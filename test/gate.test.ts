/**
 * dsh-api-cost — off-peak gate verification, unit and wire half (T4/v2.3, adversarial).
 *
 * Every test here drives the real `src/host/gate.ts` through the frozen
 * interface in docs/off-peak-gate.md §4, or the real `/gate` route through the
 * handler `src/host/http.ts` registered on a fake `webServer`. Nothing in this
 * file re-implements gate logic: where a double is needed it is a *clock*, a
 * *store*, or a *pricing status script*, never a second copy of the state
 * machine under test.
 *
 * Scope: since v2.2.0 the switch is stored per SESSION; since v2.3.0 its scope is
 * that session **and its delegation subtree** (`GateView` schemaVersion 4). Every
 * claim is expressed for an explicit session id (`S`/`T` below, or the `P`/`C`/`G`
 * tree); the claims that only make sense once sessions disagree are A15–A26.
 *
 * Timing is never real: `createClock` is a deterministic clock whose `sleep`
 * registers a deadline the test drains by hand, so a hold is observed at exact
 * instants and a hang is a failed assertion rather than a slow test. The
 * pricing engine is the real one wherever the claim is about billing; the two
 * engine doubles that exist do so to produce states the real card cannot
 * (a peak with no known boundary, a throw).
 *
 * The fixtures below are the *only* place an instant is chosen, and each is
 * `bj(...)` so the tests never read the real clock. 2026-09-30 is a Wednesday
 * inside the 09:00-12:00 window; 2026-10-08 is the next non-holiday Thursday
 * (2026-10-01..07 is the National Day holiday, which the engine reports as
 * off-peak, so it cannot be used as a second peak window).
 *
 * Run: <node> --test --test-isolation=none --test-concurrency=1 test/gate.test.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../src/host/index.ts'
import { createOffPeakGate, defaultGateStore } from '../src/host/gate.ts'
import { createPricingEngine, isPricedModel } from '../src/pricing/index.ts'
import { validGateView } from '../src/client/transport.ts'
import { API_PREFIX } from '../src/shared/contracts.ts'
import type { GateClock, GateStore, OffPeakGate } from '../src/host/gate.ts'
import type { PricingEngine } from '../src/pricing/index.ts'
import type { GateConfig, GateView, PluginConfig, PricingView } from '../src/shared/contracts.ts'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Two distinct sessions. The gate's scope is exactly one of these at a time. */
const S = 'session-a'
const T = 'session-b'

/**
 * The delegation tree the subtree claims are about: `P` delegates to `C`, which
 * delegates to `G`. `R` is an unrelated root conversation.
 */
const P = 'tree-parent'
const C = 'tree-child'
const G = 'tree-grand'
const R = 'tree-other'

/** Explicit Beijing wall-clock time; the tests never read the real clock. */
const bj = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  Date.UTC(year, month - 1, day, hour - 8, minute)

/** Wednesday 2026-09-30 10:00 +08:00 — inside the 09:00-12:00 window. */
const PEAK = bj(2026, 9, 30, 10)
/** The same day at 12:00, the instant the peak window ends. */
const BOUNDARY = bj(2026, 9, 30, 12)
/** The same day at 20:00 — outside both published windows. */
const OFF_PEAK = bj(2026, 9, 30, 20)
/** Thursday 2026-10-08 10:00 +08:00 — the next peak window after the holiday. */
const SECOND_PEAK = bj(2026, 10, 8, 10)
/** Thursday 2026-10-08 12:00 +08:00 — its boundary. */
const SECOND_BOUNDARY = bj(2026, 10, 8, 12)

/** `setTimeout`'s ceiling; a longer delay must be clamped and re-armed (§4.1). */
const MAX_TIMER = 2_147_483_647

const engine = createPricingEngine()
/** The real engine's own view of a peak instant, used as the base for doubles. */
const PEAK_VIEW = engine.status(PEAK)

/* ------------------------------------------------------------------ *
 * Doubles
 * ------------------------------------------------------------------ */

interface PendingSleep {
  readonly deadline: number
  readonly resolve: (released: boolean) => void
}

interface FakeClock extends GateClock {
  /** Every requested duration, in call order, so clamping is observable. */
  readonly asked: readonly number[]
  /** Move the clock without releasing anything (a fresh fixture instant). */
  set(instant: number): void
  /** Move the clock and release every sleep whose deadline has been reached. */
  advanceTo(instant: number): void
  /** Release the newest pending sleep as a timer that fired before its deadline. */
  fireEarly(): void
  readonly waiting: () => number
}

/**
 * A deterministic clock. `now()` never moves on its own, so "the request was
 * still parked" is a fact about the code under test and not about scheduling.
 */
function createClock(start: number): FakeClock {
  let instant = start
  const pending: PendingSleep[] = []
  const asked: number[] = []
  return {
    now: () => instant,
    sleep(milliseconds, signal) {
      asked.push(milliseconds)
      if (signal?.aborted === true) return Promise.resolve(false)
      return new Promise<boolean>((resolve) => {
        const entry: PendingSleep = { deadline: instant + Math.max(0, milliseconds), resolve }
        pending.push(entry)
        signal?.addEventListener('abort', () => {
          const index = pending.indexOf(entry)
          if (index === -1) return
          pending.splice(index, 1)
          resolve(false)
        }, { once: true })
      })
    },
    get asked() { return asked },
    set(next) { instant = next },
    advanceTo(next) {
      instant = next
      for (const entry of [...pending]) {
        if (entry.deadline > instant) continue
        pending.splice(pending.indexOf(entry), 1)
        entry.resolve(true)
      }
    },
    fireEarly() {
      const entry = pending.pop()
      entry?.resolve(true)
    },
    waiting: () => pending.length,
  }
}

interface MemoryWrite { readonly sessionId: string; readonly enabled: boolean }

interface MemoryStore extends GateStore {
  readonly writes: readonly MemoryWrite[]
  readonly values: Map<string, boolean>
  readChangedAt(sessionId: string): number | undefined
}

/**
 * The store double, keyed by SESSION. The gate tests never reach the real home
 * directory, so a choice written by one test can never enable the gate in the
 * next one — and a choice written for one session can never leak into another.
 */
function memoryStore(initial: Readonly<Record<string, boolean>> = {}): MemoryStore {
  const values = new Map<string, boolean>(Object.entries(initial))
  const writes: MemoryWrite[] = []
  return {
    read: (sessionId) => values.get(sessionId),
    write(sessionId, enabled) { values.set(sessionId, enabled); writes.push({ sessionId, enabled }); return true },
    readChangedAt: () => undefined,
    get writes() { return writes },
    get values() { return values },
  }
}

/** A pricing double whose only job is to answer `status` with a scripted view. */
function statusEngine(status: (now: number) => PricingView): PricingEngine {
  return {
    fingerprint: 'gate-verification-double',
    price() { throw new Error('the gate must never price a call') },
    status,
  }
}

/** A mutable script, so one test can turn the tier from peak to off-peak. */
function scriptedEngine(initial: PricingView): { engine: PricingEngine, script: { view: PricingView } } {
  const script = { view: initial }
  return { script, engine: statusEngine(() => script.view) }
}

type Chunk = Record<string, unknown>

/** A realistic adapter sequence: deltas, usage, one terminal finish. */
const SCRIPT: readonly Chunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hel' },
  { type: 'text-delta', index: 0, text: 'lo' },
  { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

interface ScriptedNext {
  readonly next: () => AsyncIterable<Chunk>
  /** Calls to `next()` itself: the delegation count the claims are about. */
  readonly delegations: () => number
  readonly pulls: () => number
  /** The clock instant the provider body actually started, or null. */
  readonly startedAt: () => number | null
}

/**
 * `next()` as the framework provides it: a lazy `AsyncIterable` whose body —
 * the adapter dispatch — runs on the first pull. `startedAt` therefore proves
 * *when* the provider request was really made, not when middleware was called.
 */
function scriptedNext(clock: FakeClock, script: readonly Chunk[] = SCRIPT): ScriptedNext {
  let delegations = 0
  let pulls = 0
  let started: number | null = null
  return {
    next() {
      delegations += 1
      return {
        [Symbol.asyncIterator]() {
          let index = 0
          return {
            async next() {
              if (index === 0 && started === null) started = clock.now()
              if (index >= script.length) return { done: true as const, value: undefined }
              const value = script[index] as Chunk
              index += 1
              pulls += 1
              return { done: false as const, value }
            },
            async return(value?: unknown) { return { done: true as const, value } },
          }
        },
      }
    },
    delegations: () => delegations,
    pulls: () => pulls,
    startedAt: () => started,
  }
}

/** Consume an iterable to completion, like the agent loop's `for await`. */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const value of iterable) out.push(value)
  return out
}

/** Let queued microtasks and one macrotask turn, without any real sleeping. */
const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

/**
 * A real deadline, used only to turn "it hung" into a failed assertion. The
 * fake clock never advances by itself, so a hold that can only end on a timer
 * would otherwise leave the test suite hanging forever.
 */
