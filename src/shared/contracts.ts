export const PACKAGE_NAME = 'dsh-api-cost' as const
export const PROJECTION_KEY = 'apiCost' as const
export const API_PREFIX = '/dsh-api-cost/v2' as const
export const SCHEMA_VERSION = 2 as const

export type Scope = 'auto' | 'self' | 'tree' | 'team'
export type EffectiveScope = Exclude<Scope, 'auto'>
export type ModelKey = 'deepseek-flash' | 'deepseek-v4-pro'
export type Decimal = string
export type IssueCode = 'unknown-model' | 'invalid-usage' | 'missing-usage' | 'holiday-data-missing' | 'before-rate-card' | 'routing-disputed' | 'session-unavailable' | 'scope-unavailable' | 'scope-truncated'
export interface Money { readonly cny: Decimal; readonly usd: Decimal }
export interface Tokens { readonly cacheHit: Decimal; readonly cacheMiss: Decimal; readonly output: Decimal; readonly reasoning: Decimal; readonly total: Decimal }
export interface Totals {
  readonly calls: number
  readonly attempts: number
  readonly unpricedCalls: number
  readonly money: Money
  readonly tokens: Tokens
  readonly periods: { readonly peak: Money; readonly offPeak: Money }
}
export interface Coverage {
  readonly status: 'complete' | 'partial' | 'unavailable'
  readonly issues: readonly IssueCode[]
  readonly failedSessions: number
  readonly omittedSessions: number
}
export interface ModelBreakdown { readonly model: ModelKey | 'unknown'; readonly totals: Totals }
export interface RecentCall {
  readonly seq: number
  readonly at: number
  readonly model: string
  readonly kind: 'message' | 'interrupted' | 'attempt'
  readonly money: Money
  readonly tokens: Tokens
  readonly peak: boolean
  readonly issues: readonly IssueCode[]
}
/** A bounded whole value. The framework owns delivery and watermark ordering. */
export interface LedgerView {
  readonly revision: string
  readonly totals: Totals
  readonly byModel: readonly ModelBreakdown[]
  readonly recent: readonly RecentCall[]
  readonly coverage: Coverage
}
export interface MemberView {
  readonly sessionId: string
  readonly name: string
  readonly role: 'lead' | 'teammate' | 'session'
  readonly money: Money
  readonly ownMoney: Money
}
export interface CostView {
  readonly schemaVersion: 2
  readonly sessionId: string
  readonly rootSessionId: string
  readonly scope: EffectiveScope
  readonly revision: string
  readonly total: Totals
  readonly own: Totals
  readonly others: Totals
  readonly coverage: Coverage
  readonly sessionCount: number
  readonly byModel?: readonly ModelBreakdown[]
  readonly recent?: readonly RecentCall[]
  readonly members?: readonly MemberView[]
}
export interface Rates { readonly cacheHit: Decimal; readonly cacheMiss: Decimal; readonly output: Decimal }
export interface ModelRates {
  readonly label: string
  readonly peak: { readonly cny: Rates; readonly usd: Rates }
  readonly offPeak: { readonly cny: Rates; readonly usd: Rates }
}
export interface PricingView {
  readonly schemaVersion: 2
  readonly revision: string
  readonly now: number
  readonly validUntil: number
  readonly peak: boolean
  readonly reason: string
  readonly next: { readonly at: number; readonly peak: boolean } | null
  readonly issues: readonly IssueCode[]
  readonly rateCard: Readonly<Record<ModelKey, ModelRates>>
  readonly source: string
  readonly effectiveFrom: string
}
export type HolidayRange = string | readonly [string, string]
export type HolidayOverrides = Readonly<Record<string, { readonly holidays?: readonly HolidayRange[] | undefined; readonly makeupWorkdays?: readonly HolidayRange[] | undefined }>>
/**
 * Off-peak request gate (`src/host/gate.ts`).
 *
 * `off`     the user turned it off; every model request dispatches immediately.
 * `open`    the user turned it on and the tier is off-peak; requests dispatch.
 * `holding` the user turned it on and the tier is peak; model requests are
 *           parked until the tier turns off-peak, so the provider call — and
 *           therefore its settlement — happens entirely inside the cheap window.
 */
export type GateState = 'off' | 'open' | 'holding'
/**
 * The control surface the capsule panel reads and writes.
 *
 * Deliberately shaped so the client can render without a second source of
 * truth: `peak`/`reason`/`next` come from the pricing engine, `state` and the
 * counters come from the gate itself. Timestamps are absolute epoch
 * milliseconds so a client clock skew cannot change what is displayed.
 */
export interface GateView {
  readonly schemaVersion: 2
  /** The user's choice; the only field the panel writes. */
  readonly enabled: boolean
  readonly state: GateState
  /** The tier in force at `now`, from the same engine that prices settlements. */
  readonly peak: boolean
  /** The engine's own reason for that tier (peak-window, weekend, holiday, …). */
  readonly reason: string
  /** Instant the current hold releases; null while nothing is held. */
  readonly releaseAt: number | null
  /** Model requests currently parked. */
  readonly holding: number
  /** Instant the oldest parked request started waiting; null while none is. */
  readonly since: number | null
  /** Requests parked since this process started. */
  readonly heldTotal: number
  /** Total milliseconds of dispatch delay applied since this process started. */
  readonly delayedMs: number
  /** Instant the enabled flag last changed. */
  readonly changedAt: number
  /** True when the enabled flag survives a restart of this process. */
  readonly durable: boolean
  /** Changes only when this value changes; safe as an ETag component. */
  readonly revision: string
  /** The next tier change, so a client re-reads exactly at the boundary. */
  readonly next: { readonly at: number; readonly peak: boolean } | null
  /** Instant this view was produced. */
  readonly now: number
}
/** Off-peak gate configuration. Omit `gate` to keep the feature available but off. */
export interface GateConfig {
  /** Initial enabled state, used only when nothing durable has been stored. Default false. */
  readonly enabled?: boolean | undefined
  /** Persist the enabled state across restarts. Default true. */
  readonly persist?: boolean | undefined
  /** Explicit state-file path; defaults to `<dsh home>/state/dsh-api-cost/gate.json`. */
  readonly path?: string | undefined
  /**
   * Which model calls the gate holds. `all` (the default) holds every model
   * request. `priced` holds only ids the published DeepSeek card prices, so a
   * subscription-backed or third-party route — where no peak/off-peak rate
   * exists to save — is never delayed for nothing.
   */
  readonly models?: 'all' | 'priced' | undefined
}
export interface PluginConfig {
  readonly holidays?: HolidayOverrides | undefined
  readonly defaultScope?: Scope | undefined
  readonly tool?: boolean | undefined
  readonly command?: boolean | undefined
  readonly gate?: GateConfig | undefined
}
export interface ApiError { readonly ok: false; readonly code: string; readonly message: string }
