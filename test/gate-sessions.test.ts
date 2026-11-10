/**
 * dsh-api-cost — off-peak gate, independent verification of the ROOT-SESSION
 * half of the conversation-tree contract (GateView schemaVersion 4, adversarial).
 *
 * This artifact was written claim-first for the v2.2.0 per-session contract and
 * has been updated IN PLACE to schemaVersion 4: the switch governs one session
 * and its delegation subtree, `enabled`/`source` are the EFFECTIVE position,
 * `ownHolding` is this session's own parked count while `holding` is its whole
 * tracked subtree's, and `otherHolding` counts requests parked outside it.
 *
 * The V1–V11b claims are preserved because their subject survives the scope
 * change: EVERY session in this file is a ROOT conversation — no parent link is
 * ever announced (no `observeSession`, no `parentOf`) — and the sessions paired in
 * a claim are independent roots, i.e. two separate conversation trees. "Enabling
 * A must not park B" therefore means "an unrelated root conversation is never
 * affected", which is exactly the user requirement. Because no link exists, no
 * view in this file may claim an inherited source, and a root's subtree is just
 * itself (`ownHolding === holding`).
 *
 * Claim → test map (prose form in docs/verification-gate.md):
 *
 *   V1   enabling one root parks only its tree; an independent root returns the
 *        identical next() object and dispatches at the same peak instant
 *        → `V1 — enabling root session A parks only A’s tree; …`
 *   V2   two independent roots hold independently: holding/ownHolding/since/
 *        releaseAt/heldTotal/delayedMs are each root's own tree, and
 *        otherHolding counts what is parked outside it
 *        → `V2 — two independent root sessions hold independently: …`
 *   V3   setEnabled(A,false) releases only A's parked requests; the unrelated
 *        root B stays parked, counted and timer-armed
 *        → `V3 — setEnabled(A,false) releases only A’s parked requests; …`
 *   V4   middleware without a usable session id returns the identical next()
 *        object and never throws; wait() on an ungated session releases at once
 *        → `V4 — middleware without a usable session id …`
 *   V5a  durable state is per session: the v2 file shape round-trips and
 *        restores each session independently
 *        → `V5a — durable state is per session: …`
 *   V5b  a legacy version-1 file is ignored: no session starts gated
 *        → `V5b — a legacy version-1 file is ignored: …`
 *   V5c  an unwritable path degrades to durable:false without throwing;
 *        persist:false writes nothing
 *        → `V5c — an unwritable path degrades …`
 *   V5d  the durable file is capped at 512 sessions, evicting the oldest
 *        changedAt first
 *        → `V5d — the durable file is capped at 512 sessions …`
 *   V6a  GET requires a valid session, returns that session's view, and
 *        per-session ETags never collide
 *        → `V6a — GET requires a valid session …`
 *   V6b  POST flips only the named session; missing/malformed/extra-key bodies
 *        are 400 and change nothing
 *        → `V6b — POST flips only the named session …`
 *   V6c  cross-site, content-type and origin guards are unchanged for
 *        session-addressed gate requests
 *        → `V6c — cross-site, content-type and origin guards are unchanged …`
 *   V7   revision is per session: folded from sessionId + rendered fields
 *        (state/source/counter/releaseAt/changedAt), never from now/delayedMs
 *        → `V7 — revision is per session …`
 *   V8   disabling one root during a hold does not abort an independent root's hold
 *        → `V8 — disabling a root session during a hold …`
 *   V9a  a throwing clock or pricing engine fails open: identity middleware,
 *        no rejection
 *        → `V9a — a throwing clock or pricing engine fails open …`
 *   V9b  a throwing store or publisher cannot throw out of the gate or break a
 *        hold
 *        → `V9b — a throwing store or publisher …`
 *   V10a view() is pure: many viewed sessions write nothing to the durable store
 *        → `V10a — view() is pure …`
 *   V10b many viewed sessions do not grow the gate's retained state without bound
 *        → `V10b — many viewed sessions do not grow …`
 *   V11a the configured default is inherited by every root session and an
 *        explicit switch overrides only that root's own tree
 *        → `V11a — the configured default is inherited per session …`
 *   V11b dispose() releases every session's parked requests, is idempotent and
 *        never throws
 *        → `V11b — dispose() releases every session’s parked requests …`
 *
 * Style follows `test/gate.test.ts`: the real `src/host/gate.ts` and the real
 * `apply()`-registered `/gate` route are driven through their public surfaces.
 * The only doubles are a deterministic clock (sleeps are drained by hand, never
 * by waiting), an in-memory GateStore, a fake webServer and scripted pricing
 * statuses; the real pricing engine is used wherever billing or the real tier
 * matters. No test sleeps in real time; the watchdog timers only turn a hang
 * into a failed assertion.
 *
 * Run: node --test --test-isolation=none --test-concurrency=1 test/gate-sessions.test.ts
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { setFlagsFromString } from 'node:v8'

import { apply } from '../src/host/index.ts'
import { createOffPeakGate, defaultGateStore } from '../src/host/gate.ts'
import { createPricingEngine } from '../src/pricing/index.ts'
import { API_PREFIX } from '../src/shared/contracts.ts'
import type { GateClock, GateStore, OffPeakGate } from '../src/host/gate.ts'
import type { PricingEngine } from '../src/pricing/index.ts'
import type { GateConfig, GateView, PluginConfig, PricingView } from '../src/shared/contracts.ts'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** Explicit Beijing wall-clock time; the tests never read the real clock for tier decisions. */
const bj = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  Date.UTC(year, month - 1, day, hour - 8, minute)

/** Wednesday 2026-09-30 10:00 +08:00 — inside the 09:00-12:00 peak window. */
const PEAK = bj(2026, 9, 30, 10)
/** The same day at 12:00, the instant the peak window ends. */
const BOUNDARY = bj(2026, 9, 30, 12)
/** The same day at 20:00 — outside every published window. */
const OFF_PEAK = bj(2026, 9, 30, 20)
/** Thursday 2026-10-08 10:00 +08:00 — the next peak window after the National Day holiday. */
const SECOND_PEAK = bj(2026, 10, 8, 10)
/** Thursday 2026-10-08 12:00 +08:00 — its boundary. */
const SECOND_BOUNDARY = bj(2026, 10, 8, 12)

const engine = createPricingEngine()
/** The real engine's own view of a peak instant; also a cheap static double for view() sweeps. */
const PEAK_VIEW = engine.status(PEAK)
const OFF_PEAK_VIEW = engine.status(OFF_PEAK)

const SESSION_A = 'session-a'
const SESSION_B = 'session-b'
const SESSION_C = 'session-c'

/* ------------------------------------------------------------------ *
 * Doubles: the clock is deterministic, and only tests advance it
 * ------------------------------------------------------------------ */

interface PendingSleep {
  readonly deadline: number
  readonly resolve: (released: boolean) => void
}

interface FakeClock extends GateClock {
  /** Every requested duration, in call order, so clamping/re-arming is observable. */
  readonly asked: readonly number[]
  /** Move the clock without releasing anything. */
  set(instant: number): void
  /** Move the clock and release every sleep whose deadline has been reached. */
  advanceTo(instant: number): void
  /** Release the newest pending sleep as a timer that fired early. */
  fireEarly(): void
  readonly waiting: () => number
}

/**
 * A deterministic clock: `now()` never moves on its own, so "the request was
 * still parked" is a fact about the code under test rather than about scheduling.
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

interface MemorySessionStore extends GateStore {
  readonly writes: ReadonlyArray<readonly [string, boolean]>
}

/**
 * The session-keyed store double. The gate's tests never reach the real dsh
 * home directory, so a flag written by one test can never enable the next one.
 */
function memorySessionStore(initial: Readonly<Record<string, boolean>> = {}): MemorySessionStore {
  const values = new Map<string, boolean>(Object.entries(initial))
  const writes: Array<readonly [string, boolean]> = []
  return {
    read: (sessionId) => values.get(sessionId),
    write(sessionId, enabled) {
      values.set(sessionId, enabled)
      writes.push([sessionId, enabled] as const)
      return true
    },
    get writes() { return writes },
  }
}

/** A pricing double whose only job is to answer `status` with a scripted view. */
function statusEngine(status: (now: number) => PricingView): PricingEngine {
  return {
    fingerprint: 'gate-sessions-verification-double',
    price() { throw new Error('the gate must never price a call') },
    status,
  }
}

