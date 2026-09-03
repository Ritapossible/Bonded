# BONDED — Architecture

---

## 1. Threat model

State this before anything else. Scope honesty is the credibility move; a security design that
does not name its own limits reads as unexamined.

### Defends against

| Threat | Defence |
| --- | --- |
| Agent places an out-of-mandate order — bad reasoning, bug, retry loop | Pre-trade gate denies in-process; the order never reaches Binance |
| Prompt injection via market data, news, or a token name | Same gate. The mandate is not in the model's context and cannot be argued with |
| Anything holding the key bypasses BONDED entirely | **Reconciliation** — an order on the exchange with no matching authorisation is a finding |
| Silent drift — the agent slowly widening its own behaviour | Conformance audit over the full order history, not just the last order |

### Does not defend against

- **Host compromise.** The bound rests on key custody. This is rung 3 of the enforcement
  ladder — *signed mandate plus public trace*. Rungs 4 and 5 (attested enclave, ZK circuit)
  need hardware or a ZK-native chain and are out of reach in four days.
- **Bad trades that are within the mandate.** BONDED audits compliance, not quality.
- **Prevention of a bypass.** A bypass order fills before BONDED sees it. Detection and
  attribution only.
- **Withdrawals** — see §4. Not BONDED's job, by design.

---

## 2. Three planes

Split by what must live where. Deciding what does *not* belong in the trusted core is the
design skill; putting everything in one process is the default mistake.

```
                      ┌──────────────────────────────────────┐
   agent (Claude Code,│           CONTROL PLANE              │
   Codex, OpenClaw)   │  mandate compiler · bond state ·     │
        │             │  scope issuance · owner console      │
        │ MCP         └──────────────┬───────────────────────┘
        ▼                            │ mandate (content-addressed)
┌───────────────────┐                ▼
│   DATA PLANE      │  ┌──────────────────────────┐
│ BONDED MCP server │──│  pre-trade gate          │──► Binance REST
│  (holds the key)  │  │  in-process, <1 ms,      │    (testnet)
└───────────────────┘  │  zero network            │
        ▲              └──────────────────────────┘
        │ decision records (append-only, hash-chained)
        ▼
┌──────────────────────────────────────────────────────────┐
│                     AUDIT PLANE                          │
│  user-data-stream listener · reconciler · conformance    │
│  replay · certificate issuer                             │
└──────────────────────────────────────────────────────────┘
```

The agent reaches only the **data plane**. It has no path to the control plane and cannot read
the mandate — it learns the rules only by being refused, one clause at a time.

---

## 3. Layered enforcement

Every rule sits at the layer where it belongs, with a reason for the placement. Read
top-to-bottom: the guarantee weakens and the coverage broadens. That shape is correct, and
saying so out loud beats pretending the protection is uniform.

| Rule | Enforced where | Why there |
| --- | --- | --- |
| No withdrawals, ever | **Binance API key permission** — "Enable Withdrawals" off, IP allowlist on | Outside BONDED entirely. A total BONDED compromise still cannot withdraw |
| Testnet only during judging | **Boot guard** — refuse to start unless `BINANCE_API_ENV=testnet` or `BONDED_ALLOW_PROD=1` | A misconfiguration must fail loudly at boot, not quietly at the first order |
| Symbol allowlist · max notional · leverage ceiling · order-type allowlist | **Pre-trade gate**, in-process | A violating order must never reach the exchange; the denial names the firing clause |
| Daily loss limit · max drawdown · max open exposure | **Pre-trade gate**, against **exchange-derived** state | Must be recomputed from Binance account state, never a local tally (§6) |
| Was every executed order actually authorised? | **Reconciler**, post-trade, against the exchange's own order history | A bypass is invisible to the gate by definition — only the exchange sees it |
| Did fills conform to the mandate at their timestamp? | **Conformance replay**, independent of the gate log | Catches a gate *bug*, which the gate cannot catch in itself |
| Bond balance · scope revocation | **Control plane**, on reconciler verdict | Off the hot path; a slow decision that must not add trading latency |

---

## 4. Why withdrawals are not BONDED's job

Binance API keys carry their own permission flags and an IP allowlist. Withdrawals are
disabled by default and must be explicitly enabled.

So BONDED does not implement a withdrawal guard — it **verifies one exists** at boot and
refuses to run otherwise. That is a stronger position than implementing it: the guarantee
survives BONDED being wrong about everything else.

> **Verify before relying on it.** `GET /sapi/v1/account/apiRestrictions` returns key
> permissions on mainnet and is very likely **absent on Spot Testnet**. If so, boot guard 2
> degrades to asserting `BINANCE_API_ENV=testnet`, and the log line must say that is what it
> checked. Never claim a check you did not perform.

---

