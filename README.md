<h1 align="center">dsh-api-cost</h1>

<p align="center">DeepSeek cost estimation for DeepSeek Harness: peak / off-peak rates, delegation or team spend attributed to the session that caused it, folded by the host's session projections.</p>

<p align="center">
  <a href="https://github.com/NIRVANA-APOC/dsh-api-cost/actions/workflows/test.yml"><img src="https://github.com/NIRVANA-APOC/dsh-api-cost/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT">
  <img src="https://img.shields.io/badge/DSH-plugin-4c8bf5" alt="DSH plugin">
</p>

<p align="center"><b>English</b> · <a href="README.zh.md">中文</a></p>

---

`dsh-api-cost` 2.0 is a **TypeScript, projection-first** rewrite. Instead of metering streams, replaying logs and polling on a timer, the plugin registers one pure session projection; the Harness owns the event drive, the per-session watermark, the durable checkpoint and the delivery to the browser. The client half reads the host's own projection through the framework `useProjection` seat.

What that buys you:

- **Correct history without a recount button** — the first read of a session, a resumed conversation, or a restart all fold from the durable log through the host's checkpoint cache, so a figure never starts at ¥0 and never double counts.
- **Real settlement semantics** — one billed event per `assistant/message` (or `assistant/attempt` fallback), priced at the *event's* own settlement time, with fork-inherited prefixes excluded from a child's own spend.
- **Honest delegation and team totals** — `self`, `tree` and `team` scopes resolved from durable subagent catalogs and the team roster, with `own` always meaning *this session* and `others = total − own`.
- **An optional Avoid-peak switch** — one toggle in the pill's panel parks model requests until the cheap window opens, so the call is billed off-peak and the model never sees a failure.
- **Lightweight by construction** — no replay framework, no database, no own polling loop. Built artifacts: client ≈ **11.3 KiB gzip**, host ≈ **13.1 KiB gzip**.