function staticEngine(view: PricingView): PricingEngine {
  return statusEngine(() => view)
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
 * A real deadline used only to turn "it hung" into a failed assertion: the fake
 * clock never advances by itself, so a hold that can only end on a timer would
 * otherwise leave the test suite hanging forever.
 */
async function withDeadline<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${milliseconds}ms — the gate hung`)), milliseconds)
  })
  try { return await Promise.race([promise, deadline]) } finally { if (timer !== undefined) clearTimeout(timer) }
}

/* ------------------------------------------------------------------ *
 * View assertions
 * ------------------------------------------------------------------ */

/**
 * The frozen GateView v4 shape, plus the invariants that tie its fields
 * together: `state` is exactly derived from `enabled`+`peak`, `source` and
 * `inheritedFrom` agree, any parked request implies a non-null wait window (and
 * vice versa), and the session's own parked count is a slice of its subtree
 * aggregate (`ownHolding <= holding`).
 */
function assertGateViewShape(view: GateView, label: string): void {
  assert.equal(typeof view, 'object', `${label}: a view must be an object`)
  assert.notEqual(view, null, `${label}: a view must not be null`)
  assert.equal(view.schemaVersion, 4, `${label}: schemaVersion must be 4`)
  assert.ok(view.source === 'self' || view.source === 'inherited' || view.source === 'default', `${label}: source must be self|inherited|default, got ${String(view.source)}`)
  if (view.source === 'inherited') {
    assert.equal(typeof view.inheritedFrom, 'string', `${label}: an inherited position must name its ancestor`)
    assert.notEqual(view.inheritedFrom, '', `${label}: an inherited position must name a real ancestor`)
  } else {
    assert.equal(view.inheritedFrom, null, `${label}: only an inherited position may name an ancestor`)
  }
  assert.equal(typeof view.sessionId, 'string', `${label}: sessionId must be a string`)
  assert.notEqual(view.sessionId, '', `${label}: sessionId must not be empty`)
  assert.equal(typeof view.enabled, 'boolean', `${label}: enabled must be a boolean`)
  assert.equal(typeof view.peak, 'boolean', `${label}: peak must be a boolean`)
  assert.equal(typeof view.reason, 'string', `${label}: reason must be a string`)
  assert.ok(view.state === 'off' || view.state === 'open' || view.state === 'holding', `${label}: state must be off|open|holding, got ${String(view.state)}`)
  assert.ok(Number.isSafeInteger(view.holding) && view.holding >= 0, `${label}: holding must be a non-negative safe integer`)
  assert.ok(Number.isSafeInteger(view.ownHolding) && view.ownHolding >= 0, `${label}: ownHolding must be a non-negative safe integer`)
  assert.ok(view.ownHolding <= view.holding, `${label}: ownHolding must be a slice of the subtree holding (${view.ownHolding} > ${view.holding})`)
  assert.ok(Number.isSafeInteger(view.heldTotal) && view.heldTotal >= 0, `${label}: heldTotal must be a non-negative safe integer`)
  assert.ok(typeof view.delayedMs === 'number' && Number.isFinite(view.delayedMs) && view.delayedMs >= 0, `${label}: delayedMs must be a non-negative finite number`)
  assert.equal(typeof view.durable, 'boolean', `${label}: durable must be a boolean`)
  assert.equal(typeof view.revision, 'string', `${label}: revision must be a string`)
  assert.notEqual(view.revision, '', `${label}: revision must not be empty`)
  assert.ok(Number.isSafeInteger(view.now), `${label}: now must be a safe integer instant`)
  assert.ok(view.releaseAt === null || Number.isSafeInteger(view.releaseAt), `${label}: releaseAt must be null or a safe integer instant`)
  assert.ok(view.since === null || Number.isSafeInteger(view.since), `${label}: since must be null or a safe integer instant`)
  assert.ok(view.changedAt === null || Number.isSafeInteger(view.changedAt), `${label}: changedAt must be null or a safe integer instant`)
  // Only a hand-made choice can report a switch instant or durability; an
  // inherited/default position was never switched by this session.
  if (view.source === 'self') {
    assert.ok(Number.isSafeInteger(view.changedAt), `${label}: an explicit self choice must report its switch instant`)
  } else {
    assert.equal(view.changedAt, null, `${label}: only a self choice may report a switch instant`)
    assert.equal(view.durable, false, `${label}: an inherited/default position is not durable for this session`)
  }
  assert.ok(view.next === null || (typeof view.next === 'object' && view.next !== null && Number.isSafeInteger((view.next as { at: number }).at) && typeof (view.next as { peak: boolean }).peak === 'boolean'), `${label}: next must be null or {at:number,peak:boolean}`)
  assert.ok(Number.isSafeInteger(view.otherHolding) && view.otherHolding >= 0, `${label}: otherHolding must be a non-negative safe integer`)

  const expectedState = !view.enabled ? 'off' : view.peak ? 'holding' : 'open'
  assert.equal(view.state, expectedState, `${label}: state must be derived from enabled+peak (enabled=${view.enabled}, peak=${view.peak})`)
  if (view.holding > 0) {
    assert.notEqual(view.since, null, `${label}: a parked request must have a since instant`)
    assert.notEqual(view.releaseAt, null, `${label}: a parked request must have a releaseAt instant`)
  } else {
    assert.equal(view.since, null, `${label}: since must be null when nothing is parked`)
    assert.equal(view.releaseAt, null, `${label}: releaseAt must be null when nothing is parked`)
  }
}

/**
 * Read one session's view and assert the full frozen shape plus the ROOT facts
 * of this file: no parent link is ever announced, so the session's subtree is
 * itself and it can never inherit a position.
 */
function viewOf(gate: OffPeakGate, sessionId: string): GateView {
  const view = gate.view(sessionId)
  assertGateViewShape(view, `view(${JSON.stringify(sessionId)})`)
  assert.equal(view.sessionId, sessionId, 'a view must describe exactly the session it was asked about')
  assert.notEqual(view.source, 'inherited', `${JSON.stringify(sessionId)}: no link was announced, so the view must not claim an inherited position`)
  assert.equal(view.inheritedFrom, null, `${JSON.stringify(sessionId)}: no link was announced, so no ancestor may be named`)
  assert.equal(view.ownHolding, view.holding, 'a root session\'s subtree is itself, so ownHolding must equal holding')
  return view
}

interface SessionGateFixture {
  readonly clock: FakeClock
  readonly gate: OffPeakGate
  readonly store: GateStore
  /** One entry per `onChange` call, stamped with the gate's own instant. */
  readonly changes: number[]
}

function sessionGateFixture(options: {
  at?: number
  engine?: PricingEngine
  config?: GateConfig
  store?: GateStore
} = {}): SessionGateFixture {
  const clock = createClock(options.at ?? PEAK)
  const store: GateStore = options.store ?? memorySessionStore()
  const changes: number[] = []
  const gate = createOffPeakGate({
    engine: options.engine ?? engine,
    config: options.config ?? {},
    clock,
    store,
    onChange: () => { changes.push(clock.now()) },
  })
  return { clock, gate, store, changes }
}

/* ------------------------------------------------------------------ *
 * V1. One root conversation's switch never reaches an independent root conversation
 * ------------------------------------------------------------------ */

test('V1 — enabling root session A parks only A’s tree; independent root B returns the identical next() object and dispatches at the same peak instant', async () => {
  // A and B are ROOT sessions with no announced parent: two separate
  // conversation trees. This is the user-visible isolation requirement.
  const h = sessionGateFixture()
  const beforeA = viewOf(h.gate, SESSION_A)
  assert.equal(beforeA.peak, true, 'the fixture must start inside a peak window')
  assert.equal(beforeA.enabled, false)
  assert.equal(beforeA.changedAt, null, 'a session that inherits the default has no switch instant')
  assert.equal(beforeA.durable, false)
  assert.equal(beforeA.state, 'off')
  assert.deepEqual({ source: beforeA.source, inheritedFrom: beforeA.inheritedFrom, ownHolding: beforeA.ownHolding }, { source: 'default', inheritedFrom: null, ownHolding: 0 }, 'an unswitched root follows the configured default and has no ancestor')

  const switchedOn = await h.gate.setEnabled(SESSION_A, true)
  assertGateViewShape(switchedOn, 'setEnabled(A,true)')
  assert.equal(switchedOn.sessionId, SESSION_A)
  assert.equal(switchedOn.enabled, true)
  assert.equal(switchedOn.changedAt, PEAK, 'the switch instant must be the gate clock, not the wall clock')
  assert.deepEqual({ source: switchedOn.source, inheritedFrom: switchedOn.inheritedFrom }, { source: 'self', inheritedFrom: null }, 'a hand switch is this session\'s own choice')

  const untouchedB = viewOf(h.gate, SESSION_B)
  assert.equal(untouchedB.enabled, false, 'enabling A must not enable B')
  assert.equal(untouchedB.changedAt, null)
  assert.equal(untouchedB.durable, false)
  assert.equal(untouchedB.state, 'off')
  assert.deepEqual({ source: untouchedB.source, inheritedFrom: untouchedB.inheritedFrom, ownHolding: untouchedB.ownHolding }, { source: 'default', inheritedFrom: null, ownHolding: 0 }, 'enabling A must not give B a choice or an ancestor')

  // A's llm/stream call parks at the request boundary.
  const aScript = scriptedNext(h.clock)
  const aIterator = h.gate.middleware({ sessionId: SESSION_A }, aScript.next)[Symbol.asyncIterator]()
  const aFirstPull = aIterator.next()
  await settle()
  assert.equal(h.clock.waiting(), 1, 'A must arm exactly one hold timer')
  assert.equal(aScript.delegations(), 0, 'A must not reach next() while the tier is peak')
  assert.equal(aScript.pulls(), 0)
  assert.equal(aScript.startedAt(), null)
  const heldA = viewOf(h.gate, SESSION_A)
  assert.equal(heldA.state, 'holding')
  assert.equal(heldA.holding, 1)
  assert.equal(heldA.ownHolding, 1, 'A is a root, so its own parked call is its whole subtree')
  assert.equal(heldA.source, 'self')
  assert.equal(heldA.since, PEAK)
  assert.equal(heldA.releaseAt, BOUNDARY)
  assert.equal(heldA.otherHolding, 0)

  // B's call is at the very same peak instant and must be completely untouched.
  const bScript = scriptedNext(h.clock)
  const bProduced = bScript.next()
  const bReturned = h.gate.middleware({ sessionId: SESSION_B }, () => bProduced)
  assert.equal(bReturned, bProduced, 'an ungated session must get the very same AsyncIterable back')
  assert.equal((bReturned as { then?: unknown }).then, undefined, 'the middleware must stay synchronous')
  assert.equal(h.clock.now(), PEAK, 'B is exercised at the same peak instant as A')
  const bChunks = await collect(bReturned)
  assert.deepEqual(bChunks, [...SCRIPT], 'B must see the untouched adapter sequence')
  assert.equal(bScript.startedAt(), PEAK, 'B must dispatch immediately, at the peak instant')
  assert.equal(bScript.delegations(), 1)

  // A is still parked after B ran.
  assert.equal(aScript.delegations(), 0, 'B dispatching must not release A')
  assert.equal(h.clock.waiting(), 1, 'only A may own a hold timer')
  assert.equal(viewOf(h.gate, SESSION_A).holding, 1)
  assert.equal(viewOf(h.gate, SESSION_A).otherHolding, 0)
  assert.equal(viewOf(h.gate, SESSION_B).holding, 0)
  assert.equal(viewOf(h.gate, SESSION_B).source, 'default', 'B is still an unswitched root')

  // A releases at the boundary and dispatches exactly once.
  h.clock.advanceTo(BOUNDARY)
  const aFirst = await withDeadline(aFirstPull, 500, 'A’s parked first chunk')
  assert.equal(aFirst.done, false)
  assert.deepEqual(aFirst.value, SCRIPT[0])
  assert.equal(aScript.startedAt(), BOUNDARY, 'A must dispatch at the off-peak boundary')
  const aRest = await withDeadline(collect({ [Symbol.asyncIterator]: () => aIterator }), 500, 'A’s gated stream')
  assert.deepEqual([aFirst.value, ...aRest], [...SCRIPT])
  assert.equal(aScript.delegations(), 1, 'A must delegate exactly once')
  assert.equal(h.clock.waiting(), 0, 'no timer may be left armed after release')
  const afterA = viewOf(h.gate, SESSION_A)
  assert.equal(afterA.holding, 0)
  assert.equal(afterA.heldTotal, 1)
})

/* ------------------------------------------------------------------ *
 * V2. Independent holds: each root's own tree, and otherHolding outside it
 * ------------------------------------------------------------------ */

test('V2 — two independent root sessions hold independently: holding/ownHolding/since/releaseAt/heldTotal/delayedMs are each root’s own tree and otherHolding is outside it', async () => {
  const h = sessionGateFixture()
  await h.gate.setEnabled(SESSION_A, true)
  await h.gate.setEnabled(SESSION_B, true)

  const a1 = h.gate.wait(SESSION_A)
  await settle()
  h.clock.set(PEAK + 30_000)
  const a2 = h.gate.wait(SESSION_A)
  await settle()
  h.clock.set(PEAK + 60_000)
  const b1 = h.gate.wait(SESSION_B)
  await settle()
  assert.equal(h.clock.waiting(), 3, 'each parked request must own a timer')

  const viewA = viewOf(h.gate, SESSION_A)
  assert.equal(viewA.holding, 2, 'A holds two requests')
  assert.equal(viewA.ownHolding, 2, 'A is a root: its own parked requests are its whole subtree')
  assert.equal(viewA.source, 'self')
  assert.equal(viewA.since, PEAK, 'since is the OLDEST parked request of this session')
  assert.equal(viewA.releaseAt, BOUNDARY, 'releaseAt is this session’s boundary')
  assert.equal(viewA.otherHolding, 1, 'otherHolding counts B’s parked requests')
  assert.equal(viewA.heldTotal, 2)

  const viewB = viewOf(h.gate, SESSION_B)
  assert.equal(viewB.holding, 1, 'B holds one request')
  assert.equal(viewB.ownHolding, 1)
  assert.equal(viewB.source, 'self')
  assert.equal(viewB.since, PEAK + 60_000, 'B’s since is its own first park instant')
  assert.equal(viewB.releaseAt, BOUNDARY)
  assert.equal(viewB.otherHolding, 2, 'otherHolding counts A’s two parked requests')
  assert.equal(viewB.heldTotal, 1)

  const viewC = viewOf(h.gate, SESSION_C)
  assert.equal(viewC.holding, 0)
  assert.equal(viewC.ownHolding, 0)
  assert.equal(viewC.source, 'default', 'an unswitched independent root follows the configured default')
  assert.equal(viewC.since, null)
  assert.equal(viewC.releaseAt, null)
  assert.equal(viewC.otherHolding, 3, 'an unconfigured session still sees every other session’s holds')

  h.clock.advanceTo(BOUNDARY)
  const outcomes = await withDeadline(Promise.all([a1, a2, b1]), 500, 'the three holds')
  const expectedWaits = [BOUNDARY - PEAK, BOUNDARY - (PEAK + 30_000), BOUNDARY - (PEAK + 60_000)]
  assert.deepEqual(outcomes.map((outcome) => [outcome.released, outcome.waitedMs]), expectedWaits.map((waited) => [true, waited]))

  const afterA = viewOf(h.gate, SESSION_A)
  assert.equal(afterA.holding, 0)
  assert.equal(afterA.since, null)
  assert.equal(afterA.releaseAt, null)
  assert.equal(afterA.heldTotal, 2)
  assert.equal(afterA.delayedMs, expectedWaits[0]! + expectedWaits[1]!, 'A’s delayedMs is its own absorbed delay')
  const afterB = viewOf(h.gate, SESSION_B)
  assert.equal(afterB.heldTotal, 1)
  assert.equal(afterB.delayedMs, expectedWaits[2]!, 'B’s delayedMs is its own absorbed delay')
  assert.equal(afterB.otherHolding, 0)

  // A second peak window: only A accumulates.
  h.clock.set(SECOND_PEAK)
  const secondA = h.gate.wait(SESSION_A)
  await settle()
  const duringSecond = viewOf(h.gate, SESSION_A)
  assert.equal(duringSecond.holding, 1)
  assert.equal(duringSecond.since, SECOND_PEAK)
  assert.equal(duringSecond.releaseAt, SECOND_BOUNDARY)
  assert.equal(viewOf(h.gate, SESSION_B).heldTotal, 1, 'B’s counters must not move when A parks again')
  assert.equal(viewOf(h.gate, SESSION_B).otherHolding, 1, 'B sees A’s new hold even though B is idle')
  h.clock.advanceTo(SECOND_BOUNDARY)
  const secondOutcome = await withDeadline(secondA, 500, 'A’s second-window hold')
  assert.equal(secondOutcome.waitedMs, SECOND_BOUNDARY - SECOND_PEAK)
  const lastA = viewOf(h.gate, SESSION_A)
  assert.equal(lastA.heldTotal, 3)
  assert.equal(lastA.delayedMs, afterA.delayedMs + secondOutcome.waitedMs, 'delayedMs accumulates only in the session that waited')
})

/* ------------------------------------------------------------------ *
 * V3. Switching one root off releases only that root's requests
 * ------------------------------------------------------------------ */

test('V3 — setEnabled(A,false) releases only A’s parked requests; independent root B stays parked, counted and timer-armed', async () => {
  const h = sessionGateFixture()
  await h.gate.setEnabled(SESSION_A, true)
  await h.gate.setEnabled(SESSION_B, true)

  const aScript = scriptedNext(h.clock)
  const bScript = scriptedNext(h.clock)
  const aIterator = h.gate.middleware({ sessionId: SESSION_A }, aScript.next)[Symbol.asyncIterator]()
  const bIterator = h.gate.middleware({ sessionId: SESSION_B }, bScript.next)[Symbol.asyncIterator]()
  const aPull = aIterator.next()
  const bPull = bIterator.next()
  await settle()
  assert.equal(h.clock.waiting(), 2, 'both sessions must be parked before the switch changes')
  assert.equal(viewOf(h.gate, SESSION_A).holding, 1)
  assert.equal(viewOf(h.gate, SESSION_B).holding, 1)
  assert.equal(viewOf(h.gate, SESSION_A).otherHolding, 1)
  assert.equal(viewOf(h.gate, SESSION_B).otherHolding, 1)

  const switchedOff = await h.gate.setEnabled(SESSION_A, false)
  assertGateViewShape(switchedOff, 'setEnabled(A,false)')
  assert.equal(switchedOff.sessionId, SESSION_A)
  assert.equal(switchedOff.enabled, false)
  assert.equal(switchedOff.state, 'off')
  assert.equal(switchedOff.holding, 0, 'the answer must not claim A is still holding')
  assert.equal(switchedOff.ownHolding, 0)
  assert.deepEqual({ source: switchedOff.source, inheritedFrom: switchedOff.inheritedFrom }, { source: 'self', inheritedFrom: null }, 'turning the switch off is A\'s own explicit choice')

  const aFirst = await withDeadline(aPull, 500, 'A’s released first chunk')
  assert.deepEqual(aFirst.value, SCRIPT[0], 'A must dispatch its untouched stream')
  assert.equal(aScript.startedAt(), PEAK, 'turning the switch off dispatches now, inside peak')
  await settle()

  const bDuring = viewOf(h.gate, SESSION_B)
  assert.equal(bDuring.enabled, true, 'B must still be enabled')
  assert.equal(bDuring.holding, 1, 'B must still be parked')
  assert.equal(bDuring.ownHolding, 1)
  assert.equal(bDuring.source, 'self')
  assert.equal(bDuring.otherHolding, 0)
  assert.equal(viewOf(h.gate, SESSION_A).otherHolding, 1, 'A still counts B’s parked request')
  assert.equal(h.clock.waiting(), 1, 'only B may still own a hold timer')
  assert.equal(bScript.delegations(), 0, 'B must not have been dispatched')
  assert.equal(bScript.startedAt(), null)

  h.clock.advanceTo(BOUNDARY)
  const bFirst = await withDeadline(bPull, 500, 'B’s parked first chunk')
  assert.deepEqual(bFirst.value, SCRIPT[0])
  assert.equal(bScript.startedAt(), BOUNDARY, 'B must still release at the tier boundary, not earlier')
  const afterB = viewOf(h.gate, SESSION_B)
  assert.equal(afterB.holding, 0)
  assert.equal(afterB.heldTotal, 1)
})

/* ------------------------------------------------------------------ *
 * V4. No usable session id is a synchronous identity bypass
 * ------------------------------------------------------------------ */

test('V4 — middleware without a usable session id returns the identical next() object and never throws; wait() on an ungated session releases at once', async () => {
  const h = sessionGateFixture()
  await h.gate.setEnabled(SESSION_A, true)
  const parkedA = h.gate.wait(SESSION_A)
  await settle()
  assert.equal(h.clock.waiting(), 1, 'A must be parked while the bypass calls run')

  const identity = (label: string, options: unknown): void => {
    const produced = scriptedNext(h.clock).next()
    let returned: AsyncIterable<Chunk> | null = null
    assert.doesNotThrow(() => { returned = h.gate.middleware(options as never, () => produced) }, `${label} must never throw`)
    assert.notEqual(returned, null, `${label} must return an iterable`)
    assert.equal(returned, produced, `${label} must return the identical next() object`)
    assert.equal((returned as { then?: unknown }).then, undefined, `${label} must stay synchronous`)
  }
  identity('no sessionId at all', {})
  identity('an empty sessionId', { sessionId: '' })
  identity('a numeric sessionId', { sessionId: 42 })
  identity('a null sessionId', { sessionId: null })
  identity('an object sessionId', { sessionId: {} })
  identity('a boolean sessionId', { sessionId: true })
  identity('a session that never switched the gate', { sessionId: 'session-never-switched' })

  const neverSwitched = viewOf(h.gate, 'session-never-switched')
  assert.deepEqual(
    { enabled: neverSwitched.enabled, source: neverSwitched.source, inheritedFrom: neverSwitched.inheritedFrom },
    { enabled: false, source: 'default', inheritedFrom: null },
    'a root session that never switched the gate follows the configured default',
  )

  const ungated = await h.gate.wait('session-never-switched')
  assert.equal(ungated.released, true, 'wait() on an ungated session must resolve immediately')
  assert.equal(ungated.waitedMs, 0)
  const noSession = await h.gate.wait(undefined as unknown as string)
  assert.equal(noSession.released, true, 'wait() without a usable session id must fail open')

  for (const weird of ['', 'session with spaces', 'x'.repeat(300)]) {
    assert.doesNotThrow(() => { h.gate.view(weird) }, `view(${JSON.stringify(weird)}) must never throw`)
  }

  assert.equal(h.clock.waiting(), 1, 'no bypass call may arm a timer')
  assert.equal(viewOf(h.gate, SESSION_A).holding, 1, 'A must still be parked throughout')
  h.clock.advanceTo(BOUNDARY)
  const outcome = await withDeadline(parkedA, 500, 'A’s hold')
  assert.equal(outcome.released, true)
})

/* ------------------------------------------------------------------ *
 * V5. Per-session durability
 * ------------------------------------------------------------------ */

test('V5a — durable state is per session: the v2 file shape round-trips and restores each session independently', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-api-cost-sessions-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const path = join(directory, 'gate.json')
  const store = defaultGateStore(path)

  assert.equal(store.read(SESSION_A), undefined, 'nothing has been stored yet')
  assert.equal(store.write(SESSION_A, true), true, 'a writable path must report a durable write')
  assert.equal(store.read(SESSION_A), true)
  assert.equal(store.read(SESSION_B), undefined, 'a switch in one session must not create another')

  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version: unknown; sessions: Record<string, unknown> }
  assert.equal(parsed.version, 2, 'the durable file must be the v2 shape')
  assert.deepEqual(Object.keys(parsed).sort(), ['sessions', 'version'], 'the v2 file has exactly version+sessions')
  const entry = parsed.sessions[SESSION_A] as { enabled: unknown; changedAt: unknown }
  assert.equal(entry.enabled, true)
  assert.ok(Number.isSafeInteger(entry.changedAt) && (entry.changedAt as number) >= 0, 'changedAt must be a safe non-negative instant')
  assert.equal(SESSION_B in parsed.sessions, false)

  // A hand-written v2 file is read per session: this fixes the read semantics
  // without relying on the gate's own write path.
  writeFileSync(path, JSON.stringify({ version: 2, sessions: { [SESSION_B]: { enabled: true, changedAt: 111_111 } } }))
  const gate = createOffPeakGate({ engine, config: { path }, clock: createClock(PEAK), store: defaultGateStore(path) })
  const fromDisk = viewOf(gate, SESSION_B)
  assert.equal(fromDisk.enabled, true, 'the stored per-session choice must win')
  assert.equal(fromDisk.changedAt, 111_111, 'the stored switch instant must survive the restart')
  assert.equal(fromDisk.durable, true, 'a choice read from durable storage is durable')
  assert.deepEqual({ source: fromDisk.source, inheritedFrom: fromDisk.inheritedFrom, ownHolding: fromDisk.ownHolding }, { source: 'self', inheritedFrom: null, ownHolding: 0 }, 'a restored stored choice is a self choice of a root')
  const defaulted = viewOf(gate, SESSION_A)
  assert.equal(defaulted.enabled, false, 'a session with nothing stored inherits the configured default')
  assert.equal(defaulted.changedAt, null)
  assert.equal(defaulted.durable, false)
  assert.equal(defaulted.source, 'default', 'nothing stored means no self choice')
  assert.equal(defaulted.inheritedFrom, null)

  // Writing through the gate adds only the named session.
  const written = await gate.setEnabled(SESSION_A, true)
  assert.equal(written.enabled, true)
  assert.equal(written.durable, true, 'a successful store write is durable')
  const after = JSON.parse(readFileSync(path, 'utf8')) as { version: unknown; sessions: Record<string, { enabled: boolean; changedAt: number }> }
  assert.equal(after.version, 2)
  assert.equal(after.sessions[SESSION_A]?.enabled, true)
  assert.equal(after.sessions[SESSION_B]?.enabled, true, 'writing A must not rewrite B’s stored choice')
  assert.ok(Number.isSafeInteger(after.sessions[SESSION_A]?.changedAt))

  // A fresh gate sees both stored choices, and flipping one off leaves the other.
  const restarted = createOffPeakGate({ engine, config: { path }, clock: createClock(PEAK), store: defaultGateStore(path) })
  assert.equal(viewOf(restarted, SESSION_A).enabled, true)
  assert.equal(viewOf(restarted, SESSION_A).source, 'self', 'a restored stored choice is a self choice')
  assert.equal(viewOf(restarted, SESSION_B).enabled, true)
  assert.equal(viewOf(restarted, SESSION_B).source, 'self')
  assert.equal(viewOf(restarted, SESSION_C).enabled, false, 'a stored switch is attributed to its own session only')
  assert.equal(viewOf(restarted, SESSION_C).source, 'default', 'a stored switch creates no choice for another session')
  const offAfterRestart = await restarted.setEnabled(SESSION_A, false)
  assert.equal(offAfterRestart.enabled, false)
  const finalFile = JSON.parse(readFileSync(path, 'utf8')) as { sessions: Record<string, { enabled: boolean }> }
  assert.equal(finalFile.sessions[SESSION_A]?.enabled, false, 'flipping off only rewrites that session')
  assert.equal(finalFile.sessions[SESSION_B]?.enabled, true, 'flipping A off must not touch B’s stored choice')
})

test('V5b — a legacy version-1 file is ignored: no session starts gated', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-api-cost-sessions-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const path = join(directory, 'gate.json')
  writeFileSync(path, JSON.stringify({ version: 1, enabled: true, changedAt: 1_700_000_000_000 }))

  const store = defaultGateStore(path)
  assert.equal(store.read(SESSION_A), undefined, 'a v1 flag cannot be attributed to a session')
  assert.equal(store.read(SESSION_B), undefined)

  const gate = createOffPeakGate({ engine, config: { enabled: false, path }, clock: createClock(PEAK), store })
  for (const sessionId of [SESSION_A, SESSION_B]) {
    const view = viewOf(gate, sessionId)
    assert.equal(view.enabled, false, `no session may start gated from a legacy flag (${sessionId})`)
    assert.equal(view.changedAt, null)
    assert.equal(view.durable, false)
    assert.equal(view.source, 'default', 'a legacy flag cannot become a self choice')
    assert.equal(view.inheritedFrom, null)
  }

  // At peak, the legacy flag must not park anything.
  const script = scriptedNext(createClock(PEAK))
  const produced = script.next()
  assert.equal(gate.middleware({ sessionId: SESSION_A }, () => produced), produced, 'a legacy flag must not open a hold path')

  // The first per-session write replaces the legacy file with the v2 shape.
  const written = await gate.setEnabled(SESSION_A, true)
  assert.equal(written.durable, true)
  assert.equal(written.source, 'self', 'the first hand switch is this session\'s own choice')
  const upgraded = JSON.parse(readFileSync(path, 'utf8')) as { version: unknown; sessions: Record<string, unknown> }
  assert.equal(upgraded.version, 2, 'the first per-session write must upgrade the file to v2')
  assert.deepEqual(Object.keys(upgraded.sessions), [SESSION_A], 'only the switched session may be stored')
  assert.equal(store.read(SESSION_B), undefined, 'the legacy flag must not be re-attributed to another session')
})

test('V5c — an unwritable path degrades to durable:false without throwing; persist:false writes nothing', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-api-cost-sessions-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })

  // A path whose parent is a plain file can never be created.
  const blocked = join(directory, 'blocked')
  writeFileSync(blocked, 'not a directory')
  const target = join(blocked, 'gate.json')
  const unwritable = defaultGateStore(target)
  assert.equal(unwritable.read(SESSION_A), undefined, 'an unreadable store reads as "nothing stored"')
  assert.equal(unwritable.write(SESSION_A, true), false, 'an unwritable path must report failure, never throw')
  const gate = createOffPeakGate({ engine, config: { path: target }, clock: createClock(PEAK), store: unwritable })
  const degraded = await gate.setEnabled(SESSION_A, true)
  assert.equal(degraded.enabled, true, 'the feature must keep working in memory')
  assert.equal(degraded.durable, false, 'an unwritable path can never claim durability')
  assert.deepEqual({ source: degraded.source, inheritedFrom: degraded.inheritedFrom }, { source: 'self', inheritedFrom: null }, 'the switch still names the session that made it')
  assert.equal(existsSync(target), false)

  // persist:false means no store at all.
  const memory = memorySessionStore()
  const noPersist = createOffPeakGate({ engine, config: { persist: false }, clock: createClock(PEAK), store: memory })
  const enabled = await noPersist.setEnabled(SESSION_A, true)
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.durable, false, 'persist:false must report durable:false')
  assert.equal(enabled.source, 'self')
  assert.deepEqual(memory.writes, [], 'persist:false must never write the store')
  const parked = noPersist.wait(SESSION_A)
  await settle()
  assert.equal(noPersist.view(SESSION_A).holding, 1, 'the in-memory switch must still work')
  const off = await noPersist.setEnabled(SESSION_A, false)
  assert.equal(off.holding, 0)
  await withDeadline(parked, 500, 'the in-memory hold')

  // A corrupt file and a malformed v2 entry both read as "nothing stored".
  const corrupt = join(directory, 'corrupt.json')
  writeFileSync(corrupt, '{ not json')
  assert.equal(defaultGateStore(corrupt).read(SESSION_A), undefined, 'a corrupt file reads as "nothing stored"')
  const corruptGate = createOffPeakGate({ engine, config: { path: corrupt }, clock: createClock(PEAK), store: defaultGateStore(corrupt) })
  assert.equal(viewOf(corruptGate, SESSION_A).enabled, false)
  assert.equal(viewOf(corruptGate, SESSION_A).durable, false)
  assert.equal(viewOf(corruptGate, SESSION_A).source, 'default', 'a corrupt file contains no self choice')
  writeFileSync(corrupt, JSON.stringify({ version: 2, sessions: { [SESSION_A]: { enabled: 'yes' } } }))
  assert.equal(defaultGateStore(corrupt).read(SESSION_A), undefined, 'a malformed session entry reads as "nothing stored"')
})

test('V5d — the durable file is capped at 512 sessions, evicting the oldest changedAt first', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-api-cost-sessions-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const path = join(directory, 'gate.json')
  const seeded: Record<string, { enabled: boolean; changedAt: number }> = {}
  for (let index = 1; index <= 512; index += 1) {
    seeded[`seed-${String(index).padStart(3, '0')}`] = { enabled: index % 2 === 0, changedAt: index }
  }
  writeFileSync(path, JSON.stringify({ version: 2, sessions: seeded }))

  const store = defaultGateStore(path)
  assert.equal(store.read('seed-001'), false, 'the seeded file must be readable per session')
  assert.equal(store.read('seed-512'), true)

  // Re-writing an existing session updates it in place: no eviction.
  assert.equal(store.write('seed-100', true), true)
  let parsed = JSON.parse(readFileSync(path, 'utf8')) as { version: unknown; sessions: Record<string, { enabled: boolean; changedAt: number }> }
  assert.equal(parsed.version, 2)
  assert.equal(Object.keys(parsed.sessions).length, 512, 'updating an existing session must not grow the file')
  assert.equal(parsed.sessions['seed-100']?.enabled, true)

  // The 513th session evicts the oldest changedAt, not the first key written.
  assert.equal(store.write('session-new', true), true)
  parsed = JSON.parse(readFileSync(path, 'utf8')) as { version: unknown; sessions: Record<string, { enabled: boolean; changedAt: number }> }
  const ids = Object.keys(parsed.sessions)
  assert.equal(ids.length, 512, 'at most 512 sessions may be persisted')
  assert.equal('session-new' in parsed.sessions, true, 'the write that hit the cap must itself be stored')
  assert.equal('seed-001' in parsed.sessions, false, 'the oldest changedAt must be evicted first')
  assert.equal('seed-002' in parsed.sessions, true, 'only the oldest may be evicted')
  for (const [id, stored] of Object.entries(parsed.sessions)) {
    assert.ok(Number.isSafeInteger(stored.changedAt), `${id}: changedAt must stay a safe instant`)
  }
  assert.equal(store.read('session-new'), true, 'the capped file must still be readable')
  assert.equal(store.read('seed-001'), undefined)
})

/* ------------------------------------------------------------------ *
 * V6. The session-addressed wire
 * ------------------------------------------------------------------ */

const GATE_ROUTE = `${API_PREFIX}/gate`
const JSON_HEADERS = { 'content-type': 'application/json' }

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
  readonly directory: string
  cleanup(): void
}

/**
 * The plugin's own entry point against a fake Cordis context: `apply()` is what
 * registers the `/gate` route, so driving it here is the same code path the GUI
 * uses. The gate's state file is redirected into a temp directory so no test can
 * inherit another test's flags.
 */
function wireHarness(config: PluginConfig = {}): WireHarness {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-api-cost-sessions-wire-'))
  const routes = new Map<string, (req: unknown, res: unknown) => unknown>()
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>()
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
    sessionQuery: { observeSession: async () => { throw new Error('the gate session tests never read session history') } },
    webServer,
    get: (service: string) => services[service],
    effect,
    inject(dependencies: readonly string[], callback: (inner: unknown) => void) {
      if (!dependencies.every((dependency) => services[dependency] !== undefined)) return
      const inner: Record<string, unknown> = { get: ctx.get, effect, on: ctx.on, interval: () => () => {} }
      for (const dependency of dependencies) inner[dependency] = services[dependency]
      callback(inner)
    },
    on(event: string, listener: (...args: unknown[]) => unknown) {
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
    routes, listeners, directory,
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
  query?: string
} = {}): Promise<WireResponse> {
  const base = options.path ?? GATE_ROUTE
  const url = options.query === undefined ? base : `${base}?${options.query}`
  const handler = h.routes.get(base)
  assert.ok(handler !== undefined, `apply() must register ${base}`)
  const res = createResponse()
  const body = options.body === undefined ? undefined : Buffer.from(options.body, 'utf8')
  const req = {
    method: options.method ?? 'GET',
    url,
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

test('V6a — GET requires a valid session, returns that session’s view, and per-session ETags never collide', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })

  const missing = await send(h)
  assert.equal(missing.status, 400, 'a gate read without a session must be refused')
  assert.equal((missing.json() as { code: string }).code, 'INVALID_SESSION')
  assertNoPathLeak(missing, 'V6a GET no session')

  for (const query of ['session=', 'session=bad%20session', `session=${'x'.repeat(200)}`]) {
    const rejected = await send(h, { query })
    assert.equal(rejected.status, 400, `GET ?${query} must be a 400`)
    assert.equal((rejected.json() as { code: string }).code, 'INVALID_SESSION', `GET ?${query} must report INVALID_SESSION`)
  }

  const unknownKey = await send(h, { query: `session=${SESSION_A}&detail=full` })
  assert.equal(unknownKey.status, 400, 'the gate read has exactly one query key')
  assert.equal((unknownKey.json() as { code: string }).code, 'INVALID_PARAMETER')

  const a = await send(h, { query: `session=${SESSION_A}` })
  assert.equal(a.status, 200)
  const viewA = a.json() as GateView
  assertGateViewShape(viewA, 'GET ?session=session-a')
  assert.equal(viewA.sessionId, SESSION_A)
  assert.equal(viewA.enabled, false)
  assert.deepEqual({ source: viewA.source, inheritedFrom: viewA.inheritedFrom, ownHolding: viewA.ownHolding }, { source: 'default', inheritedFrom: null, ownHolding: 0 }, 'the wire view of an unswitched root must carry the v4 default source')
  assert.equal(typeof a.headers['etag'], 'string', 'a gate read must carry an ETag')
  assert.equal(a.headers['etag'], `"${viewA.revision}"`, 'the ETag must be the quoted revision')
  assertNoPathLeak(a, 'V6a GET A')

  const b = await send(h, { query: `session=${SESSION_B}` })
  assert.equal(b.status, 200)
  const viewB = b.json() as GateView
  assertGateViewShape(viewB, 'GET ?session=session-b')
  assert.equal(viewB.sessionId, SESSION_B)
  assert.equal(viewB.source, 'default')
  assert.notEqual(a.headers['etag'], b.headers['etag'], 'two sessions must never share an ETag (sessionId is a rendered field)')
  assert.notEqual(viewA.revision, viewB.revision)

  const notModified = await send(h, { query: `session=${SESSION_A}`, headers: { 'if-none-match': a.headers['etag'] as string } })
  assert.equal(notModified.status, 304)
  assert.equal(notModified.body, '', 'a 304 must carry no body')
  assert.equal(notModified.headers['etag'], a.headers['etag'])
  const foreignValidator = await send(h, { query: `session=${SESSION_A}`, headers: { 'if-none-match': b.headers['etag'] as string } })
  assert.equal(foreignValidator.status, 200, 'another session’s ETag must not validate this session’s read')
})

test('V6b — POST flips only the named session; missing, malformed and extra-key bodies are 400 and change nothing', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })

  const state = async (sessionId: string): Promise<GateView> => {
    const response = await send(h, { query: `session=${sessionId}` })
    assert.equal(response.status, 200, `GET ?session=${sessionId} must succeed`)
    const view = response.json() as GateView
    assertGateViewShape(view, `GET ?session=${sessionId}`)
    return view
  }
  const baselineA = await state(SESSION_A)
  const baselineB = await state(SESSION_B)
  assert.equal(baselineA.enabled, false)
  assert.equal(baselineB.enabled, false)

  // Bodies that are not exactly {"session":<valid id>,"enabled":<boolean>}.
  const malformedBodies: ReadonlyArray<readonly [string, string]> = [
    ['missing session', '{"enabled":true}'],
    ['non-string session', '{"session":42,"enabled":true}'],
    ['null session', '{"session":null,"enabled":true}'],
    ['missing enabled', '{"session":"session-a"}'],
    ['non-boolean enabled', '{"session":"session-a","enabled":"true"}'],
    ['extra key', '{"session":"session-a","enabled":true,"extra":1}'],
    ['array body', '[true]'],
    ['null body', 'null'],
    ['malformed json', '{'],
  ]
  for (const [label, body] of malformedBodies) {
    const rejected = await send(h, { method: 'POST', headers: JSON_HEADERS, body })
    assert.equal(rejected.status, 400, `${label} must be a 400, got ${rejected.status}`)
    assert.equal((rejected.json() as { ok: unknown }).ok, false, `${label} must answer an ApiError`)
    assertNoPathLeak(rejected, `V6b ${label}`)
  }
  // The extra-key case is a body-shape rejection, the documented INVALID_BODY.
  const extraKey = await send(h, { method: 'POST', headers: JSON_HEADERS, body: '{"session":"session-a","enabled":true,"extra":1}' })
  assert.equal((extraKey.json() as { code: string }).code, 'INVALID_BODY')

  for (const sessionId of ['bad session', '', 'x'.repeat(200)]) {
    const rejected = await send(h, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ session: sessionId, enabled: true }) })
    assert.equal(rejected.status, 400, `a malformed session id ${JSON.stringify(sessionId)} must be a 400`)
    assert.equal((rejected.json() as { code: string }).code, 'INVALID_SESSION', 'a malformed session id must report INVALID_SESSION')
  }

  // No rejected write may change either session, not even a revision.
  const afterRejectedA = await state(SESSION_A)
  const afterRejectedB = await state(SESSION_B)
  assert.equal(afterRejectedA.enabled, false, 'a rejected write must not change A')
  assert.equal(afterRejectedB.enabled, false, 'a rejected write must not change B')
  assert.equal(afterRejectedA.revision, baselineA.revision, 'a rejected write must not move A’s revision')
  assert.equal(afterRejectedB.revision, baselineB.revision, 'a rejected write must not move B’s revision')

  // A valid write flips exactly the named session.
  const flipped = await send(h, { method: 'POST', headers: JSON_HEADERS, body: `{"session":"${SESSION_A}","enabled":true}` })
  assert.equal(flipped.status, 200)
  const flippedView = flipped.json() as GateView
  assertGateViewShape(flippedView, 'POST flip A')
  assert.equal(flippedView.sessionId, SESSION_A)
  assert.equal(flippedView.enabled, true)
  assert.notEqual(flippedView.changedAt, null, 'a hand switch must report its instant')
  assert.deepEqual({ source: flippedView.source, inheritedFrom: flippedView.inheritedFrom, ownHolding: flippedView.ownHolding }, { source: 'self', inheritedFrom: null, ownHolding: flippedView.holding }, 'a POST answer is the named session\'s own choice')
  const afterFlipA = await state(SESSION_A)
  const afterFlipB = await state(SESSION_B)
  assert.equal(afterFlipA.enabled, true)
  assert.equal(afterFlipA.source, 'self')
  assert.equal(afterFlipB.enabled, false, 'writing A must not enable B')
  assert.equal(afterFlipB.source, 'default', 'writing A must not give B a self choice')
  assert.notEqual(afterFlipA.revision, baselineA.revision, 'A’s revision must move when A is switched')
  assert.equal(afterFlipB.revision, baselineB.revision, 'B’s revision must not move when A is switched')

  const flipB = await send(h, { method: 'POST', headers: JSON_HEADERS, body: `{"session":"${SESSION_B}","enabled":true}` })
  assert.equal(flipB.status, 200)
  assert.equal((flipB.json() as GateView).sessionId, SESSION_B)
  assert.equal((await state(SESSION_A)).enabled, true, 'flipping B must leave A alone')
  assert.equal((await state(SESSION_B)).enabled, true)

  const offA = await send(h, { method: 'POST', headers: JSON_HEADERS, body: `{"session":"${SESSION_A}","enabled":false}` })
  assert.equal(offA.status, 200)
  assert.equal((await state(SESSION_A)).enabled, false)
  assert.equal((await state(SESSION_A)).source, 'self', 'turning A off is still A\'s own choice')
  assert.equal((await state(SESSION_B)).enabled, true, 'turning A off must not switch B off')

  // The body bound is unchanged: exactly 4096 bytes is accepted, 4097 is not.
  const atLimitBase = `{"session":"${SESSION_B}","enabled":true}`
  const atLimit = atLimitBase + ' '.repeat(4096 - Buffer.byteLength(atLimitBase, 'utf8'))
  assert.equal(Buffer.byteLength(atLimit, 'utf8'), 4096)
  assert.equal((await send(h, { method: 'POST', headers: JSON_HEADERS, body: atLimit })).status, 200, 'exactly 4096 bytes must be accepted')
  const overLimitBase = `{"session":"${SESSION_B}","enabled":false}`
  const overLimit = overLimitBase + ' '.repeat(4097 - Buffer.byteLength(overLimitBase, 'utf8'))
  const oversized = await send(h, { method: 'POST', headers: JSON_HEADERS, body: overLimit })
  assert.equal(oversized.status, 400, 'a body over 4096 bytes must be rejected')
  assert.equal((oversized.json() as { code: string }).code, 'INVALID_BODY')
})

test('V6c — cross-site, content-type and origin guards are unchanged for session-addressed gate requests', async (t) => {
  const h = wireHarness()
  t.after(() => { h.cleanup() })
  const host = '127.0.0.1:19387'

  // The read rule stays: a cross-site page cannot read a session's switch state.
  const crossSiteRead = await send(h, { query: `session=${SESSION_A}`, headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSiteRead.status, 403, 'a cross-site gate read must be refused')
  assert.equal((crossSiteRead.json() as { code: string }).code, 'CROSS_SITE')

  const crossSiteWrite = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' }, body: `{"session":"${SESSION_A}","enabled":true}` })
  assert.equal(crossSiteWrite.status, 403, 'a cross-site write must be refused')
  assert.equal((crossSiteWrite.json() as { code: string }).code, 'CROSS_SITE')
  const crossSiteWins = await send(h, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain' }, body: 'not json' })
  assert.equal(crossSiteWins.status, 403, 'the cross-site rule must run before the content-type rule')

  const wrongType = await send(h, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: `{"session":"${SESSION_A}","enabled":true}` })
  assert.equal(wrongType.status, 415, 'a non-json body must be refused')
  assert.equal((wrongType.json() as { code: string }).code, 'INVALID_CONTENT_TYPE')
  const parameters = await send(h, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: `{"session":"${SESSION_A}","enabled":true}` })
  assert.equal(parameters.status, 200, 'content-type parameters are allowed')

  const matching = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, host, origin: `http://${host}` }, body: `{"session":"${SESSION_B}","enabled":true}` })
  assert.equal(matching.status, 200, 'the panel talks to its own origin')
  const secure = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, host, origin: `https://${host}` }, body: `{"session":"${SESSION_B}","enabled":true}` })
  assert.equal(secure.status, 200, 'the https form of the same host is the same origin')
  for (const origin of ['http://evil.example', `http://${host}.evil.example`, 'null', `https://${host}:1`]) {
    const refused = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, host, origin }, body: `{"session":"${SESSION_B}","enabled":true}` })
    assert.equal(refused.status, 403, `Origin ${origin} must be refused`)
    assert.equal((refused.json() as { code: string }).code, 'CROSS_SITE')
  }
  const noHost = await send(h, { method: 'POST', headers: { ...JSON_HEADERS, origin: `http://${host}` }, body: `{"session":"${SESSION_A}","enabled":true}` })
  assert.equal(noHost.status, 403, 'an Origin we cannot check against Host must be refused')

  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const rejected = await send(h, { method, headers: JSON_HEADERS, body: `{"session":"${SESSION_A}","enabled":true}` })
    assert.equal(rejected.status, 405, `${method} must be a 405`)
    assert.equal(rejected.headers['allow'], 'GET, POST', `${method} must advertise both supported methods`)
    assert.equal(rejected.body, '', 'a 405 must carry no body')
  }

  for (const [label, response] of [['read', crossSiteRead], ['write', crossSiteWrite], ['wrong type', wrongType], ['missing host', noHost]] as const) {
    assertNoPathLeak(response, `V6c ${label}`)
  }
})

