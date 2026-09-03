# bonded

A mandate gate between an AI agent and a Binance Spot account.

The agent holds no Binance credential. Every order it submits is evaluated against a
mandate the owner wrote, and every order that reaches the exchange is reconciled against
what was actually authorised — so an order the gate never approved is detected rather than
merely discouraged.

**This skill does not decide what to trade.** It produces no signals, strategies or
recommendations. It enforces limits and reports what it refused and why.

## Requirements

- Node.js 22 or later
- Binance Spot Testnet API key and secret — <https://testnet.binance.vision>
- No system binaries, no root

## Install

```bash
git clone https://github.com/Ritapossible/Bonded && cd Bonded
npm install && npm run build

cp .env.example .env      # BINANCE_API_KEY, BINANCE_SECRET_KEY
openssl rand -hex 32      # -> BONDED_HMAC_SECRET
cp examples/mandate.example.json data/mandate.json
```

Register with your agent:

```bash
claude mcp add bonded -- node /absolute/path/to/Bonded/dist/cli.js
```

On startup it prints a boot-guard banner to stderr and refuses to run if any guard fails.

## Tools

| Tool | Purpose |
| --- | --- |
| `place_order` | Submit a Spot order. Returns `PLACED`, `DENIED` or `FAILED` |
| `check_order` | Evaluate without placing, and without consuming an audit entry |
| `get_mandate_summary` | Mandate hash, expiry, clause names, scope status |
| `get_account` | Balances and open-order count, with the observation time |

A denial is a normal outcome, not an error. It names the clause, the observed value and the
limit, so the agent can correct itself rather than retry.

## Scripts

None. The skill is an MCP server; there is nothing to run separately.

## Limits

Documented in full in the source repository's README. In short: the bound rests on key
custody and does not survive host compromise; reconciliation detects and attributes but
cannot prevent; it audits compliance, not trade quality; and the withdrawal guarantee is
enforced by the exchange on the API key, which this skill verifies at boot rather than
implements.

## Licence

MIT. Source and full documentation: <https://github.com/Ritapossible/Bonded>