async function withDeadline<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${milliseconds}ms — the gate hung`)), milliseconds)
  })
  try { return await Promise.race([promise, deadline]) } finally { if (timer !== undefined) clearTimeout(timer) }
}

interface GateFixture {
  readonly clock: FakeClock
  readonly gate: OffPeakGate
  readonly store: MemoryStore
  /** One entry per `onChange` call, stamped with the gate's own instant. */
  readonly changes: number[]
}

function gateFixture(options: {
  at?: number
  engine?: PricingEngine
  clock?: GateClock
  config?: GateConfig
  store?: GateStore
  parentOf?: (sessionId: string) => string | undefined
} = {}): GateFixture {
  const clock = createClock(options.at ?? PEAK)
  const store = memoryStore()
  const changes: number[] = []
  const gate = createOffPeakGate({
    engine: options.engine ?? engine,
    config: options.config ?? {},
    clock: options.clock ?? clock,
    store: options.store ?? store,
    ...(options.parentOf === undefined ? {} : { parentOf: options.parentOf }),
    onChange: () => { changes.push(clock.now()) },
  })
  return { clock, gate, store, changes }
}

/** A gate whose configured default is ON: sessions with no stored choice inherit it. */
function enabledFixture(options: { at?: number, engine?: PricingEngine, clock?: GateClock, config?: Omit<GateConfig, 'enabled'> } = {}): GateFixture {
  return gateFixture({ ...options, config: { ...options.config, enabled: true } })
}

/**
 * The three decision fields a panel renders. Reading them through one helper is
 * what makes a precedence claim state the whole position, not just `enabled`.
 */
function position(view: GateView): { readonly enabled: boolean, readonly source: GateView['source'], readonly inheritedFrom: string | null } {
  return { enabled: view.enabled, source: view.source, inheritedFrom: view.inheritedFrom }
}

/* ------------------------------------------------------------------ *
 * A. Hold semantics (per session)
 * ------------------------------------------------------------------ */

test('A1 — at a peak instant the first pull is parked, then dispatched exactly once at the boundary', async () => {
  const h = enabledFixture()
  assert.equal(h.gate.view(S).peak, true, 'the fixture must start inside a peak window')
  assert.equal(h.gate.view(S).state, 'holding', 'enabled inside a peak window is the holding state')

  const script = scriptedNext(h.clock)
  const iterator = h.gate.middleware({ sessionId: S }, script.next)[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()
  assert.equal(h.clock.waiting(), 1, 'the hold must arm exactly one timer')
  assert.equal(script.delegations(), 0, 'next() must not be called while the tier is peak')
  assert.equal(script.pulls(), 0, 'nothing may be pulled from the provider while peak')
  assert.equal(script.startedAt(), null)

  h.clock.advanceTo(BOUNDARY)
  const first = await withDeadline(firstPull, 500, 'the parked first chunk')
  assert.equal(script.delegations(), 1, 'the boundary must delegate exactly once')
  assert.equal(script.startedAt(), BOUNDARY, 'the provider body must start at the boundary')
  assert.equal(first.done, false)
  assert.deepEqual(first.value, SCRIPT[0])

  const rest = await withDeadline(collect({ [Symbol.asyncIterator]: () => iterator }), 500, 'the rest of the gated stream')
  assert.deepEqual([first.value, ...rest], [...SCRIPT])
  assert.equal(script.delegations(), 1, 'consuming the rest must not delegate again')
  assert.equal(h.clock.waiting(), 0, 'no timer may be left armed after release')
  assert.equal(h.gate.view(S).holding, 0, 'the released request must leave the counter')
})

test('A2 — off-peak with the gate on, middleware returns the identical object next() produced', () => {
  const h = enabledFixture({ at: OFF_PEAK })
  assert.equal(h.gate.view(S).peak, false, 'the fixture must be off-peak')
  const produced = scriptedNext(h.clock).next()
  const returned = h.gate.middleware({ sessionId: S }, () => produced)
  assert.equal(returned, produced, 'the very same AsyncIterable must be returned, not a wrapper')
  assert.equal(h.clock.waiting(), 0, 'no timer may be armed off-peak')
})

test('A3 — at peak with this session\'s gate off, middleware returns the identical object next() produced', () => {
  const h = gateFixture({ at: PEAK, store: memoryStore({ [S]: false }) })
  assert.equal(h.gate.view(S).enabled, false, 'the fixture must have this session\'s gate off')
  assert.equal(h.gate.view(S).state, 'off')
  const produced = scriptedNext(h.clock).next()
  assert.equal(h.gate.middleware({ sessionId: S }, () => produced), produced)
  assert.equal(h.clock.waiting(), 0)
})

test('A4 — the gated chunk sequence is deepEqual to the ungated one, with nothing injected', async () => {
  // Baseline through the same `next()` script, with no gate in the way at all.
  const ungated = await collect(scriptedNext(createClock(PEAK)).next())

  const h = enabledFixture()
  const script = scriptedNext(h.clock)
  const iterator = h.gate.middleware({ sessionId: S }, script.next)[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()
  assert.equal(script.pulls(), 0, 'nothing may be pulled while peak')
  h.clock.advanceTo(BOUNDARY)
  // The first pull is awaited before the rest, so no chunk is dropped by two
  // concurrent next() calls on one iterator.
  const first = await withDeadline(firstPull, 500, 'the parked first chunk')
  assert.equal(first.done, false)
  const rest = await withDeadline(collect({ [Symbol.asyncIterator]: () => iterator }), 500, 'the gated stream')
  const emitted: Chunk[] = [first.value as Chunk, ...rest]

  assert.deepEqual(emitted, ungated, 'the consumer must see exactly the ungated chunk sequence')
  assert.deepEqual(emitted, [...SCRIPT], 'and exactly the scripted sequence, so the comparison is not vacuous')
  assert.equal(emitted.length, SCRIPT.length, 'no extra chunk may be appended')
  const types = emitted.map((chunk) => chunk['type'])
  assert.equal(types.filter((type) => type === 'finish').length, 1, 'exactly one terminal finish')
  assert.ok(!types.includes('error'), 'the gate must never synthesize an error chunk')
  assert.ok(!types.includes('aborted'), 'the gate must never synthesize an aborted chunk')
  assert.deepEqual(Object.keys(emitted[0] as object).sort(), Object.keys(SCRIPT[0] as object).sort(), 'the first chunk must not be rewritten')
})

test('A5 — a caller abort during the hold settles promptly, leaves no timer, and delegates exactly once', async () => {
  const h = enabledFixture()
  const controller = new AbortController()
  const script = scriptedNext(h.clock)
  const iterator = h.gate.middleware({ sessionId: S, signal: controller.signal }, script.next)[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()
  assert.equal(h.clock.waiting(), 1, 'the request must be parked before the abort')

  controller.abort()
  const first = await withDeadline(firstPull, 500, 'the aborted hold')
  assert.equal(script.delegations(), 1, 'an aborted caller must still delegate exactly once, never zero or twice')
  assert.equal(h.clock.waiting(), 0, 'the abort must disarm the timer')
  assert.deepEqual(first.value, SCRIPT[0])

  const rest = await withDeadline(collect({ [Symbol.asyncIterator]: () => iterator }), 500, 'the rest of the aborted stream')
  assert.deepEqual([first.value, ...rest], [...SCRIPT], 'the aborted path must add no chunk of its own')
  assert.equal(script.delegations(), 1)
})

test('A6 — return() during the hold never dispatches, not even after the boundary', async () => {
  const h = enabledFixture()
  const script = scriptedNext(h.clock)
  const iterator = h.gate.middleware({ sessionId: S }, script.next)[Symbol.asyncIterator]()
  const abandoned = iterator.next()
  await settle()
  assert.equal(h.clock.waiting(), 1)

  // A `for await` loop that exits early does exactly this.
  const finish = iterator.return?.bind(iterator)
  assert.ok(finish !== undefined, 'the middleware must expose return() so an abandoned stream can release the hold')
  const returned = await withDeadline(finish(undefined), 500, 'iterator.return() during the hold')
  assert.equal(returned.done, true, 'return() must complete the stream')
  assert.equal(script.delegations(), 0, 'the abandoned request must never be dispatched')
  assert.equal(h.clock.waiting(), 0, 'the abandoned hold must be disarmed')

  h.clock.advanceTo(BOUNDARY)
  await settle()
  assert.equal(script.delegations(), 0, 'the boundary must not resurrect an abandoned request')
  assert.equal(script.pulls(), 0)
  await withDeadline(abandoned, 500, 'the abandoned first pull')
})

test('A7 — setEnabled(session, false) during a hold releases that parked waiter at once', async () => {
  const h = enabledFixture()
  const script = scriptedNext(h.clock)
  const iterator = h.gate.middleware({ sessionId: S }, script.next)[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()
  const parked = h.gate.view(S)
  assert.equal(parked.holding, 1)
  assert.equal(parked.since, PEAK, 'since is the instant the parked request started waiting')
  assert.equal(parked.releaseAt, BOUNDARY)

  const off = await h.gate.setEnabled(S, false)
  assert.equal(off.enabled, false)
  const first = await withDeadline(firstPull, 500, 'the released hold')
  assert.equal(script.delegations(), 1, 'turning the gate off must release, not abandon, the request')
  assert.deepEqual(first.value, SCRIPT[0])
  assert.equal(h.clock.waiting(), 0)
  assert.equal(h.gate.view(S).holding, 0)
  assert.equal(h.gate.view(S).state, 'off')
})

test('A8 — a sleep past 2^31-1 ms is clamped and re-armed, and an early wake while peak re-arms', async () => {
  // 5e9 ms is ~57 days: the real setTimeout would overflow and fire at once.
  const { engine: farEngine, script } = scriptedEngine({ ...PEAK_VIEW, peak: true, next: { at: PEAK + 5_000_000_000, peak: false } })
  const h = enabledFixture({ engine: farEngine })
  const next = scriptedNext(h.clock)
  const iterator = h.gate.middleware({ sessionId: S }, next.next)[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()

  assert.equal(h.clock.asked.length, 1, 'the hold must arm one timer')
  const asked = h.clock.asked[0] ?? Number.POSITIVE_INFINITY
  assert.ok(asked <= MAX_TIMER, `the delay must be clamped to 2^31-1 ms, the gate asked for ${String(asked)}`)
  assert.equal(next.delegations(), 0)

  // A suspend or a clamped timer: the sleep reports elapsed while the tier is
  // still peak. The gate must classify again and re-arm, never dispatch.
  h.clock.fireEarly()
  await settle()
  assert.equal(next.delegations(), 0, 'an early wake that finds the tier still peak must not dispatch')
  assert.equal(h.clock.asked.length, 2, 'the hold must be re-armed after the early wake')
  assert.equal(h.gate.view(S).state, 'holding')
  assert.equal(next.startedAt(), null)

  // The tier actually turns off-peak: the next wake must release.
  script.view = engine.status(BOUNDARY)
  h.clock.fireEarly()
  const first = await withDeadline(firstPull, 500, 'the re-armed hold')
  assert.equal(next.delegations(), 1, 'the re-armed hold must release exactly once when the tier turns')
  assert.deepEqual(first.value, SCRIPT[0])
})

test('A9 — a peak view with next === null releases instead of hanging (fail-open)', async () => {
  const h = enabledFixture({ engine: statusEngine(() => ({ ...PEAK_VIEW, peak: true, next: null })) })

  const outcome = await withDeadline(h.gate.wait(S), 500, 'the fail-open hold')
  assert.equal(outcome.released, true, 'an unknown boundary must release, not park')
  assert.equal(h.clock.asked.length, 0, 'no timer may be armed when the boundary is unknown')

  const script = scriptedNext(h.clock)
  const emitted = await withDeadline(collect(h.gate.middleware({ sessionId: S }, script.next)), 500, 'the fail-open middleware')
  assert.equal(script.delegations(), 1, 'the request must be dispatched rather than parked')
  assert.deepEqual(emitted, [...SCRIPT])
})

test('A10 — a throwing clock and a throwing pricing engine all fail open', async () => {
  const cases: Array<{ label: string, fixture: () => GateFixture }> = [
    { label: 'clock.now throws', fixture: () => enabledFixture({ clock: { now() { throw new Error('clock exploded') }, sleep: () => Promise.resolve(true) } }) },
    { label: 'clock.sleep throws', fixture: () => enabledFixture({ clock: { now: () => PEAK, sleep() { throw new Error('timer exploded') } } }) },
    { label: 'engine.status throws', fixture: () => enabledFixture({ engine: statusEngine(() => { throw new Error('pricing exploded') }) }) },
  ]
  for (const { label, fixture } of cases) {
    const h = fixture()
    // view() is a pure read: it may report a degraded value but must never throw.
    let view: GateView | undefined
    assert.doesNotThrow(() => { view = h.gate.view(S) }, `${label}: view() must never throw`)
    assert.equal(typeof view?.revision, 'string', `${label}: view() must still produce a usable view`)
    assert.equal(view?.enabled, true, `${label}: the user's flag must survive a broken engine`)

    const outcome = await withDeadline(h.gate.wait(S), 500, `${label}: wait()`)
    assert.equal(outcome.released, true, `${label}: a broken hold must fail open`)

    // middleware() is the seam that would break every model call if it threw.
    const script = scriptedNext(h.clock)
    let iterable: AsyncIterable<Chunk> | undefined
    assert.doesNotThrow(() => { iterable = h.gate.middleware({ sessionId: S }, script.next) }, `${label}: middleware() must never throw`)
    const emitted = await withDeadline(collect(iterable as AsyncIterable<Chunk>), 500, `${label}: the fail-open stream`)
    assert.deepEqual(emitted, [...SCRIPT], `${label}: the fail-open stream must be the provider's own sequence`)
    assert.equal(script.delegations(), 1, `${label}: the call must proceed`)
  }
})