/* ------------------------------------------------------------------ *
 * V7. Revision is per session and folds only rendered fields
 * ------------------------------------------------------------------ */

test('V7 — revision is per session: folded from sessionId + rendered fields (state/source/counters/releaseAt/changedAt), never from now/delayedMs', async () => {
  const h = sessionGateFixture()
  const a0 = viewOf(h.gate, SESSION_A)
  const b0 = viewOf(h.gate, SESSION_B)
  assert.notEqual(a0.revision, b0.revision, 'sessionId must be part of the revision, so two sessions never share one')

  // now moves, nothing else does.
  h.clock.advanceTo(PEAK + 60_000)
  const a1 = viewOf(h.gate, SESSION_A)
  assert.notEqual(a1.now, a0.now, 'the fixture must actually move now, or the negative case is vacuous')
  assert.equal(a1.revision, a0.revision, 'now must never enter the revision')
  assert.equal(viewOf(h.gate, SESSION_B).revision, b0.revision)

  // Enabling A is a rendered change for A only.
  await h.gate.setEnabled(SESSION_A, true)
  const a2 = viewOf(h.gate, SESSION_A)
  const b2 = viewOf(h.gate, SESSION_B)
  assert.notEqual(a2.revision, a0.revision, 'enabling a session is a rendered change')
  assert.equal(b2.revision, b0.revision, 'A’s switch must not move B’s revision')

  // A hold in progress changes holding/since/releaseAt once, then only `now`.
  const parked = h.gate.wait(SESSION_A)
  await settle()
  const a3 = viewOf(h.gate, SESSION_A)
  assert.equal(a3.holding, 1)
  assert.notEqual(a3.revision, a2.revision, 'the hold window is a rendered change')

  // `otherHolding` is a rendered field (the panel prints it), so B's revision
  // must move when A parks — otherwise a 304 would hide A's parked request.
  const bDuring = viewOf(h.gate, SESSION_B)
  assert.equal(bDuring.otherHolding, 1, 'B now sees A’s parked request')
  assert.notEqual(bDuring.revision, b2.revision, 'otherHolding is rendered, so B’s revision must move when it changes')

  h.clock.advanceTo(PEAK + 120_000)
  const a4 = viewOf(h.gate, SESSION_A)
  assert.notEqual(a4.now, a3.now, 'the clock must really have moved during the hold')
  assert.equal(a4.revision, a3.revision, 'a hold in progress is not a revision change by itself')

  // Releasing changes the counters that are rendered.
  h.clock.advanceTo(BOUNDARY)
  await withDeadline(parked, 500, 'A’s hold')
  const a5 = viewOf(h.gate, SESSION_A)
  assert.equal(a5.holding, 0)
  assert.equal(a5.heldTotal, 1)
  assert.equal(a5.otherHolding, 0)
  assert.notEqual(a5.revision, a4.revision, 'the counters changed on release, so the revision must move')
  assert.equal(viewOf(h.gate, SESSION_B).otherHolding, 0, 'B’s otherHolding clears when A releases')

  // v4 adds rendered fields: the same effective position reached through the
  // configured default must not share a revision with the same position made a
  // hand choice of this session (source/changedAt are rendered).
  const defaultOn = sessionGateFixture({ config: { enabled: true } })
  const dDefault = viewOf(defaultOn.gate, SESSION_A)
  assert.deepEqual({ enabled: dDefault.enabled, source: dDefault.source, changedAt: dDefault.changedAt }, { enabled: true, source: 'default', changedAt: null })
  await defaultOn.gate.setEnabled(SESSION_A, true)
  const dSelf = viewOf(defaultOn.gate, SESSION_A)
  assert.deepEqual({ enabled: dSelf.enabled, source: dSelf.source }, { enabled: true, source: 'self' })
  assert.notEqual(dSelf.revision, dDefault.revision, 'source/changedAt are rendered fields, so an explicit choice moves the revision even when enabled is unchanged')
})

