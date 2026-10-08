import type { HolidayOverrides, IssueCode, ModelKey, ModelRates, PricingView, Rates } from '../shared/contracts.ts'
export type { HolidayOverrides, IssueCode, ModelKey, PricingView } from '../shared/contracts.ts'

export interface NormalizedTokens {
  readonly cacheHit: bigint
  readonly cacheMiss: bigint
  readonly output: bigint
  /** Informational subset of output; never charged a second time. */
  readonly reasoning: bigint
  readonly total: bigint
}
/**
 * A priced report, and exactly what could not be trusted about it.
 *
 * Contract note: `price()` reports the fields it can read and flags the rest —
 * a partially malformed report still yields the rate for its trustworthy
 * buckets, so a caller can show usage even when money is refused. The billing
 * policy is the caller's: the `apiCost` fold deliberately bills NOTHING (zero
 * money, zero tokens) for a report it flags `invalid-usage`, because a figure
 * that no priced call explains must never appear in a total.
 */
export interface PricedUsage {
  readonly model: ModelKey | null
  readonly modelId: string
  readonly peak: boolean
  readonly moneyNano: { readonly cny: bigint; readonly usd: bigint }
  readonly tokens: NormalizedTokens
  readonly issues: readonly IssueCode[]
}
export interface PricingEngine {
  /** Canonical static data, not a hash. The host owns the stateVersion hash. */
  readonly fingerprint: string
  price(usage: unknown, model: unknown, at: number): PricedUsage
  status(now: number): PricingView
}

const NANO = 1_000_000_000n
const MILLION = 1_000_000n
const MINUTE = 60_000
const DAY = 86_400_000
const OFFSET = 8 * 60 * MINUTE
const WINDOWS = [[540, 720], [840, 1080]] as const
const WINDOW_EDGES = [540, 720, 840, 1080] as const
export const PEAK_POLICY_FROM = '2026-08-17T00:00:00+08:00'
export const PEAK_POLICY_FROM_MS = Date.UTC(2026, 7, 17) - OFFSET
export const RATE_CARD_EFFECTIVE_FROM = '2026-09-10T12:00:00+08:00'
export const RATE_CARD_EFFECTIVE_FROM_MS = Date.UTC(2026, 8, 10, 12) - OFFSET
export const ROUTING_DISPUTED_AFTER = '2026-09-14T12:00:00+08:00'
export const ROUTING_DISPUTED_AFTER_MS = Date.UTC(2026, 8, 14, 12) - OFFSET
/** Civil bounds of the supported instant range, evaluated once instead of per settlement. */
const MIN_INSTANT = Date.UTC(1, 0, 1) - OFFSET
const MAX_INSTANT = Date.UTC(9999, 11, 31, 23, 59, 59, 999) - OFFSET

/** No Number conversions, rounding, exponent notation, or locale formatting. */
export function nanoToDecimal(value: bigint): string {
  const negative = value < 0n
  const magnitude = negative ? -value : value
  const whole = magnitude / NANO
  const remainder = magnitude % NANO
  const fraction = remainder === 0n ? '' : `.${remainder.toString().padStart(9, '0').replace(/0+$/, '')}`
  return `${negative ? '-' : ''}${whole}${fraction}`
}
/** Strict signed base-10 decimal, at most nine fractional digits. */
export function decimalToNano(value: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,9})?$/.test(value)) {
    throw new TypeError('Expected a decimal string with at most 9 fractional digits')
  }
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const [whole = '0', fraction = ''] = unsigned.split('.')
  const magnitude = BigInt(whole) * NANO + BigInt(fraction.padEnd(9, '0'))
  return negative ? -magnitude : magnitude
}
function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child)
    Object.freeze(value)
  }
  return value
}

