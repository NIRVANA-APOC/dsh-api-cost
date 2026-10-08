import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { PricingEngine, PricedUsage } from '../pricing/index.ts'
import { decimalToNano, nanoToDecimal } from '../pricing/index.ts'
import { PROJECTION_KEY } from '../shared/contracts.ts'
import type { Coverage, IssueCode, LedgerView, ModelBreakdown, Money, Tokens, Totals } from '../shared/contracts.ts'

export interface LedgerState {
  readonly fingerprint: string
  readonly inheritedEventCount: number
  readonly model: string
  readonly view: LedgerView
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { apiCost: LedgerView }
  interface SessionProjectionStateMap { apiCost: LedgerState }
}

const integer = z.string().regex(/^(0|[1-9]\d*)$/)
const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,9})?$/)
const moneySchema = z.object({ cny: decimal, usd: decimal })
const tokensSchema = z.object({ cacheHit: integer, cacheMiss: integer, output: integer, reasoning: integer, total: integer })
const issueSchema = z.enum(['unknown-model', 'invalid-usage', 'missing-usage', 'holiday-data-missing', 'before-rate-card', 'routing-disputed', 'session-unavailable', 'scope-unavailable', 'scope-truncated'])
const totalsSchema = z.object({ calls: z.number().int().nonnegative(), attempts: z.number().int().nonnegative(), unpricedCalls: z.number().int().nonnegative(), money: moneySchema, tokens: tokensSchema, periods: z.object({ peak: moneySchema, offPeak: moneySchema }) })
export const ledgerViewSchema: z.ZodType<LedgerView> = z.object({
  revision: z.string(), totals: totalsSchema,
  byModel: z.array(z.object({ model: z.enum(['deepseek-flash', 'deepseek-v4-pro', 'unknown']), totals: totalsSchema })).max(3),
  recent: z.array(z.object({ seq: z.number().int().nonnegative(), at: z.number().int().nonnegative(), model: z.string().max(96), kind: z.enum(['message', 'interrupted', 'attempt']), money: moneySchema, tokens: tokensSchema, peak: z.boolean(), issues: z.array(issueSchema).max(9) })).max(20),
  coverage: z.object({ status: z.enum(['complete', 'partial', 'unavailable']), issues: z.array(issueSchema).max(9), failedSessions: z.number().int().nonnegative(), omittedSessions: z.number().int().nonnegative() }),
})

export function zeroMoney(): Money { return { cny: '0', usd: '0' } }
export function zeroTotals(): Totals {
  return { calls: 0, attempts: 0, unpricedCalls: 0, money: zeroMoney(), tokens: { cacheHit: '0', cacheMiss: '0', output: '0', reasoning: '0', total: '0' }, periods: { peak: zeroMoney(), offPeak: zeroMoney() } }
}
export function addMoney(a: Money, b: Money, sign: 1 | -1 = 1): Money {
  const cny = decimalToNano(a.cny) + BigInt(sign) * decimalToNano(b.cny)
  const usd = decimalToNano(a.usd) + BigInt(sign) * decimalToNano(b.usd)
  if (cny < 0n || usd < 0n) throw new Error('Negative cost balance')
  return { cny: nanoToDecimal(cny), usd: nanoToDecimal(usd) }
}
export function addTotals(a: Totals, b: Totals, sign: 1 | -1 = 1): Totals {
  const token = (key: keyof Tokens): string => {
    const value = BigInt(a.tokens[key]) + BigInt(sign) * BigInt(b.tokens[key])
    if (value < 0n) throw new Error('Negative token balance')
    return String(value)
  }
  return {
    calls: a.calls + sign * b.calls, attempts: a.attempts + sign * b.attempts, unpricedCalls: a.unpricedCalls + sign * b.unpricedCalls,
    money: addMoney(a.money, b.money, sign),
    tokens: { cacheHit: token('cacheHit'), cacheMiss: token('cacheMiss'), output: token('output'), reasoning: token('reasoning'), total: token('total') },
    periods: { peak: addMoney(a.periods.peak, b.periods.peak, sign), offPeak: addMoney(a.periods.offPeak, b.periods.offPeak, sign) },
  }
}
export function completeCoverage(): Coverage { return { status: 'complete', issues: [], failedSessions: 0, omittedSessions: 0 } }
export function emptyLedgerView(revision = 'empty'): LedgerView { return { revision, totals: zeroTotals(), byModel: [], recent: [], coverage: completeCoverage() } }
function contribution(priced: PricedUsage, hasUsage: boolean): Totals {
  const invalid = priced.issues.includes('invalid-usage')
  // A report the engine rejected is not accounting: pricing its surviving fields
  // would invent spend the ledger cannot explain (calls stays 0 either way).
  const money = invalid ? zeroMoney() : { cny: nanoToDecimal(priced.moneyNano.cny), usd: nanoToDecimal(priced.moneyNano.usd) }
  const tokens: Tokens = invalid
    ? { cacheHit: '0', cacheMiss: '0', output: '0', reasoning: '0', total: '0' }
    : { cacheHit: String(priced.tokens.cacheHit), cacheMiss: String(priced.tokens.cacheMiss), output: String(priced.tokens.output), reasoning: String(priced.tokens.reasoning), total: String(priced.tokens.total) }
  const unpriced = !hasUsage || invalid || priced.issues.includes('unknown-model')
  return {
    calls: hasUsage && !invalid ? 1 : 0, attempts: 1, unpricedCalls: unpriced ? 1 : 0,
    money, tokens,
    periods: { peak: priced.peak ? money : zeroMoney(), offPeak: priced.peak ? zeroMoney() : money },
  }
}

