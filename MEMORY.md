# BONDED — Project Memory

Durable context for anyone (human or agent) picking this up cold. Everything here was verified
against a primary source on **2026-09-03**, unless marked otherwise.

Read this before `PLAN.md` or `ARCHITECTURE.md` — those say *what* and *how*; this says *why*,
and records what was already tried and ruled out.

---

## 1. The event

| | |
| --- | --- |
| Event | Binance Agent OS Mini Hackathon |
| Deadline | **2026-09-08 23:59 UTC** |
| Track A | Build an AI agent with Agent OS — **20,000 USDC** |
| Track B | Connect your MCPs and trade — 40,000 USDC |
| Entry | Follow @Binance, repost, reply/quote-repost with video + GitHub, complete the survey |
| Survey | `app.binance.com/uni-qr/user-su…` — behind Binance login |
| Excluded | US, UK, EEA, Hong Kong, Singapore, and Binance's prohibited list. **Nigeria is eligible** (confirmed by the builder) |

**Track A's four workflow buckets** (from the promotional card): Data & Analysis (Reports,
Market Analysis, Portfolio Insights) · **Trading Workflows (Signals, Strategies, Automated
Actions)** · Payment Workflows (Agent-to-Agent, Automated Payments) · Onchain Workflows
(Staking, DeFi, Onchain Actions). BONDED targets Trading Workflows.

**Track B is not viable here** — it requires real trading capital. Chosen Track A for that
reason, not because the pool is bigger.

### There is no rules page

Searched Binance's announcement system and the wider web. **No Devpost, no DoraHacks, no
judging rubric, no submission portal.** The X post is the rules.

Consequence: **the demo video is the rubric.** Optimise the 30 seconds over system breadth.

