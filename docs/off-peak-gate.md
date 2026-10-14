# Off-peak request gate — frozen design and interface contract

Status: **implemented and verified.** The freeze held: `src/host/gate.ts` shipped the
interface in §4 unchanged, and the only additions after the freeze were the
`models: 'all' | 'priced'` narrowing and `isPricedModel()` in the pricing engine,
both additive and both at the registration site rather than inside the gate.

Where the evidence lives:

| Evidence | Where |
| --- | --- |
| Deterministic hold/wire claims A1–A14, B1–B5, E1–E3 | `test/gate.test.ts` |
| Real cordis + real `dsh-llm` waterfall, C1–C7 | `test/gate-integration.test.ts` |
| Claim → test → verdict table, defects, falsification runs | `docs/verification-gate.md` |
| Live acceptance in a real peak window (real plugin entry, real HTTP, real clock) | `.verify-home/acceptance.mts` (gitignored scratch) |

Two findings from verification changed this document's assumptions, and both are
recorded here because they are what makes the design correct rather than merely
plausible:

1. **The context filter passes.** `cordis`'s `Service.prototype[filter]` compares
   only the service's isolation label, so a plugin-level
   `ctx.on('llm/stream', …)` **is** selected inside `ctx.llm.stream()`. This was
   probed empirically before any gate code existed; it is not an assumption.
2. **`prepend: true` is `unshift`, so the last prepend runs outermost.** Our
   listener therefore wraps whatever registered before it, and a later listener
   still composes around ours. Both directions are asserted.

## 1. Goal

A user-selectable switch that makes every DeepSeek model call happen inside an
off-peak (谷时) billing window, so the session is billed at half price, **without
the model ever observing a failure**.

Success criteria:

1. While the switch is on and the current tier is peak, no provider request is
   dispatched. The request is *parked*, not failed.
2. When the tier turns off-peak, every parked request is dispatched unchanged.
3. Nothing about the wait is visible to the model: no session event is appended,
   no error is reported, the request body is byte-identical to the un-gated one.
4. The switch is controllable from the cost capsule popup and survives a restart.
5. Turning the switch off, or aborting the run, releases parked requests at once.
6. The gate can never break a model call: any internal failure fails **open**.

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

## 3. Module map and write scopes

| Module | Owner | Responsibility |
| --- | --- | --- |
| `src/shared/contracts.ts` | Lead | `GateState`, `GateView`, `GateConfig`, `PluginConfig.gate` (already frozen) |
| `src/host/gate.ts` | T1 | Gate state machine, hold scheduler, durable flag, `llm/stream` middleware |
| `src/host/http.ts` | T2 | `GET`/`POST /dsh-api-cost/v2/gate` |
| `src/client/transport.ts` | T2 | `gate()` / `setGate()` + wire validation |
| `src/client/gate.ts`, `widgets.tsx`, `locale.ts`, `styles.ts`, `index.ts` | T3 | Panel control, pill state, dictionaries, CSS |
| `src/host/index.ts` | Lead | Wiring, config schema, listener registration |
| `test/gate*.test.ts` | T4 | Independent verification |

## 4. `src/host/gate.ts` — frozen interface

```ts
import type { GateConfig, GateView } from '../shared/contracts.ts'
import type { PricingEngine } from '../pricing/index.ts'

export interface GateClock {
  now(): number
  /** Resolve `true` when the delay elapsed, `false` when `signal` aborted first. */
  sleep(milliseconds: number, signal?: AbortSignal | undefined): Promise<boolean>
}

export interface HoldOutcome { readonly released: boolean; readonly waitedMs: number }

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

export interface CreateGateOptions {
  readonly engine: PricingEngine
  readonly config?: GateConfig | undefined
  readonly clock?: GateClock | undefined
  readonly store?: GateStore | undefined
  /** Called after every observable change, so a transport can publish it. */
  readonly onChange?: (() => void) | undefined
}

export function createOffPeakGate(options: CreateGateOptions): OffPeakGate
/** The default durable flag: `<dsh home>/state/dsh-api-cost/gate.json`. */
export function defaultGateStore(path?: string | undefined): GateStore
```

### 4.1 Hold algorithm (one holder)

```
loop:
  view = engine.status(clock.now())
  if (!enabled)        -> released (no wait)
  if (!view.peak)      -> released (no wait)
  if (view.next === null) -> released        // defensive fail-open: never hang
  releaseAt = view.next.at                    // next.peak === false here
  register holder(releaseAt)
  woke = await clock.sleep(releaseAt - clock.now(), signal)
  unregister holder
  if (signal aborted)  -> released = false, return
  continue loop                                // re-classify: sleep may have been cut short
                                               // by a suspend, or the clock moved on
```

The re-classification loop is mandatory: a laptop suspend can delay a timer past
the boundary, and a `setTimeout` longer than `2^31-1` ms must be clamped and
re-armed rather than fetched early.

### 4.2 Middleware algorithm

