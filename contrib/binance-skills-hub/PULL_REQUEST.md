# Summary

Adds `bonded`, a skill that places Binance Spot orders through a **mandate gate** and
reconciles every executed order against what was actually authorised.

The agent holds no Binance credential — its entire capability is the skill's five tools, so
the bound is structural rather than advisory. Each order returns either `PLACED` with a
stamped client order id, or `DENIED` naming the exact mandate clause it breached.

The skill does not decide what to trade. It produces no signals, strategies or
recommendations; it enforces limits an owner wrote and reports what it refused and why.

Source: <https://github.com/Ritapossible/Bonded> — MIT, 309 tests, typecheck and lint clean.

# APIs Used

All Binance Spot REST, against Spot Testnet by default (`https://testnet.binance.vision`).

HTTP Info | Description | Required Parameters | Optional Parameters | Authentication
--------- | ----------- | ------------------- | ------------------- | -------------
GET /api/v3/time | Clock-skew check at startup, before any signed request | None | None | No
GET /api/v3/exchangeInfo | Grounds the mandate: resolves each symbol and inherits its real tick size, step size and min notional | None | symbols | No
GET /api/v3/account | Balances and trading status for the gate's limit checks | None | recvWindow | Yes (signed)
GET /api/v3/openOrders | Open-order count for the `maxOpenOrders` clause | None | symbol, recvWindow | Yes (signed)
GET /api/v3/ticker/price | Reference price, to bound the notional of a base-denominated market order | None | symbol, symbols | No
GET /api/v3/allOrders | Reconciliation backstop — reads order history including orders the gate never saw | symbol | startTime, limit, recvWindow | Yes (signed)
POST /api/v3/order | Places an order, stamped with an HMAC-authenticated `newClientOrderId` | symbol, side, type | quantity, price, quoteOrderQty, timeInForce, newClientOrderId, recvWindow | Yes (signed)
DELETE /api/v3/order | Cancels an order | symbol, orderId or origClientOrderId | recvWindow | Yes (signed)
POST /api/v3/userDataStream | Opens the user data stream for real-time `executionReport` events | None | None | Yes (API key only)
PUT /api/v3/userDataStream | Keeps the listen key alive inside its 60-minute window | listenKey | None | Yes (API key only)
DELETE /api/v3/userDataStream | Closes the stream on shutdown | listenKey | None | Yes (API key only)
GET /sapi/v1/account/apiRestrictions | Boot guard: verifies the API key cannot withdraw. **Mainnet only** — on testnet the guard reports `WARN` and states what it checked instead | None | recvWindow | Yes (signed)

WebSocket: `wss://stream.testnet.binance.vision/ws/<listenKey>` for `executionReport` events.

> **Known limitation, verified on Spot Testnet 2026-09-06.** Binance removed the
> listen-key REST endpoints in February 2026 and they now answer `410 Gone`, so the
> account-wide stream does not connect. The skill treats that as a permanent failure,
> reports it once on the boot banner rather than retrying, and refuses to start unless
> `BONDED_ALLOW_PARTIAL_AUDIT=1` accepts symbol-scoped polling instead. Migrating to
> `POST /sapi/v1/userListenToken` + `userDataStream.subscribe.listenToken` is the
> outstanding work; it is listed here rather than left for a reviewer to discover.

# Binaries Used

- **node** (>= 22; >= 22.13 for the optional binance-cli price source) — the runtime. The skill runs an MCP server over stdio.

No system binaries and no root. Runtime dependencies are five packages:
`@binance/binance-cli`, `@modelcontextprotocol/sdk`, `zod`, `decimal.js`, `pino`.

The one subprocess is optional and opt-in: with `BONDED_PRICE_SOURCE=binance-cli`,
reference prices are read via `binance-cli spot ticker-price` rather than through the
skill's own signed client. Orders are always signed in-process — the gate has to control
the exact query string it signs and stamp a `newClientOrderId` on each order, so the
write path never leaves the process. Reads carry no such constraint. Either source fails
closed: an unavailable price denies the order instead of sizing it against a guess.

