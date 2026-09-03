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

## What it does not do

- **It is not a TEE and not a ZK circuit.** The bound rests on key custody. Compromise the
  BONDED host and the bound is gone.
- **It audits compliance, not quality.** It cannot tell you a trade was unwise.
- **Reconciliation detects; it does not prevent.** A bypass order fills before BONDED sees it.
  The guarantee is deterrence plus attribution, not prevention.
- **It does not stop withdrawals** — because it never needs to. That is enforced one layer
  below, at the exchange, and BONDED refuses to boot unless it is.

## Status

**Day 1 complete.** The gate, the audit log and the MCP surface are implemented and
tested; the reconciler (Day 3, the differentiator) is not yet built.

| Component | State |
| --- | --- |
| Mandate compiler, content addressing, `exchangeInfo` grounding | done |
| Pre-trade gate — 15 clauses, pure, fail-closed | done |
| Hash-chained decision log with tamper detection | done |
| Binance Spot REST client — signing, timeouts, bounded retries | done |
| MCP server — `place_order`, `check_order`, `get_mandate_summary`, `get_account` | done |
| Boot guards + startup banner | done |
| **Reconciler / bypass detection** | **not started** |
| Owner console | not started |

69 tests passing (unit + property), typecheck and lint clean.

## Documents

| Document | Contents |
| --- | --- |
| [PLAN.md](./PLAN.md) | Scope, milestones, cut list, demo script, submission checklist |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Three planes, enforcement layers, data flows, invariants |
| [MEMORY.md](./MEMORY.md) | Verified research, decisions and why, dead ends, open questions |

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
```

The `WARN` is deliberate. That check cannot be performed on testnet, so the guard says
what it actually verified instead of reporting a pass it did not earn.

To connect an agent:

```bash
claude mcp add bonded -- node /path/to/bonded/dist/cli.js
```

### Development

```bash
npm run check      # typecheck + lint + tests
npm test           # 69 tests, ~1s
```

## Licence

MIT