/* ------------------------------------------------------------------ *
 * V8. One root's switch cannot abort an independent root's hold
 * ------------------------------------------------------------------ */

test('V8 — disabling a root session during a hold does not abort an independent root session’s hold', async () => {
  const h = sessionGateFixture()
  await h.gate.setEnabled(SESSION_A, true)
  await h.gate.setEnabled(SESSION_B, true)

  const aScript = scriptedNext(h.clock)
  const bScript = scriptedNext(h.clock)
  const aIterator = h.gate.middleware({ sessionId: SESSION_A }, aScript.next)[Symbol.asyncIterator]()
  const bIterator = h.gate.middleware({ sessionId: SESSION_B }, bScript.next)[Symbol.asyncIterator]()
  const aPull = aIterator.next()
  const bPull = bIterator.next()
  await settle()
  assert.equal(h.clock.waiting(), 2)

  await h.gate.setEnabled(SESSION_A, false)
  const aFirst = await withDeadline(aPull, 500, 'A’s released first chunk')
  assert.deepEqual(aFirst.value, SCRIPT[0])
  assert.equal(aScript.startedAt(), PEAK)
  await settle()

  // B's hold must be untouched: same timer, no dispatch.
  assert.equal(h.clock.waiting(), 1, 'B’s timer must survive A’s switch')
  assert.equal(bScript.delegations(), 0, 'B must not be aborted or dispatched by A’s switch')
  assert.equal(bScript.startedAt(), null)
  const bDuring = viewOf(h.gate, SESSION_B)
  assert.equal(bDuring.holding, 1)
  assert.equal(bDuring.ownHolding, 1)
  assert.equal(bDuring.source, 'self', 'B’s own explicit switch is untouched by A')
  assert.equal(bDuring.since, PEAK, 'B’s hold start instant must be unchanged')
  assert.equal(bDuring.releaseAt, BOUNDARY)

  h.clock.advanceTo(BOUNDARY)
  const bFirst = await withDeadline(bPull, 500, 'B’s parked first chunk')
  assert.deepEqual(bFirst.value, SCRIPT[0])
  assert.equal(bScript.startedAt(), BOUNDARY, 'B must dispatch at its own boundary, not when A was switched off')
  assert.equal(bScript.delegations(), 1)
})

