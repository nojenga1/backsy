/* Backsy on-chain wallet page: reads devnet, asks the browser wallet to sign. */
(function () {
  const {
    Connection, Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL,
  } = window.solanaWeb3;
  const B = window.BacksyChain;

  const $ = (id) => document.getElementById(id);

  let connection = null;   // set once the server tells us which chain this is
  let config = null;
  let pubkey = null;       // the connected wallet

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
    await faucetStatus();
  }

  async function refresh() {
    if (!pubkey) return;
    const lamports = await connection.getBalance(pubkey);
    $("balance").textContent = sol(lamports) + " SOL";
    await listPending();
  }

  /* ---------- faucet ----------
     Every public devnet faucet turns someone away: rate limits by address,
     accounts deemed too new, empty pools. A visitor with nothing in their
     wallet cannot try this at all, so the site hands out a sip of its own. */
  async function faucetStatus() {
    try {
      const r = await fetch("/api/faucet").then((x) => x.json());
      if (r.available) $("faucetWrap").classList.remove("hidden");
    } catch {
      /* the faucet is a convenience; the page works without it */
    }
  }

  async function askForCoins() {
    const btn = $("faucetBtn");
    btn.disabled = true;
    btn.textContent = "Sending…";
    say($("faucetMsg"), "");
    try {
      const r = await fetch("/api/faucet", {
        method: "POST",
        body: JSON.stringify({ address: pubkey.toBase58() }),
      }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      say($("faucetMsg"), "On the way. It lands in a few seconds.", "ok");
      // The public RPC this page reads lags behind the one the server sends
      // through, so look more than once before believing the balance.
      for (let i = 0; i < 10; i++) {
        await new Promise((k) => setTimeout(k, 2000));
        const now = await connection.getBalance(pubkey);
        if (now > 0) {
          await refresh();
          say($("faucetMsg"), "Arrived.", "ok");
          $("faucetWrap").classList.add("hidden");
          return;
        }
      }
      await refresh();
    } catch (e) {
      say($("faucetMsg"), String(e.message || e), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Get test coins";
    }
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
          say($("sendMsg"), describe(e), "err");
          // Refresh regardless: if it failed because the transfer was already
          // settled, the row should not be sitting there inviting another click.
          await refresh();
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
    // Anchor's own codes arrive as bare hex, which means nothing to a person.
    // 3012 is what a settled transfer looks like: its account is gone.
    if (/0xbc4|AccountNotInitialized|3012/.test(s))
      return "That transfer is already settled — claimed, cancelled, or returned to you.";
    if (/0x0|already in use/.test(s)) return "That claim key is already in use.";
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
  /** The network is the server's to decide, so nothing here hard-codes it. */
  async function boot() {
    config = await fetch("/api/config").then((r) => r.json());
    connection = new Connection(config.rpc, "confirmed");
    B.setProgramId(config.programId);

    if (config.realMoney) {
      // Loud, because everything else on this page reads the same either way.
      const warn = document.createElement("div");
      warn.className = "msg err";
      warn.style.margin = "0 0 18px";
      warn.textContent =
        "This is mainnet. The money is real and the program has not been audited — " +
        "send only what you are willing to lose.";
      document.querySelector("main").prepend(warn);
      document.querySelector(".eyebrow").innerHTML = "<span></span>Solana mainnet";
    }

    $("connectBtn").onclick = connect;
    $("sendBtn").onclick = createTransfer;
    $("faucetBtn").onclick = askForCoins;

    handleLink();
    window.addEventListener("hashchange", handleLink);
    if (window.solana && window.solana.isPhantom) {
      window.solana.connect({ onlyIfTrusted: true }).then(connect).catch(() => {});
    }
  }

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
  boot().catch((e) =>
    say($("sendMsg"), "Could not reach the server: " + (e.message || e), "err")
  );
})();