/** Published columns are independent literals, NOT a currency exchange rate. */
export const RATE_CARD: Readonly<Record<ModelKey, ModelRates>> = freezeTree({
  'deepseek-flash': {
    label: 'DeepSeek Flash',
    peak: {
      cny: { cacheHit: '0.04', cacheMiss: '2', output: '8' },
      usd: { cacheHit: '0.006', cacheMiss: '0.3', output: '1.2' },
    },
    offPeak: {
      cny: { cacheHit: '0.02', cacheMiss: '1', output: '4' },
      usd: { cacheHit: '0.003', cacheMiss: '0.15', output: '0.6' },
    },
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek V4 Pro',
    peak: {
      cny: { cacheHit: '0.3', cacheMiss: '9', output: '27' },
      usd: { cacheHit: '0.044', cacheMiss: '1.32', output: '3.96' },
    },
    offPeak: {
      cny: { cacheHit: '0.15', cacheMiss: '4.5', output: '13.5' },
      usd: { cacheHit: '0.022', cacheMiss: '0.66', output: '1.98' },
    },
  },
})
export const RATE_CARD_AUDIT = freezeTree({
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  retrievedAt: '2026-09-30',
  effectiveFrom: RATE_CARD_EFFECTIVE_FROM,
  currencyRelation: {
    note: 'CNY and USD are separate published columns, never derived from each other.',
    publishedFactors: { 'deepseek-flash': '6.666667', 'deepseek-v4-pro': '6.818182' },
  },
  aliases: {
    'deepseek-flash': ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
    'deepseek-v4-pro': [],
  },
  disputedRouting: {
    model: 'deepseek-v4-pro',
    disputedAfter: ROUTING_DISPUTED_AFTER,
    note: 'Official sources conflict: news260910 routes and reprices V4 Pro at Flash rates; the 2026-09-10 changelog says serving and billing are unchanged. Keep the Pro table and flag strictly later instants.',
  },
  holidaySources: [
    '国务院办公厅 国办发明电〔2024〕12号 (2025)',
    '国务院办公厅 国办发明电〔2025〕7号 (2026)',
  ],
})
export const BUNDLED_HOLIDAYS: HolidayOverrides = freezeTree({
  '2025': {
    holidays: [
      '2025-01-01', ['2025-01-28', '2025-02-04'], ['2025-04-04', '2025-04-06'],
      ['2025-05-01', '2025-05-05'], ['2025-05-31', '2025-06-02'], ['2025-10-01', '2025-10-08'],
    ],
    makeupWorkdays: ['2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11'],
  },
  '2026': {
    holidays: [
      ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'], ['2026-04-04', '2026-04-06'],
      ['2026-05-01', '2026-05-05'], ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'],
      ['2026-10-01', '2026-10-07'],
    ],
    makeupWorkdays: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'],
  },
})

