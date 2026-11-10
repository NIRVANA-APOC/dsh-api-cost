# Off-peak request gate — frozen design and interface contract

Status: **implemented and verified, v2.3.0 conversation-tree revision.** The v2.1.0
freeze held: `src/host/gate.ts` shipped the process-global interface then documented
in §4 unchanged, and the only additions after that freeze were the
`models: 'all' | 'priced'` narrowing and `isPricedModel()` in the pricing engine,
both additive and both at the registration site rather than inside the gate. The
v2.2.0 freeze held too: the switch became per-session without changing the hold
state machine, the durable file or the `/gate` wire.

**v2.3.0 changes the scope from one session to one session AND its delegation
subtree.** `GateView` is now schemaVersion 4 (`enabled` is the effective position,
`source` says whether it is `self`/`inherited`/`default`, `inheritedFrom` names the
ancestor, `ownHolding` is this session's own parked count and the counters are
subtree-scoped). §4 and §5 below are the current v2.3 contract. The v2.2.0
per-session-only contract is kept verbatim in **Appendix B** and the v2.1.0
process-global contract in **Appendix A** — both are historical record, not the
current contract.

Where the evidence lives:

| Evidence | Where |
| --- | --- |
| Deterministic hold/wire/tree claims A1–A26, B1–B5, E1–E3 | `test/gate.test.ts` |
| Real cordis + real `dsh-llm` waterfall, C1–C10 | `test/gate-integration.test.ts` |
| Claim → test → verdict table, defects, falsification runs, v2.2.0/v2.3.0 addenda | `docs/verification-gate.md` |
| Live acceptance in a real peak window (real plugin entry, real HTTP, real clock) | `.verify-home/acceptance.mts` (gitignored scratch) |

Two findings from the v2.1.0 verification changed this document's assumptions, and
both are recorded here because they are what makes the design correct rather than
merely plausible:

1. **The context filter passes.** `cordis`'s `Service.prototype[filter]` compares
   only the service's isolation label, so a plugin-level
   `ctx.on('llm/stream', …)` **is** selected inside `ctx.llm.stream()`. This was
   probed empirically before any gate code existed; it is not an assumption.
2. **`prepend: true` is `unshift`, so the last prepend runs outermost.** Our
   listener therefore wraps whatever registered before it, and a later listener
   still composes around ours. Both directions are asserted.

The v2.3.0 revision adds a third fact the design depends on: **delegation lineage is
in the session header.** `session/created` carries the `Session`, whose
`header.parentSession` is the durable delegation parent, and `ctx.sessions` /
`ctx.agents` can answer the same link synchronously for a session this plugin never
saw created. The gate therefore takes the tree as live runtime state (bounded,
never persisted) and keeps the durable file for explicit choices only.

## 1. Goal

A user-selectable switch that makes every DeepSeek model call **of one conversation
tree** happen inside an off-peak (谷时) billing window, so that tree is billed at
half price, **without the model ever observing a failure**. The tree is the session
the switch was flipped in plus the sessions it delegates to; an unrelated
conversation keeps its own switch.

Success criteria:

1. While a session's effective switch is on and the current tier is peak, no
   provider request issued by that session — or by any descendant session that
   follows it — is dispatched. The request is *parked*, not failed.
2. When the tier turns off-peak, every parked request is dispatched unchanged.
3. Nothing about the wait is visible to the model: no session event is appended,
   no error is reported, the request body is byte-identical to the un-gated one.
4. The switch is controllable from the cost capsule popup, is stored per session,
   and survives a restart. The delegation tree is rebuilt from live links (a
   `session/created` announcement, or a synchronous parent lookup), never from the
   durable file.
5. Turning a session's switch off, or aborting the run, releases that session's
   parked requests and those of the descendants that were only following it — and
   no other conversation's. A descendant with its own explicit choice keeps it
   (and its subtree keeps holding).
6. The gate can never break a model call: any internal failure fails **open**.
7. The scope is exactly one conversation tree. Enabling the switch in one
   conversation never parks an unrelated conversation's requests. The nearest
   explicit choice wins: a descendant switched by hand keeps its own position,
   otherwise it follows the nearest ancestor that was switched, otherwise the
   configured default.

