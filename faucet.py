"""A small devnet faucet, so a first-time visitor has something to send.

Every public devnet faucet turned us away at some point -- rate limits by IP,
GitHub accounts too new, empty proof-of-work pools. A visitor with an empty
wallet cannot try Backsy at all, so we hand out a sip from our own wallet.

Devnet only. The key here signs transfers of worthless test currency and
nothing else; it must never hold real funds.
"""
import base64
import json
import os
import time
import urllib.request

from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.hash import Hash
from solders.message import Message
from solders.transaction import Transaction
from solders.system_program import TransferParams, transfer

RPC = os.environ.get("BACKSY_RPC", "https://api.devnet.solana.com").strip()
DRIP_LAMPORTS = int(os.environ.get("BACKSY_DRIP_LAMPORTS", 50_000_000))  # 0.05 SOL
DRIP_EVERY = 24 * 3600           # per address
DAILY_DRIPS = int(os.environ.get("BACKSY_DAILY_DRIPS", 60))
# Keep enough back to cover fees and to make the emptiness obvious before it bites.
RESERVE_LAMPORTS = 100_000_000   # 0.1 SOL

SCHEMA = """
CREATE TABLE IF NOT EXISTS drips (
  address TEXT PRIMARY KEY,
  at      REAL NOT NULL,
  sig     TEXT
);
"""


class FaucetError(Exception):
    """Something the visitor should be told, in words they can act on."""


def _refuse_on_mainnet():
    """Giving away real money is not a feature. Fail loudly if pointed at it."""
    if os.environ.get("BACKSY_CLUSTER", "devnet").strip().lower() != "devnet":
        raise FaucetError("The faucet only runs on devnet.")


def _keypair():
    raw = os.environ.get("BACKSY_FAUCET_KEY", "").strip()
    if not raw:
        raise FaucetError("The faucet is not configured on this server.")
    try:
        return Keypair.from_bytes(bytes(json.loads(raw)))
    except Exception:
        raise FaucetError("The faucet key on this server is malformed.")


def _rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    req = urllib.request.Request(
        RPC, data=body.encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        out = json.loads(r.read())
    if "error" in out:
        raise FaucetError("The network refused: %s" % out["error"].get("message", "unknown"))
    return out["result"]


def balance(pubkey):
    return _rpc("getBalance", [str(pubkey)])["value"]


def _check_quota(conn, address, now):
    row = conn.execute("SELECT at FROM drips WHERE address=?", (address,)).fetchone()
    if row and now - row[0] < DRIP_EVERY:
        hours = int((DRIP_EVERY - (now - row[0])) / 3600) + 1
        raise FaucetError("This wallet already got a sip. Try again in %dh." % hours)
    today = conn.execute("SELECT COUNT(*) FROM drips WHERE at > ?", (now - 86400,)).fetchone()[0]
    if today >= DAILY_DRIPS:
        raise FaucetError("The faucet has given out its daily limit. Try tomorrow.")


def drip(conn, address):
    """Send one sip to `address`. Returns the signature."""
    _refuse_on_mainnet()
    conn.executescript(SCHEMA)
    try:
        dest = Pubkey.from_string(address)
    except Exception:
        raise FaucetError("That does not look like a Solana address.")

    kp = _keypair()
    if dest == kp.pubkey():
        raise FaucetError("That is the faucet's own wallet.")

    now = time.time()
    _check_quota(conn, address, now)

    have = balance(kp.pubkey())
    if have < DRIP_LAMPORTS + RESERVE_LAMPORTS:
        raise FaucetError("The faucet is empty. Ping us and we will refill it.")

    blockhash = Hash.from_string(_rpc("getLatestBlockhash", [{"commitment": "finalized"}])["value"]["blockhash"])
    ix = transfer(TransferParams(from_pubkey=kp.pubkey(), to_pubkey=dest, lamports=DRIP_LAMPORTS))
    tx = Transaction([kp], Message.new_with_blockhash([ix], kp.pubkey(), blockhash), blockhash)

    sig = _send(tx)

    # Record only after the network accepted it, so a failure does not burn the quota.
    conn.execute("INSERT OR REPLACE INTO drips VALUES (?,?,?)", (address, now, sig))
    return sig


def _send(tx):
    raw = base64.b64encode(bytes(tx)).decode()
    return _rpc("sendTransaction", [raw, {"encoding": "base64", "skipPreflight": False}])


def status(conn):
    """What the page shows before anyone clicks."""
    conn.executescript(SCHEMA)
    try:
        _refuse_on_mainnet()
        kp = _keypair()
    except FaucetError as e:
        return {"available": False, "reason": str(e)}
    try:
        have = balance(kp.pubkey())
    except FaucetError:
        return {"available": False, "reason": "network unreachable"}
    today = conn.execute(
        "SELECT COUNT(*) FROM drips WHERE at > ?", (time.time() - 86400,)
    ).fetchone()[0]
    return {
        "available": have >= DRIP_LAMPORTS + RESERVE_LAMPORTS and today < DAILY_DRIPS,
        "drip": DRIP_LAMPORTS,
        "left_today": max(0, DAILY_DRIPS - today),
        "wallet": str(kp.pubkey()),
    }
