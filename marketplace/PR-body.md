This PR adds one entry, `data/plugins/NIRVANA-APOC__dsh-api-cost.yml`, for
[dsh-api-cost](https://github.com/NIRVANA-APOC/dsh-api-cost) 2.3.

- `category: usage`
- `dsh.bundle` is declared in the repository root `package.json`, pointing at
  `./cordis.patch.yml`, so the plugin installs via `dsh plugin add`.
- The repository has the `dsh-plugin` topic and is public and actively maintained.

## What it does

dsh-api-cost estimates DeepSeek spend from reported token usage at the published
peak / off-peak rates, in CNY and USD, and exposes it as a composer pill with a
detail panel, a `/cost` command, a `session_cost` tool, and HTTP routes.

It does **not** aggregate session logs. It registers one pure session projection,
`apiCost` (`src/host/projection.ts`), and the Harness owns the event drive, the
per-session watermark and the durable checkpoint. There is no plugin-side log
replay, no ledger, no recount button and no own polling loop — a figure cannot
drift from a recount because it is the fold itself. The 2.0 release was a
deliberate breaking rewrite that deleted the 1.x replay design.

It attributes spend that belongs to a session because of delegation rather than
presence:

- `self` — the session only
- `tree` — the session plus every durable subagent descendant (400-session budget,
  reported as `scope-truncated` when exceeded)
- `team` — the whole roster, but only when membership is verified, otherwise
  refused with `TEAM_UNAVAILABLE`
- `auto` — the verified team when the caller is a member, otherwise its tree

A forked child's own figure excludes the inherited prefix, so an ancestor is not
billed twice when you look at a branch.

## The part that is not just a cost readout: the per-tree off-peak request gate

2.1 added a switch in the panel — **Avoid peak** / 「避开高峰」 — that makes model
calls happen inside an off-peak (谷时) billing window instead of at the peak
rate, which is double. **2.3 makes that switch govern a conversation tree**: one
switch covers the session and the sessions it delegates to (subagents, and their
descendants), while a genuinely unrelated conversation is never parked because
another one is waiting. The nearest manual choice wins — a session's own switch
first, otherwise the nearest switched ancestor, otherwise the configured default
— so a child session can override its parent for its own subtree, and an
`Inherited` badge on its panel says which situation it is in. Parked counts are
aggregated over the tree (with the child-session share called out separately),
and requests waiting in unrelated conversations are reported as such. This is a
different kind of feature from "show me what I spent", so it is worth stating
precisely.

While a session's effective switch is on and the tier is peak, the model
requests issued by that session and its descendants are **parked, not failed**.
They are held at the `llm/stream` waterfall (`src/host/gate.ts`, registered with
`prepend: true`) and dispatched unchanged the moment the window closes. The model
observes nothing: no session event, no error, no retry, no injected chunk — from
the loop's point of view the call was simply slow. The request body is
byte-identical to the un-gated one. The session identity is the loop-stamped
`GenerateOptions.sessionId`; a model call without one is never gated, and the
parent link comes from the session header (`session/created`) rather than from
guessing about a call.

2.2 rebuilt the panel around what the two tariffs actually are, and 2.3 updates
its copy for the tree scope. The screenshots in the README show the result: a
money hero in the app's brand face, one tariff band split proportionally by peak
and off-peak spend (amber = peak, blue = off-peak, with the words 峰/谷 and both
amounts written out), the tier and the countdown to the next window in the
header, and a dedicated avoid-peak block that names its scope (this session and
its child sessions) and, while holding, shows how many requests in the tree are
parked, how many of those come from child sessions, how long the hold has lasted,
when it releases, and how many requests are parked in unrelated conversations.
The panel keeps its old information budget (no token buckets, no per-model rows)
at a smaller height, and both locales have first-class copy.

Design points that a reviewer can check in the code:

- **Fail-open is the invariant** (`src/host/gate.ts`): an unreadable clock, an
  unreadable tier, or a timer that will not arm all release the request
  immediately. `wait()` resolves and never rejects; `middleware` is synchronous
  and returns the identical `next()` object whenever it does not hold. The worst
  case of this feature is "you paid peak prices", never "your session stopped".
- **A hold is cancellable at any instant** — turning the switch off, aborting the
  run, or unloading the plugin releases parked requests at once. The iterable
  implements `return()` explicitly so an abandoned stream is noticed immediately
  rather than at the boundary.
- **Each switch is the user's, so it is not config-only**: the panel writes it
  through the plugin's own route and the host keeps a per-session map of manual
  choices in `<dsh home>/state/dsh-api-cost/gate.json`, written atomically
  (version 2, at most 512 stored sessions). Inheritance is not persisted: parent
  links are reconstructed from the live session tree, so the file never guesses a
  session's lineage. A session that was never switched keeps inheriting the
  configured default and reports that it is still the default; the panel never
  shows a state the host did not confirm.
- **The one mutating surface is guarded before the body is read**: `POST
  /dsh-api-cost/v2/gate` requires `application/json`, rejects `sec-fetch-site`
  outside `same-origin`/`none`, rejects a mismatching `Origin`, and accepts only
  `{"session":"<id>","enabled":boolean}` within 4096 bytes. The read route takes
  exactly one `?session=<id>`; each session's view carries its own ETag. The two
  cost routes stay GET-only.

Verification is documented rather than asserted: `docs/off-peak-gate.md` is the
frozen interface (v2.1.0 process-global contract kept in Appendix A as history),
`docs/verification-gate.md` is the claim → test → verdict table (A1–A24 hold and
subtree semantics, B1–B5 the `/gate` wire, C1–C9 a real cordis `Context` plus a
real `@deepseek-ai/dsh-llm` waterfall, including two concurrent sessions where
only the gated tree parks), and the tests are `test/gate.test.ts`,
`test/gate-integration.test.ts` plus independent adversarial suites written from
the contract rather than the code (`test/gate-sessions.test.ts` for the v2.2
session scope, `test/gate-tree.test.ts` for the v2.3 tree scope).

## Claims in the description, and where they are verifiable

| Claim | Source |
| --- | --- |
| `apiCost` session projection | `src/shared/contracts.ts:2`, registered `src/host/index.ts` |
| peak / off-peak published rates | `src/pricing/index.ts` (CNY and USD as separate published columns, never converted) |
| reported token usage, not a bill | `src/host/projection.ts`; the tool description says "Not a provider bill" |
| self / tree / team scopes | `src/host/query.ts` |
| CNY and USD | `src/pricing/index.ts`; `src/shared/contracts.ts` |
| composer-dock pill and detail panel | `src/client/index.ts`; `src/client/widgets.tsx` |
| `/cost` command and `session_cost` tool | `src/host/index.ts` |
| GET view / pricing routes | `src/host/http.ts` |
| per-tree off-peak hold on `llm/stream` | `src/host/gate.ts` (parent links via `session/created`) |
| `GET /dsh-api-cost/v2/gate?session=` and `POST` with `{session,enabled}` | `src/host/http.ts` |
| manual choices survive a restart; inheritance rebuilt from the live tree | `src/host/gate.ts` (durable v2 map + parent links) |
| redesigned tariff-ledger panel and pill | `src/client/widgets.tsx`, `src/client/styles.ts` |

The repository does not ship a `tarball:` field: the prebuilt `dist/` is tracked,
so it installs from source with no build step. If a storefront download is
preferred, a release tarball can be attached and the field added.

## What the entry deliberately does not claim

The bundled artifacts are **13.7 KiB** (client) and **15.0 KiB** (host) gzip; the
entry does not claim the plugin is small or that the gate saves money without
qualification. Specifically the code does not do, and the docs do not claim:

- it is an estimate and never a provider bill; it prices the two official models
  in the rate card and marks anything else `unknown-model` with zero money;
- it makes no network call to DeepSeek, so it reads no account balance or quota;
- it has no budgets, alerts, charts or history dashboard;
- the panel shows no token buckets or per-model rows (those stay on `/cost`,
  `session_cost` and `detail=full`);
- cross-session scopes re-read on a short timer, so it is not described as
  poll-free;
- the gate holds calls, it does not split them: a call already in flight when
  peak begins is unaffected, and a call that starts off-peak but settles in peak
  is still billed at peak;
- a hold can last up to a four-hour weekday window; switches govern a conversation
  tree while the holds are per process, and the durable state is a versioned file
  rather than a database;
- inheritance is reconstructed at runtime: parent links are read from live
  sessions, so a session whose lineage cannot be resolved is treated as a root
  and follows its own choice or the configured default (the panel makes this
  visible as a default/self state rather than inventing a parent).

215 tests pass locally (`node --test test/*.test.ts`), the TypeScript
typecheck is clean, and the size/state/timing budgets hold.
