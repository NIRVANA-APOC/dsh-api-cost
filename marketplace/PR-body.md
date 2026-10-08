This PR adds one entry, `data/plugins/NIRVANA-APOC__dsh-api-cost.yml`, for
[dsh-api-cost](https://github.com/NIRVANA-APOC/dsh-api-cost) 2.0.

- `category: usage`
- `dsh.bundle` is declared in the repository root `package.json`, pointing at
  `./cordis.patch.yml`, so the plugin installs via `dsh plugin add`.
- The repository has the `dsh-plugin` topic and is public and actively maintained.

## Why this is not a duplicate of the cost entries already listed

There are several cost/usage plugins on the list, so here is what this one does
differently, stated so it can be checked against the code.

dsh-api-cost 2.0 does **not** aggregate session logs. It registers one pure
session projection, `apiCost` (`src/host/projection.ts`), and the Harness owns
the event drive, the per-session watermark and the durable checkpoint. There is
no plugin-side log replay, no ledger, no recount button and no own polling loop —
a figure cannot drift from a recount because it is the fold itself. The 2.0
release was a deliberate breaking rewrite that deleted the 1.x replay design.

It also attributes spend that belongs to a session because of delegation rather
than presence:

- `self` — the session only
- `tree` — the session plus every durable subagent descendant (400-session budget,
  reported as `scope-truncated` when exceeded)
- `team` — the whole roster, but only when membership is verified, otherwise
  refused with `TEAM_UNAVAILABLE`
- `auto` — the verified team when the caller is a member, otherwise its tree

A forked child's own figure excludes the inherited prefix, so an ancestor is not
billed twice when you look at a branch.

## Claims in the description, and where they are verifiable

| Claim | Source |
| --- | --- |
| `apiCost` session projection | `src/shared/contracts.ts:2`, registered `src/host/index.ts:49` |
| peak / off-peak published rates | `src/pricing/index.ts:83-106` (CNY and USD as separate published columns, never converted) |
| reported token usage, not a bill | `src/host/projection.ts:97-147`; the tool description says "Not a provider bill" (`src/host/index.ts:76`) |
| self / tree / team scopes | `src/host/query.ts:137-190` |
| CNY and USD | `src/pricing/index.ts:425`; `src/shared/contracts.ts:11` |
| composer-dock pill and detail panel | `src/client/index.ts:43-46`; `src/client/widgets.tsx:159,212` |
| `/cost` command | `src/host/index.ts:92` |
| `session_cost` tool | `src/host/index.ts:75` |
| two GET routes | `src/host/http.ts:39` (`/dsh-api-cost/v2/view`), `:50` (`/dsh-api-cost/v2/pricing`) |

The repository does not ship a `tarball:` field: the prebuilt `dist/` is tracked,
so it installs from source with no build step. If a storefront download is
preferred, a release tarball can be attached and the field added.

## What the entry deliberately does not claim

To keep the description checkable, it avoids claims the code does not support:
it is an estimate and never a provider bill; it prices the two official models
in the rate card and marks anything else `unknown-model` with zero money; it
makes no network calls, so it reads no account balance or quota; it has no
budgets, alerts, charts or history dashboard; the panel shows no token buckets
or per-model rows (those stay on `/cost`, `session_cost` and `detail=full`); and
cross-session scopes re-read on a short timer, so it is not described as
poll-free.

117 tests pass locally (`node --test test/*.test.ts`).