test('A10b — a pricing throw after the hold is armed still releases instead of hanging or rejecting', async () => {
  // `middleware` classifies once to decide whether to wrap (planHold) and the
  // hold re-classifies before arming, so the third call is the post-wake one.
  let calls = 0
  const h = enabledFixture({
    engine: statusEngine(() => {
      calls += 1
      if (calls > 2) throw new Error('pricing exploded mid-hold')
      return PEAK_VIEW
    }),
  })
  const script = scriptedNext(h.clock)
  const iterator = h.gate.middleware({ sessionId: S }, script.next)[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()
  assert.equal(calls, 2, 'the plan and the arming classification must both have succeeded')
  assert.equal(h.clock.waiting(), 1, 'the request must be parked before the failure')

  // The wake re-classifies; the engine is broken now. Fail open, never hang.
  h.clock.advanceTo(BOUNDARY)
  const first = await withDeadline(firstPull, 500, 'the mid-hold pricing failure')
  assert.equal(calls, 3, 'the wake must have re-classified')
  assert.deepEqual(first.value, SCRIPT[0], 'a mid-hold throw must fail open and dispatch')
  assert.equal(script.delegations(), 1)
  const rest = await withDeadline(collect({ [Symbol.asyncIterator]: () => iterator }), 500, 'the rest of the mid-hold failure')
  assert.deepEqual([first.value, ...rest], [...SCRIPT])
})

test('A11 — dispose() while a hold is parked resolves the waiter and is idempotent', async () => {
  const h = enabledFixture()
  const parked = h.gate.wait(S)
  await settle()
  assert.equal(h.clock.waiting(), 1, 'the fixture must have a parked waiter')

  h.gate.dispose()
  const outcome = await withDeadline(parked, 500, 'the disposed hold')
  assert.equal(typeof outcome.waitedMs, 'number', 'a disposed hold must still report its outcome')
  assert.equal(h.clock.waiting(), 0, 'dispose() must disarm the timer')

  assert.doesNotThrow(() => { h.gate.dispose() }, 'dispose() must be idempotent')
  assert.doesNotThrow(() => { h.gate.view(S) }, 'view() must stay safe after dispose')
})

test('A12 — holding/since/heldTotal/delayedMs are exact across sequential holds of one session', async () => {
  const h = enabledFixture()

  const first = h.gate.wait(S)
  await settle()
  const during = h.gate.view(S)
  assert.equal(during.holding, 1, 'one parked request')
  assert.equal(during.since, PEAK, 'since is when the oldest parked request started waiting')
  assert.equal(during.releaseAt, BOUNDARY, 'releaseAt is the boundary the hold is waiting for')
  h.clock.advanceTo(BOUNDARY)
  const one = await withDeadline(first, 500, 'the first hold')
  assert.equal(one.released, true)
  assert.equal(one.waitedMs, BOUNDARY - PEAK, 'two hours of dispatch delay')

  const afterFirst = h.gate.view(S)
  assert.equal(afterFirst.holding, 0)
  assert.equal(afterFirst.since, null, 'since must clear when nothing is parked')
  assert.equal(afterFirst.releaseAt, null, 'releaseAt must clear when nothing is parked')
  assert.equal(afterFirst.heldTotal, 1, 'the parked request must be counted')
  assert.equal(afterFirst.delayedMs, one.waitedMs, 'delayedMs is the delay actually applied')

  // The next peak window: the same shape a week later.
  h.clock.set(SECOND_PEAK)
  const second = h.gate.wait(S)
  await settle()
  assert.equal(h.gate.view(S).since, SECOND_PEAK)
  assert.equal(h.gate.view(S).releaseAt, SECOND_BOUNDARY)
  h.clock.advanceTo(SECOND_BOUNDARY)
  const two = await withDeadline(second, 500, 'the second hold')
  assert.equal(two.waitedMs, SECOND_BOUNDARY - SECOND_PEAK)

  const afterSecond = h.gate.view(S)
  assert.equal(afterSecond.holding, 0)
  assert.equal(afterSecond.heldTotal, 2, 'both parked requests must be counted')
  assert.equal(afterSecond.delayedMs, one.waitedMs + two.waitedMs, 'delayedMs accumulates across holds')
})

test('A12b — two concurrent holds of one session are counted independently and released together', async () => {
  const h = enabledFixture()
  const first = h.gate.wait(S)
  const second = h.gate.wait(S)
  await settle()
  const both = h.gate.view(S)
  assert.equal(both.holding, 2, 'both parked requests must be counted')
  assert.equal(both.since, PEAK, 'since is the OLDEST parked request, not the newest')
  assert.equal(both.releaseAt, BOUNDARY)
  assert.equal(h.clock.waiting(), 2, 'each parked request owns one timer')

  h.clock.advanceTo(BOUNDARY)
  const [a, b] = await withDeadline(Promise.all([first, second]), 500, 'the concurrent holds')
  assert.equal(a.released, true)
  assert.equal(b.released, true)
  assert.equal(a.waitedMs, BOUNDARY - PEAK)
  assert.equal(b.waitedMs, BOUNDARY - PEAK)
  const after = h.gate.view(S)
  assert.equal(after.holding, 0)
  assert.equal(after.since, null)
  assert.equal(after.heldTotal, 2, 'both requests count as parked')
  // Interpretation: "total milliseconds of dispatch delay applied" is the sum
  // over delayed requests, so two requests each delayed two hours is four
  // hours. A wall-clock-union reading would say two hours; if this assertion
  // fails, that is the ambiguity to resolve, not a rounding error.
  assert.equal(after.delayedMs, a.waitedMs + b.waitedMs, 'delayedMs is per delayed request')
})

test('A12c — aborting one parked request leaves the other parked and counted', async () => {
  const h = enabledFixture()
  const controller = new AbortController()
  const aborted = scriptedNext(h.clock)
  const survivor = scriptedNext(h.clock)
  const first = h.gate.middleware({ sessionId: S, signal: controller.signal }, aborted.next)[Symbol.asyncIterator]()
  const second = h.gate.middleware({ sessionId: S }, survivor.next)[Symbol.asyncIterator]()
  const firstPull = first.next()
  const secondPull = second.next()
  await settle()
  assert.equal(h.gate.view(S).holding, 2, 'both requests must be parked')

  controller.abort()
  const firstChunk = await withDeadline(firstPull, 500, 'the aborted request')
  assert.deepEqual(firstChunk.value, SCRIPT[0])
  assert.equal(aborted.delegations(), 1)
  const view = h.gate.view(S)
  assert.equal(view.holding, 1, 'the survivor must still be parked')
  assert.equal(view.since, PEAK, 'the survivor keeps its own start instant')
  assert.equal(h.clock.waiting(), 1, 'the survivor keeps its own timer')
  assert.equal(survivor.delegations(), 0, 'aborting one request must not dispatch another')
  assert.equal(h.clock.asked.length, 2, 'only the survivor may still be waiting')

  h.clock.advanceTo(BOUNDARY)
  const secondChunk = await withDeadline(secondPull, 500, 'the surviving request')
  assert.deepEqual(secondChunk.value, SCRIPT[0])
  assert.equal(survivor.delegations(), 1)
  assert.equal(h.gate.view(S).holding, 0)
})

test('A13 — revision moves with a rendered field, folds the session id, and never moves with now/delayedMs alone', async () => {
  const h = gateFixture({ store: memoryStore({ [S]: false }) })
  const off = h.gate.view(S)

  // Negative case: the clock moves, nothing else does.
  h.clock.advanceTo(PEAK + 60_000)
  const moved = h.gate.view(S)
  assert.notEqual(moved.now, off.now, 'the fixture must actually move now, or the negative case is vacuous')
  assert.equal(moved.revision, off.revision, 'now must never enter the revision')

  const on = await h.gate.setEnabled(S, true)
  assert.notEqual(on.revision, off.revision, 'enabling is a rendered change')

  const parked = h.gate.wait(S)
  await settle()
  const holdingA = h.gate.view(S)
  h.clock.advanceTo(PEAK + 120_000)
  const holdingB = h.gate.view(S)
  assert.notEqual(holdingB.now, holdingA.now, 'the clock must really have moved during the hold')
  assert.equal(holdingB.revision, holdingA.revision, 'a hold in progress is not a revision change by itself')

  h.clock.advanceTo(BOUNDARY)
  await withDeadline(parked, 500, 'the hold')
  const released = h.gate.view(S)
  assert.notEqual(released.revision, holdingB.revision, 'the counters that changed on release are rendered fields')
  assert.equal(released.heldTotal, 1)
})

test('A14 — the durable choice round-trips per session, degrades on an unwritable path, and honours persist:false', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-api-cost-gate-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const flagged = async (config: GateConfig, store: GateStore, sessionId = S): Promise<GateView> =>
    await createOffPeakGate({ engine, config, clock: createClock(PEAK), store }).setEnabled(sessionId, true)

  // 1. Write one session, then read it back through a second store instance.
  const path = join(directory, 'gate.json')
  const store = defaultGateStore(path)
  assert.equal(store.read(S), undefined, 'nothing has been stored yet')
  assert.equal(store.write(S, true), true, 'a writable path must report a durable write')
  assert.equal(store.read(S), true)
  assert.equal(defaultGateStore(path).read(S), true, 'a fresh store on the same path must see the choice')
  const stored: unknown = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(Object.keys(stored as object).sort(), ['sessions', 'version'])
  assert.equal((stored as { version: number }).version, 2)
  const sessions = (stored as { sessions: Record<string, { enabled: boolean, changedAt: number }> }).sessions
  assert.deepEqual(Object.keys(sessions), [S], 'only the switched session is stored')
  assert.equal(sessions[S]?.enabled, true)
  assert.equal(typeof sessions[S]?.changedAt, 'number')

  // 2. The stored choice wins for ITS session; another session inherits the config default.
  const restored = createOffPeakGate({ engine, config: { enabled: false, path }, clock: createClock(PEAK), store: defaultGateStore(path) })
  const restoredA = restored.view(S)
  assert.equal(restoredA.enabled, true, 'the durable choice must win over config.enabled')
  assert.equal(restoredA.durable, true, 'a choice that survived a restart is durable')
  assert.equal(restoredA.changedAt, sessions[S]?.changedAt, 'a restored switch keeps its stored changedAt')
  const inheritedB = restored.view(T)
  assert.equal(inheritedB.enabled, false, 'a session with no stored choice inherits config.enabled')
  assert.equal(inheritedB.changedAt, null, 'an inherited position was never switched by hand')
  assert.equal(inheritedB.durable, false, 'an inherited position is not durable')
  const fresh = createOffPeakGate({ engine, config: { enabled: true }, clock: createClock(PEAK), store: defaultGateStore(join(directory, 'absent.json')) })
  assert.equal(fresh.view(S).enabled, true, 'with nothing stored, config.enabled is the initial value')
  assert.equal(fresh.view(S).durable, false, 'an unwritten choice is not durable')

  // 3. A path that cannot be created: in-memory only, no throw, no durability claim.
  const blocked = join(directory, 'blocked')
  writeFileSync(blocked, 'not a directory')
  const unwritable = defaultGateStore(join(blocked, 'gate.json'))
  assert.equal(unwritable.read(S), undefined, 'an unreadable store reads as "nothing stored"')
  assert.equal(unwritable.write(S, true), false, 'an unwritable path must report failure, never throw')
  const degraded = await flagged({ enabled: true, path: join(blocked, 'gate.json') }, unwritable)
  assert.equal(degraded.enabled, true, 'the feature must keep working in memory')
  assert.equal(degraded.durable, false, 'an unwritable path can never claim durability')
  assert.equal(existsSync(join(blocked, 'gate.json')), false)

  // 4. persist:false disables storage entirely.
  const memory = memoryStore()
  const noPersist = await createOffPeakGate({ engine, config: { persist: false }, clock: createClock(PEAK), store: memory }).setEnabled(S, true)
  assert.equal(noPersist.enabled, true)
  assert.equal(noPersist.durable, false, 'persist:false must report durable:false')
  assert.deepEqual(memory.writes, [], 'persist:false must not write the store at all')
})

test('A14b — the env override and the <dsh home> default resolve where §4.4 says', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-api-cost-home-'))
  const previousFile = process.env['DSH_API_COST_GATE_FILE']
  const previousHome = process.env['DSH_HOME']
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
    if (previousFile === undefined) delete process.env['DSH_API_COST_GATE_FILE']
    else process.env['DSH_API_COST_GATE_FILE'] = previousFile
    if (previousHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previousHome
  })

  const explicit = join(directory, 'explicit.json')
  process.env['DSH_API_COST_GATE_FILE'] = explicit
  delete process.env['DSH_HOME']
  assert.equal(defaultGateStore().write(S, true), true, 'the env override must be writable')
  assert.equal(existsSync(explicit), true, 'DSH_API_COST_GATE_FILE must be the store path')
  assert.equal(defaultGateStore().read(S), true)

  // A `DSH_HOME` with surrounding whitespace is trimmed, not treated as a path.
  const home = join(directory, 'home')
  process.env['DSH_HOME'] = `  ${home}  `
  delete process.env['DSH_API_COST_GATE_FILE']
  assert.equal(defaultGateStore().write(T, false), true, 'the home default must be writable')
  assert.equal(existsSync(join(home, 'state', 'dsh-api-cost', 'gate.json')), true, 'the default path must be <dsh home>/state/dsh-api-cost/gate.json')
})