interface YearCalendar {
  readonly year: number
  readonly holidays: ReadonlySet<number>
  readonly makeup: ReadonlySet<number>
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function parseDay(value: unknown, year: number, location: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${location}: expected YYYY-MM-DD`)
  const instant = Date.parse(`${value}T00:00:00Z`)
  const date = new Date(instant)
  if (!Number.isFinite(instant) || date.toISOString().slice(0, 10) !== value || date.getUTCFullYear() !== year) {
    throw new RangeError(`${location}: invalid date or date outside configured year ${year}: ${value}`)
  }
  return instant / DAY
}
function parseDays(value: unknown, year: number, location: string): ReadonlySet<number> {
  if (!Array.isArray(value)) throw new TypeError(`${location}: expected an array of dates or inclusive ranges`)
  const days = new Set<number>()
  for (const [index, item] of value.entries()) {
    const path = `${location}[${index}]`
    let from: number
    let to: number
    if (typeof item === 'string') from = to = parseDay(item, year, path)
    else if (Array.isArray(item) && item.length === 2) {
      from = parseDay(item[0], year, `${path}[0]`)
      to = parseDay(item[1], year, `${path}[1]`)
      if (from > to) throw new RangeError(`${path}: reversed date range`)
    } else throw new TypeError(`${path}: expected a date or exactly two range endpoints`)
    for (let day = from; day <= to; day += 1) {
      if (days.has(day)) throw new RangeError(`${path}: duplicate or overlapping date`)
      days.add(day)
    }
  }
  return days
}
/** Validate once when activated; copy inputs so subsequent config mutation is inert. */
function calendarFor(overrides: HolidayOverrides | undefined): ReadonlyMap<number, YearCalendar> {
  if (overrides !== undefined && !isRecord(overrides)) throw new TypeError('holidays: expected a year-keyed object')
  const source: Record<string, unknown> = overrides ?? {}
  const keys = [...new Set([...Object.keys(BUNDLED_HOLIDAYS), ...Object.keys(source)])].sort()
  const result = new Map<number, YearCalendar>()
  for (const key of keys) {
    if (!/^\d{4}$/.test(key) || Number(key) < 1) throw new RangeError(`holidays.${key}: expected a four-digit year in 0001..9999`)
    const year = Number(key)
    const base = BUNDLED_HOLIDAYS[key]
    const supplied = Object.hasOwn(source, key) ? source[key] : undefined
    if (Object.hasOwn(source, key) && !isRecord(supplied)) throw new TypeError(`holidays.${key}: expected a calendar object`)
    const entry = isRecord(supplied) ? supplied : {}
    for (const property of Object.keys(entry)) {
      if (property !== 'holidays' && property !== 'makeupWorkdays') throw new TypeError(`holidays.${key}.${property}: unknown calendar property`)
    }
    if (entry.holidays === null || entry.makeupWorkdays === null) throw new TypeError(`holidays.${key}: lists must be arrays`)
    // An empty new-year entry does not assert that the calendar is known.
    if (base === undefined && entry.holidays === undefined && entry.makeupWorkdays === undefined) continue
    const holidays = parseDays(entry.holidays ?? base?.holidays ?? [], year, `holidays.${key}.holidays`)
    const makeup = parseDays(entry.makeupWorkdays ?? base?.makeupWorkdays ?? [], year, `holidays.${key}.makeupWorkdays`)
    for (const day of makeup) {
      if (holidays.has(day)) throw new RangeError(`holidays.${key}: a date cannot be both a holiday and a makeup workday`)
    }
    result.set(year, { year, holidays, makeup })
  }
  return result
}
function assertInstant(instant: number): void {
  if (typeof instant !== 'number' || !Number.isSafeInteger(instant) || instant < MIN_INSTANT || instant > MAX_INSTANT) {
    throw new RangeError('Expected explicit safe-integer epoch milliseconds within civil years 0001..9999 (UTC+8)')
  }
}
interface CivilTime {
  readonly year: number
  readonly day: number
  readonly dayStart: number
  readonly weekday: number
  readonly minute: number
}
/**
 * Bounded memo of immutable per-day facts. A day's year, weekday and start never
 * change, and the cache only serves pure arithmetic — so replaying a year of
 * settlements stops allocating a Date per event.
 */
const DAY_CACHE_LIMIT = 4096
const dayFacts = new Map<number, { readonly year: number; readonly weekday: number; readonly dayStart: number }>()
function dayFactsOf(day: number): { readonly year: number; readonly weekday: number; readonly dayStart: number } {
  const cached = dayFacts.get(day)
  if (cached !== undefined) return cached
  const shifted = day * DAY
  const date = new Date(shifted)
  const facts = { year: date.getUTCFullYear(), weekday: date.getUTCDay(), dayStart: shifted - OFFSET }
  if (dayFacts.size >= DAY_CACHE_LIMIT) dayFacts.clear()
  dayFacts.set(day, facts)
  return facts
}
function civilTime(instant: number): CivilTime {
  const shifted = instant + OFFSET
  const day = Math.floor(shifted / DAY)
  const facts = dayFactsOf(day)
  return { year: facts.year, day, dayStart: facts.dayStart, weekday: facts.weekday, minute: Math.floor((shifted - day * DAY) / MINUTE) }
}
interface Classification {
  readonly peak: boolean
  readonly reason: string
  readonly windowDay: boolean
  readonly local: CivilTime
  readonly issues: readonly IssueCode[]
  /** Flags the price hot path reads without materializing the issues array. */
  readonly missingYear: boolean
  readonly beforeCard: boolean
}
const NO_ISSUES: readonly IssueCode[] = Object.freeze([])
/**
 * Classification is constant within one local minute. The memo lives INSIDE an
 * engine because the answer depends on that engine's holiday configuration.
 */
const CLASSIFY_CACHE_LIMIT = 8192
function classify(instant: number, calendars: ReadonlyMap<number, YearCalendar>, cache: Map<number, Classification>): Classification {
  const local = civilTime(instant)
  const cacheKey = local.day * 1440 + local.minute
  const cached = cache.get(cacheKey)
  if (cached !== undefined) return cached
  const calendar = calendars.get(local.year)
  const holiday = calendar?.holidays.has(local.day) ?? false
  const makeup = calendar?.makeup.has(local.day) ?? false
  const weekday = local.weekday >= 1 && local.weekday <= 5
  const inWindow = WINDOWS.some(([start, end]) => local.minute >= start && local.minute < end)
  const beforePolicy = instant < PEAK_POLICY_FROM_MS
  const windowDay = calendar !== undefined && weekday && !holiday && !makeup
  let reason: string
  let peak = false
  if (beforePolicy && windowDay && inWindow) reason = 'before-policy'
  else if (calendar === undefined) reason = 'holiday-data-missing'
  else if (holiday) reason = 'holiday'
  else if (makeup) reason = 'makeup-workday'
  else if (!weekday) reason = 'weekend'
  else if (inWindow && !beforePolicy) { peak = true; reason = 'peak-window' }
  else reason = 'outside-window'
  const missingYear = calendar === undefined
  const beforeCard = instant < RATE_CARD_EFFECTIVE_FROM_MS
  const issues: IssueCode[] = []
  if (missingYear) issues.push('holiday-data-missing')
  if (beforeCard) issues.push('before-rate-card')
  const classification: Classification = { peak, reason, windowDay, local, issues, missingYear, beforeCard }
  if (cache.size >= CLASSIFY_CACHE_LIMIT) cache.clear()
  cache.set(cacheKey, classification)
  return classification
}
function readCount(source: Record<string, unknown>, field: string, state: { invalid: boolean }): bigint {
  const value = source[field]
  if (value === undefined) return 0n
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) { state.invalid = true; return 0n }
  return BigInt(value)
}
interface NormalizedUsage { readonly tokens: NormalizedTokens; readonly missing: boolean; readonly invalid: boolean }
function normalizedUsage(usage: unknown): NormalizedUsage {
  const record = isRecord(usage)
  const source: Record<string, unknown> = record ? usage : {}
  const invalidShape = usage !== undefined && usage !== null && !record
  const state = { invalid: invalidShape }
  const input = readCount(source, 'inputTokens', state)
  const cacheHit = readCount(source, 'cacheReadTokens', state)
  const cacheWrite = readCount(source, 'cacheWriteTokens', state)
  const output = readCount(source, 'outputTokens', state)
  const reasoning = readCount(source, 'reasoningTokens', state)
  const cacheMiss = input + cacheWrite
  const total = cacheHit + cacheMiss + output
  const declaredTotal = readCount(source, 'totalTokens', state)
  const billingPresent = source.inputTokens !== undefined || source.cacheReadTokens !== undefined
    || source.cacheWriteTokens !== undefined || source.outputTokens !== undefined
  const anythingPresent = billingPresent || source.reasoningTokens !== undefined || source.totalTokens !== undefined
  const missing = (!anythingPresent && !invalidShape) || (anythingPresent && !billingPresent)
  if ((source.totalTokens !== undefined && declaredTotal !== total) || reasoning > output) state.invalid = true
  return { tokens: { cacheHit, cacheMiss, output, reasoning, total }, missing, invalid: state.invalid }
}
function resolve(model: unknown): { model: ModelKey | null; modelId: string } {
  const modelId = typeof model === 'string' ? model.trim() : ''
  switch (modelId.toLowerCase()) {
    case 'deepseek-flash':
    case 'deepseek-v4-flash':
    case 'deepseek-v4-flash-vision-exp': return { model: 'deepseek-flash', modelId }
    case 'deepseek-v4-pro': return { model: 'deepseek-v4-pro', modelId }
    default: return { model: null, modelId }
  }
}
interface NanoRates { readonly cacheHit: bigint; readonly cacheMiss: bigint; readonly output: bigint }
function perToken(rates: Rates): NanoRates {
  const convert = (rate: string): bigint => {
    const nano = decimalToNano(rate)
    if (nano < 0n || nano % MILLION !== 0n) throw new RangeError('Rate must have at most 3 fractional digits per million tokens')
    return nano / MILLION
  }
  return { cacheHit: convert(rates.cacheHit), cacheMiss: convert(rates.cacheMiss), output: convert(rates.output) }
}
function cost(tokens: NormalizedTokens, rates: NanoRates): bigint {
  return tokens.cacheHit * rates.cacheHit + tokens.cacheMiss * rates.cacheMiss + tokens.output * rates.output
}
const ZERO_MONEY = Object.freeze({ cny: 0n, usd: 0n })
const NANO_CARD = {
  'deepseek-flash': {
    peak: { cny: perToken(RATE_CARD['deepseek-flash'].peak.cny), usd: perToken(RATE_CARD['deepseek-flash'].peak.usd) },
    offPeak: { cny: perToken(RATE_CARD['deepseek-flash'].offPeak.cny), usd: perToken(RATE_CARD['deepseek-flash'].offPeak.usd) },
  },
  'deepseek-v4-pro': {
    peak: { cny: perToken(RATE_CARD['deepseek-v4-pro'].peak.cny), usd: perToken(RATE_CARD['deepseek-v4-pro'].peak.usd) },
    offPeak: { cny: perToken(RATE_CARD['deepseek-v4-pro'].offPeak.cny), usd: perToken(RATE_CARD['deepseek-v4-pro'].offPeak.usd) },
  },
} as const
/** Actual next flip, including distant configured years; no arbitrary scan horizon. */
function nextFlip(instant: number, current: Classification, calendars: ReadonlyMap<number, YearCalendar>): PricingView['next'] {
  if (current.peak) {
    const end = current.local.minute < 720 ? 720 : 1080
    return { at: current.local.dayStart + end * MINUTE, peak: false }
  }
  const firstDay = Math.max(current.local.day, Math.floor((PEAK_POLICY_FROM_MS + OFFSET) / DAY))
  for (const calendar of calendars.values()) {
    const yearStart = Date.parse(`${String(calendar.year).padStart(4, '0')}-01-01T00:00:00Z`) / DAY
    const yearEnd = Date.parse(`${String(calendar.year).padStart(4, '0')}-12-31T00:00:00Z`) / DAY
    if (yearEnd < firstDay) continue
    for (let day = Math.max(yearStart, firstDay); day <= yearEnd; day += 1) {
      const weekday = ((day + 4) % 7 + 7) % 7
      if (weekday < 1 || weekday > 5 || calendar.holidays.has(day) || calendar.makeup.has(day)) continue
      for (const [start] of WINDOWS) {
        const at = day * DAY - OFFSET + start * MINUTE
        if (at > instant && at >= PEAK_POLICY_FROM_MS) return { at, peak: true }
      }
    }
  }
  return null
}
/** Small deterministic revision label; fingerprint itself remains unhashed. */
function revisionPrefix(fingerprint: string): string {
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(fingerprint.charCodeAt(index))) * 0x100000001b3n)
  }
  return `pricing-${hash.toString(16)}`
}
export function createPricingEngine(holidays?: HolidayOverrides): PricingEngine {
  const calendars = calendarFor(holidays)
  const classifyCache = new Map<number, Classification>()
  const classifyAt = (instant: number): Classification => classify(instant, calendars, classifyCache)
  const sortedDays = (days: ReadonlySet<number>): string[] => [...days].sort((a, b) => a - b)
    .map((day) => new Date(day * DAY).toISOString().slice(0, 10))
  const fingerprint = JSON.stringify({
    version: 'bigint-pricing-v2', rateCard: RATE_CARD, audit: RATE_CARD_AUDIT,
    policy: {
      from: PEAK_POLICY_FROM, offsetMinutes: 480, windows: WINDOWS, weekdays: [1, 2, 3, 4, 5],
      missingYear: 'off-peak', makeupWorkdays: 'off-peak', disputeComparison: 'strictly-after',
      usage: 'safe-integer-disjoint-cache-write-as-miss-reasoning-in-output',
    },
    holidays: [...calendars.values()].map((entry) => ({
      year: entry.year, holidays: sortedDays(entry.holidays), makeupWorkdays: sortedDays(entry.makeup),
    })),
  })
  const prefix = revisionPrefix(fingerprint)
  let cached: { readonly from: number; readonly view: PricingView } | undefined
  return Object.freeze({
    fingerprint,
    price(usage: unknown, model: unknown, at: number): PricedUsage {
      assertInstant(at)
      const classification = classifyAt(at)
      const resolved = resolve(model)
      const normalized = normalizedUsage(usage)
      const disputed = resolved.model === 'deepseek-v4-pro' && at > ROUTING_DISPUTED_AFTER_MS
      let issues: readonly IssueCode[] = NO_ISSUES
      if (normalized.missing || normalized.invalid || classification.missingYear || classification.beforeCard || resolved.model === null || disputed) {
        const list: IssueCode[] = []
        if (normalized.missing) list.push('missing-usage')
        if (normalized.invalid) list.push('invalid-usage')
        if (classification.missingYear) list.push('holiday-data-missing')
        if (classification.beforeCard) list.push('before-rate-card')
        if (resolved.model === null) list.push('unknown-model')
        if (disputed) list.push('routing-disputed')
        issues = list
      }
      const rates = resolved.model === null ? null : NANO_CARD[resolved.model][classification.peak ? 'peak' : 'offPeak']
      return {
        model: resolved.model, modelId: resolved.modelId, peak: classification.peak,
        moneyNano: rates === null ? ZERO_MONEY : { cny: cost(normalized.tokens, rates.cny), usd: cost(normalized.tokens, rates.usd) },
        tokens: normalized.tokens, issues,
      }
    },
    status(now: number): PricingView {
      assertInstant(now)
      if (cached !== undefined && now >= cached.from && now < cached.view.validUntil) return Object.freeze({ ...cached.view, now })
      const current = classifyAt(now)
      const issues: IssueCode[] = [...current.issues]
      // Status describes the complete card, which includes the disputed Pro row.
      if (now > ROUTING_DISPUTED_AFTER_MS) issues.push('routing-disputed')
      const boundaries = [current.local.dayStart, current.local.dayStart + DAY]
      if (current.windowDay) for (const edge of WINDOW_EDGES) boundaries.push(current.local.dayStart + edge * MINUTE)
      boundaries.push(PEAK_POLICY_FROM_MS, RATE_CARD_EFFECTIVE_FROM_MS, ROUTING_DISPUTED_AFTER_MS, ROUTING_DISPUTED_AFTER_MS + 1)
      let from = current.local.dayStart
      let validUntil = current.local.dayStart + DAY
      for (const boundary of boundaries) {
        if (boundary <= now && boundary > from) from = boundary
        if (boundary > now && boundary < validUntil) validUntil = boundary
      }
      const view: PricingView = Object.freeze({
        schemaVersion: 2, revision: `${prefix}:${from}:${validUntil}`, now, validUntil,
        peak: current.peak, reason: current.reason,
        next: freezeTree(nextFlip(now, current, calendars)), issues: Object.freeze(issues),
        rateCard: RATE_CARD, source: RATE_CARD_AUDIT.source, effectiveFrom: RATE_CARD_EFFECTIVE_FROM,
      })
      cached = { from, view }
      return view
    },
  })
}
