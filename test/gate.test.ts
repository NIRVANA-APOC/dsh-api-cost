/**
 * dsh-api-cost — off-peak gate verification, unit and wire half (T4, adversarial).
 *
 * Every test here drives the real `src/host/gate.ts` through the frozen
 * interface in docs/off-peak-gate.md §4, or the real `/gate` route through the
 * handler `src/host/http.ts` registered on a fake `webServer`. Nothing in this
 * file re-implements gate logic: where a double is needed it is a *clock*, a
 * *store*, or a *pricing status script*, never a second copy of the state
 * machine under test.
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

interface MemoryStore extends GateStore {
  readonly writes: readonly boolean[]
  value: boolean | undefined
}

/**
 * The store double. The gate tests never reach the real home directory, so a
 * flag written by one test can never enable the gate in the next one.
 */
function memoryStore(initial?: boolean): MemoryStore {
  const state = { value: initial, writes: [] as boolean[] }
  return {
    read: () => state.value,
    write(enabled) { state.value = enabled; state.writes.push(enabled); return true },
    get writes() { return state.writes },
    get value() { return state.value },
    set value(next) { state.value = next },
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
} = {}): GateFixture {
  const clock = createClock(options.at ?? PEAK)
  const store = memoryStore()
  const changes: number[] = []
  const gate = createOffPeakGate({
    engine: options.engine ?? engine,
    config: options.config ?? {},
    clock: options.clock ?? clock,
    store: options.store ?? store,
    onChange: () => { changes.push(clock.now()) },
  })
  return { clock, gate, store, changes }
}

/* ------------------------------------------------------------------ *
 * A. Hold semantics
 * ------------------------------------------------------------------ */

test('A1 — at a peak instant the first pull is parked, then dispatched exactly once at the boundary', async () => {
  const h = gateFixture({ config: { enabled: true } })
  assert.equal(h.gate.view().peak, true, 'the fixture must start inside a peak window')
  assert.equal(h.gate.view().state, 'holding', 'enabled inside a peak window is the holding state')

  const script = scriptedNext(h.clock)
  const iterator = h.gate.middleware({}, script.next)[Symbol.asyncIterator]()
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
  assert.equal(h.gate.view().holding, 0, 'the released request must leave the counter')
})

test('A2 — off-peak with the gate on, middleware returns the identical object next() produced', () => {
  const h = gateFixture({ at: OFF_PEAK, config: { enabled: true } })
  assert.equal(h.gate.view().peak, false, 'the fixture must be off-peak')
  const produced = scriptedNext(h.clock).next()
  const returned = h.gate.middleware({}, () => produced)
  assert.equal(returned, produced, 'the very same AsyncIterable must be returned, not a wrapper')
  assert.equal(h.clock.waiting(), 0, 'no timer may be armed off-peak')
})

test('A3 — at peak with the gate off, middleware returns the identical object next() produced', () => {
  const h = gateFixture({ at: PEAK, store: memoryStore(false) })
  assert.equal(h.gate.view().enabled, false, 'the fixture must have the gate off')
  assert.equal(h.gate.view().state, 'off')
  const produced = scriptedNext(h.clock).next()
  assert.equal(h.gate.middleware({}, () => produced), produced)
  assert.equal(h.clock.waiting(), 0)
})

