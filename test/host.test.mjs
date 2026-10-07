/**
 * dsh-api-cost — Host-half integration test.
 *
 * Drives `index.mjs` through a fake Cordis context: it records the listeners the
 * plugin registers, replays a realistic call sequence, and asserts on the exact
 * HTTP payloads the Client half would receive. This is the test that proves the
 * metering path (llm/stream → assistant-stream usage → priced ledger) and the
 * four disjoint token buckets, without a running Harness.
 *
 * Run: <node> --test test/host.test.mjs   (from the package directory)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, name } from '../index.mjs'
import { classifyInstant } from '../lib/pricing.mjs'

/* ------------------------------------------------------------------ *
 * Fake Cordis context
 * ------------------------------------------------------------------ */

/**
 * Minimal Cordis stand-in: records `on` listeners and `webServer` routes, runs
 * `effect` callbacks immediately, and exposes timer/interval helpers as no-ops.
 * @returns {object} `{ ctx, emit, routes, logs, state }`.
 */
function harness() {
  /** @type {Map<string, Function>} */
  const listeners = new Map()
  /** @type {Map<string, Function>} */
  const routes = new Map()
  const logs = []
  const effects = []
  const registered = { tools: [], commands: [] }
  /** Delegation tree the fake subagent service reports, `rootId -> entries`. */
  const descendants = new Map()
  /** Every root the plugin asked the service about. */
  const descendantCalls = []
  /** Fake Team roster: `sessionId -> membership`, plus the rows it reports. */
  const teams = new Map()
  const agentsById = new Map()
  /** Fake durable logs (`sessionId -> { session, events }`) behind `sessionQuery`. */
  const sessionLogs = new Map()
  /** Sessions the fake corpus lists, newest first. */
  let corpus = []
  const logReads = []

  const ctx = {
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return () => { if (typeof dispose === 'function') dispose() }
    },
    interval() { return () => {} },
    timeout() { return () => {} },
    get(service) {
      if (service === 'tools') {
        return { register: (definition) => { registered.tools.push(definition); return () => {} } }
      }
      if (service === 'commands') {
        return { register: (definition) => { registered.commands.push(definition); return () => {} } }
      }
      if (service === 'subagents') {
        return {
          listDescendants: async (rootId) => {
            descendantCalls.push(rootId)
            return descendants.get(rootId) ?? []
          },
        }
      }
      if (service === 'agents') {
        return { get: (id) => agentsById.get(id) }
      }
      if (service === 'agentTeams') {
        return {
          tryMembership: (agent) => teams.get(agent === null || agent === undefined ? undefined : agent.id)?.membership,
          listMembers: (agent) => teams.get(agent === null || agent === undefined ? undefined : agent.id)?.members ?? [],
        }
      }
      if (service === 'sessionQuery') {
        return {
          listSessions: async () => corpus.map((id) => ({
            header: { id, parentSession: sessionLogs.get(id)?.session?.parentSession },
            live: false,
            persisted: true,
          })),
          readSession: async (id) => {
            logReads.push(id)
            const entry = sessionLogs.get(id)
            if (entry === undefined) throw new Error(`no log for ${id}`)
            return { session: entry.session ?? { id }, events: entry.events }
          },
        }
      }
      return undefined
    },
    webServer: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
  }

  const originalLog = console.log
  console.log = (...args) => { logs.push(args.join(' ')) }

  return {
    ctx,
    routes,
    logs,
    registered,
    listeners,
    descendants,
    descendantCalls,
    teams,
    agentsById,
    sessionLogs,
    logReads,
    /** Replace the corpus the fake `sessionQuery` lists. */
    setCorpus(ids) { corpus = ids.slice() },
    restore() { console.log = originalLog },
    /**
     * Dispatch one recorded event.
     * @param {string} event - event name.
     * @param {...unknown} args - handler arguments.
     * @returns {unknown} handler result.
     */
    emit(event, ...args) {
      const handler = listeners.get(event)
      assert.ok(handler !== undefined, `plugin did not listen to ${event}`)
      return handler(...args)
    },
    /**
     * Dispatch one event the way Cordis does: a leading object argument becomes
     * the event's `this` (the scoped context), not a listener parameter.
     * @param {string} event - event name.
     * @param {object} thisArg - the dispatching context.
     * @param {...unknown} args - the remaining arguments.
     * @returns {unknown} handler result.
     */
    emitOn(event, thisArg, ...args) {
      const handler = listeners.get(event)
      assert.ok(handler !== undefined, `plugin did not listen to ${event}`)
      return handler.apply(thisArg, args)
    },
    /**
     * Call one registered HTTP route with a fake request/response pair. The
     * handlers resolve the delegation tree first, so this drains microtasks the
     * way the webserver awaits the handler's promise.
     * @param {string} path - route path.
     * @param {string} query - query string without '?'.
     * @returns {Promise<{status: number, body: any}>} the written response.
     */
    async request(path, query = '') {
      const handler = routes.get(path)
      assert.ok(handler !== undefined, `route ${path} not registered`)
      let status = 0
      let payload = ''
      const res = {
        writeHead(code) { status = code },
        end(text) { payload = text },
      }
      const url = query === '' ? path : `${path}?${query}`
      try {
        // Await the handler's chain (it resolves the delegation tree first).
        await handler({ url, method: 'GET', headers: {} }, res)
      } catch (error) {
        // A live webserver answers a thrown handler with 400; mirror that here
        // so a test can assert on the diagnostic body.
        status = 400
        payload = JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) })
      }
      return { status, body: payload === '' ? null : JSON.parse(payload) }
    },
  }
}

