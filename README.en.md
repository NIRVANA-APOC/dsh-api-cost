<h1 align="center">dsh-api-cost</h1>

<p align="center">DeepSeek cost estimation for DeepSeek Harness: peak / off-peak rates, delegation or team spend attributed to the session that caused it, folded by the host's session projections.</p>

<p align="center">
  <a href="https://github.com/NIRVANA-APOC/dsh-api-cost/actions/workflows/test.yml"><img src="https://github.com/NIRVANA-APOC/dsh-api-cost/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT">
  <img src="https://img.shields.io/badge/DSH-plugin-4c8bf5" alt="DSH plugin">
</p>

<p align="center"><b>English</b> · <a href="README.md">中文</a></p>

---

`dsh-api-cost` 2.x is a **TypeScript, projection-first** design. Instead of metering streams, replaying logs and polling on a timer, the plugin registers one pure session projection; the Harness owns the event drive, the per-session watermark, the durable checkpoint and the delivery to the browser. The client half reads the host's own projection through the framework `useProjection` seat.

What that buys you:

- **Correct history without a recount button** — the first read of a session, a resumed conversation, or a restart all fold from the durable log through the host's checkpoint cache, so a figure never starts at ¥0 and never double counts.
- **Real settlement semantics** — one billed event per `assistant/message` (or `assistant/attempt` fallback), priced at the *event's* own settlement time, with fork-inherited prefixes excluded from a child's own spend.
- **Honest delegation and team totals** — `self`, `tree` and `team` scopes resolved from durable subagent catalogs and the team roster, with `own` always meaning *this session* and `others = total − own`.
- **An optional Avoid-peak switch, per conversation tree** — each session's panel owns a toggle; while it is on and the tier is peak, the model requests issued by *that session and the sessions it delegates to* are parked until the cheap window opens, so the calls are billed off-peak and the model never sees a failure. It governs one conversation tree only: an unrelated conversation is never parked because this one is waiting.
- **Lightweight by construction** — no replay framework, no database, no own polling loop. Built artifacts: client ≈ **13.7 KiB gzip**, host ≈ **15.0 KiB gzip**.