# How it works

**1. The mandate.** A JSON document stating what the agent may do — symbol allowlist, max
notional, max open orders, permitted order types and sides, daily loss limit, UTC trading
window, expiry. It is validated, grounded against live `exchangeInfo`, then canonicalised
and hashed. That `mandateHash` is stamped into every audit record, so a record always cites
one exact ruleset and the rules cannot be quietly widened while the trail is kept.

**2. The gate.** A pure function of `(mandate, intent, exchange state, now)` — no I/O, no
clock reads — evaluating seventeen clauses in a fixed order. It fails closed: stale exchange
state, a missing reference price, or an unresolvable symbol all deny rather than pass. Every
denial names the clause that fired, with the observed value and the limit.

**3. The audit log.** Every decision — allows as well as denials — is appended to a
hash-chained JSONL file and `fsync`'d **before** the order is sent. That ordering is the
whole safety argument: an order can never reach the exchange carrying an authorisation that
a crash could erase. The reverse ordering would manufacture phantom bypasses.

**4. Reconciliation.** The gate is structurally blind to anything that goes around it, so
the skill keeps a second, independent account of reality — Binance's own order history, via
the user data stream with `allOrders` as a backstop — and diffs the two. Every authorised
order is stamped with `bnd_<mandateHash8>_<seq>_<hmac>`, so an order on the account with no
matching authorisation is detectable. Five outcomes:

| Outcome | Meaning |
| --- | --- |
| `AUTHORISED` | Executed exactly as authorised |
| `MISMATCHED` | Authorised — but the order that executed is not the one authorised |
| `FOREIGN` | No identifier from this skill at all |
| `FORGED` | Wears the namespace without a valid authentication tag |
| `UNKNOWN_AUTHENTIC` | Valid tag, no matching record — a log-integrity problem |

Anything but the first revokes trade scope; every subsequent order is refused with
`clause: "scope"` until the owner investigates. Findings carry a plain explanation, the
verbatim exchange payload, a Binance `orderId` checkable independently of the skill, and an
explicit list of what could not be determined.

**5. Boot guards.** The skill refuses to start unless environment, mandate validity, audit
chain integrity, clock skew and a readable order history all check out, and prints what each
guard actually verified. A guard that cannot perform its check reports `WARN` and says so —
it never claims a pass it did not earn.

# Use Cases

- **Unattended agent trading.** An owner wants an agent to trade while they sleep, with
  size, symbol and loss limits that hold without a human approving each order.
- **Answering "did anything trade that I didn't authorise?"** Reconciliation gives a
  checkable answer rather than a self-reported log, because the exchange's record is the
  second source.
- **Debugging a refused order.** The agent gets the clause, the observed value and the
  limit, so it can correct itself instead of retrying blindly.
- **Testing a mandate before trusting it.** `check_order` evaluates without placing anything
  and without consuming an audit-log entry.

# Notes for reviewers

Two things worth flagging rather than leaving you to find:

1. **Frontmatter convention.** `CONTRIBUTING.md` specifies top-level `name`, `description`,
   `version`, `license`; the root `README.md` shows `title:`; and every skill in the tree
   uses `name:` with `version` nested under `metadata`. This skill follows `CONTRIBUTING.md`
   and additionally carries `metadata.author` to match in-tree practice. Happy to change it
   to whichever is canonical — it may be worth aligning the two documents.

2. **Namespace.** Existing skills sit under `skills/binance/` and `skills/binance-web3/`,
   which read as first-party. This one is not a Binance-operated service, so it is placed at
   `skills/bonded/` per the structure in `CONTRIBUTING.md`. Happy to move it.

On the Trading Rules: this skill promotes no coin, token or asset, presents nothing as safe
or recommended, and contains no wallet addresses. It produces no trading recommendations of
any kind — refusing orders is the entire product.

Built for the Binance Agent OS Mini Hackathon (Track A).
