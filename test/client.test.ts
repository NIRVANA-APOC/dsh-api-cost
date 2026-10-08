/**
 * Client bridge behaviour: validation, single-flight, generation safety and
 * resource release. These are Node-level tests over the same modules the
 * browser bundle ships — no DOM, no React, no live Harness connection.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CostTransport, validCostView, validLedger, validPricingView } from '../src/client/transport.ts'
import type { HttpResponse } from '../src/client/transport.ts'
import { CostStore, PricingStore } from '../src/client/store.ts'
import { cardNotes } from '../src/client/cardNotes.ts'
import type { Scheduler, Visibility } from '../src/client/store.ts'

/* ------------------------------------------------------------------ *
 * Doubles
 * ------------------------------------------------------------------ */

interface Pending { readonly url: string; readonly signal: AbortSignal | undefined; readonly rawResolve: (response: HttpResponse) => void; readonly rawReject: (error: unknown) => void }
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
    this.calls.push({ url, signal: options.signal ?? undefined, rawResolve: resolve, rawReject: reject })
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
