# Recording the demo

The X post is the only rubric there is, so the video is the rubric. This is the runbook:
every command in order, so a take fails on nerves rather than on typing.

Read [PLAN.md §6](./PLAN.md) first for the beat sheet — what the 30 seconds have to land.
This file is the mechanics.

## Before you press record

```bash
npm ci && npm run build

mkdir -p data
cp examples/mandate.example.json data/mandate.json
cp .env.example .env          # fill in the two testnet keys
openssl rand -hex 32          # -> BONDED_HMAC_SECRET in .env
```

Add two more lines to `.env`. Binance removed the listen-key endpoints in February 2026,
so the account-wide stream answers 410 and BONDED refuses to start until it is told that
symbol-scoped polling is acceptable:

```
BONDED_ALLOW_PARTIAL_AUDIT=1
BONDED_POLL_INTERVAL_MS=5000
```

Five seconds keeps bypass detection inside one unbroken shot. The bypass targets a
mandate symbol, so the poller sees it; an order on a symbol *outside* the mandate would
not be seen at all, which is exactly what the banner's WARN is telling you.

Do not go much lower. A poll no longer retries internally, so a pass is bounded, but a
very short interval still means more requests into a testnet that is not always
obliging — and a pass that never lands is a pass that cannot detect anything.

Testnet keys come from <https://testnet.binance.vision> (log in with GitHub). The account is
funded automatically; there is nothing to deposit and no money at risk.

Run it once before recording:

```bash
npm start
```

You are looking for four `[PASS]` lines and one `[WARN]`. The WARN on
`withdrawalPermission` is expected and correct — Spot Testnet has no `apiRestrictions`
endpoint, so the guard reports what it checked instead of claiming a check it could not
make. If any line reads `[FAIL]`, BONDED refuses to start and the banner names why; fix that
before recording, not during.

Leave it running. The console is at <http://127.0.0.1:7391>.

Then, in a second shell, confirm the agent-facing surface before you rely on it:

```bash
npm run smoke
```

It drives BONDED over MCP and evaluates orders through the gate without placing any —
so it is safe to run repeatedly, right up to the moment you press record. If the gate is
misconfigured you find out here rather than on camera.

## Window layout

Two windows, side by side, nothing else on screen.

| Side | What | Why |
| --- | --- | --- |
| Left | Claude Code with the `bonded` MCP server registered | The agent, acting |
| Right | <http://127.0.0.1:7391> | The owner, watching |

```bash
claude mcp add bonded -- node "$(pwd)/dist/cli.js"
```

Optionally register Binance's own MCP server too, with the **Market data** scope only. It
costs nothing on camera and it answers the question a judge is entitled to ask — whether
this is really built alongside Agent OS or merely next to it:

```bash
claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic
```

The agent then reads prices from Binance and places orders through BONDED. Do not grant it
the Trade scope: that path confirms every trade with a human and has nothing to do with
what this demo is about.

Put the terminal font up two sizes. Half the audience watches this on a phone.

## The take

**Beat 1 — the gate refuses (0-6s).** In Claude Code:

> Buy 900 USD of ETH.

The tool returns `DENIED` naming `maxNotionalUsd`, observed 900 against a limit of 500. The
console's decision feed shows the same thing. This is setup, not the climax — do not linger.

**Beat 2 — the objection (6-12s).** Say the thing the viewer is already thinking:

> "Fine. I'll just use the API key directly."

**Beat 3 — the bypass, and the catch (12-25s).** In a third shell, off to the side:

```bash
node scripts/bypass-order.mjs BTCUSDT BUY 0.001
```

It prints a real `orderId` and it fills. BONDED never authorised it. Within seconds the
console turns: **FOREIGN**, the order id matching the one on screen, the bond `CLEARED ->
BURNED`, trade scope revoked.

Then go back to the agent and ask for anything at all. It is refused with `scope`.

**Beat 4 — the line (25-30s).**

> "You can go around it. You can't go around it unnoticed."

## Rules for the cut

- **One beat.** The bypass detection is it. The blocked order in beat 1 is setup; do not
  cut it as a second climax.
- **It must read on mute.** Assume no audio: the clause name and the colour change carry it.
- **TESTNET on screen throughout**, and in the first caption. Disclosed, not hidden.
- **Leave the order id legible in both windows.** The same id in the bypass output and in
  the console finding is what tells a judge nothing was faked.
- Do not cut between the bypass and the detection. The unbroken shot is the evidence.

## If it goes wrong on camera

| Symptom | Cause | Fix |
| --- | --- | --- |
| `[FAIL] clockSkew` | Machine clock drifted, or no route to the exchange | Sync the clock; check the testnet is reachable |
| Bypass order rejected for `LOT_SIZE` | Quantity below the symbol's step size | Raise it: `node scripts/bypass-order.mjs BTCUSDT BUY 0.002` |
| Console shows nothing after the bypass | The stream is gone (410 since Feb 2026), so polling is the only source | Confirm `BONDED_ALLOW_PARTIAL_AUDIT=1` is set and lower `BONDED_POLL_INTERVAL_MS`. Detection lands within one poll interval |
| Everything is refused before you start | The bond is already burned from a previous take | Reset between takes (below) |
| The bond burned while you were setting up | `npm run redteam` was run with this instance live | Expected: the red team places a real order on the same account. Stop the recording instance before running it, then reset |

## Resetting between takes

The bond burns permanently, by design — that is the whole point. To record a second take,
start from a clean log:

```bash
rm -f data/decisions.jsonl
npm start
```

The decision log is the audit trail. Deleting it is fine on testnet while rehearsing and
would be tampering anywhere else.
