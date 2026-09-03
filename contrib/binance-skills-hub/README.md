# Binance Skills Hub contribution

Everything needed to submit BONDED to
[`binance/binance-skills-hub`](https://github.com/binance/binance-skills-hub), prepared but
**not submitted**. Opening the PR is a deliberate step, not an automated one.

## Contents

| File | Purpose |
| --- | --- |
| `PULL_REQUEST.md` | The PR body, following the hub's `.github/pull_request_template.md` |
| `skills/bonded/README.md` | The per-skill README the hub's `CONTRIBUTING.md` asks for |

`SKILL.md` is not duplicated here — the canonical copy is at the repository root and is
copied into place by the command below, so the two can never drift.

## Submitting

```bash
# 1. Fork binance/binance-skills-hub on GitHub, then:
git clone https://github.com/<you>/binance-skills-hub && cd binance-skills-hub
git checkout -b add-bonded-skill

# 2. Copy the skill into place
mkdir -p skills/bonded
cp /path/to/Bonded/SKILL.md                                    skills/bonded/SKILL.md
cp /path/to/Bonded/contrib/binance-skills-hub/skills/bonded/README.md skills/bonded/README.md

# 3. Commit and push
git add skills/bonded
git commit -m "Add bonded skill: mandate gate and reconciliation for Spot trading"
git push -u origin add-bonded-skill

# 4. Open the PR against binance/binance-skills-hub:main
#    and paste PULL_REQUEST.md as the body.
```

## Two things to decide before submitting

Both are flagged in the PR body rather than guessed at silently.

**Frontmatter.** The hub documents three different conventions:

| Source | Says |
| --- | --- |
| `CONTRIBUTING.md` | top-level `name`, `description`, `version`, `license` |
| `README.md` | `title:` |
| Every skill in the tree | `name:` with `version` under `metadata:` |

`SKILL.md` follows `CONTRIBUTING.md` and adds `metadata.author` to match in-tree practice.
If a maintainer prefers one of the others, it is a one-line change.

**Namespace.** Existing skills live under `skills/binance/` and `skills/binance-web3/`,
both of which read as first-party. BONDED is not a Binance-operated service, so it is placed
at `skills/bonded/` — the structure `CONTRIBUTING.md` actually documents. Expect a
maintainer to have an opinion; moving it is trivial.

## Compliance with the hub's Trading Rules

The rules prohibit promoting any asset, presenting anything as safe or recommended, and
including wallet addresses. BONDED does none of these: it produces no trading
recommendations at all — refusing orders is the entire product — and contains no addresses.
