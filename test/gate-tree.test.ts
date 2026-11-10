/**
 * dsh-api-cost — off-peak gate verification, subtree-scope half (T5/v2.3, adversarial).
 *
 * The claims in this file (V12–V19) are written from the FROZEN CONTRACT before
 * the implementation is trusted:
 *
 *  - `src/shared/contracts.ts` GateView schemaVersion 4: the switch governs one
 *    session AND its delegation subtree. `enabled`/`state` are EFFECTIVE (nearest
 *    explicit choice walking self → parent → …, else the configured default);
 *    `source` is `'self' | 'inherited' | 'default'` and `inheritedFrom` names the
 *    nearest ancestor with an explicit choice. `holding`/`since`/`releaseAt`/
 *    `heldTotal`/`delayedMs` are subtree aggregates; `ownHolding` is this
 *    session's own parked count; `otherHolding` is parked outside this subtree.
 *  - The task contract for `src/host/gate.ts`: `observeSession(sessionId,
 *    parentSession)` records a delegation link (never persisted), an optional
 *    live `parentOf` resolver is the fallback for sessions never announced, the
 *    decision walk is cycle-safe (max depth 64), parent links live in bounded
 *    caches, and turning a session OFF releases only the parked requests that
 *    its change un-gates (an explicit-ON descendant keeps holding).
 *  - `src/host/index.ts`: exactly one `session/created` listener (wrapped so it
 *    can never veto creation) plus the one prepended `llm/stream` listener; the
 *    event teaches the gate the parent link.
 *
 * Nothing in this file re-implements the gate: where a double is needed it is a
 * hand-drained CLOCK, an in-memory STORE, or a fake webServer/ctx — never a
 * second copy of the state machine under test. There are no real sleeps: a hold
 * is observed at exact instants and released by draining the fake clock, so a
 * hang is a failed deadline assertion rather than a slow test.
 *
 * The fixtures below are the only place an instant is chosen, and every instant
 * is `bj(...)`, so the suite never depends on the wall clock (2026-09-30 10:00
 * +08:00 is inside the 09:00–12:00 peak window; 12:00 is its end; 20:00 the same
 * day is off-peak).
 *
 * This file imports no other test file: it is a standalone artifact.
 *
 * Run: <node> --test --test-isolation=none --test-concurrency=1 test/gate-tree.test.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../src/host/index.ts'
import { createOffPeakGate, defaultGateStore } from '../src/host/gate.ts'
import { createPricingEngine } from '../src/pricing/index.ts'
import { API_PREFIX } from '../src/shared/contracts.ts'
import type { GateClock, GateStore, OffPeakGate } from '../src/host/gate.ts'
import type { PricingEngine } from '../src/pricing/index.ts'
import type { GateConfig, GateView, PluginConfig } from '../src/shared/contracts.ts'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/**
 * Explicit Beijing wall-clock instants. The suite never reads the real clock,
 * so the tier is a fact about the fixture, not about when the test runs.
 */
const bj = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  Date.UTC(year, month - 1, day, hour - 8, minute)

/** Wednesday 2026-09-30 10:00 +08:00 — inside the 09:00-12:00 peak window. */
const PEAK = bj(2026, 9, 30, 10)
/** Half an hour into that peak window, so a subtree can have staggered holders. */
const MID_PEAK = bj(2026, 9, 30, 10, 30)
/** The same day at 12:00, the instant the peak window ends. */
const BOUNDARY = bj(2026, 9, 30, 12)
/** Thursday 2026-10-08 10:00 +08:00 — the next peak window after the holiday. */
const SECOND_PEAK = bj(2026, 10, 8, 10)
/** Thursday 2026-10-08 12:00 — its boundary. */
const SECOND_BOUNDARY = bj(2026, 10, 8, 12)

const engine = createPricingEngine()

/* ------------------------------------------------------------------ *
 * Doubles
 * ------------------------------------------------------------------ */

interface PendingSleep {
  readonly deadline: number
  readonly resolve: (released: boolean) => void
}

interface FakeClock extends GateClock {
  /** Every requested duration, in call order, so clamping/timer counts are observable. */
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
 * The store double, keyed by SESSION and holding explicit choices only — exactly
 * what the durable file is allowed to hold. It can never record a parent link,
 * so a test that sees a tree resolved through this store proves the link came
 * from the live gate state (observeSession / parentOf), not from persistence.
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
  const store = options.store ?? memoryStore()
  const changes: number[] = []
  const gate = createOffPeakGate({
    engine: options.engine ?? engine,
    config: options.config ?? {},
    clock: options.clock ?? clock,
    store,
    onChange: () => { changes.push(clock.now()) },
    ...(options.parentOf === undefined ? {} : { parentOf: options.parentOf }),
  })
  return { clock, gate, store: store as MemoryStore, changes }
}

/** A gate whose configured default is ON: sessions with no explicit choice inherit it. */
function enabledFixture(options: { at?: number, engine?: PricingEngine, clock?: GateClock, config?: Omit<GateConfig, 'enabled'> } = {}): GateFixture {
  return gateFixture({ ...options, config: { ...options.config, enabled: true } })
}

/* ------------------------------------------------------------------ *
 * Call helpers — the only way a model call enters the gate
 * ------------------------------------------------------------------ */

interface Parked {
  readonly script: ScriptedNext
  readonly iterator: AsyncIterator<Chunk>
  readonly firstPull: Promise<IteratorResult<Chunk>>
}

/**
 * Issue one model call through the gate and pull once. A gated session must
 * return a wrapper (never `next()` itself) and the middleware must NOT dispatch
 * synchronously: the first pull is what arms the hold. The pending first pull is
 * kept, so the test can await it after releasing the hold.
 */