test('A15 — enabling one session parks only that session; another session and a session-less call stay identical', async () => {
  const h = gateFixture({ at: PEAK })
  assert.equal(h.gate.view(S).enabled, false, 'the fixture starts with every session inheriting the default (off)')
  assert.equal(h.gate.view(T).enabled, false)
  await h.gate.setEnabled(S, true)
  assert.equal(h.gate.view(S).enabled, true)
  assert.equal(h.gate.view(T).enabled, false, 'enabling A must not enable B')

  const held = scriptedNext(h.clock)
  const iterator = h.gate.middleware({ sessionId: S }, held.next)[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()
  assert.equal(h.clock.waiting(), 1, 'session A must be parked')
  assert.equal(h.gate.view(S).holding, 1)
  assert.equal(h.gate.view(S).otherHolding, 0)
  assert.equal(h.gate.view(T).holding, 0, 'session B must have nothing parked')
  assert.equal(h.gate.view(T).otherHolding, 1, 'B can see that another session waits, without holding it')

  // B is not wrapped at all: the very object next() produced comes back...
  const produced = scriptedNext(h.clock).next()
  assert.equal(h.gate.middleware({ sessionId: T }, () => produced), produced, 'session B must bypass the gate by identity while session A holds')
  // ...and a call the loop did not stamp with a session is never gated either.
  const unstamped = scriptedNext(h.clock).next()
  assert.equal(h.gate.middleware({}, () => unstamped), unstamped, 'a session-less call must bypass the gate by identity')
  // The same is true for any session id that is not a non-empty string (§4.3).
  for (const malformed of [undefined, null, 42, {}, '']) {
    const candidate = scriptedNext(h.clock).next()
    assert.doesNotThrow(() => {
      const returned = h.gate.middleware({ sessionId: malformed as never }, () => candidate)
      assert.equal(returned, candidate, `sessionId ${JSON.stringify(malformed)} must bypass the gate by identity`)
    }, `a malformed session id (${JSON.stringify(malformed)}) must never throw from middleware`)
  }

  // B really dispatches while A is still parked.
  const free = scriptedNext(h.clock)
  const emitted = await withDeadline(collect(h.gate.middleware({ sessionId: T }, free.next)), 500, 'session B\'s ungated stream')
  assert.equal(free.delegations(), 1)
  assert.equal(free.startedAt(), PEAK, 'session B must dispatch at the peak instant')
  assert.deepEqual(emitted, [...SCRIPT])
  assert.equal(h.gate.view(S).holding, 1, 'B completing must not touch A')

  h.clock.advanceTo(BOUNDARY)
  const first = await withDeadline(firstPull, 500, 'session A\'s parked request')
  assert.deepEqual(first.value, SCRIPT[0])
  assert.equal(held.delegations(), 1)
})

test('A16 — two sessions hold independently; counters are isolated and switching one off releases only its holders', async () => {
  const h = gateFixture({ at: PEAK })
  await h.gate.setEnabled(S, true)
  await h.gate.setEnabled(T, true)

  const a = h.gate.wait(S)
  const b = h.gate.wait(T)
  await settle()
  assert.equal(h.clock.waiting(), 2, 'each parked session owns one timer')
  const viewA = h.gate.view(S)
  const viewB = h.gate.view(T)
  assert.equal(viewA.holding, 1)
  assert.equal(viewB.holding, 1)
  assert.equal(viewA.heldTotal, 1)
  assert.equal(viewB.heldTotal, 1)
  assert.equal(viewA.since, PEAK)
  assert.equal(viewB.since, PEAK)
  assert.equal(viewA.releaseAt, BOUNDARY)
  assert.equal(viewB.releaseAt, BOUNDARY)
  assert.equal(viewA.otherHolding, 1, 'A sees exactly one request parked in other sessions')
  assert.equal(viewB.otherHolding, 1)
  assert.notEqual(viewA.revision, viewB.revision, 'two sessions must never share an ETag')

  const off = await h.gate.setEnabled(S, false)
  assert.equal(off.enabled, false)
  assert.equal(off.holding, 0)
  const released = await withDeadline(a, 500, 'session A\'s released hold')
  assert.equal(released.released, true)
  // B is untouched and still parked.
  assert.equal(h.clock.waiting(), 1, 'turning A off must not disarm B\'s timer')
  assert.equal(h.gate.view(T).holding, 1, 'turning A off must not release B')
  assert.equal(h.gate.view(T).otherHolding, 0)
  assert.equal(h.gate.view(S).holding, 0)
  assert.equal(h.gate.view(S).heldTotal, 1, 'A keeps its own history')
  assert.equal(h.gate.view(T).heldTotal, 1, 'B keeps its own history')

  h.clock.advanceTo(BOUNDARY)
  const done = await withDeadline(b, 500, 'session B\'s hold')
  assert.equal(done.released, true)
  assert.equal(done.waitedMs, BOUNDARY - PEAK)
  assert.equal(h.gate.view(T).delayedMs, BOUNDARY - PEAK, 'B absorbed the two-hour delay')
  assert.equal(h.gate.view(S).delayedMs, 0, 'A was released immediately at PEAK and absorbed nothing')
  assert.equal(h.gate.view(T).holding, 0)
})

test('A17 — per-session durability: choices round-trip independently, a legacy v1 file is ignored, an unwritable path degrades, and the file keeps at most 512 sessions', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-api-cost-gate-store-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const path = join(directory, 'gate.json')

  // 1. Two sessions, two independent stored choices.
  const store = defaultGateStore(path)
  assert.equal(store.write(S, true), true)
  assert.equal(store.write(T, false), true)
  const restored = createOffPeakGate({ engine, config: { enabled: true }, clock: createClock(PEAK), store: defaultGateStore(path) })
  assert.equal(restored.view(S).enabled, true)
  assert.equal(restored.view(T).enabled, false, 'the second session keeps its own stored false')
  assert.equal(restored.view(S).durable, true)
  assert.equal(restored.view(T).durable, true)
  assert.equal(restored.view(T).changedAt === null, false, 'a restored switch was switched by hand at some point')
  const document = JSON.parse(readFileSync(path, 'utf8')) as { version: number, sessions: Record<string, { enabled: boolean, changedAt: number }> }
  assert.equal(document.version, 2)
  assert.deepEqual(Object.keys(document.sessions).sort(), [S, T].sort())

  // 2. A v1 file held one process-global flag; it cannot be attributed to a
  // session, so it is ignored rather than guessed at, and the next write upgrades.
  const legacy = join(directory, 'legacy.json')
  writeFileSync(legacy, `${JSON.stringify({ version: 1, enabled: true, changedAt: 123 })}\n`)
  assert.equal(defaultGateStore(legacy).read(S), undefined, 'a v1 file must read as "nothing stored for this session"')
  const legacyGate = createOffPeakGate({ engine, config: { enabled: false }, clock: createClock(PEAK), store: defaultGateStore(legacy) })
  const inherited = legacyGate.view(S)
  assert.equal(inherited.enabled, false, 'the discarded v1 flag must not enable a session')
  assert.equal(inherited.changedAt, null)
  assert.equal(inherited.durable, false)
  const flipped = await legacyGate.setEnabled(S, true)
  assert.equal(flipped.enabled, true)
  const upgraded = JSON.parse(readFileSync(legacy, 'utf8')) as { version: number, sessions: Record<string, { enabled: boolean }> }
  assert.equal(upgraded.version, 2, 'the first write after a v1 file must produce a v2 document')
  assert.equal(upgraded.sessions[S]?.enabled, true)

  // 3. An unwritable path keeps the feature working in memory, without claiming durability.
  const blocked = join(directory, 'blocked')
  writeFileSync(blocked, 'not a directory')
  const unwritable = defaultGateStore(join(blocked, 'gate.json'))
  assert.equal(unwritable.write(S, true), false, 'an unwritable path must report failure, never throw')
  assert.equal(unwritable.read(S), undefined)

  // 4. At most 512 sessions are stored; the oldest changedAt is evicted first.
  const cappedPath = join(directory, 'capped.json')
  const capped = defaultGateStore(cappedPath)
  for (let index = 0; index < 513; index += 1) {
    assert.equal(capped.write(`session-${index}`, index % 2 === 0), true, `write ${index} must be durable`)
  }
  const cappedDocument = JSON.parse(readFileSync(cappedPath, 'utf8')) as { sessions: Record<string, { enabled: boolean }> }
  const kept = Object.keys(cappedDocument.sessions)
  assert.equal(kept.length, 512, 'the durable file must keep at most 512 sessions')
  assert.equal(kept.includes('session-0'), false, 'the oldest changedAt must be evicted first')
  assert.equal(kept.includes('session-512'), true, 'the newest write must survive')
  assert.equal(defaultGateStore(cappedPath).read('session-512'), true)
  assert.equal(defaultGateStore(cappedPath).read('session-0'), undefined)
})

test('A17b — the durable file stores explicit choices only; a restart rebuilds the tree from live links', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-api-cost-gate-tree-store-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const path = join(directory, 'gate.json')

  const first = createOffPeakGate({ engine, config: { enabled: false, path }, clock: createClock(PEAK), store: defaultGateStore(path) })
  await first.setEnabled(P, true)
  first.observeSession(C, P)
  assert.deepEqual(position(first.view(C)), { enabled: true, source: 'inherited', inheritedFrom: P })

  const document = JSON.parse(readFileSync(path, 'utf8')) as { version: number, sessions: Record<string, { enabled: boolean, changedAt: number }> }
  assert.equal(document.version, 2)
  assert.deepEqual(Object.keys(document.sessions), [P], 'the delegation link must never be persisted: only the explicit choice is')
  assert.equal(document.sessions[P]?.enabled, true)
  assert.equal(typeof document.sessions[P]?.changedAt, 'number')

  // A fresh gate on the same store knows the parent's choice but none of the
  // links: the tree is live state, so an unannounced child is a root again.
  const restarted = createOffPeakGate({ engine, config: { enabled: false, path }, clock: createClock(PEAK), store: defaultGateStore(path) })
  assert.deepEqual(position(restarted.view(P)), { enabled: true, source: 'self', inheritedFrom: null }, 'the explicit choice survives a restart')
  assert.deepEqual(position(restarted.view(C)), { enabled: false, source: 'default', inheritedFrom: null }, 'a fresh process has no links until it observes them')
  restarted.observeSession(C, P)
  assert.deepEqual(position(restarted.view(C)), { enabled: true, source: 'inherited', inheritedFrom: P }, 'the tree is rebuilt from the live links, not from the durable file')
  const restartedDocument = JSON.parse(readFileSync(path, 'utf8')) as { sessions: Record<string, unknown> }
  assert.deepEqual(Object.keys(restartedDocument.sessions), [P], 'observing a link writes nothing to the store')
})

test('A18 — the gate read is per-session: a missing session is a 400, each session has its own ETag, and a POST flips only its named session', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })

  // No session at all: the old process-global read is gone.
  const missing = await send(h)
  assert.equal(missing.status, 400, 'a gate read without a session must be refused')
  assert.equal((missing.json() as { code: string }).code, 'INVALID_SESSION')
  const invalid = await send(h, { query: '?session=not%20a%20session' })
  assert.equal(invalid.status, 400)
  assert.equal((invalid.json() as { code: string }).code, 'INVALID_SESSION')
  const empty = await send(h, { query: '?session=' })
  assert.equal(empty.status, 400, 'an empty session must be refused like a missing one')
  assert.equal((empty.json() as { code: string }).code, 'INVALID_SESSION')
  const unknownKey = await send(h, { query: `${gateQuery(S)}&scope=self` })
  assert.equal(unknownKey.status, 400)
  assert.equal((unknownKey.json() as { code: string }).code, 'INVALID_PARAMETER', 'only the session query key is accepted')
  const duplicated = await send(h, { query: `${gateQuery(S)}&session=${T}` })
  assert.equal(duplicated.status, 400)
  assert.equal((duplicated.json() as { code: string }).code, 'INVALID_PARAMETER')

  const a = await send(h, { query: gateQuery(S) })
  const b = await send(h, { query: gateQuery(T) })
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  const viewA = a.json() as GateView
  const viewB = b.json() as GateView
  assert.equal(viewA.sessionId, S)
  assert.equal(viewB.sessionId, T)
  assert.notEqual(viewA.revision, viewB.revision, 'two sessions must have different revisions')
  assert.notEqual(a.headers['etag'], b.headers['etag'], 'two sessions must have different ETags')
  assert.equal(viewA.enabled, false)
  assert.equal(viewB.enabled, false)

  // A POST names exactly one session and flips only that session.
  const flipA = await send(h, { method: 'POST', headers: JSON_HEADERS, body: gateBody(S, true) })
  assert.equal(flipA.status, 200)
  const flipped = flipA.json() as GateView
  assert.equal(flipped.sessionId, S, 'the answer must describe the named session')
  assert.equal(flipped.enabled, true)
  const aAfter = (await send(h, { query: gateQuery(S) })).json() as GateView
  assert.equal(aAfter.enabled, true, 'the flip must be visible on the next read of that session')
  assert.equal(aAfter.revision, flipped.revision)
  const bAfter = (await send(h, { query: gateQuery(T) })).json() as GateView
  assert.equal(bAfter.enabled, false, 'the named session is the only one a POST may flip')
  assert.equal(bAfter.revision, viewB.revision, 'another session\'s revision must not move')

  const flipB = await send(h, { method: 'POST', headers: JSON_HEADERS, body: gateBody(T, true) })
  assert.equal(flipB.status, 200)
  assert.equal((flipB.json() as GateView).sessionId, T)
  assert.equal(((await send(h, { query: gateQuery(S) })).json() as GateView).enabled, true, 'A keeps its own independent choice')

  // A malformed session id in a well-shaped body is the session error, not a body error.
  const badSession = await send(h, { method: 'POST', headers: JSON_HEADERS, body: gateBody('bad/id', true) })
  assert.equal(badSession.status, 400)
  assert.equal((badSession.json() as { code: string }).code, 'INVALID_SESSION')
  // A missing session key is a body-shape error.
  const noSession = await send(h, { method: 'POST', headers: JSON_HEADERS, body: '{"enabled":true}' })
  assert.equal(noSession.status, 400)
  assert.equal((noSession.json() as { code: string }).code, 'INVALID_BODY')
  assertNoPathLeak(a, 'A18 GET 200')
  assertNoPathLeak(flipA, 'A18 POST 200')
})