/** A realistic settled call, in the exact shape DSH writes to its session log. */
const REAL_USAGE = { inputTokens: 459, outputTokens: 294, cacheReadTokens: 10496, cacheWriteTokens: 0, totalTokens: 11249 }

/** Instant that is definitively peak: Wednesday 2026-09-30 10:00 +08:00. */
const PEAK_AT = Date.parse('2026-09-30T10:00:00+08:00')

/** Per-session call counter, so replayed frames carry distinct log positions. */
const callPositions = new Map()

/**
 * Replay one complete model call.
 * @param {object} h - harness.
 * @param {object} options - `{ sessionId, model, usage, turn, step }`.
 */
function replayCall(h, options) {
  const { sessionId = 'session-test', model = 'deepseek-flash', usage = REAL_USAGE } = options
  const seenSoFar = (callPositions.get(sessionId) ?? 0) + 1
  callPositions.set(sessionId, seenSoFar)
  const turn = options.turn ?? 1
  const step = options.step ?? seenSoFar
  h.emit('llm/stream', { provider: 'deepseek-account', model, sessionId, messages: [] }, () => (async function* () {})())
  h.emit('agent/assistant-stream', {
    agent: { id: sessionId },
    frame: { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: Date.now(), turn, step, chunk: { type: 'usage', usage } },
  })
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test('host half exports the Cordis entry contract', async () => {
  assert.equal(name, 'dsh-api-cost')
  assert.equal(typeof apply, 'function')
})

test('registers exactly the three cost routes and both event listeners', async () => {
  const h = harness()
  apply(h.ctx)
  h.restore()
  assert.deepEqual([...h.routes.keys()].sort(), ['/dsh-api-cost/api', '/dsh-api-cost/api/reconcile', '/dsh-api-cost/api/session', '/dsh-api-cost/api/status'])
  assert.ok(h.listeners.has('llm/stream'))
  assert.ok(h.listeners.has('agent/assistant-stream'))
  assert.equal(h.registered.tools.length, 1)
  assert.equal(h.registered.tools[0].name, 'session_cost')
  assert.equal(h.registered.commands.length, 1)
  assert.equal(h.registered.commands[0].name, 'cost')
})

test('a settled call lands in the ledger with the four disjoint buckets', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'session-a' })
  h.restore()

  const { status, body } = await h.request('/dsh-api-cost/api', 'session=session-a')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  const session = body.session
  assert.equal(session.calls, 1)
  assert.deepEqual(session.tokens, { cacheHit: 10496, cacheMiss: 459, output: 294, reasoning: 0, total: 11249 })
  assert.ok(session.costCny > 0, 'a real call must cost something')
  assert.ok(session.costUsd > 0)
  // USD is the CNY column over DeepSeek's own published factor.
  assert.ok(Math.abs(session.costUsd * 6.6667 - session.costCny) < 1e-6)
  assert.match(body.session.recent[0].model, /deepseek-flash/)
})

test('a call observed without a usage report is never billed', async () => {
  const h = harness()
  apply(h.ctx)
  h.emit('llm/stream', { provider: 'deepseek-account', model: 'deepseek-flash', sessionId: 'session-b' }, () => (async function* () {})())
  h.restore()
  const { body } = await h.request('/dsh-api-cost/api', 'session=session-b')
  assert.equal(body.session.calls, 0)
  assert.equal(body.session.costCny, 0)
  assert.equal(body.session.inFlight.length, 1)
  assert.equal(body.pricing.model.key, 'deepseek-flash')
})

test('usage without a preceding request still bills, flagged with an unknown model', async () => {
  const h = harness()
  apply(h.ctx)
  h.emit('agent/assistant-stream', {
    agent: { id: 'session-c' },
    frame: { type: 'chunk', chunk: { type: 'usage', usage: REAL_USAGE } },
  })
  h.restore()
  const { body } = await h.request('/dsh-api-cost/api', 'session=session-c')
  assert.equal(body.session.calls, 1)
  assert.equal(body.session.recent[0].modelId, '(unknown)')
})

test('usage chunks are cumulative per call: the second report for the same call replaces the first', async () => {
  // DSH emits one usage chunk per attempt; a retry or an incremental report for
  // the same request must not be summed again.
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'session-d' })
  replayCall(h, { sessionId: 'session-d' })
  h.restore()
  const { body } = await h.request('/dsh-api-cost/api', 'session=session-d')
  assert.equal(body.session.calls, 2, 'two requests settled as two calls')
  assert.equal(body.session.tokens.total, 22498)
})

test('sessions are isolated from each other', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'session-x' })
  replayCall(h, { sessionId: 'session-y' })
  replayCall(h, { sessionId: 'session-y' })
  h.restore()
  const x = (await h.request('/dsh-api-cost/api', 'session=session-x')).body.session
  const y = (await h.request('/dsh-api-cost/api', 'session=session-y')).body.session
  assert.equal(x.calls, 1)
  assert.equal(y.calls, 2)
  assert.ok(x.costCny < y.costCny)
})