```ts
middleware(options, next) {
  if (!this.enabled) return next()
  const status = this.engine.status(this.clock.now())
  if (!status.peak || status.next === null) return next()
  const controller = new AbortController()                     // consumer-return channel
  const signal = options.signal === undefined ? controller.signal
                                              : AbortSignal.any([options.signal, controller.signal])
  const gate = this
  const iterator = (async function* () {
    await gate.wait(signal)                                    // never throws
    if (controller.signal.aborted) return                      // consumer went away: send nothing
    yield* next()                                              // caller abort is normalized by the framework
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

### 4.3 Fail-open policy (non-negotiable)

* `middleware` must be synchronous and must return `next()` unchanged whenever it
  does not hold. An exception thrown here would break the model call.
* Any error inside the hold (a pricing throw, a clock throw, a timer failure) is
  caught, recorded, and treated as "release now". The gate exists to save money,
  never to break a session.
* `wait()` resolves; it never rejects.
* `view()` is a pure read and never throws.

### 4.4 Durable flag

* Path: `config.path`, else `$DSH_API_COST_GATE_FILE`, else
  `<dsh home>/state/dsh-api-cost/gate.json` where the home is
  `$DSH_HOME` (trimmed, blank ignored) else `<os homedir>/.dsh`.
* File shape: `{ "version": 1, "enabled": boolean, "changedAt": number }`.
* Atomic write: write a sibling `*.tmp` then rename; create parent directories.
* Any read or write failure is swallowed — the feature stays usable in memory and
  `GateView.durable` reports `false`. Never throw into the plugin's lifetime.
* `config.persist === false` disables storage entirely (`durable: true` is then a
  lie, so report `durable: false`).

### 4.5 `GateView` revision

`revision` must change if and only if a field that a client renders changes:
`enabled`, `state`, `holding`, `releaseAt`, `changedAt`, `heldTotal`, or the
pricing `revision`. Build it as a short deterministic string (the repository
already uses an FNV-style fold in `src/pricing/index.ts`); do not hash the clock.
`now` and `delayedMs` are allowed to change without changing `revision` — they
are display-only and must never be part of an ETag.

## 5. `src/host/http.ts` — frozen routes

| Route | Method | Behaviour |
| --- | --- | --- |
| `/dsh-api-cost/v2/gate` | `GET` | `200` `GateView`, `ETag` = `"<revision>"`, `If-None-Match` → `304` |
| `/dsh-api-cost/v2/gate` | `POST` | Body `{"enabled":boolean}` → `200` `GateView` |

The existing `guarded` wrapper is GET-only and keeps that behaviour for `/view`
and `/pricing`. Add a sibling wrapper for the gate; do **not** relax the read rule.

Mutation guard, all of which must be enforced before the body is read:

1. `req.method === 'POST'`, else `405` with `Allow: POST`.
2. `req.headers['sec-fetch-site']` must be absent, `same-origin`, or `none`.
   `cross-site` → `403 CROSS_SITE`. (The browser sends `same-origin` for the
   panel's own `fetch`.)
3. `content-type` must be exactly `application/json` (parameters allowed) →
   otherwise `415 INVALID_CONTENT_TYPE`.
4. When an `Origin` header is present it must match `http://<host>` /
   `https://<host>` from `req.headers.host`, else `403 CROSS_SITE`.
5. Body must be a JSON object with exactly one key `enabled: boolean`, at most
   4096 bytes → otherwise `400 INVALID_BODY`.
6. Any other method (`PUT`, `DELETE`, `PATCH`) → `405` with `Allow: GET, POST`.

`setEnabled` never rejects, so the route has no failure path beyond validation.
Responses must not contain a local path.

## 6. `src/client` — frozen additions

* `CostTransport.gate(signal): Promise<GateView>` and
  `CostTransport.setGate(enabled, signal): Promise<GateView>`, both validating
  through one shared `validGateView` predicate in `transport.ts`.
* `GateStore` (new `src/client/gate.ts`), modelled on `PricingStore`:
  * `subscribe` / `snapshot` for `useSyncExternalStore`;
  * fetches on first subscriber, re-arms a timer at `GateView.next.at` (clamped to
    `2^31-1`) and at `releaseAt`;
  * polls every 2 s while `state === 'holding'` and the document is visible, and
    not otherwise;
  * pauses while the document is hidden, resumes on `visibilitychange`;
  * `setEnabled(enabled)` is optimistic-free: it awaits the server value and
    publishes it, so the button never shows a state the host did not accept.
* Panel: one control row below the period rows, before the footer.
  * A real `<button role="switch" aria-checked>` with the visible label
    「避开高峰」 / “Avoid peak”, plus the current state word.
  * While holding: the release countdown (reuse the local `Countdown`), the
    number of parked requests, and how long the current hold has lasted.
  * The button is disabled while a write is in flight.
  * The pill gains one more text segment while holding (never colour alone),
    e.g. `¥1.23 · 峰 · 等待谷时`.

## 7. Out of scope

* Splitting a call that starts off-peak and settles in peak. The settlement
  instant decides the rate, and it cannot be known before dispatch.
* Any provider, adapter, or composition change. The gate is one waterfall
  listener plus its surface.
* Blocking non-model work (tools, filesystem, jobs) — only model requests wait.

## 8. Known limitations to state in the README

1. A hold can span hours (a weekday window is up to 4 h). The session is idle but
   alive; the user-visible run keeps its spinner.
2. A queued request is held at the request boundary; a call already in flight
   when peak begins is unaffected.
3. A consumer that abandons a stream without aborting its signal is released by
   the explicit-`return()` channel above, which is what the agent loop does.
4. The gate is per process: it is not shared across separate DSH processes.
