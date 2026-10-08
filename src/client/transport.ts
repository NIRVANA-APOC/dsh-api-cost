import type { CostView, Coverage, IssueCode, LedgerView, ModelBreakdown, Money, PricingView, RecentCall, Scope, Totals } from '../shared/contracts.ts'
import { isMoneyString, isTokenString } from '../shared/format.ts'

export type Detail = 'summary' | 'full'
export interface HttpResponse { readonly ok: boolean; readonly status: number; json(): Promise<unknown> }
export type Fetcher = (url: string, options: RequestInit) => Promise<HttpResponse>

const issues: ReadonlySet<string> = new Set<IssueCode>([
  'unknown-model', 'invalid-usage', 'missing-usage', 'holiday-data-missing', 'before-rate-card',
  'routing-disputed', 'session-unavailable', 'scope-unavailable', 'scope-truncated',
])
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const text = (v: unknown): v is string => typeof v === 'string'
const issueList = (v: unknown): boolean => Array.isArray(v) && v.every((x: unknown) => typeof x === 'string' && issues.has(x))
const money = (v: unknown): v is Money => record(v) && isMoneyString(v.cny) && isMoneyString(v.usd)
const tokens = (v: unknown): boolean => record(v) && ['cacheHit', 'cacheMiss', 'output', 'reasoning', 'total'].every(k => isTokenString(v[k]))
export const validCoverage = (v: unknown): v is Coverage => record(v)
  && (v.status === 'complete' || v.status === 'partial' || v.status === 'unavailable')
  && issueList(v.issues) && count(v.failedSessions) && count(v.omittedSessions)
export const validTotals = (v: unknown): v is Totals => record(v)
  && count(v.calls) && count(v.attempts) && count(v.unpricedCalls) && money(v.money) && tokens(v.tokens)
  && record(v.periods) && money(v.periods.peak) && money(v.periods.offPeak)
const models = (v: unknown): v is readonly ModelBreakdown[] => Array.isArray(v) && v.every((x: unknown) => record(x)
  && (x.model === 'deepseek-flash' || x.model === 'deepseek-v4-pro' || x.model === 'unknown') && validTotals(x.totals))
const recent = (v: unknown): v is readonly RecentCall[] => Array.isArray(v) && v.every((x: unknown) => record(x)
  && count(x.seq) && time(x.at) && text(x.model) && (x.kind === 'message' || x.kind === 'interrupted' || x.kind === 'attempt')
  && money(x.money) && tokens(x.tokens) && typeof x.peak === 'boolean' && issueList(x.issues))

export function validLedger(v: unknown): v is LedgerView {
  return record(v) && text(v.revision) && validTotals(v.totals) && models(v.byModel) && recent(v.recent) && validCoverage(v.coverage)
}
export function validCostView(v: unknown): v is CostView {
  return record(v) && v.schemaVersion === 2 && text(v.sessionId) && text(v.rootSessionId)
    && (v.scope === 'self' || v.scope === 'tree' || v.scope === 'team') && text(v.revision)
    && validTotals(v.total) && validTotals(v.own) && validTotals(v.others) && validCoverage(v.coverage) && count(v.sessionCount)
    && (!('byModel' in v) || models(v.byModel)) && (!('recent' in v) || recent(v.recent))
    && (!('members' in v) || (Array.isArray(v.members) && v.members.every((x: unknown) => record(x)
      && text(x.sessionId) && text(x.name) && (x.role === 'lead' || x.role === 'teammate' || x.role === 'session')
      && money(x.money) && money(x.ownMoney))))
}
function rates(v: unknown): boolean {
  return record(v) && isMoneyString(v.cacheHit) && isMoneyString(v.cacheMiss) && isMoneyString(v.output)
}
export function validPricingView(v: unknown): v is PricingView {
  if (!record(v) || v.schemaVersion !== 2 || !text(v.revision) || !time(v.now) || !time(v.validUntil)
    || v.validUntil <= v.now || typeof v.peak !== 'boolean' || !text(v.reason) || !issueList(v.issues)
    || !text(v.source) || !text(v.effectiveFrom) || !record(v.rateCard)) return false
  if (v.next !== null && !(record(v.next) && time(v.next.at) && typeof v.next.peak === 'boolean')) return false
  const card = v.rateCard
  if (!record(card)) return false
  return ['deepseek-flash', 'deepseek-v4-pro'].every(key => {
    const model = card[key]
    return record(model) && text(model.label) && record(model.peak) && record(model.offPeak)
      && rates(model.peak.cny) && rates(model.peak.usd) && rates(model.offPeak.cny) && rates(model.offPeak.usd)
  })
}

/** GET-only v2 transport: no billing, replay, reconcile, or legacy DTO adapters. */
export class CostTransport {
  private readonly fetcher: Fetcher
  constructor(fetcher: Fetcher = globalThis.fetch.bind(globalThis)) { this.fetcher = fetcher }
  private async get(url: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(url, { method: 'GET', headers: { accept: 'application/json' }, signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }
  async view(sessionId: string, scope: Scope, detail: Detail, signal: AbortSignal): Promise<CostView> {
    const query = new URLSearchParams({ session: sessionId, scope, detail })
    const body = await this.get('/dsh-api-cost/v2/view?' + query.toString(), signal)
    if (!validCostView(body) || body.sessionId !== sessionId || (scope !== 'auto' && body.scope !== scope)) {
      throw new Error('Malformed cost view')
    }
    return body
  }
  async pricing(signal: AbortSignal): Promise<PricingView> {
    const body = await this.get('/dsh-api-cost/v2/pricing', signal)
    if (!validPricingView(body)) throw new Error('Malformed pricing view')
    return body
  }
}
