import { createHash } from 'node:crypto'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { TeamProjection } from '@deepseek-ai/dsh-experimental-agent-team'
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent'
import type { CostView, Coverage, EffectiveScope, IssueCode, LedgerView, MemberView, ModelBreakdown, Scope, Totals } from '../shared/contracts.ts'
import { addMoney, addTotals, zeroMoney, zeroTotals } from './projection.ts'

export class QueryError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status: number, message: string) { super(message); this.name = 'QueryError'; this.code = code; this.status = status }
}
export interface CostCut {
  readonly header: Pick<SessionHeader, 'id' | 'parentSession' | 'origin'>
  readonly ledger: LedgerView
  readonly catalog: readonly SubagentCatalogEntry[] | undefined
  readonly team: TeamProjection | undefined
}
export interface QuerySource {
  /** The adapter owns and releases each native observation before returning. */
  read(id: string, signal: AbortSignal): Promise<CostCut>
  membershipRoot?(id: string): string | undefined
}
export interface ViewRequest { readonly sessionId: string; readonly scope?: Scope; readonly detail?: 'summary' | 'full'; readonly force?: boolean; readonly signal?: AbortSignal }
interface CacheEntry { readonly value: CostView; readonly expires: number; readonly dependencies: ReadonlySet<string> }
interface Flight { readonly controller: AbortController; readonly dependencies: Set<string>; promise: Promise<CostView>; waiters: number; settled: boolean; dirty: boolean }

export function validateSessionId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new QueryError('INVALID_SESSION', 400, 'A valid session id is required.')
  return value
}
export function parseScope(value: unknown, fallback: Scope = 'auto'): Scope {
  if (value === undefined || value === null || value === '') return fallback
  if (value === 'auto' || value === 'self' || value === 'tree' || value === 'team') return value
  throw new QueryError('INVALID_SCOPE', 400, 'Scope must be auto, self, tree or team.')
}
function aborted(): never { throw new DOMException('Request cancelled', 'AbortError') }

/** Only bounded result caches. The host owns log restoration and projection state. */
export class CostQueries {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly flights = new Map<string, Flight>()
  private readonly dependents = new Map<string, Set<string>>()
  private disposed = false
  private readonly source: QuerySource
  private readonly defaultScope: Scope
  private readonly now: () => number
  constructor(source: QuerySource, defaultScope: Scope = 'auto', now: () => number = Date.now) {
    this.source = source
    this.defaultScope = defaultScope
    this.now = now
  }

  invalidate(sessionId: string): void {
    for (const key of [...this.dependents.get(sessionId) ?? []]) this.removeCache(key)
    for (const flight of this.flights.values()) if (flight.dependencies.has(sessionId)) flight.dirty = true
  }
  dispose(): void {
    this.disposed = true
    for (const flight of this.flights.values()) flight.controller.abort()
    this.cache.clear(); this.dependents.clear()
  }
  get stats(): { cached: number; flights: number; dependencySessions: number } { return { cached: this.cache.size, flights: this.flights.size, dependencySessions: this.dependents.size } }