test('an unknown session reports an empty ledger rather than failing', async () => {
  const h = harness()
  apply(h.ctx)
  h.restore()
  const { status, body } = await h.request('/dsh-api-cost/api', 'session=nope')
  assert.equal(status, 200)
  assert.equal(body.session.calls, 0)
  assert.equal(body.session.known, false)
  assert.equal(body.session.costCny, 0)
})

test('the snapshot carries the pricing window, the rate card and the boundary', async () => {
  const h = harness()
  apply(h.ctx)
  h.restore()
  const { body } = await h.request('/dsh-api-cost/api/status')
  const pricing = body.pricing
  assert.equal(pricing.peak, classifyInstant(pricing.now).peak)
  assert.ok(['peak-window', 'weekend', 'holiday', 'makeup-workday', 'outside-window', 'holiday-data-missing', 'before-policy'].includes(pricing.reason))
  assert.equal(pricing.rates.peak.cacheHitCny, 0.04)
  assert.equal(pricing.rates.offPeak.cacheMissCny, 1)
  assert.equal(pricing.rates.peak.outputCny, 8)
  assert.equal(pricing.rates.offPeak.outputCny, 4)
  assert.ok(pricing.next === null || typeof pricing.next.at === 'number')
  assert.match(pricing.source, /api-docs\.deepseek\.com/)
  // The full card is shipped so the widget can explain any model it shows.
  assert.ok(body.rateCard['deepseek-flash'])
  assert.ok(body.rateCard['deepseek-v4-pro'])
})

test('a peak-window call is priced at peak rates; the tier is recorded per call', async () => {
  const h = harness()
  apply(h.ctx)
  // Freeze the settlement clock so the tier is deterministic.
  const realNow = Date.now
  Date.now = () => PEAK_AT
  try {
    replayCall(h, { sessionId: 'session-peak' })
    h.restore()
    const { body } = await h.request('/dsh-api-cost/api', 'session=session-peak')
    const entry = body.session.recent[0]
    assert.equal(classifyInstant(PEAK_AT).peak, true, 'test fixture must be inside a peak window')
    assert.equal(entry.peak, true)
    assert.equal(entry.reason, 'peak-window')
    // 459 miss * 2 + 10496 hit * 0.04 + 294 output * 8, per million tokens.
    // Independently verified value (task-2 adversarial case T1).
    assert.ok(Math.abs(entry.costCny - 0.00368984) < 1e-12, `expected 0.00368984, got ${entry.costCny}`)
    assert.ok(Math.abs(entry.costUsd - 0.000553476) < 1e-12, `expected 0.000553476, got ${entry.costUsd}`)
    assert.equal(body.session.peakCostCny, entry.costCny)
    assert.equal(body.session.offPeakCostCny, 0)
  } finally {
    Date.now = realNow
  }
})

test('off-peak calls are billed at exactly half the peak rate for the same tokens', async () => {
  const h = harness()
  apply(h.ctx)
  const realNow = Date.now
  // Sunday 2026-09-20 is a 调休 makeup workday AND a weekend — off-peak either way.
  const offPeakAt = Date.parse('2026-09-20T10:00:00+08:00')
  try {
    Date.now = () => offPeakAt
    replayCall(h, { sessionId: 'session-offpeak' })
    h.restore()
    const { body } = await h.request('/dsh-api-cost/api', 'session=session-offpeak')
    const entry = body.session.recent[0]
    assert.equal(entry.peak, false)
    // Exactly half of the verified peak figure for the same token vector.
    assert.ok(Math.abs(entry.costCny - 0.00184492) < 1e-12, `off-peak must be half: ${entry.costCny}`)
    assert.ok(Math.abs(entry.costUsd - 0.000276738) < 1e-12, `off-peak must be half: ${entry.costUsd}`)
  } finally {
    Date.now = realNow
  }
})

test('the session_cost tool reports the calling session', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'session-tool' })
  h.restore()
  const definition = h.registered.tools[0]
  const value = await definition.execute({}, { agent: { id: 'session-tool' } })
  assert.equal(value.sessionId, 'session-tool')
  assert.equal(value.calls, 1)
  assert.equal(value.cacheHitTokens, 10496)
  assert.equal(value.cacheMissTokens, 459)
  assert.equal(value.outputTokens, 294)
  assert.match(value.text, /session-tool/)
  const rendered = definition.output.render({}, value)
  assert.equal(rendered[0].type, 'text')
  assert.match(rendered[0].text, /¥/)
})

test('the /cost command reports tier, boundary and current rates', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'session-cmd' })
  h.restore()
  const result = h.registered.commands[0].handler({ rawInput: '', agent: { id: 'session-cmd' } })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /(PEAK|OFF-PEAK)/)
  assert.match(result.text, /Rates now/)
})