## 5. The mandate

### Compilation

Plain English → a structured, deterministic rule spec. **The model translates; it never
decides.** The owner reads numbered clauses before anything runs. The failure mode is a bad
spec the owner can see, not a wrong decision they cannot.

```jsonc
{
  "version": 1,
  "env": "testnet",
  "symbols": ["BTCUSDT", "ETHUSDT"],   // allowlist, resolved against exchangeInfo
  "maxNotionalUsd": 500,
  "maxOpenPositions": 2,
  "maxLeverage": 1,                     // spot only
  "orderTypes": ["LIMIT", "MARKET"],
  "dailyLossLimitUsd": 50,
  "maxDrawdownPct": 5,
  "tradingWindowUtc": ["00:00", "23:59"],
  "expiresAt": "2026-09-08T23:59:00Z"
}
```

### Grounding

Every symbol resolves against live `GET /api/v3/exchangeInfo`, and the compiler inherits that
symbol's real `tickSize`, `stepSize` and `minNotional` as implicit clauses. The model selects
from a live universe; it never invents an instrument or a filter value. A mandate naming a
symbol that does not exist fails at compile time, not at the first order.

### Content addressing

Canonicalise the compiled spec (JCS, RFC 8785) and hash it. `mandateHash` appears in **every**
decision record and **every** certificate.

This is what stops the rules being quietly widened while the record is kept: a certificate
provably refers to one exact ruleset. Sign certificates with an Ed25519 key and the record
becomes third-party verifiable.

### Consent

Mandate creation walks an **ordered checklist and refuses to skip ahead** — each clause
confirmed individually, then a full summary, then a final confirmation. The stance to adopt
verbatim: *do not skip or confirm on my behalf.*

---

## 6. State is derived, never remembered

- Drawdown, realised PnL and open exposure are computed from `GET /api/v3/account`,
  `GET /api/v3/myTrades` and (if futures are added) `GET /fapi/v2/positionRisk` — **never**
  from a counter BONDED increments locally.
- A restart must reproduce identical gate decisions. **If restarting resets the daily loss
  limit, the limit is theatre.**
- Cache exchange state with an explicit TTL and a staleness flag.

**Fail closed.** If the state needed to evaluate a rule is stale or unavailable, **deny**.
An outage must never become an open mandate.

---

## 7. The gate

In-process, no network, target **under 1 ms**.

A fast, specific refusal lets an agent correct itself; a slow generic error makes it retry
blindly. The denial carries the exact clause that fired and the observed-versus-limit values.

Every decision — allowed and denied alike — is appended to a **hash-chained decision log**:

```jsonc
{
  "seq": 412,
  "prevHash": "…",
  "ts": "2026-09-06T14:22:09.118Z",
  "mandateHash": "…",
  "intent": { "symbol": "ETHUSDT", "side": "BUY", "type": "MARKET", "quoteQty": 900 },
  "decision": "DENY",
  "clause": "maxNotionalUsd",
  "clauseText": "Order notional must not exceed 500 USD.",
  "observed": 900,
  "limit": 500
}
```

Hash-chaining matters: BONDED must not be able to retro-edit its own log to hide a bad
decision. It is the cheapest available approximation of an attested record.

---

## 8. Reconciliation

**This is the novel contribution and the demo beat.**

The gate only sees orders that pass through it. Anything holding the API key can bypass BONDED
completely, and the gate is structurally blind to that. So a second, independent path is
required, and disagreement between the two is the finding — no ground truth needed beyond the
fact that both must agree.

- **Path A — what BONDED authorised.** The hash-chained decision log.
- **Path B — what actually happened.** Binance's **user data stream** delivers an
  `executionReport` for every order on the account, *including ones BONDED never saw*.
  Backstopped by periodic `GET /api/v3/allOrders` per allowlisted symbol and
  `GET /api/v3/openOrders`.

  Confirmed available on Spot Testnet: events push in real time, order updates arrive as
  `executionReport`, and subscription is via the **WebSocket API** (`userDataStream.subscribe`,
  authenticated with an API key) — **not** the legacy REST `listenKey` flow.
  `userDataStream.unsubscribe` closes it. JSON and SBE both supported; use JSON.

### Matching

BONDED stamps every order it authorises with a namespaced, unguessable client order id:

```
bnd_<mandateHash8>_<seq>_<hmac>
```

| Case | Meaning | Action |
| --- | --- | --- |
| In log, on exchange, ids match | Normal | — |
| In log, never on exchange | Rejected upstream or dropped | Reconcile against the exchange's rejection reason |
| **On exchange, not in log** | **BYPASS** — an order BONDED never authorised | Burn the bond, revoke scope, raise a finding |
| Id present, HMAC invalid | Forged id — someone imitated BONDED's namespace | Same as bypass, flagged more severely |

