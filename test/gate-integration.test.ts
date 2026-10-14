/**
 * dsh-api-cost — off-peak gate verification, real-framework interception (T4).
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

function memoryStore(initial?: boolean): GateStore {
  const state = { value: initial }
  return {
    read: () => state.value,
    write(enabled) { state.value = enabled; return true },
  }
}

/**
 * A provider adapter with no wire code: it records when its body actually
 * started, which is the fact a hold is supposed to move. It honours
 * `options.signal` the way a real adapter must, so the framework's own abort
 * normalization is what the consumer sees.
 */
class StubAdapter extends LlmAdapter {
  readonly clock: { now(): number }
  readonly startedAt: number[] = []
  calls = 0
  constructor(clock: { now(): number }) {
    super()
    this.clock = clock
  }
  async *stream(options: GenerateOptions): AsyncIterableIterator<StreamChunk> {
    this.calls += 1
    this.startedAt.push(this.clock.now())
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

/** One real context, one real runtime, one stub adapter, one gate. */
async function createRig(options: {
  at?: number
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

const request = (model: string, signal?: AbortSignal): GenerateOptions => {
  const options: GenerateOptions = {
    provider: 'stub', model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  }
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
async function ungatedSequence(model: string): Promise<StreamChunk[]> {
  const rig = await createRig({ gate: false })
  const iterator = rig.llm.stream(request(model))[Symbol.asyncIterator]()
  return await drain(iterator.next(), iterator)
}

/* ------------------------------------------------------------------ *
 * C. Real-framework interception
 * ------------------------------------------------------------------ */

test('C1 — a real ctx.llm.stream() reaches the registered adapter and yields its sequence', async () => {
  const rig = await createRig({ gate: false })
  const iterator = rig.llm.stream(request(PRICED_MODEL))[Symbol.asyncIterator]()
  const chunks = await drain(iterator.next(), iterator)
  assert.equal(rig.adapter.calls, 1, 'the adapter must be dispatched exactly once')
  assert.deepEqual(chunks.map((chunk) => chunk.type), CHUNK_TYPES)
  assert.deepEqual(chunks, [...CHUNKS], 'the runtime must pass the provider sequence through unchanged')
})

test('C2 — a real model call is parked while peak and dispatched at the boundary, unchanged', async () => {
  const rig = await createRig({ at: PEAK, enabled: true })
  assert.equal(rig.gate.view().peak, true, 'the fixture must start inside a peak window')

  const stream = rig.llm.stream(request(PRICED_MODEL))
  // The waterfall resolves synchronously; a promise here would replace every
  // model call's chunk stream with a promise.
  assert.equal(typeof (stream as { then?: unknown }).then, 'undefined', 'llm.stream() must stay synchronous')

  const iterator = stream[Symbol.asyncIterator]()
  const firstPull = iterator.next()
  await settle()
  assert.equal(rig.adapter.calls, 0, 'P0: no provider request may be dispatched while the tier is peak')
  assert.equal(rig.clock.waiting(), 1, 'the real call must be parked on the gate clock')
  assert.equal(rig.gate.view().holding, 1)
  assert.equal(rig.gate.view().state, 'holding')

  rig.clock.advanceTo(BOUNDARY)
  const chunks = await drain(firstPull, iterator)

  assert.equal(rig.adapter.calls, 1, 'exactly one provider dispatch, after the boundary')
  assert.deepEqual(rig.adapter.startedAt, [BOUNDARY], 'the provider body must start at the boundary instant')
  assert.deepEqual(chunks.map((chunk) => chunk.type), CHUNK_TYPES, 'no synthetic chunk may be added or removed')
  assert.deepEqual(chunks, [...CHUNKS], 'the consumer must see exactly the provider sequence')
  assert.deepEqual(chunks, await ungatedSequence(PRICED_MODEL), 'and exactly the ungated run')
  assert.equal(rig.gate.view().holding, 0)
  assert.equal(rig.gate.view().heldTotal, 1)
})

test('C3 — a real caller abort during the hold yields only the framework\'s terminal chunk', async () => {
  const rig = await createRig({ at: PEAK, enabled: true })
  const controller = new AbortController()
  const iterator = rig.llm.stream(request(PRICED_MODEL, controller.signal))[Symbol.asyncIterator]()
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
  const iterator = rig.llm.stream(request(PRICED_MODEL, controller.signal))[Symbol.asyncIterator]()
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
  const bypass = rig.llm.stream(request(UNPRICED_MODEL))[Symbol.asyncIterator]()
  const bypassChunks = await drain(bypass.next(), bypass)
  assert.equal(rig.adapter.calls, 1, 'the unpriced model must reach the provider without waiting')
  assert.equal(rig.clock.waiting(), 0, 'no timer may be armed for a bypassed model')
  assert.deepEqual(rig.adapter.startedAt, [PEAK], 'the bypassed call must dispatch at the peak instant')
  assert.deepEqual(bypassChunks, [...CHUNKS])

  // The same context must still park the priced model.
  const held = rig.llm.stream(request(PRICED_MODEL))[Symbol.asyncIterator]()
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
  const options = request(PRICED_MODEL)
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
  assert.deepEqual(options, request(PRICED_MODEL), 'the gate must not have rewritten the request')
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

  const iterator = rig.llm.stream(request(PRICED_MODEL))[Symbol.asyncIterator]()
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