test('malformed events never throw and never corrupt the ledger', async () => {
  const h = harness()
  apply(h.ctx)
  const cases = [
    ['agent/assistant-stream', {}],
    ['agent/assistant-stream', { agent: {}, frame: null }],
    ['agent/assistant-stream', { agent: { id: 'session-bad' }, frame: { type: 'chunk', chunk: { type: 'text-delta' } } }],
    ['agent/assistant-stream', { agent: { id: 'session-bad' }, frame: { type: 'chunk', chunk: { type: 'usage', usage: null } } }],
    ['agent/assistant-stream', { agent: { id: 'session-bad' }, frame: { type: 'end', outcome: { kind: 'abandoned' } } }],
    ['agent/assistant-stream', { agent: { id: 'session-bad' }, frame: { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: Number.NaN, outputTokens: -5 } } } }],
  ]
  for (const [event, payload] of cases) {
    assert.doesNotThrow(() => h.emit(event, payload))
  }
  h.emit('llm/stream', { model: 'deepseek-flash' }, () => (async function* () {})())
  h.emit('llm/stream', {}, () => (async function* () {})())
  h.restore()
  const { body } = await h.request('/dsh-api-cost/api', 'session=session-bad')
  assert.ok(Number.isFinite(body.session.tokens.total))
  assert.ok(Number.isFinite(body.session.costCny))
  assert.equal(body.session.tokens.total, 0)
})

test('llm/stream returns the downstream stream untouched', async () => {
  const h = harness()
  apply(h.ctx)
  const sentinel = (async function* () { yield { type: 'finish' } })()
  const returned = h.emit('llm/stream', { model: 'deepseek-flash', sessionId: 'session-s' }, () => sentinel)
  h.restore()
  assert.equal(returned, sentinel, 'the waterfall must not wrap or buffer the provider stream')
})

test('the plugin survives a composition without tools or commands', async () => {
  const h = harness()
  const bare = { ...h.ctx, get: () => undefined }
  assert.doesNotThrow(() => apply(bare))
  h.restore()
})

test('route registrations are disposed through effect', async () => {
  const h = harness()
  const disposers = []
  const tracking = { ...h.ctx, effect: (cb) => { const d = cb(); disposers.push(d); return () => { if (typeof d === 'function') d() } } }
  apply(tracking)
  h.restore()
  assert.equal(h.routes.size, 4)
  for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  assert.equal(h.routes.size, 0)
})

/* ------------------------------------------------------------------ *
 * Refresh (reconcile from the durable logs)
 * ------------------------------------------------------------------ */

/**
 * Build one durable usage event in the shape the Host writes to its log.
 * @param {object} options - `{ time, turn, step, usage, model }`.
 * @returns {{type: string, time: number, data: object}} the event.
 */
function logUsage(options) {
  const { time, turn = 1, step = 1, usage = REAL_USAGE, model } = options
  return {
    type: 'assistant/message',
    time,
    data: { turn, step, message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model } }, usage },
  }
}

test('refresh counts calls that settled before the plugin was listening', async () => {
  const h = harness()
  apply(h.ctx)
  h.restore()
  // Nothing live was observed at all — the whole figure must come from the log.
  const when = Date.parse('2026-09-30T10:00:00+08:00')
  h.sessionLogs.set('old-session', {
    session: { id: 'old-session' },
    events: [
      { type: 'request/header', time: when - 1000, data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
      logUsage({ time: when, turn: 1, step: 1 }),
      logUsage({ time: when + 1000, turn: 1, step: 2 }),
    ],
  })
  h.setCorpus(['old-session'])

  const before = (await h.request('/dsh-api-cost/api', 'session=old-session')).body.session
  assert.equal(before.calls, 0, 'nothing is metered before the refresh')

  const { status, body } = await h.request('/dsh-api-cost/api/reconcile', 'session=old-session&scope=self')
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.recovered, 2, 'both logged calls are recovered')
  assert.equal(body.scanned, 1)

  const after = (await h.request('/dsh-api-cost/api', 'session=old-session&scope=self')).body.session
  assert.equal(after.calls, 2, 'the recovered calls are in the ledger')
  // Priced at the instant the provider reported, not at refresh time.
  assert.equal(after.tokens.total, 2 * REAL_USAGE.totalTokens)
  assert.ok(after.recent.every((entry) => entry.model === 'deepseek-flash'), 'the logged model is attributed')
})

test('refresh is idempotent: pressing it twice does not double the figure', async () => {
  const h = harness()
  apply(h.ctx)
  h.restore()
  const when = Date.parse('2026-09-30T20:00:00+08:00')
  h.sessionLogs.set('idem', {
    session: { id: 'idem' },
    events: [logUsage({ time: when, turn: 1, step: 1 }), logUsage({ time: when + 10, turn: 1, step: 2 })],
  })
  h.setCorpus(['idem'])

  await h.request('/dsh-api-cost/api/reconcile', 'session=idem&scope=self')
  const once = (await h.request('/dsh-api-cost/api', 'session=idem&scope=self')).body.session
  await h.request('/dsh-api-cost/api/reconcile', 'session=idem&scope=self')
  const twice = (await h.request('/dsh-api-cost/api', 'session=idem&scope=self')).body.session

  assert.equal(once.calls, 2)
  assert.equal(twice.calls, 2, 'the second refresh recounts, it does not add')
  assert.ok(Math.abs(once.costCny - twice.costCny) < 1e-12, 'the cost is stable across refreshes')
  assert.equal(twice.tokens.total, once.tokens.total)
})