  async view(request: ViewRequest): Promise<CostView> {
    if (this.disposed) throw new QueryError('PLUGIN_UNAVAILABLE', 503, 'Cost service is not available.')
    if (request.signal?.aborted) aborted()
    const id = validateSessionId(request.sessionId)
    const scope = parseScope(request.scope, this.defaultScope), detail = request.detail ?? 'summary'
    const key = id + ':' + scope + ':' + detail
    const cached = this.cache.get(key)
    if (!request.force && cached && cached.expires > this.now()) {
      this.cache.delete(key); this.cache.set(key, cached)
      return cached.value
    }
    let flight = this.flights.get(key)
    if (!flight) {
      if (this.flights.size >= 64) throw new QueryError('QUERY_LIMIT', 429, 'Too many simultaneous cost queries.')
      const created: Flight = { controller: new AbortController(), dependencies: new Set(), promise: Promise.resolve(undefined as never), waiters: 0, settled: false, dirty: false }
      this.flights.set(key, created)
      created.promise = this.compute(id, scope, detail, created).then(value => {
        if (!this.disposed && !created.controller.signal.aborted && !created.dirty) this.store(key, value, created.dependencies)
        return value
      }).finally(() => { created.settled = true; if (this.flights.get(key) === created) this.flights.delete(key) })
      // A cancelled last waiter must not leave an unhandled rejection behind.
      void created.promise.catch(() => {})
      flight = created
    }
    const shared = flight
    shared.waiters++
    return new Promise<CostView>((resolve, reject) => {
      let finished = false
      const finish = (error: unknown, value?: CostView): void => {
        if (finished) return
        finished = true
        request.signal?.removeEventListener('abort', onAbort)
        shared.waiters--
        if (shared.waiters === 0 && !shared.settled) shared.controller.abort()
        if (error !== undefined) reject(error)
        else if (value !== undefined) resolve(value)
      }
      const onAbort = (): void => finish(new DOMException('Request cancelled', 'AbortError'))
      request.signal?.addEventListener('abort', onAbort, { once: true })
      if (request.signal?.aborted) onAbort()
      void shared.promise.then(value => finish(undefined, value), error => finish(error))
    })
  }
  private removeCache(key: string): void {
    const old = this.cache.get(key)
    if (!old) return
    for (const id of old.dependencies) {
      const keys = this.dependents.get(id); keys?.delete(key)
      if (keys?.size === 0) this.dependents.delete(id)
    }
    this.cache.delete(key)
  }
  private store(key: string, value: CostView, dependencies: ReadonlySet<string>): void {
    this.removeCache(key)
    while (this.cache.size >= 64) { const oldest = this.cache.keys().next().value; if (oldest === undefined) break; this.removeCache(oldest) }
    const ids = new Set(dependencies)
    this.cache.set(key, { value, expires: this.now() + 2500, dependencies: ids })
    for (const id of ids) { let keys = this.dependents.get(id); if (!keys) { keys = new Set(); this.dependents.set(id, keys) }; keys.add(key) }
  }
  private async compute(id: string, requested: Scope, detail: 'summary' | 'full', flight: Flight): Promise<CostView> {
    const signal = flight.controller.signal
    const cuts = new Map<string, CostCut>(), pending = new Map<string, Promise<CostCut>>()
    const read = (target: string): Promise<CostCut> => {
      if (signal.aborted) return Promise.reject(new DOMException('Request cancelled', 'AbortError'))
      flight.dependencies.add(target)
      const cached = cuts.get(target); if (cached) return Promise.resolve(cached)
      const existing = pending.get(target); if (existing) return existing
      const pass = this.source.read(target, signal).then(cut => { cuts.set(target, cut); return cut })
      pending.set(target, pass)
      return pass
    }
    const ownCut = await read(id)
    let rootId = id, scope: EffectiveScope = requested === 'self' ? 'self' : 'tree'
    const issues = new Set<IssueCode>(), failures = new Set<string>()
    let roster: TeamProjection | undefined
    if (requested === 'team' || requested === 'auto') {
      const liveRoot = this.source.membershipRoot?.(id)
      const candidate = liveRoot ?? (ownCut.header.origin === 'subagent' ? ownCut.header.parentSession : id)
      if (candidate !== undefined) {
        try {
          const teamCut = await read(candidate)
          const team = teamCut.team
          if (team?.failure !== undefined) issues.add('scope-unavailable')
          // The agentTeam view always synthesizes the projected session's own Lead
          // row, so a roster naming nobody but that session is not a Team: an
          // unverified team scope must fail loudly instead of reporting a Team of one.
          if (team !== undefined && team.failure === undefined && team.members.length > 1 && team.members.some(member => member.id === id)) {
            rootId = candidate; scope = 'team'; roster = team
          }
        } catch (error) {
          if (signal.aborted) throw error
          issues.add('scope-unavailable')
        }
      }
      if (requested === 'team' && scope !== 'team') throw new QueryError('TEAM_UNAVAILABLE', 400, 'Team membership could not be verified.')
    }
    const targets = new Set<string>([rootId, id])
    const parents = new Map<string, string>()
    if (scope !== 'self' && roster) for (const member of roster.members) {
      if (member.phase === 'failed') continue
      targets.add(member.id)
      if (member.id !== rootId) parents.set(member.id, rootId)
    }
    let omitted = 0
    // A bounded breadth-first catalog walk combines metadata and cost in ONE observation per node.
    const queue = [...targets]
    if (queue.length > 400) { omitted += queue.length - 400; queue.length = 400; issues.add('scope-truncated') }
    targets.clear(); for (const target of queue) targets.add(target)
    for (let offset = 0; offset < queue.length;) {
      if (signal.aborted) aborted()
      const batch = queue.slice(offset, offset + 2)
      offset += batch.length
      const observed = await Promise.all(batch.map(async target => {
        try { return { target, cut: await read(target) } }
        catch (error) { if (signal.aborted) throw error; failures.add(target); issues.add('session-unavailable'); return { target, cut: undefined } }
      }))
      for (const { target, cut } of observed) {
        if (!cut || scope === 'self') continue
        if (cut.catalog === undefined) { issues.add('scope-unavailable'); continue }
        for (const child of cut.catalog) {
          if (targets.has(child.id)) continue
          if (queue.length >= 400) { omitted++; issues.add('scope-truncated'); continue }
          targets.add(child.id); parents.set(child.id, target); queue.push(child.id)
        }
      }
    }
    // The requested Session must never be displaced by the traversal budget.
    if (!targets.has(id)) { targets.add(id); issues.add('scope-truncated') }
    let total = zeroTotals()
    const byModel = new Map<string, ModelBreakdown>()
    for (const target of targets) {
      const cut = cuts.get(target)
      if (!cut) continue
      total = addTotals(total, cut.ledger.totals)
      for (const issue of cut.ledger.coverage.issues) issues.add(issue)
      for (const model of cut.ledger.byModel) byModel.set(model.model, { model: model.model, totals: addTotals(byModel.get(model.model)?.totals ?? zeroTotals(), model.totals) })
    }
    const own = ownCut.ledger.totals
    const coverage: Coverage = { status: issues.size ? 'partial' : 'complete', issues: [...issues].sort(), failedSessions: failures.size, omittedSessions: omitted }
    const revision = createHash('sha256').update(JSON.stringify([id, scope, rootId, [...targets].map(target => [target, cuts.get(target)?.ledger.revision ?? 'unavailable']), roster?.members, coverage])).digest('hex').slice(0, 24)
    const view: CostView = { schemaVersion: 2, sessionId: id, rootSessionId: rootId, scope, revision, total, own, others: addTotals(total, own, -1), coverage, sessionCount: [...targets].filter(target => cuts.has(target)).length }
    if (detail === 'summary') return view
    const memberRows = new Map<string, MemberView>()
    for (const member of roster?.members ?? []) memberRows.set(member.id, { sessionId: member.id, name: member.name.slice(0, 120), role: member.role, money: zeroMoney(), ownMoney: cuts.get(member.id)?.ledger.totals.money ?? zeroMoney() })
    for (const target of targets) {
      const cut = cuts.get(target); if (!cut) continue
      let owner = target
      const visited = new Set<string>()
      while (roster && !memberRows.has(owner) && !visited.has(owner)) { visited.add(owner); const parent = parents.get(owner); if (parent === undefined) break; owner = parent }
      const member = memberRows.get(owner)
      if (member) memberRows.set(owner, { ...member, money: addMoney(member.money, cut.ledger.totals.money) })
    }
    return { ...view, byModel: [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model)), recent: ownCut.ledger.recent, members: [...memberRows.values()] }
  }
}
