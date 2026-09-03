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

Pre-implementation. Planning docs only.

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

## Licence

MIT