test('refresh does not double-count a call that was already metered live', async () => {
  const h = harness()
  apply(h.ctx)
  const when = Date.parse('2026-09-30T10:00:00+08:00')
  const realNow = Date.now
  Date.now = () => when
  try {
    replayCall(h, { sessionId: 'both-paths' })
  } finally {
    Date.now = realNow
  }
  h.restore()
  // The same call exists in the log, keyed by the same turn/step position.
  h.sessionLogs.set('both-paths', {
    session: { id: 'both-paths' },
    events: [logUsage({ time: when, turn: 1, step: 1 })],
  })
  h.setCorpus(['both-paths'])

  const live = (await h.request('/dsh-api-cost/api', 'session=both-paths&scope=self')).body.session
  assert.equal(live.calls, 1)
  await h.request('/dsh-api-cost/api/reconcile', 'session=both-paths&scope=self')
  const after = (await h.request('/dsh-api-cost/api', 'session=both-paths&scope=self')).body.session
  assert.equal(after.calls, 1, 'the same call is counted once, not twice')
  assert.ok(Math.abs(after.costCny - live.costCny) < 1e-12, 'and it keeps the price the live meter resolved')
  assert.equal(after.recent.length, 1, 'the log replay replaced the entry rather than appending one')
})

test('a log replay keeps a priced call when the log never recorded its model', async () => {
  // The usage is in the log but the request header is not: replacing the live
  // priced entry with an unknown-model zero would silently lose money.
  const h = harness()
  apply(h.ctx)
  const when = Date.parse('2026-09-30T10:00:00+08:00')
  const realNow = Date.now
  Date.now = () => when
  try {
    replayCall(h, { sessionId: 'no-header' })
  } finally {
    Date.now = realNow
  }
  h.restore()
  h.sessionLogs.set('no-header', { session: { id: 'no-header' }, events: [logUsage({ time: when, turn: 1, step: 1 })] })
  h.setCorpus(['no-header'])

  const live = (await h.request('/dsh-api-cost/api', 'session=no-header&scope=self')).body.session
  await h.request('/dsh-api-cost/api/reconcile', 'session=no-header&scope=self')
  const after = (await h.request('/dsh-api-cost/api', 'session=no-header&scope=self')).body.session
  assert.equal(after.calls, 1)
  assert.ok(Math.abs(after.costCny - live.costCny) < 1e-12, 'the priced live entry survives')
  assert.equal(after.recent[0].model, 'deepseek-flash')
})

test('refresh repairs delegation attribution from the corpus headers', async () => {
  const h = harness()
  apply(h.ctx)
  h.restore()
  const when = Date.parse('2026-09-30T20:00:00+08:00')
  h.sessionLogs.set('hist-parent', { session: { id: 'hist-parent' }, events: [logUsage({ time: when })] })
  h.sessionLogs.set('hist-child', { session: { id: 'hist-child', parentSession: 'hist-parent' }, events: [logUsage({ time: when + 5 })] })
  h.setCorpus(['hist-child', 'hist-parent'])

  // No events were ever seen by this process, so nothing links the two and the
  // child has no ledger at all.
  const before = (await h.request('/dsh-api-cost/api', 'session=hist-child&scope=self')).body.session
  assert.equal(before.known, false, 'the child is unknown before the refresh')

  await h.request('/dsh-api-cost/api/reconcile', 'session=hist-parent&scope=tree')
  const after = (await h.request('/dsh-api-cost/api', 'session=hist-parent')).body.session
  assert.equal(after.calls, 2, 'parent plus the historical child')
  assert.equal(after.children[0].sessionId, 'hist-child', 'the historical child is attributed after the refresh')
  assert.ok(Math.abs(after.ownCostCny + after.subagentCostCny - after.costCny) < 1e-12)
})

test('the corpus scope sweeps every session the Host can see', async () => {
  const h = harness()
  apply(h.ctx)
  h.restore()
  const when = Date.parse('2026-09-30T20:00:00+08:00')
  for (const id of ['c1', 'c2', 'c3']) h.sessionLogs.set(id, { session: { id }, events: [logUsage({ time: when })] })
  h.setCorpus(['c1', 'c2', 'c3'])

  const { body } = await h.request('/dsh-api-cost/api/reconcile', 'session=c1&scope=corpus')
  assert.equal(body.ok, true)
  assert.equal(body.scanned, 3)
  assert.equal(body.recovered, 3)
  assert.deepEqual([...h.logReads].sort(), ['c1', 'c2', 'c3'])
})

test('refresh degrades loudly when the logs are not queryable', async () => {
  const h = harness()
  const ctx = { ...h.ctx, get: (service) => (service === 'sessionQuery' ? undefined : h.ctx.get(service)) }
  apply(ctx)
  h.restore()
  const { status, body } = await h.request('/dsh-api-cost/api/reconcile', 'session=x')
  assert.equal(status, 503, 'a composition without logs answers 503, not a silent success')
  assert.equal(body.ok, false)
  assert.match(body.reason, /sessionQuery/)
})

