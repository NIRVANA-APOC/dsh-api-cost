/**
 * Client bridge behaviour: validation, single-flight, generation safety and
 * resource release. These are Node-level tests over the same modules the
 * browser bundle ships — no DOM, no React, no live Harness connection.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CostTransport, validCostView, validGateView, validLedger, validPricingView } from '../src/client/transport.ts'
import type { HttpResponse } from '../src/client/transport.ts'
import { CostStore, PricingStore } from '../src/client/store.ts'
import { GateStore } from '../src/client/gate.ts'
import { cardNotes } from '../src/client/cardNotes.ts'
import type { Scheduler, Visibility } from '../src/client/store.ts'

/* ------------------------------------------------------------------ *
 * Doubles
 * ------------------------------------------------------------------ */

interface Pending { readonly url: string; readonly init: RequestInit; readonly signal: AbortSignal | undefined; readonly rawResolve: (response: HttpResponse) => void; readonly rawReject: (error: unknown) => void }
class FakeFetch {
  readonly calls: Pending[] = []
  respond(body: unknown, index = 0): void {
    const call = this.calls[index]
    assert.ok(call, `no request at index ${index}`)
    call.rawResolve({ ok: true, status: 200, json: async () => body })
  }
  fail(error: unknown, index = 0): void {
    const call = this.calls[index]
    assert.ok(call, `no request at index ${index}`)
    call.rawReject(error)
  }
  readonly fetcher = (url: string, options: RequestInit): Promise<HttpResponse> => new Promise((resolve, reject) => {
    this.calls.push({ url, init: options, signal: options.signal ?? undefined, rawResolve: resolve, rawReject: reject })
  })
}
class FakeClock implements Scheduler {
  now(): number { return this.time }
  time = 1000
  private readonly tasks: { at: number; callback: () => void }[] = []
  later(callback: () => void, milliseconds: number): () => void {
    const task = { at: this.time + milliseconds, callback }
    this.tasks.push(task)
    return () => { const index = this.tasks.indexOf(task); if (index >= 0) this.tasks.splice(index, 1) }
  }
  get pending(): number { return this.tasks.length }
  advance(milliseconds: number): void {
    this.time += milliseconds
    for (const task of [...this.tasks].sort((a, b) => a.at - b.at)) {
      if (task.at > this.time) continue
      const index = this.tasks.indexOf(task)
      if (index >= 0) this.tasks.splice(index, 1)
      task.callback()
    }
  }
}
class FakeVisibility implements Visibility {
  visible(): boolean { return this.shown }
  shown = true
  private readonly listeners = new Set<() => void>()
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  set(shown: boolean): void { this.shown = shown; for (const listener of [...this.listeners]) listener() }
}
/** Drain the promise chain a refresh walks: fetch → json → publish → finally. */
const settle = async (): Promise<void> => { for (let i = 0; i < 25; i += 1) await Promise.resolve() }

const totals = (cny: string, usd = '0'): unknown => ({
  calls: 1, attempts: 1, unpricedCalls: 0, money: { cny, usd },
  tokens: { cacheHit: '0', cacheMiss: '1000', output: '10', reasoning: '0', total: '1010' },
  periods: { peak: { cny, usd }, offPeak: { cny: '0', usd: '0' } },
})
const coverage = { status: 'complete', issues: [], failedSessions: 0, omittedSessions: 0 }
function view(cny: string, scope: 'self' | 'tree' | 'team' = 'tree', extra: Record<string, unknown> = {}): unknown {
  return { schemaVersion: 2, sessionId: 'session-a', rootSessionId: 'session-a', scope, revision: 'rev-' + cny, total: totals(cny), own: totals(cny), others: totals('0'), coverage, sessionCount: 1, ...extra }
}
const pricingBody = (validUntil: number): unknown => ({
  schemaVersion: 2, revision: 'p1', now: 1000, validUntil, peak: true, reason: 'window', next: { at: validUntil, peak: false },
  issues: [], source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/', effectiveFrom: '2026-09-10T12:00:00+08:00',
  rateCard: {
    'deepseek-flash': { label: 'DeepSeek Flash', peak: { cny: { cacheHit: '0.04', cacheMiss: '2', output: '8' }, usd: { cacheHit: '0.006', cacheMiss: '0.3', output: '1.2' } }, offPeak: { cny: { cacheHit: '0.02', cacheMiss: '1', output: '4' }, usd: { cacheHit: '0.003', cacheMiss: '0.15', output: '0.6' } } },
    'deepseek-v4-pro': { label: 'DeepSeek V4 Pro', peak: { cny: { cacheHit: '0.3', cacheMiss: '9', output: '27' }, usd: { cacheHit: '0.044', cacheMiss: '1.32', output: '3.96' } }, offPeak: { cny: { cacheHit: '0.15', cacheMiss: '4.5', output: '13.5' }, usd: { cacheHit: '0.022', cacheMiss: '0.66', output: '1.98' } } },
  },
})
function harness(): { store: CostStore; clock: FakeClock; page: FakeVisibility; fetch: FakeFetch } {
  const fetch = new FakeFetch(), clock = new FakeClock(), page = new FakeVisibility()
  const store = new CostStore(new CostTransport(fetch.fetcher), clock, page)
  return { store, clock, page, fetch }
}

