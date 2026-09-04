# BONDED

**Going around BONDED is possible. Going around it unnoticed is not.**

An AI agent trading a Binance account gets no credential of its own — only a mandate. Every
order that reaches the exchange is reconciled against what BONDED actually authorised, so an
order it never approved is detected, attributed, and burns the bond.

Built for the **Binance Agent OS Mini Hackathon**, Track A (Agent Workflows → Trading
Workflows). Deadline **2026-09-08 23:59 UTC**.

---

## The problem

Binance ships two ways for an AI agent to trade your account, and they have very different
security postures:

| Path | Guarded? |
| --- | --- |
| **MCP Server** (`agent.binance.com/mcp/agentic`) | Yes — dedicated Agentic sub-account, withdrawal scope never available, **every trade confirmed by you first** |
| **Skills Hub / `binance-cli`** | **No** — takes raw `BINANCE_API_KEY` / `BINANCE_SECRET_KEY`, no confirmation step |

Binance guarded the path where a human approves every trade. It did not guard the path where
an agent holds your API keys directly — and that is the path every agent framework actually
uses, because it is the one that runs unattended.

BONDED guards that one.

## What it does

1. **Holds the credential.** The agent talks to BONDED's MCP server, never to Binance. It has
   no key of its own.
2. **Gates every order** against a mandate it cannot read — symbol allowlist, max notional,
   leverage ceiling, drawdown, trading window. Denials are sub-millisecond and name the exact
   clause that fired.
3. **Reconciles what actually happened.** Binance's user data stream reports every order on
   the account — *including ones BONDED never authorised*. An unexplained order is a bypass:
   the bond burns and trade scope is revoked.

Point 3 is the one nobody else has built. A gate is blind to anything that goes around it, so
BONDED keeps a second, independent account of reality and treats disagreement as the finding.

Five outcomes, and the differences matter:

| Outcome | Meaning |
| --- | --- |
| `AUTHORISED` | An order BONDED allowed, executed exactly as authorised |
| `MISMATCHED` | Authorised — but the order that executed is not the one authorised |
| `FOREIGN` | No BONDED identifier at all. A plain bypass |
| `FORGED` | Wears BONDED's namespace without a valid tag — worse than foreign |
| `UNKNOWN_AUTHENTIC` | Tag verifies, no matching record. A log-integrity problem |

Anything but the first burns the bond and revokes trade scope. Every finding ships with a
plain explanation, the verbatim evidence, a Binance order id anyone can check independently,
and an explicit list of what could **not** be determined.

## Honest limits

Every one of these is a real weakness. They are here rather than buried because a security
design that does not name its own limits has not been examined, and because each is
something a careful reader would find in ten minutes anyway.

### The bound rests on key custody

BONDED is **not a TEE and not a ZK circuit**. It holds the Binance credential and the agent
does not, which is what makes the bound structural rather than advisory — but compromise the
machine BONDED runs on and the bound is gone. On the ladder of enforcement mechanisms this
is the middle rung: a signed mandate with a public trace. The rungs above it need attested
hardware or a ZK-native chain, and neither was reachable here.

### Reconciliation detects; it does not prevent

A bypass order reaches the exchange and fills **before** BONDED sees it. What BONDED
guarantees is that it will not go unnoticed: the order is attributed, the bond burns, and
scope is revoked so nothing further can be placed through the gate. Deterrence plus
attribution, not prevention. Every `FOREIGN` finding says exactly this in its own
uncertainty list, on screen, in the demo.

### It audits compliance, not quality

The gate can prove an order was inside the mandate. It has no opinion on whether the trade
was sensible, and it cannot acquire one. An agent that loses money strictly within its
limits is a mandate problem, not a BONDED problem.

### The withdrawal guarantee is not verified on testnet

BONDED does not implement a withdrawal guard — it verifies the exchange enforces one, which
is stronger, because that guarantee survives BONDED being wrong about everything else. But
`GET /sapi/v1/account/apiRestrictions` does not exist on Spot Testnet, so on testnet the
guard reports `WARN` and states that it asserted `BINANCE_API_ENV=testnet` instead. It does
not report a pass it did not earn.

### Two loss limits, and what they mean

`dailyLossLimitUsd` is absolute; `maxDrawdownPct` is the same loss as a percentage of the
account's quote-asset balance. Whichever is tighter fires first. Both compare against
**realised** PnL computed with an average cost basis from Binance's own trade history —
the definition is stated in full in `src/domain/pnl.ts`, because an undefined risk metric
is worse than none.

Positions opened before the seven-day basis window have no known cost here. Selling one
realises an unknown amount, so that quantity is excluded from the figure and reported
rather than guessed at. The limits therefore **understate** activity in that case; they
never overstate it.

### The gate is only as good as the mandate

A mandate that compiles to weaker rules than the owner intended fails silently — nothing
downstream can detect the difference between "permitted" and "permitted by mistake". The
mitigations are human: clauses render as numbered text before anything runs, and an
unrecognised clause name is a hard error rather than an ignored key.

