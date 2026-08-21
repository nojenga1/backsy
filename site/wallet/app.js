/* Backsy on-chain wallet page: reads devnet, asks the browser wallet to sign. */
(function () {
  const {
    Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL,
  } = window.solanaWeb3;
  const B = window.BacksyChain;

  const RPC = "https://api.devnet.solana.com";
  const connection = new Connection(RPC, "confirmed");
  const $ = (id) => document.getElementById(id);

  let pubkey = null; // the connected wallet

  /* ---------- claim links ---------- */
  // base64url, so the secret survives a URL without percent-encoding.
  const b64u = {
    enc: (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)),
  };
  const linkFor = (claim) => `${location.origin}/wallet/#k=${b64u.enc(claim.secretKey)}`;

  function claimKeyFromUrl() {
    const m = location.hash.match(/k=([A-Za-z0-9_-]+)/);
    if (!m) return null;
    try {
      return Keypair.fromSecretKey(b64u.dec(m[1]));
    } catch {
      return null;
    }
  }

  /* ---------- little helpers ---------- */
  const sol = (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  const short = (k) => { const s = k.toBase58(); return s.slice(0, 4) + "…" + s.slice(-4); };

  function say(el, text, kind) {
    el.innerHTML = "";
    if (!text) return;
    const d = document.createElement("div");
    d.className = "msg " + (kind || "info");
    d.textContent = text;
    el.appendChild(d);
  }

  /** Whose money it goes back to depends on who is reading. */
  function whenDue(expiresAt, side) {
    const left = expiresAt - Math.floor(Date.now() / 1000);
    const who = side === "recipient" ? "the sender" : "you";
    if (left <= 0) return `past its deadline — anyone can return it to ${who}`;
    const h = Math.round(left / 3600);
    const when = h >= 24 ? `${Math.round(h / 24)}d` : `${h}h`;
    return `goes back to ${who} in ${when}`;
  }

  /** The wallet signs and pays; extra local keypairs sign too (the claim key). */
  async function sendTx(instruction, extraSigners) {
    const tx = new Transaction().add(instruction);
    tx.feePayer = pubkey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    (extraSigners || []).forEach((s) => tx.partialSign(s));
    const signed = await window.solana.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }

  /* ---------- wallet ---------- */
  async function connect() {
    if (!window.solana || !window.solana.isPhantom) {
      say($("sendMsg"), "No Solana wallet found. Install Phantom and set it to devnet.", "err");
      return;
    }
    const res = await window.solana.connect();
    pubkey = new PublicKey(res.publicKey.toString());
    $("notConnected").classList.add("hidden");
    $("connected").classList.remove("hidden");
    $("address").textContent = pubkey.toBase58();
    $("sendBtn").disabled = false;
    await refresh();
  }

  async function refresh() {
    if (!pubkey) return;
    const lamports = await connection.getBalance(pubkey);
    $("balance").textContent = sol(lamports) + " SOL";
    await listPending();
  }

  /* ---------- send ---------- */
  async function createTransfer() {
    const msg = $("sendMsg");
    say(msg, "");
    const amount = Math.round(parseFloat($("amount").value) * LAMPORTS_PER_SOL);
    const hold = parseInt($("hold").value, 10);
    const claim = Keypair.generate();

    $("sendBtn").disabled = true;
    try {
      await sendTx(
        B.createIx({ sender: pubkey, claimKey: claim.publicKey, lamports: amount, holdSeconds: hold })
      );
      const url = linkFor(claim);
      msg.innerHTML = "";
      const box = document.createElement("div");
      box.className = "msg ok";
      box.textContent = "Sent. Give this link to the recipient — it is the only way to claim it:";
      const link = document.createElement("div");
      link.className = "link";
      link.textContent = url;
      const copy = document.createElement("button");
      copy.className = "ghost";
      copy.style.marginTop = "10px";
      copy.textContent = "Copy link";
      copy.onclick = () => {
        navigator.clipboard.writeText(url);
        copy.textContent = "Copied";
      };
      box.appendChild(link);
      box.appendChild(copy);
      msg.appendChild(box);
      await refresh();
    } catch (e) {
      say(msg, describe(e), "err");
    } finally {
      $("sendBtn").disabled = false;
    }
  }

  /* ---------- in flight ---------- */
  async function listPending() {
    const host = $("pending");
    host.textContent = "Loading…";
    let rows;
    try {
      rows = await B.pendingFrom(connection, pubkey);
    } catch (e) {
      host.textContent = "Could not read the chain: " + describe(e);
      return;
    }
    if (!rows.length) {
      host.textContent = "Nothing in flight.";
      return;
    }
    host.innerHTML = "";
    rows.forEach((t) => {
      const row = document.createElement("div");
      row.className = "row";
      const left = document.createElement("div");
      left.innerHTML =
        `<b>${sol(t.amount)} SOL</b> <span class="muted">· claim key ${short(t.claimKey)}</span>` +
        `<div class="link">${whenDue(t.expiresAt)}</div>`;
      const btn = document.createElement("button");
      btn.className = "ghost";
      btn.textContent = "Cancel";
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "Cancelling…";
        try {
          await sendTx(B.cancelIx({ sender: pubkey, claimKey: t.claimKey }));
          await refresh();
        } catch (e) {
          btn.disabled = false;
          btn.textContent = "Cancel";
          say($("sendMsg"), describe(e), "err");
        }
      };
      row.appendChild(left);
      row.appendChild(btn);
      host.appendChild(row);
    });
  }

  /* ---------- claim ---------- */
  async function showClaim(claim) {
    const panel = $("claimPanel");
    const escrow = B.transferAddress(claim.publicKey);
    const info = await connection.getAccountInfo(escrow);
    panel.classList.remove("hidden");

    if (!info) {
      $("claimAmount").textContent = "Nothing here";
      $("claimExpiry").textContent =
        "This transfer was already claimed, cancelled, or returned to the sender.";
      $("claimBtn").classList.add("hidden");
      return;
    }
    const t = B.decodeTransfer(info.data);
    $("claimAmount").textContent = sol(t.amount) + " SOL";
    $("claimFrom").textContent = "from " + t.sender.toBase58();
    $("claimExpiry").textContent = whenDue(t.expiresAt, "recipient") + " unless you claim it";

    $("claimBtn").onclick = async () => {
      if (!pubkey) {
        await connect();
        if (!pubkey) return;
      }
      $("claimBtn").disabled = true;
      $("claimBtn").textContent = "Claiming…";
      try {
        await sendTx(
          B.claimIx({ claimKey: claim.publicKey, destination: pubkey, sender: t.sender }),
          [claim]
        );
        say($("claimMsg"), "Claimed. The money is in your wallet.", "ok");
        $("claimBtn").classList.add("hidden");
        await refresh();
      } catch (e) {
        $("claimBtn").disabled = false;
        $("claimBtn").textContent = "Claim into my wallet";
        say($("claimMsg"), describe(e), "err");
      }
    };
  }

  /** Turn a program error into something a person can act on. */
  function describe(e) {
    const s = String((e && e.message) || e);
    if (/NotTheSender/.test(s)) return "Only the sender can cancel this transfer.";
    if (/WrongClaimKey/.test(s)) return "This link does not match that transfer.";
    if (/Expired/.test(s)) return "Too late — the transfer has gone back to the sender.";
    if (/NotExpiredYet/.test(s)) return "Not yet: the hold window has not passed.";
    if (/AmountTooLarge/.test(s)) return "Above the 0.5 SOL cap that stands while unaudited.";
    if (/AmountTooSmall/.test(s)) return "Below the 0.001 SOL minimum.";
    if (/insufficient|Insufficient/.test(s)) return "Not enough SOL in the wallet for this and the fees.";
    if (/User rejected|rejected the request/.test(s)) return "You dismissed the wallet prompt.";
    return s.slice(0, 200);
  }

  /* ---------- boot ---------- */
  $("connectBtn").onclick = connect;
  $("sendBtn").onclick = createTransfer;

  function handleLink() {
    const fromLink = claimKeyFromUrl();
    if (!fromLink) return;
    $("sendPanel").classList.add("hidden");
    $("claimBtn").classList.remove("hidden");
    $("claimBtn").disabled = false;
    $("claimBtn").textContent = "Claim into my wallet";
    say($("claimMsg"), "");
    showClaim(fromLink).catch((e) => say($("claimMsg"), describe(e), "err"));
  }
  handleLink();
  // Pasting a link while already here is a fragment navigation: no reload.
  window.addEventListener("hashchange", handleLink);
  // Reconnect silently if this site was approved before.
  if (window.solana && window.solana.isPhantom) {
    window.solana.connect({ onlyIfTrusted: true }).then(connect).catch(() => {});
  }
})();