/* ------------------------------------------------------------------ *
 * DTO validation
 * ------------------------------------------------------------------ */

test('a well-formed view passes and a malformed one is refused', () => {
  assert.equal(validCostView(view('1.25')), true)
  assert.equal(validCostView(view('1.25', 'tree', { byModel: [{ model: 'deepseek-flash', totals: totals('1.25') }], recent: [], members: [{ sessionId: 's', name: 'Lead', role: 'lead', money: { cny: '1', usd: '0' }, ownMoney: { cny: '1', usd: '0' } }] })), true)
  const cases: [string, unknown][] = [
    ['schema version', { ...(view('1') as object), schemaVersion: 1 }],
    ['negative money', { ...(view('1') as object), total: totals('-1') }],
    ['float money', { ...(view('1') as object), total: totals('1.5e3') }],
    ['unknown issue', { ...(view('1') as object), coverage: { ...coverage, issues: ['bogus'] } }],
    ['bad scope', { ...(view('1') as object), scope: 'corpus' }],
    ['missing totals', { ...(view('1') as object), total: undefined }],
    ['bad member role', { ...(view('1') as object), members: [{ sessionId: 's', name: 'x', role: 'root', money: { cny: '1', usd: '0' }, ownMoney: { cny: '1', usd: '0' } }] }],
  ]
  for (const [label, body] of cases) assert.equal(validCostView(body), false, label)
})

test('ledger and pricing payloads are validated structurally', () => {
  assert.equal(validLedger({ revision: 'r', totals: totals('0.1'), byModel: [], recent: [], coverage }), true)
  assert.equal(validLedger({ revision: 'r', totals: totals('0.1'), byModel: [], recent: [{ seq: 1, at: 1, model: 'deepseek-flash', kind: 'message', money: { cny: '0', usd: '0' }, tokens: { cacheHit: '0', cacheMiss: '0', output: '0', reasoning: '0', total: '0' }, peak: true, issues: [] }], coverage }), true)
  assert.equal(validLedger({ revision: 'r' }), false)
  assert.equal(validPricingView(pricingBody(60000)), true)
  assert.equal(validPricingView({ ...(pricingBody(60000) as object), validUntil: 500 }), false, 'an expired window is refused')
  assert.equal(validPricingView({ ...(pricingBody(60000) as object), rateCard: { 'deepseek-flash': {} } }), false)
})

/* ------------------------------------------------------------------ *
 * Single-flight, generations and release
 * ------------------------------------------------------------------ */

test('one subscriber performs one request and publishes the validated view', async () => {
  const { store, fetch } = harness()
  let notified = 0
  const unsubscribe = store.subscribe('session-a', () => { notified += 1 })
  await settle()
  assert.equal(fetch.calls.length, 1)
  assert.match(fetch.calls[0]!.url, /^\/dsh-api-cost\/v2\/view\?session=session-a&scope=auto&detail=summary$/)
  assert.equal(store.snapshot('session-a').loading, true)
  fetch.respond(view('1.25'))
  await settle()
  assert.equal(store.snapshot('session-a').view?.total.money.cny, '1.25')
  assert.equal(store.snapshot('session-a').loading, false)
  assert.ok(notified >= 2, 'subscribers are notified on settle')
  unsubscribe()
})

test('a second seat shares the in-flight request instead of starting another', async () => {
  const { store, fetch } = harness()
  const first = store.subscribe('session-a', () => {})
  const second = store.subscribe('session-a', () => {})
  await settle()
  assert.equal(fetch.calls.length, 1)
  fetch.respond(view('0.5'))
  await settle()
  assert.equal(store.snapshot('session-a').view?.total.money.cny, '0.5')
  first(); second()
})

test('a superseded response never lands: the newer generation wins', async () => {
  const { store, fetch } = harness()
  const unsubscribe = store.subscribe('session-a', () => {})
  await settle()
  const forced = store.refresh('session-a', true)
  await settle()
  assert.equal(fetch.calls.length, 2, 'a forced refresh replaces the in-flight request')
  assert.equal(fetch.calls[0]!.signal?.aborted, true, 'the replaced request is aborted')
  fetch.respond(view('9.99'), 0)
  await settle()
  assert.equal(store.snapshot('session-a').view, null, 'the stale generation cannot publish')
  fetch.respond(view('0.01'), 1)
  await forced
  await settle()
  assert.equal(store.snapshot('session-a').view?.total.money.cny, '0.01')
  unsubscribe()
})

test('an abandoned subscriber releases listeners, timers and in-flight work', async () => {
  const { store, fetch, clock } = harness()
  const unsubscribe = store.subscribe('session-a', () => {})
  await settle()
  unsubscribe()
  assert.equal(fetch.calls[0]!.signal?.aborted, true)
  assert.equal(clock.pending, 0, 'no poll timer survives the last seat')
  assert.equal(store.snapshot('session-a').view, null)
})