test('an unreadable log is reported, not thrown', async () => {
  const h = harness()
  apply(h.ctx)
  h.restore()
  h.setCorpus(['ghost'])
  const { status, body } = await h.request('/dsh-api-cost/api/reconcile', 'session=ghost&scope=corpus')
  assert.equal(status, 200)
  assert.equal(body.failed, 1, 'the failure is counted')
  assert.match(String(body.lastError), /no log for ghost/)
})

/* ------------------------------------------------------------------ *
 * Agent Team members
 * ------------------------------------------------------------------ */

/**
 * Make a set of sessions look like one live Team to the fake services.
 * @param {object} h - harness.
 * @param {string} leadId - the Team Lead session.
 * @param {string[]} teammateIds - the member sessions.
 */
function joinTeam(h, leadId, teammateIds) {
  const rows = [
    { id: leadId, name: 'lead', role: 'lead', status: 'running' },
    ...teammateIds.map((id) => ({ id, name: id, role: 'teammate', status: 'inactive' })),
  ]
  for (const row of rows) {
    h.agentsById.set(row.id, { id: row.id })
    h.teams.set(row.id, { membership: { root: { id: leadId }, id: 'team-1', role: row.role, name: row.name }, members: rows })
  }
}

test('a Team member reports the whole Team by default, from any seat', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'team-lead' })
  replayCall(h, { sessionId: 'team-mate-a' })
  replayCall(h, { sessionId: 'team-mate-a' })
  replayCall(h, { sessionId: 'team-mate-b' })
  joinTeam(h, 'team-lead', ['team-mate-a', 'team-mate-b'])
  h.restore()

  for (const seat of ['team-lead', 'team-mate-a', 'team-mate-b']) {
    const { body } = await h.request('/dsh-api-cost/api', `session=${seat}`)
    assert.equal(body.scope, 'team', `${seat} reports the Team`)
    assert.equal(body.teamRootId, 'team-lead')
    assert.equal(body.session.calls, 4, `${seat} sees every member's calls`)
    assert.equal(body.session.members.length, 3)
    assert.equal(body.session.members.find((m) => m.sessionId === 'team-lead').role, 'lead')
    assert.equal(body.session.members.filter((m) => m.role === 'teammate').length, 2)
    assert.ok(body.session.membersWithSpend.length >= 2, 'per-member spend is listed')
  }
})

test('the Team figure keeps the requesting session share for the panel', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'team-lead' })
  replayCall(h, { sessionId: 'team-mate-a' })
  replayCall(h, { sessionId: 'team-mate-a' })
  joinTeam(h, 'team-lead', ['team-mate-a'])
  h.restore()

  const mate = (await h.request('/dsh-api-cost/api', 'session=team-mate-a')).body.session
  assert.equal(mate.calls, 3, 'the Team total')
  assert.equal(mate.teamSpendCny > 0, true, 'the requesting session share rides along')
  assert.ok(Math.abs(mate.teamSpendCny - mate.ownCostCny) < 1e-12 || mate.teamSpendCny <= mate.costCny, 'the share cannot exceed the total')
  assert.ok(mate.teamSpendSubagentCny >= 0)
})

test('scope=self and scope=tree stay available to a Team member', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'team-lead' })
  replayCall(h, { sessionId: 'team-mate-a' })
  replayCall(h, { sessionId: 'team-mate-a' })
  joinTeam(h, 'team-lead', ['team-mate-a'])
  h.restore()

  const self = (await h.request('/dsh-api-cost/api', 'session=team-mate-a&scope=self')).body
  assert.equal(self.scope, 'self')
  assert.equal(self.session.calls, 2, 'scope=self is the session alone')

  const tree = (await h.request('/dsh-api-cost/api', 'session=team-mate-a&scope=tree')).body
  assert.equal(tree.scope, 'tree')
  assert.equal(tree.session.calls, 2, 'a teammate has no children of its own in this fixture')

  const named = (await h.request('/dsh-api-cost/api', 'session=team-mate-a&scope=team')).body
  assert.equal(named.scope, 'team')
  assert.equal(named.session.calls, 3)
})

test('a session outside any Team still reports its own subtree', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'lonely-parent' })
  announceChild(h, 'lonely-child', 'lonely-parent')
  replayCall(h, { sessionId: 'lonely-child' })
  joinTeam(h, 'team-lead', ['team-mate-a'])
  h.restore()
  const { body } = await h.request('/dsh-api-cost/api', 'session=lonely-parent')
  assert.equal(body.scope, 'tree', 'no Team membership means no Team scope')
  assert.equal(body.session.calls, 2)
})

test('the tool and command also report the Team', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'team-lead' })
  replayCall(h, { sessionId: 'team-mate-a' })
  joinTeam(h, 'team-lead', ['team-mate-a'])
  h.restore()

  // A live Agent carries both `id` and `session`; the fixtures match that.
  const invocation = { rawInput: '', agent: { id: 'team-mate-a', session: { sessionId: 'team-mate-a' } } }
  const result = h.registered.commands[0].handler(invocation)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /Team/)

  const value = await h.registered.tools[0].execute({}, { agent: { id: 'team-mate-a', session: { sessionId: 'team-mate-a' } } })
  assert.equal(value.scope, 'team')
  assert.equal(value.calls, 2, 'the tool reports the Team too')
})

/* ------------------------------------------------------------------ *
 * Delegated sessions (subagents / agent team)
 * ------------------------------------------------------------------ */

