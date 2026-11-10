# HTTP API

Reference for the plugin's HTTP surface: the fixed-path cost routes and the
Avoid-peak gate's read/write route. The gate's own design and frozen contract are
in [off-peak-gate.md](./off-peak-gate.md); the keys that change the defaults are in
[configuration.md](./configuration.md).

Two GET-only cost routes live on fixed paths, with no configuration knob, plus the
gate's control route:

| Route | Returns |
| --- | --- |
| `GET /dsh-api-cost/v2/view?session=<id>[&scope=…][&detail=summary\|full][&force=1]` | The unified cost view (ETag; `If-None-Match` answers `304`). |
| `GET /dsh-api-cost/v2/pricing` | Current period, next transition, rate card and provenance. |
| `GET /dsh-api-cost/v2/gate?session=<id>` | That session's tree-scoped gate state, including inherited choices (ETag; `If-None-Match` answers `304`). |
| `POST /dsh-api-cost/v2/gate` | Body `{"session":"<id>","enabled":boolean}`; flips that session's switch and answers the view the host stored. |

## Cost view

`GET /dsh-api-cost/v2/view?session=<id>` returns the unified cost view for one
session.

| Parameter | Meaning |
| --- | --- |
| `session=<id>` | The session the view is for. |
| `scope=auto\|self\|tree\|team` | The aggregation scope. When omitted, the configured `defaultScope` applies — see [configuration.md](./configuration.md). |
| `detail=summary\|full` | `summary` (the default) omits the per-model, roster and recent-call payloads; `full` includes them. |
| `force=1` | Skips the cached view and recomputes it; `1` is the only accepted value. |

Every view carries an `ETag`, and a matching `If-None-Match` answers `304` with no
body. Each session's view carries its own `ETag`, so two sessions never share a
cached state.

## Pricing

`GET /dsh-api-cost/v2/pricing` takes no parameters and returns the current period,
the next transition, the rate card and its provenance.

## Gate state

`GET /dsh-api-cost/v2/gate?session=<id>` returns that session's tree-scoped gate
state, including inherited choices. The read requires exactly one `session` query
parameter, and a missing or malformed one answers `400`. It too carries an `ETag`,
and `If-None-Match` answers `304`.

## Gate mutation

`POST /dsh-api-cost/v2/gate` is the one mutating surface in the API: it flips one
session's switch and answers the view the host stored. Its body is
`{"session":"<id>","enabled":boolean}`.

The request is guarded before the body is read, in this order:

| Order | Check | Refusal |
| --- | --- | --- |
| 1 | `sec-fetch-site` is present and outside `same-origin`/`none` | `403` |
| 2 | The body is not sent as `application/json` | `415` |
| 3 | A present `Origin` does not match the request's `Host` | `403` |
| 4 | The body is not exactly `{"session":"<id>","enabled":boolean}` within 4096 bytes | `400` |

A malformed session id or an extra key changes nothing.

## Error taxonomy

| Status | When |
| --- | --- |
| `405` | A non-GET request on a cost route (the gate route accepts `GET` and `POST`). |
| `400` | An unknown query parameter, scope or detail; an invalid `force`; a missing or malformed session; a gate body that is malformed, has an extra key, carries a malformed session id, or exceeds 4096 bytes. |
| `404` | An unknown session. |
| `403` | A cross-site fetch; a gate request whose `sec-fetch-site` is outside `same-origin`/`none`; a gate `POST` whose `Origin` does not match the request's `Host`. |
| `415` | A gate `POST` whose body is not `application/json`. |
| `503` | A read that outlives its 8-second budget. |

Error bodies are JSON objects with `ok: false`, a `code` and a `message`; no
response ever carries a local path.

## See also

- [off-peak-gate.md](./off-peak-gate.md) — the gate's frozen interface, including
  the `GateView` fields this route serves.
- [verification-gate.md](./verification-gate.md) — claim-by-claim verification of
  the routes, their statuses and their ETags.
- [configuration.md](./configuration.md) — `defaultScope` and the gate's keys.
- [dsh-api-cost README](../README.md) — install, usage and the rate card.
