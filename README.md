<h1 align="center">dsh-api-cost</h1>

<p align="center">Real-time DeepSeek API cost with peak / off-peak rates, shown under the composer in CNY and USD.</p>

<p align="center">
  <a href="https://github.com/NIRVANA-APOC/dsh-api-cost/actions/workflows/test.yml"><img src="https://github.com/NIRVANA-APOC/dsh-api-cost/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT">
  <img src="https://img.shields.io/badge/DSH-plugin-4c8bf5" alt="DSH plugin">
</p>

<p align="center"><b>English</b> · <a href="README.zh.md">中文</a></p>

---

DeepSeek prices its official API by time of day: weekday working hours in Beijing time are **peak** (double price), and everything else — nights, weekends, Chinese statutory holidays — is **off-peak**. DSH itself shows token counts, not money. This plugin turns those tokens into money, without touching a single request.

Three things make the figure worth trusting. It prices against the **statutory-holiday and makeup-workday calendar**, so a holiday Monday is not billed at peak. It can **recount from the session logs** — idempotently, keyed by `turn:step` — recovering calls that settled before the plugin loaded or were lost across a restart. And it **attributes delegated work** instead of hiding it: subagent and agent-team spend rolls into the session that started it, split into `this session` and `subsessions ×N`.

It is deliberately small: **no runtime dependencies, no build step, no database** — two source files and a pricing table, with the UI built on nothing but the host's own platform seeds.