/* ------------------------------------------------------------------ *
 * V9. Fail-open: the gate can never break a model call
 * ------------------------------------------------------------------ */

test('V9a — a throwing clock or pricing engine fails open: identity middleware, no rejection', async () => {
  const throwingClock: GateClock = {
    now(): number { throw new Error('clock down') },
    sleep(): Promise<boolean> { return Promise.reject(new Error('sleep down')) },
  }
  const clockGate = createOffPeakGate({
    engine: staticEngine(OFF_PEAK_VIEW),
    config: {},
    clock: throwingClock,
    store: memorySessionStore(),
  })
  const clockSwitched = await clockGate.setEnabled(SESSION_A, true)
  assert.equal(clockSwitched.enabled, true, 'a throwing clock must not reject setEnabled')
  assert.equal(clockSwitched.sessionId, SESSION_A)
  assert.equal(clockSwitched.source, 'self')
  assert.doesNotThrow(() => { clockGate.view(SESSION_A) }, 'view() must never throw, even with a broken clock')
  const producedUnderBrokenClock = scriptedNext(createClock(PEAK)).next()
  const returnedUnderBrokenClock = clockGate.middleware({ sessionId: SESSION_A }, () => producedUnderBrokenClock)
  assert.equal(returnedUnderBrokenClock, producedUnderBrokenClock, 'a clock the gate cannot read must make it dispatch immediately')
  assert.equal((returnedUnderBrokenClock as { then?: unknown }).then, undefined, 'the middleware must stay synchronous even when failing open')
  assert.deepEqual(await collect(returnedUnderBrokenClock), [...SCRIPT])
  const clockOutcome = await clockGate.wait(SESSION_A)
  assert.equal(clockOutcome.released, true, 'wait() must resolve, never reject')
  assert.equal(clockOutcome.waitedMs, 0)

  // A pricing engine that throws.
  const brokenEngine: PricingEngine = {
    fingerprint: 'broken-pricing-double',
    price() { throw new Error('pricing down') },
    status() { throw new Error('pricing status down') },
  }
  const engineGate = createOffPeakGate({ engine: brokenEngine, config: {}, clock: createClock(PEAK), store: memorySessionStore() })
  const engineSwitched = await engineGate.setEnabled(SESSION_B, true)
  assert.equal(engineSwitched.enabled, true)
  const engineView = engineGate.view(SESSION_B)
  assertGateViewShape(engineView, 'throwing-engine view')
  assert.notEqual(engineView.state, 'holding', 'a pricing failure must never be classified as a hold')
  assert.deepEqual({ source: engineView.source, inheritedFrom: engineView.inheritedFrom }, { source: 'self', inheritedFrom: null })
  const producedUnderBrokenEngine = scriptedNext(createClock(PEAK)).next()
  const returnedUnderBrokenEngine = engineGate.middleware({ sessionId: SESSION_B }, () => producedUnderBrokenEngine)
  assert.equal(returnedUnderBrokenEngine, producedUnderBrokenEngine, 'a pricing failure must dispatch immediately')
  assert.deepEqual(await collect(returnedUnderBrokenEngine), [...SCRIPT])
  const engineOutcome = await engineGate.wait(SESSION_B)
  assert.equal(engineOutcome.released, true)

  // A peak status with no usable next boundary must also fail open, and so must
  // malformed statuses: the hold path must never act on data it cannot trust.
  const malformedStatuses: ReadonlyArray<readonly [string, () => unknown]> = [
    ['null status', () => null],
    ['non-boolean peak', () => ({ peak: 'yes' })],
    ['peak with a null next', () => ({ ...PEAK_VIEW, peak: true, next: null })],
    ['peak with a malformed next', () => ({ ...PEAK_VIEW, peak: true, next: { at: 'later', peak: false } })],
  ]
  for (const [label, status] of malformedStatuses) {
    const malformedEngine: PricingEngine = {
      fingerprint: `malformed-${label}`,
      price() { throw new Error('must not price') },
      status: status as unknown as PricingEngine['status'],
    }
    const gate = createOffPeakGate({ engine: malformedEngine, config: {}, clock: createClock(PEAK), store: memorySessionStore() })
    await gate.setEnabled(SESSION_A, true)
    const produced = scriptedNext(createClock(PEAK)).next()
    assert.equal(gate.middleware({ sessionId: SESSION_A }, () => produced), produced, `${label}: middleware must fail open`)
    const outcome = await gate.wait(SESSION_A)
    assert.equal(outcome.released, true, `${label}: wait() must fail open`)
  }
})

