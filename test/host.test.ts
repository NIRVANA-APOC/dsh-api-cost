/**
 * dsh-api-cost — host-half integration test (TypeScript host, DSH 0.2.0-rc.2).
 *
 * Every test drives the real `src/host/**` code: `apply()` composes the plugin
 * against a fake Cordis context, the real `createCostProjection` unit is folded
 * event by event through a fake `sessionProjections` registry, reads go through
 * a fake `sessionQuery.observeSession` that returns a disposable observation,
 * and HTTP goes through the handler the plugin registered on a fake
 * `webServer.register`.
 *
 * The doubles are NOT a real DSH service. They implement only the documented
 * contract of each seam (`ProjectionDefinition` pure fold + wire view, the
 * `observeSession` observation lease, `register` returning its disposer, the
 * change feed notifying on `Object.is` view changes). No fixture decides a
 * price, a scope or an attribution: those come from `src/pricing` and
 * `src/host`, so a failure here is a host-behaviour failure.
 *
 * Run: <node> --test test/host.test.ts   (from the package directory)
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, name } from '../src/host/index.ts'
import { createCostProjection } from '../src/host/projection.ts'
import { CostQueries, QueryError, parseScope, validateSessionId } from '../src/host/query.ts'
import { publicError } from '../src/host/http.ts'
import { createPricingEngine, decimalToNano } from '../src/pricing/index.ts'
import { API_PREFIX, PACKAGE_NAME, PROJECTION_KEY } from '../src/shared/contracts.ts'
import { validCostView, validPricingView } from '../src/client/transport.ts'
import type { CostView, LedgerView, PluginConfig, Totals } from '../src/shared/contracts.ts'
import type { QuerySource } from '../src/host/query.ts'
import type { SessionId } from '@deepseek-ai/dsh-session'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const VIEW = `${API_PREFIX}/view`
const PRICING = `${API_PREFIX}/pricing`

/** Explicit Beijing wall-clock time; the tests never read the real clock. */
const bj = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  Date.UTC(year, month - 1, day, hour - 8, minute)

/** Wednesday 2026-09-30 10:00 +08:00 — a working day inside the 09:00-12:00 window. */
const PEAK = bj(2026, 9, 30, 10)
/** The same working day at 20:00 — outside both published windows. */
const OFF_PEAK = bj(2026, 9, 30, 20)
/** Friday 2026-09-11 10:00 +08:00 — peak, after the card date and before the routing dispute. */
const PRE_DISPUTE_PEAK = bj(2026, 9, 11, 10)

/** Disjoint buckets, exactly the shape DSH records for a settled model call. */
const REAL_USAGE = { inputTokens: 459, outputTokens: 294, cacheReadTokens: 10496, cacheWriteTokens: 0, totalTokens: 11249 }
/** Independent hand-computed figure: 459*2 + 10496*0.04 + 294*8 per million tokens. */
const PEAK_CNY = '0.00368984'
const PEAK_USD = '0.000553476'
const OFF_PEAK_CNY = '0.00184492'

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/
const INTEGER = /^(0|[1-9]\d*)$/

interface FakeHeader {
  version: number
  id: string
  createdAt: number
  isSeeded: boolean
  parentSession?: string
  origin?: 'subagent'
  delegationDepth?: number
}
interface FakeEvent {
  type: string
  seq: number
  time: number
  data: any
}
interface FakeSession {
  header: FakeHeader
  inheritedEventCount: number
  events: FakeEvent[]
}

/** One settled assistant message, in the shape DSH appends to the durable log. */
function messageEvent(seq: number, time: number, model: unknown, usage?: unknown, stream?: unknown): FakeEvent {
  const data: Record<string, unknown> = {
    turn: 1, step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-account', model } },
    stream: stream ?? [],
  }
  if (usage !== undefined) data.usage = usage
  return { type: 'assistant/message', seq, time, data }
}
function attemptEvent(seq: number, time: number, stream: unknown): FakeEvent {
  return { type: 'assistant/attempt', seq, time, data: { turn: 1, step: 1, stream } }
}
function usageChunk(usage: unknown, time: number = PEAK): unknown {
  return { type: 'chunk', time, chunk: { type: 'usage', usage } }
}
function headerEvent(seq: number, time: number, model: unknown): FakeEvent {
  return { type: 'request/header', seq, time, data: { header: { config: { provider: 'deepseek-account', model } }, reason: 'initial' } }
}
/** The parent-owned direct-child discovery fact `@deepseek-ai/dsh-subagent` appends. */
function catalogEvent(seq: number, childId: string): FakeEvent {
  return { type: 'subagent/catalog', seq, time: PEAK, data: { version: 1, childId, childCreatedAt: PEAK, mode: 'one-shot' } }
}
/** The whole-value teammate lifecycle record stored in the Team Lead's log. */
function teamMemberEvent(seq: number, id: string, name: string, phase = 'active'): FakeEvent {
  return {
    type: 'team/member', seq, time: PEAK,
    data: { version: 2, teamId: 'team-lead', member: { id, name, description: '', provider: 'deepseek-account', context: 'fresh', phase } },
  }
}

/* ------------------------------------------------------------------ *
 * Fake DSH seams
 * ------------------------------------------------------------------ */

interface DefinitionLike {
  key: string
  stateVersion: number
  stateSchema: { parse(value: unknown): unknown }
  init(header: unknown, inheritedEventCount: number): unknown
  apply(state: unknown, event: unknown): unknown
  wire?: { viewSchema: { parse(value: unknown): unknown }, view(state: unknown): unknown }
}
type ChangeListener = (session: { id: string }, key: string, value: unknown, seq: number) => void
interface Cell {
  state: unknown
  view: unknown
  folded: number
  hasView: boolean
  viewState: unknown
}

/**
 * Fake `ctx.sessionProjections`: it drives every registered unit exactly the way
 * the real registry documents — eager `apply` per committed event, a state
 * reference change only when the unit owns the event, a change published only
 * when the raw wire view changes by `Object.is`, and every served value passing
 * its own `viewSchema`.
 */
function createRegistry(sessions: Map<string, FakeSession>) {
  const definitions = new Map<string, DefinitionLike>()
  const listeners = new Set<ChangeListener>()
  /** One lazily materialized cell per (session, key), advanced event by event. */
  const cells = new Map<string, Map<string, Cell>>()

  const cellFor = (definition: DefinitionLike, session: FakeSession): Cell => {
    let byKey = cells.get(session.header.id)
    if (byKey === undefined) { byKey = new Map(); cells.set(session.header.id, byKey) }
    let cell = byKey.get(definition.key)
    if (cell === undefined) {
      cell = { state: definition.init(session.header, session.inheritedEventCount), view: undefined, folded: 0, hasView: false, viewState: undefined }
      byKey.set(definition.key, cell)
    }
    // Eager drive: fold exactly the events this cell has not seen. An event the
    // unit does not own returns the same state reference, so nothing downstream
    // changes — the documented `Object.is` discipline.
    while (cell.folded < session.events.length) {
      cell.state = definition.apply(cell.state, session.events[cell.folded])
      cell.folded += 1
    }
    return cell
  }
  const cellView = (definition: DefinitionLike, cell: Cell): unknown => {
    if (definition.wire === undefined) return undefined
    // Only a changed state reference recomputes the view; an unchanged one reuses it.
    if (!cell.hasView || !Object.is(cell.viewState, cell.state)) {
      cell.view = definition.wire.view(cell.state)
      cell.viewState = cell.state
      cell.hasView = true
    }
    return cell.view
  }

  return {
    definitions,
    register(definition: DefinitionLike): () => void {
      definitions.set(definition.key, definition)
      return () => { definitions.delete(definition.key) }
    },
    onChanged(listener: ChangeListener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** `stateOf` from the DSH read face. */
    stateOf(session: FakeSession, key: string): unknown {
      const definition = definitions.get(key)
      return definition === undefined ? undefined : cellFor(definition, session).state
    },
    /** One consistent, schema-validated client cut. */
    snapshot(session: FakeSession): { asOfSeq: number, values: Record<string, unknown> } {
      const values: Record<string, unknown> = {}
      for (const [key, definition] of definitions) {
        if (definition.wire === undefined) continue
        values[key] = definition.wire.viewSchema.parse(cellView(definition, cellFor(definition, session)))
      }
      const last = session.events[session.events.length - 1]
      return { asOfSeq: last === undefined ? -1 : last.seq, values }
    },
    /** Commit one event, then publish every unit whose raw view changed against the previous drive result. */
    append(session: FakeSession, event: FakeEvent): void {
      const before = new Map<string, unknown>()
      for (const [key, definition] of definitions) {
        if (definition.wire === undefined) continue
        before.set(key, cellView(definition, cellFor(definition, session)))
      }
      session.events.push(event)
      for (const [key, definition] of definitions) {
        if (definition.wire === undefined) continue
        const value = cellView(definition, cellFor(definition, session))
        if (Object.is(before.get(key), value)) continue
        for (const listener of listeners) listener({ id: session.header.id }, key, value, event.seq)
      }
    },
  }
}

/**
 * Stand-ins for the two DSH units whose values the host reads next to its own
 * (`subagentCatalog` from `@deepseek-ai/dsh-subagent`, `agentTeam` from
 * `@deepseek-ai/dsh-experimental-agent-team`). They fold the same whole-value
 * event payloads and apply the same fork-inheritance and Lead-row rules the
 * shipped units document, so the host's read path is exercised against real
 * projection semantics instead of a stubbed value map.
 */
function installStandInUnits(registry: ReturnType<typeof createRegistry>): void {
  const teamViews = new WeakMap<object, unknown>()
  registry.register({
    key: 'subagentCatalog', stateVersion: 3,
    stateSchema: { parse: (value: unknown) => value },
    init: (_header, inheritedEventCount) => ({ inheritedEventCount, entries: [] as unknown[] }),
    apply(state: any, event: any) {
      if (event?.type !== 'subagent/catalog' || typeof event.seq !== 'number' || event.seq < state.inheritedEventCount) return state
      const data = event.data
      if (data === null || typeof data !== 'object' || typeof data.childId !== 'string') return state
      const entry = { id: data.childId, createdAt: typeof data.childCreatedAt === 'number' ? data.childCreatedAt : 0, mode: data.mode ?? 'unknown' }
      return { ...state, entries: [...state.entries, entry] }
    },
    wire: { viewSchema: { parse: (value: unknown) => value }, view: (state: any) => state.entries },
  })
  registry.register({
    key: 'agentTeam', stateVersion: 4,
    stateSchema: { parse: (value: unknown) => value },
    init: (header: any) => ({ rootId: header?.id, members: [] as unknown[] }),
    apply(state: any, event: any) {
      if (event?.type !== 'team/member') return state
      const member = event.data?.member
      if (member === null || typeof member !== 'object' || typeof member.id !== 'string' || typeof member.name !== 'string') {
        return { ...state, failure: 'invalid team member record' }
      }
      const row = { id: member.id, name: member.name, role: member.id === state.rootId ? 'lead' : 'teammate', phase: typeof member.phase === 'string' ? member.phase : 'active' }
      return { ...state, members: [...state.members.filter((item: any) => item.id !== row.id), row] }
    },
    wire: {
      viewSchema: { parse: (value: unknown) => value },
      // The shipped unit memoizes its view by collection reference so a
      // mailbox-only change republishes nothing; the double must do the same,
      // otherwise every event would look like a roster change.
      view: (state: any) => {
        const cached = teamViews.get(state.members)
        if (cached !== undefined) return cached
        const built = {
          members: [{ id: state.rootId, name: 'lead', role: 'lead', phase: 'active' }, ...state.members],
          tasks: [],
          ...(state.failure === undefined ? {} : { failure: state.failure }),
        }
        teamViews.set(state.members, built)
        return built
      },
    },
  })
}

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
  /** Test-side socket close: what a real client disconnect does to the response. */
  close(): void
}