test('A4 — the gated chunk sequence is deepEqual to the ungated one, with nothing injected', async () => {
  // Baseline through the same `next()` script, with no gate in the way at all.
  const ungated = await collect(scriptedNext(createClock(PEAK)).next())

  const h = gateFixture({ config: { enabled: true } })
  const script = scriptedNext(h.clock)
  const iterator = h.gate.middleware({}, script.next)[Symbol.asyncIterator]()
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
  const h = gateFixture({ config: { enabled: true } })
  const controller = new AbortController()
  const script = scriptedNext(h.clock)
  const iterator = h.gate.middleware({ signal: controller.signal }, script.next)[Symbol.asyncIterator]()
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
  const h = gateFixture({ config: { enabled: true } })
  const script = scriptedNext(h.clock)
  const iterator = h.gate.middleware({}, script.next)[Symbol.asyncIterator]()
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

test('A7 — setEnabled(false) during a hold releases the parked waiter at once', async () => {
  const h = gateFixture({ config: { enabled: true } })
  const script = scriptedNext(h.clock)
  const iterator = h.gate.middleware({}, script.next)[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()
  const parked = h.gate.view()
  assert.equal(parked.holding, 1)
  assert.equal(parked.since, PEAK, 'since is the instant the parked request started waiting')
  assert.equal(parked.releaseAt, BOUNDARY)

  const off = await h.gate.setEnabled(false)
  assert.equal(off.enabled, false)
  const first = await withDeadline(firstPull, 500, 'the released hold')
  assert.equal(script.delegations(), 1, 'turning the gate off must release, not abandon, the request')
  assert.deepEqual(first.value, SCRIPT[0])
  assert.equal(h.clock.waiting(), 0)
  assert.equal(h.gate.view().holding, 0)
  assert.equal(h.gate.view().state, 'off')
})

test('A8 — a sleep past 2^31-1 ms is clamped and re-armed, and an early wake while peak re-arms', async () => {
  // 5e9 ms is ~57 days: the real setTimeout would overflow and fire at once.
  const { engine: farEngine, script } = scriptedEngine({ ...PEAK_VIEW, peak: true, next: { at: PEAK + 5_000_000_000, peak: false } })
  const h = gateFixture({ engine: farEngine, config: { enabled: true } })
  const next = scriptedNext(h.clock)
  const iterator = h.gate.middleware({}, next.next)[Symbol.asyncIterator]()
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
  assert.equal(h.gate.view().state, 'holding')
  assert.equal(next.startedAt(), null)

  // The tier actually turns off-peak: the next wake must release.
  script.view = engine.status(BOUNDARY)
  h.clock.fireEarly()
  const first = await withDeadline(firstPull, 500, 'the re-armed hold')
  assert.equal(next.delegations(), 1, 'the re-armed hold must release exactly once when the tier turns')
  assert.deepEqual(first.value, SCRIPT[0])
})

test('A9 — a peak view with next === null releases instead of hanging (fail-open)', async () => {
  const h = gateFixture({ engine: statusEngine(() => ({ ...PEAK_VIEW, peak: true, next: null })), config: { enabled: true } })

  const outcome = await withDeadline(h.gate.wait(), 500, 'the fail-open hold')
  assert.equal(outcome.released, true, 'an unknown boundary must release, not park')
  assert.equal(h.clock.asked.length, 0, 'no timer may be armed when the boundary is unknown')

  const script = scriptedNext(h.clock)
  const emitted = await withDeadline(collect(h.gate.middleware({}, script.next)), 500, 'the fail-open middleware')
  assert.equal(script.delegations(), 1, 'the request must be dispatched rather than parked')
  assert.deepEqual(emitted, [...SCRIPT])
})

test('A10 — a throwing clock and a throwing pricing engine all fail open', async () => {
  const cases: Array<{ label: string, fixture: () => GateFixture }> = [
    { label: 'clock.now throws', fixture: () => gateFixture({ clock: { now() { throw new Error('clock exploded') }, sleep: () => Promise.resolve(true) }, config: { enabled: true } }) },
    { label: 'clock.sleep throws', fixture: () => gateFixture({ clock: { now: () => PEAK, sleep() { throw new Error('timer exploded') } }, config: { enabled: true } }) },
    { label: 'engine.status throws', fixture: () => gateFixture({ engine: statusEngine(() => { throw new Error('pricing exploded') }), config: { enabled: true } }) },
  ]
  for (const { label, fixture } of cases) {
    const h = fixture()
    // view() is a pure read: it may report a degraded value but must never throw.
    let view: GateView | undefined
    assert.doesNotThrow(() => { view = h.gate.view() }, `${label}: view() must never throw`)
    assert.equal(typeof view?.revision, 'string', `${label}: view() must still produce a usable view`)
    assert.equal(view?.enabled, true, `${label}: the user's flag must survive a broken engine`)

    const outcome = await withDeadline(h.gate.wait(), 500, `${label}: wait()`)
    assert.equal(outcome.released, true, `${label}: a broken hold must fail open`)

    // middleware() is the seam that would break every model call if it threw.
    const script = scriptedNext(h.clock)
    let iterable: AsyncIterable<Chunk> | undefined
    assert.doesNotThrow(() => { iterable = h.gate.middleware({}, script.next) }, `${label}: middleware() must never throw`)
    const emitted = await withDeadline(collect(iterable as AsyncIterable<Chunk>), 500, `${label}: the fail-open stream`)
    assert.deepEqual(emitted, [...SCRIPT], `${label}: the fail-open stream must be the provider's own sequence`)
    assert.equal(script.delegations(), 1, `${label}: the call must proceed`)
  }
})

test('A10b — a pricing throw after the hold is armed still releases instead of hanging or rejecting', async () => {
  // `middleware` classifies once to decide whether to wrap (planHold) and the
  // hold re-classifies before arming, so the third call is the post-wake one.
  let calls = 0
  const h = gateFixture({
    engine: statusEngine(() => {
      calls += 1
      if (calls > 2) throw new Error('pricing exploded mid-hold')
      return PEAK_VIEW
    }),
    config: { enabled: true },
  })
  const script = scriptedNext(h.clock)
  const iterator = h.gate.middleware({}, script.next)[Symbol.asyncIterator]()
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
  const h = gateFixture({ config: { enabled: true } })
  const parked = h.gate.wait()
  await settle()
  assert.equal(h.clock.waiting(), 1, 'the fixture must have a parked waiter')

  h.gate.dispose()
  const outcome = await withDeadline(parked, 500, 'the disposed hold')
  assert.equal(typeof outcome.waitedMs, 'number', 'a disposed hold must still report its outcome')
  assert.equal(h.clock.waiting(), 0, 'dispose() must disarm the timer')

  assert.doesNotThrow(() => { h.gate.dispose() }, 'dispose() must be idempotent')
  assert.doesNotThrow(() => { h.gate.view() }, 'view() must stay safe after dispose')
})

test('A12 — holding/since/heldTotal/delayedMs are exact across sequential holds', async () => {
  const h = gateFixture({ config: { enabled: true } })

  const first = h.gate.wait()
  await settle()
  const during = h.gate.view()
  assert.equal(during.holding, 1, 'one parked request')
  assert.equal(during.since, PEAK, 'since is when the oldest parked request started waiting')
  assert.equal(during.releaseAt, BOUNDARY, 'releaseAt is the boundary the hold is waiting for')
  h.clock.advanceTo(BOUNDARY)
  const one = await withDeadline(first, 500, 'the first hold')
  assert.equal(one.released, true)
  assert.equal(one.waitedMs, BOUNDARY - PEAK, 'two hours of dispatch delay')

  const afterFirst = h.gate.view()
  assert.equal(afterFirst.holding, 0)
  assert.equal(afterFirst.since, null, 'since must clear when nothing is parked')
  assert.equal(afterFirst.releaseAt, null, 'releaseAt must clear when nothing is parked')
  assert.equal(afterFirst.heldTotal, 1, 'the parked request must be counted')
  assert.equal(afterFirst.delayedMs, one.waitedMs, 'delayedMs is the delay actually applied')

  // The next peak window: the same shape a week later.
  h.clock.set(SECOND_PEAK)
  const second = h.gate.wait()
  await settle()
  assert.equal(h.gate.view().since, SECOND_PEAK)
  assert.equal(h.gate.view().releaseAt, SECOND_BOUNDARY)
  h.clock.advanceTo(SECOND_BOUNDARY)
  const two = await withDeadline(second, 500, 'the second hold')
  assert.equal(two.waitedMs, SECOND_BOUNDARY - SECOND_PEAK)

  const afterSecond = h.gate.view()
  assert.equal(afterSecond.holding, 0)
  assert.equal(afterSecond.heldTotal, 2, 'both parked requests must be counted')
  assert.equal(afterSecond.delayedMs, one.waitedMs + two.waitedMs, 'delayedMs accumulates across holds')
})

test('A12b — two concurrent holds are counted independently and released together', async () => {
  const h = gateFixture({ config: { enabled: true } })
  const first = h.gate.wait()
  const second = h.gate.wait()
  await settle()
  const both = h.gate.view()
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
  const after = h.gate.view()
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
  const h = gateFixture({ config: { enabled: true } })
  const controller = new AbortController()
  const aborted = scriptedNext(h.clock)
  const survivor = scriptedNext(h.clock)
  const first = h.gate.middleware({ signal: controller.signal }, aborted.next)[Symbol.asyncIterator]()
  const second = h.gate.middleware({}, survivor.next)[Symbol.asyncIterator]()
  const firstPull = first.next()
  const secondPull = second.next()
  await settle()
  assert.equal(h.gate.view().holding, 2, 'both requests must be parked')

  controller.abort()
  const firstChunk = await withDeadline(firstPull, 500, 'the aborted request')
  assert.deepEqual(firstChunk.value, SCRIPT[0])
  assert.equal(aborted.delegations(), 1)
  const view = h.gate.view()
  assert.equal(view.holding, 1, 'the survivor must still be parked')
  assert.equal(view.since, PEAK, 'the survivor keeps its own start instant')
  assert.equal(h.clock.waiting(), 1, 'the survivor keeps its own timer')
  assert.equal(survivor.delegations(), 0, 'aborting one request must not dispatch another')
  assert.equal(h.clock.asked.length, 2, 'only the survivor may still be waiting')

  h.clock.advanceTo(BOUNDARY)
  const secondChunk = await withDeadline(secondPull, 500, 'the surviving request')
  assert.deepEqual(secondChunk.value, SCRIPT[0])
  assert.equal(survivor.delegations(), 1)
  assert.equal(h.gate.view().holding, 0)
})

test('A13 — revision moves with a rendered field and never with now/delayedMs alone', async () => {
  const h = gateFixture({ store: memoryStore(false) })
  const off = h.gate.view()

  // Negative case: the clock moves, nothing else does.
  h.clock.advanceTo(PEAK + 60_000)
  const moved = h.gate.view()
  assert.notEqual(moved.now, off.now, 'the fixture must actually move now, or the negative case is vacuous')
  assert.equal(moved.revision, off.revision, 'now must never enter the revision')

  const on = await h.gate.setEnabled(true)
  assert.notEqual(on.revision, off.revision, 'enabling is a rendered change')

  const parked = h.gate.wait()
  await settle()
  const holdingA = h.gate.view()
  h.clock.advanceTo(PEAK + 120_000)
  const holdingB = h.gate.view()
  assert.notEqual(holdingB.now, holdingA.now, 'the clock must really have moved during the hold')
  assert.equal(holdingB.revision, holdingA.revision, 'a hold in progress is not a revision change by itself')

  h.clock.advanceTo(BOUNDARY)
  await withDeadline(parked, 500, 'the hold')
  const released = h.gate.view()
  assert.notEqual(released.revision, holdingB.revision, 'the counters that changed on release are rendered fields')
  assert.equal(released.heldTotal, 1)
})

test('A14 — the durable flag round-trips, degrades on an unwritable path, and honours persist:false', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-api-cost-gate-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const flagged = async (config: GateConfig, store: GateStore): Promise<GateView> =>
    await createOffPeakGate({ engine, config, clock: createClock(PEAK), store }).setEnabled(true)

  // 1. Write, then read back through a second store instance.
  const path = join(directory, 'gate.json')
  const store = defaultGateStore(path)
  assert.equal(store.read(), undefined, 'nothing has been stored yet')
  assert.equal(store.write(true), true, 'a writable path must report a durable write')
  assert.equal(store.read(), true)
  assert.equal(defaultGateStore(path).read(), true, 'a fresh store on the same path must see the flag')
  const stored: unknown = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(Object.keys(stored as object).sort(), ['changedAt', 'enabled', 'version'])
  assert.equal((stored as { version: number }).version, 1)
  assert.equal((stored as { enabled: boolean }).enabled, true)
  assert.equal(typeof (stored as { changedAt: number }).changedAt, 'number')

  // 2. The stored flag wins over the config default, and reports durable.
  const restored = createOffPeakGate({ engine, config: { enabled: false, path }, clock: createClock(PEAK), store: defaultGateStore(path) })
  assert.equal(restored.view().enabled, true, 'the durable flag must win over config.enabled')
  assert.equal(restored.view().durable, true, 'a flag that survived a restart is durable')
  const fresh = createOffPeakGate({ engine, config: { enabled: true }, clock: createClock(PEAK), store: defaultGateStore(join(directory, 'absent.json')) })
  assert.equal(fresh.view().enabled, true, 'with nothing stored, config.enabled is the initial value')
  assert.equal(fresh.view().durable, false, 'an unwritten flag is not durable')

  // 3. A path that cannot be created: in-memory only, no throw, no durability claim.
  const blocked = join(directory, 'blocked')
  writeFileSync(blocked, 'not a directory')
  const unwritable = defaultGateStore(join(blocked, 'gate.json'))
  assert.equal(unwritable.read(), undefined, 'an unreadable store reads as "nothing stored"')
  assert.equal(unwritable.write(true), false, 'an unwritable path must report failure, never throw')
  const degraded = await flagged({ enabled: true, path: join(blocked, 'gate.json') }, unwritable)
  assert.equal(degraded.enabled, true, 'the feature must keep working in memory')
  assert.equal(degraded.durable, false, 'an unwritable path can never claim durability')
  assert.equal(existsSync(join(blocked, 'gate.json')), false)

  // 4. persist:false disables storage entirely.
  const memory = memoryStore()
  const noPersist = await createOffPeakGate({ engine, config: { persist: false }, clock: createClock(PEAK), store: memory }).setEnabled(true)
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
  assert.equal(defaultGateStore().write(true), true, 'the env override must be writable')
  assert.equal(existsSync(explicit), true, 'DSH_API_COST_GATE_FILE must be the store path')
  assert.equal(defaultGateStore().read(), true)

  // A `DSH_HOME` with surrounding whitespace is trimmed, not treated as a path.
  const home = join(directory, 'home')
  process.env['DSH_HOME'] = `  ${home}  `
  delete process.env['DSH_API_COST_GATE_FILE']
  assert.equal(defaultGateStore().write(false), true, 'the home default must be writable')
  assert.equal(existsSync(join(home, 'state', 'dsh-api-cost', 'gate.json')), true, 'the default path must be <dsh home>/state/dsh-api-cost/gate.json')
})

/* ------------------------------------------------------------------ *
 * B. Wire
 * ------------------------------------------------------------------ */

const GATE_ROUTE = `${API_PREFIX}/gate`

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
 * into a temp directory so no test can inherit another test's flag.
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
} = {}): Promise<WireResponse> {
  const path = options.path ?? GATE_ROUTE
  const handler = h.routes.get(path)
  assert.ok(handler !== undefined, `apply() must register ${path}`)
  const res = createResponse()
  const body = options.body === undefined ? undefined : Buffer.from(options.body, 'utf8')
  const req = {
    method: options.method ?? 'GET',
    url: path,
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

test('B1 — GET returns 200 with an ETag, and a matching If-None-Match returns 304 with no body', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })

  const first = await send(h)
  assert.equal(first.status, 200)
  assert.equal(first.headers['content-type'], 'application/json; charset=utf-8')
  const view = first.json()
  assert.ok(validGateView(view), 'the GET body must satisfy the client wire validator')
  const etag = first.headers['etag']
  assert.equal(typeof etag, 'string', 'a gate read must carry an ETag')
  assert.equal(etag, `"${(view as GateView).revision}"`, 'the ETag must be the quoted revision')
  assertNoPathLeak(first, 'B1 GET 200')

  const second = await send(h, { headers: { 'if-none-match': etag as string } })
  assert.equal(second.status, 304)
  assert.equal(second.body, '', 'a 304 must carry no body')
  assert.equal(second.headers['etag'], etag)

  const stale = await send(h, { headers: { 'if-none-match': '"not-the-revision"' } })
  assert.equal(stale.status, 200, 'a non-matching validator must re-read the view')
})