test('V9b — a throwing store or publisher cannot throw out of the gate or break a hold', async () => {
  const throwingStore: GateStore = {
    read(): boolean | undefined { throw new Error('store read down') },
    write(): boolean { throw new Error('store write down') },
  }
  const gate = createOffPeakGate({ engine, config: {}, clock: createClock(PEAK), store: throwingStore })
  assert.doesNotThrow(() => { gate.view(SESSION_A) }, 'view() must survive a throwing store')
  const switched = await gate.setEnabled(SESSION_A, true)
  assert.equal(switched.enabled, true, 'setEnabled must never reject on a store failure')
  assert.equal(switched.durable, false, 'a store that cannot write can never be durable')
  assert.equal(switched.source, 'self', 'the choice still exists in memory even when it cannot be stored')
  const parked = gate.wait(SESSION_A)
  await settle()
  assert.equal(viewOf(gate, SESSION_A).holding, 1, 'the in-memory hold must still work')
  const publishClock = createClock(PEAK)
  const angryPublisher = createOffPeakGate({
    engine,
    config: {},
    clock: publishClock,
    store: memorySessionStore(),
    onChange() { throw new Error('publisher down') },
  })
  await assert.doesNotReject(async () => { await angryPublisher.setEnabled(SESSION_A, true) }, 'a throwing publisher must not reject setEnabled')
  const angryParked = angryPublisher.wait(SESSION_A)
  await settle()
  assert.equal(viewOf(angryPublisher, SESSION_A).holding, 1, 'a throwing publisher must not break the hold itself')
  assert.equal(viewOf(angryPublisher, SESSION_A).source, 'self')
  publishClock.advanceTo(BOUNDARY)
  const released = await withDeadline(angryParked, 500, 'the hold beside a throwing publisher')
  assert.equal(released.released, true)
  assert.equal(angryPublisher.view(SESSION_A).holding, 0)

  gate.dispose()
  const disposed = await withDeadline(parked, 500, 'the hold beside a throwing store')
  assert.equal(disposed.released, true)
})