**Contents:** [Requirements](#requirements) · [Install](#install) · [Usage](#usage) · [Avoiding peak hours](#avoiding-peak-hours) · [HTTP](#http) · [Rates](#rates) · [Configuration](#configuration) · [What it does not promise](#what-it-does-not-promise) · [Development](#development) · [Migrating from 1.x](#migrating-from-1x) · [License](#license)

## Requirements

- DeepSeek Harness **0.2.0-rc.2** with the `sessionProjections`, `sessionProjectionCache` and `sessionQuery` capabilities mounted (the shipped `web` and `desktop` profiles have them).
- Node.js **24** or newer for development only; the published package ships prebuilt JavaScript.

The plugin declares those services in `inject`, so in a composition without them it stays inactive rather than half-working. The per-tree Avoid-peak switch additionally uses the `llm` service's `llm/stream` waterfall; a composition without `llm` simply has nothing to hold, and every other surface keeps working.

## Install

```sh
dsh plugin --profile web add dsh-api-cost                # from npm
dsh plugin --profile web add /absolute/path/to/checkout  # from a checkout or a git URL
```

The package ships `dist/index.js` (ESM host) and `dist/client.js` (the lazy browser factory), so **installation never runs a compiler**. A local source checkout must be built once with `pnpm build` before it is installed that way.

Host-side features (the projection, `/cost`, `session_cost`, the HTTP reads) take effect immediately. The composer pill appears once the client bundle is composed at startup, so restart DSH once.

## Usage

### The pill

Beside the shipped session-stats pills, the cost pill stays quiet at rest: this session's estimate, a hairline divider, and the tier word (**峰** / **谷**, never colour alone) in that tariff's colour. It reads the host projection for this-session money, so it repaints when a settlement lands — not on a timer. A partial-coverage marker appears whenever any contributing session is unpriced, truncated or unreadable, and while requests are parked the pill adds the words `等待谷时` together with how many of them are waiting (`×2`).

| Off-peak | Peak |
| --- | --- |
| ![The pill in the off-peak tier: this session's cost in CNY, then a hairline divider and the tier written as the word 谷 in the off-peak blue](assets/pill-off-peak.png) | ![The same figure during peak hours: the same quiet capsule, with the tier written as the word 峰 in the peak amber](assets/pill-peak.png) |

### The panel

Clicking the pill (or pressing Enter on it) opens a trigger-anchored dialog rebuilt around the two tariffs rather than around a row list:

- the header carries the tier in force and the countdown to the next window, because *when* it is cheap matters as much as *what* was spent;
- the session's estimated spend is the hero, set in the app's brand face with the USD column beside it and the scope's counts under it;
- one **tariff band** splits that spend between peak and off-peak — amber against blue, each end labelled with its own amount and with the words 峰 / 谷 — so the money's cost profile is visible before any number is read;
- then this-session / other-session shares, the coverage state including every caveat in words, and the rates in force with their unit line;
- an **Avoid-peak block covering this session and its delegated child sessions**: the switch, a one-line statement of its scope, and — while holding — how many requests in the tree are parked (and how many of those come from child sessions), when they will be released, how long they have waited, and how many are parked in *other* conversations;
- a **Refresh** button that re-reads the scope instead of replaying logs.

Token buckets and the per-model breakdown are deliberately not on the panel; they stay available through `/cost`, `session_cost` and `detail=full`.

![The redesigned detail panel for one session in the peak tier: this session's spend, the tier and countdown, the amber/blue tariff band splitting peak and off-peak spend, the this-session and other-session split, partial coverage naming the unknown-model reason, the rates in force, and the tree-scoped Avoid-peak block showing two parked requests (one from a child session), a release countdown and one request waiting in an unrelated session](assets/panel-session.png)

### Scopes

| Scope | Meaning |
| --- | --- |
| `auto` (default) | The verified team when the session is a team member, otherwise its delegation tree. |
| `self` | This session only. |
| `tree` | This session plus every durable subagent descendant. |
| `team` | The whole team: lead, members and their descendants. Refused when membership cannot be verified. |

A `team` scope names every member's own money under **Team roster**, with the Lead marked ★:

![The redesigned detail panel for a Team scope: the team total in the brand face, the all-blue off-peak tariff band, complete coverage across seven sessions, and the roster with the Lead marked ★ and one money figure per member](assets/panel-team.png)

### Command and tool

| Surface | Behaviour |
| --- | --- |
| `/cost [sessionId] [auto\|self\|tree\|team]` | Prints the same summary the pill shows, including coverage warnings. |
| `session_cost` | Lets the assistant read a session's estimate; defaults to the calling session. |

## Avoiding peak hours

Peak windows cost twice the off-peak rate: DeepSeek Flash is ¥2 / ¥8 per million cache-miss / output tokens during peak against ¥1 / ¥4 off-peak, and V4 Pro is ¥9 / ¥27 against ¥4.5 / ¥13.5. If a request does not have to be answered *now*, it does not have to be billed at the expensive rate.

Each session's panel has a switch, and it governs that session together with the sessions it delegates to. **Avoid peak** (`避开高峰`) is off until you turn it on; while it is on and the current tier is peak, the model requests issued by *this session and its child sessions* are *parked* rather than sent, and released the moment the tier turns off-peak. Scope is one conversation tree, not the process: an unrelated conversation is never parked because this one is waiting. A delegated subagent follows its parent automatically, unless its own panel was switched by hand — the nearest manual choice wins: this session's own choice first, then the nearest switched ancestor, then the configured default. A child session's panel says so plainly with an `Inherited` badge; the parent's parked count includes its children's requests and states how many come from child sessions; and a request parked in a genuinely unrelated conversation is reported as "N more parked in other sessions". The request itself is unchanged — same messages, same tools, same bytes — so the answer is the same one you would have got, at half the price.

The important part is what the model sees: **nothing**. The gate holds the request at the `llm/stream` waterfall, before any provider dispatch, so no failure is ever reported, no error is appended to the session log, no retry is consumed, and no chunk is injected. From the loop's point of view the call was simply slow. The pill and the panel are the only places the wait is visible, and they show it plainly — the tier, the countdown to the off-peak release, how many requests in this conversation tree are parked (and how many of those come from child sessions), and how long the current hold has lasted. While something is parked, the pill gains the words `等待谷时`; the words, never colour alone, carry the state.

Because the switch is a *user* choice, it is not `config`-only: the panel writes it through the plugin's own route, and the host keeps a per-session map of manual choices in `<dsh home>/state/dsh-api-cost/gate.json`, so the choices survive a restart. A conversation tree that has never been switched inherits the configured default and reports that it is still the default. The panel never shows a state the host did not confirm, and a failed write keeps the previous choice beside an inline error.

Turning a session's switch off, pressing stop, or unloading the plugin releases the requests that are actually parked: turning off releases only the requests in that session's subtree that the change un-gates, while stopping the run or unloading the plugin releases all of them. A hold is cancellable at every instant and can never outlive the reason for it.

## HTTP

Two GET-only cost routes on fixed paths, with no configuration knob, plus the gate's control route:

| Route | Returns |
| --- | --- |
| `/dsh-api-cost/v2/view?session=<id>[&scope=…][&detail=summary\|full][&force=1]` | The unified cost view (ETag; `If-None-Match` answers `304`). |
| `/dsh-api-cost/v2/pricing` | Current period, next transition, rate card and provenance. |
| `GET /dsh-api-cost/v2/gate?session=<id>` | That session's tree-scoped gate state, including inherited choices (ETag; `If-None-Match` answers `304`). |
| `POST /dsh-api-cost/v2/gate` | Body `{"session":"<id>","enabled":boolean}`; flips that session's switch and answers the view the host stored. |

The cost routes are GET-only and reject anything else with `405`. `detail=summary` omits the per-model, roster and recent-call payloads; unknown parameters, scopes or details answer `400`; an unknown session answers `404`; a cross-site fetch is refused with `403`; a read that outlives its 8-second budget answers `503`. The gate read requires exactly one `session` query parameter, and a missing or malformed one answers `400`; each session's view carries its own `ETag`, so two sessions never share a cached state.

The gate's `POST` is the one mutating surface, so it is guarded before the body is read: `sec-fetch-site` outside `same-origin`/`none` is refused with `403`, a body that is not `application/json` with `415`, an `Origin` that does not match the request's `Host` with `403`, and a body that is not exactly `{"session":"<id>","enabled":boolean}` within 4096 bytes with `400` — a malformed session id or an extra key changes nothing. No response ever carries a local path.

## Rates

Published DeepSeek prices, in force from 2026-09-10 12:00 +08:00 (CNY per million tokens):

| Model | Period | Cache hit | Cache miss | Output |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | peak | 0.04 | 2 | 8 |
| `deepseek-flash` | off-peak | 0.02 | 1 | 4 |
| `deepseek-v4-pro` | peak | 0.30 | 9 | 27 |
| `deepseek-v4-pro` | off-peak | 0.15 | 4.5 | 13.5 |

The published USD column is billed as its own column, never converted at a guessed rate. Peak windows are Monday–Friday 09:00–12:00 and 14:00–18:00 Beijing time, excluding statutory holidays; nights, weekends, holidays and 调休 makeup days are off-peak. Money accumulates in exact integer arithmetic (nano-units) and only rounds for display. Years missing from the holiday table resolve **off-peak** and are reported as `holiday-data-missing`.

## Configuration

In the profile patch:

```yaml
- id: dsh-api-cost
  name: 'dsh-api-cost'
  config:
    defaultScope: auto          # auto | self | tree | team
    tool: true                  # register session_cost
    command: true               # register /cost
    holidays:                   # extend or correct the bundled Chinese calendar
      '2027':
        holidays: ['2027-01-01', ['2027-02-05', '2027-02-11']]
        makeupWorkdays: ['2027-02-20']
    gate:                       # the per-tree off-peak gate; a session's panel switch covers it and its child sessions
      enabled: false            # default position for a session that was never switched by hand
      persist: true             # keep every session's position across restarts
      path: ~                   # override <dsh home>/state/dsh-api-cost/gate.json
      models: all               # all | priced
```

Changing `holidays` changes the projection's fold identity, so stale checkpoints are discarded and rebuilt instead of being mixed with new money.

`gate.enabled` is only a **default**: once a session's panel has stored a manual choice, that choice — and the subtree under it — follows it on every later start, because the user's choice is the authority, not the profile file; a descendant that stored its own choice overrides it for its own subtree. A conversation tree that has never been switched keeps inheriting the default. Only manual choices are persisted (per session id); parent links are reconstructed from live sessions at startup. A version-1 state file from the process-global design is ignored rather than guessed at, so after upgrading every tree starts from the configured default. Set `gate.persist: false` to keep the positions in memory only.

`gate.models: priced` narrows the gate to ids the published card actually prices. The default, `all`, holds every model request of a gated conversation tree — a subscription-backed or third-party route has no peak column to save on, so on a composition that mixes them, `priced` avoids delaying calls that gain nothing.

## What it does not promise

- **It is an estimate, not a bill.** Only published rates and reported token counts are used; grants, discounts, retry billing and third-party routing are invisible here.
- **Only official DeepSeek models are priced.** An unknown id is recorded as `unknown-model` with zero money rather than guessed.
- **A settlement is billed at its settlement time.** A call that crosses a boundary is not split proportionally, because the official documentation defines no such split.
- **Unreadable sessions are reported, not guessed**: they appear as `session-unavailable` with `coverage.status = partial`, and a traversal that exceeds the 400-session budget is marked `scope-truncated`.
- **A malformed usage report is never billed.** The call is counted as an attempt and flagged `invalid-usage` or `missing-usage`, but it adds no money and no tokens, so a total never contains spend that no priced call explains.
- **The Pro routing caveat is a rate-card note, not a coverage gap.** This repository records that official billing for `deepseek-v4-pro` after 2026-09-14 12:00 +08:00 is disputed (whether those requests are served — and billed — as Flash, or keep the Pro column). The plugin cannot verify the provider's policy, so it prices the published Pro column and says so. That note appears **only when the scope actually priced that model**; other card caveats (missing holiday data, calls predating the card) always show, because they shape the rates and period on display.
- **Fork semantics are explicit**: a forked child's own figure excludes the inherited prefix, so ancestors are not billed twice when you look at a branch.

And about the Avoid-peak switch specifically:

- **It holds calls; it does not split them.** A request that is already in flight when peak begins is unaffected, and a call that starts off-peak but settles in peak is still billed at peak, because the settlement instant decides the rate and it cannot be known before dispatch.
- **A hold can be long.** A weekday window is up to four hours (09:00–12:00, 14:00–18:00), so the session will look idle while the pill explains why. Nothing is lost: the request is sent unchanged the moment the window closes, and pressing stop releases it at once.
- **The switch is per conversation tree; the process is the boundary.** Two DSH processes hold their own parked requests. Manual choices are stored per session id in one state file, so sessions of the same profile share the file while the in-flight holds never leave the process that created them.
- **Unrelated conversations are untouched; a child session can override.** A tree's switch never reaches another conversation, and a subagent follows its parent by default while a manual choice of its own wins for its own subtree.
- **Delegation lineage is runtime state, never persisted.** In a fresh process the conversation tree is rebuilt as sessions get announced or looked up; a session the plugin has not observed yet is treated as a root and follows only its own/default choice, so switching a parent covers an already-existing child only once that link is observable.
- **Its durable state is a file, not a database.** `<dsh home>/state/dsh-api-cost/gate.json`, written atomically as a versioned map of manual per-session choices (bounded to 512 stored sessions, the oldest changed one evicted first when full). Memory is bounded too: at most 1024 session records and 4096 parent links, so under extreme pressure an inactive record or link can be evicted — a manual choice comes back from the durable file, and a link is re-learned from live sessions. If the file cannot be read or written, the switches still work for the current run and the panel reports the position as not durable rather than failing. A version-1 file written by the process-global design is ignored, never guessed at.
- **Failures fail open.** The gate is built so that it cannot break a model call: an unreadable clock, an unreadable tier or a timer that will not arm all release the request immediately. The failure mode of this feature is "you paid peak prices", never "your session stopped".

## Development

```sh
pnpm install --ignore-scripts     # dev-only toolchain
pnpm typecheck                    # strict TypeScript over src, test and scripts
pnpm build                        # dist/index.js, dist/client.js, dist/types
pnpm test                         # builds, then runs the Node suite over *.test.ts
pnpm bench                        # size/state budgets plus machine-calibrated timing budgets
```

| Path | Role |
| --- | --- |
| `src/pricing/` | Rate card, holiday calendar, exact BigInt pricing engine. |
| `src/host/projection.ts` | The pure `apiCost` fold and its wire schema. |
| `src/host/query.ts` | Scope resolution, single-flight aggregation, bounded caches. |
| `src/host/gate.ts` | The per-tree off-peak hold state machine, its durable position map, the live parent-link cache (`session/created`) and the `llm/stream` middleware. |
| `src/host/http.ts` | The cost routes, the gate's read/write route, validation and the error taxonomy. |
| `src/client/` | TSX pill and panel, projection seats, the scope bridge and the gate store. |
| `test/` | Node-native TypeScript tests: pricing, client bridge, release contract, host integration, gate hold/wire, one real-cordis waterfall test, and two independent claim-first verifiers (`test/gate-sessions.test.ts` for the v2.2 per-session scope, `test/gate-tree.test.ts` for the v2.3 per-tree scope). |
| `scripts/build.ts` | esbuild host/client plus declaration emission. |
| `docs/baseline.json` | Recorded 1.0.0 measurements the budget gate compares against. |
| `docs/off-peak-gate.md` | The gate's frozen interface and the reasoning behind each clause. |
| `docs/verification-gate.md` | Claim-by-claim verification record for the gate, with the falsification runs. |

Measured on Node 24.21 against the recorded 1.0.0 baseline and the same fixtures: 100k settlements price in **11 ms** (was 22.7 ms), a 71-session historical tree aggregates completely in **1.4 ms** cold and **0.05 ms** warm, and per-session projection state stays under **6 KiB** after 100k settlements. The shipped bundles in 2.3 are **13.7 KiB** (client) and **15.0 KiB** (host) gzip: the growth over the pre-gate 9.6 / 10.3 KiB is the gate (a session-keyed client store, the durable choices, the parent-link resolution and the wire) plus the tariff-ledger panel redesign (one panel clock, the tariff band, the gate block and the larger bilingual copy), and both still fit hard size budgets asserted in `test/build.test.ts` and `scripts/bench.ts`.

## Migrating from 1.x

2.0 is a deliberate breaking release: no legacy routes, parameters, configuration keys or data shapes are kept.

Upgrading from **2.1 to 2.2** breaks exactly two things, both on the gate: `GET /dsh-api-cost/v2/gate` requires `?session=<id>`, and `POST /dsh-api-cost/v2/gate` takes `{"session":"<id>","enabled":boolean}` instead of `{"enabled":boolean}`. The version-1 gate file is ignored (a process-global flag cannot be attributed to a session), so every session starts from `gate.enabled` until it is switched again.

Upgrading from **2.2 to 2.3** changes the gate's scope and its view fields; the route shapes stay the same. One switch now governs the session *and its delegated child sessions*, while unrelated conversations remain independent. `GateView` moves to schemaVersion 4: it adds `source` (`self` / `inherited` / `default`) and `inheritedFrom`, makes `holding` / `since` / `releaseAt` / `heldTotal` / `delayedMs` **subtree aggregates** and adds `ownHolding` for this session's own share, and `otherHolding` now means parked requests outside this subtree. The state file is still version 2 and holds only manual per-session choices; parent links are reconstructed from live sessions.

| 1.x | 2.0 |
| --- | --- |
| `GET /dsh-api-cost/api`, `/api/session`, `/api/status`, `/api/reconcile` | `GET /dsh-api-cost/v2/view`, `/v2/pricing`, `/v2/gate` |
| `tree=0`, `scope=corpus`, `force` on every route | `scope=self\|tree\|team`, `force=1` on `/view` |
| `routePrefix` configuration | fixed `/dsh-api-cost/v2` |
| Plugin-side log replay, LRU ledgers, recount button | Host projection, durable checkpoint, Refresh |
| Plain-number money | Exact decimal strings folded from BigInt nano-units |
| `index.mjs`, `client.js`, `lib/pricing.mjs` | `src/**/*.ts(x)` compiled to `dist/` |

## License

MIT — see [LICENSE](LICENSE).