**Contents:** [Requirements](#requirements) · [Install](#install) · [Usage](#usage) · [Avoiding peak hours](#avoiding-peak-hours) · [HTTP](#http) · [Rates](#rates) · [Configuration](#configuration) · [What it does not promise](#what-it-does-not-promise) · [Development](#development) · [Migrating from 1.x](#migrating-from-1x) · [License](#license)

## Requirements

- DeepSeek Harness **0.2.0-rc.2** with the `sessionProjections`, `sessionProjectionCache` and `sessionQuery` capabilities mounted (the shipped `web` and `desktop` profiles have them).
- Node.js **24** or newer for development only; the published package ships prebuilt JavaScript.

The plugin declares those services in `inject`, so in a composition without them it stays inactive rather than half-working. The Avoid-peak switch additionally uses the `llm` service's `llm/stream` waterfall; a composition without `llm` simply has nothing to hold, and every other surface keeps working.

## Install

```sh
dsh plugin --profile web add dsh-api-cost                # from npm
dsh plugin --profile web add /absolute/path/to/checkout  # from a checkout or a git URL
```

The package ships `dist/index.js` (ESM host) and `dist/client.js` (the lazy browser factory), so **installation never runs a compiler**. A local source checkout must be built once with `pnpm build` before it is installed that way.

Host-side features (the projection, `/cost`, `session_cost`, the HTTP reads) take effect immediately. The composer pill appears once the client bundle is composed at startup, so restart DSH once.

## Usage

### The pill

Beside the shipped session-stats pills, the cost pill shows this session's estimated spend and the period in force (**peak** / **off-peak** spelled out in words, never colour alone). It reads the host projection directly, so it repaints when a settlement lands — not on a timer. A `Partial` marker appears whenever any contributing session is unpriced, truncated or unreadable.

| Off-peak | Peak |
| --- | --- |
| ![The pill in the off-peak tier: this session's cost in CNY with the tier written as the word 谷, in the neutral colour](https://raw.githubusercontent.com/NIRVANA-APOC/dsh-api-cost/main/assets/pill-off-peak.png) | ![The same figure during peak hours: the tier reads 峰 and the capsule switches to the warning colour](https://raw.githubusercontent.com/NIRVANA-APOC/dsh-api-cost/main/assets/pill-peak.png) |

### The panel

Clicking the pill (or pressing Enter on it) opens a trigger-anchored dialog: totals, the this-session / other-session split, the peak / off-peak split, the priced-call count, coverage, the team roster when the scope is a team, current rates, a rate-card notes row when the published card carries a caveat that affects this scope, the countdown to the next period change, an **Avoid-peak switch** (see below), and a **Refresh** button that re-reads the scope instead of replaying logs. Token buckets and the per-model breakdown are deliberately not on the panel; they stay available through `/cost`, `session_cost` and `detail=full`.

![The detail panel for one session: total in CNY and USD, this-session and other-session split, partial coverage naming the unknown-model reason, session and priced-call counts, the peak and off-peak split, the period with a countdown, the rates in force, and the Refresh button](https://raw.githubusercontent.com/NIRVANA-APOC/dsh-api-cost/main/assets/panel-session.png)

### Scopes

| Scope | Meaning |
| --- | --- |
| `auto` (default) | The verified team when the session is a team member, otherwise its delegation tree. |
| `self` | This session only. |
| `tree` | This session plus every durable subagent descendant. |
| `team` | The whole team: lead, members and their descendants. Refused when membership cannot be verified. |

A `team` scope names every member's own money under **Team roster**, with the Lead marked ★:

![The detail panel for a Team scope: the total with the requesting seat's own share, complete coverage across seven sessions, and the roster with the Lead marked ★ and one money figure per member](https://raw.githubusercontent.com/NIRVANA-APOC/dsh-api-cost/main/assets/panel-team.png)

### Command and tool

| Surface | Behaviour |
| --- | --- |
| `/cost [sessionId] [auto\|self\|tree\|team]` | Prints the same summary the pill shows, including coverage warnings. |
| `session_cost` | Lets the assistant read a session's estimate; defaults to the calling session. |

## Avoiding peak hours

Peak windows cost twice the off-peak rate: DeepSeek Flash is ¥2 / ¥8 per million cache-miss / output tokens during peak against ¥1 / ¥4 off-peak, and V4 Pro is ¥9 / ¥27 against ¥4.5 / ¥13.5. If a request does not have to be answered *now*, it does not have to be billed at the expensive rate.

The panel has one switch for that. **Avoid peak** (`避开高峰`) is off until you turn it on; while it is on and the current tier is peak, every model request in the process is *parked* rather than sent, and released the moment the tier turns off-peak. The request itself is unchanged — same messages, same tools, same bytes — so the answer is the same one you would have got, at half the price.

The important part is what the model sees: **nothing**. The gate holds the request at the `llm/stream` waterfall, before any provider dispatch, so no failure is ever reported, no error is appended to the session log, no retry is consumed, and no chunk is injected. From the loop's point of view the call was simply slow. The pill and the panel are the only places the wait is visible, and they show it plainly — the tier, the countdown to the off-peak release, how many requests are parked, and how long the current hold has lasted. While the switch is on and something is parked, the pill gains one more text segment (`¥1.23 · 峰 · 等待谷时`); the segment is words, never colour alone.

Because the switch is a *user* choice, it is not `config`-only: the panel writes it through the plugin's own route, and the host keeps it in `<dsh home>/state/dsh-api-cost/gate.json`, so the position survives a restart. The panel never shows a state the host did not confirm.

Turning the switch off, pressing stop, or unloading the plugin releases every parked request immediately — a hold is cancellable at every instant and can never outlive the reason for it.

## HTTP

Two GET-only cost routes on fixed paths, with no configuration knob, plus the gate's control route:

| Route | Returns |
| --- | --- |
| `/dsh-api-cost/v2/view?session=<id>[&scope=…][&detail=summary\|full][&force=1]` | The unified cost view (ETag; `If-None-Match` answers `304`). |
| `/dsh-api-cost/v2/pricing` | Current period, next transition, rate card and provenance. |
| `GET /dsh-api-cost/v2/gate` | The off-peak gate's state (ETag; `If-None-Match` answers `304`). |
| `POST /dsh-api-cost/v2/gate` | Body `{"enabled":boolean}`; flips the switch and answers the view the host stored. |

The cost routes are GET-only and reject anything else with `405`. `detail=summary` omits the per-model, roster and recent-call payloads; unknown parameters, scopes or details answer `400`; an unknown session answers `404`; a cross-site fetch is refused with `403`; a read that outlives its 8-second budget answers `503`. The gate's `POST` is the one mutating surface, so it is guarded before the body is read: `sec-fetch-site` outside `same-origin`/`none` is refused with `403`, a body that is not `application/json` with `415`, an `Origin` that does not match the request's `Host` with `403`, and a body that is not exactly `{"enabled":boolean}` within 4096 bytes with `400`. No response ever carries a local path.

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
    gate:                       # the off-peak request gate; the panel owns the switch
      enabled: false            # initial position, used only when nothing is stored yet
      persist: true             # keep the position across restarts
      path: ~                   # override <dsh home>/state/dsh-api-cost/gate.json
      models: all               # all | priced
```

Changing `holidays` changes the projection's fold identity, so stale checkpoints are discarded and rebuilt instead of being mixed with new money.

`gate.enabled` is only a **default**: once the panel has stored a position, that position wins on every later start, because the user's choice is the authority, not the profile file. Set `gate.persist: false` to keep the switch in memory only.

`gate.models: priced` narrows the gate to ids the published card actually prices. The default, `all`, holds every model request — a subscription-backed or third-party route has no peak column to save on, so on a composition that mixes them, `priced` avoids delaying calls that gain nothing.

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
- **It is per process.** Two DSH processes hold their own parked requests; the switch position is shared through the state file, the holds are not.
- **Its durable flag is a file, not a database.** `<dsh home>/state/dsh-api-cost/gate.json`, written atomically. If it cannot be read or written, the switch still works for the current run and the panel reports it as not durable rather than failing.
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
| `src/host/gate.ts` | The off-peak hold state machine, its durable flag and the `llm/stream` middleware. |
| `src/host/http.ts` | The cost routes, the gate's read/write route, validation and the error taxonomy. |
| `src/client/` | TSX pill and panel, projection seats, the scope bridge and the gate store. |
| `test/` | Node-native TypeScript tests: pricing, client bridge, release contract, host integration, gate hold/wire, and one real-cordis waterfall test. |
| `scripts/build.ts` | esbuild host/client plus declaration emission. |
| `docs/baseline.json` | Recorded 1.0.0 measurements the budget gate compares against. |
| `docs/off-peak-gate.md` | The gate's frozen interface and the reasoning behind each clause. |
| `docs/verification-gate.md` | Claim-by-claim verification record for the gate, with the falsification runs. |

Measured on Node 24.21 against the recorded 1.0.0 baseline and the same fixtures: 100k settlements price in **11 ms** (was 22.7 ms), a 71-session historical tree aggregates completely in **1.4 ms** cold and **0.05 ms** warm, per-session projection state stays under **6 KiB** after 100k settlements, and the shipped bundles are **11.3 KiB** (client) and **13.1 KiB** (host) gzip — the growth over the pre-gate 9.6 / 10.3 KiB is the Avoid-peak surface: a second client store, the panel switch and its status rows, the bilingual copy, and the gate itself.

## Migrating from 1.x

2.0 is a deliberate breaking release: no legacy routes, parameters, configuration keys or data shapes are kept.

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