test('a hidden page pauses work and a visible page resumes immediately', async () => {
  const { store, fetch, page, clock } = harness()
  const unsubscribe = store.subscribe('session-a', () => {})
  await settle()
  fetch.respond(view('1', 'tree'))
  await settle()
  assert.equal(clock.pending, 1, 'a cross-session scope keeps a slow validity poll')
  page.set(false)
  await settle()
  assert.equal(clock.pending, 0, 'hiding the page cancels the poll')
  const before = fetch.calls.length
  clock.advance(60000)
  await settle()
  assert.equal(fetch.calls.length, before, 'no request runs while hidden')
  page.set(true)
  await settle()
  assert.equal(fetch.calls.length, before + 1, 'becoming visible refreshes at once')
  unsubscribe()
})

test('an own-session scope with a live projection stops polling entirely', async () => {
  const { store, fetch, clock } = harness()
  const unsubscribe = store.subscribe('session-a', () => {})
  store.observe('session-a', { running: false, projectionReady: true, projectionRevision: 'r1', catalogRevision: 'c1', catalogProjectionRevision: 'p1' })
  await settle()
  fetch.respond(view('2', 'self'))
  await settle()
  assert.equal(clock.pending, 0, 'native projection totals need no timer')
  clock.advance(600000)
  await settle()
  assert.equal(fetch.calls.length, 1)
  unsubscribe()
})

test('a changed projection or catalog revision invalidates the cached view once', async () => {
  const { store, fetch } = harness()
  const unsubscribe = store.subscribe('session-a', () => {})
  await settle()
  fetch.respond(view('1', 'tree'))
  await settle()
  assert.equal(fetch.calls.length, 1)
  store.observe('session-a', { running: false, projectionReady: true, projectionRevision: 'r1', catalogRevision: 'c1', catalogProjectionRevision: 'p1' })
  await settle()
  assert.equal(fetch.calls.length, 1, 'the first observation only records a baseline')
  store.observe('session-a', { running: false, projectionReady: true, projectionRevision: 'r1', catalogRevision: 'c2', catalogProjectionRevision: 'p1' })
  await settle()
  await settle()
  assert.equal(fetch.calls.length, 2, 'a catalog change invalidates the cross-session total')
  unsubscribe()
})

test('opening the panel requests full detail and closing it aborts that flight', async () => {
  const { store, fetch } = harness()
  const unsubscribe = store.subscribe('session-a', () => {})
  await settle()
  fetch.respond(view('1', 'tree'))
  await settle()
  const close = store.open('session-a')
  await settle()
  assert.equal(fetch.calls.length, 2)
  assert.match(fetch.calls[1]!.url, /detail=full$/)
  close()
  await settle()
  assert.equal(fetch.calls[1]!.signal?.aborted, true, 'a closed panel stops its own request')
  unsubscribe()
})

test('a request that outlives its timeout surfaces an error instead of hanging', async () => {
  const { store, fetch, clock } = harness()
  const unsubscribe = store.subscribe('session-a', () => {})
  await settle()
  clock.advance(8000)
  await settle()
  assert.equal(store.snapshot('session-a').error, 'Request timed out')
  assert.equal(fetch.calls[0]!.signal?.aborted, true)
  unsubscribe()
})

test('disposal aborts everything and refuses further work', async () => {
  const { store, fetch } = harness()
  store.subscribe('session-a', () => {})
  await settle()
  store.dispose()
  assert.equal(fetch.calls[0]!.signal?.aborted, true)
  await assert.doesNotReject(() => store.refresh('session-a'))
  assert.equal(store.subscribe('session-a', () => {})(), undefined)
})

/* ------------------------------------------------------------------ *
 * Rate-card notes
 * ------------------------------------------------------------------ */

test('a disputed-model note is shown only where that model is priced', () => {
  const issues = ['routing-disputed'] as const
  assert.deepEqual(cardNotes(issues, undefined), [], 'an unknown scope must not inherit a note about Pro')
  assert.deepEqual(cardNotes(issues, ['deepseek-flash', 'unknown']), [], 'a session without Pro is not a Pro problem')
  assert.deepEqual(cardNotes(issues, ['deepseek-flash', 'deepseek-v4-pro']), ['routing-disputed'])
})

test('calendar and card-epoch caveats survive regardless of the scope models', () => {
  const issues = ['holiday-data-missing', 'before-rate-card', 'routing-disputed'] as const
  assert.deepEqual(cardNotes(issues, []), ['holiday-data-missing', 'before-rate-card'], 'they shape the rates on display')
  assert.deepEqual(cardNotes(issues, ['deepseek-v4-pro']), ['holiday-data-missing', 'before-rate-card', 'routing-disputed'])
  assert.deepEqual(cardNotes([], undefined), [])
})

/* ------------------------------------------------------------------ *
 * Pricing refresh boundary
 * ------------------------------------------------------------------ */