### Testnet fills are not real fills

Testnet liquidity does not resemble production. No PnL figure produced here means anything,
and none is presented as if it does.

### The user data stream is a single point of failure

A dropped socket blinds real-time detection. The polling backstop is a hard startup
dependency for exactly this reason — no audit path, no trading — but a mid-session stream
loss degrades detection from near-instant to one polling interval until it reconnects.

### What has not been exercised against a live exchange

Development ran in an environment Binance geo-blocks, so **the live testnet round trip has
not been run** — signing, order placement and the user data stream are covered by tests
against a stubbed exchange, not by a real one. The listen-key flow in particular is
unverified: it is used deliberately, because `userDataStream.subscribe` requires
`session.logon` and therefore Ed25519 keys that Spot Testnet does not issue, but whether it
behaves as documented is an open question recorded in [MEMORY.md](./MEMORY.md).

## Status

**The reconciler works end to end.** The full sequence — allow, refuse, bypass, detect,
revoke — is covered by an integration test against a stubbed exchange.

| Component | State |
| --- | --- |
| Mandate compiler, content addressing, `exchangeInfo` grounding | done |
| Pre-trade gate — 17 clauses, pure, fail-closed | done |
| Realised PnL from trade history — the figure the loss limits bind on | done |
| Hash-chained decision log with tamper detection | done |
| Binance Spot REST client — signing, timeouts, bounded retries | done |
| MCP server — `place_order`, `check_order`, `get_mandate_summary`, `get_account` | done |
| Boot guards + startup banner | done |
| **Reconciler — authorisation index, classification, bond burn** | **done** |
| Order sources — polling backstop + user data stream | done |
| Owner console — one screen, live over SSE | done |
| Public API entry point, CI, process-level failure handling | done |

147 tests passing (unit, property, integration); typecheck, lint and format clean in CI.

### The console

![BONDED console showing a burned bond](docs/console.png)

One screen at `http://127.0.0.1:7391`, pushed over SSE. The bond state is the largest
thing on it and changes colour, so it reads on mute. `TESTNET` is permanently visible.

Its security posture is deliberate and tested: **loopback only** (never `0.0.0.0` — the
payload includes balances and order history), **read-only** (every method but `GET` is
refused, so a compromised browser tab cannot become a trading capability), and no
credential ever reaches the view model.

One difference from the agent's view: the console **does** show the mandate's thresholds.
The owner wrote them; hiding them would be theatre. `get_mandate_summary` still omits
them, because an agent that can read its limits can sit exactly inside them.

## Documents

| Document | Contents |
| --- | --- |
| [PLAN.md](./PLAN.md) | Scope, milestones, cut list, demo script, submission checklist |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Three planes, enforcement layers, data flows, invariants |
| [MEMORY.md](./MEMORY.md) | Verified research, decisions and why, dead ends, open questions |
| [SKILL.md](./SKILL.md) | Binance Skills Hub package — tool contract, and how an agent should behave when denied |

## Environment

Runs entirely on **Binance Spot Testnet** — no capital required.

```bash
export BINANCE_API_ENV=testnet
export BINANCE_SPOT_BASE_PATH=https://testnet.binance.vision
```

Testnet API keys: https://testnet.binance.vision/

### Running it

```bash
npm install
npm run build

cp .env.example .env          # then fill in testnet key, secret, and:
openssl rand -hex 32          # -> BONDED_HMAC_SECRET
cp examples/mandate.example.json data/mandate.json

npm start
```

Startup prints a guard banner to **stderr** (stdout is the MCP channel) and refuses to
run if anything fails:

```
BONDED boot guards
  [PASS] environment           testnet confirmed, base URL https://testnet.binance.vision
  [PASS] mandate               mandate ed1ff01a valid until 2026-09-08T23:59:00.000Z
  [WARN] withdrawalPermission  not verified: apiRestrictions is unavailable on Spot Testnet.
                               Asserted BINANCE_API_ENV=testnet instead
  [PASS] decisionLog           no existing log; starting at genesis
  [PASS] clockSkew             clock within 42 ms of exchange
  [PASS] symbolGrounding       2 symbols resolved from exchangeInfo
  [PASS] authorisationIndex    0 prior authorisations replayed
  [PASS] auditPath             order history reconciled every 15000 ms
```

The `WARN` is deliberate. That check cannot be performed on testnet, so the guard says
what it actually verified instead of reporting a pass it did not earn.

To connect an agent:

```bash
claude mcp add bonded -- node /path/to/bonded/dist/cli.js
```

To preview the console UI without credentials — **synthetic data, not a demo of the
system** — run `node scripts/console-preview.mjs`. The real demo is
`tests/integration/bypass-detection.test.ts`.

### Development

```bash
npm run check      # typecheck + lint + tests
npm test           # 147 tests, ~1.7s
```

## Licence

MIT