/**
 * Announce a delegated session the way the Host does: the child's own header
 * names its parent.
 * @param {object} h - harness.
 * @param {string} childId - the delegated session.
 * @param {string} parentId - the conversation that delegated it.
 */
function announceChild(h, childId, parentId) {
  h.emit('session/created', {
    id: childId,
    header: { id: childId, parentSession: parentId, isSeeded: false, origin: 'subagent', delegationDepth: 1 },
  })
}

test('a subagent session is rolled into the conversation that delegated it', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'session-parent' })
  announceChild(h, 'session-child', 'session-parent')
  replayCall(h, { sessionId: 'session-child' })
  replayCall(h, { sessionId: 'session-child' })
  h.restore()

  const parent = (await h.request('/dsh-api-cost/api', 'session=session-parent')).body.session
  assert.equal(parent.calls, 3, 'the parent figure covers its own call and the child 2')
  assert.equal(parent.sessions, 2)
  assert.equal(parent.subagents, 1)
  assert.equal(parent.children.length, 1)
  assert.equal(parent.children[0].sessionId, 'session-child')
  assert.equal(parent.children[0].parentId, 'session-parent')
  assert.equal(parent.children[0].direct, true)
  // The split must add up, or the total is unexplainable in the UI.
  assert.ok(Math.abs(parent.ownCostCny + parent.subagentCostCny - parent.costCny) < 1e-12, 'own + subsessions === total')
  assert.ok(parent.subagentCostCny > parent.ownCostCny, 'in this fixture the child spent the bulk')
  assert.equal(parent.tokens.total, 3 * REAL_USAGE.totalTokens)
  assert.deepEqual(parent.tokens, {
    cacheHit: 3 * REAL_USAGE.cacheReadTokens,
    cacheMiss: 3 * REAL_USAGE.inputTokens,
    output: 3 * REAL_USAGE.outputTokens,
    reasoning: 0,
    total: 3 * REAL_USAGE.totalTokens,
  })
})

test('a nested delegation is counted too, and marked as indirect', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'session-root' })
  announceChild(h, 'session-mid', 'session-root')
  replayCall(h, { sessionId: 'session-mid' })
  announceChild(h, 'session-leaf', 'session-mid')
  replayCall(h, { sessionId: 'session-leaf' })
  h.restore()

  const root = (await h.request('/dsh-api-cost/api', 'session=session-root')).body.session
  assert.equal(root.calls, 3, 'the grandchild is part of the total')
  assert.equal(root.sessions, 3)
  assert.equal(root.subagents, 2)
  assert.equal(root.children.length, 2)
  const mid = root.children.find((child) => child.sessionId === 'session-mid')
  const leaf = root.children.find((child) => child.sessionId === 'session-leaf')
  assert.equal(mid.direct, true, 'the middle session is a direct child')
  assert.equal(leaf.direct, false, 'the grandchild is nested, not direct')
  assert.equal(leaf.parentId, 'session-mid')
})

test('the middle session reports only its own subtree', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'session-root' })
  announceChild(h, 'session-mid', 'session-root')
  announceChild(h, 'session-leaf', 'session-mid')
  replayCall(h, { sessionId: 'session-mid' })
  replayCall(h, { sessionId: 'session-leaf' })
  h.restore()

  const mid = (await h.request('/dsh-api-cost/api', 'session=session-mid')).body.session
  assert.equal(mid.calls, 2, 'mid plus leaf, not root')
  assert.equal(mid.subagents, 1)
  assert.equal(mid.children.length, 1)
  assert.equal(mid.children[0].sessionId, 'session-leaf')
})

test('tree=0 reports the session alone', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'session-parent' })
  announceChild(h, 'session-child', 'session-parent')
  replayCall(h, { sessionId: 'session-child' })
  h.restore()

  const alone = (await h.request('/dsh-api-cost/api', 'session=session-parent&tree=0')).body.session
  assert.equal(alone.calls, 1, 'tree=0 keeps the old single-session behaviour')
  assert.equal(alone.subagents, 0)
  assert.equal(alone.subagentCostCny, 0)
})

test('a child is attributed from subagent/start when it never announces a header', async () => {
  // The Host hands the delegating session to this listener as the event's `this`
  // (the Cordis dispatch convention), which is how the edge survives a child
  // that never announces its own header.
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'session-host' })
  h.emitOn('subagent/start', { agents: { currentInitiator: () => ({ id: 'session-host' }) } }, { runId: 'run-1', provider: 'spawn', id: 'session-orphan', local: true })
  replayCall(h, { sessionId: 'session-orphan' })
  h.restore()
  const host = (await h.request('/dsh-api-cost/api', 'session=session-host')).body.session
  assert.equal(host.calls, 2)
  assert.equal(host.children[0].sessionId, 'session-orphan')
})

test('a child whose parent arrives as the event payload argument is attributed too', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'session-host2' })
  h.emit('subagent/start', { runId: 'run-2', provider: 'spawn', id: 'session-child2', local: true }, { header: { id: 'session-host2' } })
  replayCall(h, { sessionId: 'session-child2' })
  h.restore()
  const host = (await h.request('/dsh-api-cost/api', 'session=session-host2')).body.session
  assert.equal(host.calls, 2)
  assert.equal(host.children[0].sessionId, 'session-child2')
})