test('A19 — in-memory session state is bounded: an inherited record is evicted before an explicit choice, and the oldest-touched record goes under real pressure', async () => {
  const BOUND = 1024
  const h = gateFixture({ config: { persist: false } })
  // One explicit in-memory choice, then fill the budget with inherited records.
  await h.gate.setEnabled('pinned', true)
  for (let index = 0; index < BOUND - 1; index += 1) h.gate.view(`idle-${index}`)
  assert.equal(h.gate.view('pinned').enabled, true, 'the explicit choice is still remembered')

  // Every new inherited session must evict an older inherited one, never the
  // explicit choice: dropping an inherited record is invisible, so it goes first.
  for (let index = 0; index < BOUND - 1; index += 1) h.gate.view(`fresh-${index}`)
  assert.equal(h.gate.view('pinned').enabled, true, 'an inherited record must be evicted before an explicit choice')
  assert.equal(h.gate.view('pinned').changedAt === null, false, 'the explicit choice keeps its switch instant')

  // Now overflow the budget with explicit choices: inherited records are already
  // gone, so the oldest-touched explicit record has to go — the bound is hard.
  for (let index = 0; index < BOUND; index += 1) await h.gate.setEnabled(`chosen-${index}`, true)
  assert.equal(h.gate.view('pinned').enabled, false, 'under real pressure the oldest-touched explicit choice is evicted and the session falls back to the default')
  assert.equal(h.gate.view('pinned').changedAt, null, 'the rebuilt inherited record reports the default again')
  assert.equal(h.gate.view(`chosen-${BOUND - 1}`).enabled, true, 'the newest explicit choice survives')
})

/* ------------------------------------------------------------------ *
 * A20–A26. The v2.3.0 scope: one switch, one conversation tree
 * ------------------------------------------------------------------ */

test('A20 — a parent switch parks its child and grandchild, while an unrelated root returns the identical next()', async () => {
  const h = gateFixture({ at: PEAK })
  await h.gate.setEnabled(P, true)
  // The delegation links arrive the way the host learns them: session/created.
  h.gate.observeSession(C, P)
  h.gate.observeSession(G, C)

  assert.deepEqual(position(h.gate.view(P)), { enabled: true, source: 'self', inheritedFrom: null })
  assert.deepEqual(position(h.gate.view(C)), { enabled: true, source: 'inherited', inheritedFrom: P }, 'a child with no choice of its own follows its parent')
  assert.deepEqual(position(h.gate.view(G)), { enabled: true, source: 'inherited', inheritedFrom: P }, 'inheritedFrom names the nearest explicit ancestor, not the immediate parent')
  assert.equal(h.gate.view(C).changedAt, null, 'the child itself was never switched')
  assert.equal(h.gate.view(C).durable, false, 'an inherited position is not the child’s own durable choice')

  // Both inherited sessions really park at the request boundary, lazily.
  const childScript = scriptedNext(h.clock)
  const childIterator = h.gate.middleware({ sessionId: C }, childScript.next)[Symbol.asyncIterator]()
  const childPull = childIterator.next()
  const grandScript = scriptedNext(h.clock)
  const grandIterator = h.gate.middleware({ sessionId: G }, grandScript.next)[Symbol.asyncIterator]()
  const grandPull = grandIterator.next()
  await settle()
  assert.equal(h.clock.waiting(), 2, 'the child and the grandchild must both be parked')
  assert.equal(childScript.delegations(), 0, 'the child must not reach next() while the tier is peak')
  assert.equal(grandScript.delegations(), 0, 'the grandchild must not reach next() either')

  const parentView = h.gate.view(P)
  assert.equal(parentView.holding, 2, 'the parent view aggregates its tracked subtree')
  assert.equal(parentView.ownHolding, 0, 'the parent itself parked nothing')
  assert.equal(h.gate.view(C).holding, 2, 'the child view aggregates itself and its grandchild')
  assert.equal(h.gate.view(C).ownHolding, 1)
  assert.equal(h.gate.view(G).holding, 1)
  assert.equal(h.gate.view(G).ownHolding, 1)
  assert.equal(parentView.otherHolding, 0)

  // An unrelated conversation is not in the tree: its call is the very object
  // next() produced, and it dispatches at the peak instant.
  const produced = scriptedNext(h.clock).next()
  assert.equal(h.gate.middleware({ sessionId: R }, () => produced), produced, 'an unrelated root must bypass the gate by identity')
  assert.equal(h.gate.view(R).enabled, false)
  assert.equal(h.gate.view(R).source, 'default')
  assert.equal(h.gate.view(R).otherHolding, 2, 'it can see the tree waiting without being part of it')
  const free = scriptedNext(h.clock)
  const emitted = await withDeadline(collect(h.gate.middleware({ sessionId: R }, free.next)), 500, 'the unrelated root stream')
  assert.deepEqual(emitted, [...SCRIPT])
  assert.equal(free.delegations(), 1)
  assert.equal(free.startedAt(), PEAK, 'an unrelated conversation must never be delayed by another conversation’s switch')

  h.clock.advanceTo(BOUNDARY)
  const [childFirst, grandFirst] = await withDeadline(Promise.all([childPull, grandPull]), 500, 'the two parked subtree requests')
  assert.deepEqual(childFirst.value, SCRIPT[0])
  assert.deepEqual(grandFirst.value, SCRIPT[0])
  assert.equal(childScript.delegations(), 1)
  assert.equal(grandScript.delegations(), 1)
  assert.equal(h.gate.view(P).holding, 0)
  assert.equal(h.gate.view(P).heldTotal, 2, 'the subtree counter sums its members')
  assert.equal(h.gate.view(P).delayedMs, (BOUNDARY - PEAK) * 2, 'dispatch delay is aggregated over the subtree')
})