test('pricing is fetched once, then re-armed exactly at its validity boundary', async () => {
  const fetch = new FakeFetch(), clock = new FakeClock(), page = new FakeVisibility()
  const store = new PricingStore(new CostTransport(fetch.fetcher), clock, page)
  const unsubscribe = store.subscribe(() => {})
  await settle()
  assert.equal(fetch.calls.length, 1)
  fetch.respond(pricingBody(clock.now() + 60000))
  await settle()
  assert.equal(store.snapshot().pricing?.peak, true)
  clock.advance(59999)
  await settle()
  assert.equal(fetch.calls.length, 1, 'no recurring ticker: nothing is fetched before the boundary')
  clock.advance(1)
  await settle()
  assert.equal(fetch.calls.length, 2)
  unsubscribe()
  assert.equal(clock.pending, 0)
})

test('an invalid pricing payload is rejected rather than displayed', async () => {
  const fetch = new FakeFetch(), clock = new FakeClock(), page = new FakeVisibility()
  const store = new PricingStore(new CostTransport(fetch.fetcher), clock, page)
  const unsubscribe = store.subscribe(() => {})
  await settle()
  fetch.respond({ schemaVersion: 2, revision: 'p1' })
  await settle()
  assert.equal(store.snapshot().pricing, null)
  assert.equal(store.snapshot().error, 'Malformed pricing view')
  unsubscribe()
})

/* ------------------------------------------------------------------ *
 * Off-peak gate: per-session wire and store
 * ------------------------------------------------------------------ */

/** A v4 GateView fixture: one session's answer, which the store must never mix up. */
const gateBody = (sessionId = 'session-a', extra: Record<string, unknown> = {}): unknown => ({
  schemaVersion: 4, sessionId, enabled: false, source: 'default', inheritedFrom: null, state: 'off',
  peak: true, reason: 'peak-window', releaseAt: null, holding: 0, ownHolding: 0, since: null,
  heldTotal: 0, delayedMs: 0, changedAt: null, durable: false, revision: 'rev-' + sessionId,
  next: null, now: 1000, otherHolding: 0, ...extra,
})
function gateHarness(): { store: GateStore; clock: FakeClock; page: FakeVisibility; fetch: FakeFetch } {
  const fetch = new FakeFetch(), clock = new FakeClock(), page = new FakeVisibility()
  const store = new GateStore(new CostTransport(fetch.fetcher), clock, page)
  return { store, clock, page, fetch }
}

test('a well-formed v4 per-session gate view passes and malformed ones are refused', () => {
  assert.equal(validGateView(gateBody()), true)
  assert.equal(validGateView(gateBody('session-b', {
    enabled: true, source: 'self', state: 'holding', holding: 2, ownHolding: 1, since: 900,
    releaseAt: 9000, changedAt: 800, durable: true, otherHolding: 3,
  })), true, 'a parked session with a durable switch and peer waiters is well formed')
  assert.equal(validGateView(gateBody('session-a', {
    enabled: true, source: 'inherited', inheritedFrom: 'session-root', state: 'open',
  })), true, 'an inherited position names the ancestor it follows')
  assert.equal(validGateView(gateBody('session-a', { holding: 2, ownHolding: 2 })), true, 'ownHolding may equal holding')
  assert.equal(validGateView(gateBody('session-a', { enabled: true, source: 'self', changedAt: 0 })), true, 'epoch 0 is a legal, if unlikely, change instant')
  const base = gateBody() as Record<string, unknown>
  const cases: [string, unknown][] = [
    ['schema version 3', { ...base, schemaVersion: 3 }],
    ['absent schema version', { ...base, schemaVersion: undefined }],
    ['empty session id', { ...base, sessionId: '' }],
    ['non-string session id', { ...base, sessionId: 42 }],
    ['bogus source', { ...base, source: 'bogus' }],
    ['absent source', { ...base, source: undefined }],
    ['inherited with a null ancestor', { ...base, source: 'inherited', inheritedFrom: null }],
    ['inherited with an absent ancestor', { ...base, source: 'inherited', inheritedFrom: undefined }],
    ['inherited with an empty ancestor', { ...base, source: 'inherited', inheritedFrom: '' }],
    ['self with an inherited ancestor', { ...base, source: 'self', inheritedFrom: 'session-root' }],
    ['default with an inherited ancestor', { ...base, source: 'default', inheritedFrom: 'session-root' }],
    ['absent changedAt', { ...base, changedAt: undefined }],
    ['negative changedAt', { ...base, changedAt: -1 }],
    ['non-finite changedAt', { ...base, changedAt: Number.POSITIVE_INFINITY }],
    ['non-number changedAt', { ...base, changedAt: '800' }],
    ['negative otherHolding', { ...base, otherHolding: -1 }],
    ['fractional otherHolding', { ...base, otherHolding: 1.5 }],
    ['negative holding', { ...base, holding: -1 }],
    ['absent ownHolding', { ...base, ownHolding: undefined }],
    ['negative ownHolding', { ...base, ownHolding: -1 }],
    ['fractional ownHolding', { ...base, ownHolding: 1.5 }],
    ['ownHolding above holding', { ...base, holding: 1, ownHolding: 2 }],
    ['bad state', { ...base, state: 'paused' }],
    ['bad releaseAt', { ...base, releaseAt: 'soon' }],
    ['bad next', { ...base, next: { at: 'soon', peak: false } }],
  ]
  for (const [label, body] of cases) assert.equal(validGateView(body), false, label)
})