Detection is **near-real-time**, because the stream pushes. That is what makes the demo work
in 30 seconds instead of on a cron.

This answers, as the demo, the objection every judge will raise: *"what stops me just using
the key directly?"*

### Conformance replay — second oracle, ship only if time allows

Independently recompute, from historical klines at each fill's timestamp, whether that fill was
within the mandate — **without** consulting the gate log. A divergence between "the gate said
allow" and "the replay says this violated clause X" is a **gate bug**, which the gate cannot
find in itself.

Be precise about the limit: this verifies *conformance*, not *strategy attribution*. Claiming
it proves the agent followed a strategy is the overclaim that would sink the submission.

---

## 9. The certificate

### Output contract

Every finding carries four things, not one:

1. **Plain explanation** — "an order executed that BONDED never authorised."
2. **Verbatim source** — the raw `executionReport` payload *and* the exact mandate clause text.
3. **External reference** — the Binance `orderId`, checkable by anyone with account access,
   independently of BONDED.
4. **Explicit uncertainty** — what could not be determined: fills straddling a kline boundary,
   ambiguous partial-fill ordering, clock skew beyond `recvWindow`.

Most tools ship only (1). The other three are what make a finding safe to act on, and naming
the gaps beats smoothing over them.

### Privacy split

A track record that leaks your strategy is a track record nobody will publish. So:

| | Contents | Visible to |
| --- | --- | --- |
| **Public** | `mandateHash`, order count, violation count, bond state, period, signature | anyone — provably verifiable |
| **Private** | full decision log, order detail, symbols, sizes, timings | the owner only |

Prove the aggregate, disclose nothing about the shape. Ask what an observer learns from the
envelope, not just the contents — a record that hides amounts but publishes exact counts and
timings has leaked the strategy anyway. If counts alone leak too much, bucket them (`<10`,
`10–99`, `100+`) and say why in the README.

---

## 10. Boot guards

Refuse to start if any of these fail. Machine-check your own claim rather than asserting it —
"the bound is real" should be greppable, not marketing.

1. `BINANCE_API_ENV != "testnet"` and `BONDED_ALLOW_PROD` unset
2. The key reports withdrawal permission enabled (mainnet only — see §4)
3. No mandate loaded, or the loaded mandate has expired
4. The decision log's hash chain does not verify from genesis
5. The user data stream cannot be established — **no audit path, no trading**

Print each check and its result as a startup banner. A reviewer should read the boot log and
know exactly which guarantees are live. Guard 5 is the important one: it makes the audit plane
a hard dependency rather than a nice-to-have.

**Mid-session stream loss** needs a defined behaviour, not silence: halt trading on
disconnect, resubscribe, reconcile the gap against `allOrders`, then resume.

---

## 11. Testing

**Differential property tests.** Generate random order intents with `fast-check`. Assert the
production gate's verdict matches an independent, deliberately naive reference implementation
of the same mandate. Where they disagree, one is wrong — no oracle needed, only that two paths
must agree.

**Reconciler tests.** Synthesise an `executionReport` with no matching log entry; assert BYPASS
fires. Synthesise a forged `clientOrderId`; assert the HMAC check catches it.

**Fixture-replay tests.** Recorded testnet sessions replayed end to end, asserting identical
decisions. This is what proves §6's "restart reproduces state" claim.

Aim for a test count worth putting in the README — evidence over assertion.

---

## 12. Surface

| Artifact | Purpose |
| --- | --- |
| **MCP server** | Agent-facing. Framework-agnostic: Claude Code, Codex, Cursor, OpenClaw. Tools: `place_order`, `cancel_order`, `get_account`, `get_mandate_summary` — the last returns clause *names* only, never values, so the agent cannot read its own limits |
| **Owner console** | One screen: mandate clauses, bond state, live decision feed, certificate. One screen, not eight — breadth is not a claim |
| **`SKILL.md`** | Packaged for Binance Skills Hub, plus a PR to `binance/binance-skills-hub` |
| **README** | Threat model, enforcement table, boot-guard banner, honest limits |

---

## 13. Prior art

Both projects named *AgentVault* (Flare and Aleo, both first-place winners) bound an agent's
**spend** on payments. BONDED bounds **trading semantics** — notional, leverage, symbol set,
drawdown — which spend caps structurally cannot express: a 1 USDT margin position at 125× is a
trivial spend and a catastrophic risk.

Two moves appear to be genuinely new:

- **Reconciling an authorisation log against the exchange's own record**, making bypass
  detectable rather than merely discouraged.
- **A bond that can be burned mid-session** by evidence the guard itself could not have seen.

Name the AgentVault comparison in the README. Both won firsts — the echo is a credential, not
a liability.