/* ------------------------------------------------------------------ *
 * V10. Bounded state
 * ------------------------------------------------------------------ */

test('V10a — view() is pure: many viewed sessions write nothing to the durable store', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-api-cost-sessions-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const path = join(directory, 'gate.json')
  const gate = createOffPeakGate({ engine: staticEngine(PEAK_VIEW), config: { path }, clock: createClock(PEAK), store: defaultGateStore(path) })
  await gate.setEnabled('session-seeded', true)
  assert.equal(existsSync(path), true, 'the fixture must have produced a state file')

  const before = readFileSync(path, 'utf8')
  for (let index = 0; index < 2_000; index += 1) {
    const view = gate.view(`session-viewed-${index}`)
    assert.equal(view.sessionId, `session-viewed-${index}`)
  }
  const after = readFileSync(path, 'utf8')
  assert.equal(after, before, 'view() is a pure read: it must not write the durable store')
  const parsed = JSON.parse(after) as { sessions: Record<string, unknown> }
  assert.deepEqual(Object.keys(parsed.sessions), ['session-seeded'], 'viewing sessions must not persist anything for them')
})

test('V10b — many viewed sessions do not grow the gate’s retained state without bound', async (t) => {
  // Forced GC makes the heap measurement deterministic. If the runtime refuses
  // the trick, the sweep still runs and the heap assertion is not asserted; the
  // fallback is reported as a diagnostic rather than silently skipped.
  const gc = forceGc()
  const VIEWED = 200_000
  const HEAP_BOUND = 16 * 1024 * 1024
  const h = sessionGateFixture({ engine: staticEngine(PEAK_VIEW) })

  // Warm up so one-time allocations (JIT, interned ids) are not counted.
  for (let index = 0; index < 20_000; index += 1) h.gate.view(`warmup-${index}`)
  gc?.(); gc?.()
  const before = process.memoryUsage().heapUsed
  for (let index = 0; index < VIEWED; index += 1) {
    const view = h.gate.view(`session-viewed-${index}`)
    assert.equal(view.sessionId, `session-viewed-${index}`)
  }
  gc?.(); gc?.()
  const delta = process.memoryUsage().heapUsed - before
  if (gc === null) {
    t.diagnostic('forced GC unavailable; heap bound not asserted (V10b heap check skipped, view purity still asserted by V10a)')
  } else {
    assert.ok(delta < HEAP_BOUND, `view() must not retain per-session state: heap grew ${(delta / 1_048_576).toFixed(1)} MiB across ${VIEWED} distinct viewed sessions`)
  }
  const sample = viewOf(h.gate, 'session-viewed-123')
  assert.equal(sample.enabled, false)
  assert.equal(sample.source, 'default')
  assert.equal(sample.otherHolding, 0)
  assert.equal(sample.heldTotal, 0)
})