test('gate() names the session in the query and refuses another session\'s answer', async () => {
  const fetch = new FakeFetch()
  const transport = new CostTransport(fetch.fetcher)
  const signal = new AbortController().signal
  const valid = transport.gate('session a/b', signal)
  await settle()
  assert.equal(fetch.calls.length, 1)
  assert.equal(fetch.calls[0]!.url, '/dsh-api-cost/v2/gate?session=session%20a%2Fb')
  assert.equal(fetch.calls[0]!.init.method, 'GET')
  fetch.respond(gateBody('session a/b'))
  assert.equal((await valid).sessionId, 'session a/b')
  const wrong = transport.gate('session-a', signal)
  await settle()
  fetch.respond(gateBody('session-b'), 1)
  await assert.rejects(wrong, /Malformed gate view/)
  const invalid = transport.gate('session-a', signal)
  await settle()
  fetch.respond({ schemaVersion: 3, revision: 'g1' }, 2)
  await assert.rejects(invalid, /Malformed gate view/)
})

test('setGate() posts only the named session and refuses another session\'s answer', async () => {
  const fetch = new FakeFetch()
  const transport = new CostTransport(fetch.fetcher)
  const signal = new AbortController().signal
  const write = transport.setGate('session-a', true, signal)
  await settle()
  assert.equal(fetch.calls[0]!.url, '/dsh-api-cost/v2/gate')
  assert.equal(fetch.calls[0]!.init.method, 'POST')
  assert.deepEqual(JSON.parse(String(fetch.calls[0]!.init.body)), { session: 'session-a', enabled: true })
  assert.match((fetch.calls[0]!.init.headers as Record<string, string>)['content-type'] ?? '', /^application\/json/)
  fetch.respond(gateBody('session-a', { enabled: true, source: 'self', changedAt: 800 }))
  const view = await write
  assert.equal(view.sessionId, 'session-a')
  assert.equal(view.enabled, true)
  const wrong = transport.setGate('session-a', true, signal)
  await settle()
  fetch.respond(gateBody('session-b', { enabled: true }), 1)
  await assert.rejects(wrong, /Malformed gate view/)
})

test('a first subscriber reads that session and publishes the confirmed view', async () => {
  const { store, fetch } = gateHarness()
  let notified = 0
  const unsubscribe = store.subscribe('session-a', () => { notified += 1 })
  await settle()
  assert.equal(fetch.calls.length, 1)
  assert.equal(fetch.calls[0]!.url, '/dsh-api-cost/v2/gate?session=session-a')
  assert.equal(store.snapshot('session-a').loading, true)
  assert.equal(store.snapshot('session-a'), store.snapshot('session-a'), 'the snapshot identity is stable between publishes')
  assert.equal(store.snapshot('session-b').gate, null, 'a session nobody subscribed to is neither fetched nor invented')
  assert.equal(fetch.calls.length, 1)
  fetch.respond(gateBody('session-a'))
  await settle()
  const state = store.snapshot('session-a')
  assert.equal(state.gate?.sessionId, 'session-a')
  assert.equal(state.gate?.changedAt, null, 'a session inheriting the default reports no change instant')
  assert.equal(state.loading, false)
  assert.equal(state.error, null)
  assert.ok(notified >= 2, 'loading and settle both notify')
  unsubscribe()
})

test('a second seat shares the read while another session gets its own request', async () => {
  const { store, fetch } = gateHarness()
  const first = store.subscribe('session-a', () => {})
  const second = store.subscribe('session-a', () => {})
  await settle()
  assert.equal(fetch.calls.length, 1, 'two seats for one session share one read')
  const other = store.subscribe('session-b', () => {})
  await settle()
  assert.equal(fetch.calls.length, 2, 'a different session is a different entry')
  assert.equal(fetch.calls[1]!.url, '/dsh-api-cost/v2/gate?session=session-b')
  fetch.respond(gateBody('session-a'), 0)
  fetch.respond(gateBody('session-b', { enabled: true, source: 'self', changedAt: 500 }), 1)
  await settle()
  assert.equal(store.snapshot('session-a').gate?.enabled, false)
  assert.equal(store.snapshot('session-b').gate?.enabled, true)
  assert.equal(store.snapshot('session-b').gate?.changedAt, 500)
  first(); second(); other()
})