/** Minimal node:http `ServerResponse` double: headers, body, and the close event. */
function createResponse(): FakeResponse {
  const closeListeners = new Set<() => void>()
  const res: FakeResponse = {
    status: 0, headers: {}, body: '', ended: false, destroyed: false,
    get writableEnded() { return res.ended },
    writeHead(status, headers) { res.status = status; if (headers !== undefined) res.headers = { ...headers }; return res },
    end(text) { if (typeof text === 'string') res.body = text; res.ended = true; return res },
    once(event, listener) { if (event === 'close') closeListeners.add(listener); return res },
    off(event, listener) { closeListeners.delete(listener); return res },
    close() { for (const listener of [...closeListeners]) listener() },
  }
  return res
}

function abortError(): Error { return new DOMException('Request cancelled', 'AbortError') }
/** A function boundary, so the caller's control-flow narrowing cannot make a recheck dead code. */
function isAborted(signal: AbortSignal | undefined): boolean { return signal !== undefined && signal.aborted }
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

interface HarnessOptions {
  config?: PluginConfig
  /** Service names to leave out of the composition, for degradation tests. */
  without?: readonly string[]
}

function harness(options: HarnessOptions = {}) {
  const sessions = new Map<string, FakeSession>()
  const observeCalls: string[] = []
  const disposedObservations: string[] = []
  const readErrors = new Map<string, unknown>()
  const effectDisposers: Array<() => void> = []
  const routes = new Map<string, (req: any, res: any) => unknown>()
  const tools: any[] = []
  const commands: any[] = []
  const agents = new Map<string, { id: string }>()
  const memberships = new Map<string, unknown>()
  const registry = createRegistry(sessions)
  installStandInUnits(registry)
  let held: Promise<void> | undefined
  let releaseHeld: (() => void) | undefined

  const query = {
    async observeSession(id: string, readOptions?: { signal?: AbortSignal, projectionMode?: 'all' | 'none' }) {
      observeCalls.push(id)
      const signal = readOptions?.signal
      if (isAborted(signal)) throw abortError()
      if (held !== undefined) await held
      const failure = readErrors.get(id)
      if (failure !== undefined) throw failure
      const session = sessions.get(id)
      if (session === undefined) {
        const missing: any = new Error(`Session ${id} is not available`)
        missing.code = 'SESSION_QUERY_NOT_FOUND'
        throw missing
      }
      // A cooperative cold read observes cancellation at its next checkpoint.
      if (isAborted(signal)) throw abortError()
      const projections = readOptions?.projectionMode === 'none' ? undefined : registry.snapshot(session)
      let released = false
      return {
        source: 'prepared' as const,
        header: session.header,
        inheritedEventCount: session.inheritedEventCount,
        events: session.events.slice(),
        cursor: session.events.length === 0 ? -1 : (session.events[session.events.length - 1] as FakeEvent).seq,
        projections,
        retain() { return this },
        [Symbol.dispose]() { if (!released) { released = true; disposedObservations.push(id) } },
      }
    },
  }
  const webServer = {
    register(route: { path: string, handler: (req: any, res: any) => unknown }) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  const services: Record<string, unknown> = {
    webServer,
    sessionProjections: registry,
    sessionProjectionCache: { note: 'fake: the host only asserts the capability is mounted' },
    sessionQuery: query,
    agents: { get: (id: string) => agents.get(id) },
    agentTeams: { tryMembership: (agent: { id: string } | undefined) => (agent === undefined ? undefined : memberships.get(agent.id)) },
    tools: { register: (definition: unknown) => { tools.push(definition); return () => {} } },
    commands: { register: (definition: unknown) => { commands.push(definition); return () => {} } },
  }
  for (const service of options.without ?? []) delete services[service]

  const ctx: any = {
    sessionProjections: services.sessionProjections,
    sessionProjectionCache: services.sessionProjectionCache,
    sessionQuery: services.sessionQuery,
    webServer: services.webServer,
    get: (service: string) => services[service],
    effect(callback: () => unknown) {
      const disposer = callback()
      if (typeof disposer === 'function') effectDisposers.push(disposer as () => void)
      return () => { if (typeof disposer === 'function') disposer() }
    },
    inject(dependencies: readonly string[], callback: (inner: unknown) => void) {
      if (!dependencies.every((dependency) => services[dependency] !== undefined)) return
      // Cordis exposes every injected service as a property of the callback's ctx.
      const inner: any = { get: ctx.get, effect: ctx.effect, on: ctx.on, interval: ctx.interval }
      for (const dependency of dependencies) Object.defineProperty(inner, dependency, { get: () => services[dependency] })
      callback(inner)
    },
    on() { return () => {} },
    interval() { return () => {} },
  }

  const h = {
    ctx, routes, tools, commands, registry, observeCalls, disposedObservations, effectDisposers, sessions, agents, memberships,
    addSession(id: string, sessionOptions: { parentSession?: string, origin?: 'subagent', inheritedEventCount?: number, events?: FakeEvent[] } = {}): FakeSession {
      const header: FakeHeader = { version: 4, id, createdAt: 0, isSeeded: (sessionOptions.inheritedEventCount ?? 0) > 0 }
      if (sessionOptions.parentSession !== undefined) header.parentSession = sessionOptions.parentSession
      if (sessionOptions.origin !== undefined) { header.origin = sessionOptions.origin; header.delegationDepth = 1 }
      const session: FakeSession = { header, inheritedEventCount: sessionOptions.inheritedEventCount ?? 0, events: [...(sessionOptions.events ?? [])] }
      sessions.set(id, session)
      return session
    },
    session(id: string): FakeSession {
      const session = sessions.get(id)
      assert.ok(session !== undefined, `fixture session ${id} must exist`)
      return session
    },
    /** Commit one durable event and publish the projection changes it caused. */
    append(sessionId: string, event: FakeEvent): void {
      const session = sessions.get(sessionId) ?? h.addSession(sessionId)
      registry.append(session, event)
    },
    /** Park every subsequent observation until `releaseReads`, for deterministic ordering. */
    holdReads(): void {
      held = new Promise<void>((resolve) => { releaseHeld = resolve })
    },
    releaseReads(): void {
      const release = releaseHeld
      held = undefined; releaseHeld = undefined
      release?.()
    },
    /** Make one session id fail the way a broken persistence backend would. */
    setReadError(sessionId: string, error: unknown): void { readErrors.set(sessionId, error) },
    /** Dispose every effect the plugin registered, newest first, like a fiber unload. */
    dispose(): void {
      for (let index = effectDisposers.length - 1; index >= 0; index -= 1) (effectDisposers[index] as () => void)()
    },
  }
  apply(ctx, options.config ?? {})
  return h
}

type Harness = ReturnType<typeof harness>

interface Sent {
  res: FakeResponse
  done: Promise<{ status: number, headers: Record<string, unknown>, body: any }>
}

function startRequest(h: Harness, path: string, queryString = '', options: { method?: string, headers?: Record<string, string> } = {}): Sent {
  const handler = h.routes.get(path)
  assert.ok(handler !== undefined, `the host must register the route ${path}`)
  const res = createResponse()
  const req = { method: options.method ?? 'GET', url: queryString === '' ? path : `${path}?${queryString}`, headers: options.headers ?? {} }
  const done = (async () => {
    await handler(req, res)
    return { status: res.status, headers: res.headers, body: res.body === '' ? undefined : JSON.parse(res.body) }
  })()
  return { res, done }
}
async function request(h: Harness, path: string, queryString = '', options: { method?: string, headers?: Record<string, string> } = {}) {
  return startRequest(h, path, queryString, options).done
}

/* ------------------------------------------------------------------ *
 * Assertion helpers
 * ------------------------------------------------------------------ */

/** One boundary cast: these doubles carry the documented contract, not DSH's branded types. */
const cast = (value: unknown): any => value as any

/** Validate a body against the client wire contract without narrowing the caller's binding. */
function assertValidView(body: unknown, label = 'view'): void {
  assert.ok(validCostView(body), `${label} must satisfy the client wire validator`)
}

/** A `QuerySource` double answering with a real folded ledger, no catalog and no Team. */
function cutSource(ledgerOf: (id: string, signal: AbortSignal) => LedgerView | Promise<LedgerView>): QuerySource {
  return {
    async read(id, signal) {
      return {
        header: { id: id as SessionId },
        ledger: await ledgerOf(id, signal), catalog: undefined, team: undefined,
      }
    },
  }
}

/** Every response body is JSON; a NaN would have been serialized as null. */
function assertNoNumbersLeaked(body: any, label: string): void {
  const text = JSON.stringify(body)
  assert.ok(!/\bNaN\b|\bInfinity\b/.test(text), `${label}: the ledger must never contain NaN/Infinity: ${text}`)
}

function assertTotalsWellFormed(totals: Totals, label: string): void {
  for (const key of ['cacheHit', 'cacheMiss', 'output', 'reasoning', 'total'] as const) {
    assert.match(totals.tokens[key], INTEGER, `${label}: tokens.${key} must be an exact integer string, got ${JSON.stringify(totals.tokens[key])}`)
  }
  for (const money of [totals.money, totals.periods.peak, totals.periods.offPeak]) {
    assert.match(money.cny, DECIMAL, `${label}: cny must be an exact decimal string, got ${JSON.stringify(money.cny)}`)
    assert.match(money.usd, DECIMAL, `${label}: usd must be an exact decimal string, got ${JSON.stringify(money.usd)}`)
  }
}

/** own + others must reconstruct total exactly, in every bucket. */
function assertSplitIsExact(view: CostView, label: string): void {
  assert.equal(view.own.calls + view.others.calls, view.total.calls, `${label}: own.calls + others.calls must equal total.calls`)
  assert.equal(view.own.attempts + view.others.attempts, view.total.attempts, `${label}: own.attempts + others.attempts must equal total.attempts`)
  assert.equal(view.own.unpricedCalls + view.others.unpricedCalls, view.total.unpricedCalls, `${label}: unpriced calls must add up`)
  assert.equal(
    decimalToNano(view.own.money.cny) + decimalToNano(view.others.money.cny), decimalToNano(view.total.money.cny),
    `${label}: own + others must equal total in CNY (${view.own.money.cny} + ${view.others.money.cny} != ${view.total.money.cny})`,
  )
  assert.equal(
    decimalToNano(view.own.money.usd) + decimalToNano(view.others.money.usd), decimalToNano(view.total.money.usd),
    `${label}: own + others must equal total in USD`,
  )
  for (const key of ['cacheHit', 'cacheMiss', 'output', 'reasoning', 'total'] as const) {
    assert.equal(
      BigInt(view.own.tokens[key]) + BigInt(view.others.tokens[key]), BigInt(view.total.tokens[key]),
      `${label}: own + others must equal total for tokens.${key}`,
    )
  }
  assertTotalsWellFormed(view.total, `${label}.total`)
  assertTotalsWellFormed(view.own, `${label}.own`)
  assertTotalsWellFormed(view.others, `${label}.others`)
}

const PATH_PATTERNS = [/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/, /\/node_modules\//, /\/Users\//, /\/home\//, /file:\/\//]
function assertNoPathLeak(body: unknown, label: string): void {
  const text = JSON.stringify(body) ?? String(body)
  for (const pattern of PATH_PATTERNS) {
    assert.ok(!pattern.test(text), `${label}: the response must not leak a file path (matched ${String(pattern)}): ${text}`)
  }
}

/** A cut backed by the real projection, used by the direct CostQueries tests. */
function ledgerFor(calls: number, at: number = PEAK): LedgerView {
  const definition = createCostProjection(createPricingEngine())
  let state = definition.init(cast({ version: 4, id: 'direct', createdAt: 0, isSeeded: false }), cast(0))
  for (let index = 0; index < calls; index += 1) {
    state = definition.apply(state, cast(messageEvent(index, at, 'deepseek-flash', REAL_USAGE)))
  }
  return definition.wire.view(state)
}

/* ------------------------------------------------------------------ *
 * 1. Entry contract and settlement
 * ------------------------------------------------------------------ */

test('the host half exports the Cordis entry contract and registers one tool and one command', async () => {
  assert.equal(name, PACKAGE_NAME)
  assert.equal(typeof apply, 'function')
  const h = harness()
  assert.deepEqual([...h.routes.keys()].sort(), [VIEW, PRICING].sort(), 'apply must register exactly the view and pricing routes')
  assert.equal(h.tools.length, 1, 'apply must register the session_cost tool through ctx.inject([\'tools\'])')
  assert.equal(h.tools[0].name, 'session_cost')
  assert.equal(h.commands.length, 1, 'apply must register the /cost command through ctx.inject([\'commands\'])')
  assert.equal(h.commands[0].name, 'cost')
  assert.equal(h.effectDisposers.length, 6, 'apply must register every lifecycle it creates as a ctx.effect disposer')
})

test('a settled call is priced at the instant its event recorded, peak and off-peak separately', async () => {
  const h = harness()
  h.addSession('s-price', {
    events: [
      messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE),
      messageEvent(1, OFF_PEAK, 'deepseek-flash', REAL_USAGE),
    ],
  })
  const { status, body } = await request(h, VIEW, 'session=s-price&detail=full')
  assert.equal(status, 200)
  assertValidView(body, 'the response')
  assert.equal(body.total.calls, 2, 'two settled events are two calls')
  assert.equal(body.total.attempts, 2)
  assert.equal(body.total.money.cny, '0.00553476', `peak + off-peak CNY must be exact, got ${body.total.money.cny}`)
  assert.equal(body.total.money.usd, '0.000830214', `peak + off-peak USD must be exact, got ${body.total.money.usd}`)
  assert.equal(body.total.periods.peak.cny, PEAK_CNY, 'the 10:00 event must be billed at the peak column')
  assert.equal(body.total.periods.offPeak.cny, OFF_PEAK_CNY, 'the 20:00 event must be billed at the off-peak column')
  assert.equal(body.total.tokens.total, '22498')
  assert.equal(body.coverage.status, 'complete', `fixture must price cleanly, issues: ${body.coverage.issues.join(', ')}`)
  assert.equal(body.byModel.length, 1)
  assert.equal(body.byModel[0].model, 'deepseek-flash')
  assert.equal(body.byModel[0].totals.money.cny, '0.00553476', 'the model row must carry the same exact total')
  assert.deepEqual(body.recent.map((row: any) => row.peak), [false, true], 'recent is newest first: off-peak then peak')
  assert.equal(body.recent[0].at, OFF_PEAK, 'each row must carry the event instant, not the read instant')
  assert.equal(body.recent[0].money.cny, OFF_PEAK_CNY)
  assert.equal(body.recent[1].money.cny, PEAK_CNY)
  assertSplitIsExact(body, 'single-session scope')
  assertNoPathLeak(body, 'view 200')
})

test('a usage chunk in the durable stream is the fallback when the event carries no usage', async () => {
  const h = harness()
  const second = { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 0, totalTokens: 3000 }
  h.addSession('s-stream', {
    events: [
      // The request header is what attributes an assistant/attempt (it carries no message).
      headerEvent(0, PEAK, 'deepseek-flash'),
      // No `usage` field: only the embedded attempt stream carries accounting, and
      // the LAST usage record is the settlement of the attempt.
      messageEvent(1, PEAK, 'deepseek-flash', undefined, [usageChunk(REAL_USAGE), usageChunk(second)]),
      attemptEvent(2, PEAK, [usageChunk(second)]),
    ],
  })
  const { status, body } = await request(h, VIEW, 'session=s-stream&detail=full')
  assert.equal(status, 200)
  assert.equal(body.total.calls, 2, 'a message and an attempt both settle one call each')
  assert.equal(body.total.tokens.cacheMiss, '2000', `the last usage chunk must win on both settlements, got ${body.total.tokens.cacheMiss}`)
  assert.equal(body.total.tokens.output, '4000')
  assert.equal(body.total.tokens.total, '6000', 'the first chunk must not be summed on top of the last one')
  assert.equal(body.total.money.cny, '0.036', `1000 miss + 2000 output twice, got ${body.total.money.cny}`)
  assert.equal(body.total.money.usd, '0.0054')
  assert.equal(body.recent[0].kind, 'attempt', 'the assistant/attempt settlement is recorded as an attempt')
  assert.equal(body.byModel.length, 1, 'the request header must attribute the attempt')
  assert.equal(body.byModel[0].model, 'deepseek-flash')
  assert.equal(body.coverage.status, 'complete', `issues: ${body.coverage.issues.join(', ')}`)
  assertSplitIsExact(body, 'stream fallback')
})

test('a call with no usage at all is reported as missing-usage and never billed', async () => {
  const h = harness()
  h.addSession('s-missing', {
    events: [messageEvent(0, PEAK, 'deepseek-flash', undefined, [{ type: 'chunk', chunk: { type: 'text-delta' } }])],
  })
  const missing = (await request(h, VIEW, 'session=s-missing&detail=full')).body
  assert.equal(missing.total.calls, 0, 'a settlement with no usage report must not be a billed call')
  assert.equal(missing.total.attempts, 1, 'the attempt itself is still recorded')
  assert.equal(missing.total.unpricedCalls, 1, 'the unpriced call must be visible in the ledger')
  assert.equal(missing.total.money.cny, '0')
  assert.equal(missing.total.money.usd, '0')
  assert.equal(missing.total.tokens.total, '0')
  assert.ok(missing.coverage.issues.includes('missing-usage'), `expected missing-usage, got ${missing.coverage.issues.join(', ')}`)
  assert.equal(missing.coverage.status, 'partial')
  assert.equal(missing.recent[0].issues.includes('missing-usage'), true)
  assertNoNumbersLeaked(missing, 'missing usage')

  // A legitimate settlement arriving after it must bill exactly.
  h.append('s-missing', messageEvent(1, PEAK, 'deepseek-flash', REAL_USAGE))
  const after = (await request(h, VIEW, 'session=s-missing&detail=full')).body
  assert.equal(after.total.calls, 1)
  assert.equal(after.total.money.cny, PEAK_CNY, 'a missing usage report must not disturb later billing')
  assert.equal(after.total.tokens.total, '11249')
})

test('an unknown model is flagged and priced at zero instead of guessing', async () => {
  const h = harness()
  h.addSession('s-unknown', { events: [messageEvent(0, PEAK, 'gpt-5-nope', REAL_USAGE)] })
  const body = (await request(h, VIEW, 'session=s-unknown&detail=full')).body
  assert.equal(body.total.calls, 1)
  assert.equal(body.total.unpricedCalls, 1, 'an unpriced call must be counted as unpriced')
  assert.equal(body.total.money.cny, '0', 'an unknown model must never be priced with another model card')
  assert.equal(body.total.money.usd, '0')
  assert.ok(body.coverage.issues.includes('unknown-model'), `expected unknown-model, got ${body.coverage.issues.join(', ')}`)
  assert.equal(body.byModel.length, 1)
  assert.equal(body.byModel[0].model, 'unknown', 'the unpriced row must be labelled unknown')
  assert.equal(body.byModel[0].totals.money.cny, '0')
  assert.equal(body.total.tokens.total, '11249', 'the reported tokens are still shown for an unpriced call')
  assertNoNumbersLeaked(body, 'unknown model')
})

test('an invalid usage report is flagged and never leaks NaN into the ledger', async () => {
  const h = harness()
  h.addSession('s-invalid', {
    events: [
      messageEvent(0, PEAK, 'deepseek-flash', { inputTokens: Number.NaN, outputTokens: -5, cacheReadTokens: 3.5 }),
      messageEvent(1, PEAK, 'deepseek-flash', 42),
      messageEvent(2, PEAK, 'deepseek-flash', { inputTokens: 1, outputTokens: 1, totalTokens: 99 }),
    ],
  })
  const { status, body } = await request(h, VIEW, 'session=s-invalid&detail=full')
  assert.equal(status, 200, 'an invalid usage report must be reported, not thrown')
  assert.equal(body.total.calls, 0, 'no invalid report may be counted as a billed call')
  assert.equal(body.total.attempts, 3)
  assert.equal(body.total.unpricedCalls, 3)
  assert.equal(body.total.money.cny, '0')
  assert.equal(body.total.money.usd, '0')
  assert.equal(body.total.tokens.total, '0')
  assert.ok(body.coverage.issues.includes('invalid-usage'), `expected invalid-usage, got ${body.coverage.issues.join(', ')}`)
  assertNoNumbersLeaked(body, 'invalid usage')
  assertTotalsWellFormed(body.total, 'invalid usage')
  assert.ok(!JSON.stringify(body).includes('null'), 'a NaN must never be serialized as null somewhere in the payload')
})

/* ------------------------------------------------------------------ *
 * 2. Fork-inherited prefix
 * ------------------------------------------------------------------ */

test('fork-inherited events are never billed, and an inherited header never attributes the child', async () => {
  // Direct fold proof first: neither an inherited settlement NOR an inherited
  // request header may move the child's state off `init`.
  const definition = createCostProjection(createPricingEngine())
  const init: any = definition.init(cast({ version: 4, id: 'fork-contract', createdAt: 0, isSeeded: true }), cast(3))
  assert.equal(init.inheritedEventCount, 3)
  assert.equal(
    definition.apply(init, cast(messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE))), init,
    'an inherited settlement must leave the child state reference untouched',
  )
  assert.equal(
    definition.apply(init, cast(headerEvent(1, PEAK, 'deepseek-v4-pro'))), init,
    'an inherited request header must not attribute the child (the state reference must not move)',
  )
  assert.equal(definition.apply(init, cast(headerEvent(2, PEAK, 'deepseek-v4-pro'))), init)

  const h = harness()
  h.addSession('s-fork', {
    inheritedEventCount: 2,
    events: [
      headerEvent(0, PEAK, 'deepseek-v4-pro'),
      messageEvent(1, PEAK, 'deepseek-flash', REAL_USAGE),
      messageEvent(2, PEAK, 'deepseek-flash', REAL_USAGE),
      headerEvent(3, PEAK, 'deepseek-flash'),
      attemptEvent(4, PEAK, [usageChunk(REAL_USAGE)]),
    ],
  })
  const { status, body } = await request(h, VIEW, 'session=s-fork&scope=self&detail=full')
  assert.equal(status, 200)
  assert.equal(body.total.calls, 2, 'only the two events at or after inheritedEventCount may bill')
  assert.equal(body.total.attempts, 2)
  assert.equal(body.total.money.cny, '0.00737968', 'the inherited prefix must contribute nothing')
  assert.equal(body.byModel.length, 1, `expected only the child's own model row, got ${JSON.stringify(body.byModel.map((row: any) => row.model))}`)
  assert.equal(body.byModel[0].model, 'deepseek-flash')
  assert.equal(body.sessionCount, 1)
  const state: any = h.registry.stateOf(h.session('s-fork'), PROJECTION_KEY)
  assert.equal(state.model, 'deepseek-flash', 'the inherited request header must not attribute the child (the child\'s own header must)')
  assert.equal(state.inheritedEventCount, 2)
  assertSplitIsExact(body, 'fork prefix')
})

