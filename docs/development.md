# Development

How to build, typecheck, test and benchmark the repository, what each path does,
and the measured budget evidence the project holds itself to. This page is for
contributors: the published package ships prebuilt JavaScript, so the Node
toolchain is a development-only requirement.

## Prerequisites

- Node.js **24** or newer. Development only — the published package ships prebuilt
  JavaScript, so installation never runs a compiler.
- pnpm. CI uses Node 24 with pnpm 11.7.0 and installs with
  `pnpm install --frozen-lockfile --ignore-scripts`.
- No running DSH host is needed for the Node-native `pnpm test` suite. To exercise
  the plugin inside DSH, the host must be DeepSeek Harness **0.2.0-rc.2** with the
  `sessionProjections`, `sessionProjectionCache` and `sessionQuery` capabilities
  mounted (the shipped `web` and `desktop` profiles have them).

## Commands

```sh
pnpm install --ignore-scripts     # dev-only toolchain
pnpm typecheck                    # strict TypeScript over src, test and scripts
pnpm build                        # dist/index.js, dist/client.js, dist/types
pnpm test                         # builds, then runs the Node suite over *.test.ts
pnpm bench                        # size/state budgets plus machine-calibrated timing budgets
```

`pnpm check` runs the three gates in order (`typecheck && test && bench`), the same
sequence CI runs.

## Repository map

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

## Measured results

Measured on Node 24.21 against the recorded 1.0.0 baseline and the same fixtures:
100k settlements price in **11 ms** (was 22.7 ms), a 71-session historical tree
aggregates completely in **1.4 ms** cold and **0.05 ms** warm, and per-session
projection state stays under **6 KiB** after 100k settlements. The shipped bundles
in 2.3 are **13.7 KiB** (client) and **15.0 KiB** (host) gzip: the growth over the
pre-gate 9.6 / 10.3 KiB is the gate (a session-keyed client store, the durable
choices, the parent-link resolution and the wire) plus the tariff-ledger panel
redesign (one panel clock, the tariff band, the gate block and the larger bilingual
copy), and both still fit hard size budgets asserted in `test/build.test.ts` and
`scripts/bench.ts`.

## See also

- [off-peak-gate.md](./off-peak-gate.md) — the gate's frozen interface.
- [verification-gate.md](./verification-gate.md) — claim → test → verdict record,
  including the commands and the falsification runs.
- [dsh-api-cost README](../README.md) — install, usage and host prerequisites.