test('a write publishes only to its own session', async () => {
  const { store, fetch } = gateHarness()
  let aNotified = 0
  let bNotified = 0
  const a = store.subscribe('session-a', () => { aNotified += 1 })
  const b = store.subscribe('session-b', () => { bNotified += 1 })
  await settle()
  fetch.respond(gateBody('session-a'), 0)
  fetch.respond(gateBody('session-b'), 1)
  await settle()
  const confirmedB = store.snapshot('session-b').gate
  const callsBefore = fetch.calls.length
  const bNotifiedBefore = bNotified
  const write = store.setEnabled('session-a', true)
  await settle()
  assert.equal(fetch.calls.length, callsBefore + 1, 'exactly one write request for session A')
  assert.match(fetch.calls[callsBefore]!.url, /\/dsh-api-cost\/v2\/gate$/)
  assert.equal(store.snapshot('session-a').saving, true)
  assert.equal(store.snapshot('session-b').saving, false, 'session B has no write in flight')
  assert.equal(store.snapshot('session-b').gate, confirmedB, 'the confirmed view of B is untouched')
  assert.equal(bNotified, bNotifiedBefore, 'writing A does not notify B')
  fetch.respond(gateBody('session-a', {
    enabled: true, source: 'self', state: 'holding', holding: 2, since: 900, releaseAt: 9000, changedAt: 800,
  }), callsBefore)
  await write
  assert.equal(store.snapshot('session-a').gate?.enabled, true)
  assert.equal(store.snapshot('session-a').saving, false)
  assert.equal(store.snapshot('session-b').gate, confirmedB)
  assert.ok(aNotified > 0)
  a(); b()
})

test('a write supersedes only its own session\'s pending read', async () => {
  const { store, fetch } = gateHarness()
  const a = store.subscribe('session-a', () => {})
  const b = store.subscribe('session-b', () => {})
  await settle()
  assert.equal(fetch.calls.length, 2)
  const write = store.setEnabled('session-a', true)
  await settle()
  assert.equal(fetch.calls.length, 3)
  assert.equal(fetch.calls[0]!.signal?.aborted, true, 'the superseded read for A is aborted')
  assert.equal(fetch.calls[1]!.signal?.aborted, false, 'B\'s read is untouched')
  assert.equal(store.snapshot('session-a').loading, false, 'cancelling the read settles its loading flag')
  assert.equal(store.snapshot('session-a').saving, true)
  assert.equal(store.snapshot('session-b').loading, true, 'B is still waiting for its own answer')
  fetch.respond(gateBody('session-b'), 1)
  await settle()
  assert.equal(store.snapshot('session-b').gate?.sessionId, 'session-b')
  assert.equal(fetch.calls[1]!.signal?.aborted, false)
  fetch.respond(gateBody('session-a', { enabled: true, source: 'self', changedAt: 800 }), 2)
  await write
  assert.equal(store.snapshot('session-a').gate?.enabled, true)
  a(); b()
})

test('a failed re-read keeps the last confirmed view of that session only', async () => {
  const { store, fetch, clock } = gateHarness()
  const a = store.subscribe('session-a', () => {})
  const b = store.subscribe('session-b', () => {})
  await settle()
  fetch.respond(gateBody('session-a', { next: { at: clock.now() + 2000, peak: false } }), 0)
  fetch.respond(gateBody('session-b'), 1)
  await settle()
  const confirmed = store.snapshot('session-a').gate
  assert.ok(confirmed)
  clock.advance(2000)
  await settle()
  assert.equal(fetch.calls.length, 3, 'the tier boundary re-reads A only')
  assert.match(fetch.calls[2]!.url, /session=session-a/)
  fetch.fail(new Error('network down'), 2)
  await settle()
  assert.equal(store.snapshot('session-a').error, 'network down')
  assert.equal(store.snapshot('session-a').gate, confirmed, 'a failure neither invents nor drops state')
  assert.equal(store.snapshot('session-a').loading, false)
  assert.equal(store.snapshot('session-b').gate?.sessionId, 'session-b')
  assert.equal(store.snapshot('session-b').error, null)
  assert.equal(fetch.calls.length, 3, 'no request was issued for B')
  a(); b()
})

test('a failed write keeps the previous flag and surfaces the error', async () => {
  const { store, fetch } = gateHarness()
  const a = store.subscribe('session-a', () => {})
  await settle()
  fetch.respond(gateBody('session-a'), 0)
  await settle()
  const confirmed = store.snapshot('session-a').gate
  const write = store.setEnabled('session-a', true)
  await settle()
  assert.equal(store.snapshot('session-a').gate?.enabled, false, 'the switch does not move before the host answers')
  assert.equal(store.snapshot('session-a').saving, true)
  fetch.fail(new Error('denied'), 1)
  await write
  assert.equal(store.snapshot('session-a').gate, confirmed, 'the published value stays the last confirmed one')
  assert.equal(store.snapshot('session-a').gate?.enabled, false)
  assert.equal(store.snapshot('session-a').saving, false)
  assert.equal(store.snapshot('session-a').error, 'denied')
  a()
})

test('the published flag is always the host answer, never the requested one', async () => {
  const { store, fetch } = gateHarness()
  const a = store.subscribe('session-a', () => {})
  await settle()
  fetch.respond(gateBody('session-a'), 0)
  await settle()
  const write = store.setEnabled('session-a', true)
  await settle()
  fetch.respond(gateBody('session-a', { enabled: false }), 1)
  await write
  assert.equal(store.snapshot('session-a').gate?.enabled, false, 'an answer that disagrees with the request is what gets published')
  assert.equal(store.snapshot('session-a').saving, false)
  a()
})