## 2. Why `llm/stream` is the right seam

`@deepseek-ai/dsh-llm` exposes one interception point:

```ts
// dsh-llm/lib/types/index.d.ts
'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>;
// dsh-llm/lib/index.js
streamWithRegistration(options, prepared) {
  return this.ctx.waterfall(this, 'llm/stream', options, () => this.adapterStream(options, prepared));
}
```

Every model call in the composition reaches this waterfall: the agent loop
(`preparedCall?.stream(request) ?? ctx.llm.stream(request)`), the session-title
generator, and compaction, because `prepareCall()` also returns
`this.streamWithRegistration(...)`.

`ctx.waterfall` calls the outermost listener **synchronously** and takes its
return value as the stream. So the listener must be synchronous and return an
`AsyncIterable` — never a `Promise`.

The generator is lazy: `next()` returns an `AsyncIterable` whose body (adapter
`prepareCall`, HTTP dispatch) runs on the first `.next()`. Holding that first
`.next()` therefore holds the provider request itself, which is exactly the
semantics we want, and it costs nothing to hold:

```ts
ctx.on('llm/stream', (options, next) => gate.middleware(options, next), { prepend: true })
```

`prepend: true` makes the hold the outermost wrapper, so a downstream
middleware (retry, replay, routing) can never dispatch around it.

**Session identity** comes from the same `GenerateOptions` object the loop already
builds: `options.sessionId` is stamped by the agent loop for request routing and is
a branded string at runtime. The gate reads exactly that field — it never guesses a
session, never infers one from a provider or a model id, and a call without the
field is never gated.

**Tree identity** is a separate, live fact. `src/host/index.ts` registers exactly one
`session/created` listener and records each announced session's
`header.parentSession`; for a session announced before this plugin loaded, the gate
falls back to a synchronous `parentOf(sessionId)` resolver built on
`ctx.get('sessions')` (else `ctx.get('agents')`). A listener failure must never
veto creation (a synchronous `session/created` throw rolls the session back in
`dsh-session`), so the listener body is wrapped in its own `try/catch`.

## 3. Module map and write scopes

| Module | Owner | Responsibility |
| --- | --- | --- |
| `src/shared/contracts.ts` | Lead | `GateState`, `GateSource`, `GateView` (schemaVersion 4), `GateConfig`, `PluginConfig.gate` (frozen) |
| `src/host/gate.ts` | T1 | Tree-scoped gate state machine, live parent-link cache, hold scheduler, durable explicit-choice store, `llm/stream` middleware |
| `src/host/http.ts` | T2 | `GET`/`POST /dsh-api-cost/v2/gate`, session-keyed (wire unchanged in v2.3.0 except the v4 view body) |
| `src/client/transport.ts` | T2 | `gate(sessionId)` / `setGate(sessionId, enabled)` + schemaVersion-4 wire validation |
| `src/client/gate.ts`, `widgets.tsx`, `locale.ts`, `styles.ts`, `index.ts` | T3 | Session-keyed panel control with subtree copy and inheritance badge, pill state, dictionaries, CSS |
| `src/host/index.ts` | Lead | Wiring, config schema, `llm/stream` listener, the one `session/created` link listener, `parentOf` resolver |
| `test/gate*.test.ts` | T4 | Independent verification |

## 4. `src/host/gate.ts` — frozen interface (v4, conversation tree)