test('A21 — enabling a root parks only its tree: an unrelated tree and its child dispatch immediately', async () => {
  const h = gateFixture({ at: PEAK })
  const OTHER_CHILD = 'tree-other-child'
  h.gate.observeSession(C, P)
  h.gate.observeSession(OTHER_CHILD, R)
  await h.gate.setEnabled(P, true)

  assert.equal(h.gate.view(C).enabled, true, 'the enabled root’s child follows it')
  assert.equal(h.gate.view(R).enabled, false, 'an unrelated root keeps the default')
  assert.deepEqual(position(h.gate.view(OTHER_CHILD)), { enabled: false, source: 'default', inheritedFrom: null }, 'an unrelated tree’s child is not in the enabled subtree')

  const held = scriptedNext(h.clock)
  const iterator = h.gate.middleware({ sessionId: C }, held.next)[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()
  assert.equal(h.clock.waiting(), 1, 'only the enabled tree owns a hold')
  assert.equal(h.gate.view(R).otherHolding, 1, 'the unrelated tree can see the hold it is not part of')
  assert.equal(h.gate.view(OTHER_CHILD).holding, 0)

  // Both the unrelated root and its child bypass the gate by identity.
  const produced = scriptedNext(h.clock).next()
  assert.equal(h.gate.middleware({ sessionId: R }, () => produced), produced, 'the unrelated root bypasses by identity')
  assert.equal(h.gate.middleware({ sessionId: OTHER_CHILD }, () => produced), produced, 'the unrelated child bypasses by identity')
  const free = scriptedNext(h.clock)
  const emitted = await withDeadline(collect(h.gate.middleware({ sessionId: OTHER_CHILD }, free.next)), 500, 'the unrelated child stream')
  assert.deepEqual(emitted, [...SCRIPT])
  assert.equal(free.delegations(), 1)
  assert.equal(free.startedAt(), PEAK, 'a whole unrelated tree dispatches at the peak instant')
  assert.equal(h.clock.waiting(), 1, 'an unrelated dispatch must not touch the parked tree')

  h.clock.advanceTo(BOUNDARY)
  const first = await withDeadline(firstPull, 500, 'the tree request')
  assert.deepEqual(first.value, SCRIPT[0])
  assert.equal(held.delegations(), 1)
  assert.equal(h.gate.view(R).otherHolding, 0)
})

test('A22 — the nearest explicit choice wins; view.source and view.inheritedFrom are exact', async () => {
  // 1. A child's explicit OFF overrides a parent's ON, and the grandchild follows
  // the child (the NEAREST explicit ancestor), not the root.
  const h = gateFixture({ at: PEAK })
  h.gate.observeSession(C, P)
  h.gate.observeSession(G, C)
  await h.gate.setEnabled(P, true)
  await h.gate.setEnabled(C, false)
  assert.deepEqual(position(h.gate.view(P)), { enabled: true, source: 'self', inheritedFrom: null })
  assert.deepEqual(position(h.gate.view(C)), { enabled: false, source: 'self', inheritedFrom: null }, 'the child’s own OFF wins over the parent ON')
  assert.deepEqual(position(h.gate.view(G)), { enabled: false, source: 'inherited', inheritedFrom: C }, 'the grandchild inherits the nearest explicit choice, even a negative one')

  const produced = scriptedNext(h.clock).next()
  assert.equal(h.gate.middleware({ sessionId: C }, () => produced), produced, 'an explicitly disabled child is not gated')
  assert.equal(h.gate.middleware({ sessionId: G }, () => produced), produced, 'its subtree is not gated either')
  const parentHold = h.gate.wait(P)
  await settle()
  assert.equal(h.clock.waiting(), 1, 'only the explicitly enabled root parks')

  // 2. Switching the child ON overrides the parent for the child's own subtree:
  // the grandchild's inheritedFrom moves from the root to the child.
  await h.gate.setEnabled(C, true)
  assert.deepEqual(position(h.gate.view(C)), { enabled: true, source: 'self', inheritedFrom: null })
  assert.deepEqual(position(h.gate.view(G)), { enabled: true, source: 'inherited', inheritedFrom: C }, 'inheritance follows the nearest explicit ancestor')
  const childHold = h.gate.wait(C)
  const grandHold = h.gate.wait(G)
  await settle()
  assert.equal(h.clock.waiting(), 3, 'the root, the child subtree and the grandchild all park')

  // 3. A parent OFF with a child explicit ON: the child (and its subtree) keeps
  // its own position; the parent itself is off and gated nowhere.
  const m = gateFixture({ at: PEAK })
  m.gate.observeSession(C, P)
  m.gate.observeSession(G, C)
  await m.gate.setEnabled(C, true)
  assert.deepEqual(position(m.gate.view(P)), { enabled: false, source: 'default', inheritedFrom: null }, 'an unswitched parent of an enabled child is still default-off')
  assert.deepEqual(position(m.gate.view(C)), { enabled: true, source: 'self', inheritedFrom: null })
  assert.deepEqual(position(m.gate.view(G)), { enabled: true, source: 'inherited', inheritedFrom: C })
  const parentProduced = scriptedNext(m.clock).next()
  assert.equal(m.gate.middleware({ sessionId: P }, () => parentProduced), parentProduced, 'the parent itself is not gated by its child’s choice')
  const childHeld = scriptedNext(m.clock)
  const childIterator = m.gate.middleware({ sessionId: C }, childHeld.next)[Symbol.asyncIterator]()
  const childPull = childIterator.next()
  await settle()
  assert.equal(m.clock.waiting(), 1)
  // The subtree counters are structural: the parent's view aggregates every
  // tracked descendant, so it can show that its child's own tree is waiting even
  // while the parent itself is off and holds nothing.
  assert.equal(m.gate.view(P).holding, 1, 'the enabled child is still part of the parent’s tracked subtree')
  assert.equal(m.gate.view(P).ownHolding, 0)
  assert.equal(m.gate.view(C).ownHolding, 1)
  m.clock.advanceTo(BOUNDARY)
  const childFirst = await withDeadline(childPull, 500, 'the explicitly enabled child’s hold')
  assert.deepEqual(childFirst.value, SCRIPT[0])
  assert.equal(childHeld.delegations(), 1)

  // 4. An explicit negative ancestor also overrides the configured default ON.
  const n = gateFixture({ at: PEAK, config: { enabled: true }, store: memoryStore({ [P]: false }) })
  n.gate.observeSession(C, P)
  assert.equal(n.gate.view(R).enabled, true, 'a session with no explicit ancestor follows the configured default ON')
  assert.equal(n.gate.view(R).source, 'default')
  assert.deepEqual(position(n.gate.view(C)), { enabled: false, source: 'inherited', inheritedFrom: P }, 'an explicit ancestor OFF overrides the default ON')

  // 5. Release everything the fixtures still hold.
  await h.gate.setEnabled(P, false)
  await h.gate.setEnabled(C, false)
  const [parentsDone, childDone, grandDone] = await withDeadline(Promise.all([parentHold, childHold, grandHold]), 500, 'the precedence fixture holds')
  assert.equal(parentsDone.released, true)
  assert.equal(childDone.released, true)
  assert.equal(grandDone.released, true)
})

test('A23 — disabling a parent releases only its inheriting descendants; an explicit-ON child stays parked and counted', async () => {
  const h = gateFixture({ at: PEAK })
  const D = 'tree-child-unswitched'
  const U = 'tree-unrelated'
  h.gate.observeSession(C, P)
  h.gate.observeSession(D, P)
  h.gate.observeSession(G, C)
  await h.gate.setEnabled(P, true)
  await h.gate.setEnabled(U, true)
  // The child is switched ON by hand: its own choice now wins over the parent's.
  await h.gate.setEnabled(C, true)

  const parentHold = h.gate.wait(P)
  const childHold = h.gate.wait(C)
  const siblingHold = h.gate.wait(D)
  const grandHold = h.gate.wait(G)
  const unrelatedHold = h.gate.wait(U)
  await settle()
  assert.equal(h.clock.waiting(), 5, 'the whole tree and the unrelated root are parked')
  assert.equal(h.gate.view(P).holding, 4, 'P subtree: P, C, D, G')
  assert.equal(h.gate.view(P).ownHolding, 1)
  assert.equal(h.gate.view(U).otherHolding, 4)

  const off = await h.gate.setEnabled(P, false)
  assert.equal(off.enabled, false, 'the parent’s own choice is now off')
  assert.equal(off.source, 'self')

  // The parent and the unswitched sibling are released; the explicit-ON child and
  // its subtree keep holding, and so does the unrelated root.
  const [parentDone, siblingDone] = await withDeadline(Promise.all([parentHold, siblingHold]), 500, 'the un-gated descendants')
  assert.equal(parentDone.released, true, 'the parent’s own holder is released')
  assert.equal(siblingDone.released, true, 'an inheriting descendant is released')
  assert.equal(h.clock.waiting(), 3, 'the explicit-ON child, its grandchild and the unrelated root stay parked and timer-armed')
  assert.equal(h.gate.view(C).holding, 2, 'the explicit-ON child’s subtree is still parked')
  assert.equal(h.gate.view(G).holding, 1, 'the grandchild inheriting the explicit-ON child is still parked')
  assert.equal(h.gate.view(U).holding, 1, 'the unrelated conversation is untouched')

  const parentView = h.gate.view(P)
  assert.equal(parentView.enabled, false)
  assert.equal(parentView.holding, 2, 'the explicitly enabled child’s subtree is still counted under the parent')
  assert.equal(parentView.ownHolding, 0, 'the parent itself holds nothing')
  assert.equal(parentView.otherHolding, 1, 'the unrelated root is outside the parent’s subtree')
  assert.deepEqual(position(h.gate.view(C)), { enabled: true, source: 'self', inheritedFrom: null }, 'the explicit choice survived')
  assert.deepEqual(position(h.gate.view(G)), { enabled: true, source: 'inherited', inheritedFrom: C })
  assert.equal(h.gate.view(C).holding, 2, 'C’s subtree holds C and G')
  assert.equal(h.gate.view(C).ownHolding, 1, 'only one of those two is C’s own request')

  // An unrelated conversation is untouched: still parked and still counted.
  assert.equal(h.gate.view(U).holding, 1)
  assert.equal(h.gate.view(U).source, 'self')

  h.clock.advanceTo(BOUNDARY)
  const [childDone, grandDone, unrelatedDone] = await withDeadline(Promise.all([childHold, grandHold, unrelatedHold]), 500, 'the surviving holds')
  assert.equal(childDone.released, true)
  assert.equal(grandDone.released, true)
  assert.equal(unrelatedDone.released, true)
  assert.equal(h.gate.view(P).holding, 0)
  assert.equal(h.gate.view(C).delayedMs, (BOUNDARY - PEAK) * 2, 'the explicit-ON child absorbed its subtree’s delay')
})

test('A24 — a view aggregates its subtree counters and the revision moves only with rendered fields', async () => {
  const OTHER_CHILD = 'tree-other-child'
  const h = gateFixture({ at: PEAK })
  h.gate.observeSession(C, P)
  h.gate.observeSession(G, C)
  h.gate.observeSession(OTHER_CHILD, R)
  await h.gate.setEnabled(P, true)
  await h.gate.setEnabled(R, true)

  const parentHold = h.gate.wait(P)
  await settle()
  h.clock.set(PEAK + 60_000)
  const childHold = h.gate.wait(C)
  await settle()
  const unrelatedHold = h.gate.wait(R)
  await settle()
  h.clock.set(PEAK + 120_000)
  const grandHold = h.gate.wait(G)
  await settle()
  assert.equal(h.clock.waiting(), 4, 'the tree and the unrelated root are parked')

  const parent = h.gate.view(P)
  assert.equal(parent.holding, 3, 'the parent subtree holds the parent, the child and the grandchild')
  assert.equal(parent.ownHolding, 1)
  assert.equal(parent.since, PEAK, 'since is the OLDEST park in the whole subtree')
  assert.equal(parent.releaseAt, BOUNDARY)
  assert.equal(parent.heldTotal, 3, 'heldTotal sums the tracked subtree')
  assert.equal(parent.delayedMs, 0, 'nothing has been released yet')
  assert.equal(parent.otherHolding, 1, 'the unrelated root’s hold is outside this subtree')

  const child = h.gate.view(C)
  assert.equal(child.holding, 2, 'the child view is its own subtree, not its parent’s')
  assert.equal(child.ownHolding, 1)
  assert.equal(child.since, PEAK + 60_000, 'the child subtree’s oldest park is the child’s own')
  assert.equal(child.otherHolding, 2, 'the parent’s own hold plus the unrelated root')

  const grand = h.gate.view(G)
  assert.equal(grand.holding, 1)
  assert.equal(grand.ownHolding, 1)
  assert.equal(grand.otherHolding, 3, 'everything outside the grandchild’s own subtree')

  const unrelated = h.gate.view(R)
  assert.equal(unrelated.holding, 1)
  assert.equal(unrelated.ownHolding, 1)
  assert.equal(unrelated.otherHolding, 3, 'the whole enabled tree is outside the unrelated root’s subtree')
  assert.equal(unrelated.since, PEAK + 60_000)

  // A pure clock move is not a rendered change: the revision must not move.
  const beforeClock = h.gate.view(P).revision
  h.clock.set(PEAK + 180_000)
  assert.equal(h.gate.view(P).revision, beforeClock, 'a clock move alone must never change the revision')
  assert.notEqual(h.gate.view(P).now, parent.now, 'the fixture must really have moved now, or the negative case is vacuous')

  // A new park inside the subtree is a rendered change for the ancestor’s view.
  const lateHold = h.gate.wait(C)
  await settle()
  const during = h.gate.view(P)
  assert.notEqual(during.revision, beforeClock, 'a subtree counter change is a rendered change for the root')
  assert.equal(during.holding, 4, 'the late request is counted under the root')
  assert.equal(during.ownHolding, 1)

  h.clock.advanceTo(BOUNDARY)
  const [parentDone, childDone, unrelatedDone, grandDone, lateDone] = await withDeadline(
    Promise.all([parentHold, childHold, unrelatedHold, grandHold, lateHold]), 500, 'the aggregated holds',
  )
  const subtreeDelay = parentDone.waitedMs + childDone.waitedMs + grandDone.waitedMs + lateDone.waitedMs
  const after = h.gate.view(P)
  assert.equal(after.holding, 0)
  assert.equal(after.since, null, 'since clears when nothing in the subtree is parked')
  assert.equal(after.releaseAt, null, 'releaseAt clears when nothing in the subtree is parked')
  assert.equal(after.heldTotal, 4, 'every request parked in the subtree is counted')
  assert.equal(after.delayedMs, subtreeDelay, 'delayedMs is the summed dispatch delay of the subtree')
  assert.notEqual(after.revision, during.revision, 'the counters that changed on release are rendered fields')
  assert.equal(h.gate.view(R).delayedMs, unrelatedDone.waitedMs, 'the unrelated root keeps its own counters')
  assert.equal(h.gate.view(R).heldTotal, 1)
})

test('A25 — the live parentOf fallback resolves a tree, observeSession overrides it, cycles end as roots, and the link cache is bounded', async () => {
  // 1. Live fallback: no session/created was ever delivered.
  const links = new Map<string, string>([[C, P], [G, C]])
  const asked: string[] = []
  const h = gateFixture({
    at: PEAK,
    parentOf: (sessionId) => {
      asked.push(sessionId)
      return links.get(sessionId)
    },
  })
  await h.gate.setEnabled(P, true)
  assert.deepEqual(position(h.gate.view(C)), { enabled: true, source: 'inherited', inheritedFrom: P }, 'a session that was never announced still follows the live link')
  assert.deepEqual(position(h.gate.view(G)), { enabled: true, source: 'inherited', inheritedFrom: P })
  assert.ok(asked.includes(C), 'the unresolved link must have been asked from the live resolver')

  // 2. A session/created announcement overrides the live guess. Re-parent the
  // child onto a second explicit root: its old parent's subtree loses it.
  const SECOND = 'tree-parent-2'
  await h.gate.setEnabled(SECOND, true)
  links.set(C, SECOND)
  h.gate.observeSession(C, SECOND)
  assert.deepEqual(position(h.gate.view(C)), { enabled: true, source: 'inherited', inheritedFrom: SECOND }, 'an announced link must win over the live guess')
  const childHold = h.gate.wait(C)
  await settle()
  assert.equal(h.gate.view(P).holding, 0, 'the re-parented child must leave its old parent’s subtree')
  assert.equal(h.gate.view(SECOND).holding, 1)
  assert.equal(h.gate.view(SECOND).ownHolding, 0, 'the second root itself holds nothing')
  await h.gate.setEnabled(P, false)
  assert.equal(h.clock.waiting(), 1, 'switching the old parent off must not release the re-parented child')
  assert.equal(h.gate.view(C).holding, 1)
  await h.gate.setEnabled(SECOND, false)
  const released = await withDeadline(childHold, 500, 'the re-parented child')
  assert.equal(released.released, true, 'the announced parent’s release reaches the child')
  assert.equal(h.clock.waiting(), 0)

  // 3. Cycles and self-links are roots, never hangs; a cycle still resolves the
  // nearest explicit ancestor for a member that is not on the cycle path start.
  const cyc = gateFixture({ at: PEAK })
  cyc.gate.observeSession('cycle-a', 'cycle-b')
  cyc.gate.observeSession('cycle-b', 'cycle-a')
  cyc.gate.observeSession('self', 'self')
  assert.equal(cyc.gate.view('cycle-a').source, 'default', 'a pure cycle has no explicit ancestor, so the default applies')
  assert.equal(cyc.gate.view('self').source, 'default')
  await cyc.gate.setEnabled('cycle-a', true)
  assert.deepEqual(position(cyc.gate.view('cycle-b')), { enabled: true, source: 'inherited', inheritedFrom: 'cycle-a' })
  const cycleHold = cyc.gate.wait('cycle-b')
  await settle()
  assert.equal(cyc.gate.view('cycle-a').holding, 1, 'the cycle is walked exactly once')
  cyc.clock.advanceTo(BOUNDARY)
  await withDeadline(cycleHold, 500, 'the cyclic-tree hold')
  assert.equal(cyc.gate.view('cycle-a').holding, 0)

  // 4. The link cache is bounded: a very old link is dropped and re-resolved by
  // the live fallback, while a recent one is still cached.
  const boundedAsked: string[] = []
  const bounded = gateFixture({
    at: PEAK,
    parentOf: (sessionId) => {
      boundedAsked.push(sessionId)
      return undefined
    },
  })
  for (let index = 0; index < 4200; index += 1) bounded.gate.view(`bounded-${index}`)
  const settledCalls = boundedAsked.length
  assert.ok(settledCalls >= 4200, `each never-linked session must be resolved once (saw ${settledCalls})`)
  bounded.gate.view('bounded-4199')
  assert.equal(boundedAsked.length, settledCalls, 'a recently resolved link is still cached')
  bounded.gate.view('bounded-0')
  assert.equal(boundedAsked.length, settledCalls + 1, 'the oldest link was evicted and re-resolved from the live fallback')
})

test('A26 — apply() registers exactly one session/created listener, and an event makes the tree resolve', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })

  const created = h.listeners.get('session/created')
  assert.equal(created?.length, 1, 'apply() must register exactly one session/created listener')
  assert.equal(h.events.filter((entry) => entry.event === 'session/created').length, 1, 'and only one registration of it')
  assert.equal(h.events.filter((entry) => entry.event === 'llm/stream').length, 1, 'the one llm/stream interception point is unchanged')

  const WIRE_PARENT = 'wire-parent'
  const WIRE_CHILD = 'wire-child'
  const WIRE_GRAND = 'wire-grand'
  const view = async (sessionId: string): Promise<GateView> => (await send(h, { query: gateQuery(sessionId) })).json() as GateView

  // Flip the parent through the wire; before the announcement exists the child is
  // just another default session.
  const flipped = await send(h, { method: 'POST', headers: JSON_HEADERS, body: gateBody(WIRE_PARENT, true) })
  assert.equal(flipped.status, 200)
  assert.deepEqual(position(await view(WIRE_CHILD)), { enabled: false, source: 'default', inheritedFrom: null })

  const announce = (sessionId: string, parentSession: string | undefined): void => {
    const listener = created?.[0]
    assert.ok(listener !== undefined, 'the session/created listener must be registered')
    assert.doesNotThrow(() => {
      listener({ id: sessionId, header: { parentSession, version: 4, id: sessionId, createdAt: 0, isSeeded: false } })
    }, 'a link announcement must never throw and veto creation')
  }
  announce(WIRE_CHILD, WIRE_PARENT)
  assert.deepEqual(position(await view(WIRE_CHILD)), { enabled: true, source: 'inherited', inheritedFrom: WIRE_PARENT }, 'the session/created link must make the parent switch reach the child')
  assert.equal((await view(WIRE_CHILD)).changedAt, null, 'the child itself has no switch instant')
  assert.equal((await view(WIRE_CHILD)).durable, false, 'the child’s position is not its own durable choice')

  announce(WIRE_GRAND, WIRE_CHILD)
  assert.deepEqual(position(await view(WIRE_GRAND)), { enabled: true, source: 'inherited', inheritedFrom: WIRE_PARENT }, 'the whole announced chain resolves through the gate')

  // A hostile announcement can never veto session creation...
  assert.doesNotThrow(() => { created?.[0]?.({ get id(): never { throw new Error('hostile session') } }) })
  assert.doesNotThrow(() => { created?.[0]?.(null) })
  assert.doesNotThrow(() => { created?.[0]?.(undefined) })
  // ...and it cannot corrupt the tree that was learned.
  assert.deepEqual(position(await view(WIRE_CHILD)), { enabled: true, source: 'inherited', inheritedFrom: WIRE_PARENT })
  assert.equal((await send(h, { method: 'POST', headers: JSON_HEADERS, body: gateBody(WIRE_PARENT, false) })).status, 200)
  assert.deepEqual(position(await view(WIRE_CHILD)), { enabled: false, source: 'inherited', inheritedFrom: WIRE_PARENT }, 'the release reaches the announced subtree too')
})