test('a read timeout keeps the last confirmed view and reports the timeout once', async () => {
  const { store, fetch, clock } = gateHarness()
  const a = store.subscribe('session-a', () => {})
  await settle()
  fetch.respond(gateBody('session-a', { next: { at: clock.now() + 5000, peak: false } }), 0)
  await settle()
  const confirmed = store.snapshot('session-a').gate
  clock.advance(5000)
  await settle()
  assert.equal(fetch.calls.length, 2, 'the boundary read is in flight')
  clock.advance(8000)
  await settle()
  assert.equal(store.snapshot('session-a').error, 'Request timed out')
  assert.equal(store.snapshot('session-a').loading, false)
  assert.equal(store.snapshot('session-a').gate, confirmed)
  assert.equal(fetch.calls[1]!.signal?.aborted, true, 'the timed-out read is aborted')
  a()
})

test('a write timeout clears saving without inventing a value', async () => {
  const { store, fetch, clock } = gateHarness()
  const a = store.subscribe('session-a', () => {})
  await settle()
  fetch.respond(gateBody('session-a'), 0)
  await settle()
  const confirmed = store.snapshot('session-a').gate
  void store.setEnabled('session-a', true)
  await settle()
  assert.equal(store.snapshot('session-a').saving, true)
  clock.advance(8000)
  await settle()
  assert.equal(store.snapshot('session-a').saving, false)
  assert.equal(store.snapshot('session-a').error, 'Request timed out')
  assert.equal(store.snapshot('session-a').gate, confirmed)
  assert.equal(fetch.calls[1]!.signal?.aborted, true)
  a()
})

test('a parked session is polled every 2 s and its idle peer is not', async () => {
  const { store, fetch, clock } = gateHarness()
  const a = store.subscribe('session-a', () => {})
  const b = store.subscribe('session-b', () => {})
  await settle()
  const releaseAt = clock.now() + 60000
  const parked = (since: number): unknown => gateBody('session-a', {
    enabled: true, state: 'holding', holding: 2, since, releaseAt, next: { at: releaseAt, peak: false },
  })
  fetch.respond(parked(clock.now() - 500), 0)
  fetch.respond(gateBody('session-b'), 1)
  await settle()
  assert.equal(clock.pending, 2, 'the parked session arms a poll and a boundary; the idle one arms nothing')
  clock.advance(1999)
  await settle()
  assert.equal(fetch.calls.length, 2, 'nothing is polled before two seconds')
  clock.advance(1)
  await settle()
  assert.equal(fetch.calls.length, 3, 'the 2 s poll fired for the parked session only')
  assert.match(fetch.calls[2]!.url, /session=session-a/)
  fetch.respond(parked(clock.now() - 2500), 2)
  await settle()
  a(); b()
  assert.equal(clock.pending, 0, 'the last subscriber clears every timer')
})

test('peak that holds nothing is polled every 15 s instead of every 2 s', async () => {
  const { store, fetch, clock } = gateHarness()
  const a = store.subscribe('session-a', () => {})
  await settle()
  fetch.respond(gateBody('session-a', { enabled: true, state: 'holding', holding: 0 }), 0)
  await settle()
  assert.equal(clock.pending, 1, 'no request is parked, so only the idle poll is armed')
  clock.advance(14999)
  await settle()
  assert.equal(fetch.calls.length, 1, 'an idle hold is not re-read every 2 s')
  clock.advance(1)
  await settle()
  assert.equal(fetch.calls.length, 2, 'the 15 s poll fired')
  a()
})

test('the boundary timer re-reads at the tier change and clamps a distant instant', async () => {
  const { store, fetch, clock } = gateHarness()
  const a = store.subscribe('session-a', () => {})
  await settle()
  const distant = clock.now() + 3_000_000_000
  fetch.respond(gateBody('session-a', { next: { at: distant, peak: false } }), 0)
  await settle()
  assert.equal(clock.pending, 1, 'a tier boundary is armed')
  clock.advance(2_147_483_646)
  await settle()
  assert.equal(fetch.calls.length, 1, 'nothing is read early')
  clock.advance(1)
  await settle()
  assert.equal(fetch.calls.length, 1, 'the clamped timer re-arms rather than firing a premature read')
  assert.equal(clock.pending, 1)
  clock.advance(distant - clock.now())
  await settle()
  assert.equal(fetch.calls.length, 2, 'the real boundary then performs the re-read')
  a()
})

test('a past boundary is never armed', async () => {
  const { store, fetch, clock } = gateHarness()
  const a = store.subscribe('session-a', () => {})
  await settle()
  fetch.respond(gateBody('session-a', { next: { at: clock.now() - 1, peak: false } }), 0)
  await settle()
  assert.equal(clock.pending, 0, 'an instant already behind the clock arms no timer')
  assert.equal(fetch.calls.length, 1)
  a()
})