function park(h: GateFixture, sessionId: string, label: string): Parked {
  const script = scriptedNext(h.clock)
  let produced: AsyncIterable<Chunk> | undefined
  const next = (): AsyncIterable<Chunk> => { produced = script.next(); return produced }
  const iterable = h.gate.middleware({ sessionId }, next)
  assert.equal(produced, undefined, `${label}: gated middleware must not dispatch next() synchronously`)
  assert.notEqual(iterable, produced, `${label}: a gated call must be wrapped, not returned by identity`)
  const iterator = iterable[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  return { script, iterator, firstPull }
}

/**
 * Prove a parked call was released: the provider body runs exactly once and the
 * consumer sees exactly the provider's own chunk sequence.
 */
async function finish(parked: Parked, label: string): Promise<void> {
  const first = await withDeadline(parked.firstPull, 500, label)
  assert.equal(first.done, false, `${label}: the released call must yield the provider's first chunk`)
  assert.deepEqual(first.value, SCRIPT[0], `${label}: the first chunk must be the provider's own`)
  const rest = await withDeadline(collect({ [Symbol.asyncIterator]: () => parked.iterator }), 500, label)
  assert.deepEqual([first.value, ...rest], [...SCRIPT], `${label}: the gated sequence must be the ungated one`)
  assert.equal(parked.script.delegations(), 1, `${label}: the provider body must run exactly once`)
  assert.equal(parked.script.pulls(), SCRIPT.length, `${label}: every provider chunk must be pulled exactly once`)
}

/** A session the gate does not apply to must get the very object `next()` produced. */
function assertBypassed(h: GateFixture, sessionId: string, label: string): void {
  const produced = scriptedNext(h.clock).next()
  const returned = h.gate.middleware({ sessionId }, () => produced)
  assert.equal(returned, produced, `${label}: an unaffected session must get the identical next() object`)
}

/** An unaffected session really dispatches while the tree is parked. */
async function dispatchFree(h: GateFixture, sessionId: string, label: string): Promise<ScriptedNext> {
  const script = scriptedNext(h.clock)
  const produced = script.next()
  const returned = h.gate.middleware({ sessionId }, () => produced)
  assert.equal(returned, produced, `${label}: an unaffected session must bypass the gate by identity`)
  const emitted = await withDeadline(collect(returned), 500, `${label}: the ungated stream`)
  assert.deepEqual(emitted, [...SCRIPT], `${label}: the ungated sequence must be the provider's own`)
  assert.equal(script.startedAt() !== null, true, `${label}: the ungated provider body must actually run`)
  return script
}

/* ------------------------------------------------------------------ *
 * V12. Subtree hold: parent ON parks child and grandchild
 * ------------------------------------------------------------------ */

test('V12 — a parent switch parks the model calls of its child and grandchild, and an unrelated root keeps dispatching', async () => {
  const ROOT = 'conv-root'
  const CHILD = 'conv-child'
  const GRAND = 'conv-grand'
  const OTHER = 'conv-other'
  const h = gateFixture()
  await h.gate.setEnabled(ROOT, true)
  // Parent links are announced by the framework's `session/created` event.
  h.gate.observeSession(CHILD, ROOT)
  h.gate.observeSession(GRAND, CHILD)

  // The tree resolves before any call: child and grandchild both follow the
  // root's explicit choice, and both name the ROOT as the source of inheritance.
  assert.deepEqual(
    { enabled: h.gate.view(CHILD).enabled, source: h.gate.view(CHILD).source, inheritedFrom: h.gate.view(CHILD).inheritedFrom },
    { enabled: true, source: 'inherited', inheritedFrom: ROOT },
    'the child must inherit the parent switch',
  )
  assert.deepEqual(
    { enabled: h.gate.view(GRAND).enabled, source: h.gate.view(GRAND).source, inheritedFrom: h.gate.view(GRAND).inheritedFrom },
    { enabled: true, source: 'inherited', inheritedFrom: ROOT },
    'the grandchild must inherit the nearest explicit ancestor, not just its parent',
  )

  const rootCall = park(h, ROOT, 'V12 root call')
  const childCall = park(h, CHILD, 'V12 child call')
  const grandCall = park(h, GRAND, 'V12 grandchild call')
  await settle()

  assert.equal(h.clock.waiting(), 3, 'a call from the root, the child and the grandchild must each be parked')
  assert.deepEqual(
    [rootCall.script.delegations(), childCall.script.delegations(), grandCall.script.delegations()],
    [0, 0, 0],
    'no provider body may run while the tree is parked at peak',
  )
  assert.equal(rootCall.script.startedAt(), null)
  assert.equal(childCall.script.startedAt(), null)
  assert.equal(grandCall.script.startedAt(), null)

  // The subtree aggregate: the root sees all three, the child only itself and
  // its child, the grandchild only itself. Nothing is parked outside the tree.
  assert.equal(h.gate.view(ROOT).holding, 3, 'the root subtree holds all three calls')
  assert.equal(h.gate.view(ROOT).ownHolding, 1, 'the root owns only its own call')
  assert.equal(h.gate.view(ROOT).otherHolding, 0, 'nothing outside the root subtree is parked')
  assert.equal(h.gate.view(CHILD).holding, 2, 'the child subtree holds the child and grandchild calls')
  assert.equal(h.gate.view(CHILD).ownHolding, 1, 'the child owns only its own call')
  assert.equal(h.gate.view(GRAND).holding, 1)
  assert.equal(h.gate.view(GRAND).ownHolding, 1)
  assert.equal(h.gate.view(GRAND).otherHolding, 2, 'the root and child calls are outside the grandchild subtree')

  // An unrelated conversation is not wrapped at all, and really dispatches at peak.
  assertBypassed(h, OTHER, 'V12 unrelated root')
  const free = await dispatchFree(h, OTHER, 'V12 unrelated root dispatch')
  assert.equal(free.startedAt(), PEAK, 'the unrelated root must dispatch at the peak instant')
  assert.equal(h.clock.waiting(), 3, 'the unrelated dispatch must not touch a tree timer')
  assert.equal(h.gate.view(ROOT).holding, 3, 'the unrelated dispatch must not touch tree counters')

  // The whole tree is released by the same tier boundary, unchanged.
  h.clock.advanceTo(BOUNDARY)
  await finish(rootCall, 'V12 root release')
  await finish(childCall, 'V12 child release')
  await finish(grandCall, 'V12 grandchild release')
  assert.equal(rootCall.script.startedAt(), BOUNDARY)
  assert.equal(childCall.script.startedAt(), BOUNDARY)
  assert.equal(grandCall.script.startedAt(), BOUNDARY)
  assert.equal(h.clock.waiting(), 0, 'no timer may survive the release')
  assert.equal(h.gate.view(ROOT).holding, 0)
  assert.equal(h.gate.view(ROOT).heldTotal, 3, 'all three subtree calls must be counted as parked')
  assert.equal(h.gate.view(CHILD).heldTotal, 2)
  assert.equal(h.gate.view(GRAND).heldTotal, 1)
})

/* ------------------------------------------------------------------ *
 * V13. Nearest explicit choice wins
 * ------------------------------------------------------------------ */

test('V13 — the nearest explicit choice wins: child OFF overrides parent ON, child ON stays on under a parent OFF, and source/inheritedFrom are exact', async () => {
  const P = 'prec-parent'
  const C = 'prec-child'
  const G = 'prec-grand'
  const h = gateFixture()
  h.gate.observeSession(C, P)
  h.gate.observeSession(G, C)

  // --- default case: no explicit choice anywhere in the tree ---
  const root = h.gate.view(P)
  assert.deepEqual(
    { enabled: root.enabled, source: root.source, inheritedFrom: root.inheritedFrom, changedAt: root.changedAt, durable: root.durable },
    { enabled: false, source: 'default', inheritedFrom: null, changedAt: null, durable: false },
    'an unswitched session must report the configured default exactly',
  )
  assert.deepEqual(
    { enabled: h.gate.view(G).enabled, source: h.gate.view(G).source, inheritedFrom: h.gate.view(G).inheritedFrom },
    { enabled: false, source: 'default', inheritedFrom: null },
    'a default position must not claim an ancestor it follows',
  )

  // --- parent ON, child explicit OFF: the child wins over the parent ---
  await h.gate.setEnabled(P, true)
  await h.gate.setEnabled(C, false)
  const parentOn = h.gate.view(P)
  assert.deepEqual(
    { enabled: parentOn.enabled, source: parentOn.source, inheritedFrom: parentOn.inheritedFrom },
    { enabled: true, source: 'self', inheritedFrom: null },
    'the parent reports its own explicit ON',
  )
  assert.equal(typeof parentOn.changedAt, 'number', 'a session with its own choice has a switch instant')
  assert.equal(parentOn.durable, true, 'the memory store accepted the write, so the choice is durable')
  const childOff = h.gate.view(C)
  assert.deepEqual(
    { enabled: childOff.enabled, source: childOff.source, inheritedFrom: childOff.inheritedFrom },
    { enabled: false, source: 'self', inheritedFrom: null },
    'the child\'s explicit OFF must override the parent\'s ON',
  )
  assert.equal(typeof childOff.changedAt, 'number')
  assert.deepEqual(
    { enabled: h.gate.view(G).enabled, source: h.gate.view(G).source, inheritedFrom: h.gate.view(G).inheritedFrom },
    { enabled: false, source: 'inherited', inheritedFrom: C },
    'the grandchild must follow the nearest explicit ancestor (the child), not the root',
  )
  assertBypassed(h, C, 'V13 explicit-OFF child')
  assertBypassed(h, G, 'V13 grandchild under an explicit-OFF child')
  const parentCall = park(h, P, 'V13 parent call')
  await settle()
  assert.equal(h.clock.waiting(), 1, 'only the parent itself may be parked')
  h.clock.advanceTo(BOUNDARY)
  await finish(parentCall, 'V13 parent release')

  // --- parent OFF, child explicit ON: the child stays on ---
  await h.gate.setEnabled(P, false)
  await h.gate.setEnabled(C, true)
  assert.deepEqual(
    { enabled: h.gate.view(P).enabled, source: h.gate.view(P).source },
    { enabled: false, source: 'self' },
    'the parent keeps its own explicit OFF',
  )
  assert.deepEqual(
    { enabled: h.gate.view(C).enabled, source: h.gate.view(C).source, inheritedFrom: h.gate.view(C).inheritedFrom },
    { enabled: true, source: 'self', inheritedFrom: null },
    'an explicit ON child stays on while the parent is off',
  )
  assert.deepEqual(
    { enabled: h.gate.view(G).enabled, source: h.gate.view(G).source, inheritedFrom: h.gate.view(G).inheritedFrom },
    { enabled: true, source: 'inherited', inheritedFrom: C },
    'the grandchild follows the child\'s explicit ON',
  )
  assertBypassed(h, P, 'V13 explicit-OFF parent')
  h.clock.set(SECOND_PEAK)
  const childCall = park(h, C, 'V13 explicit-ON child call')
  const grandCall = park(h, G, 'V13 grandchild call under explicit-ON child')
  await settle()
  assert.equal(h.clock.waiting(), 2, 'the explicit-ON child tree must park')
  h.clock.advanceTo(SECOND_BOUNDARY)
  await finish(childCall, 'V13 explicit-ON child release')
  await finish(grandCall, 'V13 grandchild release')

  // --- a tree whose configured default is ON reports source 'default' ---
  const on = enabledFixture()
  on.gate.observeSession(C, P)
  const defaultOn = on.gate.view(P)
  assert.deepEqual(
    { enabled: defaultOn.enabled, source: defaultOn.source, inheritedFrom: defaultOn.inheritedFrom },
    { enabled: true, source: 'default', inheritedFrom: null },
    'a configured default ON is a default, never a self choice',
  )
  assert.deepEqual(
    { enabled: on.gate.view(C).enabled, source: on.gate.view(C).source, inheritedFrom: on.gate.view(C).inheritedFrom },
    { enabled: true, source: 'default', inheritedFrom: null },
    'an ancestor with no explicit choice cannot be named as inheritedFrom',
  )
})

/* ------------------------------------------------------------------ *
 * V14. Cross-conversation isolation + otherHolding
 * ------------------------------------------------------------------ */

test('V14 — one conversation tree parks without touching another root or its child, and otherHolding is exactly the parked requests outside the subtree', async () => {
  const A = 'iso-root-a'
  const A1 = 'iso-child-a'
  const B = 'iso-root-b'
  const B1 = 'iso-child-b'
  const h = gateFixture()
  h.gate.observeSession(A1, A)
  h.gate.observeSession(B1, B)
  await h.gate.setEnabled(A, true)

  const aCall = park(h, A, 'V14 root A call')
  const a1Call = park(h, A1, 'V14 child A call')
  await settle()
  assert.equal(h.clock.waiting(), 2, 'the enabled tree must park both calls')
  assert.equal(h.gate.view(A).holding, 2)
  assert.equal(h.gate.view(A).ownHolding, 1)
  assert.equal(h.gate.view(A).otherHolding, 0, 'a descendant is inside the subtree, never otherHolding')
  assert.equal(h.gate.view(A1).holding, 1)
  assert.equal(h.gate.view(A1).otherHolding, 1, 'the root A call is outside the A1 subtree')
  assert.equal(h.gate.view(B).holding, 0, 'root B must not be parked')
  assert.equal(h.gate.view(B).otherHolding, 2)
  assert.equal(h.gate.view(B1).holding, 0)
  assert.equal(h.gate.view(B1).source, 'default', 'B\'s child has no enabled ancestor')

  // B and B's child really dispatch while A's tree waits.
  assertBypassed(h, B, 'V14 root B')
  const bCall = await dispatchFree(h, B1, 'V14 child B dispatch')
  assert.equal(bCall.startedAt(), PEAK, 'the unrelated conversation must dispatch at peak')
  assert.equal(h.clock.waiting(), 2, 'the unrelated dispatch must not touch A\'s timers')
  assert.equal(h.gate.view(A).holding, 2, 'the unrelated dispatch must not touch A\'s counters')

  // Enabling a second root parks only its own tree; A's tree is unchanged.
  await h.gate.setEnabled(B, true)
  const b1Call = park(h, B1, 'V14 child B call after B was enabled')
  await settle()
  assert.equal(h.clock.waiting(), 3, 'each parked call owns its own timer')
  assert.equal(h.gate.view(A).holding, 2, 'the second tree must not change A\'s aggregate')
  assert.equal(h.gate.view(A).otherHolding, 1, 'B\'s child call is parked outside A\'s subtree')
  assert.equal(h.gate.view(B).holding, 1)
  assert.equal(h.gate.view(B).ownHolding, 0, 'B itself has nothing parked')
  assert.equal(h.gate.view(B).otherHolding, 2, 'A\'s two calls are outside B\'s subtree')
  assert.equal(h.gate.view(A1).otherHolding, 2, 'A\'s root call and B\'s child are outside A1')

  h.clock.advanceTo(BOUNDARY)
  await finish(aCall, 'V14 root A release')
  await finish(a1Call, 'V14 child A release')
  await finish(b1Call, 'V14 child B release')
  assert.equal(h.clock.waiting(), 0)
  assert.equal(h.gate.view(A).heldTotal, 2)
  assert.equal(h.gate.view(A1).heldTotal, 1)
  assert.equal(h.gate.view(B).heldTotal, 1, 'only the call that was actually parked counts for B')
})

/* ------------------------------------------------------------------ *
 * V15. Disabling a parent releases only the calls its change un-gates
 * ------------------------------------------------------------------ */

test('V15 — disabling a parent releases its inheriting descendants, keeps an explicit-ON child parked and counted, and leaves unrelated sessions and timers untouched', async () => {
  const P = 'rel-parent'
  const C = 'rel-child'
  const G = 'rel-grand'
  const D = 'rel-explicit-on-child'
  const U = 'rel-unrelated'
  const h = gateFixture()
  h.gate.observeSession(C, P)
  h.gate.observeSession(G, C)
  h.gate.observeSession(D, P)
  h.gate.observeSession(U, undefined)
  await h.gate.setEnabled(P, true)
  await h.gate.setEnabled(D, true)
  await h.gate.setEnabled(U, true)

  const parentCall = park(h, P, 'V15 parent call')
  const childCall = park(h, C, 'V15 child call')
  const grandCall = park(h, G, 'V15 grandchild call')
  const explicitCall = park(h, D, 'V15 explicit-ON child call')
  const unrelatedCall = park(h, U, 'V15 unrelated call')
  await settle()
  assert.equal(h.clock.waiting(), 5, 'all five calls must be parked')
  assert.equal(h.gate.view(P).holding, 4, 'P\'s subtree holds itself, C, G and D')
  assert.equal(h.gate.view(P).ownHolding, 1)
  assert.equal(h.gate.view(P).otherHolding, 1, 'U is outside P\'s subtree')

  // Turning the parent OFF releases P itself and the descendants that only
  // followed it; D has its own explicit ON and keeps holding.
  await h.gate.setEnabled(P, false)
  const off = h.gate.view(P)
  assert.equal(off.enabled, false, 'the parent is now explicitly off')
  assert.equal(off.source, 'self')
  assert.equal(off.ownHolding, 0, 'the parent\'s own parked call must be released')
  assert.equal(off.holding, 1, 'only the explicit-ON child still holds inside the subtree')
  assert.equal(h.clock.waiting(), 2, 'only the explicit-ON child and the unrelated session may still wait')
  assert.equal(explicitCall.script.delegations(), 0, 'the explicit-ON child must not be dispatched by the parent\'s change')
  assert.equal(unrelatedCall.script.delegations(), 0, 'the unrelated session must not be released by another tree\'s change')

  await finish(parentCall, 'V15 parent release')
  await finish(childCall, 'V15 inherited child release')
  await finish(grandCall, 'V15 inheriting grandchild release')
  // Released by the manual switch, the three calls dispatched at the switch
  // instant, not at the boundary: the user asked for them to go now.
  assert.equal(parentCall.script.startedAt(), PEAK)
  assert.equal(childCall.script.startedAt(), PEAK)
  assert.equal(grandCall.script.startedAt(), PEAK)

  assert.equal(h.gate.view(C).enabled, false)
  assert.equal(h.gate.view(C).holding, 0)
  assert.equal(h.gate.view(G).holding, 0)
  assert.equal(h.gate.view(D).enabled, true, 'an explicit ON child stays on')
  assert.equal(h.gate.view(D).source, 'self')
  assert.equal(h.gate.view(D).holding, 1, 'the explicit-ON child is still parked and counted')
  assert.equal(h.gate.view(P).holding, 1, 'the parent subtree still reports the explicit-ON child')
  assert.equal(h.gate.view(U).holding, 1, 'the unrelated session is still parked')
  assert.equal(h.gate.view(U).otherHolding, 1, 'the only still-parked call outside U is the explicit-ON child')

  // The boundary releases the survivors only.
  h.clock.advanceTo(BOUNDARY)
  await finish(explicitCall, 'V15 explicit-ON child release')
  await finish(unrelatedCall, 'V15 unrelated release')
  assert.equal(h.clock.waiting(), 0)
  const after = h.gate.view(P)
  assert.equal(after.holding, 0)
  assert.equal(after.heldTotal, 4, 'all four calls that were parked in P\'s subtree are counted')
  assert.equal(after.delayedMs, BOUNDARY - PEAK, 'only the explicit-ON child actually waited; the released calls dispatched immediately')
  assert.equal(h.gate.view(U).delayedMs, BOUNDARY - PEAK)
})

/* ------------------------------------------------------------------ *
 * V16. Subtree aggregation, revision and ETags
 * ------------------------------------------------------------------ */

test('V16 — holding/ownHolding/heldTotal/delayedMs/since/releaseAt aggregate over a 3-level tree, and revision folds rendered fields only', async () => {
  const R = 'agg-root'
  const C = 'agg-child'
  const G = 'agg-grand'
  const h = gateFixture()
  h.gate.observeSession(C, R)
  h.gate.observeSession(G, C)
  await h.gate.setEnabled(R, true)

  const rootCall = park(h, R, 'V16 root call')
  await settle()
  h.clock.advanceTo(MID_PEAK)
  const childCalls = [park(h, C, 'V16 child call 1'), park(h, C, 'V16 child call 2')]
  const grandCall = park(h, G, 'V16 grandchild call')
  await settle()
  assert.equal(h.clock.waiting(), 4)

  // Aggregate view during the hold, with staggered starts.
  const rootDuring = h.gate.view(R)
  assert.equal(rootDuring.holding, 4, 'the root subtree holds all four calls')
  assert.equal(rootDuring.ownHolding, 1)
  assert.equal(rootDuring.otherHolding, 0)
  assert.equal(rootDuring.since, PEAK, 'since is the OLDEST parked instant in the subtree')
  assert.equal(rootDuring.releaseAt, BOUNDARY, 'releaseAt is the boundary the subtree expects')
  assert.equal(rootDuring.heldTotal, 4, 'every parked request is counted while it waits')
  assert.equal(rootDuring.delayedMs, 0, 'no delay has been absorbed yet')
  const childDuring = h.gate.view(C)
  assert.equal(childDuring.holding, 3, 'the child subtree holds its two calls and the grandchild call')
  assert.equal(childDuring.ownHolding, 2)
  assert.equal(childDuring.since, MID_PEAK, 'the child subtree has no older parked call')
  assert.equal(childDuring.releaseAt, BOUNDARY)
  assert.equal(childDuring.heldTotal, 3)
  const grandDuring = h.gate.view(G)
  assert.equal(grandDuring.holding, 1)
  assert.equal(grandDuring.since, MID_PEAK)
  assert.equal(grandDuring.heldTotal, 1)

  // Revision: moving `now` inside the same tier must not move it, even while
  // requests are parked; nor may delayedMs alone (it is display-only).
  const parkedRevision = rootDuring.revision
  h.clock.advanceTo(BOUNDARY - 60_000)
  const later = h.gate.view(R)
  assert.notEqual(later.now, rootDuring.now, 'the fixture must really move now, or the negative case is vacuous')
  assert.equal(later.revision, parkedRevision, 'now must never enter the revision')
  assert.equal(later.holding, 4, 'the hold must be unaffected by moving the clock inside the window')

  // Releasing changes rendered fields (holding/releaseAt and heldTotal/delay).
  h.clock.advanceTo(BOUNDARY)
  await finish(rootCall, 'V16 root release')
  for (const [index, call] of childCalls.entries()) await finish(call, `V16 child release ${index + 1}`)
  await finish(grandCall, 'V16 grandchild release')
  const released = h.gate.view(R)
  assert.equal(released.holding, 0)
  assert.equal(released.since, null, 'since must clear when nothing in the subtree is parked')
  assert.equal(released.releaseAt, null, 'releaseAt must clear when nothing in the subtree is parked')
  assert.equal(released.heldTotal, 4)
  assert.equal(released.delayedMs, (BOUNDARY - PEAK) + 2 * (BOUNDARY - MID_PEAK) + (BOUNDARY - MID_PEAK), 'each delayed request contributes its own wait')
  assert.notEqual(released.revision, parkedRevision, 'the counters that changed on release are rendered fields')
  assert.equal(h.gate.view(C).delayedMs, 3 * (BOUNDARY - MID_PEAK))
  assert.equal(h.gate.view(G).delayedMs, BOUNDARY - MID_PEAK)

  // Moving now alone while idle, inside one tier, leaves the revision alone.
  const idleRevision = released.revision
  h.clock.advanceTo(BOUNDARY + 60_000)
  assert.equal(h.gate.view(R).now === released.now, false, 'the clock must really have moved')
  assert.equal(h.gate.view(R).revision, idleRevision, 'now and delayedMs alone must never move the revision')

  // Revision folds source/inheritedFrom/changedAt: the child becoming an
  // explicit choice changes the child's view and the grandchild's ancestry.
  const childInherited = h.gate.view(C)
  const grandInherited = h.gate.view(G)
  assert.deepEqual(
    { source: grandInherited.source, inheritedFrom: grandInherited.inheritedFrom },
    { source: 'inherited', inheritedFrom: R },
  )
  await h.gate.setEnabled(C, true)
  const childSelf = h.gate.view(C)
  assert.deepEqual({ source: childSelf.source, inheritedFrom: childSelf.inheritedFrom, changedAt: typeof childSelf.changedAt }, { source: 'self', inheritedFrom: null, changedAt: 'number' })
  assert.notEqual(childSelf.revision, childInherited.revision, 'a source/changedAt change must move the child\'s own revision')
  const grandMoved = h.gate.view(G)
  assert.equal(grandMoved.inheritedFrom, C, 'the grandchild now follows the child')
  assert.notEqual(grandMoved.revision, grandInherited.revision, 'a changed inheritedFrom must move the revision')

  // Two sessions whose rendered tree fields are identical must still never
  // share an ETag: the session id is folded into the revision.
  const fresh = gateFixture()
  const etagA = fresh.gate.view('etag-a')
  const etagB = fresh.gate.view('etag-b')
  assert.deepEqual(
    { enabled: etagA.enabled, source: etagA.source, holding: etagA.holding, heldTotal: etagA.heldTotal },
    { enabled: etagB.enabled, source: etagB.source, holding: etagB.holding, heldTotal: etagB.heldTotal },
    'the two sessions must render the same counters for the collision test to mean anything',
  )
  assert.notEqual(etagA.revision, etagB.revision, 'two sessions must never share an ETag revision')
})

/* ------------------------------------------------------------------ *
 * V17. Live parentOf fallback, observeSession override, cycles, bounds
 * ------------------------------------------------------------------ */

test('V17 — a live parentOf resolves the tree without observeSession, observeSession overrides it, cycles and self-parent terminate, and parent caches stay bounded', async () => {
  // --- live parentOf fallback ---
  const R = 'live-root'
  const C = 'live-child'
  const G = 'live-grand'
  const links = new Map<string, string>()
  links.set(C, R)
  links.set(G, C)
  const h = gateFixture({ parentOf: (id) => links.get(id) })
  await h.gate.setEnabled(R, true)
  assert.deepEqual(
    { enabled: h.gate.view(C).enabled, source: h.gate.view(C).source, inheritedFrom: h.gate.view(C).inheritedFrom },
    { enabled: true, source: 'inherited', inheritedFrom: R },
    'parentOf must resolve a session that was never announced',
  )
  assert.deepEqual(
    { enabled: h.gate.view(G).enabled, source: h.gate.view(G).source, inheritedFrom: h.gate.view(G).inheritedFrom },
    { enabled: true, source: 'inherited', inheritedFrom: R },
    'parentOf must resolve a multi-hop chain',
  )
  const childCall = park(h, C, 'V17 parentOf child call')
  await settle()
  assert.equal(h.clock.waiting(), 1, 'a parentOf-resolved session must be parked')
  h.clock.advanceTo(BOUNDARY)
  await finish(childCall, 'V17 parentOf child release')

  // --- observeSession overrides an already-resolved parentOf link ---
  const Q = 'override-explicit-on'
  const P = 'override-explicit-off'
  const S = 'override-session'
  const overrides = new Map<string, string>([[S, P]])
  const o = gateFixture({ parentOf: (id) => overrides.get(id) })
  await o.gate.setEnabled(P, false)
  await o.gate.setEnabled(Q, true)
  // Touch the session first so the parentOf result is cached, then announce a
  // DIFFERENT parent: the announced link is the durable truth and must win.
  assert.equal(o.gate.view(S).enabled, false, 'the parentOf link initially follows the explicit-OFF parent')
  o.gate.observeSession(S, Q)
  assert.deepEqual(
    { enabled: o.gate.view(S).enabled, source: o.gate.view(S).source, inheritedFrom: o.gate.view(S).inheritedFrom },
    { enabled: true, source: 'inherited', inheritedFrom: Q },
    'observeSession must override a previously cached parentOf link',
  )

  // --- cycles and self-parent terminate instead of hanging ---
  const cyc = gateFixture()
  cyc.gate.observeSession('cycle-a', 'cycle-b')
  cyc.gate.observeSession('cycle-b', 'cycle-a')
  assert.deepEqual(
    { enabled: cyc.gate.view('cycle-a').enabled, source: cyc.gate.view('cycle-a').source },
    { enabled: false, source: 'default' },
    'a cycle with no explicit choice must fall back to the default, not loop',
  )
  const cycOn = enabledFixture()
  cycOn.gate.observeSession('cycle-a', 'cycle-b')
  cycOn.gate.observeSession('cycle-b', 'cycle-a')
  assert.deepEqual(
    { enabled: cycOn.gate.view('cycle-a').enabled, source: cycOn.gate.view('cycle-a').source },
    { enabled: true, source: 'default' },
    'a cycle with the default ON must report the default, not a bogus ancestor',
  )
  await cycOn.gate.setEnabled('cycle-a', true)
  assert.deepEqual(
    { enabled: cycOn.gate.view('cycle-b').enabled, source: cycOn.gate.view('cycle-b').source, inheritedFrom: cycOn.gate.view('cycle-b').inheritedFrom },
    { enabled: true, source: 'inherited', inheritedFrom: 'cycle-a' },
    'a cycle containing an explicit choice must resolve that choice and terminate',
  )
  cyc.gate.observeSession('self-parent', 'self-parent')
  assert.deepEqual(
    { enabled: cyc.gate.view('self-parent').enabled, source: cyc.gate.view('self-parent').source },
    { enabled: false, source: 'default' },
    'a self-parent must be treated as a root, not loop',
  )
  // A parentOf cycle (no observeSession at all) must also terminate.
  const pointless = new Map<string, string>([['pf-a', 'pf-b'], ['pf-b', 'pf-a']])
  const pf = gateFixture({ parentOf: (id) => pointless.get(id) })
  assert.equal(pf.gate.view('pf-a').source, 'default', 'a parentOf cycle must terminate')
  assert.equal(pf.gate.view('pf-b').source, 'default')

  // --- bounded parent caches: many observed sessions cannot grow forever ---
  const BOUND = 'bound-root'
  const bounded = gateFixture()
  await bounded.gate.setEnabled(BOUND, true)
  const FIRST = 'bounded-first'
  bounded.gate.observeSession(FIRST, BOUND)
  // The frozen contract caps the parent-link cache at 4096 entries (LRU). Push
  // well past it, then check the newest link resolves and the oldest is gone.
  for (let index = 0; index < 4200; index += 1) bounded.gate.observeSession(`bounded-${index}`, BOUND)
  assert.deepEqual(
    { enabled: bounded.gate.view('bounded-4199').enabled, source: bounded.gate.view('bounded-4199').source, inheritedFrom: bounded.gate.view('bounded-4199').inheritedFrom },
    { enabled: true, source: 'inherited', inheritedFrom: BOUND },
    'the newest observed link must resolve after the cache bound was crossed',
  )
  const oldest = bounded.gate.view(FIRST)
  assert.equal(oldest.source, 'default', 'a bounded parent cache must have evicted the oldest link, not grown without bound')
  assert.equal(oldest.enabled, false, 'the evicted child falls back to the configured default')
  assert.deepEqual({ enabled: bounded.gate.view(BOUND).enabled, source: bounded.gate.view(BOUND).source }, { enabled: true, source: 'self' }, 'the bound may never damage the root\'s own choice')
})

/* ------------------------------------------------------------------ *
 * V18. apply() wiring: one session/created listener, it teaches the link,
 *      and a throwing listener can never veto creation
 * ------------------------------------------------------------------ */

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
  /** The fake `sessions` service: what the live `parentOf` resolver reads. */
  readonly sessionHeaders: Map<string, { readonly parentSession?: string | undefined }>
  readonly directory: string
  cleanup(): void
}

