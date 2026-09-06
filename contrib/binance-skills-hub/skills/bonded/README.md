# bonded

A mandate gate between an AI agent and a Binance Spot account.

The agent holds no Binance credential. Every order it submits is evaluated against a
mandate the owner wrote, and every order that reaches the exchange is reconciled against
what was actually authorised — so an order the gate never approved is detected rather than
merely discouraged.

**This skill does not decide what to trade.** It produces no signals, strategies or
recommendations. It enforces limits and reports what it refused and why.

## Requirements

- Node.js 22 or later (22.13+ for the binance-cli price source)
- Binance Spot Testnet API key and secret — <https://testnet.binance.vision>
- No system binaries, no root

## Install

```bash
git clone https://github.com/Ritapossible/Bonded && cd Bonded
npm install && npm run build

cp .env.example .env      # BINANCE_API_KEY, BINANCE_SECRET_KEY
openssl rand -hex 32      # -> BONDED_HMAC_SECRET
mkdir -p data
cp examples/mandate.example.json data/mandate.json
```

Register with your agent:

```bash
claude mcp add bonded -- node /absolute/path/to/Bonded/dist/cli.js
```

On startup it prints a boot-guard banner to stderr and refuses to run if any guard fails.

### Alongside Binance's own MCP server

This skill does not replace Binance's MCP server; it runs next to it. Register both and the
agent reads from Binance and writes through the mandate:

```bash
claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic
claude mcp add bonded -- node /absolute/path/to/Bonded/dist/cli.js
```

Grant Binance's server the **Market data** scope and withhold **Trade**. Market data is
public and needs no credentials; every order the agent then decides to place goes through
the mandate gate. The division is deliberate: Binance's MCP path trades an Agentic
sub-account over OAuth with every trade confirmed by a human and no withdrawal scope in
existence, so it is already guarded. This skill guards the other path - raw API keys, no
confirmation step - which is what an unattended agent runs on.

## Tools

| Tool | Purpose |
| --- | --- |
| `place_order` | Submit a Spot order. Returns `PLACED`, `DENIED` or `FAILED` |
| `check_order` | Evaluate without placing, and without consuming an audit entry |
| `cancel_order` | Cancel an order by its client order id. Never refused - cancelling only reduces exposure |
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