The only adjacent official announcement is a *different, earlier* campaign — ["Put Your Binance
Agent OS to Work & Share 2,000 USDC"](https://www.binance.com/en/support/announcement/detail/609d1628fc42433b9d48458fb7d46513),
Aug 25–30, a Discord challenge series. Useful for one thing: it confirms **Binance Discord has
a Builders chat and an agent-registration channel** — the only realistic place to get a rules
question answered before the deadline.

---

## 2. Verified technical findings

### Testnet is available — this is the finding the project rests on

`binance-cli` (official, `@binance/binance-cli`, shipped via Skills Hub) supports three
environments. From [binance/binance-cli](https://github.com/binance/binance-cli) README —
**note the branch is `master`, not `main`**:

```bash
# valid options: prod, demo and testnet
export BINANCE_API_ENV=testnet
export BINANCE_SPOT_BASE_PATH=https://testnet.binance.vision
export BINANCE_FUTURES_USDS_BASE_PATH=https://testnet.binancefuture.com
```

Confirmed again in Skills Hub's own `skills/binance/binance/references/auth.md`:
`BINANCE_API_ENV: <prod|testnet|demo>`, and
`binance-cli profile create --env <prod|testnet|demo>`.

Two corollaries:
- **Futures testnet exists** (`testnet.binancefuture.com`). The docs *site* lists only Spot
  testnet; the CLI documents both.
- **`demo` is a third environment** whose semantics are undocumented. Unexplored — may be a
  better demo surface than testnet. Worth ten minutes.

### User data streams work on Spot Testnet — the reconciler depends on this

[Docs](https://developers.binance.com/en/docs/products/spot/testnet/user-data-stream):

- Events pushed **in real time**
- Order updates arrive as **`executionReport`**; balance changes as `outboundAccountPosition`
- Subscribe via the **WebSocket API** — `userDataStream.subscribe`, authenticated with an API
  key. **Not** the legacy REST `listenKey` flow. `userDataStream.unsubscribe` closes it
- JSON and SBE both supported

This was the single load-bearing unknown. It resolved in our favour: bypass detection is
instant rather than polled, which is the difference between a 30-second demo and a cron job.

### The MCP server path is already guarded by Binance

From [/agent-native/mcp-server/agentic](https://developers.binance.com/en/docs/agent-native/mcp-server/agentic):

- Endpoint `https://agent.binance.com/mcp/agentic`, OAuth — **no API keys on your device**
- Everything runs in a **dedicated Agentic sub-account**
- **"Withdrawal scope: Never available"** — funds can never leave the sub-account
- **"Every trade / transfer: Confirmed by you first"**
- Scopes: Market data (public, no auth) · Account · Trade · Transfer. Transfer only moves funds
  *between wallets inside* the same sub-account
- Changing scopes requires disconnect + reconnect
- Desktop browser only for setup
- **No testnet**

### The Skills Hub / `binance-cli` path is not guarded

`skills/binance/binance/references/auth.md` takes raw `BINANCE_API_KEY` and
`BINANCE_SECRET_KEY` via env vars, profile files, or "sending them directly to the agent in the
chat." **No confirmation step, no sub-account isolation, no withdrawal fence.**

**This asymmetry is the entire product thesis.** Binance guarded the attended path and left the
unattended one open — and the unattended one is what agent frameworks actually use.

### Agentic Wallet — mainnet only

[Docs](https://developers.binance.com/en/docs/products/agentic-wallet/welcome): BSC 56,
Ethereum 1, Base 8453, Solana CT_501. No testnet. Requires a Binance account plus an MPC Wallet
created in the Binance App. Security settings (daily limit, tradable token scope, high-risk
handling) are **changeable only in the App** — the agent can read but never modify them.

Its skill surface is larger than the docs suggest: x402 payments, `approvals list/revoke`, DeFi
(staking, LP, health factor, APY, TVL), prediction markets, limit orders, EIP-712 signing,
speed-up/cancel.

### x402 / B402 — has a testnet, but gated

- Sandbox on **BSC Testnet (chain 97)**, faucet/mintable Mock U, USDC, USDT
- **But** `/verify` and `/settle` need merchant onboarding — clientId, accessToken, RSA public
  key, IP whitelist — and **the base URL itself is "contact us for access"** for *both* sandbox
  and production. Separate application per environment, via
  [this form](https://forms.gle/aUQvxUETfGMzyTky5)
- **Exception:** B402 Bazaar discovery is **public, no auth**, stable URL
  `https://www.binance.com/bapi/ramp/v1/public/ramp/b402`

Not used by BONDED. Recorded because it killed a sibling idea (§4).

### Skills Hub mechanics

[binance/binance-skills-hub](https://github.com/binance/binance-skills-hub) — 19 skills, split
`binance/` (spot, futures, convert, p2p, fiat, payment, onchain-pay, square-post, academy) and
`binance-web3/` (agentic-wallet, wallet-tracker, token-info, token-audit, meme-rush,
trading-signal, leaderboard, address-info, market-rank).

Contribution: fork → new folder with `SKILL.md` (YAML frontmatter: `title`, `description`,
`metadata.version`, `metadata.author`, `license`) → PR to `main`. Install via
`npx skills add https://github.com/binance/binance-skills-hub`. Node 22+.

**Precision note:** `skills/binance/onchain-pay` is **not** x402 — it is the fiat on-ramp
product. B402/x402 is a separate thing entirely. This was confused once; don't repeat it.

---

## 3. Decisions and why

| Decision | Reasoning |
| --- | --- |
| **Track A, Trading Workflows** | Track B needs capital. Trading is where the testnet story works and where the asymmetry (§2) lives |
| **Guard the `binance-cli` path, not the MCP path** | The MCP path is already guarded. Pitching against it would be an overclaim a judge disproves in one click |
| **Reconciliation is the product; the gate is table stakes** | Several entrants will build a gate. Nobody reconciles against the exchange's own record |
| **Bypass detection as the demo beat** | It answers the obvious objection ("I'll just use the key directly") *as the demo* rather than in a FAQ |
| **Testnet only** | Zero capital, and the honest environment for a security demo |
| **Key custody, not TEE/ZK** | Rung 3 of the enforcement ladder. Rungs 4–5 need hardware or a ZK-native chain — impossible in four days. Disclosed rather than hidden |
| **Withdrawals enforced at the exchange, verified at boot** | A guarantee that survives BONDED being wrong about everything else |
| **One console screen** | Breadth is not a claim. A comparable project shipped eight dashboard surfaces and placed 2nd |
| **Prefer `binance-cli` over direct REST** | Sponsor-tooling alignment. Fall back to REST only where the CLI cannot express what the gate needs |

---

## 4. Dead ends — do not re-litigate

| Idea | Why it was dropped |
| --- | --- |
| **"Your agent can't drain your account"** framing | False. Binance's sub-account has no withdrawal scope and confirms every trade. This was the original pitch and it does not survive contact with the docs |
| **A guard whose demo is "rogue order blocked"** | Redundant on the MCP path — the confirmation prompt already blocks it. Survives only on the CLI path, and even there it is table stakes |
| **ASSAY** — x402 escrow with a delivery assay | Blocked on B402 onboarding: even the sandbox base URL requires an application round-trip. Not survivable in four days. Genuinely good idea; revisit outside a deadline |
| **Building on Spot Testnet via the plain Binance API** | Would not be Agent OS — fails sponsor-technology alignment, the strongest pattern in the vault. Resolved by using `binance-cli`, which *is* Agent OS tooling and *does* support testnet |
| **Revoking the Binance API key's Trade permission programmatically** | Key management is a web-UI operation, not in the standard REST API. Revocation therefore means BONDED stops proxying. Do not claim otherwise |
| **Publishing a full public track record** | Leaks strategy — timing, sizes, symbols. Replaced by the public-aggregate / private-detail split |

---

## 5. Open questions

| # | Question | Blocks | Status |
| --- | --- | --- | --- |
| 1 | Does `GET /sapi/v1/account/apiRestrictions` exist on Spot Testnet? | Boot guard 2's strength | Open — likely no; degrade gracefully and log what was actually checked |
| 2 | What is `BINANCE_API_ENV=demo`? | Possibly a better demo surface | Open — undocumented |
| 3 | Do user data streams work on Spot Testnet? | The reconciler | **Resolved — yes** (§2) |
| 4 | `binance-cli` subprocess vs direct REST? | Implementation shape | Open — prefer CLI for alignment |
| 5 | What is already published on Binance Skills Hub's listing UI? | Competitive picture | **Unresolved** — `binance.com/en/skills` could not be loaded through this sandbox's proxy on three attempts. **Check manually** |

---

## 6. Lineage

BONDED is a remix from a vault of 26 captured hackathon winners
([Ritapossible/Wining-hackathon-skills](https://github.com/Ritapossible/Wining-hackathon-skills)).
Recorded so the design rationale is traceable and the echoes are known rather than accidental.

| Role | Source | Contribution |
| --- | --- | --- |
| **Spine** | PolyDesk (OKX AI Genesis, Finance Copilot) | Governing the agent *is* the product; bounded mandate + decision trace + public verification |
| Donor | LeoZap (Aleo APAC, 1st, Infra & Devtools) | Differential oracle — two independent computations, divergence is the finding. Also: answer the obvious objection as the demo |
| Donor | Astryum (Flare Summer Signal, 2nd) | Boot guards that machine-check the trust claim; state derived not remembered; fail closed |
| Donor | 看懂 · Understand (OKX, 7,900 sold — highest usage in the vault) | The four-part traceable output contract |
| Donor | AgentVault-Aleo (Aleo APAC, 1st, AI × Privacy) | The layered-enforcement table; sub-millisecond local pre-check naming the firing clause |

Secondary: PactPay + CLOAKCLUB (certificate privacy split, metadata leakage) · Remnara
(content addressing, from its reproducible-builds instinct) · PolyDesk (consent checklist) ·
Clawby (Skills Hub distribution) · Prex (mandate compiler) · LEAPSY (grounding in a real
instrument universe).

**Patterns being deliberately applied:** sponsor-technology alignment (remove Binance and there
is nothing to guard) · pitch a negative capability, not a feature · one sentence beats an
impressive system · precision as an architectural component, not a prompting hope · honest
disclosure of weakness buys credibility.

**The relevant anti-patterns:** building something portable in a sponsor-funded track · pitching
a positive capability where a negative one is available · spending the pitch on breadth instead
of one claim · shipping a summary with no source, no reference and no statement of uncertainty.

---

## 7. Working agreements

- **Day 3 (the reconciler) is the project.** If time slips, cut Day 4, never Day 3. The full
  cut list is `PLAN.md` §4.
- **Never claim a check that was not performed.** Boot-guard log lines say what was actually
  verified. This applies to the README and the video too.
- **The README's honest-limits section is not optional.** Naming a weakness before a judge
  finds it converts it into evidence of rigour.
- **Record the demo as soon as it works.** Do not leave filming to the final hours.