/**
 * The plugin's own entry point against a fake Cordis context. `apply()` is what
 * registers the `/gate` route, the `llm/stream` listener and the `session/created`
 * listener, so driving this harness is the same code path the GUI uses. Only the
 * required DSH capabilities are stubbed, and the gate's state file is redirected
 * into a temp directory so no test can inherit another test's choice.
 */
function wireHarness(config: PluginConfig = {}): WireHarness {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-api-cost-tree-wire-'))
  const routes = new Map<string, (req: unknown, res: unknown) => unknown>()
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
  const events: Array<{ readonly event: string, readonly options: unknown }> = []
  const disposers: Array<() => void> = []
  const sessionHeaders = new Map<string, { readonly parentSession?: string | undefined }>()
  const webServer = {
    register(route: { path: string, handler: (req: unknown, res: unknown) => unknown }) {
      assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`)
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  const sessions = {
    get(id: string): { readonly id: string, readonly header: { readonly parentSession?: string | undefined } } | undefined {
      const header = sessionHeaders.get(id)
      return header === undefined ? undefined : { id, header }
    },
  }
  const services: Record<string, unknown> = { webServer, sessions }
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
    sessionQuery: { observeSession: async () => { throw new Error('the gate-tree tests never read session history') } },
    webServer,
    sessions,
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
    routes, listeners, events, sessionHeaders, directory,
    cleanup() { for (const dispose of [...disposers].reverse()) dispose(); rmSync(directory, { recursive: true, force: true }) },
  }
}

interface WireResponse {
  status: number
  headers: Record<string, unknown>
  body: string
  json(): unknown
}

const GATE_ROUTE = `${API_PREFIX}/gate`
const JSON_HEADERS = { 'content-type': 'application/json' }

async function send(h: WireHarness, options: {
  method?: string
  headers?: Record<string, string>
  body?: string
  query?: string
} = {}): Promise<WireResponse> {
  const handler = h.routes.get(GATE_ROUTE)
  assert.ok(handler !== undefined, `apply() must register ${GATE_ROUTE}`)
  const res = createResponse()
  const body = options.body === undefined ? undefined : Buffer.from(options.body, 'utf8')
  const req = {
    method: options.method ?? 'GET',
    url: GATE_ROUTE + (options.query ?? ''),
    headers: options.headers ?? {},
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield body },
  }
  await (handler as (request: unknown, response: unknown) => Promise<void>)(req, res)
  return { status: res.status, headers: res.headers, body: res.body, json: () => JSON.parse(res.body) as unknown }
}

/** Run every `session/created` listener the plugin registered, in order. */
function createSession(h: WireHarness, session: unknown): void {
  const registered = h.listeners.get('session/created')
  assert.ok(registered !== undefined && registered.length > 0, 'apply() must register a session/created listener')
  for (const listener of registered) listener(session)
}

test('V18 — apply() registers exactly one session/created listener, a created event teaches the parent link, and a poisoned event never breaks creation', async (t) => {
  const P = 'wire-parent'
  const C = 'wire-child'
  const G = 'wire-grand'
  const h = wireHarness()
  t.after(() => { h.cleanup() })

  // Exactly one listener for creation, and exactly one llm/stream listener: the
  // whole host half may intercept model calls once and observe creation once.
  const counts = new Map<string, number>()
  for (const entry of h.events) counts.set(entry.event, (counts.get(entry.event) ?? 0) + 1)
  assert.equal(counts.get('session/created'), 1, 'apply() must register exactly one session/created listener')
  assert.equal(counts.get('llm/stream'), 1, 'apply() must keep exactly one llm/stream listener')
  assert.equal((h.listeners.get('session/created')?.length ?? 0), 1)
  assert.equal((h.listeners.get('llm/stream')?.length ?? 0), 1)

  // The model-call listener stays synchronous and still bypasses a session-less call.
  const streamListener = h.listeners.get('llm/stream')?.[0]
  assert.ok(streamListener !== undefined)
  const produced = scriptedNext(createClock(PEAK)).next()
  const returned = streamListener({ model: 'deepseek-flash' }, () => produced)
  assert.equal(typeof (returned as { then?: unknown })?.then, 'undefined', 'the llm/stream listener must never return a promise')
  assert.equal(returned, produced, 'a session-less call must bypass the gate by identity')

  // The switch is written through the real HTTP route, as the panel does.
  const flip = await send(h, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ session: P, enabled: true }) })
  assert.equal(flip.status, 200)
  assert.equal((flip.json() as GateView).sessionId, P)
  assert.equal((flip.json() as GateView).enabled, true)
  assert.equal((flip.json() as GateView).source, 'self', 'a POST is this session\'s own explicit choice')

  // A created event teaches the gate the parent link...
  createSession(h, { id: C, header: { parentSession: P } })
  const child = ((await send(h, { query: `?session=${encodeURIComponent(C)}` })).json()) as GateView
  assert.deepEqual(
    { enabled: child.enabled, source: child.source, inheritedFrom: child.inheritedFrom },
    { enabled: true, source: 'inherited', inheritedFrom: P },
    'the session/created event must make the child inherit the parent switch',
  )
  // ...and the links compose into a full tree.
  createSession(h, { id: G, header: { parentSession: C } })
  const grand = ((await send(h, { query: `?session=${encodeURIComponent(G)}` })).json()) as GateView
  assert.deepEqual(
    { enabled: grand.enabled, source: grand.source, inheritedFrom: grand.inheritedFrom },
    { enabled: true, source: 'inherited', inheritedFrom: P },
    'the created events must compose a grandchild link',
  )
  // An unrelated root is untouched.
  const other = ((await send(h, { query: '?session=wire-other' })).json()) as GateView
  assert.deepEqual({ enabled: other.enabled, source: other.source }, { enabled: false, source: 'default' })

  // A second POST on the child is its own explicit choice and re-roots the tree.
  const childOff = await send(h, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ session: C, enabled: false }) })
  assert.equal((childOff.json() as GateView).source, 'self')
  const grandAfter = ((await send(h, { query: `?session=${encodeURIComponent(G)}` })).json()) as GateView
  assert.deepEqual(
    { enabled: grandAfter.enabled, source: grandAfter.source, inheritedFrom: grandAfter.inheritedFrom },
    { enabled: false, source: 'inherited', inheritedFrom: C },
    'the wire view must follow the nearest explicit ancestor',
  )

  // A live parentOf fallback (no created event) also resolves, through the
  // `sessions` service the plugin consults.
  const R2 = 'wire-live-root'
  const C2 = 'wire-live-child'
  const G2 = 'wire-live-grand'
  h.sessionHeaders.set(R2, {})
  h.sessionHeaders.set(C2, { parentSession: R2 })
  h.sessionHeaders.set(G2, { parentSession: C2 })
  const liveFlip = await send(h, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ session: R2, enabled: true }) })
  assert.equal(liveFlip.status, 200)
  const liveGrand = ((await send(h, { query: `?session=${encodeURIComponent(G2)}` })).json()) as GateView
  assert.deepEqual(
    { enabled: liveGrand.enabled, source: liveGrand.source, inheritedFrom: liveGrand.inheritedFrom },
    { enabled: true, source: 'inherited', inheritedFrom: R2 },
    'the wired parentOf resolver must resolve a tree that was never announced',
  )

  // A thrown listener path must never propagate: the plugin catches internally,
  // so creation is never vetoed by a session object the listener cannot read.
  const decorated = { id: 'wire-poisoned' }
  Object.defineProperty(decorated, 'header', { get(): never { throw new Error('header exploded') } })
  const poisoned: unknown[] = [
    null,
    undefined,
    {},
    { id: 42 },
    { id: 'wire-poisoned', header: undefined },
    decorated,
    { id: 'wire-poisoned', header: { get parentSession(): never { throw new Error('parent exploded') } } },
  ]
  for (const [index, session] of poisoned.entries()) {
    assert.doesNotThrow(() => { createSession(h, session) }, `a poisoned session/created payload #${index} must never throw out of the plugin listener`)
  }

  // Creation was not broken: the gate still learns new links and answers.
  createSession(h, { id: 'wire-after-poison', header: { parentSession: P } })
  const after = ((await send(h, { query: '?session=wire-after-poison' })).json()) as GateView
  assert.deepEqual(
    { enabled: after.enabled, source: after.source, inheritedFrom: after.inheritedFrom },
    { enabled: true, source: 'inherited', inheritedFrom: P },
    'the session/created path must stay functional after a poisoned payload',
  )
})