/* ------------------------------------------------------------------ *
 * B. Wire
 * ------------------------------------------------------------------ */

const GATE_ROUTE = `${API_PREFIX}/gate`
/** The one accepted gate-read query string: exactly one session. */
const gateQuery = (sessionId: string): string => '?session=' + encodeURIComponent(sessionId)
/** The one accepted gate-write body: exactly the session and the boolean. */
const gateBody = (sessionId: string, enabled: boolean): string => JSON.stringify({ session: sessionId, enabled })

interface FakeResponse {
  status: number
  headers: Record<string, unknown>
  body: string
  ended: boolean
  destroyed: boolean
  readonly writableEnded: boolean
  writeHead(status: number, headers?: Record<string, unknown>): FakeResponse
  end(text?: string): FakeResponse
  once(event: string, listener: () => void): FakeResponse
  off(event: string, listener: () => void): FakeResponse
}

/** Minimal node:http `ServerResponse` double: status, headers, body, close. */
function createResponse(): FakeResponse {
  const closeListeners = new Set<() => void>()
  const res: FakeResponse = {
    status: 0, headers: {}, body: '', ended: false, destroyed: false,
    get writableEnded() { return res.ended },
    writeHead(status, headers) { res.status = status; if (headers !== undefined) res.headers = { ...headers }; return res },
    end(text) { if (typeof text === 'string') res.body = text; res.ended = true; return res },
    once(event, listener) { if (event === 'close') closeListeners.add(listener); return res },
    off(event, listener) { closeListeners.delete(listener); return res },
  }
  return res
}

interface WireHarness {
  readonly routes: Map<string, (req: unknown, res: unknown) => unknown>
  readonly listeners: Map<string, Array<(...args: unknown[]) => unknown>>
  /** Every `ctx.on` registration, with the options the host asked for. */
  readonly events: Array<{ readonly event: string, readonly options: unknown }>
  readonly directory: string
  cleanup(): void
}

/**
 * The plugin's own entry point against a fake Cordis context: `apply()` is what
 * registers the `/gate` route and the `llm/stream` listener, so driving the
 * route through this harness is the same code path the GUI uses. Only the two
 * required DSH capabilities are stubbed, and the gate's state file is redirected
 * into a temp directory so no test can inherit another test's choice.
 */