```ts
import type { GateConfig, GateSource, GateState, GateView } from '../shared/contracts.ts'
import type { PricingEngine } from '../pricing/index.ts'

export interface GateClock {
  now(): number
  /** Resolve `true` when the delay elapsed, `false` when `signal` aborted first. */
  sleep(milliseconds: number, signal?: AbortSignal | undefined): Promise<boolean>
}

export interface HoldOutcome { readonly released: boolean; readonly waitedMs: number }

export interface GateStore {
  /** The choice stored for exactly this session, or `undefined` when it has none / it is unreadable. */
  read(sessionId: string): boolean | undefined
  /** Persist this session's choice; `true` when the write is durable. Never throws. */
  write(sessionId: string, enabled: boolean): boolean
}

export interface OffPeakGate {
  /** This session's control surface. Pure read; never throws. */
  readonly view: (sessionId: string) => GateView
  /** The only mutation; it touches exactly one session. Never rejects; persistence failure is reported, not thrown. */
  readonly setEnabled: (sessionId: string, enabled: boolean) => Promise<GateView>
  /** Hold this session's dispatch until the tier is off-peak. Resolves as soon as dispatch may proceed. Never rejects. */
  readonly wait: (sessionId: string, signal?: AbortSignal | undefined) => Promise<HoldOutcome>
  /**
   * Record the delegation link this session was announced with (`session/created`).
   * Links are live runtime state, not durable state: the durable file keeps only
   * explicit per-session choices. Never throws.
   */
  readonly observeSession: (sessionId: string, parentSession: string | undefined) => void
  /**
   * The `llm/stream` middleware. SYNCHRONOUS: returns an `AsyncIterable`, never a Promise.
   * When the gate does not apply to `options.sessionId` it must return `next()` — the very same object.
   */
  readonly middleware: <T>(options: { readonly signal?: AbortSignal | undefined; readonly sessionId?: string | undefined }, next: () => AsyncIterable<T>) => AsyncIterable<T>
  readonly dispose: () => void
}

export interface CreateGateOptions {
  readonly engine: PricingEngine
  readonly config?: GateConfig | undefined
  readonly clock?: GateClock | undefined
  readonly store?: GateStore | undefined
  /**
   * Synchronous live fallback for a parent link we have not been told about. Used
   * for a session that was never announced (e.g. one that existed before this
   * plugin loaded); a throwing or unknown resolver means "root".
   */
  readonly parentOf?: ((sessionId: string) => string | undefined) | undefined
  /** Called after every observable change, so a transport can publish it. */
  readonly onChange?: (() => void) | undefined
}

export function createOffPeakGate(options: CreateGateOptions): OffPeakGate
/** The default durable store: `<dsh home>/state/dsh-api-cost/gate.json`. */
export function defaultGateStore(path?: string | undefined): GateStore
```

### 4.1 Decision resolution (nearest explicit choice wins)

```
decide(session):
  seen = {}
  cursor = session
  for depth in 0..64:
    if cursor is null or already in seen: break        // unknown parent = root; cycle = root
    seen.add(cursor)
    record = ensure(cursor)                             // its OWN explicit choice, or the default
    if record.explicit:
      if cursor == session: return { enabled: record.enabled, source: 'self',         inheritedFrom: null }
      else:                 return { enabled: record.enabled, source: 'inherited',    inheritedFrom: cursor }
    cursor = parent(cursor)                             // cached link, else parentOf(), else null
  return { enabled: config.gate.enabled === true, source: 'default', inheritedFrom: null }
```

* An explicit choice is one stored in the durable file (read on first touch) or
  written by `setEnabled` in this process.
* `inheritedFrom` is the **nearest explicit ancestor**, not necessarily the direct
  parent; it is non-null exactly when `source === 'inherited'` and null otherwise.
* The walk is cycle-safe (`seen`) and depth-bounded (`MAX_ANCESTRY = 64`), so a
  malformed tree can never spin a model call.
* Parent links live in two bounded maps: `parents: Map<string, string | null>` (cap
  `MAX_PARENT_LINKS = 4096`, LRU order; `null` means "known root") and
  `children: Map<parent, Set<child>>` (the reverse index every subtree walk uses).
  They are **never persisted**. A link is learned from `observeSession` first and
  from the synchronous `parentOf` resolver second; an announcement always wins over
  a resolver guess. A self-link is a root.
* `parentOf` is called synchronously and defensively: a throw, a non-string or an
  empty string means "root", and a throwing resolver is not cached.

### 4.2 Hold algorithm (one holder, one session)