/* ------------------------------------------------------------------ *
 * V19. Durable store: explicit choices only, v1 ignored, inheritance rebuilt
 * ------------------------------------------------------------------ */

test('V19 — the durable store holds only explicit choices (never parent links), a v1 file is ignored, and inheritance is rebuilt from live links after a restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-api-cost-gate-tree-store-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const path = join(directory, 'gate.json')
  const P = 'durable-parent'
  const C = 'durable-child'
  const G = 'durable-grand'

  // --- first process: one explicit choice; the tree is learned from events ---
  const clock = createClock(PEAK)
  const gate1 = createOffPeakGate({ engine, config: { enabled: false, path }, clock, store: defaultGateStore(path) })
  await gate1.setEnabled(P, true)
  gate1.observeSession(C, P)
  gate1.observeSession(G, C)
  assert.equal(gate1.view(C).enabled, true, 'the live tree must inherit before the restart')

  // The durable file contains explicit choices only: no parent links, no event
  // data, no tree. (The whole point is that inheritance is a runtime fact.)
  const document = JSON.parse(readFileSync(path, 'utf8')) as { version: number, sessions: Record<string, { enabled: boolean, changedAt: number }> }
  assert.deepEqual(Object.keys(document).sort(), ['sessions', 'version'])
  assert.equal(document.version, 2)
  assert.deepEqual(Object.keys(document.sessions), [P], 'only the switched session may be stored')
  assert.deepEqual(Object.keys(document.sessions[P] as object).sort(), ['changedAt', 'enabled'])
  const serialized = JSON.stringify(document)
  assert.equal(serialized.includes(C), false, 'a child session id must never be persisted')
  assert.equal(serialized.includes(G), false, 'a grandchild session id must never be persisted')
  assert.equal(serialized.includes('parentSession'), false, 'no parent-link field may appear in the durable file')
  assert.equal(serialized.includes('"parent"'), false, 'no parent-link field may appear in the durable file')

  // --- a second process: same store, a brand-new gate on the same clock ---
  const clock2 = createClock(PEAK)
  const gate2 = createOffPeakGate({ engine, config: { enabled: false, path }, clock: clock2, store: defaultGateStore(path) })
  const restoredParent = gate2.view(P)
  assert.deepEqual(
    { enabled: restoredParent.enabled, source: restoredParent.source, inheritedFrom: restoredParent.inheritedFrom, durable: restoredParent.durable },
    { enabled: true, source: 'self', inheritedFrom: null, durable: true },
    'the explicit choice must survive the restart and stay attributed to its session',
  )
  // Before the links are announced again, the tree is flat: default off.
  assert.deepEqual(
    { enabled: gate2.view(C).enabled, source: gate2.view(C).source, inheritedFrom: gate2.view(C).inheritedFrom },
    { enabled: false, source: 'default', inheritedFrom: null },
    'a restart must not invent a parent link it never persisted',
  )
  // Re-observing the live links rebuilds the effective inheritance.
  gate2.observeSession(C, P)
  gate2.observeSession(G, C)
  assert.deepEqual(
    { enabled: gate2.view(C).enabled, source: gate2.view(C).source, inheritedFrom: gate2.view(C).inheritedFrom },
    { enabled: true, source: 'inherited', inheritedFrom: P },
    'the effective inheritance must be reconstructed from live links after a restart',
  )
  assert.deepEqual(
    { enabled: gate2.view(G).enabled, inheritedFrom: gate2.view(G).inheritedFrom },
    { enabled: true, inheritedFrom: P },
    'the reconstructed tree must reach the grandchild',
  )
  // The rebuilt decision is operational, not just cosmetic: it parks, then
  // releases at the boundary like any other inherited hold.
  const rebuiltScript = scriptedNext(clock2)
  const rebuiltIterator = gate2.middleware({ sessionId: C }, rebuiltScript.next)[Symbol.asyncIterator]()
  const rebuiltPull = rebuiltIterator.next()
  await settle()
  assert.equal(clock2.waiting(), 1, 'the reconstructed inherited decision must park the call')
  assert.equal(rebuiltScript.delegations(), 0, 'nothing may be dispatched while the reconstructed hold runs')
  clock2.advanceTo(BOUNDARY)
  await finish({ script: rebuiltScript, iterator: rebuiltIterator, firstPull: rebuiltPull }, 'V19 reconstructed hold release')
  assert.equal(rebuiltScript.startedAt(), BOUNDARY, 'the reconstructed hold must dispatch at the boundary')

  // --- a v1 file is ignored, and the next write upgrades it ---
  const legacy = join(directory, 'legacy.json')
  writeFileSync(legacy, `${JSON.stringify({ version: 1, enabled: true, changedAt: 123 })}\n`)
  assert.equal(defaultGateStore(legacy).read(P), undefined, 'a v1 process-global flag cannot be attributed to a session')
  const legacyGate = createOffPeakGate({ engine, config: { enabled: false, path: legacy }, clock: createClock(PEAK), store: defaultGateStore(legacy) })
  const legacyView = legacyGate.view(P)
  assert.deepEqual(
    { enabled: legacyView.enabled, source: legacyView.source, changedAt: legacyView.changedAt, durable: legacyView.durable },
    { enabled: false, source: 'default', changedAt: null, durable: false },
    'the discarded v1 flag must not enable any session',
  )
  await legacyGate.setEnabled(P, true)
  const upgraded = JSON.parse(readFileSync(legacy, 'utf8')) as { version: number, sessions: Record<string, { enabled: boolean }> }
  assert.equal(upgraded.version, 2, 'the first write after a v1 file must produce a v2 document')
  assert.equal(upgraded.sessions[P]?.enabled, true)
})
