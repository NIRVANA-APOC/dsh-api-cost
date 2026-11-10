/**
 * dsh-api-cost — off-peak gate verification, real-framework interception (T4/v2.3).
 *
 * This is the only test that proves the gate is actually reachable: it builds a
 * REAL `@deepseek-ai/cordis` Context, mounts the REAL `@deepseek-ai/dsh-llm`
 * `LlmRuntime`, registers a stub adapter through the documented
 * `registerAdapter(providers, adapter)` contract, and registers the gate's
 * listener exactly the way `src/host/index.ts` does — a plugin-level
 * `ctx.on('llm/stream', ..., { prepend: true })`. The call under test is a real
 * `ctx.llm.stream(...)`, so the waterfall, the context filter, the adapter
 * dispatch and the abort normalization are the framework's, not a double's.
 *
 * Since v2.2.0 the switch is stored per SESSION; since v2.3.0 its scope is that
 * session **and its delegation subtree**. Every real `GenerateOptions` in this
 * file is stamped with a session id; C8 is the unrelated-conversations claim and
 * C9/C10 are the tree claims — a real parent switch parks its descendant sessions
 * and a real release reaches only the descendants still following it.
 *
 * The only substitution is the clock: the gate is given a deterministic clock
 * so "still parked" and "dispatched at the boundary" are exact instants instead
 * of wall-clock guesses. The pricing engine is the real one, so the tier really
 * is a peak window at `PEAK` and really is off-peak at `BOUNDARY`.
 *
 * Run: <node> --test --test-isolation=none --test-concurrency=1 test/gate-integration.test.ts
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

import { createOffPeakGate } from '../src/host/gate.ts'
import { createPricingEngine, isPricedModel } from '../src/pricing/index.ts'
import type { GateClock, GateStore, OffPeakGate } from '../src/host/gate.ts'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The two conversations the claims are about; the switch is per one of them. */
const SESSION_A = 'session-a'
const SESSION_B = 'session-b'

/** Explicit Beijing wall-clock time; this file never reads the real clock. */
const bj = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  Date.UTC(year, month - 1, day, hour - 8, minute)

/** Wednesday 2026-09-30 10:00 +08:00 — inside the 09:00-12:00 peak window. */
const PEAK = bj(2026, 9, 30, 10)
/** The same day at 12:00, the instant that window ends. */
const BOUNDARY = bj(2026, 9, 30, 12)
/** The model whose id the published card prices, so the gate must hold it. */
const PRICED_MODEL = 'deepseek-flash'
/** A model id no card prices: the documented bypass case. */
const UNPRICED_MODEL = 'gpt-5-nope'

/** The sequence a stub provider answers with: deltas, usage, one terminal finish. */
const CHUNKS: readonly StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'hel' },
  { type: 'text-delta', index: 0, text: 'lo' },
  { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const CHUNK_TYPES = ['block-start', 'text-delta', 'text-delta', 'usage', 'finish']

/* ------------------------------------------------------------------ *
 * Doubles
 * ------------------------------------------------------------------ */

interface PendingSleep {
  readonly deadline: number
  readonly resolve: (released: boolean) => void
}

interface FakeClock extends GateClock {
  readonly asked: readonly number[]
  advanceTo(instant: number): void
  readonly waiting: () => number
}

/** The same deterministic clock as test/gate.test.ts: no real timer, ever. */
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
    advanceTo(next) {
      instant = next
      for (const entry of [...pending]) {
        if (entry.deadline > instant) continue
        pending.splice(pending.indexOf(entry), 1)
        entry.resolve(true)
      }
    },
    waiting: () => pending.length,
  }
}

/** A session-keyed durable double; no two sessions ever share a choice. */
function memoryStore(initial: Readonly<Record<string, boolean>> = {}): GateStore {
  const values = new Map<string, boolean>(Object.entries(initial))
  return {
    read: (sessionId) => values.get(sessionId),
    write(sessionId, enabled) { values.set(sessionId, enabled); return true },
  }
}

/**
 * A provider adapter with no wire code: it records when its body actually
 * started and which session it was asked for, which are the facts a per-session
 * hold is supposed to move. It honours `options.signal` the way a real adapter
 * must, so the framework's own abort normalization is what the consumer sees.
 */
