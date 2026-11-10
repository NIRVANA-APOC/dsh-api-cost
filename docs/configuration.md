# Configuration

Reference for every key the plugin reads from the profile patch: scope, tool and
command toggles, the holiday calendar override, and the Avoid-peak gate settings.
The gate's behaviour is documented in [off-peak-gate.md](./off-peak-gate.md) and
its routes in [http-api.md](./http-api.md).

## Profile patch

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

## Keys

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultScope` | `auto` | Scope used when a surface does not name one: `auto`, `self`, `tree` or `team`. |
| `tool` | `true` | Register the `session_cost` tool. |
| `command` | `true` | Register the `/cost` command. |
| `holidays` | the bundled Chinese calendar | Per-year extension or correction of the holiday calendar. |
| `gate.enabled` | `false` | Default switch position for a session that was never switched by hand. |
| `gate.persist` | `true` | Keep every session's manual choice across restarts. |
| `gate.path` | `~` | Override the `<dsh home>/state/dsh-api-cost/gate.json` path. |
| `gate.models` | `all` | `all` holds every model request; `priced` narrows the gate to ids the published card prices. |

## `defaultScope`

| Scope | Meaning |
| --- | --- |
| `auto` (default) | The verified team when the session is a team member, otherwise its delegation tree. |
| `self` | This session only. |
| `tree` | This session plus every durable subagent descendant. |
| `team` | The whole team: lead, members and their descendants. Refused when membership cannot be verified. |

An explicit scope — the `/cost` command's scope argument, a tool call, or the
`scope` query parameter on the cost view — overrides the configured default for
that one request.

## `tool` and `command`

- `tool: true` registers `session_cost`, which lets the assistant read a session's
  estimate; it defaults to the calling session.
- `command: true` registers `/cost [sessionId] [auto|self|tree|team]`, which prints
  the same summary the pill shows, including coverage warnings.

## `holidays`

- The map is keyed by year. `holidays` lists dates (`'2027-01-01'`) or inclusive
  `['start', 'end']` ranges; `makeupWorkdays` lists the 调休 makeup days. The map
  extends or corrects the bundled Chinese calendar.
- Peak windows are Monday–Friday 09:00–12:00 and 14:00–18:00 Beijing time,
  excluding statutory holidays; nights, weekends, holidays and 调休 makeup days
  are off-peak.
- Changing `holidays` changes the projection's fold identity, so stale checkpoints
  are discarded and rebuilt instead of being mixed with new money.
- Years missing from the holiday table resolve **off-peak** and are reported as
  `holiday-data-missing`.

## `gate.enabled` — the default, not the authority

`gate.enabled` is only a **default**: once a session's panel has stored a manual
choice, that choice — and the subtree under it — follows it on every later start,
because the user's choice is the authority, not the profile file; a descendant
that stored its own choice overrides it for its own subtree. A conversation tree
that has never been switched keeps inheriting the default.

Only manual choices are persisted (per session id); parent links are reconstructed
from live sessions at startup. A version-1 state file from the process-global
design is ignored rather than guessed at, so after upgrading every tree starts
from the configured default.

## `gate.persist` and `gate.path`

- `persist: true` (the default) keeps every session's position across restarts;
  `false` keeps the positions in memory only.
- The durable file defaults to `<dsh home>/state/dsh-api-cost/gate.json`, and
  `path` overrides it.
- The file holds only the manual per-session choices, written atomically. Its
  bounds and its failure behaviour are in [limitations.md](./limitations.md).

## `gate.models`

`gate.models: priced` narrows the gate to ids the published card actually prices.
The default, `all`, holds every model request of a gated conversation tree — a
subscription-backed or third-party route has no peak column to save on, so on a
composition that mixes them, `priced` avoids delaying calls that gain nothing.

## See also

- [off-peak-gate.md](./off-peak-gate.md) — the gate's frozen interface and the
  reasoning behind each clause.
- [http-api.md](./http-api.md) — the routes that expose the view and the switch.
- [migration-1x.md](./migration-1x.md) — the gate changes and state-file versions
  between 2.1, 2.2 and 2.3.
- [limitations.md](./limitations.md) — the estimate's boundaries and the gate's
  durable-state bounds.
- [dsh-api-cost README](../README.md) — install, usage and the rate card.