/* ------------------------------------------------------------------ *
 * 3. Tree scope
 * ------------------------------------------------------------------ */

test('a 71-child subagent tree is summed in full: own + others === total and sessionCount === 72', async () => {
  const h = harness()
  const CHILDREN = 71
  h.addSession('tree-root', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  for (let index = 0; index < CHILDREN; index += 1) {
    const id = `tree-child-${String(index)}`
    h.addSession(id, { parentSession: 'tree-root', origin: 'subagent', events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
    h.append('tree-root', catalogEvent(index + 1, id))
  }
  const catalog = h.registry.snapshot(h.session('tree-root')).values.subagentCatalog as unknown[]
  assert.equal(catalog instanceof Array, true)
  assert.equal(catalog.length, CHILDREN, 'the fixture must publish all 71 direct children')

  const { status, body } = await request(h, VIEW, 'session=tree-root&scope=tree&detail=full')
  assert.equal(status, 200)
  assert.equal(body.sessionCount, 72, `every one of the 71 delegated sessions must be counted plus the root, got ${body.sessionCount}`)
  assert.equal(body.total.attempts, 72, 'the old 64-entry ledger cap must be gone: all 71 children settle')
  assert.equal(body.total.calls, 72)
  assert.equal(body.total.money.cny, '0.26566848', `72 identical calls must total exactly, got ${body.total.money.cny}`)
  assert.equal(body.own.money.cny, PEAK_CNY, 'own is the requested session alone')
  assert.equal(body.others.money.cny, '0.26197864', `the 71 delegated sessions must be exactly 71 calls, got ${body.others.money.cny}`)
  assert.equal(body.others.attempts, 71, 'no delegated session may be dropped from others')
  assert.ok(!body.coverage.issues.includes('scope-truncated'), 'nothing may be truncated at this size')
  assert.equal(body.coverage.failedSessions, 0)
  assert.equal(body.coverage.omittedSessions, 0)
  assert.equal(new Set(h.observeCalls).size, 72, `each of the 72 sessions must be observed, saw ${new Set(h.observeCalls).size}`)
  assert.equal(h.observeCalls.length, 72, 'one query must read each session exactly once')
  for (let index = 0; index < CHILDREN; index += 1) {
    assert.ok(h.observeCalls.includes(`tree-child-${String(index)}`), `child tree-child-${String(index)} must be part of the tree read`)
  }
  assert.equal(h.disposedObservations.length, 72, 'every observation lease must be released before the query returns')
  assertSplitIsExact(body, 'tree scope')
  assertNoNumbersLeaked(body, 'tree scope')
})

/* ------------------------------------------------------------------ *
 * 4. Team scope
 * ------------------------------------------------------------------ */

/** Lead + two teammates, one of which owns a delegated child session. */
function teamHarness(): Harness {
  const h = harness()
  h.addSession('team-lead', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  h.addSession('team-mate-a', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE), messageEvent(1, PEAK, 'deepseek-flash', REAL_USAGE)] })
  h.addSession('team-mate-b', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  h.addSession('team-b-child', { parentSession: 'team-mate-b', origin: 'subagent', events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  h.append('team-lead', teamMemberEvent(1, 'team-mate-a', 'mate-a'))
  h.append('team-lead', teamMemberEvent(2, 'team-mate-b', 'mate-b'))
  h.append('team-mate-b', catalogEvent(1, 'team-b-child'))
  for (const id of ['team-lead', 'team-mate-a', 'team-mate-b']) {
    h.agents.set(id, { id })
    h.memberships.set(id, { root: { id: 'team-lead' }, id: 'team-1', role: id === 'team-lead' ? 'lead' : 'teammate', name: id })
  }
  return h
}

test('a verified Team reports total/own/others with per-member attribution and no double counting', async () => {
  const h = teamHarness()
  const { status, body } = await request(h, VIEW, 'session=team-mate-a&scope=team&detail=full')
  assert.equal(status, 200)
  assertValidView(body, 'the verified Team view')
  assert.equal(body.scope, 'team')
  assert.equal(body.rootSessionId, 'team-lead')
  assert.equal(body.sessionCount, 4, 'lead, both teammates and the delegated child are four sessions')
  assert.equal(body.total.attempts, 5, 'each session is summed exactly once')
  assert.equal(body.total.money.cny, '0.0184492', `five identical calls must total exactly, got ${body.total.money.cny}`)
  assert.equal(body.own.calls, 2, 'own is the requesting teammate session')
  assert.equal(body.own.money.cny, '0.00737968')
  assert.equal(body.others.calls, 3, 'the Lead, the other teammate and its child')
  assert.equal(body.others.money.cny, '0.01106952')
  assertSplitIsExact(body, 'team scope')

  assert.equal(body.members.length, 3, 'the roster is the Lead plus two teammates')
  const lead = body.members.find((member: any) => member.sessionId === 'team-lead')
  const mateA = body.members.find((member: any) => member.sessionId === 'team-mate-a')
  const mateB = body.members.find((member: any) => member.sessionId === 'team-mate-b')
  assert.equal(lead.role, 'lead')
  assert.equal(mateA.role, 'teammate')
  assert.equal(mateB.role, 'teammate')
  assert.equal(lead.money.cny, PEAK_CNY, 'the Lead owns its own call')
  assert.equal(mateA.money.cny, '0.00737968', 'mate-a owns its two calls')
  assert.equal(mateA.ownMoney.cny, '0.00737968')
  assert.equal(mateB.money.cny, '0.00737968', 'mate-b owns its own call plus its delegated child')
  assert.equal(mateB.ownMoney.cny, PEAK_CNY, 'ownMoney is the member session itself, never its children')
  const attributed = body.members.reduce((sum: bigint, member: any) => sum + decimalToNano(member.money.cny), 0n)
  assert.equal(attributed, decimalToNano(body.total.money.cny), 'member attribution must reconstruct the Team total without double counting')
})

test('a teammate own share is the teammate itself, not the Lead', async () => {
  const h = teamHarness()
  const team = (await request(h, VIEW, 'session=team-mate-a&scope=team')).body
  const self = (await request(h, VIEW, 'session=team-mate-a&scope=self')).body
  assert.equal(team.scope, 'team')
  assert.equal(self.scope, 'self')
  assert.equal(self.total.attempts, 2, 'scope=self is the session alone')
  assert.equal(self.sessionCount, 1)
  assert.equal(team.own.money.cny, self.total.money.cny, 'own must equal the requesting session, not the Lead')
  assert.equal(team.own.attempts, self.total.attempts)
  assert.notEqual(team.own.money.cny, team.total.money.cny)

  const lead = (await request(h, VIEW, 'session=team-lead&scope=team')).body
  assert.equal(lead.scope, 'team', 'the Lead sees the same Team')
  assert.equal(lead.total.money.cny, team.total.money.cny)
  assert.equal(lead.own.money.cny, PEAK_CNY, 'the Lead own share is the Lead session only')

  const auto = (await request(h, VIEW, 'session=team-mate-a')).body
  assert.equal(auto.scope, 'team', 'scope=auto selects the verified Team')
  assert.equal(auto.total.money.cny, team.total.money.cny)
})

test('scope=team refuses an unverified Team instead of pretending to succeed', async () => {
  const h = harness()
  h.addSession('lonely-1', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  h.addSession('lonely-child', { parentSession: 'lonely-1', origin: 'subagent', events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  h.append('lonely-1', catalogEvent(1, 'lonely-child'))

  const refused = await request(h, VIEW, 'session=lonely-1&scope=team')
  assert.equal(refused.status, 400, 'an unverified Team must fail loudly')
  assert.deepEqual(refused.body, { ok: false, code: 'TEAM_UNAVAILABLE', message: 'Team membership could not be verified.' })
  assertNoPathLeak(refused.body, 'unverified team')

  const fallback = await request(h, VIEW, 'session=lonely-1')
  assert.equal(fallback.status, 200)
  assert.equal(fallback.body.scope, 'tree', 'without a Team the automatic scope stays a subtree')
  assert.equal(fallback.body.total.attempts, 2)
})

/* ------------------------------------------------------------------ *
 * 5. Concurrency
 * ------------------------------------------------------------------ */

test('concurrent identical requests share one read and one caller abort cannot affect the other', async () => {
  const h = harness()
  h.addSession('c-solo', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  h.holdReads()

  const first = startRequest(h, VIEW, 'session=c-solo&scope=self')
  const second = startRequest(h, VIEW, 'session=c-solo&scope=self')
  assert.equal(h.observeCalls.length, 1, 'both concurrent callers must share one underlying read')

  // The first response's socket closes while the read is still parked.
  first.res.close()
  h.releaseReads()
  const [aborted, survivor] = await Promise.all([first.done, second.done])
  assert.equal(aborted.status, 503, 'the cancelled caller must be told the query was cancelled')
  assert.equal(aborted.body.code, 'QUERY_CANCELLED')
  assert.equal(survivor.status, 200, 'the surviving caller must still get its answer')
  assertValidView(survivor.body, 'the surviving caller')
  assert.equal(survivor.body.total.money.cny, PEAK_CNY)
  assert.equal(survivor.body.total.attempts, 1)
  assert.equal(h.observeCalls.length, 1, 'cancelling one waiter must not restart or duplicate the shared read')

  const cached = await request(h, VIEW, 'session=c-solo&scope=self')
  assert.equal(cached.status, 200)
  assert.equal(cached.body.revision, survivor.body.revision)
  assert.equal(h.observeCalls.length, 1, 'the surviving result must have been published to the cache')
})

test('the query layer deduplicates a flight, shares one result reference and honours cancellation', async () => {
  let reads = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const source = cutSource(async () => {
    reads += 1
    await gate
    return ledgerFor(1)
  })
  const queries = new CostQueries(source)
  const first = queries.view({ sessionId: 'shared' })
  const second = queries.view({ sessionId: 'shared' })
  assert.equal(reads, 1, 'two concurrent requests for one key must trigger one source read')
  release?.()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a, b, 'both callers must receive the very same result value')
  assert.equal(a.total.money.cny, PEAK_CNY)

  const controller = new AbortController()
  controller.abort()
  const before = reads
  await assert.rejects(
    () => queries.view({ sessionId: 'shared-2', signal: controller.signal }),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    'a pre-aborted request must reject with AbortError',
  )
  assert.equal(reads, before, 'a pre-aborted request must not reach the source')
})

/* ------------------------------------------------------------------ *
 * 6. Cache and invalidation
 * ------------------------------------------------------------------ */

test('the cache serves repeats, is invalidated by the three cost keys, and ignores unrelated changes', async () => {
  const h = harness()
  h.addSession('cache-1', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  const first = await request(h, VIEW, 'session=cache-1&scope=self')
  assert.equal(first.status, 200)
  assert.equal(h.observeCalls.length, 1)

  const second = await request(h, VIEW, 'session=cache-1&scope=self')
  assert.equal(h.observeCalls.length, 1, 'a repeated request must be served from the cache')
  assert.equal(second.body.total.money.cny, first.body.total.money.cny)

  // An event the cost unit does not own changes no wire view: no invalidation.
  h.append('cache-1', { type: 'turn/start', seq: 1, time: PEAK, data: { turn: 1 } })
  await request(h, VIEW, 'session=cache-1&scope=self')
  assert.equal(h.observeCalls.length, 1, 'an unrelated event must not invalidate the cached view')

  // A settled call changes apiCost.
  h.append('cache-1', messageEvent(2, PEAK, 'deepseek-flash', REAL_USAGE))
  const afterApiCost = await request(h, VIEW, 'session=cache-1&scope=self')
  assert.equal(h.observeCalls.length, 2, "an 'apiCost' change must invalidate the cached view")
  assert.equal(afterApiCost.body.total.calls, 2)
  assert.equal(afterApiCost.body.total.money.cny, '0.00737968')

  // A catalog fact changes subagentCatalog only.
  h.append('cache-1', catalogEvent(3, 'cache-child'))
  await request(h, VIEW, 'session=cache-1&scope=self')
  assert.equal(h.observeCalls.length, 3, "a 'subagentCatalog' change must invalidate the cached view")

  // A roster fact changes agentTeam only.
  h.append('cache-1', teamMemberEvent(4, 'cache-mate', 'mate'))
  await request(h, VIEW, 'session=cache-1&scope=self')
  assert.equal(h.observeCalls.length, 4, "an 'agentTeam' change must invalidate the cached view")

  // A change on a different session must not invalidate this one.
  h.addSession('cache-other', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  h.append('cache-other', messageEvent(1, PEAK, 'deepseek-flash', REAL_USAGE))
  await request(h, VIEW, 'session=cache-1&scope=self')
  assert.equal(h.observeCalls.length, 4, 'another session changing must not invalidate an unrelated cached view')
})

test('a change to a delegated session invalidates the cached tree view that depended on it', async () => {
  const h = harness()
  h.addSession('dep-root', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  h.addSession('dep-child', { parentSession: 'dep-root', origin: 'subagent', events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  h.append('dep-root', catalogEvent(1, 'dep-child'))

  const first = await request(h, VIEW, 'session=dep-root&scope=tree')
  assert.equal(first.body.total.calls, 2)
  assert.equal(h.observeCalls.length, 2, 'the tree read covers root and child')

  h.append('dep-child', messageEvent(1, PEAK, 'deepseek-flash', REAL_USAGE))
  const second = await request(h, VIEW, 'session=dep-root&scope=tree')
  assert.equal(h.observeCalls.length, 4, 'a change in the child must invalidate the cached tree view')
  assert.equal(second.body.total.calls, 3, 'the refreshed view must include the new child settlement')
  assert.equal(second.body.total.money.cny, '0.01106952')
  assertSplitIsExact(second.body, 'invalidated tree view')
})

test('the result cache stays bounded at 64 entries and eviction never changes an answer', async () => {
  let clock = 1_000_000
  const reads: string[] = []
  const source = cutSource((id) => {
    reads.push(id)
    return ledgerFor(Number(id.slice('direct-'.length)) + 1)
  })
  const queries = new CostQueries(source, 'auto', () => clock)
  for (let index = 0; index < 70; index += 1) {
    const view = await queries.view({ sessionId: `direct-${String(index)}` })
    assert.equal(view.total.calls, index + 1, `session direct-${String(index)} must report its own call count`)
  }
  assert.ok(queries.stats.cached <= 64, `the cache must stay bounded, saw ${queries.stats.cached} entries`)
  assert.equal(queries.stats.cached, 64)

  const newest = await queries.view({ sessionId: 'direct-69' })
  assert.equal(reads.length, 70, 'the newest entry must still be a cache hit')
  assert.equal(newest.total.calls, 70)

  const evicted = await queries.view({ sessionId: 'direct-0' })
  assert.equal(reads.length, 71, 'an evicted entry must be re-read instead of served stale')
  assert.equal(evicted.total.calls, 1, 'an evicted entry must still produce the correct answer')

  clock += 2_501
  await queries.view({ sessionId: 'direct-69' })
  assert.equal(reads.length, 72, 'an expired entry must be re-read')

  const before = reads.length
  await queries.view({ sessionId: 'direct-69', force: true })
  assert.equal(reads.length, before + 1, 'force must bypass a fresh cache entry')
})

test('a view invalidated while it is still in flight is not published to the cache', async () => {
  let reads = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let hold = true
  const source = cutSource(async () => {
    reads += 1
    if (hold) await gate
    return ledgerFor(2)
  })
  const queries = new CostQueries(source)
  const pending = queries.view({ sessionId: 'live-1' })
  await Promise.resolve()
  queries.invalidate('live-1')
  hold = false
  release?.()
  const view = await pending
  assert.equal(view.total.calls, 2)
  const settled = reads
  await queries.view({ sessionId: 'live-1' })
  assert.equal(reads, settled + 1, 'a view invalidated before it settled must not be served from the cache')
})

/* ------------------------------------------------------------------ *
 * 7. HTTP surface
 * ------------------------------------------------------------------ */

test('GET /view answers 200 with an ETag and 304 on a matching If-None-Match', async () => {
  const h = harness()
  h.addSession('http-1', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  const first = await request(h, VIEW, 'session=http-1')
  assert.equal(first.status, 200)
  assert.equal(first.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(first.headers['x-content-type-options'], 'nosniff')
  const etag = first.headers.etag
  assert.equal(typeof etag, 'string', 'a 200 view must carry an ETag')
  assert.match(String(etag), /^"[0-9a-f]{24}:summary"$/, `the ETag must be the revision plus the detail, got ${String(etag)}`)
  assertValidView(first.body, 'the etag response')

  const cached = await request(h, VIEW, 'session=http-1', { headers: { 'if-none-match': String(etag) } })
  assert.equal(cached.status, 304, 'a matching If-None-Match must answer 304')
  assert.equal(cached.headers.etag, etag)
  assert.equal(cached.body, undefined, 'a 304 must carry no body')

  const stale = await request(h, VIEW, 'session=http-1', { headers: { 'if-none-match': '"deadbeef:summary"' } })
  assert.equal(stale.status, 200, 'a non-matching If-None-Match must answer the full body')

  const withDetail = await request(h, VIEW, 'session=http-1&detail=full')
  assert.notEqual(withDetail.headers.etag, etag, 'the ETag must distinguish summary from full')
  assert.equal(withDetail.body.byModel.length, 1)
  assert.equal(withDetail.body.recent.length, 1)
})

test('the view route rejects non-GET, cross-site, unknown parameters, bad scope/detail and a missing session', async () => {
  const h = harness()
  h.addSession('http-2', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })

  const post = await request(h, VIEW, 'session=http-2', { method: 'POST' })
  assert.equal(post.status, 405, 'a non-GET request must be refused')
  assert.equal(post.headers.allow, 'GET', 'the 405 must advertise the allowed method')
  assert.equal(post.body, undefined)

  const crossSite = await request(h, VIEW, 'session=http-2', { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.body.ok, false)
  assert.equal(crossSite.body.code, 'CROSS_SITE')
  assertNoPathLeak(crossSite.body, 'cross-site')

  const unknownParameter = await request(h, VIEW, 'session=http-2&tree=1')
  assert.equal(unknownParameter.status, 400)
  assert.deepEqual(Object.keys(unknownParameter.body).sort(), ['code', 'message', 'ok'])
  assert.equal(unknownParameter.body.ok, false)
  assert.equal(unknownParameter.body.code, 'INVALID_PARAMETER')
  assert.equal(typeof unknownParameter.body.message, 'string')

  const badScope = await request(h, VIEW, 'session=http-2&scope=corpus')
  assert.equal(badScope.status, 400)
  assert.equal(badScope.body.code, 'INVALID_SCOPE')

  const badDetail = await request(h, VIEW, 'session=http-2&detail=everything')
  assert.equal(badDetail.status, 400)
  assert.equal(badDetail.body.code, 'INVALID_DETAIL')

  const badForce = await request(h, VIEW, 'session=http-2&force=yes')
  assert.equal(badForce.status, 400)
  assert.equal(badForce.body.code, 'INVALID_FORCE')

  const noSession = await request(h, VIEW, 'scope=self')
  assert.equal(noSession.status, 400, 'a request without a session must be refused')
  assert.equal(noSession.body.code, 'INVALID_SESSION')

  const traversal = await request(h, VIEW, 'session=../../etc/passwd')
  assert.equal(traversal.status, 400, 'a path-shaped session id must be refused')
  assert.equal(traversal.body.code, 'INVALID_SESSION')
  assertNoPathLeak(traversal.body, 'invalid session')
})

test('an unknown session answers 404 and any other failure answers 503 without echoing internals', async () => {
  const h = harness()
  const missing = await request(h, VIEW, 'session=ghost-session')
  assert.equal(missing.status, 404, 'a session the query engine cannot find must answer 404')
  assert.deepEqual(missing.body, { ok: false, code: 'SESSION_NOT_FOUND', message: 'Session not found.' })
  assertNoPathLeak(missing.body, 'unknown session')

  // The real engine reports absence as a coded error; both published codes map to 404.
  h.addSession('broken-session', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  const notFound: any = new Error('SESSION_QUERY_SESSION_NOT_FOUND')
  notFound.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
  h.setReadError('broken-session', notFound)
  const coded = await request(h, VIEW, 'session=broken-session')
  assert.equal(coded.status, 404)
  assert.equal(coded.body.code, 'SESSION_NOT_FOUND')

  const leaking: any = new Error("ENOENT: no such file or directory, open 'C:\\Users\\nirvana\\.dsh\\logs\\secret.jsonl'")
  leaking.code = 'EIO'
  h.setReadError('broken-session', leaking)
  const failed = await request(h, VIEW, 'session=broken-session')
  assert.equal(failed.status, 503)
  assert.equal(failed.body.ok, false)
  assert.equal(failed.body.code, 'SESSION_UNAVAILABLE')
  assertNoPathLeak(failed.body, 'failed read')
  assert.equal(failed.body.message, 'Cost estimate is currently unavailable.')
})

test('GET /pricing returns the pricing view of the mounted engine', async () => {
  const h = harness()
  const { status, body } = await request(h, PRICING)
  assert.equal(status, 200)
  assert.ok(validPricingView(body), 'the pricing payload must satisfy the client wire validator')
  assert.equal(body.schemaVersion, 2)
  assert.equal(typeof body.now, 'number')
  assert.equal(typeof body.peak, 'boolean')
  assert.ok(body.rateCard['deepseek-flash'] && body.rateCard['deepseek-v4-pro'])
  assert.match(body.source, /api-docs\.deepseek\.com/)
  assertNoPathLeak(body, 'pricing')

  const post = await request(h, PRICING, '', { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(post.status, 403, 'the pricing route is guarded like the view route')
})

/* ------------------------------------------------------------------ *
 * 8. Tool and command
 * ------------------------------------------------------------------ */

test('the session_cost tool and the /cost command report the same scope and figures as HTTP', async () => {
  const h = teamHarness()
  const http = await request(h, VIEW, 'session=team-mate-a&detail=full')
  assert.equal(http.status, 200)
  const signal = new AbortController().signal

  const value = await h.tools[0].execute({}, { agent: { id: 'team-mate-a' }, signal })
  assert.equal(value.view.scope, http.body.scope, 'the tool must resolve the same scope as HTTP')
  assert.equal(value.view.rootSessionId, http.body.rootSessionId)
  assert.deepEqual(value.view.total, http.body.total, 'the tool must report the same totals as HTTP')
  assert.deepEqual(value.view.own, http.body.own)
  assert.deepEqual(value.view.others, http.body.others)
  assert.equal(value.view.sessionCount, http.body.sessionCount)
  assert.equal(value.text.includes(`¥${String(http.body.total.money.cny)}`), true, `the tool text must carry the total: ${value.text}`)
  const rendered = h.tools[0].output.render({}, value)
  assert.equal(rendered[0].type, 'text')
  assert.equal(rendered[0].text, value.text)

  const command = await h.commands[0].handler({ rawInput: '', agent: { id: 'team-mate-a' }, signal })
  assert.equal(command.kind, 'success')
  assert.equal(command.text.includes(`¥${String(http.body.total.money.cny)}`), true, `the command must carry the same total: ${command.text}`)
  assert.equal(command.text.includes(`¥${String(http.body.own.money.cny)}`), true, 'the command must carry the same own share')
  assert.equal(command.text.includes(`¥${String(http.body.others.money.cny)}`), true, 'the command must carry the same others share')
  assert.equal(command.text.includes('4 sessions'), true, `the command must report the same session count: ${command.text}`)

  // An explicit session id and scope must override the invoking agent.
  const explicit = await h.commands[0].handler({ rawInput: 'team-mate-b self', agent: { id: 'team-lead' }, signal })
  assert.equal(explicit.kind, 'success')
  assert.equal(explicit.text.includes(`¥0.00368984`), true, `explicit self scope must be the teammate alone: ${explicit.text}`)
})

test('the /cost command returns an error result for bad input and forwards its cancellation signal', async () => {
  const h = harness()
  h.addSession('cmd-1', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  const signal = new AbortController().signal

  const tooMany = await h.commands[0].handler({ rawInput: 'cmd-1 tree extra', agent: { id: 'cmd-1' }, signal })
  assert.equal(tooMany.kind, 'error', 'too many arguments must be an error result, not a thrown error')
  assert.equal(tooMany.text, 'Usage: /cost [sessionId] [auto|self|tree|team]')

  const badScope = await h.commands[0].handler({ rawInput: 'cmd-1 nonsense', agent: { id: 'cmd-1' }, signal })
  assert.equal(badScope.kind, 'error')
  assert.equal(badScope.text, 'Scope must be auto, self, tree or team.')

  // A cancelled invocation must settle as an error result and drop the pending read.
  h.holdReads()
  const controller = new AbortController()
  const pending = h.commands[0].handler({ rawInput: '', agent: { id: 'cmd-1' }, signal: controller.signal })
  controller.abort()
  h.releaseReads()
  const cancelled = await pending
  assert.equal(cancelled.kind, 'error', 'the command handler must observe the invocation signal')
  assert.equal(cancelled.text, 'Cost estimate unavailable.')

  await assert.rejects(
    () => h.tools[0].execute({ sessionId: 'ghost-tool' }, { agent: { id: 'cmd-1' }, signal }),
    (error: any) => error?.code === 'SESSION_QUERY_NOT_FOUND',
    'a missing session must reject the tool call rather than fabricate a view',
  )
})

test('the plugin survives a composition without tools or commands', async () => {
  const h = harness({ without: ['tools', 'commands'] })
  h.addSession('bare-1', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  assert.equal(h.tools.length, 0)
  assert.equal(h.commands.length, 0)
  const { status, body } = await request(h, VIEW, 'session=bare-1')
  assert.equal(status, 200, 'the HTTP surface must work without the tool and command seats')
  assert.equal(body.total.money.cny, PEAK_CNY)
})

test('a composition without the checkpoint cache still activates: cold recovery belongs to the query service', async () => {
  const h = harness({ without: ['sessionProjectionCache'] })
  h.addSession('no-cache-1', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  const { status, body } = await request(h, VIEW, 'session=no-cache-1')
  assert.equal(status, 200, 'the plugin must not require a service it never reads')
  assert.equal(body.total.money.cny, PEAK_CNY)
})

test('a composition without a webserver still meters through the tool and command seats', async () => {
  const h = harness({ without: ['webServer'] })
  h.addSession('no-http-1', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  assert.equal(h.routes.size, 0, 'no route is registered without a webserver')
  assert.equal(h.tools.length, 1, 'the tool is still registered')
  assert.equal(h.commands.length, 1, 'the command is still registered')
  const tool = h.tools[0] as { execute(args: unknown, exec: unknown): Promise<{ view: { total: { money: { cny: string } } } }> }
  const value = await tool.execute({ sessionId: 'no-http-1' }, { agent: { id: 'no-http-1' }, signal: new AbortController().signal })
  assert.equal(value.view.total.money.cny, PEAK_CNY)
})

/* ------------------------------------------------------------------ *
 * 9. Lifecycle
 * ------------------------------------------------------------------ */

test('every effect disposer is usable; disposal removes the routes, aborts in-flight work and answers 503', async () => {
  const h = harness()
  h.addSession('life-1', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  const healthy = await request(h, VIEW, 'session=life-1')
  assert.equal(healthy.status, 200)
  assert.equal(h.effectDisposers.length, 6, 'apply must expose a disposer per effect it registered')

  const viewHandler = h.routes.get(VIEW)
  assert.ok(viewHandler !== undefined, 'the view route must be registered before disposal')

  h.holdReads()
  const inflight = startRequest(h, VIEW, 'session=life-1&force=1')
  assert.equal(h.observeCalls.length, 2, 'the forced request must start a fresh read')

  h.dispose()
  assert.equal(h.routes.size, 0, 'disposing every effect must remove every route')

  h.releaseReads()
  const cancelled = await inflight.done
  assert.equal(cancelled.status, 503, 'an in-flight request must be aborted by disposal')
  assert.equal(cancelled.body.code, 'QUERY_CANCELLED')

  // A handler captured before disposal still runs: the query layer itself must refuse.
  const res = createResponse()
  await viewHandler({ method: 'GET', url: `${VIEW}?session=life-1`, headers: {} }, res)
  assert.equal(res.status, 503, 'after disposal the query layer must answer 503')
  assert.deepEqual(JSON.parse(res.body), { ok: false, code: 'PLUGIN_UNAVAILABLE', message: 'Cost service is not available.' })
  assertNoPathLeak(JSON.parse(res.body), 'disposed view')
})

test('CostQueries refuses to serve after dispose and rejects a bad scope or session id with a typed 400', async () => {
  const queries = new CostQueries(cutSource(() => ledgerFor(1)))
  assert.equal(parseScope(undefined), 'auto')
  assert.equal(parseScope('', 'tree'), 'tree')
  assert.equal(parseScope('team'), 'team')
  assert.throws(() => parseScope('corpus'), (error: unknown) => error instanceof QueryError && error.code === 'INVALID_SCOPE' && error.status === 400)
  assert.equal(validateSessionId('a-1.b:c_d'), 'a-1.b:c_d')
  assert.throws(() => validateSessionId(''), (error: unknown) => error instanceof QueryError && error.code === 'INVALID_SESSION')
  assert.throws(() => validateSessionId('../etc/passwd'), (error: unknown) => error instanceof QueryError && error.status === 400)
  const view = await queries.view({ sessionId: 'alive' })
  assert.equal(view.total.calls, 1)
  queries.dispose()
  await assert.rejects(
    () => queries.view({ sessionId: 'alive' }),
    (error: unknown) => error instanceof QueryError && error.code === 'PLUGIN_UNAVAILABLE' && error.status === 503,
    'a disposed plugin must answer QueryError(503)',
  )
})

test('the public error taxonomy never echoes internal failure detail', () => {
  assert.deepEqual(publicError(new QueryError('INVALID_SCOPE', 400, 'Scope must be auto, self, tree or team.')), {
    status: 400, body: { ok: false, code: 'INVALID_SCOPE', message: 'Scope must be auto, self, tree or team.' },
  })
  const missing: any = new Error('gone')
  missing.code = 'SESSION_QUERY_NOT_FOUND'
  assert.equal(publicError(missing).status, 404)
  const aborted = publicError(new DOMException('x', 'AbortError'))
  assert.equal(aborted.status, 503)
  assert.equal(aborted.body.code, 'QUERY_CANCELLED')
  const leaking: any = new Error("EACCES: permission denied, open 'C:\\Users\\nirvana\\.dsh\\cost.db'")
  leaking.code = 'EACCES'
  const mapped = publicError(leaking)
  assert.equal(mapped.status, 503)
  assert.equal(mapped.body.message, 'Cost estimate is currently unavailable.')
  assert.equal(mapped.body.message.includes('C:\\'), false)
})

/* ------------------------------------------------------------------ *
 * 10. Robustness
 * ------------------------------------------------------------------ */

test('fully malformed events never throw and never corrupt later billing', async () => {
  const definition = createCostProjection(createPricingEngine())
  const header: FakeHeader = { version: 4, id: 'malformed', createdAt: 0, isSeeded: false }
  let state = definition.init(cast(header), cast(0))
  const malformed: FakeEvent[] = [
    { type: 'assistant/message', seq: 0, time: PEAK, data: undefined },
    { type: 'assistant/message', seq: 1, time: PEAK, data: {} },
    { type: 'assistant/message', seq: 2, time: PEAK, data: { message: null, stream: null, usage: null } },
    { type: 'assistant/attempt', seq: 3, time: PEAK, data: { stream: 'not-an-array' } },
    { type: 'assistant/attempt', seq: 4, time: PEAK, data: { stream: 7 } },
    { type: 'assistant/message', seq: 5, time: PEAK, data: { message: { source: { model: 42 } }, stream: [], usage: REAL_USAGE } },
    { type: 'assistant/message', seq: 6, time: PEAK, data: { message: { source: { model: 'deepseek-flash' } }, stream: [] } },
    { type: 'request/header', seq: 7, time: PEAK, data: undefined },
    { type: 'request/header', seq: 8, time: PEAK, data: {} },
    { type: 'request/header', seq: 9, time: PEAK, data: { header: {} } },
    { type: 'request/header', seq: 10, time: PEAK, data: { header: { config: { model: {} } } } },
    { type: 'request/header', seq: 11, time: PEAK, data: { header: null, reason: 'initial' } },
    { type: 'assistant/message', seq: Number.NaN, time: PEAK, data: { usage: REAL_USAGE } },
    { type: 'assistant/message', seq: -3, time: PEAK, data: { usage: REAL_USAGE } },
    { type: 'assistant/message', seq: 12, time: Number.NaN, data: { usage: REAL_USAGE } },
    { type: 'assistant/message', seq: 13, time: PEAK, data: { message: { source: { model: 'deepseek-flash' } }, stream: [], usage: { inputTokens: Number.NaN, outputTokens: -1 } } },
  ]
  for (const event of malformed) {
    assert.doesNotThrow(() => { state = definition.apply(state, cast(event)) }, `apply must not throw for ${JSON.stringify(event)}`)
  }
  assert.doesNotThrow(() => definition.stateSchema.parse(state), 'malformed events must not produce state its own schema rejects')
  const view: any = definition.wire.view(state)
  assert.doesNotThrow(() => definition.wire.viewSchema.parse(view), 'malformed events must not produce a wire value its own schema rejects')
  // Exactly one malformed event carried usable accounting (a non-string model with a
  // valid report): it is counted as a call, priced at zero, and nothing else is.
  assert.equal(view.totals.calls, 1, `only the one event with usable usage may bill, got ${String(view.totals.calls)}`)
  assert.equal(view.totals.attempts, 8, 'every well-formed assistant settlement is still recorded as an attempt')
  assert.equal(view.totals.money.cny, '0', 'a non-string model must be unknown, never priced')
  assert.equal(view.totals.unpricedCalls, view.totals.attempts, 'every one of these settlements is unpriced')

  // The same barrage through the live composition must not disturb later billing.
  const h = harness()
  h.addSession('mal-1', { events: [] })
  for (const event of malformed) h.append('mal-1', event)
  h.append('mal-1', messageEvent(100, PEAK, 'deepseek-flash', REAL_USAGE))
  const { status, body } = await request(h, VIEW, 'session=mal-1&scope=self&detail=full')
  assert.equal(status, 200, 'a session full of malformed events must still answer')
  assert.equal(body.total.calls, 2, 'the one usable malformed settlement and the following legitimate call')
  assert.equal(body.total.money.cny, PEAK_CNY, `only the legitimate call is priced, got ${body.total.money.cny}`)
  assert.equal(body.total.tokens.total, '22498', 'both usable token reports are counted, the malformed ones contribute nothing')
  assertSplitIsExact(body, 'malformed-event session')
  assertNoNumbersLeaked(body, 'malformed events')
})

/* ------------------------------------------------------------------ *
 * 11. Projection contract
 * ------------------------------------------------------------------ */

test('the apiCost projection satisfies the DSH projection contract', () => {
  const engine = createPricingEngine()
  const definition = createCostProjection(engine)
  assert.equal(definition.key, PROJECTION_KEY)
  assert.equal(PROJECTION_KEY, 'apiCost')
  assert.ok(Number.isSafeInteger(definition.stateVersion) && definition.stateVersion > 0, `stateVersion must be a positive safe integer, got ${String(definition.stateVersion)}`)

  const header: FakeHeader = { version: 4, id: 'contract', createdAt: 0, isSeeded: false }
  const init: any = definition.init(cast(header), cast(0))
  assert.doesNotThrow(() => definition.stateSchema.parse(init), 'init state must satisfy stateSchema')
  assert.equal(init.inheritedEventCount, 0)
  assert.equal(init.view.totals.calls, 0)

  const unrelated: FakeEvent = { type: 'turn/start', seq: 0, time: PEAK, data: { turn: 1 } }
  assert.equal(definition.apply(init, cast(unrelated)), init, 'an unrelated event must reuse the state reference')
  assert.equal(definition.apply(init, cast({ type: 'tool/result', seq: 1, time: PEAK, data: {} })), init)
  assert.equal(definition.apply(init, cast({ type: 'session/end-seed', seq: 2, time: PEAK, data: {} })), init)
  assert.equal(definition.apply(init, cast(headerEvent(3, PEAK, ''))), init, 'a request header repeating the current model must reuse the state')

  const priced: any = definition.apply(init, cast(messageEvent(4, PEAK, 'deepseek-flash', REAL_USAGE)))
  assert.notEqual(priced, init)
  assert.doesNotThrow(() => definition.stateSchema.parse(priced))
  const wire = definition.wire.view(priced)
  assert.doesNotThrow(() => definition.wire.viewSchema.parse(wire), 'the wire value must pass the unit wire schema')
  assert.equal(wire.totals.money.cny, PEAK_CNY)
  assert.equal(definition.wire.view(definition.apply(priced, cast(unrelated))), wire, 'an unrelated event must not republish the view')

  const other = createCostProjection(createPricingEngine({ 2027: { holidays: ['2027-01-01'] } }))
  const same = createCostProjection(createPricingEngine({ 2027: { holidays: ['2027-01-01'] } }))
  assert.notEqual(other.stateVersion, definition.stateVersion, 'a different holiday calendar must change stateVersion')
  assert.equal(same.stateVersion, other.stateVersion, 'the same configuration must produce a stable stateVersion')
  assert.equal(definition.stateSchema.safeParse(other.init(cast(header), cast(0))).success, false, 'a persisted state from another configuration must be rejected')
  assert.equal(definition.stateSchema.safeParse({ ...init, inheritedEventCount: -1 }).success, false, 'a negative inherited prefix must be rejected')
})

/* ------------------------------------------------------------------ *
 * 12. Decimal exactness
 * ------------------------------------------------------------------ */

test('money accumulates exactly as decimal strings, without floating-point drift', async () => {
  const h = harness()
  const events: FakeEvent[] = []
  for (let index = 0; index < 7; index += 1) {
    // V4 Pro at peak, cache hit: CNY 0.3 and USD 0.044 per million tokens.
    events.push(messageEvent(index, PRE_DISPUTE_PEAK, 'deepseek-v4-pro', { cacheReadTokens: 1 }))
  }
  h.addSession('precise-1', { events })
  const { body } = await request(h, VIEW, 'session=precise-1&detail=full')
  assert.equal(body.total.calls, 7)
  assert.equal(typeof body.total.money.cny, 'string', 'money must be transported as a decimal string')
  assert.equal(body.total.money.cny, '0.0000021', `7 x 0.3 per million tokens must be exact, got ${body.total.money.cny}`)
  assert.equal(body.total.money.usd, '0.000000308', `7 x 0.044 per million tokens must be exact, got ${body.total.money.usd}`)
  assert.equal(body.total.periods.peak.cny, '0.0000021')
  assert.equal(body.total.periods.offPeak.cny, '0')
  assertTotalsWellFormed(body.total, 'precision')
  // The point of the string accumulation: float arithmetic does not produce this value.
  assert.notEqual(String((0.044 / 1_000_000) * 7), '0.000000308', 'the exact expectation must be one float arithmetic cannot produce')

  // A single 9-digit residue must survive a long accumulation unchanged.
  const many: FakeEvent[] = []
  for (let index = 0; index < 500; index += 1) many.push(messageEvent(index, PRE_DISPUTE_PEAK, 'deepseek-v4-pro', { cacheReadTokens: 1 }))
  h.addSession('precise-2', { events: many })
  const bulk = (await request(h, VIEW, 'session=precise-2')).body
  assert.equal(bulk.total.money.cny, '0.00015', `500 x 0.3 per million tokens must be exact, got ${bulk.total.money.cny}`)
  assert.equal(decimalToNano(bulk.total.money.cny), 150_000n)
})

/* ------------------------------------------------------------------ *
 * 12. Traversal budget
 * ------------------------------------------------------------------ */

test('a traversal past the 400-session budget is reported as truncated, never silently dropped', async () => {
  const h = harness()
  const WIDE = 420
  h.addSession('wide-root', { events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
  for (let index = 0; index < WIDE; index += 1) {
    const id = `wide-${index}`
    h.addSession(id, { parentSession: 'wide-root', origin: 'subagent', events: [messageEvent(0, PEAK, 'deepseek-flash', REAL_USAGE)] })
    h.append('wide-root', catalogEvent(index + 1, id))
  }
  const { status, body } = await request(h, VIEW, 'session=wide-root&scope=tree')
  assert.equal(status, 200)
  assert.equal(body.coverage.status, 'partial', 'a truncated scope is never presented as complete')
  assert.ok(body.coverage.issues.includes('scope-truncated'), 'the truncation is named')
  assert.ok(body.coverage.omittedSessions > 0, 'the omitted count is reported')
  assert.ok(body.sessionCount <= 400, `the budget holds, got ${body.sessionCount}`)
  assert.equal(decimalToNano(body.own.money.cny) > 0n, true, 'the requested session is still metered')
  assert.ok(body.others.money.cny !== undefined)
})
