# Migrating from 1.x

Every breaking change between the 1.x line and the current 2.3 line, grouped by
release boundary, so an upgrade is a checklist instead of guesswork. The gate's
current contract is in [off-peak-gate.md](./off-peak-gate.md) (with the 2.1.0 and
2.2.0 contracts kept as appendices); the current keys are in
[configuration.md](./configuration.md).

## 1.x → 2.0

2.0 is a deliberate breaking release: no legacy routes, parameters, configuration
keys or data shapes are kept.

| 1.x | 2.0 |
| --- | --- |
| `GET /dsh-api-cost/api`, `/api/session`, `/api/status`, `/api/reconcile` | `GET /dsh-api-cost/v2/view`, `/v2/pricing`, `/v2/gate` |
| `tree=0`, `scope=corpus`, `force` on every route | `scope=self\|tree\|team`, `force=1` on `/view` |
| `routePrefix` configuration | fixed `/dsh-api-cost/v2` |
| Plugin-side log replay, LRU ledgers, recount button | Host projection, durable checkpoint, Refresh |
| Plain-number money | Exact decimal strings folded from BigInt nano-units |
| `index.mjs`, `client.js`, `lib/pricing.mjs` | `src/**/*.ts(x)` compiled to `dist/` |

## 2.1 → 2.2

Upgrading from **2.1 to 2.2** breaks exactly two things, both on the gate:
`GET /dsh-api-cost/v2/gate` requires `?session=<id>`, and
`POST /dsh-api-cost/v2/gate` takes `{"session":"<id>","enabled":boolean}` instead
of `{"enabled":boolean}`. The version-1 gate file is ignored (a process-global flag
cannot be attributed to a session), so every session starts from `gate.enabled`
until it is switched again.

## 2.2 → 2.3

Upgrading from **2.2 to 2.3** changes the gate's scope and its view fields; the
route shapes stay the same. One switch now governs the session *and its delegated
child sessions*, while unrelated conversations remain independent. `GateView` moves
to schemaVersion 4: it adds `source` (`self` / `inherited` / `default`) and
`inheritedFrom`, makes `holding` / `since` / `releaseAt` / `heldTotal` /
`delayedMs` **subtree aggregates** and adds `ownHolding` for this session's own
share, and `otherHolding` now means parked requests outside this subtree. The state
file is still version 2 and holds only manual per-session choices; parent links are
reconstructed from live sessions.

## See also

- [off-peak-gate.md](./off-peak-gate.md) — the current gate contract, plus the
  historical v2.1.0 and v2.2.0 contracts in its appendices.
- [verification-gate.md](./verification-gate.md) — the claim matrices for the
  per-session and per-tree revisions.
- [configuration.md](./configuration.md) — the current `gate.*` keys.
- [http-api.md](./http-api.md) — the current route shapes and error taxonomy.
- [dsh-api-cost README](../README.md) — install and usage.
