import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Backsy } from "../target/types/backsy";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert } from "chai";

const AMOUNT = 0.05 * LAMPORTS_PER_SOL;
const HOLD = 3; // seconds -- short enough that a test can outlive it

describe("backsy", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Backsy as Program<Backsy>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  const sender = Keypair.generate();

  const pda = (claimKey: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("transfer"), claimKey.toBuffer()],
      program.programId
    )[0];

  /** Escrow a transfer and hand back the link's keypair. */
  async function create(hold = HOLD, amount = AMOUNT) {
    const claim = Keypair.generate();
    await program.methods
      .create(claim.publicKey, new anchor.BN(amount), new anchor.BN(hold))
      .accounts({ sender: sender.publicKey, transfer: pda(claim.publicKey) })
      .signers([sender])
      .rpc();
    return claim;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Assert a transaction fails. Cheaper than a chai-as-promised dependency. */
  async function rejects(p: Promise<unknown>, what = "expected this to fail") {
    try {
      await p;
    } catch {
      return;
    }
    assert.fail(what);
  }

  before(async () => {
    const sig = await provider.connection.requestAirdrop(
      sender.publicKey,
      5 * LAMPORTS_PER_SOL
    );
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...bh });
  });

  it("escrows the money out of the sender's balance", async () => {
    const before = await provider.connection.getBalance(sender.publicKey);
    const claim = await create();
    const after = await provider.connection.getBalance(sender.publicKey);
    const acct = await program.account.transfer.fetch(pda(claim.publicKey));

    assert.equal(acct.amount.toNumber(), AMOUNT);
    assert.equal(acct.sender.toBase58(), sender.publicKey.toBase58());
    assert.isBelow(after, before - AMOUNT, "amount plus rent left the sender");
  });

  it("pays the destination the claimer names", async () => {
    const claim = await create();
    const dest = Keypair.generate();

    await program.methods
      .claim()
      .accounts({
        claimSigner: claim.publicKey,
        destination: dest.publicKey,
        sender: sender.publicKey,
        transfer: pda(claim.publicKey),
      })
      .signers([claim])
      .rpc();

    assert.equal(await provider.connection.getBalance(dest.publicKey), AMOUNT);
  });

  it("cannot be claimed twice", async () => {
    const claim = await create();
    const dest = Keypair.generate();
    const accounts = {
      claimSigner: claim.publicKey,
      destination: dest.publicKey,
      sender: sender.publicKey,
      transfer: pda(claim.publicKey),
    };
    await program.methods.claim().accounts(accounts).signers([claim]).rpc();

    // The account is closed, so there is nothing left to settle a second time.
    await rejects(
      program.methods.claim().accounts(accounts).signers([claim]).rpc()
    );
    assert.equal(await provider.connection.getBalance(dest.publicKey), AMOUNT);
  });

  it("cannot be claimed by a key that is not in the link", async () => {
    const claim = await create();
    const impostor = Keypair.generate();
    const dest = Keypair.generate();

    await rejects(
      program.methods
        .claim()
        .accounts({
          claimSigner: impostor.publicKey,
          destination: dest.publicKey,
          sender: sender.publicKey,
          transfer: pda(claim.publicKey),
        })
        .signers([impostor])
        .rpc()
    );
    assert.equal(await provider.connection.getBalance(dest.publicKey), 0);
  });

  it("gives the money back when the sender cancels", async () => {
    const claim = await create();
    const before = await provider.connection.getBalance(sender.publicKey);

    await program.methods
      .cancel()
      .accounts({ sender: sender.publicKey, transfer: pda(claim.publicKey) })
      .signers([sender])
      .rpc();

    const after = await provider.connection.getBalance(sender.publicKey);
    assert.isAbove(after, before + AMOUNT - 20000, "amount and rent came back");
  });

  it("cannot be cancelled by anyone but the sender", async () => {
    const claim = await create();
    const stranger = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      stranger.publicKey,
      LAMPORTS_PER_SOL
    );
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...bh });

    await rejects(
      program.methods
        .cancel()
        .accounts({ sender: stranger.publicKey, transfer: pda(claim.publicKey) })
        .signers([stranger])
        .rpc()
    );
    // still escrowed
    const acct = await program.account.transfer.fetch(pda(claim.publicKey));
    assert.equal(acct.amount.toNumber(), AMOUNT);
  });

  it("cannot be cancelled after it was claimed", async () => {
    const claim = await create();
    const dest = Keypair.generate();
    await program.methods
      .claim()
      .accounts({
        claimSigner: claim.publicKey,
        destination: dest.publicKey,
        sender: sender.publicKey,
        transfer: pda(claim.publicKey),
      })
      .signers([claim])
      .rpc();

    await rejects(
      program.methods
        .cancel()
        .accounts({ sender: sender.publicKey, transfer: pda(claim.publicKey) })
        .signers([sender])
        .rpc()
    );
  });

  it("refuses to reclaim before the hold window is over", async () => {
    const claim = await create(60);
    const anyone = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      anyone.publicKey,
      LAMPORTS_PER_SOL
    );
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...bh });

    await rejects(
      program.methods
        .reclaim()
        .accounts({
          caller: anyone.publicKey,
          sender: sender.publicKey,
          transfer: pda(claim.publicKey),
        })
        .signers([anyone])
        .rpc()
    );
  });

  it("lets anyone return an expired transfer, and only to the sender", async () => {
    const claim = await create(2);
    const anyone = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      anyone.publicKey,
      LAMPORTS_PER_SOL
    );
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...bh });

    await sleep(4000);
    const before = await provider.connection.getBalance(sender.publicKey);

    await program.methods
      .reclaim()
      .accounts({
        caller: anyone.publicKey,
        sender: sender.publicKey,
        transfer: pda(claim.publicKey),
      })
      .signers([anyone])
      .rpc();

    const after = await provider.connection.getBalance(sender.publicKey);
    assert.isAbove(after, before + AMOUNT - 20000, "money went to the sender");
  });

  it("refuses to claim an expired transfer", async () => {
    const claim = await create(2);
    const dest = Keypair.generate();
    await sleep(4000);

    await rejects(
      program.methods
        .claim()
        .accounts({
          claimSigner: claim.publicKey,
          destination: dest.publicKey,
          sender: sender.publicKey,
          transfer: pda(claim.publicKey),
        })
        .signers([claim])
        .rpc()
    );
  });

  it("enforces the damage cap while unaudited", async () => {
    await rejects(create(HOLD, 1 * LAMPORTS_PER_SOL));
    await rejects(create(HOLD, 1));
  });
});