class StubAdapter extends LlmAdapter {
  readonly clock: { now(): number }
  readonly startedAt: number[] = []
  readonly sessions: Array<string | undefined> = []
  calls = 0
  constructor(clock: { now(): number }) {
    super()
    this.clock = clock
  }
  async *stream(options: GenerateOptions): AsyncIterableIterator<StreamChunk> {
    this.calls += 1
    this.startedAt.push(this.clock.now())
    this.sessions.push(options.sessionId as string | undefined)
    if (options.signal?.aborted === true) throw new DOMException('the caller aborted before the provider answered', 'AbortError')
    for (const chunk of CHUNKS) yield chunk
  }
}

interface Rig {
  readonly ctx: Context
  readonly llm: LlmRuntime
  readonly adapter: StubAdapter
  readonly gate: OffPeakGate
  readonly clock: FakeClock
}

/** One real context, one real runtime, one stub adapter, one per-session gate. */
async function createRig(options: {
  at?: number
  /** The configured DEFAULT for sessions with no stored choice. */
  enabled?: boolean
  models?: 'all' | 'priced'
  clock?: FakeClock
  gate?: boolean
} = {}): Promise<Rig> {
  const clock = options.clock ?? createClock(options.at ?? PEAK)
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const llm = ctx.llm
  const adapter = new StubAdapter(clock)
  llm.registerAdapter(['stub'], adapter)
  const gate = createOffPeakGate({
    engine: createPricingEngine(),
    config: { enabled: options.enabled ?? true },
    clock,
    store: memoryStore(),
  })
  if (options.gate !== false) await mountGate(ctx, gate, options.models ?? 'all')
  return { ctx, llm, adapter, gate, clock }
}

/**
 * The registration `src/host/index.ts` performs, verbatim: one synchronous
 * listener, prepended so a downstream middleware can never dispatch around the
 * hold. Reproduced here because `apply()` cannot be handed a clock; the
 * expression is the contract being verified.
 */
function mountGate(ctx: Context, gate: OffPeakGate, models: 'all' | 'priced'): unknown {
  return ctx.plugin({
    name: 'dsh-api-cost-gate-listener',
    apply(inner: Context) {
      inner.on('llm/stream', (request, next) => models === 'priced' && !isPricedModel(request.model)
        ? next()
        : gate.middleware(request, next), { prepend: true })
    },
  })
}

/** A real loop-built request, stamped with the session the loop would stamp it with. */
const request = (model: string, sessionId?: string, signal?: AbortSignal): GenerateOptions => {
  const options: GenerateOptions = {
    provider: 'stub', model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  }
  if (sessionId !== undefined) options.sessionId = sessionId as NonNullable<GenerateOptions['sessionId']>
  if (signal !== undefined) options.signal = signal
  return options
}

const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

