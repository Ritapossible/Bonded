---
name: bonded
description: |
  Place Binance Spot orders through a mandate gate that refuses anything outside limits the
  owner set, and reconciles every executed order against what was actually authorised.
  Use when an agent needs to trade a Binance account unattended and the owner wants the
  bound enforced rather than requested — "trade within these limits", "give the agent a
  spending mandate", "let it trade but cap the size", "audit what my agent traded", "did
  anything trade that I didn't authorise". Also use when an order was refused and you need
  the clause that refused it, or when the bond has been burned and trading has stopped.
  Every order returns either PLACED with a stamped client order id, or DENIED naming the
  exact mandate clause it breached. Do NOT use this skill to decide *what* to trade — it
  enforces limits, it does not produce strategies or signals.
version: 0.1.0
license: MIT
metadata:
  author: Ritapossible
---

# BONDED

**Going around BONDED is possible. Going around it unnoticed is not.**

BONDED sits between an AI agent and a Binance Spot account. The agent holds no Binance
credential — its entire capability is this skill's tools, so the bound is structural
rather than advisory. There is no "please don't" to ignore, only tools that refuse.

Repository: <https://github.com/Ritapossible/Bonded>

## When to use it

- An agent should trade a Binance account **unattended**, and the owner wants limits that
  hold without a human confirming each order.
- The owner needs to know whether anything traded on the account that BONDED did not
  authorise.
- An order was refused and you need to know which clause refused it.

## When not to use it

- **Deciding what to trade.** BONDED enforces limits; it produces no signals, strategies
  or recommendations. Pair it with whatever decides.
- **Reading market data.** Use Binance's own MCP server or the `binance` skill; BONDED
  is built to run alongside them (see below).
- **Anything but Spot.** Futures and margin are out of scope in this version.

## Setup

Node 22+. Binance **Spot Testnet** keys from <https://testnet.binance.vision>.

```bash
git clone https://github.com/Ritapossible/Bonded && cd Bonded
npm install && npm run build

cp .env.example .env      # fill in BINANCE_API_KEY and BINANCE_SECRET_KEY
openssl rand -hex 32      # -> BONDED_HMAC_SECRET
mkdir -p data
cp examples/mandate.example.json data/mandate.json
```

Register the MCP server with your agent. BONDED speaks MCP over stdio, so any MCP client
works — Claude Code, Codex CLI, Claude Desktop, Cursor, Windsurf, VS Code:

```bash
claude mcp add bonded -- node /absolute/path/to/Bonded/dist/cli.js
```

