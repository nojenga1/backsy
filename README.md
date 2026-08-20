# Backsy

The wallet with reversible transfers. Send now, take it back until it's claimed.

> **Early prototype.** Reversible transfers run on a *simulated* escrow — there is no
> on-chain program deployed and no real funds move. Do not put real money behind it.

## What's here

| Path | What it is |
|---|---|
| `app.py` | The whole backend: API, the app UI, and the static site. No dependencies. |
| `site/` | Marketing site — 7 pages, plain HTML + one stylesheet, no build step. |
| `ext/` | Chrome extension (Manifest V3) that shows the app in a popup. |

## Run it

```
python app.py
```

Then open http://localhost:8000

| Route | What |
|---|---|
| `/` | the site |
| `/app` | the wallet |
| `/c/<token>` | a claim link |
| `/api/*` | JSON API |

Every new name gets 1000 in demo balance automatically. Open two tabs as `alice`
and `bob` to see both sides of a transfer.

## Tests

```
python app.py --test
```

Covers double claims, cancel-after-claim, cancellation by someone other than the
sender, overdraft, expiry, and a closing invariant that the sum of every balance
plus everything sitting in escrow never changes.

## How a transfer works

A transfer is always in exactly one state: `pending`, `claimed`, `cancelled`,
or `expired`. Once it leaves `pending` it can never go back.

- **Send** debits the sender inside a transaction with a conditional update, so an
  insufficient balance matches zero rows and the whole send rolls back.
- **Claim / cancel** update the transfer *only while it is still pending*. The second
  of two racing claims matches nothing and pays out nothing.
- **Cancel** is checked against the transfer's own sender, not against whoever asked.
- **Expiry** returns unclaimed transfers after 7 days.

## Deploying

The app reads `PORT` from the environment and serves the site and the API from one
process, which is what a single-port host needs.

**Storage is a SQLite file.** On a host with an ephemeral filesystem the database is
wiped on every redeploy. Fine for a prototype; attach a persistent volume and point
`BACKSY_DB` at it before anyone's balance matters.

## The extension

`ext/` currently points at `http://localhost:8000`. To ship it, change that URL in
`ext/manifest.json` and `ext/popup.html` to the deployed one.

Load it unpacked: `chrome://extensions` → Developer mode → Load unpacked → pick `ext/`.

## What is real, and what isn't

Real: the state machine, the concurrency guards, the claim links, the expiry.
Not real: the chain. The escrow is a row in SQLite that the server agrees to honour.