test('B2 — POST {"enabled":true} flips the view and answers with a valid GateView', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })

  const before = (await send(h)).json() as GateView
  assert.equal(before.enabled, false, 'a fresh store means the feature starts off')
  assert.equal(before.state, 'off')

  const posted = await send(h, { method: 'POST', headers: JSON_HEADERS, body: '{"enabled":true}' })
  assert.equal(posted.status, 200)
  const view = posted.json()
  assert.ok(validGateView(view), 'the POST body must satisfy the client wire validator')
  assert.equal((view as GateView).enabled, true, 'the answer must be the host value')
  assert.notEqual((view as GateView).revision, before.revision, 'a flipped flag is a revision change')
  assertNoPathLeak(posted, 'B2 POST 200')

  const after = (await send(h)).json() as GateView
  assert.equal(after.enabled, true, 'the flip must be visible on the next read')
  assert.equal(after.revision, (view as GateView).revision)

  const off = await send(h, { method: 'POST', headers: JSON_HEADERS, body: '{"enabled":false}' })
  assert.equal(off.status, 200)
  assert.equal((off.json() as GateView).enabled, false)
})

test('B3 — every rejection rule produces its exact status, in the documented order', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })

  // Cross-site first: a foreign page must never flip the switch, and it must
  // not even get as far as the content-type or body rules.
  const crossSite = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' }, body: '{"enabled":true}' })
  assert.equal(crossSite.status, 403)
  assert.equal((crossSite.json() as { code: string }).code, 'CROSS_SITE')
  const crossSiteWins = await send(h, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, body: 'not json' })
  assert.equal(crossSiteWins.status, 403, 'the cross-site rule must run before the content-type rule')

  // Content type before the body is read: a malformed body with the wrong type
  // must report the type, not the body.
  const wrongType = await send(h, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"enabled":true}' })
  assert.equal(wrongType.status, 415)
  assert.equal((wrongType.json() as { code: string }).code, 'INVALID_CONTENT_TYPE')
  const wrongTypeWins = await send(h, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{' })
  assert.equal(wrongTypeWins.status, 415, 'the content-type rule must run before the body is parsed')
  const parameters = await send(h, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"enabled":true}' })
  assert.equal(parameters.status, 200, 'content-type parameters are allowed')

  // Body shape.
  for (const body of ['{', '', '[true]', '"true"', '{"enabled":"true"}', '{"enabled":1}', '{"enabled":true,"extra":1}', '{}', 'null', '{"Enabled":true}']) {
    const rejected = await send(h, { method: 'POST', headers: JSON_HEADERS, body })
    assert.equal(rejected.status, 400, `body ${JSON.stringify(body)} must be a 400, got ${rejected.status}`)
    assert.equal((rejected.json() as { code: string }).code, 'INVALID_BODY', `body ${JSON.stringify(body)} must report INVALID_BODY`)
  }

  // The size bound is the boundary itself: 4096 bytes is accepted, 4097 is not.
  const base = '{"enabled":true}'
  const atLimit = base + ' '.repeat(4096 - base.length)
  const overLimit = base + ' '.repeat(4097 - base.length)
  assert.equal(Buffer.byteLength(atLimit, 'utf8'), 4096)
  assert.equal((await send(h, { method: 'POST', headers: JSON_HEADERS, body: atLimit })).status, 200, 'exactly 4096 bytes must be accepted')
  const oversized = await send(h, { method: 'POST', headers: JSON_HEADERS, body: overLimit })
  assert.equal(oversized.status, 400, 'a body over 4096 bytes must be rejected')
  assert.equal((oversized.json() as { code: string }).code, 'INVALID_BODY')

  // Method.
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const rejected = await send(h, { method, headers: JSON_HEADERS, body: '{"enabled":true}' })
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

  const matching = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, host, origin: `http://${host}` }, body: '{"enabled":true}' })
  assert.equal(matching.status, 200, 'the panel talks to its own origin')
  assert.equal((matching.json() as GateView).enabled, true)

  const secure = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, host, origin: `https://${host}` }, body: '{"enabled":true}' })
  assert.equal(secure.status, 200, 'the https form of the same host is the same origin')

  for (const origin of ['http://evil.example', `http://${host}.evil.example`, 'null', `https://${host}:1`]) {
    const refused = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, host, origin }, body: '{"enabled":true}' })
    assert.equal(refused.status, 403, `Origin ${origin} must be refused`)
    assert.equal((refused.json() as { code: string }).code, 'CROSS_SITE')
  }

  const noHost = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, origin: `http://${host}` }, body: '{"enabled":true}' })
  assert.equal(noHost.status, 403, 'an Origin we cannot check against Host must be refused')

  const absent = await send(h, { method: 'POST', headers: JSON_HEADERS, body: '{"enabled":true}' })
  assert.equal(absent.status, 200, 'no Origin header at all is not a cross-site request')
  assertNoPathLeak(matching, 'B4 matching origin')
  assertNoPathLeak(noHost, 'B4 missing host')
})