/** Enable V8's --expose-gc and hand back a gc function; null when unavailable. */
function forceGc(): (() => void) | null {
  try {
    setFlagsFromString('--expose-gc')
    const candidate: unknown = runInNewContext('gc')
    return typeof candidate === 'function' ? candidate as () => void : null
  } catch { return null }
}

/* ------------------------------------------------------------------ *
 * V11. Configured default, root override, dispose
 * ------------------------------------------------------------------ */

test('V11a — the configured default is inherited by every root session and an explicit switch overrides only that root’s own tree', async () => {
  const h = sessionGateFixture({ config: { enabled: true } })
  const inheritA = viewOf(h.gate, SESSION_A)
  assert.equal(inheritA.enabled, true, 'a never-switched session inherits config.gate.enabled')
  assert.equal(inheritA.changedAt, null, 'inheriting the default is not a hand switch')
  assert.equal(inheritA.durable, false, 'an inherited default is not durable')
  assert.equal(inheritA.state, 'holding', 'enabled at peak is the holding state')
  assert.deepEqual({ source: inheritA.source, inheritedFrom: inheritA.inheritedFrom }, { source: 'default', inheritedFrom: null }, 'following the configured default is not inheritance from another session')
  const inheritB = viewOf(h.gate, SESSION_B)
  assert.equal(inheritB.enabled, true)
  assert.equal(inheritB.source, 'default')

  const aWaiter = h.gate.wait(SESSION_A)
  const bWaiter = h.gate.wait(SESSION_B)
  await settle()
  assert.equal(viewOf(h.gate, SESSION_A).holding, 1)
  assert.equal(viewOf(h.gate, SESSION_B).holding, 1)
  assert.equal(h.clock.waiting(), 2)

  const switchedOff = await h.gate.setEnabled(SESSION_A, false)
  assert.equal(switchedOff.enabled, false)
  assert.equal(switchedOff.changedAt, PEAK, 'the first hand switch records its instant')
  assert.equal(switchedOff.source, 'self', 'the override is this session\'s own choice')
  const releasedA = await withDeadline(aWaiter, 500, 'A’s release')
  assert.equal(releasedA.released, true)
  await settle()
  assert.equal(viewOf(h.gate, SESSION_A).holding, 0)
  assert.equal(viewOf(h.gate, SESSION_B).holding, 1, 'B still inherits the default and stays parked')
  assert.equal(h.clock.waiting(), 1)

  h.clock.advanceTo(BOUNDARY)
  const releasedB = await withDeadline(bWaiter, 500, 'B’s release')
  assert.equal(releasedB.released, true)

  h.clock.set(SECOND_PEAK)
  const offOutcome = await withDeadline(h.gate.wait(SESSION_A), 500, 'A’s disabled wait')
  assert.equal(offOutcome.released, true, 'a disabled session must not park, even at peak')
  assert.equal(offOutcome.waitedMs, 0)
  assert.equal(h.clock.waiting(), 0)

  // The inherited default must gate the middleware too, not just wait(): a
  // session that has never been switched by hand is still a gated session.
  const inheritedScript = scriptedNext(h.clock)
  const inheritedIterator = h.gate.middleware({ sessionId: SESSION_C }, inheritedScript.next)[Symbol.asyncIterator]()
  const inheritedPull = inheritedIterator.next()
  await settle()
  assert.equal(h.clock.waiting(), 1, 'a session inheriting enabled:true must arm a hold')
  assert.equal(inheritedScript.delegations(), 0, 'a session inheriting enabled:true must not reach next() at peak')
  assert.equal(inheritedScript.startedAt(), null)
  const inheritedHeld = viewOf(h.gate, SESSION_C)
  assert.equal(inheritedHeld.holding, 1)
  assert.equal(inheritedHeld.ownHolding, 1)
  assert.equal(inheritedHeld.source, 'default', 'it follows the configured default, not an ancestor')
  assert.equal(inheritedHeld.state, 'holding')
  assert.equal(inheritedHeld.changedAt, null, 'it still inherits the default; nobody switched it')
  // Switching that one session off releases it; the other inherited default persists.
  await h.gate.setEnabled(SESSION_C, false)
  const inheritedFirst = await withDeadline(inheritedPull, 500, 'the inherited-default hold release')
  assert.deepEqual(inheritedFirst.value, SCRIPT[0], 'the released call must dispatch its untouched stream')
  assert.equal(inheritedScript.startedAt(), SECOND_PEAK, 'the released call dispatches now, at the configured peak instant')
  assert.equal(viewOf(h.gate, SESSION_C).holding, 0)
  assert.equal(viewOf(h.gate, SESSION_B).enabled, true, 'B still inherits the configured default')
  assert.equal(viewOf(h.gate, SESSION_B).source, 'default')
  assert.equal(h.clock.waiting(), 0)
})

test('V11b — dispose() releases every session’s parked requests, is idempotent and never throws', async () => {
  const h = sessionGateFixture()
  await h.gate.setEnabled(SESSION_A, true)
  await h.gate.setEnabled(SESSION_B, true)
  const aWaiter = h.gate.wait(SESSION_A)
  const bWaiter = h.gate.wait(SESSION_B)
  await settle()
  assert.equal(h.clock.waiting(), 2)

  assert.doesNotThrow(() => { h.gate.dispose() })
  const outcomes = await withDeadline(Promise.all([aWaiter, bWaiter]), 500, 'the disposed holds')
  assert.deepEqual(outcomes.map((outcome) => outcome.released), [true, true], 'dispose must release parked requests, not abandon them')
  assert.equal(h.clock.waiting(), 0, 'dispose must disarm every timer')
  assert.doesNotThrow(() => { h.gate.dispose() }, 'dispose must be idempotent')
  assert.doesNotThrow(() => { h.gate.view(SESSION_A) }, 'view must stay safe after dispose')
  await assert.doesNotReject(async () => { await h.gate.setEnabled(SESSION_B, false) }, 'setEnabled must not reject after dispose')
})