async function withDeadline<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${milliseconds}ms — the gate hung`)), milliseconds)
  })
  try { return await Promise.race([promise, deadline]) } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Drain one real stream, starting from an already-issued first pull. */
async function drain<T>(first: Promise<IteratorResult<T>>, iterator: AsyncIterator<T>): Promise<T[]> {
  const chunks: T[] = []
  const head = await withDeadline(first, 1000, 'the first chunk of a real stream')
  if (head.done !== true) chunks.push(head.value)
  for (;;) {
    const step = await withDeadline(iterator.next(), 1000, 'a chunk of a real stream')
    if (step.done === true) return chunks
    chunks.push(step.value)
  }
}

/** The whole sequence a context yields for one call, with no gate mounted. */
async function ungatedSequence(model: string, sessionId: string): Promise<StreamChunk[]> {
  const rig = await createRig({ gate: false })
  const iterator = rig.llm.stream(request(model, sessionId))[Symbol.asyncIterator]()
  return await drain(iterator.next(), iterator)
}

/* ------------------------------------------------------------------ *
 * C. Real-framework interception
 * ------------------------------------------------------------------ */

test('C1 — a real ctx.llm.stream() reaches the registered adapter and yields its sequence', async () => {
  const rig = await createRig({ gate: false })
  const iterator = rig.llm.stream(request(PRICED_MODEL, SESSION_A))[Symbol.asyncIterator]()
  const chunks = await drain(iterator.next(), iterator)
  assert.equal(rig.adapter.calls, 1, 'the adapter must be dispatched exactly once')
  assert.deepEqual(rig.adapter.sessions, [SESSION_A], 'the loop-stamped session id must reach the adapter')
  assert.deepEqual(chunks.map((chunk) => chunk.type), CHUNK_TYPES)
  assert.deepEqual(chunks, [...CHUNKS], 'the runtime must pass the provider sequence through unchanged')
})

test('C2 — a real model call is parked while peak and dispatched at the boundary, unchanged', async () => {
  const rig = await createRig({ at: PEAK, enabled: true })
  assert.equal(rig.gate.view(SESSION_A).peak, true, 'the fixture must start inside a peak window')
  assert.equal(rig.gate.view(SESSION_A).enabled, true, 'the session must inherit the configured default')

  const stream = rig.llm.stream(request(PRICED_MODEL, SESSION_A))
  // The waterfall resolves synchronously; a promise here would replace every
  // model call's chunk stream with a promise.
  assert.equal(typeof (stream as { then?: unknown }).then, 'undefined', 'llm.stream() must stay synchronous')

  const iterator = stream[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()
  assert.equal(rig.adapter.calls, 0, 'P0: no provider request may be dispatched while the tier is peak')
  assert.equal(rig.clock.waiting(), 1, 'the real call must be parked on the gate clock')
  assert.equal(rig.gate.view(SESSION_A).holding, 1)
  assert.equal(rig.gate.view(SESSION_A).state, 'holding')
  assert.equal(rig.gate.view(SESSION_B).holding, 0, 'the other session must not be parked by A\'s switch')

  rig.clock.advanceTo(BOUNDARY)
  const chunks = await drain(firstPull, iterator)

  assert.equal(rig.adapter.calls, 1, 'exactly one provider dispatch, after the boundary')
  assert.deepEqual(rig.adapter.sessions, [SESSION_A], 'the dispatch belongs to the stamped session')
  assert.deepEqual(rig.adapter.startedAt, [BOUNDARY], 'the provider body must start at the boundary instant')
  assert.deepEqual(chunks.map((chunk) => chunk.type), CHUNK_TYPES, 'no synthetic chunk may be added or removed')
  assert.deepEqual(chunks, [...CHUNKS], 'the consumer must see exactly the provider sequence')
  assert.deepEqual(chunks, await ungatedSequence(PRICED_MODEL, SESSION_A), 'and exactly the ungated run')
  assert.equal(rig.gate.view(SESSION_A).holding, 0)
  assert.equal(rig.gate.view(SESSION_A).heldTotal, 1)
})

test('C3 — a real caller abort during the hold yields only the framework\'s terminal chunk', async () => {
  const rig = await createRig({ at: PEAK, enabled: true })
  const controller = new AbortController()
  const iterator = rig.llm.stream(request(PRICED_MODEL, SESSION_A, controller.signal))[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()
  assert.equal(rig.adapter.calls, 0, 'the request must be parked before the abort')

  controller.abort()
  const chunks = await drain(firstPull, iterator)
  assert.equal(rig.adapter.calls, 1, 'the framework owns the aborted dispatch, not the gate')
  assert.equal(chunks.length, 1, `the abort path must add no chunk of its own, saw ${JSON.stringify(chunks)}`)
  const terminal = chunks[0] as Extract<StreamChunk, { type: 'finish' }>
  assert.equal(terminal.type, 'finish')
  assert.equal(terminal.reason.kind, 'aborted', 'the consumer must see the canonical aborted terminal, not a gate invention')
  assert.equal(rig.clock.waiting(), 0, 'the abort must disarm the hold')
})

test('C4 — an already-present signal parks and releases exactly like an absent one', async () => {
  const rig = await createRig({ at: PEAK, enabled: true })
  const controller = new AbortController()
  const iterator = rig.llm.stream(request(PRICED_MODEL, SESSION_A, controller.signal))[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()
  assert.equal(rig.adapter.calls, 0, 'a live signal must not defeat the hold')
  assert.equal(rig.clock.waiting(), 1)
  rig.clock.advanceTo(BOUNDARY)
  const chunks = await drain(firstPull, iterator)
  assert.deepEqual(chunks, [...CHUNKS], 'the sequence must be identical to the no-signal run')
  assert.deepEqual(rig.adapter.startedAt, [BOUNDARY])
})

test('C5 — models:priced bypasses an unpriced model by identity and still holds a priced one', async () => {
  const rig = await createRig({ at: PEAK, enabled: true, models: 'priced' })

  // A model the published card does not price must not be parked at all.
  const bypass = rig.llm.stream(request(UNPRICED_MODEL, SESSION_A))[Symbol.asyncIterator]()
  const bypassChunks = await drain(bypass.next(), bypass)
  assert.equal(rig.adapter.calls, 1, 'the unpriced model must reach the provider without waiting')
  assert.equal(rig.clock.waiting(), 0, 'no timer may be armed for a bypassed model')
  assert.deepEqual(rig.adapter.startedAt, [PEAK], 'the bypassed call must dispatch at the peak instant')
  assert.deepEqual(bypassChunks, [...CHUNKS])

  // The same context must still park the priced model.
  const held = rig.llm.stream(request(PRICED_MODEL, SESSION_A))[Symbol.asyncIterator]()
  const firstPull = held.next()
  await settle()
  assert.equal(rig.adapter.calls, 1, 'the priced model must still be parked')
  assert.equal(rig.clock.waiting(), 1)
  rig.clock.advanceTo(BOUNDARY)
  assert.deepEqual(await drain(firstPull, held), [...CHUNKS])
  assert.deepEqual(rig.adapter.startedAt, [PEAK, BOUNDARY], 'only the priced call moved to the boundary')
})

test('C7 — a deep-frozen loop-built request is parked and dispatched unchanged', async () => {
  const rig = await createRig({ at: PEAK, enabled: true })
  // A loop-built request arrives deep-frozen (mutation throws), so a gate that
  // tried to annotate the request instead of wrapping the stream would fail here.
  const options = request(PRICED_MODEL, SESSION_A)
  options.messages.forEach((message) => { if ('content' in message) message.content.forEach((block) => Object.freeze(block)); Object.freeze(message) })
  Object.freeze(options.messages)
  Object.freeze(options)

  const iterator = rig.llm.stream(options)[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()
  assert.equal(rig.adapter.calls, 0, 'a frozen request must still be parked')
  rig.clock.advanceTo(BOUNDARY)
  assert.deepEqual(await drain(firstPull, iterator), [...CHUNKS], 'a frozen request must dispatch unchanged')
  assert.deepEqual(rig.adapter.startedAt, [BOUNDARY])
  assert.deepEqual(options, request(PRICED_MODEL, SESSION_A), 'the gate must not have rewritten the request')
})

test('C6 — a second prepend listener is outermost and still composes with the hold', async () => {
  const rig = await createRig({ at: PEAK, enabled: true })
  const marks: string[] = []
  // cordis prepends with `unshift`, so the LAST prepend registered is the
  // outermost wrapper. A hold must not swallow that listener's contribution.
  const fiber = rig.ctx.plugin({
    name: 'outer-observer',
    apply(inner: Context) {
      inner.on('llm/stream', (_request, next) => ({
        async *[Symbol.asyncIterator]() {
          marks.push('outer-start')
          yield* next()
          marks.push('outer-end')
          yield { type: 'text-delta', index: 9, text: 'outer-axis' } as StreamChunk
        },
      }), { prepend: true })
    },
  })
  await fiber

  const iterator = rig.llm.stream(request(PRICED_MODEL, SESSION_A))[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()
  assert.deepEqual(marks, ['outer-start'], 'the later prepend listener must be entered first, outside the hold')
  assert.equal(rig.adapter.calls, 0, 'the hold must still apply inside the outer listener')

  rig.clock.advanceTo(BOUNDARY)
  const chunks = await drain(firstPull, iterator)
  assert.deepEqual(marks, ['outer-start', 'outer-end'], 'the outer listener must resume after the hold')
  assert.deepEqual(chunks.map((chunk) => chunk.type), [...CHUNK_TYPES, 'text-delta'], 'the outer contribution must not be swallowed')
  assert.deepEqual(chunks.slice(0, CHUNKS.length), [...CHUNKS], 'the gate must still yield the provider sequence first')
  assert.deepEqual(chunks[chunks.length - 1], { type: 'text-delta', index: 9, text: 'outer-axis' })
})

test('C8 — two concurrent real calls with different sessions: only the enabled session parks, the other dispatches while it waits', async () => {
  const rig = await createRig({ at: PEAK, enabled: false })
  await rig.gate.setEnabled(SESSION_A, true)
  assert.equal(rig.gate.view(SESSION_A).enabled, true)
  assert.equal(rig.gate.view(SESSION_B).enabled, false, 'the other session inherits the default (off)')

  // Session A: a real parked call.
  const heldIterator = rig.llm.stream(request(PRICED_MODEL, SESSION_A))[Symbol.asyncIterator]()
  const heldPull = heldIterator.next()
  await settle()
  assert.equal(rig.adapter.calls, 0, 'the enabled session must be parked before anything is dispatched')
  assert.equal(rig.clock.waiting(), 1)
  assert.equal(rig.gate.view(SESSION_A).holding, 1)
  assert.equal(rig.gate.view(SESSION_A).state, 'holding')

  // Session B: the very same real path, and it goes straight through while A waits.
  const freeIterator = rig.llm.stream(request(PRICED_MODEL, SESSION_B))[Symbol.asyncIterator]()
  const freeChunks = await withDeadline(drain(freeIterator.next(), freeIterator), 1000, 'session B\'s ungated stream')
  assert.deepEqual(freeChunks, [...CHUNKS])
  assert.equal(rig.adapter.calls, 1, 'exactly one dispatch so far: session B reached the adapter')
  assert.deepEqual(rig.adapter.sessions, [SESSION_B], 'the only dispatch belongs to the ungated session')
  assert.deepEqual(rig.adapter.startedAt, [PEAK], 'session B dispatched at the peak instant, while session A was parked')
  assert.equal(rig.gate.view(SESSION_A).holding, 1, 'session B completing must not release session A')
  assert.equal(rig.gate.view(SESSION_B).holding, 0)
  assert.equal(rig.clock.waiting(), 1, 'only A owns a timer')

  rig.clock.advanceTo(BOUNDARY)
  const heldChunks = await withDeadline(drain(heldPull, heldIterator), 1000, 'session A\'s parked stream')
  assert.deepEqual(heldChunks, [...CHUNKS])
  assert.equal(rig.adapter.calls, 2)
  assert.deepEqual(rig.adapter.sessions, [SESSION_B, SESSION_A], 'the parked session must dispatch exactly once, at the boundary')
  assert.deepEqual(rig.adapter.startedAt, [PEAK, BOUNDARY], 'only the enabled session moved to the boundary')
  assert.equal(rig.gate.view(SESSION_A).holding, 0)
  assert.equal(rig.gate.view(SESSION_A).heldTotal, 1)
  assert.equal(rig.gate.view(SESSION_B).heldTotal, 0, 'the ungated session never parked')
})

test('C9 — a real parent switch parks its child and grandchild through the real waterfall, while a sibling root dispatches', async () => {
  const CHILD = 'session-a-child'
  const GRAND = 'session-a-grand'
  const rig = await createRig({ at: PEAK, enabled: false })
  // The delegation links arrive the way the host learns them: session/created.
  rig.gate.observeSession(CHILD, SESSION_A)
  rig.gate.observeSession(GRAND, CHILD)
  await rig.gate.setEnabled(SESSION_A, true)
  assert.deepEqual({ enabled: rig.gate.view(CHILD).enabled, source: rig.gate.view(CHILD).source, inheritedFrom: rig.gate.view(CHILD).inheritedFrom }, { enabled: true, source: 'inherited', inheritedFrom: SESSION_A })

  // The whole tree issues a real ctx.llm.stream() each: parent, child, grandchild.
  const parentIterator = rig.llm.stream(request(PRICED_MODEL, SESSION_A))[Symbol.asyncIterator]()
  const parentFirst = parentIterator.next()
  const childIterator = rig.llm.stream(request(PRICED_MODEL, CHILD))[Symbol.asyncIterator]()
  const childFirst = childIterator.next()
  const grandIterator = rig.llm.stream(request(PRICED_MODEL, GRAND))[Symbol.asyncIterator]()
  const grandFirst = grandIterator.next()
  await settle()
  assert.equal(rig.adapter.calls, 0, 'no provider request may be dispatched while the whole tree is parked')
  assert.equal(rig.clock.waiting(), 3, 'each parked request owns one timer')
  const tree = rig.gate.view(SESSION_A)
  assert.equal(tree.enabled, true)
  assert.equal(tree.source, 'self')
  assert.equal(tree.holding, 3, 'the parent view aggregates its whole tracked subtree')
  assert.equal(tree.ownHolding, 1)
  assert.equal(tree.state, 'holding')
  assert.equal(rig.gate.view(CHILD).ownHolding, 1)
  assert.equal(rig.gate.view(GRAND).holding, 1)

  // A sibling root conversation is not in the tree: it reaches the adapter now.
  const freeIterator = rig.llm.stream(request(PRICED_MODEL, SESSION_B))[Symbol.asyncIterator]()
  const freeChunks = await withDeadline(drain(freeIterator.next(), freeIterator), 1000, 'the sibling root stream')
  assert.deepEqual(freeChunks, [...CHUNKS])
  assert.equal(rig.adapter.calls, 1, 'exactly one dispatch so far: the sibling root reached the adapter')
  assert.deepEqual(rig.adapter.sessions, [SESSION_B], 'the only dispatch belongs to the unrelated conversation')
  assert.deepEqual(rig.adapter.startedAt, [PEAK], 'the sibling root dispatched at the peak instant, while the tree was parked')
  assert.equal(rig.gate.view(SESSION_A).holding, 3, 'the sibling dispatch must not release the parked tree')
  assert.equal(rig.gate.view(SESSION_B).otherHolding, 3, 'it can see the tree waiting without being part of it')

  rig.clock.advanceTo(BOUNDARY)
  const [parentChunks, childChunks, grandChunks] = await withDeadline(Promise.all([
    drain(parentFirst, parentIterator),
    drain(childFirst, childIterator),
    drain(grandFirst, grandIterator),
  ]), 1000, 'the whole parked tree')
  assert.deepEqual(parentChunks, [...CHUNKS])
  assert.deepEqual(childChunks, [...CHUNKS])
  assert.deepEqual(grandChunks, [...CHUNKS])
  assert.equal(rig.adapter.calls, 4, 'the whole tree plus the sibling dispatch exactly once')
  assert.deepEqual(rig.adapter.startedAt, [PEAK, BOUNDARY, BOUNDARY, BOUNDARY], 'the whole tree moved to the boundary, the sibling did not')
  assert.deepEqual([...rig.adapter.sessions].sort(), [SESSION_A, SESSION_B, CHILD, GRAND].sort(), 'every real dispatch belongs to the stamped session')
  assert.equal(rig.gate.view(SESSION_A).holding, 0)
  assert.equal(rig.gate.view(SESSION_A).heldTotal, 3, 'the subtree counter sums the whole tree')
})

test('C10 — disabling a parent mid-hold releases its inheriting child at once but not an explicitly enabled grandchild', async () => {
  const CHILD = 'session-c10-child'
  const GRAND = 'session-c10-grand'
  const rig = await createRig({ at: PEAK, enabled: false })
  rig.gate.observeSession(CHILD, SESSION_A)
  rig.gate.observeSession(GRAND, CHILD)
  await rig.gate.setEnabled(SESSION_A, true)
  // The grandchild's own switch is ON: self wins over the parent's later OFF.
  await rig.gate.setEnabled(GRAND, true)

  const childIterator = rig.llm.stream(request(PRICED_MODEL, CHILD))[Symbol.asyncIterator]()
  const childFirst = childIterator.next()
  const grandIterator = rig.llm.stream(request(PRICED_MODEL, GRAND))[Symbol.asyncIterator]()
  const grandFirst = grandIterator.next()
  await settle()
  assert.equal(rig.adapter.calls, 0, 'the child and the grandchild must both be parked')
  assert.equal(rig.clock.waiting(), 2)
  assert.equal(rig.gate.view(SESSION_A).holding, 2)
  assert.equal(rig.gate.view(SESSION_A).ownHolding, 0)

  await rig.gate.setEnabled(SESSION_A, false)
  const childChunks = await withDeadline(drain(childFirst, childIterator), 1000, 'the released inheriting child')
  assert.deepEqual(childChunks, [...CHUNKS], 'a released hold still yields the provider sequence unchanged')
  assert.equal(rig.adapter.calls, 1, 'the inheriting child is dispatched at once')
  assert.deepEqual(rig.adapter.startedAt, [PEAK], 'the un-gated child dispatches inside peak, not at the boundary')
  await settle()
  assert.equal(rig.clock.waiting(), 1, 'only the explicit-ON grandchild still owns a timer')
  const parent = rig.gate.view(SESSION_A)
  assert.equal(parent.enabled, false)
  assert.equal(parent.holding, 1, 'the grandchild stays parked and counted under the parent')
  assert.equal(parent.ownHolding, 0)
  const grand = rig.gate.view(GRAND)
  assert.equal(grand.source, 'self')
  assert.equal(grand.inheritedFrom, null)
  assert.equal(grand.holding, 1)

  rig.clock.advanceTo(BOUNDARY)
  const grandChunks = await withDeadline(drain(grandFirst, grandIterator), 1000, 'the explicit-ON grandchild')
  assert.deepEqual(grandChunks, [...CHUNKS])
  assert.deepEqual(rig.adapter.startedAt, [PEAK, BOUNDARY], 'only the grandchild moved to the boundary')
  assert.equal(rig.gate.view(SESSION_A).holding, 0)
})
