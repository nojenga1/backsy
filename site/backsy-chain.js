/**
 * Backsy on-chain client: builds the four instructions by hand.
 *
 * No Anchor client, no bundler. An Anchor instruction is just an 8-byte
 * discriminator followed by borsh-encoded args, and our args are a pubkey and
 * two 64-bit integers -- not worth a megabyte of dependency.
 *
 * Loads in the browser as a <script> (window.BacksyChain) and in Node via
 * require, so the same code that the page runs can be tested headlessly.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("@solana/web3.js"));
  } else {
    root.BacksyChain = factory(root.solanaWeb3);
  }
})(typeof self !== "undefined" ? self : this, function (web3) {
  const { PublicKey, SystemProgram, TransactionInstruction } = web3;

  const PROGRAM_ID = new PublicKey("BmMPJRQN6vgGud2Bybcs5EMV99XKpcR2CTpjCJFLAm1W");

  // From the IDL. Anchor derives these from the instruction name, but they are
  // constants once the program is built, so hard-coding beats shipping a parser.
  const DISCRIMINATORS = {
    create: [24, 30, 200, 40, 5, 28, 7, 119],
    claim: [62, 198, 214, 193, 213, 159, 108, 210],
    cancel: [232, 219, 223, 41, 219, 236, 220, 190],
    reclaim: [44, 177, 236, 249, 145, 109, 163, 186],
  };

  /** Limits the program enforces; checking them here gives a better message. */
  const MIN_LAMPORTS = 1_000_000;
  const MAX_LAMPORTS = 500_000_000;
  const MIN_HOLD = 1;
  const MAX_HOLD = 30 * 24 * 60 * 60;

  const u64 = (n) => {
    const b = new Uint8Array(8);
    let v = BigInt(n);
    for (let i = 0; i < 8; i++) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return b;
  };
  const i64 = u64; // two's complement, and every value we send is positive

  const concat = (parts) => {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };

  /** The escrow account for a claim key. One transfer, one address. */
  function transferAddress(claimKey) {
    return PublicKey.findProgramAddressSync(
      [new TextEncoder().encode("transfer"), claimKey.toBytes()],
      PROGRAM_ID
    )[0];
  }

  function createIx({ sender, claimKey, lamports, holdSeconds }) {
    if (lamports < MIN_LAMPORTS) throw new Error("amount is below the minimum of 0.001 SOL");
    if (lamports > MAX_LAMPORTS) throw new Error("amount is above the 0.5 SOL cap");
    if (holdSeconds < MIN_HOLD || holdSeconds > MAX_HOLD) throw new Error("hold window out of range");
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: sender, isSigner: true, isWritable: true },
        { pubkey: transferAddress(claimKey), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      // Uint8Array, not Buffer: the browser bundle does not ship a Buffer
      // global, and web3.js serializes a plain byte array just as happily.
      data: concat([
        new Uint8Array(DISCRIMINATORS.create),
        claimKey.toBytes(),
        u64(lamports),
        i64(holdSeconds),
      ]),
    });
  }

  /**
   * The claim key signs, which is what binds `destination` into the signature:
   * a bot that sees this transaction cannot redirect it without invalidating it.
   */
  function claimIx({ claimKey, destination, sender }) {
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: claimKey, isSigner: true, isWritable: false },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: sender, isSigner: false, isWritable: true },
        { pubkey: transferAddress(claimKey), isSigner: false, isWritable: true },
      ],
      data: new Uint8Array(DISCRIMINATORS.claim),
    });
  }

  function cancelIx({ sender, claimKey }) {
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: sender, isSigner: true, isWritable: true },
        { pubkey: transferAddress(claimKey), isSigner: false, isWritable: true },
      ],
      data: new Uint8Array(DISCRIMINATORS.cancel),
    });
  }

  function reclaimIx({ caller, sender, claimKey }) {
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: caller, isSigner: true, isWritable: false },
        { pubkey: sender, isSigner: false, isWritable: true },
        { pubkey: transferAddress(claimKey), isSigner: false, isWritable: true },
      ],
      data: new Uint8Array(DISCRIMINATORS.reclaim),
    });
  }

  /** Decode a Transfer account: 8-byte tag, then the struct in declaration order. */
  function decodeTransfer(data) {
    const b = data instanceof Uint8Array ? data : new Uint8Array(data);
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let at = 8;
    const sender = new PublicKey(b.slice(at, at + 32));
    at += 32;
    const claimKey = new PublicKey(b.slice(at, at + 32));
    at += 32;
    const amount = Number(view.getBigUint64(at, true));
    at += 8;
    const expiresAt = Number(view.getBigInt64(at, true));
    return { sender, claimKey, amount, expiresAt };
  }

  /** Every transfer this wallet has in flight, newest deadline last. */
  async function pendingFrom(connection, sender) {
    const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
      filters: [
        { dataSize: 8 + 32 + 32 + 8 + 8 + 1 },
        { memcmp: { offset: 8, bytes: sender.toBase58() } },
      ],
    });
    return accounts
      .map((a) => ({ address: a.pubkey, ...decodeTransfer(a.account.data) }))
      .sort((x, y) => x.expiresAt - y.expiresAt);
  }

  /** Transfers waiting for this wallet is not answerable on-chain: a transfer
   *  names no recipient, only a claim key. The link is the entitlement. */

  return {
    PROGRAM_ID,
    MIN_LAMPORTS,
    MAX_LAMPORTS,
    transferAddress,
    createIx,
    claimIx,
    cancelIx,
    reclaimIx,
    decodeTransfer,
    pendingFrom,
  };
});