test('B5 — no gate response body contains a filesystem path', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })
  const responses: Array<[string, WireResponse]> = [
    ['GET 200', await send(h)],
    ['POST 200', await send(h, { method: 'POST', headers: JSON_HEADERS, body: '{"enabled":true}' })],
    ['GET 304', await send(h, { headers: { 'if-none-match': `"${((await send(h)).json() as GateView).revision}"` } })],
    ['POST 403', await send(h, { method: 'POST', headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' }, body: '{"enabled":true}' })],
    ['POST 415', await send(h, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"enabled":true}' })],
    ['POST 400', await send(h, { method: 'POST', headers: JSON_HEADERS, body: '{' })],
    ['PUT 405', await send(h, { method: 'PUT', headers: JSON_HEADERS, body: '{"enabled":true}' })],
  ]
  for (const [label, response] of responses) assertNoPathLeak(response, `B5 ${label}`)
  const body = (await send(h)).body
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

test('E2 — apply() registers the llm/stream listener and the /gate route over one gate', async (t) => {
  // `models: 'priced'` makes the listener's bypass branch tier-independent, so
  // this test cannot flake on a suite that happens to run inside a peak window.
  const h = wireHarness({ gate: { enabled: true, models: 'priced' } })
  t.after(() => { h.cleanup() })
  assert.deepEqual([...h.routes.keys()].sort(), [`${API_PREFIX}/gate`, `${API_PREFIX}/pricing`, `${API_PREFIX}/view`].sort())
  // The host half's whole event surface: one interception point, no session
  // event of its own, which is half of "nothing about the wait is visible".
  assert.deepEqual([...h.listeners.keys()], ['llm/stream'], 'the gate may register exactly one event listener')
  assert.deepEqual(h.events.map((entry) => entry.event), ['llm/stream'])
  // Prepended, so a downstream middleware (retry, replay, routing) can never
  // dispatch around the hold: the registration is the outermost wrapper.
  assert.equal((h.events[0]?.options as { prepend?: unknown } | undefined)?.prepend, true, 'the listener must be prepended')
  const registered = h.listeners.get('llm/stream')
  assert.equal(registered?.length, 1, 'apply() must register exactly one llm/stream listener')

  // The listener is synchronous by contract: a Promise here would replace every
  // model call's chunk stream with a promise.
  const produced = scriptedNext(createClock(PEAK)).next()
  const returned = registered?.[0]?.({ model: 'gpt-5-nope' }, () => produced)
  assert.equal(typeof (returned as { then?: unknown })?.then, 'undefined', 'the listener must never return a promise')
  assert.equal(returned, produced, 'an unpriced model under models:priced must bypass the gate by identity')

  // A priced model reaches the gate; whatever the real tier is, the value is
  // still an iterable and never a promise.
  const pricedProduced = scriptedNext(createClock(PEAK)).next()
  const pricedReturned = registered?.[0]?.({ model: 'deepseek-flash' }, () => pricedProduced)
  assert.equal(typeof (pricedReturned as { then?: unknown })?.then, 'undefined')
  assert.equal(typeof (pricedReturned as AsyncIterable<unknown>)?.[Symbol.asyncIterator], 'function')

  // The route and the listener share one gate: a POST is visible to the next GET.
  const flipped = (await send(h, { method: 'POST', headers: JSON_HEADERS, body: '{"enabled":false}' })).json() as GateView
  assert.equal(flipped.enabled, false)
  assert.equal(((await send(h)).json() as GateView).enabled, false)
})

test('E3 — the read rule is not relaxed: /view and /pricing stay GET-only, and the gate read is not cross-site readable', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })

  // §5 is explicit that the gate must not turn the read surface into a mutation
  // surface: a POST to the cost routes stays a 405 with `Allow: GET`.
  for (const path of [`${API_PREFIX}/view`, `${API_PREFIX}/pricing`]) {
    const rejected = await send(h, { method: 'POST', headers: JSON_HEADERS, body: '{"enabled":true}', path })
    assert.equal(rejected.status, 405, `POST ${path} must stay a 405`)
    assert.equal(rejected.headers['allow'], 'GET', `POST ${path} must advertise GET only`)
    assert.equal(rejected.body, '', `POST ${path} must carry no body`)
  }

  // A cross-site page must not be able to read the flag either.
  const crossSite = await send(h, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403, 'a cross-site gate read must be refused')
  assert.equal((crossSite.json() as { code: string }).code, 'CROSS_SITE')
  const sameOrigin = await send(h, { headers: { 'sec-fetch-site': 'same-origin' } })
  assert.equal(sameOrigin.status, 200, 'the panel\'s own read must succeed')
})