For a client that uses a config file, the command is `node` and the single argument is the
absolute path to `dist/cli.js`. Pass the credentials in that config's `env` block: an agent
launched from a desktop app has no shell, and BONDED will not find your `.env` if it also
runs from a directory you did not choose. Full per-client configs are in the
[documentation](https://bonded-one.vercel.app/docs#connect).

BONDED prints a boot-guard banner to stderr and **refuses to start** if any guard fails —
wrong environment, expired mandate, broken audit chain, clock skew, or no readable order
history. A guard that cannot perform its check reports `WARN` and says what it checked
instead; it never claims a check it did not make.

### Reference prices through Binance's own CLI

`@binance/binance-cli` is a runtime dependency, and reference prices can be read through
it rather than through BONDED's REST client:

```bash
export BONDED_PRICE_SOURCE=binance-cli
```

It takes the same environment variables BONDED already reads, supports testnet, and needs
no extra credential. Orders are always signed by BONDED itself — the gate has to control
the exact query string it signs and stamp an unforgeable `clientOrderId` on every order,
so the write path never leaves the process. Reads have no such constraint. Either source
fails closed: an unavailable price denies the order rather than sizing it against a guess.

### Alongside Binance's own MCP server

BONDED does not replace Binance's MCP server; it sits next to it. Register both and the
agent reads from Binance and writes through the mandate:

```bash
claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic
claude mcp add bonded -- node /absolute/path/to/Bonded/dist/cli.js
```

Grant Binance's server the **Market data** scope and withhold **Trade**. Market data is
public and needs no credentials, so the agent gets tickers, order books and candles from
Binance directly; every order it then decides to place goes through BONDED, checked against
the mandate and written to the hash-chained log before it is signed.

The two reach different accounts, deliberately. Binance's MCP server trades a dedicated
Agentic sub-account over OAuth, with every trade confirmed by a human and no withdrawal
scope in existence — that path is already guarded and BONDED has nothing to add to it.
BONDED guards the other path: raw API keys, no confirmation step, which is what an
unattended agent actually runs on.

## Tools

| Tool | Purpose |
| --- | --- |
| `place_order` | Submit a Spot order for evaluation. Returns `PLACED`, `DENIED` or `FAILED` |
| `check_order` | Evaluate an order **without** placing it or consuming an audit entry |
| `cancel_order` | Cancel an order by its client order id. Never refused — see below |
| `get_mandate_summary` | Mandate hash, expiry, clause **names**, and whether scope is revoked |
| `get_account` | Balances and open-order count, with the time they were observed |

### Placing an order

```json
{ "symbol": "ETHUSDT", "side": "BUY", "type": "LIMIT", "quantity": "0.1", "price": "2000" }
```

A `LIMIT` order needs `quantity` and `price`. A `MARKET` order needs **either** `quantity`
(base asset) **or** `quoteOrderQty` (quote asset) — never both. All numeric values are
decimal **strings**, matching Binance's own convention; a float loses precision that a
limit check depends on.

### Cancelling

Cancellation is **always permitted**, deliberately. Every mandate clause exists to limit
exposure, and cancelling only ever reduces it — a gate able to refuse a cancellation could
trap an agent in a position it is not allowed to close, which is the opposite of what the
mandate is for. Ungated is not unrecorded: each cancellation is appended to the same
hash-chained log as the decisions, so the trail shows the whole lifecycle.

## How to behave when an order is denied

**A denial is a normal outcome, not an error.** It arrives as a successful tool call:

```json
{
  "status": "DENIED",
  "seq": 412,
  "clause": "maxNotionalUsd",
  "clauseText": "Order notional must not exceed the mandate's maximum.",
  "observed": "900",
  "limit": "500"
}
```

Three rules for an agent reading this:

1. **Do not retry the same order.** The mandate is data; it will not change between
   attempts. A retry loop burns rate limit and produces nothing.
2. **Read `clause` and adjust.** The denial names exactly what to change. `observed` and
   `limit` tell you by how much.
3. **`clause: "scope"` means stop.** The bond has been burned — an order executed on the
   account that BONDED never authorised. Every further order will be refused until the
   owner investigates. Report it to the owner rather than working around it.

Use `check_order` first when you are unsure. It evaluates without placing anything and
without consuming an audit-log entry.

## What you cannot see

`get_mandate_summary` returns clause **names**, never thresholds. This is deliberate: an
agent that can read its limits can shape its behaviour to sit exactly inside them, which
is the behaviour the mandate exists to make visible. You learn the rules by being refused,
one clause at a time — and each refusal tells you the limit for that clause.

The names are derived from the gate itself, so every clause you can be refused by is one
the summary lists. There are nineteen.

## What BONDED does not protect against

Worth knowing, because overstating it would be worse than not having it:

- **Host compromise.** The bound rests on key custody. Compromise the machine BONDED runs
  on and the bound is gone. It is not a TEE and not a ZK circuit.
- **Bad trades inside the mandate.** BONDED audits compliance, not quality. It cannot tell
  you a permitted trade was unwise.
- **Preventing a bypass.** Reconciliation *detects*; a bypass order fills before BONDED
  sees it. The guarantee is deterrence plus attribution, not prevention.
- **Seeing every symbol without the stream.** Binance's REST order history needs a symbol,
  so the polling backstop only covers the symbols it was given. The account-wide user data
  stream closes that gap, and without it BONDED stops trading rather than claiming a
  coverage it does not have.
- **Instantaneous loss limits.** The loss caps compare against realised PnL refreshed on a
  30-second budget, so a fast sequence of losing trades can breach one and keep trading
  until the next refresh observes it.
- **Withdrawals.** Not BONDED's job — that is enforced at the exchange, on the API key
  itself. BONDED verifies at boot that it is, and refuses to run otherwise.

## Reconciliation

Every order on the account is checked against BONDED's authorisation log, using Binance's
own order history as the second, independent account. Five outcomes:

| Outcome | Meaning |
| --- | --- |
| `AUTHORISED` | Executed exactly as authorised |
| `MISMATCHED` | Authorised — but not for the order that executed |
| `FOREIGN` | No BONDED identifier. A plain bypass |
| `FORGED` | Wears BONDED's namespace without a valid tag |
| `UNKNOWN_AUTHENTIC` | Valid tag, no matching record. A log-integrity problem |

Anything but the first burns the bond and revokes trade scope. Findings carry a plain
explanation, the verbatim evidence, a Binance order id checkable independently of BONDED,
and an explicit list of what could not be determined.

The owner watches this at `http://127.0.0.1:7391` — loopback only, read-only.
