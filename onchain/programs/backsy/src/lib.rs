//! Backsy: reversible transfers on Solana.
//!
//! A transfer lives as its own PDA that holds the escrowed lamports. It is
//! settled by *closing* that account, which is why a transfer can only ever be
//! settled once: claim, cancel and reclaim all close it, and an account cannot
//! be closed twice. That single fact replaces the status field the off-chain
//! prototype needed.
//!
//! Claim links carry a private key, not a secret to be revealed. The claim
//! instruction demands a signature from it, so the destination is part of the
//! signed transaction. A bot watching the mempool cannot redirect the money:
//! changing the destination invalidates the signature, and rebroadcasting the
//! transaction unchanged just pays the intended recipient.

use anchor_lang::prelude::*;
use anchor_lang::system_program;

// Placeholder until the first build; `anchor keys sync` writes the real one.
declare_id!("Bkzy1111111111111111111111111111111111111111");

/// Damage cap while the program is unaudited. Raise it deliberately, later.
pub const MAX_AMOUNT: u64 = 500_000_000; // 0.5 SOL
/// Below this the rent deposit dwarfs the transfer and nothing makes sense.
pub const MIN_AMOUNT: u64 = 1_000_000; // 0.001 SOL
pub const MAX_HOLD_SECONDS: i64 = 30 * 24 * 60 * 60;
/// Short holds are the sender's call, and tests need one they can outlive.
pub const MIN_HOLD_SECONDS: i64 = 1;

#[program]
pub mod backsy {
    use super::*;

    /// Escrow `amount` lamports, redeemable by whoever holds the key behind
    /// `claim_key`, until `hold_seconds` have passed.
    pub fn create(
        ctx: Context<Create>,
        claim_key: Pubkey,
        amount: u64,
        hold_seconds: i64,
    ) -> Result<()> {
        require!(amount >= MIN_AMOUNT, BacksyError::AmountTooSmall);
        require!(amount <= MAX_AMOUNT, BacksyError::AmountTooLarge);
        require!(hold_seconds >= MIN_HOLD_SECONDS, BacksyError::HoldTooShort);
        require!(hold_seconds <= MAX_HOLD_SECONDS, BacksyError::HoldTooLong);

        let now = Clock::get()?.unix_timestamp;
        let expires_at = now
            .checked_add(hold_seconds)
            .ok_or(BacksyError::MathOverflow)?;

        // Move the escrow amount in. Rent for the account itself was already
        // paid by `init`, and comes back to the sender when it closes.
        system_program::transfer(
            CpiContext::new(
                // Anchor 1.x takes the program id here, not its AccountInfo.
                ctx.accounts.system_program.key(),
                system_program::Transfer {
                    from: ctx.accounts.sender.to_account_info(),
                    to: ctx.accounts.transfer.to_account_info(),
                },
            ),
            amount,
        )?;

        let t = &mut ctx.accounts.transfer;
        t.sender = ctx.accounts.sender.key();
        t.claim_key = claim_key;
        t.amount = amount;
        t.expires_at = expires_at;
        t.bump = ctx.bumps.transfer;

        emit!(Created {
            transfer: t.key(),
            sender: t.sender,
            amount,
            expires_at,
        });
        Ok(())
    }

    /// Redeem a transfer. Requires a signature from the claim key, so the
    /// destination cannot be swapped by anyone who merely sees the transaction.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now < ctx.accounts.transfer.expires_at, BacksyError::Expired);

        let amount = ctx.accounts.transfer.amount;
        // Hand over the escrowed amount; `close` then returns the rent deposit
        // to the sender, who paid it.
        let transfer_ai = ctx.accounts.transfer.to_account_info();
        **transfer_ai.try_borrow_mut_lamports()? = transfer_ai
            .lamports()
            .checked_sub(amount)
            .ok_or(BacksyError::MathOverflow)?;
        let dest = &ctx.accounts.destination;
        **dest.try_borrow_mut_lamports()? = dest
            .lamports()
            .checked_add(amount)
            .ok_or(BacksyError::MathOverflow)?;

        emit!(Settled {
            transfer: ctx.accounts.transfer.key(),
            how: Outcome::Claimed,
            amount,
        });
        Ok(())
    }

    /// Take it back. Only the sender, and only while it is still unclaimed --
    /// a claimed transfer no longer exists, so this fails to load it.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        emit!(Settled {
            transfer: ctx.accounts.transfer.key(),
            how: Outcome::Cancelled,
            amount: ctx.accounts.transfer.amount,
        });
        Ok(())
    }

    /// After the hold window anyone may push the money back to the sender --
    /// on-chain nothing happens on a timer, someone has to send this.
    pub fn reclaim(ctx: Context<Reclaim>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.transfer.expires_at,
            BacksyError::NotExpiredYet
        );
        emit!(Settled {
            transfer: ctx.accounts.transfer.key(),
            how: Outcome::Expired,
            amount: ctx.accounts.transfer.amount,
        });
        Ok(())
    }
}

#[account]
pub struct Transfer {
    pub sender: Pubkey,
    pub claim_key: Pubkey,
    pub amount: u64,
    pub expires_at: i64,
    pub bump: u8,
}

impl Transfer {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 1;
}

#[derive(Accounts)]
#[instruction(claim_key: Pubkey)]
pub struct Create<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    #[account(
        init,
        payer = sender,
        space = 8 + Transfer::LEN,
        seeds = [b"transfer", claim_key.as_ref()],
        bump,
    )]
    pub transfer: Account<'info, Transfer>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    /// The key that travelled in the link. Its signature binds `destination`.
    pub claim_signer: Signer<'info>,
    /// CHECK: any address the claimer names; it only receives lamports.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// Rent goes back to whoever paid it.
    #[account(mut)]
    pub sender: SystemAccount<'info>,
    #[account(
        mut,
        close = sender,
        has_one = sender,
        constraint = claim_signer.key() == transfer.claim_key @ BacksyError::WrongClaimKey,
    )]
    pub transfer: Account<'info, Transfer>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut)]
    pub sender: Signer<'info>,
    #[account(mut, close = sender, has_one = sender @ BacksyError::NotTheSender)]
    pub transfer: Account<'info, Transfer>,
}

#[derive(Accounts)]
pub struct Reclaim<'info> {
    /// Anyone may trigger the return; the money still goes to the sender.
    pub caller: Signer<'info>,
    #[account(mut)]
    pub sender: SystemAccount<'info>,
    #[account(mut, close = sender, has_one = sender)]
    pub transfer: Account<'info, Transfer>,
}

#[event]
pub struct Created {
    pub transfer: Pubkey,
    pub sender: Pubkey,
    pub amount: u64,
    pub expires_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Claimed,
    Cancelled,
    Expired,
}

#[event]
pub struct Settled {
    pub transfer: Pubkey,
    pub how: Outcome,
    pub amount: u64,
}

#[error_code]
pub enum BacksyError {
    #[msg("transfer has expired")]
    Expired,
    #[msg("the hold window has not passed yet")]
    NotExpiredYet,
    #[msg("only the sender can cancel this transfer")]
    NotTheSender,
    #[msg("this key cannot claim this transfer")]
    WrongClaimKey,
    #[msg("amount is below the minimum")]
    AmountTooSmall,
    #[msg("amount is above the cap")]
    AmountTooLarge,
    #[msg("hold window is too short")]
    HoldTooShort,
    #[msg("hold window is too long")]
    HoldTooLong,
    #[msg("arithmetic overflow")]
    MathOverflow,
}
