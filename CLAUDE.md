# BONDED

Read these before doing anything, in order:

1. `MEMORY.md` — verified research, decisions and their reasoning, dead ends, open questions.
   Says *why*. Read it first so you do not re-litigate settled decisions or re-verify facts.
2. `PLAN.md` — scope, milestones, cut list, demo script, submission checklist.
3. `ARCHITECTURE.md` — threat model, enforcement layers, data flows, invariants.

## Hard rules

- **Testnet only.** `BINANCE_API_ENV=testnet`. Never commit or echo API keys, and never run
  `env`/`printenv` unanchored.
- **Never claim a check that was not performed.** This applies to boot-guard log lines, the
  README, and the demo video equally.
- **Day 3 (the reconciler) is the project.** Cut from Day 4 first. Full cut list in `PLAN.md` §4.
- Deadline is **2026-09-08 23:59 UTC**. There is no published rubric — the demo video is the
  rubric.

## Keeping memory current

When something is verified, decided, or ruled out, update `MEMORY.md` in the same change —
§2 for verified facts (with the source), §3 for decisions, §4 for dead ends, §5 for open
questions. A decision that is not written down gets re-argued.
