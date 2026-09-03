# BONDED — Build Plan

Target: **Binance Agent OS Mini Hackathon**, Track A (Agent Workflows → Trading Workflows).
Prize pool 20,000 USDC. Deadline **2026-09-08 23:59 UTC**.

Solo build. Zero trading capital. Everything runs on Spot Testnet.

---

## 1. Definition of done

The submission is complete when all five exist:

- [ ] A public GitHub repo that a judge can read in five minutes and believe
- [ ] A ≤2-minute video whose first 30 seconds land the demo beat (§6)
- [ ] A working testnet demo, reproducible from the README by someone else
- [ ] The X post: follow @Binance, repost, then reply/quote-repost with video + repo link
- [ ] The survey completed — `app.binance.com/uni-qr/user-su…`

**There is no published judging rubric.** The X post is the rules; no Devpost, no DoraHacks,
no scoring criteria. That means **the video is the rubric.** Budget accordingly: a working
system nobody watches scores nothing.

---

## 2. Scope

### In

- MCP server that holds Binance testnet credentials and exposes gated trading tools
- Mandate compiler: plain English → deterministic rule spec, grounded against `exchangeInfo`
- Pre-trade gate: in-process, sub-millisecond, names the firing clause on denial
- Append-only hash-chained decision log
- User-data-stream listener + reconciler → bypass detection → bond burn → scope revocation
- One-screen owner console
- `SKILL.md` packaged for Binance Skills Hub

### Out (for the hackathon)

- Futures, margin, convert — spot only
- Multi-user, auth, hosting, persistence beyond a local file
- Strategy generation of any kind — BONDED does not decide what to trade
- Mainnet

### Non-goals, stated deliberately

BONDED is not a trading bot and not a strategy. If the demo makes anyone ask "but is it
profitable?", the framing has failed.

---

## 3. Milestones

| Day | Deliverable | Done when |
| --- | --- | --- |
| **1** | Testnet keys. MCP server skeleton holding credentials. Pre-trade gate with 3 clauses. Hash-chained decision log. | An agent places an allowed order and is refused a disallowed one, both logged |
| **2** | Mandate compiler + `exchangeInfo` grounding + `mandateHash` + consent checklist. Boot guards with startup banner. | `bonded start` prints five guard results and refuses on a bad config |
| **3** | **User data stream listener + reconciler.** `clientOrderId` namespacing and HMAC. Bypass detection → bond burn → scope revocation. | An order placed outside BONDED is flagged within seconds |
| **4** | Console (one screen). Certificate. Property tests. `SKILL.md` + PR. README. **Record and post the video.** | Submitted |

**Day 3 is the project.** The reconciler is the entire differentiator — the gate alone is
table stakes and several other entrants will have one. If Day 1 or 2 slips, cut from Day 4.
Never cut from Day 3.

---

## 4. Cut list

Strictly in this order, when time runs short:

1. **Conformance replay** — the reconciler alone carries the demo
2. **Bond accrual curve** → binary `CLEAR` / `BURNED`
3. **Ed25519 certificate signing** → publish the hash only
4. **Public/private certificate split** → private only; describe the split in the README
5. **Futures support** → spot only
6. **Skills Hub PR** → open it after the deadline

Anything not on this list is not optional. If you are considering cutting the reconciler, cut
the project instead and build ROUNDTRIP.

---

## 5. Day-one order of work

Resolve these before writing feature code:

1. Generate Spot Testnet API keys at https://testnet.binance.vision/
2. Confirm a user data stream can be opened on testnet and that `executionReport` arrives for
   a manually placed order. **Everything downstream assumes this.** (Docs say yes — verify it
   with your own key before trusting it.)
3. Decide: `binance-cli` subprocess vs direct REST. Prefer the CLI — it is the Agent-OS-native
   story and P1 rewards using the sponsor's own tooling. Fall back to REST only if the CLI
   cannot express something the gate needs.
4. Check whether `GET /sapi/v1/account/apiRestrictions` exists on testnet. If not, boot guard 2
   degrades to asserting `BINANCE_API_ENV=testnet` and must say so in its log line.

---

## 6. The 30 seconds

Split screen. Left: agent in Claude Code. Right: BONDED console — mandate clauses, bond state,
live decision feed.

| Time | Beat |
| --- | --- |
| 0–6s | **Setup.** "Buy 900 USD of ETH." Refused instantly; console names the clause: `maxNotionalUsd — observed 900, limit 500` |
| 6–12s | **The objection, said out loud.** *"Fine, I'll just use the API key directly."* |
| 12–25s | **The beat.** A raw `binance-cli` order straight to testnet, bypassing BONDED. It fills. Then the console lights: **UNAUTHORISED ORDER — orderId 28461173**, bond `CLEARED → BURNED`, scope revoked. The agent's next order is refused with `scope revoked` |
| 25–30s | **The line.** *"You can go around it. You can't go around it unnoticed."* |

Rules for the cut:

- **One beat.** The bypass detection is the beat. The blocked order is setup, not a second climax.
- **It must read on mute.** Colour change plus a large clause name; assume no audio.
- **Show "TESTNET" on screen throughout** and say it in the first caption. Disclosed, not hidden.
- Real timestamps and a real `orderId` visible — a judge should be able to tell nothing is faked.

---

## 7. README requirements

The repo is read by judges under time pressure. In order, above the fold:

1. The one-sentence claim
2. The two-path table — which path Binance guards, which it does not
3. The layered-enforcement table from `ARCHITECTURE.md` §3
4. The boot-guard banner, pasted verbatim from a real run
5. **Honest limits** — rung 3 not rung 5, detection not prevention, testnet liquidity
6. Reproduce-it-yourself instructions that actually work from a clean clone

Naming the weaknesses before a judge finds them converts a vulnerability into evidence of
rigour. Do not skip §5 to look stronger; it has the opposite effect.

---

## 8. Distribution

Ship a `SKILL.md` and open a PR to
[`binance/binance-skills-hub`](https://github.com/binance/binance-skills-hub) — fork, add a
folder with `SKILL.md` (YAML frontmatter: `title`, `description`, `metadata.version`,
`metadata.author`, `license`), PR to `main`.

A PR into Binance's own repo during judging week is a credibility signal essentially no other
entrant will bother with, and it costs an hour. Open it even if it does not merge in time.

---

## 9. Risks

| Risk | Mitigation |
| --- | --- |
| User data stream unavailable or unreliable on testnet | Verify Day 1 item 2 first. Fallback: poll `allOrders` per symbol — demo beat degrades from instant to ~5s |
| Reconciler not working by end of Day 3 | Cut Day 4 scope to console + video only; ship the reconciler even if untested by property tests |
| Testnet outage during recording | Record the demo as soon as it works — do not leave filming to the final hours |
| Time lost to the console | One screen. Astryum shipped eight dashboard surfaces and placed 2nd |
| Scope creep into strategy logic | Re-read §2 non-goals |

---

## 10. Deliberate non-decisions

Things not worth deciding now, recorded so they do not get re-litigated:

- Language/runtime — whatever ships fastest; TypeScript is the default given the MCP SDK
- Storage — a JSONL file is sufficient; no database
- Hosting — runs locally for the demo; no deployment needed
- Auth — single-user, local; no accounts