**Contents:** [Features](#features) · [Install](#install) · [Usage](#usage) · [Screenshots](#screenshots) · [Pricing](#pricing) · [Configuration](#configuration) · [Limitations](#limitations) · [Development](#development) · [Contributing](#contributing) · [License](#license)

## Features

- **A pill under the composer** — what this conversation has cost so far, in CNY and USD, plus the tier in force right now.
- **An anchored detail panel** — countdown to the next tier switch, the peak / off-peak split, token buckets (cache hit, cache miss, output), per-model spend, and the calls still in flight.
- **Priced at settlement time** — every model call is priced at the tier in force when it settled, so a conversation that crosses a boundary books the two tiers separately instead of pricing the whole thing at one rate.
- **Subagents and agent teams roll up** — delegated work counts towards the session that started it, and the panel splits the total into "this session" and "subsessions ×N".
- **Recount** — replays the session log to recover calls that settled before the plugin loaded, or that were lost across a restart. Idempotent: replay is keyed by `turn:step`, so pressing it twice does not double-count.
- **Three surfaces, one set of figures** — the `/cost` command, the `session_cost` tool, and a plain GET JSON snapshot.
- **Zero runtime dependencies** — no build step and no bundler; the UI is built on the host's platform seeds only.

## Install

```sh
dsh plugin --profile web add dsh-api-cost            # from npm
dsh plugin --profile web add /absolute/path/to/repo  # from a checkout or a git URL
```

The Host half (metering, `/cost`, `session_cost`, HTTP snapshot) starts immediately. The Client half (the pill) is composed into the boot manifest, so **restart DSH once** to see it.

Developed and tested against DeepSeek Harness 0.2.0-rc.2. The profile loader must understand `dsh.bundle` bundles — that is what `package.json` declares here, together with the `cordis.patch.yml` beside it.

## Usage

### The pill

A pill sits in the composer dock, alongside the built-in session-stats and token-usage pills. It shows two things:

- what this conversation has cost so far, in CNY and USD;
- the tier in force — `峰` peak or `谷` off-peak, in words and following the UI language, not signalled by colour alone.

During peak hours the pill switches to a warning colour, so a long task started at 10:00 looks different from one started at 20:00.

### The detail panel

Click the pill (or press Enter on it) to open a panel directly above it; click outside or press Escape to close it.

- The current tier, why it applies (weekend, statutory holiday, makeup workday), and a countdown to the next switch
- The total, in CNY and USD
- This session vs. subsessions, and the peak / off-peak split
- Any calls still in flight
- Token buckets: cache hit, cache miss, output
- Per-model spend
- The rates in force right now

### Subagents and agent teams

Delegated work is attributed to the session that started it: the pill and the panel report the whole delegation tree and split it into `of which this session` and `of which subsessions ×N`, so a shared total never looks like it came from nowhere. Multi-level delegation accumulates.

Attribution comes from the session's own `parentSession` (`session/created`), with `subagent/start` as a fallback, so a child that never announces a header still lands under its parent.

A session that is a Team member reports the whole team by default, with the Lead marked ★, so any seat can see what the team is spending. Membership is read from the host's Agent Teams service (`tryMembership()` / `listMembers()`), not from a list the plugin maintains.

The scope can be pinned per request: `auto` (Team → delegation tree → self), `team`, `tree`, or `self`.

### Command and tool

| Surface | Behaviour |
| --- | --- |
| `/cost [sessionId]` | Prints the same summary, with the current tier and rates. |
| `session_cost` | Lets the model read a session's cost; omit the id to report the current conversation. |

### HTTP API

All routes are GET-only, and deliberately live outside `/api` — that bridge belongs to the connection layer and enforces its request trust policy, answering a plain page GET with 401:

| Route | Returns |
| --- | --- |
| `/dsh-api-cost/api?session=<id>[&scope=auto\|tree\|team\|self][&force=1]` | Full snapshot |
| `/dsh-api-cost/api/session?session=<id>` | One session's ledger |
| `/dsh-api-cost/api/status` | Current tier, rate card and the next boundary |
| `/dsh-api-cost/api/reconcile?session=<id>&scope=…` | Replays the session logs and returns the recount report (`scope=corpus` scans every session) |

## Screenshots

The composer pill in both tiers, and the detail panel it opens — the labels follow the app's language:

| Off-peak | Peak |
| --- | --- |
| ![The composer pill in the off-peak tier: the session cost in CNY with the tier beside it, drawn in the neutral colour](assets/pill-off-peak.png) | ![The same pill during peak hours, drawn in the warning colour, with the tier spelled out beside the amount](assets/pill-peak.png) |

![The detail panel: the session total in CNY and USD, the current tier with a countdown to the next switch, the peak / off-peak split, the rates in force, and the recount button with the calls it recovered](assets/panel-session.png)

![The same panel for an agent team: the total split into "of which this session" and "of which team members", with the roster below and the Lead marked with a star](assets/panel-team.png)

## Pricing

Rates are DeepSeek's published card, effective 2026-09-10 12:00 +08:00, in CNY per million tokens:

| Model | Tier | Cache hit | Cache miss | Output |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | peak | 0.04 | 2 | 8 |
| `deepseek-flash` | off-peak | 0.02 | 1 | 4 |
| `deepseek-v4-pro` | peak | 0.30 | 9 | 27 |
| `deepseek-v4-pro` | off-peak | 0.15 | 4.5 | 13.5 |

The USD figure comes from DeepSeek's own USD price column, not from a converted exchange rate.

**Tiers** (Beijing time, UTC+8, no daylight saving): peak is Monday–Friday 09:00–12:00 and 14:00–18:00, excluding Chinese statutory holidays. Everything else — nights, weekends, holidays and makeup workdays — is off-peak, at half the peak price. Boundaries are half-open, so 12:00 and 18:00 sharp are off-peak. The built-in holiday and makeup-workday calendar covers 2025 and 2026; a year it does not cover is priced as off-peak and labelled that way rather than guessed at.

## Configuration

Override the plugin's row in your profile patch:

```yaml
- id: dsh-api-cost
  name: 'dsh-api-cost'
  config:
    routePrefix: /dsh-api-cost/api   # only if the path collides
    tree: true                       # subsessions count towards the session that started them
    team: true                       # a Team member reports the whole team by default
    holidays: {}                     # add future years, or correct one
    tool: true                       # register the session_cost tool
    command: true                    # register /cost
```

To report a session without its delegation tree, ask for it directly: `GET /dsh-api-cost/api?session=<id>&tree=0`, or turn `tree` off in the configuration above.

## Limitations

- **It is an estimate, not a bill.** It prices the tokens the model reports against the published card, so credits, discounts and retry behaviour are invisible to it.
- **Only DeepSeek's official card is priced.** Other providers and third-party routers are reported as unknown models at cost 0 rather than guessed at.
- **It counts what settles while it is loaded**, until you press recount — the session logs are the source of truth for anything earlier.
- **Subsession attribution depends on the runtime.** Delegations that ended before the plugin loaded, and were never recorded, cannot be recovered afterwards.
- **The card is maintained by hand.** A price change needs `lib/pricing.mjs` updated and a restart.
- **`deepseek-v4-pro` routing is disputed** — whether calls after 2026-09-14 12:00 are routed to Flash and billed as Flash. The plugin prices it as Pro and flags the conflict in the snapshot's `routingDisputed` field rather than silently choosing a side.
- **A call that straddles a boundary** is priced at the tier in force when it settled; it is not split by duration, which DeepSeek does not specify.

Estimates that fall outside the card — calls older than the effective date, a year missing from the holiday calendar, the routing conflict above — do not take up panel space; the Host still reports the matching fields (`holidayDataMissing`, `beforeCurrentCard`, `routingDisputed`, plus the card's source and effective date) in `GET /dsh-api-cost/api`.

## Development

```sh
npm test        # node --test — 118 tests, no dependencies to install
```

| Path | Role |
| --- | --- |
| `index.mjs` | Host half: meters model calls, prices them at settlement, keeps the ledger, serves the HTTP routes, registers the tool and the command |
| `client.js` | Client half: the composer pill and the detail panel |
| `lib/pricing.mjs` | Rate card, peak / off-peak calendar and the pricing functions (pure, zero-dependency) |
| `test/` | 118 tests over pricing, the host ledger and the client bundle |
| `cordis.patch.yml` | The bundle patch that inserts the plugin row |

The client bundle registers itself with `window.__ModuleLoader__.load({ id: <package name> })`. That id **must equal the package name**: the combo route serves every client bundle as a single script, so a bundle that registers under the wrong key fails the whole response. `test/client.test.mjs` reads the expected id from `package.json`, which is why a rename cannot silently drift past it.

## Contributing

Issues and pull requests are welcome. Run `npm test` before opening one — the suite is the contract for the pricing engine, the ledger and the client bundle.

## License

MIT — see [LICENSE](LICENSE).