```
middleware(options, next):
  session = options.sessionId                     // branded string, may be absent
  if session is absent / not a non-empty string -> return next()   // never gated
  if decide(session).enabled === false          -> return next()
  if tier is off-peak or tier.next is unusable  -> return next()
  return a wrapper whose first pull waits, then dispatches next()

wait(session, signal):
  loop:
    if the effective choice is disabled, the clock is unreadable, or the gate is disposed
                                                      -> released (no wait)
    tier = engine.status(clock.now())
    if (!tier.peak)                                   -> released (no wait)
    if (tier.next is null or next.peak)               -> released   // defensive fail-open: never hang
    releaseAt = tier.next.at
    if (releaseAt <= now)                             -> released   // engine and clock disagree: never spin
    register holder(session, releaseAt)
    woke = await clock.sleep(min(releaseAt - now, 2^31-1), signal)
    unregister holder
    if (caller aborted)                               -> released = false, return
    continue loop                                     // re-classify: suspend / clock jump / early timer
```

The re-classification loop is mandatory: a laptop suspend can delay a timer past
the boundary, and a `setTimeout` longer than `2^31-1` ms must be clamped and
re-armed rather than fetched early.

A holder is registered on the **session record it was decided for** (the
descendant's own record), so its counters are that session's own; a view aggregates
them over the tracked subtree (§4.5).

### 4.3 Middleware algorithm

```ts
middleware(options, next) {
  // A session-less or malformed call is never gated, and this branch is synchronous.
  if (options?.sessionId is not a non-empty string) return next()
  if (!decide(options.sessionId).enabled) return next()
  const status = this.engine.status(this.clock.now())
  if (!status.peak || status.next is unusable) return next()
  const controller = new AbortController()                     // consumer-return channel
  const signal = options.signal === undefined ? controller.signal
                                              : AbortSignal.any([options.signal, controller.signal])
  const gate = this
  const iterator = (async function* () {
    await gate.wait(options.sessionId, signal)                  // never throws
    if (controller.signal.aborted) return                       // consumer went away: send nothing
    yield* next()                                               // caller abort is normalized by the framework
  })()
  return {
    [Symbol.asyncIterator]() {
      return {
        next: (value?: unknown) => iterator.next(value),
        return: (value?: unknown) => { controller.abort(); return iterator.return(value) },
        throw: (error?: unknown) => { controller.abort(); return iterator.throw(error) },
      }
    },
  }
}
```

Why the explicit iterable instead of returning the generator directly: a
`for await` loop that exits early calls `return()` on the iterator, and the gate
must learn about that **immediately**. A plain generator parked at `await` cannot
observe a queued `return()` until the await settles, which would leave a parked
request that dispatches at the boundary for nobody. `return()` aborting our own
controller closes that hole; the `controller.signal.aborted` check after the wait
is what makes it effective.

On a **caller** signal abort we deliberately still `yield* next()`: the framework
turns an already-aborted dispatch into the canonical terminal
`{ type: 'finish', reason: { kind: 'aborted', failure } }` chunk, and inventing
our own terminal chunk would duplicate adapter-failure normalization.

### 4.4 Release semantics (`setEnabled`)

`setEnabled(S, enabled)` writes S's **explicit** choice through the same store and
durability rules as before; the answer's `source` is therefore always `'self'`
(unless the call was invalid, in which case nothing changes). Turning a switch
**on** releases nothing. Turning it **off** is a release order for exactly the
requests this change un-gates:

```
releaseInheriting(root):
  stack = [root]; seen = {}
  while stack not empty:
    current = pop
    release every parked holder of `current`            // S's own holders always
    for child of trackedChildren(current):
      if child has an explicit choice of its own: continue   // self wins; its whole subtree keeps holding
      push child                                          // its position came from S, so it was un-gated
```

* An **explicitly ON** descendant is never released by an ancestor's switch, and
  neither is anything below it: the descendant's own choice governs its subtree.
  It stays parked and stays counted in the ancestor's subtree counters.
* Descendants with no explicit choice are released (and would already dispatch
  immediately if they parked again, because they now resolve to the ancestor's OFF).
* Requests in unrelated conversations are untouched. `dispose()` still releases
  every parked request in every tree.

### 4.5 View aggregation (`GateView` v4)

For `view(S)`:

| Field | Value |
| --- | --- |
| `enabled`, `source`, `inheritedFrom` | the effective decision from §4.1 |
| `state` | `off` if not effectively enabled, else `holding` at peak / `open` off-peak |
| `ownHolding` | holders registered by S itself |
| `holding`, `since`, `releaseAt`, `heldTotal`, `delayedMs` | aggregate over S's **tracked subtree** (S + every tracked descendant, cycle-safe) |
| `otherHolding` | `totalHolding − holding`: requests parked **outside** this subtree |
| `changedAt`, `durable` | S's **own** explicit choice only: `null` / `false` when the position is inherited or the default |
| `peak`, `reason`, `next`, `now` | the pricing engine, exactly as before |

The subtree counters are structural, not decision-based: a parent's view aggregates
a child's parked requests even when the child has its own explicit ON (the parent's
panel can then say "part of my tree is waiting"). `ownHolding <= holding` always.

### 4.6 Fail-open policy (non-negotiable)

* `middleware` must be synchronous and must return `next()` unchanged whenever it
  does not hold. An exception thrown here would break the model call.
* A call whose `options.sessionId` is absent, not a string, or empty is never
  gated: `middleware` returns the very object `next()` produced.
* A session whose **effective** position is disabled is never gated, and enabling
  one tree can never park an unrelated tree's calls; disabling a tree can never
  release an unrelated tree's holders.
* Any error inside the hold (a pricing throw, a clock throw, a timer failure) is
  caught, recorded, and treated as "release now". The gate exists to save money,
  never to break a session.
* A broken or missing parent source is a root, never an exception: `observeSession`
  never throws, `parentOf` is wrapped, unknown ids are roots, and a cycle is
  walked once.
* The `session/created` listener body is wrapped in `try/catch`: a synchronous
  throw there would veto and roll back session creation in `dsh-session`.
* `wait()` resolves; it never rejects.
* `view()` is a pure read and never throws. An unusable session id renders an
  inert `off`/`default` view rather than throwing (the HTTP surface rejects such
  ids first).
* The default store never throws: an unwritable path reports `durable: false` and
  the feature keeps working in memory.

### 4.7 Durable per-session store (unchanged from v2.2.0)

* Path: `config.path`, else `$DSH_API_COST_GATE_FILE`, else
  `<dsh home>/state/dsh-api-cost/gate.json` where the home is
  `$DSH_HOME` (trimmed, blank ignored) else `<os homedir>/.dsh`.
* File shape (version 2):

  ```json
  {"version": 2, "sessions": {"<session-id>": {"enabled": true, "changedAt": 1735689600000}}}
  ```

  It stores **explicit choices only**. Parent links are never written: the tree is
  live runtime state, so a fresh process reconstructs inheritance from
  `session/created` events (and the `parentOf` fallback) as it observes sessions.
* A **version-1 file is ignored**. It held one process-global flag, which cannot be
  attributed to a session; guessing would park the wrong conversation. The first
  write replaces it with a version-2 document.
* At most **512 stored sessions**. When a write would exceed the bound, the entry
  with the oldest `changedAt` is evicted first (on a tie, the earliest inserted goes).
* Atomic write: write a sibling `*.tmp` then rename; create parent directories.
* Any read or write failure is swallowed — the feature stays usable in memory and
  that session's own `GateView.durable` reports `false`. Never throw into the
  plugin's lifetime.
* A session with **no stored choice of its own** reports `changedAt: null,
  durable: false` and follows the nearest explicit ancestor, else
  `config.gate.enabled` (default `false`).
* A session whose own choice is stored (read back or written durably) reports
  `durable: true`; a session that was switched by hand reports a non-null
  `changedAt` (the stored instant when the store remembers it, else the instant the
  process first observed the choice).
* `config.persist === false` disables storage entirely (`durable: true` is then a
  lie, so report `durable: false`).
* `GateStore` is the seam and only requires `read`/`write`. The bundled store also
  answers `readChangedAt(sessionId)`; the gate uses it when present to restore an
  exact `changedAt`, and falls back gracefully for a store that does not.

### 4.8 In-memory state budget

Both runtime maps are bounded, because a long-lived process must not keep one
record per conversation (or per delegation link) it has ever seen:

* At most **1024 session records** exist at any time. A record is created on a
  session's first touch (view, switch, hold, or an ancestor walk).
* When the session bound is exceeded, records are evicted **with no holders**
  first, and the least recently touched goes first. Within that set, a session with
  no stored choice of its own is evicted before a session that has one — dropping
  an inherited record is invisible, while dropping an explicit choice would
  silently undo the user's switch.
* A record with parked holders is **never** evicted.
* An evicted inherited record is rebuilt from the live links and the configured
  default on the next touch; an evicted explicit choice is re-read from the durable
  store when there is one. Only the display counters of an evicted inactive record
  are lost.
* At most **4096 parent links** are cached. A link evicted by the LRU bound is
  re-resolved by `parentOf` (or a later `session/created`) on the next touch; until
  then the session is treated as a root. An evicted link loses nothing durable.

### 4.9 `GateView` revision

`revision` must change if and only if a field that a client renders changes:
`sessionId`, effective `enabled`, `source`, `inheritedFrom`, `state`, `holding`,
`ownHolding`, `otherHolding`, `releaseAt`, `changedAt`, `heldTotal`, or the pricing
`revision`. Build it as a short deterministic string (the repository already uses
an FNV-style fold in `src/pricing/index.ts`); do not hash the clock. `now`, `since`
and `delayedMs` are allowed to change without changing `revision` — they are
display-only and must never be part of an ETag. Folding `sessionId` in is what
gives two sessions two different ETags even when their rendered counters are
identical.

## 5. `src/host/http.ts` — frozen routes (v4, conversation tree)

| Route | Method | Behaviour |
| --- | --- | --- |
| `/dsh-api-cost/v2/gate?session=<id>` | `GET` | `200` that session's `GateView` (v4), `ETag` = `"<revision>"`, matching `If-None-Match` → `304` |
| `/dsh-api-cost/v2/gate` | `POST` | Body `{"session":<id>,"enabled":boolean}` → `200` that session's `GateView` (v4) |

The v2.3.0 revision does not change the wire at all: the request shape, guard order
and method surface are exactly the v2.2.0 contract; only the serialized view grows
the v4 fields. The gate scope is a property of the named session — a `POST` still
names exactly one session and flips only that session's explicit choice; the
inheritance that follows is computed by the gate and visible through each
session's own read.

The existing `guarded` wrapper is GET-only and keeps that behaviour for `/view`
and `/pricing`. The gate owns both methods on one path; do **not** relax the read
rule.

**Read validation** (in this order):

1. `sec-fetch-site` must be absent, `same-origin`, or `none`; `cross-site` → `403 CROSS_SITE`.
2. Only the `session` query key is allowed, exactly once → otherwise
   `400 INVALID_PARAMETER`.
3. The session id must pass the shared `validateSessionId` rule (same regex as
   every other cost surface) → missing/invalid is `400 INVALID_SESSION`.

**Mutation guard**, all of which must be enforced before the body is read:

1. `req.method === 'POST'`, else `405` with `Allow: GET, POST`.
2. `req.headers['sec-fetch-site']` must be absent, `same-origin`, or `none`.
   `cross-site` → `403 CROSS_SITE`. (The browser sends `same-origin` for the
   panel's own `fetch`.)
3. `content-type` must be exactly `application/json` (parameters allowed) →
   otherwise `415 INVALID_CONTENT_TYPE`.
4. When an `Origin` header is present it must match `http://<host>` /
   `https://<host>` from `req.headers.host`, else `403 CROSS_SITE`.
5. Body must be a JSON object with exactly two keys, `session: string` and
   `enabled: boolean`, at most 4096 bytes → otherwise `400 INVALID_BODY`.
6. A `session` that fails `validateSessionId` → `400 INVALID_SESSION`.
7. Any other method (`PUT`, `DELETE`, `PATCH`) → `405` with `Allow: GET, POST`.

`setEnabled` never rejects, so the route has no failure path beyond validation.
The response is always the named session's view. Responses must not contain a local
path.

## 6. `src/client` — frozen additions (v4, conversation tree)

* `CostTransport.gate(sessionId, signal): Promise<GateView>` and
  `CostTransport.setGate(sessionId, enabled, signal): Promise<GateView>`, both
  validating through one shared `validGateView` predicate in `transport.ts`
  (schemaVersion 4; non-empty `sessionId`; booleans; `state`/`source` enums where an
  `inherited` source requires a non-empty `inheritedFrom` and a `self`/`default`
  source requires `inheritedFrom: null`; `ownHolding <= holding`; non-negative
  counters; nullable timestamps) and refusing a response whose `sessionId` differs
  from the one requested.
* `GateStore` (`src/client/gate.ts`) is **session-keyed**, one entry per subscribed
  session, modelled on `CostStore` but with the gate's existing timer cadence:
  * `snapshot(sessionId)` / `subscribe(sessionId, listener)` for
    `useSyncExternalStore`;
  * fetches on first subscriber, re-arms a timer at the earlier of
    `GateView.next.at` and `releaseAt` (clamped to `2^31-1`, never armed for a
    past instant);
  * polls every 2 s while that session's `state === 'holding'` and `holding > 0`,
    and every 15 s while `state === 'holding'` and `holding === 0`;
  * pauses while the document is hidden, resumes on `visibilitychange`;
  * drops an entry (abort flight, clear timers) when its last listener leaves;
  * `setEnabled(sessionId, enabled)` is optimistic-free: it awaits the server
    value and publishes it, so the switch never shows a state the host did not
    accept. A write supersedes only that session's pending reads; a failed read
    keeps the last confirmed view and never invents state.
* Panel: one per-session switch (`<button role="switch" aria-checked>`), explicit
  subtree scope copy (this switch affects this session and its delegated child
  sessions; unrelated conversations have their own switches), the state word
  已开启/已关闭, an inheritance badge/line when `source === 'inherited'` (the
  position follows a parent; flipping here makes it this session's own choice and
  affects only this session's subtree), a `默认` marker when `source === 'default'`,
  the subtree parked count and release countdown while holding (with a child-session
  note when `holding > ownHolding`), and `otherHolding` surfaced as "other
  conversations are also waiting". `changedAt === null` means the session has no
  explicit choice of its own.
* Pill: while the session is effectively holding (including an inherited ON) it
  adds the words 等待谷时 (never colour alone) and the subtree count.

## 7. Out of scope

* Splitting a call that starts off-peak and settles in peak. The settlement
  instant decides the rate, and it cannot be known before dispatch.
* Any provider, adapter, or composition change. The gate is one waterfall
  listener, one `session/created` link listener and their surface.
* Blocking non-model work (tools, filesystem, jobs) — only model requests wait.
* A single "switch every session" control. A switch governs one conversation tree;
  an unrelated conversation — or a descendant switched by hand — keeps its own
  position, and no switch on the team/fleet level exists.

## 8. Known limitations to state in the README

1. A hold can span hours (a weekday window is up to 4 h). The session is idle but
   alive; the user-visible run keeps its spinner.
2. A queued request is held at the request boundary; a call already in flight
   when peak begins is unaffected.
3. A consumer that abandons a stream without aborting its signal is released by
   the explicit-`return()` channel above, which is what the agent loop does.
4. The gate's runtime state is per process; the durable file (explicit choices) is
   the only thing shared. Two separate DSH processes each hold their own tree and
   last write wins per session id; the switch is not synchronized across processes.
5. Delegation links are **not durable**. In a fresh process the tree is rebuilt as
   sessions are announced or looked up; a session the plugin has not observed yet
   is treated as a root (and follows only its own/default choice). Switching a
   parent therefore cannot park a child that already existed before the plugin
   loaded until that link is observable.
6. A delegated subagent **inherits** its nearest explicitly-switched ancestor; it
   keeps following that ancestor until it is switched itself, after which its own
   choice governs its subtree.
7. In-memory state is bounded (1024 sessions, 4096 parent links). Under extreme
   pressure an inactive session or link can be evicted; an explicit choice comes
   back from the durable store and a link from the live resolver, but display
   counters and un-announced links can be lost until re-learned.
8. Durable state is bounded (512 sessions). A 513th stored session evicts the one
   with the oldest `changedAt`, so a very long-lived machine keeps the most
   recently switched sessions only.

---

## Appendix A — v2.1.0 process-global contract (historical, superseded)

Kept verbatim as the record of what shipped in v2.1.0. **It is not the current
contract:** §4 and §5 above supersede it, `GateView` is no longer schemaVersion 2,
and no route or client method is still allowed to assume a process-wide flag.

### A.1 v2.1.0 `src/host/gate.ts` interface

```ts
export interface GateStore {
  /** The stored flag, or `undefined` when nothing has been stored / it is unreadable. */
  read(): boolean | undefined
  /** Persist `enabled`; `true` when the write is durable. Never throws. */
  write(enabled: boolean): boolean
}

export interface OffPeakGate {
  /** Current value. Pure read; never throws. */
  readonly view: () => GateView
  /** The only mutation. Never rejects; persistence failure is reported, not thrown. */
  readonly setEnabled: (enabled: boolean) => Promise<GateView>
  /** Hold until the tier is off-peak. Resolves as soon as dispatch may proceed. Never rejects. */
  readonly wait: (signal?: AbortSignal | undefined) => Promise<HoldOutcome>
  /**
   * The `llm/stream` middleware. SYNCHRONOUS: returns an `AsyncIterable`, never a Promise.
   * When the gate does not apply it must return `next()` — the very same object.
   */
  readonly middleware: <T>(options: { readonly signal?: AbortSignal | undefined }, next: () => AsyncIterable<T>) => AsyncIterable<T>
  readonly dispose: () => void
}
```

### A.2 v2.1.0 behaviour

* One flag for the whole process: `enabled` was read once at construction from the
  durable store (file version 1, `{"version":1,"enabled":boolean,"changedAt":number}`)
  or from `config.gate.enabled`; `GateView.schemaVersion` was `2` and `changedAt`
  was always a number.
* `holding`/`since`/`releaseAt`/`heldTotal`/`delayedMs` counted every parked
  request in the process; there was no `sessionId` and no `otherHolding`.
* `revision` folded `enabled`, `state`, `holding`, `releaseAt`, `changedAt`,
  `heldTotal` and the pricing revision — not a session id.
* `GET /dsh-api-cost/v2/gate` returned the one view; `POST` carried
  `{"enabled":boolean}` and flipped the process-wide flag.
* The client `gate()`/`setGate(enabled, …)` and a single-entry `GateStore` matched
  that process-wide contract.
* Known limitation then: "the gate is per process: it is not shared across
  separate DSH processes", and it also parked *every* conversation, which the
  v2.2.0 revision fixes.

---

## Appendix B — v2.2.0 per-session-only contract (historical, superseded)

Kept as the record of what shipped in v2.2.0. **It is not the current contract:**
§4–§6 above supersede it. Where this appendix says "session", v2.3.0 says
"conversation tree"; where it says "the session's own choice", v2.3.0 resolves the
nearest explicit choice over the live delegation links.

### B.1 v2.2.0 interface difference from v2.3.0

* `GateView` was **schemaVersion 3** and had no `source`, `inheritedFrom` or
  `ownHolding`. `enabled` was that session's own stored choice, else
  `config.gate.enabled`; `changedAt`/`durable` described the same single flag.
* `holding`, `since`, `releaseAt`, `heldTotal` and `delayedMs` counted **only that
  session's** parked requests. `otherHolding` counted every parked request in every
  *other* session (there was no concept of a subtree).
* `OffPeakGate` had no `observeSession`, and `CreateGateOptions` had no `parentOf`;
  no `session/created` listener was registered, and `apply()` registered exactly
  one listener (`llm/stream`, prepended).
* `GateStore`, the version-2 durable file and the `/gate` wire were already
  session-keyed and are **unchanged** by v2.3.0 (except that the v4 view body now
  carries the tree fields). Parent links never had durable state and still do not.
* The v2.2.0 decision rule was `stored | config.gate.enabled` per session, with no
  ancestor walk; a delegated subagent was an independent session: it did **not**
  inherit its parent's switch and carried `config.gate.enabled` until it was
  switched itself.
* `setEnabled(S, false)` released only S's own holders; it could not affect a
  descendant because nothing inherited.

### B.2 Covered by the v2.2.0 verification

`docs/verification-gate.md` §6 records the v2.2.0 claim suite (A1–A19, B1–B5,
E1–E3, C1–C8) and the historical clauses the v2.3.0 revision supersedes. The
v2.3.0 claims are A20–A26 and C9–C10 (`docs/verification-gate.md` §7).