function wireHarness(config: PluginConfig = {}): WireHarness {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-api-cost-wire-'))
  const routes = new Map<string, (req: unknown, res: unknown) => unknown>()
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const events: Array<{ readonly event: string, readonly options: unknown }> = []
  const disposers: Array<() => void> = []
  const webServer = {
    register(route: { path: string, handler: (req: unknown, res: unknown) => unknown }) {
      assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`)
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  const services: Record<string, unknown> = { webServer }
  const effect = (callback: () => unknown): (() => void) => {
    const disposer = callback()
    if (typeof disposer === 'function') disposers.push(disposer as () => void)
    return () => { if (typeof disposer === 'function') (disposer as () => void)() }
  }
  const ctx = {
    sessionProjections: {
      register: () => () => {},
      onChanged: () => () => {},
    },
    sessionQuery: { observeSession: async () => { throw new Error('the gate tests never read session history') } },
    webServer,
    get: (service: string) => services[service],
    effect,
    inject(dependencies: readonly string[], callback: (inner: unknown) => void) {
      if (!dependencies.every((dependency) => services[dependency] !== undefined)) return
      const inner: Record<string, unknown> = { get: ctx.get, effect, on: ctx.on, interval: () => () => {} }
      for (const dependency of dependencies) inner[dependency] = services[dependency]
      callback(inner)
    },
    on(event: string, listener: (...args: unknown[]) => unknown, options?: unknown) {
      events.push({ event, options })
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => { listeners.set(event, list.filter((entry) => entry !== listener)) }
    },
    interval: () => () => {},
  }
  const gateConfig: GateConfig = { path: join(directory, 'gate.json'), ...(config.gate ?? {}) }
  apply(ctx as never, { ...config, gate: gateConfig })
  return {
    routes, listeners, events, directory,
    cleanup() { for (const dispose of [...disposers].reverse()) dispose(); rmSync(directory, { recursive: true, force: true }) },
  }
}

interface WireResponse {
  status: number
  headers: Record<string, unknown>
  body: string
  json(): unknown
}

async function send(h: WireHarness, options: {
  method?: string
  headers?: Record<string, string>
  body?: string
  path?: string
  /** Appended to `req.url` only; the route is still looked up by `path`. */
  query?: string
} = {}): Promise<WireResponse> {
  const path = options.path ?? GATE_ROUTE
  const handler = h.routes.get(path)
  assert.ok(handler !== undefined, `apply() must register ${path}`)
  const res = createResponse()
  const body = options.body === undefined ? undefined : Buffer.from(options.body, 'utf8')
  const req = {
    method: options.method ?? 'GET',
    url: path + (options.query ?? ''),
    headers: options.headers ?? {},
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield body },
  }
  await (handler as (request: unknown, response: unknown) => Promise<void>)(req, res)
  return { status: res.status, headers: res.headers, body: res.body, json: () => JSON.parse(res.body) as unknown }
}

const PATH_PATTERNS = [/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/, /\/node_modules\//, /\/Users\//, /\/home\//, /file:\/\//]
function assertNoPathLeak(response: WireResponse, label: string): void {
  for (const pattern of PATH_PATTERNS) {
    assert.ok(!pattern.test(response.body), `${label}: the response must not leak a file path (matched ${String(pattern)}): ${response.body}`)
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' }

test('B1 — GET with a session returns 200 with a per-session ETag, and a matching If-None-Match returns 304 with no body', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })

  const first = await send(h, { query: gateQuery(S) })
  assert.equal(first.status, 200)
  assert.equal(first.headers['content-type'], 'application/json; charset=utf-8')
  const view = first.json()
  assert.ok(validGateView(view), 'the GET body must satisfy the client wire validator')
  assert.equal((view as GateView).sessionId, S)
  const etag = first.headers['etag']
  assert.equal(typeof etag, 'string', 'a gate read must carry an ETag')
  assert.equal(etag, `"${(view as GateView).revision}"`, 'the ETag must be the quoted revision')
  assertNoPathLeak(first, 'B1 GET 200')

  const second = await send(h, { query: gateQuery(S), headers: { 'if-none-match': etag as string } })
  assert.equal(second.status, 304)
  assert.equal(second.body, '', 'a 304 must carry no body')
  assert.equal(second.headers['etag'], etag)

  const other = await send(h, { query: gateQuery(T) })
  assert.equal(other.status, 200, 'the ETag of one session must not validate another session\'s read')
  assert.notEqual(other.headers['etag'], etag)

  const stale = await send(h, { query: gateQuery(S), headers: { 'if-none-match': '"not-the-revision"' } })
  assert.equal(stale.status, 200, 'a non-matching validator must re-read the view')
})

test('B2 — POST {"session":…,"enabled":true} flips that view and answers with a valid GateView', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })

  const before = (await send(h, { query: gateQuery(S) })).json() as GateView
  assert.equal(before.enabled, false, 'a fresh store means the feature starts off')
  assert.equal(before.state, 'off')

  const posted = await send(h, { method: 'POST', headers: JSON_HEADERS, body: gateBody(S, true) })
  assert.equal(posted.status, 200)
  const view = posted.json()
  assert.ok(validGateView(view), 'the POST body must satisfy the client wire validator')
  assert.equal((view as GateView).sessionId, S)
  assert.equal((view as GateView).enabled, true, 'the answer must be the host value')
  assert.notEqual((view as GateView).revision, before.revision, 'a flipped flag is a revision change')
  assertNoPathLeak(posted, 'B2 POST 200')

  const after = (await send(h, { query: gateQuery(S) })).json() as GateView
  assert.equal(after.enabled, true, 'the flip must be visible on the next read')
  assert.equal(after.revision, (view as GateView).revision)

  const off = await send(h, { method: 'POST', headers: JSON_HEADERS, body: gateBody(S, false) })
  assert.equal(off.status, 200)
  assert.equal((off.json() as GateView).enabled, false)
  assert.equal((off.json() as GateView).sessionId, S)
})

test('B3 — every rejection rule produces its exact status, in the documented order', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })

  // Cross-site first: a foreign page must never flip the switch, and it must
  // not even get as far as the content-type or body rules.
  const crossSite = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' }, body: gateBody(S, true) })
  assert.equal(crossSite.status, 403)
  assert.equal((crossSite.json() as { code: string }).code, 'CROSS_SITE')
  const crossSiteWins = await send(h, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, body: 'not json' })
  assert.equal(crossSiteWins.status, 403, 'the cross-site rule must run before the content-type rule')

  // Content type before the body is read: a malformed body with the wrong type
  // must report the type, not the body.
  const wrongType = await send(h, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: gateBody(S, true) })
  assert.equal(wrongType.status, 415)
  assert.equal((wrongType.json() as { code: string }).code, 'INVALID_CONTENT_TYPE')
  const wrongTypeWins = await send(h, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{' })
  assert.equal(wrongTypeWins.status, 415, 'the content-type rule must run before the body is parsed')
  const parameters = await send(h, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: gateBody(S, true) })
  assert.equal(parameters.status, 200, 'content-type parameters are allowed')

  // Body shape: exactly {session: string, enabled: boolean}.
  for (const body of [
    '{', '', '[true]', '"true"', 'null', '{}',
    '{"enabled":true}',
    `{"session":"${S}"}`,
    `{"session":1,"enabled":true}`,
    `{"session":"${S}","enabled":"true"}`,
    `{"session":"${S}","enabled":1}`,
    `{"session":"${S}","enabled":true,"extra":1}`,
    `{"Enabled":true,"session":"${S}"}`,
  ]) {
    const rejected = await send(h, { method: 'POST', headers: JSON_HEADERS, body })
    assert.equal(rejected.status, 400, `body ${JSON.stringify(body)} must be a 400, got ${rejected.status}`)
    assert.equal((rejected.json() as { code: string }).code, 'INVALID_BODY', `body ${JSON.stringify(body)} must report INVALID_BODY`)
  }

  // The size bound is the boundary itself: 4096 bytes is accepted, 4097 is not.
  const base = gateBody(S, true)
  const atLimit = base + ' '.repeat(4096 - base.length)
  const overLimit = base + ' '.repeat(4097 - base.length)
  assert.equal(Buffer.byteLength(atLimit, 'utf8'), 4096)
  assert.equal((await send(h, { method: 'POST', headers: JSON_HEADERS, body: atLimit })).status, 200, 'exactly 4096 bytes must be accepted')
  const oversized = await send(h, { method: 'POST', headers: JSON_HEADERS, body: overLimit })
  assert.equal(oversized.status, 400, 'a body over 4096 bytes must be rejected')
  assert.equal((oversized.json() as { code: string }).code, 'INVALID_BODY')

  // Method.
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const rejected = await send(h, { method, headers: JSON_HEADERS, body: gateBody(S, true) })
    assert.equal(rejected.status, 405, `${method} must be a 405`)
    assert.equal(rejected.headers['allow'], 'GET, POST', `${method} must advertise both supported methods`)
    assert.equal(rejected.body, '', 'a 405 must carry no body')
  }
  assertNoPathLeak(crossSite, 'B3 cross-site')
  assertNoPathLeak(wrongType, 'B3 content-type')
  assertNoPathLeak(oversized, 'B3 oversized')
})

test('B4 — a same-origin POST succeeds and a mismatching Origin is refused', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })
  const host = '127.0.0.1:19387'

  const matching = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, host, origin: `http://${host}` }, body: gateBody(S, true) })
  assert.equal(matching.status, 200, 'the panel talks to its own origin')
  assert.equal((matching.json() as GateView).enabled, true)

  const secure = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, host, origin: `https://${host}` }, body: gateBody(S, true) })
  assert.equal(secure.status, 200, 'the https form of the same host is the same origin')

  for (const origin of ['http://evil.example', `http://${host}.evil.example`, 'null', `https://${host}:1`]) {
    const refused = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, host, origin }, body: gateBody(S, true) })
    assert.equal(refused.status, 403, `Origin ${origin} must be refused`)
    assert.equal((refused.json() as { code: string }).code, 'CROSS_SITE')
  }

  const noHost = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, origin: `http://${host}` }, body: gateBody(S, true) })
  assert.equal(noHost.status, 403, 'an Origin we cannot check against Host must be refused')

  const absent = await send(h, { method: 'POST', headers: JSON_HEADERS, body: gateBody(S, true) })
  assert.equal(absent.status, 200, 'no Origin header at all is not a cross-site request')
  assertNoPathLeak(matching, 'B4 matching origin')
  assertNoPathLeak(noHost, 'B4 missing host')
})

test('B5 — no gate response body contains a filesystem path', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })
  const responses: Array<[string, WireResponse]> = [
    ['GET 200', await send(h, { query: gateQuery(S) })],
    ['POST 200', await send(h, { method: 'POST', headers: JSON_HEADERS, body: gateBody(S, true) })],
    ['GET 304', await send(h, { query: gateQuery(S), headers: { 'if-none-match': `"${((await send(h, { query: gateQuery(S) })).json() as GateView).revision}"` } })],
    ['POST 403', await send(h, { method: 'POST', headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' }, body: gateBody(S, true) })],
    ['POST 415', await send(h, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: gateBody(S, true) })],
    ['POST 400', await send(h, { method: 'POST', headers: JSON_HEADERS, body: '{' })],
    ['PUT 405', await send(h, { method: 'PUT', headers: JSON_HEADERS, body: gateBody(S, true) })],
  ]
  for (const [label, response] of responses) assertNoPathLeak(response, `B5 ${label}`)
  const body = (await send(h, { query: gateQuery(S) })).body
  assert.ok(!body.includes(h.directory), 'the response must never name the gate state file')
})

/* ------------------------------------------------------------------ *
 * E. Wiring facts the claims above depend on
 * ------------------------------------------------------------------ */

test('E1 — isPricedModel accepts the two canonical ids and the documented aliases', () => {
  for (const model of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.equal(isPricedModel(model), true, `${model} must be priced so the gate holds it`)
  }
  for (const model of ['gpt-5-nope', '', undefined, null, 42]) {
    assert.equal(isPricedModel(model), false, `${JSON.stringify(model)} must not be priced`)
  }
})

test('E2 — apply() registers the llm/stream listener, the one session/created link listener and the /gate route over one per-session gate', async (t) => {
  // `models: 'priced'` makes the listener's bypass branch tier-independent, so
  // this test cannot flake on a suite that happens to run inside a peak window.
  const E2_SESSION = 'session-e2'
  const h = wireHarness({ gate: { enabled: true, models: 'priced' } })
  t.after(() => { h.cleanup() })
  assert.deepEqual([...h.routes.keys()].sort(), [`${API_PREFIX}/gate`, `${API_PREFIX}/pricing`, `${API_PREFIX}/view`].sort())
  // The host half's whole event surface: one model-call interception point plus
  // the one announcement listener that teaches the gate the delegation tree.
  // Nothing else about the wait is visible as an event.
  assert.deepEqual([...h.listeners.keys()].sort(), ['llm/stream', 'session/created'].sort(), 'the gate may register exactly the two documented listeners')
  assert.equal(h.events.filter((entry) => entry.event === 'llm/stream').length, 1, 'exactly one llm/stream registration')
  assert.equal(h.events.filter((entry) => entry.event === 'session/created').length, 1, 'exactly one session/created registration')
  assert.equal(h.listeners.get('session/created')?.length, 1, 'exactly one session/created listener')
  // Prepended, so a downstream middleware (retry, replay, routing) can never
  // dispatch around the hold: the registration is the outermost wrapper.
  const streamEvents = h.events.filter((entry) => entry.event === 'llm/stream')
  assert.equal((streamEvents[0]?.options as { prepend?: unknown } | undefined)?.prepend, true, 'the llm/stream listener must be prepended')
  const registered = h.listeners.get('llm/stream')
  assert.equal(registered?.length, 1, 'apply() must register exactly one llm/stream listener')

  // The listener is synchronous by contract: a Promise here would replace every
  // model call's chunk stream with a promise.
  const produced = scriptedNext(createClock(PEAK)).next()
  const returned = registered?.[0]?.({ model: 'gpt-5-nope' }, () => produced)
  assert.equal(typeof (returned as { then?: unknown })?.then, 'undefined', 'the listener must never return a promise')
  assert.equal(returned, produced, 'an unpriced model under models:priced must bypass the gate by identity')

  // A session-less call is never gated, whatever the tier is.
  const sessionlessProduced = scriptedNext(createClock(PEAK)).next()
  const sessionlessReturned = registered?.[0]?.({ model: 'deepseek-flash' }, () => sessionlessProduced)
  assert.equal(typeof (sessionlessReturned as { then?: unknown })?.then, 'undefined')
  assert.equal(sessionlessReturned, sessionlessProduced, 'a call without a session must bypass the gate by identity')

  // A priced, session-stamped call reaches the gate; whatever the real tier is,
  // the value is still an iterable and never a promise.
  const pricedProduced = scriptedNext(createClock(PEAK)).next()
  const pricedReturned = registered?.[0]?.({ model: 'deepseek-flash', sessionId: E2_SESSION }, () => pricedProduced)
  assert.equal(typeof (pricedReturned as { then?: unknown })?.then, 'undefined')
  assert.equal(typeof (pricedReturned as AsyncIterable<unknown>)?.[Symbol.asyncIterator], 'function')

  // The route and the listener share one gate, and the switch is per session:
  // turning `session-e2` off is visible to the listener's synchronous decision,
  // while a different session still inherits the configured default (on).
  const flipped = (await send(h, { method: 'POST', headers: JSON_HEADERS, body: gateBody(E2_SESSION, false) })).json() as GateView
  assert.equal(flipped.sessionId, E2_SESSION)
  assert.equal(flipped.enabled, false)
  assert.equal(((await send(h, { query: gateQuery(E2_SESSION) })).json() as GateView).enabled, false)
  assert.equal(((await send(h, { query: gateQuery(T) })).json() as GateView).enabled, true, 'another session still inherits the configured default')
  const afterOff = scriptedNext(createClock(PEAK)).next()
  assert.equal(registered?.[0]?.({ model: 'deepseek-flash', sessionId: E2_SESSION }, () => afterOff), afterOff, 'the listener must observe the per-session switch the route flipped')
})

test('E3 — the read rule is not relaxed: /view and /pricing stay GET-only, and the gate read is not cross-site readable', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })

  // §5 is explicit that the gate must not turn the read surface into a mutation
  // surface: a POST to the cost routes stays a 405 with `Allow: GET`.
  for (const path of [`${API_PREFIX}/view`, `${API_PREFIX}/pricing`]) {
    const rejected = await send(h, { method: 'POST', headers: JSON_HEADERS, body: gateBody(S, true), path })
    assert.equal(rejected.status, 405, `POST ${path} must stay a 405`)
    assert.equal(rejected.headers['allow'], 'GET', `POST ${path} must advertise GET only`)
    assert.equal(rejected.body, '', `POST ${path} must carry no body`)
  }

  // A cross-site page must not be able to read the flag either.
  const crossSite = await send(h, { query: gateQuery(S), headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403, 'a cross-site gate read must be refused')
  assert.equal((crossSite.json() as { code: string }).code, 'CROSS_SITE')
  const sameOrigin = await send(h, { query: gateQuery(S), headers: { 'sec-fetch-site': 'same-origin' } })
  assert.equal(sameOrigin.status, 200, 'the panel\'s own read must succeed')
})
