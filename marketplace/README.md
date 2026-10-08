# Submitting `dsh-api-cost` to the plugin market

Target list: [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
Guide read: [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)

## What a submission is

Exactly **one file**, added to the list — never the generated READMEs:

```
data/plugins/NIRVANA-APOC__dsh-api-cost.yml
```

The filename is enforced, not conventional. `slugFor(url)` in
`scripts/lib/entries.mjs` turns the entry `url` into `<owner>__<repo>`, and the
validator fails with `filename must match the url — expected <slug>.yml`.

The staged copy lives at [`NIRVANA-APOC__dsh-api-cost.yml`](./NIRVANA-APOC__dsh-api-cost.yml).
Run [`validate-entry.mjs`](./validate-entry.mjs) to check it against a local
replica of the upstream validator before pushing.

## Allowed fields

`ENTRY_KEYS = {url, name, category, description, tarball, file}` — but `file` is
injected by the loader, so an author may write only these five:

| Field | Required | Rule |
| --- | --- | --- |
| `url` | yes | `https://github.com/<owner>/<repo>`; must match the filename slug |
| `name` | yes | link text; the part before `#` must name the same repo as `url` |
| `category` | yes | one of 23 ids; **`usage`** is correct here |
| `description.en` | yes | single line, non-empty |
| `description.zh` | no | single line; a maintainer fills it in if omitted |
| `tarball` | no | `https` `.tgz` on GitHub release hosting only |

**Any other key is rejected by name.** In particular a hand-written `npm:` is
refused — the npm mapping is resolved automatically from the repository.

A description containing `": "` **must be quoted**, or YAML reads it as a nested
key. Both descriptions here are single-quoted for that reason.

## The three automated gates

| Check | Workflow | What it verifies |
| --- | --- | --- |
| `check` | `pr-check.yml` | path depth, `.yml` extension, README consistency, `awesome-lint`, site build |
| `Submission gate` | `pr-gate.yml` | `dsh.bundle` in `package.json`, repo ≥ **1 day old**, not archived, ≤ 3 entries per PR |
| `Repository config guard` | `pr-guard.yml` | hourly cron; flags PRs touching `.github/` |

A green run is the *precondition*, not the decision — a maintainer then reads the
repository and checks every claim in the description against the code.

## Verified status of this repository

| Requirement | Status |
| --- | --- |
| `dsh.bundle` manifest | present — `{"bundle":{"patch":"./cordis.patch.yml"}}` |
| `cordis.patch.yml` at root | present |
| Repo is public and not archived | yes |
| `dsh-plugin` GitHub topic | set (plus `dsh`, `dsh-plugin-market`, …) |
| Real, working code | 117 tests pass locally; prebuilt `dist/` tracked |
| Repo at least 1 day old | created `2026-10-07T14:28:56Z`; **eligible from `2026-10-08T14:28:56Z`** |
| ≤ 3 entries per PR | 1 entry |
| Statistically accurate description | every clause verified against `src/` |

## Overlap warning

The `usage` category already holds several cost/usage plugins, including
`0x7A7A6572/dsh-forge-studio#plugin-usage-billing`, `940842546/dsh-usage-billing`,
`Han-1413141/dsh-cost-meter` and `nonewind/dsh-spend`.

Review rule 4 makes this a *tiebreaker, not a rejection*: "the rule is not
first-come; the rule is whichever is better." The differentiator claimed in the
entry is the mechanism — `dsh-api-cost` registers a pure `apiCost` **session
projection** owned by the host (event drive, watermark, durable checkpoint), so
it never replays or tails session logs, and it attributes delegation-tree and
verified-team spend without double-billing fork-inherited prefixes. That is a
verifiable structural difference from the log-aggregating incumbents, so the
entry leads with it rather than with "shows cost".

## Pre-flight

```sh
# from this repository root
node marketplace/validate-entry.mjs marketplace/NIRVANA-APOC__dsh-api-cost.yml
```

Expected: `RESULT: entry passes every replicated validation rule.`

Then confirm the age gate before opening the PR — `pr-gate.yml` reads the repo's
creation date, and a PR opened minutes early is rejected on age alone:

```sh
node -e "const c=new Date('2026-10-07T14:28:56Z');const h=(Date.now()-c)/36e5;console.log(h.toFixed(2),'hours old — eligible:',h>=24)"
```

## Opening the PR

The existing fork branch `add-dsh-api-cost` is stale (3 commits, 46 behind
upstream `main`) and its entry describes the **removed 1.x log-replay design**,
so it must not be reused as-is. The entry must be re-created on top of current
upstream `main`, because `pr-check.yml` runs a stale-fork guard.

`git push` does not work from a sandboxed DSH shell — git's TLS stack fails with
`schannel: SEC_E_NO_CREDENTIALS`, and Node cannot pipe `gh`'s stdout (EPERM).
Use the GitHub API directly, which authenticates through `gh`'s keyring:

```sh
# 1. stage the entry on a new branch cut from the fork's main
gh api repos/NIRVANA-APOC/awesome-dsh-plugin/contents/data/plugins/NIRVANA-APOC__dsh-api-cost.yml \
  --method PUT \
  --input <payload.json>        # {message, branch, content:<base64>, sha?}

# 2. open the PR against upstream
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --head NIRVANA-APOC:add-dsh-api-cost-v2 \
  --title "Add NIRVANA-APOC/dsh-api-cost (usage)" \
  --body-file marketplace/PR-body.md
```

[`push-via-api.mjs`](./push-via-api.mjs) builds the payload for a Contents-API
PUT, and [`flip-commit.mjs`](./flip-commit.mjs) folds a run of API-created
commits into one by rewriting the branch ref to a new commit with the same tree —
useful because the Contents API can only commit one file at a time.

Only one file is touched in the list repository:
`data/plugins/NIRVANA-APOC__dsh-api-cost.yml`.