test('the split is honest before any child settles, and a bogus edge cannot loop', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'session-solo' })
  announceChild(h, 'session-loop', 'session-loop')
  h.restore()
  const solo = (await h.request('/dsh-api-cost/api', 'session=session-solo')).body.session
  assert.equal(solo.subagents, 0, 'no child means no split rows')
  assert.equal(solo.subagentCostCny, 0)
  assert.equal(solo.ownCostCny, solo.costCny)
  await assert.doesNotReject(() => h.request('/dsh-api-cost/api', 'session=session-loop'))
})

test('a tunnel of sessions reports one aggregate without dropping a level', async () => {
  const h = harness()
  apply(h.ctx)
  let parent = 'session-d0'
  replayCall(h, { sessionId: parent })
  for (let depth = 1; depth <= 12; depth += 1) {
    const child = `session-d${String(depth)}`
    announceChild(h, child, parent)
    replayCall(h, { sessionId: child })
    parent = child
  }
  h.restore()
  const root = (await h.request('/dsh-api-cost/api', 'session=session-d0')).body.session
  assert.equal(root.calls, 13, 'every level is counted')
  assert.equal(root.sessions, 13)
  assert.equal(root.children.length, 12)
})

test('the subagent service is the authoritative tree source, with no events at all', async () => {
  // The delegation events are dispatched inside the delegating agent's scope, so
  // a plugin-level listener cannot be trusted to see them. This is the path that
  // actually has to work: ask the service.
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'svc-parent' })
  replayCall(h, { sessionId: 'svc-child' })
  h.descendants.set('svc-parent', [
    { id: 'svc-child', parentId: 'svc-parent', depth: 1, activity: 'inactive', kind: 'child', mode: 'one-shot', hasChildren: false },
  ])
  h.restore()

  const parent = (await h.request('/dsh-api-cost/api', 'session=svc-parent')).body.session
  assert.deepEqual(h.descendantCalls, ['svc-parent'], 'the service is asked about the reported session')
  assert.equal(parent.calls, 2, 'the child is billed into the parent without any event')
  assert.equal(parent.subagents, 1)
  assert.equal(parent.children[0].sessionId, 'svc-child')
  assert.equal(parent.children[0].direct, true)
  assert.ok(Math.abs(parent.ownCostCny + parent.subagentCostCny - parent.costCny) < 1e-12)
})

test('a resolved tree is cached briefly so polling does not re-query the service', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'svc-cache' })
  h.descendants.set('svc-cache', [])
  h.restore()
  const first = (await h.request('/dsh-api-cost/api', 'session=svc-cache')).body.session
  assert.equal(first.calls, 1)
  await h.request('/dsh-api-cost/api', 'session=svc-cache')
  await h.request('/dsh-api-cost/api', 'session=svc-cache')
  assert.equal(h.descendantCalls.length, 1, 'the second and third polls reuse the cached tree')
})

test('the tree resolver degrades to the recorded edges when the service is absent', async () => {
  const h = harness()
  const bare = { ...h.ctx, get: (service) => (service === 'subagents' ? undefined : h.ctx.get(service)) }
  apply(bare)
  replayCall(h, { sessionId: 'no-svc-parent' })
  announceChild(h, 'no-svc-child', 'no-svc-parent')
  replayCall(h, { sessionId: 'no-svc-child' })
  h.restore()
  const parent = (await h.request('/dsh-api-cost/api', 'session=no-svc-parent')).body.session
  assert.equal(parent.calls, 2, 'the event-recorded edge still attributes the child')
  assert.equal(parent.subagents, 1)
})

test('a failing tree read answers from the recorded edges instead of erroring', async () => {
  const failing = {
    listDescendants: async () => { throw new Error('subagent service unavailable') },
  }
  const h = harness()
  const ctx = { ...h.ctx, get: (service) => (service === 'subagents' ? failing : h.ctx.get(service)) }
  apply(ctx)
  replayCall(h, { sessionId: 'fail-parent' })
  announceChild(h, 'fail-child', 'fail-parent')
  replayCall(h, { sessionId: 'fail-child' })
  h.restore()
  const { status, body } = await h.request('/dsh-api-cost/api', 'session=fail-parent')
  assert.equal(status, 200, 'a service failure must not fail the request')
  assert.equal(body.session.calls, 2)
  assert.equal(body.session.children[0].sessionId, 'fail-child')
})

test('the /cost command and the tool report the whole tree', async () => {
  const h = harness()
  apply(h.ctx)
  replayCall(h, { sessionId: 'session-cmd-parent' })
  announceChild(h, 'session-cmd-child', 'session-cmd-parent')
  replayCall(h, { sessionId: 'session-cmd-child' })
  h.restore()

  const result = h.registered.commands[0].handler({ rawInput: '', agent: { id: 'session-cmd-parent' } })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /subsession/)

  const value = await h.registered.tools[0].execute({}, { agent: { id: 'session-cmd-parent' } })
  assert.equal(value.calls, 2)
  assert.equal(value.subagents, 1)
  assert.ok(value.subagentCostCny > 0)
  assert.match(value.text, /subsession/)
})
