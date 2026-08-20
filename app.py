"""Backsy: reversible transfers on a simulated escrow.

The sender's money leaves their balance immediately and sits in escrow.
Until the recipient claims it, the sender can cancel. After the hold window
it auto-returns. No blockchain, no real funds.

Run:  python app.py   ->  http://localhost:8000  (site /, app /app)
"""
import http.server, json, mimetypes, os, secrets, sqlite3, time, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.normpath(os.path.join(HERE, "site"))
DB = os.environ.get("BACKSY_DB", os.path.join(HERE, "backsy.db"))
DB_FROM_ENV = "BACKSY_DB" in os.environ
STARTED = time.time()
HOLD_SECONDS = 7 * 24 * 3600
START_BALANCE = 1000.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
  name TEXT PRIMARY KEY,
  balance REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS transfers (
  token TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,          -- pending | claimed | cancelled | expired
  created_at REAL NOT NULL,
  expires_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sender ON transfers(sender, status);
"""


def db(path=DB):
    # BACKSY_DB usually points at a mounted volume; create the dir so a missing
    # mount is a clear failure at startup rather than a crash on first request.
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    c = sqlite3.connect(path, isolation_level=None)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout=5000")
    c.executescript(SCHEMA)
    return c


def account(c, name):
    """Fetch balance, creating a demo account on first sight."""
    c.execute("INSERT OR IGNORE INTO accounts VALUES (?,?)", (name, START_BALANCE))
    return c.execute("SELECT balance FROM accounts WHERE name=?", (name,)).fetchone()[0]


def sweep(c, now=None):
    """Auto-return anything past its hold window. Returns count actually swept.

    ponytail: swept on every request instead of on a cron -- at this size the
    scan is free. Move to a background job if transfer volume ever grows.
    """
    now = time.time() if now is None else now
    rows = c.execute(
        "SELECT token, sender, amount FROM transfers "
        "WHERE status='pending' AND expires_at<=?", (now,)
    ).fetchall()
    n = 0
    for r in rows:
        c.execute("BEGIN IMMEDIATE")
        try:
            cur = c.execute(
                "UPDATE transfers SET status='expired' WHERE token=? AND status='pending'",
                (r["token"],))
            if cur.rowcount:
                account(c, r["sender"])
                c.execute("UPDATE accounts SET balance=balance+? WHERE name=?",
                          (r["amount"], r["sender"]))
                n += 1
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
    return n


def send(c, sender, recipient, amount):
    sender, recipient = (sender or "").strip(), (recipient or "").strip()
    if not sender:
        raise ValueError("sender required")
    if not recipient or recipient == sender:
        raise ValueError("bad recipient")
    amount = round(float(amount), 2)
    if not amount > 0:
        raise ValueError("amount must be positive")
    token, now = secrets.token_urlsafe(16), time.time()
    c.execute("BEGIN IMMEDIATE")
    try:
        account(c, sender)
        # Conditional debit: no row matches when funds are short, so two
        # concurrent sends can never overdraw the same balance.
        cur = c.execute(
            "UPDATE accounts SET balance=balance-? WHERE name=? AND balance>=?",
            (amount, sender, amount))
        if cur.rowcount == 0:
            raise ValueError("insufficient balance")
        c.execute("INSERT INTO transfers VALUES (?,?,?,?,'pending',?,?)",
                  (token, sender, recipient, amount, now, now + HOLD_SECONDS))
        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise
    return token


def resolve(c, token, action, actor=None):
    """Settle a pending transfer exactly once. action: 'claim' | 'cancel'."""
    c.execute("BEGIN IMMEDIATE")
    try:
        t = c.execute("SELECT * FROM transfers WHERE token=?", (token,)).fetchone()
        if t is None:
            raise ValueError("no such transfer")
        if t["status"] != "pending":
            raise ValueError("already " + t["status"])
        if action == "cancel" and actor != t["sender"]:
            raise ValueError("only the sender can cancel")
        if action == "claim" and time.time() >= t["expires_at"]:
            raise ValueError("expired")
        # WHERE status='pending' is the race guard: the second of two
        # concurrent claims matches zero rows and pays out nothing.
        cur = c.execute("UPDATE transfers SET status=? WHERE token=? AND status='pending'",
                        ("claimed" if action == "claim" else "cancelled", token))
        if cur.rowcount == 0:
            raise ValueError("already settled")
        who = t["recipient"] if action == "claim" else t["sender"]
        account(c, who)
        c.execute("UPDATE accounts SET balance=balance+? WHERE name=?", (t["amount"], who))
        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise
    return dict(t)


def state(c, user):
    sweep(c)
    bal = account(c, user)
    sent = c.execute("SELECT * FROM transfers WHERE sender=? ORDER BY created_at DESC LIMIT 50",
                     (user,)).fetchall()
    inbox = c.execute("SELECT * FROM transfers WHERE recipient=? ORDER BY created_at DESC LIMIT 50",
                      (user,)).fetchall()
    return {
        "user": user,
        "balance": round(bal, 2),
        "in_flight": round(sum(r["amount"] for r in sent if r["status"] == "pending"), 2),
        "sent": [dict(r) for r in sent],
        "inbox": [dict(r) for r in inbox],
    }


PAGE = r"""<!doctype html><meta charset=utf-8><title>Backsy</title>
<link rel=icon href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%234A5BF2'/%3E%3Cpath d='M8 23 L14.5 8.5 L25 17.5' fill='none' stroke='%23fff' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<meta name=viewport content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0b0d10;--card:#15181d;--line:#252a32;--fg:#e8eaed;--dim:#8b93a1;--acc:#4A5BF2}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.5 ui-sans-serif,system-ui,sans-serif;padding:24px}
.wrap{max-width:640px;margin:0 auto}h1{font-size:22px;margin:0 0 2px}
.sub{color:var(--dim);font-size:13px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
.bal{font-size:34px;font-weight:600}.flight{color:var(--dim);font-size:13px}
input{background:#0f1216;border:1px solid var(--line);color:var(--fg);border-radius:8px;
padding:9px 11px;font:inherit;width:100%;margin-bottom:8px}
button{background:var(--acc);color:#ffffff;border:0;border-radius:8px;padding:9px 14px;
font:inherit;font-weight:600;cursor:pointer}button.ghost{background:transparent;color:var(--dim);
border:1px solid var(--line)}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px;
padding:10px 0;border-bottom:1px solid var(--line)}.row:last-child{border:0}
.t{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);margin-bottom:8px}
.st{font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.st.pending{color:#8f9bff;border-color:#2c3570}
.link{font-size:11px;color:var(--dim);word-break:break-all}
.err{color:#f87171;font-size:13px;min-height:18px}
.mark{width:25px;height:25px;display:inline-block;vertical-align:-5px;margin-right:9px;background:linear-gradient(135deg,#8E9BFF,#4A5BF2);-webkit-mask:url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2032%2032%27%3E%3Ccircle%20cx=%2716%27%20cy=%2716%27%20r=%2714.2%27%20fill=%27none%27%20stroke=%27%23000%27%20stroke-width=%272.6%27/%3E%3Cg%20transform=%27translate%2816%2016%29%20scale%28.62%29%20translate%28-16%20-16%29%27%3E%3Cpath%20d=%27M8%2023%20L14.5%208.5%20L25%2017.5%27%20fill=%27none%27%20stroke=%27%23000%27%20stroke-width=%274%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27/%3E%3C/g%3E%3C/svg%3E) center/contain no-repeat;mask:url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2032%2032%27%3E%3Ccircle%20cx=%2716%27%20cy=%2716%27%20r=%2714.2%27%20fill=%27none%27%20stroke=%27%23000%27%20stroke-width=%272.6%27/%3E%3Cg%20transform=%27translate%2816%2016%29%20scale%28.62%29%20translate%28-16%20-16%29%27%3E%3Cpath%20d=%27M8%2023%20L14.5%208.5%20L25%2017.5%27%20fill=%27none%27%20stroke=%27%23000%27%20stroke-width=%274%27%20stroke-linecap=%27round%27%20stroke-linejoin=%27round%27/%3E%3C/g%3E%3C/svg%3E) center/contain no-repeat}
.legal{color:var(--dim);font-size:11px;margin-top:18px}
</style>
<div class=wrap>
<h1><span class=mark></span>Backsy</h1><div class=sub>Send now. Take it back until it's claimed.</div>
<div class=card>
  <div class=t>Signed in as</div>
  <input id=me placeholder="your name">
  <div class=bal id=bal>--</div>
  <div class=flight id=flight></div>
</div>
<div class=card>
  <div class=t>Send</div>
  <input id=to placeholder="recipient name">
  <input id=amt type=number step=0.01 placeholder="amount">
  <button onclick=doSend()>Send</button>
  <div class=err id=err></div>
</div>
<div class=card><div class=t>Sent</div><div id=sent></div></div>
<div class=card><div class=t>Incoming</div><div id=inbox></div></div>
<p class=legal>Prototype. Simulated escrow, no chain, no real funds.</p>
</div>
<script>
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[<&]/g,c=>c==='<'?'&lt;':'&amp;');
let me=localStorage.me||'alice'; $('#me').value=me;
$('#me').oninput=e=>{me=localStorage.me=e.target.value.trim()||'alice';load()};
const api=(p,b)=>fetch(p,{method:'POST',body:JSON.stringify(b)}).then(r=>r.json());
const days=s=>Math.max(0,Math.ceil((s*1000-Date.now())/864e5));

function rows(list,mine){
  const out=list.map(t=>{
    const who=esc(mine?t.recipient:t.sender);
    const claimLink=(t.status==='pending'&&mine)
      ? '<div class=link>'+location.origin+'/c/'+t.token+'</div>' : '';
    const ttl=(t.status==='pending')
      ? '<div class=link>auto-returns in '+days(t.expires_at)+'d</div>' : '';
    const btn=(t.status!=='pending') ? ''
      : mine ? '<button class=ghost onclick="act(\'cancel\',\''+t.token+'\')">Cancel</button>'
             : '<button onclick="act(\'claim\',\''+t.token+'\')">Claim</button>';
    return '<div class=row><div><b>'+who+'</b> &middot; '+t.amount+claimLink+ttl+'</div>'
         + '<div>'+btn+' <span class="st '+t.status+'">'+t.status+'</span></div></div>';
  }).join('');
  return out||'<div class=flight>nothing yet</div>';
}

async function load(){
  const s=await fetch('/api/state?user='+encodeURIComponent(me)).then(r=>r.json());
  $('#bal').textContent=s.balance.toFixed(2);
  $('#flight').textContent=s.in_flight
    ? s.in_flight.toFixed(2)+' in flight (recoverable)' : 'nothing in flight';
  $('#sent').innerHTML=rows(s.sent,1);
  $('#inbox').innerHTML=rows(s.inbox,0);
}
async function doSend(){
  $('#err').textContent='';
  const r=await api('/api/send',{user:me,to:$('#to').value,amount:$('#amt').value});
  if(r.error){$('#err').textContent=r.error;return;}
  $('#to').value='';$('#amt').value='';load();
}
async function act(a,token){
  $('#err').textContent='';
  const r=await api('/api/'+a,{user:me,token:token});
  if(r.error)$('#err').textContent=r.error;
  load();
}
const m=location.pathname.match(/^\/c\/(.+)$/);
if(m){act('claim',m[1]);history.replaceState(0,'','/');}else{load();}
</script>"""


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    head_only = False

    def do_HEAD(self):
        self.head_only = True
        self.do_GET()

    def body(self, b):
        if not self.head_only:
            self.wfile.write(b)

    def reply(self, code, body, ctype="application/json"):
        b = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.body(b)

    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        if p.path == "/api/health":
            # Diagnostics for the deploy: is the database on the mounted volume,
            # and is this a different process than the last time you looked?
            return self.reply(200, json.dumps({
                "started": STARTED,
                "db": DB,
                "db_from_env": DB_FROM_ENV,
                "db_exists": os.path.isfile(DB),
                "db_bytes": os.path.getsize(DB) if os.path.isfile(DB) else 0,
            }))
        if p.path == "/api/state":
            user = (urllib.parse.parse_qs(p.query).get("user") or ["alice"])[0].strip() or "alice"
            c = db()
            try:
                return self.reply(200, json.dumps(state(c, user)))
            finally:
                c.close()
        if p.path in ("/app", "/app/") or p.path.startswith("/c/"):
            return self.reply(200, PAGE, "text/html")
        self.static(p.path)

    def static(self, path):
        """Serve the marketing site. One process, one port -- Railway gives one."""
        rel = urllib.parse.unquote(path).lstrip("/").replace("\\", "/")
        full = os.path.normpath(os.path.join(SITE, rel))
        if full != SITE and not full.startswith(SITE + os.sep):
            return self.reply(403, '{"error":"forbidden"}')
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            return self.reply(404, "Not found", "text/plain")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "image/svg+xml"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.body(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self.reply(400, '{"error":"bad json"}')
        if not isinstance(body, dict):
            return self.reply(400, '{"error":"bad json"}')
        user = (body.get("user") or "").strip()
        c = db()
        try:
            if self.path == "/api/send":
                tok = send(c, user, body.get("to"), body.get("amount"))
                return self.reply(200, json.dumps({"token": tok}))
            if self.path in ("/api/claim", "/api/cancel"):
                action = self.path.rsplit("/", 1)[1]
                t = resolve(c, (body.get("token") or "").strip(), action, actor=user)
                return self.reply(200, json.dumps({"ok": True, "amount": t["amount"]}))
        except (ValueError, TypeError) as e:
            return self.reply(400, json.dumps({"error": str(e)}))
        finally:
            c.close()
        self.reply(404, '{"error":"not found"}')

    def log_message(self, *a):
        pass


def demo():
    """Self-check: money must never appear twice, vanish, or move without consent."""
    import os
    t = "ss_test.db"
    if os.path.exists(t):
        os.remove(t)
    c = db(t)

    tok = send(c, "alice", "bob", 100)
    assert state(c, "alice")["balance"] == 900, "debited on send"
    assert state(c, "alice")["in_flight"] == 100, "shown as in flight"
    assert state(c, "bob")["balance"] == 1000, "bob gets nothing before claiming"

    resolve(c, tok, "claim", actor="bob")
    assert state(c, "bob")["balance"] == 1100, "credited on claim"
    for action, actor in [("claim", "bob"), ("cancel", "alice")]:
        try:
            resolve(c, tok, action, actor=actor)
            raise AssertionError("settled twice")
        except ValueError:
            pass
    assert state(c, "bob")["balance"] == 1100, "no double credit"

    tok = send(c, "alice", "bob", 50)
    resolve(c, tok, "cancel", actor="alice")
    assert state(c, "alice")["balance"] == 900, "refunded on cancel"

    tok = send(c, "alice", "bob", 25)
    try:
        resolve(c, tok, "cancel", actor="bob")
        raise AssertionError("bob cancelled alice's transfer")
    except ValueError:
        pass
    assert sweep(c, now=time.time() + HOLD_SECONDS + 1) == 1, "one expired"
    assert state(c, "alice")["balance"] == 900, "auto-returned"

    for args in [("alice", "bob", 10000), ("alice", "alice", 5), ("alice", "bob", -5),
                 ("alice", "bob", 0), ("", "bob", 5)]:
        try:
            send(c, *args)
            raise AssertionError("accepted bad send: %r" % (args,))
        except ValueError:
            pass

    total = sum(r[0] for r in c.execute("SELECT balance FROM accounts")) + sum(
        r[0] for r in c.execute("SELECT amount FROM transfers WHERE status='pending'"))
    assert total == 2000, "money leaked: %s" % total
    c.close()
    os.remove(t)
    print("ok")


if __name__ == "__main__":
    import sys
    if "--test" in sys.argv:
        demo()
    else:
        db().close()
        port = int(os.environ.get("PORT", 8000))
        print("db: %s" % DB)
        print("listening on :%d  (site /, app /app)" % port)
        http.server.ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