test('a hidden page pauses every session and a visible page re-reads them at once', async () => {
  const { store, fetch, clock, page } = gateHarness()
  const a = store.subscribe('session-a', () => {})
  const b = store.subscribe('session-b', () => {})
  await settle()
  assert.equal(fetch.calls.length, 2)
  page.set(false)
  await settle()
  assert.equal(fetch.calls[0]!.signal?.aborted, true)
  assert.equal(fetch.calls[1]!.signal?.aborted, true)
  assert.equal(clock.pending, 0, 'a hidden document keeps no timer alive')
  const before = fetch.calls.length
  clock.advance(60000)
  await settle()
  assert.equal(fetch.calls.length, before, 'no request runs while hidden')
  page.set(true)
  await settle()
  assert.equal(fetch.calls.length, before + 2, 'becoming visible re-reads every waiting session at once')
  assert.equal(store.snapshot('session-a').loading, true)
  assert.equal(store.snapshot('session-b').loading, true)
  fetch.respond(gateBody('session-a'), before)
  fetch.respond(gateBody('session-b'), before + 1)
  await settle()
  assert.equal(store.snapshot('session-a').gate?.sessionId, 'session-a')
  assert.equal(store.snapshot('session-b').gate?.sessionId, 'session-b')
  a(); b()
})

test('a hidden page cancels a write and reconciles with a read when visible', async () => {
  const { store, fetch, clock, page } = gateHarness()
  const a = store.subscribe('session-a', () => {})
  await settle()
  fetch.respond(gateBody('session-a'), 0)
  await settle()
  void store.setEnabled('session-a', true)
  await settle()
  assert.equal(store.snapshot('session-a').saving, true)
  assert.equal(fetch.calls[1]!.signal?.aborted, false)
  page.set(false)
  await settle()
  assert.equal(store.snapshot('session-a').saving, false, 'a hidden tab cannot leave the switch frozen')
  assert.equal(store.snapshot('session-a').gate?.enabled, false, 'the flag stays the last confirmed one')
  assert.equal(fetch.calls[1]!.signal?.aborted, true)
  assert.equal(clock.pending, 0)
  page.set(true)
  await settle()
  assert.equal(fetch.calls.length, 3, 'the abandoned write is reconciled by a fresh read')
  assert.match(fetch.calls[2]!.url, /session=session-a/)
  fetch.respond(gateBody('session-a', { enabled: true, source: 'self', changedAt: 5000 }), 2)
  await settle()
  assert.equal(store.snapshot('session-a').gate?.enabled, true)
  a()
})

test('teardown of one session leaves the other session running', async () => {
  const { store, fetch, clock } = gateHarness()
  const a = store.subscribe('session-a', () => {})
  const b = store.subscribe('session-b', () => {})
  await settle()
  a()
  assert.equal(fetch.calls[0]!.signal?.aborted, true)
  assert.equal(fetch.calls[1]!.signal?.aborted, false, 'A\'s teardown does not abort B\'s read')
  assert.equal(store.snapshot('session-a').gate, null, 'the dropped entry leaves a default snapshot behind')
  assert.equal(store.snapshot('session-a').loading, false)
  fetch.respond(gateBody('session-b'), 1)
  await settle()
  assert.equal(store.snapshot('session-b').gate?.sessionId, 'session-b')
  b()
  assert.equal(clock.pending, 0)
})

test('a view for another session is refused rather than published', async () => {
  const { store, fetch } = gateHarness()
  const a = store.subscribe('session-a', () => {})
  await settle()
  fetch.respond(gateBody('session-b'), 0)
  await settle()
  assert.equal(store.snapshot('session-a').gate, null, 'the mismatched body must not become this session\'s view')
  assert.equal(store.snapshot('session-a').error, 'Malformed gate view')
  assert.equal(store.snapshot('session-a').loading, false)
  a()
})

test('disposal aborts every session and refuses further work', async () => {
  const { store, fetch, clock } = gateHarness()
  store.subscribe('session-a', () => {})
  store.subscribe('session-b', () => {})
  await settle()
  store.dispose()
  assert.equal(fetch.calls[0]!.signal?.aborted, true)
  assert.equal(fetch.calls[1]!.signal?.aborted, true)
  assert.equal(clock.pending, 0)
  assert.equal(store.snapshot('session-a').gate, null)
  assert.equal(store.snapshot('session-b').gate, null)
  assert.equal(store.subscribe('session-a', () => {})(), undefined)
  await assert.doesNotReject(() => store.setEnabled('session-a', true))
})

test('a write that outlived its subscribers leaves no frozen entry behind', async () => {
  const { store, fetch } = gateHarness()
  const write = store.setEnabled('session-a', true)
  await settle()
  assert.equal(fetch.calls.length, 1, 'a write can be issued before a subscriber exists')
  fetch.respond(gateBody('session-a', { enabled: true }), 0)
  await write
  assert.equal(store.snapshot('session-a').gate, null, 'no orphan snapshot is published')
  const unsubscribe = store.subscribe('session-a', () => {})
  await settle()
  assert.equal(fetch.calls.length, 2, 'the later subscriber starts from a clean read')
  assert.equal(store.snapshot('session-a').saving, false, 'the orphan write cannot freeze the new entry')
  fetch.respond(gateBody('session-a', { enabled: true, source: 'self', changedAt: 800 }), 1)
  await settle()
  assert.equal(store.snapshot('session-a').gate?.enabled, true)
  unsubscribe()
})