/** A damaged log record must never throw out of the fold; it is simply not folded. */
function safeSeq(event: unknown): number | undefined {
  const seq = (event as { seq?: unknown } | null | undefined)?.seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
}
function safeTime(event: unknown): number | undefined {
  const time = (event as { time?: unknown } | null | undefined)?.time
  return typeof time === 'number' && Number.isSafeInteger(time) && time >= 0 ? time : undefined
}
/** The last usage record of an embedded attempt stream, when there is a stream at all. */
function lastStreamUsage(stream: unknown): unknown {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index] as { readonly type?: unknown, readonly chunk?: { readonly type?: unknown, readonly usage?: unknown } } | undefined
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/** Stateless pure fold; durable seq watermarks and history recovery belong to DSH. */
export type CostProjectionDefinition = Omit<ProjectionDefinition<'apiCost'>, 'wire'> & { wire: NonNullable<ProjectionDefinition<'apiCost'>['wire']> }
export function createCostProjection(engine: PricingEngine): CostProjectionDefinition {
  const fingerprint = createHash('sha256').update('apiCost/fold/2\n' + engine.fingerprint).digest('hex')
  const stateVersion = Number.parseInt(fingerprint.slice(0, 13), 16)
  const stateSchema: z.ZodType<LedgerState> = z.object({ fingerprint: z.literal(fingerprint), inheritedEventCount: z.number().int().nonnegative(), model: z.string().max(96), view: ledgerViewSchema })
  return {
    key: PROJECTION_KEY, stateVersion, stateSchema,
    init(_header, inheritedEventCount) {
      return { fingerprint, inheritedEventCount, model: '', view: emptyLedgerView(fingerprint + ':empty') }
    },
    apply(state, event: SessionEvent) {
      // Durable logs can carry damaged records; the fold ignores what it cannot read
      // rather than throwing into the framework's drive loop or corrupting state.
      const seq = safeSeq(event)
      const time = safeTime(event)
      if (seq === undefined || time === undefined) return state
      // The fork-inherited prefix belongs to the ancestor: neither its settlements
      // nor its request header may describe this session's spend or its model.
      if (seq < state.inheritedEventCount) return state
      const type = (event as { readonly type?: unknown }).type
      const data = (event as { readonly data?: unknown }).data as Record<string, unknown> | undefined
      if (type === 'request/header') {
        const raw = ((data?.header as Record<string, unknown> | undefined)?.config as Record<string, unknown> | undefined)?.model
        const model = typeof raw === 'string' ? raw.slice(0, 96) : ''
        return model === state.model ? state : { ...state, model }
      }
      if (type !== 'assistant/message' && type !== 'assistant/attempt') return state
      let usage: unknown = type === 'assistant/message' ? data?.usage : undefined
      if (usage === undefined || usage === null) usage = lastStreamUsage(data?.stream)
      const hasUsage = usage !== undefined && usage !== null
      const declared = type === 'assistant/message' ? ((data?.message as Record<string, unknown> | undefined)?.source as Record<string, unknown> | undefined)?.model : state.model
      const model = typeof declared === 'string' ? declared : state.model
      const priced = engine.price(hasUsage ? usage : {}, model, time)
      const issues: readonly IssueCode[] = [...new Set<IssueCode>(hasUsage ? priced.issues : [...priced.issues, 'missing-usage'])]
      const delta = contribution(priced, hasUsage)
      const key = priced.model ?? 'unknown'
      const existing = state.view.byModel.find(row => row.model === key)
      const row: ModelBreakdown = { model: key, totals: addTotals(existing?.totals ?? zeroTotals(), delta) }
      const byModel = [...state.view.byModel.filter(item => item.model !== key), row].sort((a, b) => a.model.localeCompare(b.model))
      const allIssues = [...new Set([...state.view.coverage.issues, ...issues])]
      return {
        ...state,
        view: {
          revision: fingerprint + ':' + seq,
          totals: addTotals(state.view.totals, delta), byModel,
          recent: [{ seq, at: time, model: String(model ?? '(unknown)').slice(0, 96), kind: type === 'assistant/attempt' ? 'attempt' as const : data?.interrupted ? 'interrupted' as const : 'message' as const, money: delta.money, tokens: delta.tokens, peak: priced.peak, issues }, ...state.view.recent].slice(0, 20),
          coverage: { status: allIssues.length === 0 ? 'complete' : 'partial', issues: allIssues, failedSessions: 0, omittedSessions: 0 },
        },
      }
    },
    wire: { viewSchema: ledgerViewSchema, view: state => state.view },
  }
}
