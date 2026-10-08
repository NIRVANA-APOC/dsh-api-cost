import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BUNDLED_HOLIDAYS,
  createPricingEngine,
  decimalToNano,
  nanoToDecimal,
  PEAK_POLICY_FROM,
  PEAK_POLICY_FROM_MS,
  RATE_CARD,
  RATE_CARD_AUDIT,
  RATE_CARD_EFFECTIVE_FROM,
  RATE_CARD_EFFECTIVE_FROM_MS,
  ROUTING_DISPUTED_AFTER_MS,
} from '../src/pricing/index.ts'
import type { HolidayOverrides, ModelKey, PricedUsage } from '../src/pricing/index.ts'

/** Explicit Beijing wall-clock time; never use the real clock. */
const bj = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number =>
  Date.UTC(year, month - 1, day, hour - 8, minute, second)
const PEAK = bj(2026, 9, 30, 10)
const OFF_PEAK = bj(2026, 9, 30, 20)
const engine = createPricingEngine()
const models = ['deepseek-flash', 'deepseek-v4-pro'] as const
const buckets = ['cacheHit', 'cacheMiss', 'output'] as const
const sane = (priced: PricedUsage): void => {
  for (const count of Object.values(priced.tokens)) assert.ok(typeof count === 'bigint' && count >= 0n)
  assert.ok(priced.moneyNano.cny >= 0n && priced.moneyNano.usd >= 0n)
  assert.equal(priced.tokens.total, priced.tokens.cacheHit + priced.tokens.cacheMiss + priced.tokens.output)
}

describe('published rates and provenance', () => {
  it('keeps exactly the published models and independent CNY/USD columns', () => {
    assert.deepEqual(Object.keys(RATE_CARD).sort(), [...models])
    assert.deepEqual(RATE_CARD, {
      'deepseek-flash': {
        label: 'DeepSeek Flash',
        peak: { cny: { cacheHit: '0.04', cacheMiss: '2', output: '8' }, usd: { cacheHit: '0.006', cacheMiss: '0.3', output: '1.2' } },
        offPeak: { cny: { cacheHit: '0.02', cacheMiss: '1', output: '4' }, usd: { cacheHit: '0.003', cacheMiss: '0.15', output: '0.6' } },
      },
      'deepseek-v4-pro': {
        label: 'DeepSeek V4 Pro',
        peak: { cny: { cacheHit: '0.3', cacheMiss: '9', output: '27' }, usd: { cacheHit: '0.044', cacheMiss: '1.32', output: '3.96' } },
        offPeak: { cny: { cacheHit: '0.15', cacheMiss: '4.5', output: '13.5' }, usd: { cacheHit: '0.022', cacheMiss: '0.66', output: '1.98' } },
      },
    })
  })
  it('retains the source, retrieval date, policy and card effective dates', () => {
    assert.equal(RATE_CARD_AUDIT.source, 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/')
    assert.equal(RATE_CARD_AUDIT.retrievedAt, '2026-09-30')
    assert.equal(PEAK_POLICY_FROM, '2026-08-17T00:00:00+08:00')
    assert.equal(PEAK_POLICY_FROM_MS, bj(2026, 8, 17))
    assert.equal(RATE_CARD_EFFECTIVE_FROM, '2026-09-10T12:00:00+08:00')
    assert.equal(RATE_CARD_EFFECTIVE_FROM_MS, bj(2026, 9, 10, 12))
    const view = engine.status(PEAK)
    assert.equal(view.source, RATE_CARD_AUDIT.source)
    assert.equal(view.effectiveFrom, RATE_CARD_EFFECTIVE_FROM)
    assert.match(RATE_CARD_AUDIT.currencyRelation.note, /separate published columns/)
    assert.match(RATE_CARD_AUDIT.disputedRouting.note, /conflict/)
    assert.equal(RATE_CARD_AUDIT.holidaySources.length, 2)
  })
  it('publishes decimal strings per million, with every cell priced exactly', () => {
    const usageFields = { cacheHit: 'cacheReadTokens', cacheMiss: 'inputTokens', output: 'outputTokens' } as const
    for (const model of models) for (const [tier, at] of [['peak', PEAK], ['offPeak', OFF_PEAK]] as const) {
      for (const bucket of buckets) {
        const priced = engine.price({ [usageFields[bucket]]: 1_000_000 }, model, at)
        assert.equal(priced.moneyNano.cny, decimalToNano(RATE_CARD[model][tier].cny[bucket]))
        assert.equal(priced.moneyNano.usd, decimalToNano(RATE_CARD[model][tier].usd[bucket]))
      }
    }
  })
  it('freezes public card, aliases and calendar literals recursively', () => {
    assert.ok(Object.isFrozen(RATE_CARD))
    assert.ok(Object.isFrozen(RATE_CARD['deepseek-flash'].peak.cny))
    assert.ok(Object.isFrozen(RATE_CARD_AUDIT.aliases['deepseek-flash']))
    assert.ok(Object.isFrozen(BUNDLED_HOLIDAYS['2026']?.holidays))
    assert.throws(() => { (RATE_CARD['deepseek-flash'].peak.cny as { cacheHit: string }).cacheHit = '100' }, TypeError)
  })
})

describe('exact model resolution, never substring guessing', () => {
  it('accepts canonical ids, declared aliases, case and surrounding whitespace', () => {
    const cases: readonly (readonly [string, ModelKey])[] = [
      ['deepseek-flash', 'deepseek-flash'], ['deepseek-v4-pro', 'deepseek-v4-pro'],
      ['deepseek-v4-flash', 'deepseek-flash'], ['deepseek-v4-flash-vision-exp', 'deepseek-flash'],
      ['  DeepSeek-V4-PRO ', 'deepseek-v4-pro'], [' DEEPSEEK-V4-FLASH ', 'deepseek-flash'],
    ]
    for (const [id, expected] of cases) {
      const result = engine.price({ inputTokens: 1_000_000 }, id, PEAK)
      assert.equal(result.model, expected)
      assert.equal(result.modelId, id.trim())
      assert.ok(!result.issues.includes('unknown-model'))
      assert.equal(result.moneyNano.cny, expected === 'deepseek-flash' ? 2_000_000_000n : 9_000_000_000n)
    }
  })
  it('does not price any heuristic, provider-prefixed or router id', () => {
    for (const id of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3', 'deepseek-pro', 'deepseekv4flash',
      'deepseek-v4-pro-0711', 'DeepSeek-V4-PRO-max', 'deepseek-flash-custom', 'router/deepseek-flash', 'gpt-4o', 'claude-sonnet']) {
      const result = engine.price({ inputTokens: 1_000_000 }, id, PEAK)
      assert.equal(result.model, null, id)
      assert.deepEqual(result.moneyNano, { cny: 0n, usd: 0n }, id)
      assert.ok(result.issues.includes('unknown-model'), id)
      assert.equal(result.peak, true)
      assert.equal(result.tokens.total, 1_000_000n)
    }
  })
  it('cannot be tricked by prototype properties or non-string coercions', () => {
    for (const id of [undefined, null, '', '  ', 123, 'constructor', 'toString', '__proto__',
      { toString: () => 'deepseek-flash' }, ['deepseek-flash']]) {
      assert.equal(engine.price({ inputTokens: 1 }, id, PEAK).model, null)
    }
  })
})

describe('Beijing peak windows and policy epochs', () => {
  it('classifies a plain weekday during the peak window', () => {
    const result = engine.status(PEAK)
    assert.equal(result.peak, true)
    assert.equal(result.reason, 'peak-window')
  })
  it('changes classification at all four half-open millisecond boundaries', () => {
    for (const [hour, before, after] of [[9, false, true], [12, true, false], [14, false, true], [18, true, false]] as const) {
      const edge = bj(2026, 9, 30, hour)
      assert.equal(engine.status(edge - 1).peak, before)
      assert.equal(engine.status(edge).peak, after)
      assert.equal(engine.status(edge + 1).peak, after)
    }
  })
  it('matches the official UTC framing for every minute of three plain weekdays', () => {
    for (const [month, day] of [[9, 29], [9, 30], [10, 8]] as const) for (let minute = 0; minute < 1440; minute += 1) {
      const at = bj(2026, month, day, 0, minute)
      const date = new Date(at)
      const weekday = date.getUTCDay()
      const utcMinute = date.getUTCHours() * 60 + date.getUTCMinutes()
      const expected = weekday >= 1 && weekday <= 5 && ((utcMinute >= 60 && utcMinute < 240) || (utcMinute >= 360 && utcMinute < 600))
      assert.equal(engine.status(at).peak, expected)
    }
  })
  it('prices normal weekends off-peak', () => {
    for (const day of [12, 13]) {
      const result = engine.status(bj(2026, 9, day, 10))
      assert.equal(result.peak, false)
      assert.equal(result.reason, 'weekend')
    }
  })
  it('has no peak surcharge before policy, but uses normal calendar reasons', () => {
    for (const [at, reason] of [
      [bj(2026, 3, 4, 10), 'before-policy'], [bj(2026, 3, 4, 3), 'outside-window'],
      [bj(2026, 2, 14, 10), 'makeup-workday'], [bj(2026, 1, 1, 10), 'holiday'],
      [bj(2026, 3, 7, 10), 'weekend'],
    ] as const) {
      const result = engine.status(at)
      assert.equal(result.peak, false)
      assert.equal(result.reason, reason)
      assert.ok(result.issues.includes('before-rate-card'))
    }
    assert.equal(engine.status(bj(2026, 8, 17, 9)).peak, true)
    assert.equal(engine.status(PEAK_POLICY_FROM_MS).reason, 'outside-window')
  })
  it('classifies between policy and card normally while flagging the estimate', () => {
    const result = engine.price({ inputTokens: 1_000_000 }, 'deepseek-flash', bj(2026, 8, 20, 10))
    assert.equal(result.peak, true)
    assert.equal(result.moneyNano.cny, 2_000_000_000n)
    assert.ok(result.issues.includes('before-rate-card'))
  })
  it('drops the before-card flag exactly at the mid-day card epoch', () => {
    assert.ok(engine.price({ inputTokens: 1 }, 'deepseek-flash', RATE_CARD_EFFECTIVE_FROM_MS - 1).issues.includes('before-rate-card'))
    assert.ok(!engine.price({ inputTokens: 1 }, 'deepseek-flash', RATE_CARD_EFFECTIVE_FROM_MS).issues.includes('before-rate-card'))
    assert.ok(engine.status(RATE_CARD_EFFECTIVE_FROM_MS - 1).peak)
    assert.ok(!engine.status(RATE_CARD_EFFECTIVE_FROM_MS).peak)
  })
  it('uses only explicit instants and never calls Date.now', () => {
    const realNow = Date.now
    Date.now = () => { throw new Error('Implicit clock access') }
    try {
      const explicit = createPricingEngine()
      explicit.status(PEAK)
      explicit.status(PEAK + 1)
      explicit.price({ inputTokens: 1 }, 'deepseek-flash', PEAK)
      assert.equal(explicit.fingerprint, engine.fingerprint)
    } finally { Date.now = realNow }
  })
  it('rejects absent, non-finite, fractional, unsafe or out-of-range timestamps', () => {
    for (const at of [undefined, null, '0', NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => engine.status(at as number), RangeError)
      assert.throws(() => engine.price({ inputTokens: 1 }, 'deepseek-flash', at as number), RangeError)
    }
  })
})

describe('bundled holidays and strict overrides', () => {
  it('covers all 2026 published holiday range edges', () => {
    for (const [month, day] of [[1, 1], [1, 3], [2, 15], [2, 23], [4, 4], [4, 6], [5, 1], [5, 5],
      [6, 19], [6, 21], [9, 25], [9, 27], [10, 1], [10, 7]] as const) {
      const result = engine.status(bj(2026, month, day, 10))
      assert.equal(result.reason, 'holiday')
      assert.equal(result.peak, false)
      assert.ok(!result.issues.includes('holiday-data-missing'))
    }
    assert.equal(engine.status(bj(2026, 10, 8, 9)).peak, true)
  })
  it('covers all 2025 published holiday edges before policy', () => {
    for (const [month, day] of [[1, 1], [1, 28], [2, 4], [4, 4], [4, 6], [5, 1], [5, 5],
      [5, 31], [6, 2], [10, 1], [10, 8]] as const) {
      const result = engine.status(bj(2025, month, day, 10))
      assert.equal(result.reason, 'holiday')
      assert.equal(result.peak, false)
      assert.ok(result.issues.includes('before-rate-card'))
      assert.ok(!result.issues.includes('holiday-data-missing'))
    }
  })
  it('keeps all published 2025/2026 makeup workdays off-peak', () => {
    for (const [year, month, day] of [[2025, 1, 26], [2025, 2, 8], [2025, 4, 27], [2025, 9, 28], [2025, 10, 11],
      [2026, 1, 4], [2026, 2, 14], [2026, 2, 28], [2026, 5, 9], [2026, 9, 20], [2026, 10, 10]] as const) {
      const result = engine.status(bj(year, month, day, 10))
      assert.equal(result.reason, 'makeup-workday')
      assert.equal(result.peak, false)
    }
  })
  it('unknown years are off-peak estimates with an explicit issue', () => {
    const at = bj(2027, 3, 10, 10)
    assert.equal(engine.status(at).reason, 'holiday-data-missing')
    assert.equal(engine.status(at).next, null)
    const result = engine.price({ inputTokens: 1_000_000 }, 'deepseek-flash', at)
    assert.equal(result.peak, false)
    assert.equal(result.moneyNano.cny, 1_000_000_000n)
    assert.ok(result.issues.includes('holiday-data-missing'))
  })
  it('extends a missing year with inclusive holiday and makeup ranges', () => {
    const extended = createPricingEngine({ '2027': {
      holidays: [['2027-03-08', '2027-03-12'], '2027-04-05'],
      makeupWorkdays: [['2027-03-13', '2027-03-14']],
    } })
    assert.equal(extended.status(bj(2027, 3, 10, 10)).reason, 'holiday')
    assert.equal(extended.status(bj(2027, 4, 5, 10)).reason, 'holiday')
    assert.equal(extended.status(bj(2027, 3, 13, 10)).reason, 'makeup-workday')
    assert.equal(extended.status(bj(2027, 3, 14, 10)).reason, 'makeup-workday')
    assert.equal(extended.status(bj(2027, 3, 15, 10)).peak, true)
    assert.ok(!extended.status(bj(2027, 3, 10, 10)).issues.includes('holiday-data-missing'))
    assert.equal(extended.price({ inputTokens: 1_000_000 }, 'deepseek-v4-pro', bj(2027, 3, 10, 10)).moneyNano.cny, 4_500_000_000n)
  })
  it('a partial override replaces one list while preserving the bundled other list', () => {
    const patched = createPricingEngine({ '2026': { holidays: [] } })
    assert.equal(patched.status(bj(2026, 10, 1, 10)).peak, true)
    assert.equal(patched.status(bj(2026, 9, 20, 10)).reason, 'makeup-workday')
    assert.equal(engine.status(bj(2026, 10, 1, 10)).reason, 'holiday')
  })
  it('empty unknown-year objects are ignored, explicit empty lists activate the year', () => {
    assert.equal(createPricingEngine({ '2027': {} }).fingerprint, engine.fingerprint)
    assert.equal(createPricingEngine({ '2027': { holidays: [] } }).status(bj(2027, 3, 10, 10)).peak, true)
  })
  it('validates leap years and strict YYYY-MM-DD formatting', () => {
    assert.equal(createPricingEngine({ '2028': { holidays: ['2028-02-29'] } }).status(bj(2028, 2, 29, 10)).reason, 'holiday')
    for (const day of ['2027-02-29', '2027-02-30', '2027-13-01', '2027-00-01', '2027-01-00',
      '2027-3-01', ' 2027-03-01', '2027-03-01 ', '2027-03-01T00:00:00Z', 'not-a-date', '2028-01-01']) {
      assert.throws(() => createPricingEngine({ '2027': { holidays: [day] } }), /date|YYYY-MM-DD/)
    }
  })
  it('rejects reversed, cross-year, malformed or oversized endpoint tuples', () => {
    for (const range of [['2027-03-12', '2027-03-08'], ['2027-12-31', '2028-01-01'],
      ['2027-03-01'], ['2027-03-01', '2027-03-02', '2027-03-03'], [null, '2027-03-02']]) {
      assert.throws(() => createPricingEngine({ '2027': { holidays: [range] } } as unknown as HolidayOverrides))
    }
  })
  it('rejects duplicate/overlapping days and holiday-versus-makeup contradictions', () => {
    for (const config of [
      { '2027': { holidays: ['2027-03-01', '2027-03-01'] } },
      { '2027': { holidays: [['2027-03-01', '2027-03-03'], ['2027-03-03', '2027-03-04']] } },
      { '2027': { makeupWorkdays: ['2027-03-01', '2027-03-01'] } },
      { '2027': { holidays: ['2027-03-01'], makeupWorkdays: ['2027-03-01'] } },
      { '2026': { holidays: ['2026-09-20'] } }, // Conflicts with inherited makeup list.
    ]) assert.throws(() => createPricingEngine(config as HolidayOverrides), /duplicate|overlapping|both/)
  })
  it('rejects malformed config containers, years, fields and list values on activation', () => {
    for (const config of [null, [], '2027', { '27': {} }, { '02027': {} }, { '2027x': {} }, { '0000': {} },
      { '2027': null }, { '2027': [] }, { '2027': { holiday: [] } }, { '2027': { holidays: null } },
      { '2027': { holidays: '2027-01-01' } }, { '2027': { holidays: [42] } }, { '2027': { makeupWorkdays: [null] } }]) {
      assert.throws(() => createPricingEngine(config as HolidayOverrides))
    }
  })
})

describe('native BigInt pricing and usage integrity', () => {
  it('prices the hand-checked Flash example exactly in both currencies', () => {
    const usage = { inputTokens: 400_000, cacheReadTokens: 600_000, outputTokens: 100_000 }
    const peak = engine.price(usage, 'deepseek-flash', PEAK)
    assert.deepEqual(peak.tokens, { cacheHit: 600_000n, cacheMiss: 400_000n, output: 100_000n, reasoning: 0n, total: 1_100_000n })
    assert.deepEqual(peak.moneyNano, { cny: 1_624_000_000n, usd: 243_600_000n })
    assert.deepEqual(peak.issues, [])
    assert.deepEqual(engine.price(usage, 'deepseek-flash', OFF_PEAK).moneyNano, { cny: 812_000_000n, usd: 121_800_000n })
  })
  it('prices the verified real DSH record without floating-point drift', () => {
    const usage = { inputTokens: 459, outputTokens: 294, cacheReadTokens: 10_496, cacheWriteTokens: 0, totalTokens: 11_249 }
    const peak = engine.price(usage, 'deepseek-flash', PEAK)
    assert.deepEqual(peak.tokens, { cacheHit: 10_496n, cacheMiss: 459n, output: 294n, reasoning: 0n, total: 11_249n })
    assert.deepEqual(peak.moneyNano, { cny: 3_689_840n, usd: 553_476n })
    assert.deepEqual(engine.price(usage, 'deepseek-flash', OFF_PEAK).moneyNano, { cny: 1_844_920n, usd: 276_738n })
    assert.equal(nanoToDecimal(peak.moneyNano.usd), '0.000553476')
  })
  it('charges cache writes as misses and never charges reasoning twice', () => {
    const without = engine.price({ inputTokens: 1000, cacheWriteTokens: 500, outputTokens: 1000 }, 'deepseek-flash', PEAK)
    const withReasoning = engine.price({ inputTokens: 1000, cacheWriteTokens: 500, outputTokens: 1000, reasoningTokens: 400 }, 'deepseek-flash', PEAK)
    assert.equal(withReasoning.tokens.cacheMiss, 1500n)
    assert.equal(withReasoning.tokens.reasoning, 400n)
    assert.equal(withReasoning.tokens.total, 2500n)
    assert.deepEqual(withReasoning.moneyNano, without.moneyNano)
    assert.deepEqual(withReasoning.issues, [])
  })
  it('a single token has exact integer nano rates even for the 0.003 USD rate', () => {
    assert.deepEqual(engine.price({ cacheReadTokens: 1 }, 'deepseek-flash', OFF_PEAK).moneyNano, { cny: 20n, usd: 3n })
    assert.deepEqual(engine.price({ cacheReadTokens: 1 }, 'deepseek-v4-pro', PEAK).moneyNano, { cny: 300n, usd: 44n })
  })
  it('sums bucket counts and money beyond the safe Number range without loss', () => {
    const count = Number.MAX_SAFE_INTEGER
    const result = engine.price({ inputTokens: count, cacheReadTokens: count, cacheWriteTokens: count, outputTokens: count }, 'deepseek-v4-pro', PEAK)
    const exact = BigInt(count)
    assert.equal(result.tokens.total, exact * 4n)
    assert.equal(result.tokens.cacheMiss, exact * 2n)
    assert.equal(result.moneyNano.cny, exact * (300n + 9000n * 2n + 27000n))
    assert.equal(result.moneyNano.usd, exact * (44n + 1320n * 2n + 3960n))
    assert.ok(!result.issues.includes('invalid-usage'))
  })
  it('splitting valid usage across many calls is exactly additive', () => {
    const unit = engine.price({ inputTokens: 3, cacheReadTokens: 7, outputTokens: 11 }, 'deepseek-flash', PEAK)
    const merged = engine.price({ inputTokens: 30_000, cacheReadTokens: 70_000, outputTokens: 110_000 }, 'deepseek-flash', PEAK)
    assert.equal(unit.moneyNano.cny * 10_000n, merged.moneyNano.cny)
    assert.equal(unit.moneyNano.usd * 10_000n, merged.moneyNano.usd)
  })
  it('flags missing reports while accepting explicitly reported zero usage', () => {
    for (const usage of [undefined, null, {}, { unrelated: 1 }]) {
      const result = engine.price(usage, 'deepseek-flash', PEAK)
      assert.deepEqual(result.issues, ['missing-usage'])
      assert.deepEqual(result.moneyNano, { cny: 0n, usd: 0n })
      sane(result)
    }
    assert.deepEqual(engine.price({ inputTokens: 0, outputTokens: 0 }, 'deepseek-flash', PEAK).issues, [])
    assert.ok(engine.price({ totalTokens: 100 }, 'deepseek-flash', PEAK).issues.includes('missing-usage'))
  })
  it('flags every malformed supplied token field rather than coercing or rounding', () => {
    const fields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'totalTokens'] as const
    const invalid = [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1000', '', null, true, 1n, {}, []]
    for (const field of fields) for (const value of invalid) {
      const result = engine.price({ inputTokens: 0, [field]: value }, 'deepseek-flash', PEAK)
      assert.ok(result.issues.includes('invalid-usage'), `${field}=${String(value)}`)
      assert.deepEqual(result.moneyNano, { cny: 0n, usd: 0n })
      sane(result)
    }
  })
  it('flags malformed report containers and preserves valid buckets of a partial report', () => {
    for (const usage of ['usage', 1, true, [], [1000]]) {
      const result = engine.price(usage, 'deepseek-flash', PEAK)
      assert.ok(result.issues.includes('invalid-usage'))
      sane(result)
    }
    const partial = engine.price({ inputTokens: '1000', outputTokens: 5 }, 'deepseek-flash', PEAK)
    assert.equal(partial.tokens.cacheMiss, 0n)
    assert.equal(partial.tokens.output, 5n)
    assert.equal(partial.moneyNano.cny, 40_000n)
    assert.ok(partial.issues.includes('invalid-usage'))
  })
  it('flags inconsistent reported totals or reasoning larger than output', () => {
    for (const usage of [{ inputTokens: 10, totalTokens: 9 }, { outputTokens: 3, reasoningTokens: 4 }]) {
      assert.ok(engine.price(usage, 'deepseek-flash', PEAK).issues.includes('invalid-usage'))
    }
    assert.ok(!engine.price({ inputTokens: 1, cacheReadTokens: 3, cacheWriteTokens: 4, outputTokens: 2, reasoningTokens: 1, totalTokens: 10 }, 'deepseek-flash', PEAK).issues.includes('invalid-usage'))
  })
  it('keeps Pro pricing and flags disputed routing strictly AFTER its epoch', () => {
    const at = engine.price({ inputTokens: 1_000_000 }, 'deepseek-v4-pro', ROUTING_DISPUTED_AFTER_MS)
    assert.equal(at.moneyNano.cny, 4_500_000_000n)
    assert.ok(!at.issues.includes('routing-disputed'))
    assert.ok(engine.price({ inputTokens: 1 }, 'deepseek-v4-pro', ROUTING_DISPUTED_AFTER_MS + 1).issues.includes('routing-disputed'))
    const later = engine.price({ inputTokens: 1_000_000 }, 'deepseek-v4-pro', bj(2026, 9, 15, 10))
    assert.equal(later.moneyNano.cny, 9_000_000_000n)
    assert.ok(later.issues.includes('routing-disputed'))
    for (const model of ['deepseek-flash', 'gpt-4o']) assert.ok(!engine.price({ inputTokens: 1 }, model, PEAK).issues.includes('routing-disputed'))
  })
  it('is deterministic for identical explicit inputs', () => {
    const usage = { inputTokens: 459, outputTokens: 294, cacheReadTokens: 10_496 }
    assert.deepEqual(engine.price(usage, 'deepseek-flash', PEAK), engine.price(usage, 'deepseek-flash', PEAK))
  })
})

describe('decimal fixed-point conversion', () => {
  it('round-trips zero, signed nanos, trailing zeros and huge amounts exactly', () => {
    for (const value of [0n, 1n, -1n, 3n, 1000n, 1_000_000_000n, -1_624_000_000n, 900719925474099312345678901234567890n]) {
      assert.equal(decimalToNano(nanoToDecimal(value)), value)
    }
    assert.equal(nanoToDecimal(1n), '0.000000001')
    assert.equal(nanoToDecimal(1_624_000_000n), '1.624')
    assert.equal(decimalToNano('0001.230000000'), 1_230_000_000n)
    assert.equal(nanoToDecimal(decimalToNano('-0.000000000')), '0')
  })
  it('rejects ambiguous, non-decimal and overprecision inputs without rounding', () => {
    for (const value of ['', ' ', '1e-9', '1e3', 'Infinity', 'NaN', '.1', '1.', '+1', ' 1', '1 ', '0.1234567890', '--1', '1,000']) {
      assert.throws(() => decimalToNano(value), TypeError)
    }
  })
})

describe('status caching, revisions and next flips', () => {
  it('caches by the full valid interval but echoes each supplied now', () => {
    const local = createPricingEngine()
    const a = local.status(PEAK)
    const b = local.status(PEAK + 60_000)
    assert.equal(a.revision, b.revision)
    assert.equal(b.now, PEAK + 60_000)
    assert.equal(a.validUntil, bj(2026, 9, 30, 12))
    assert.equal(a.next, b.next)
    assert.equal(a.issues, b.issues)
    assert.notEqual(a, b)
    assert.equal(createPricingEngine().status(PEAK - 60_000).revision, a.revision)
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a.next) && Object.isFrozen(a.issues))
  })
  it('expires exactly at all four windows and is safe when timestamps go backwards', () => {
    const local = createPricingEngine()
    for (const hour of [9, 12, 14, 18]) {
      const at = bj(2026, 9, 30, hour)
      const before = local.status(at - 1)
      assert.equal(before.validUntil, at)
      const after = local.status(at)
      assert.notEqual(before.revision, after.revision)
      assert.notEqual(before.peak, after.peak)
      assert.equal(local.status(at - 1).revision, before.revision)
    }
  })
  it('expires at local midnight even if the current tier stays off-peak', () => {
    const local = createPricingEngine()
    const before = local.status(bj(2026, 9, 30, 23, 59, 59))
    assert.equal(before.validUntil, bj(2026, 10, 1))
    const after = local.status(before.validUntil)
    assert.equal(before.reason, 'outside-window')
    assert.equal(after.reason, 'holiday')
    assert.notEqual(before.revision, after.revision)
    assert.equal(after.validUntil, bj(2026, 10, 2))
  })
  it('expires unknown-year state at midnight and detects loss of year coverage', () => {
    const before = engine.status(bj(2026, 12, 31, 23, 59, 59))
    assert.equal(before.validUntil, bj(2027, 1, 1))
    const unknown = engine.status(before.validUntil)
    assert.equal(unknown.reason, 'holiday-data-missing')
    assert.equal(unknown.validUntil, bj(2027, 1, 2))
    assert.ok(unknown.issues.includes('holiday-data-missing'))
  })
  it('bounds validity by policy, card and strict routing audit epochs', () => {
    assert.equal(engine.status(PEAK_POLICY_FROM_MS - 1).validUntil, PEAK_POLICY_FROM_MS)
    assert.equal(engine.status(RATE_CARD_EFFECTIVE_FROM_MS - 1).validUntil, RATE_CARD_EFFECTIVE_FROM_MS)
    assert.equal(engine.status(ROUTING_DISPUTED_AFTER_MS - 1).validUntil, ROUTING_DISPUTED_AFTER_MS)
    const at = engine.status(ROUTING_DISPUTED_AFTER_MS)
    assert.equal(at.validUntil, ROUTING_DISPUTED_AFTER_MS + 1)
    assert.ok(!at.issues.includes('routing-disputed'))
    assert.ok(engine.status(at.validUntil).issues.includes('routing-disputed'))
  })
  it('returns the next actual flip, strictly forward from exact or subminute inputs', () => {
    assert.deepEqual(engine.status(PEAK).next, { at: bj(2026, 9, 30, 12), peak: false })
    assert.deepEqual(engine.status(PEAK + 30_000).next, { at: bj(2026, 9, 30, 12), peak: false })
    assert.deepEqual(engine.status(bj(2026, 9, 30, 12)).next, { at: bj(2026, 9, 30, 14), peak: true })
    assert.deepEqual(engine.status(bj(2026, 9, 30, 14)).next, { at: bj(2026, 9, 30, 18), peak: false })
  })
  it('skips weekends, full holidays and the pre-policy era', () => {
    assert.deepEqual(engine.status(bj(2026, 9, 11, 18)).next, { at: bj(2026, 9, 14, 9), peak: true })
    assert.deepEqual(engine.status(bj(2026, 10, 1)).next, { at: bj(2026, 10, 8, 9), peak: true })
    assert.deepEqual(engine.status(bj(2026, 8, 14, 10)).next, { at: bj(2026, 8, 17, 9), peak: true })
    assert.deepEqual(engine.status(bj(2025, 1, 1)).next, { at: bj(2026, 8, 17, 9), peak: true })
  })
  it('finds distant configured years rather than giving up at a 40-day horizon', () => {
    const future = createPricingEngine({ '2028': { holidays: [] } })
    assert.deepEqual(future.status(bj(2027, 3, 10, 10)).next, { at: bj(2028, 1, 3, 9), peak: true })
  })
})

describe('canonical engine fingerprint', () => {
  it('is stable static JSON, independent of calls and time', () => {
    assert.equal(createPricingEngine({}).fingerprint, engine.fingerprint)
    const before = engine.fingerprint
    engine.status(PEAK)
    engine.price({ inputTokens: 1 }, 'deepseek-v4-pro', OFF_PEAK)
    assert.equal(before, engine.fingerprint)
    const staticData: unknown = JSON.parse(before)
    assert.ok(staticData)
    assert.match(before, /2025-01-01/)
    assert.match(before, /safe-integer-disjoint/)
  })
  it('normalizes equivalent key order, day order and range encodings', () => {
    const first = createPricingEngine({
      '2027': { holidays: [['2027-03-08', '2027-03-10'], '2027-04-05'], makeupWorkdays: ['2027-03-13'] },
      '2028': { holidays: [] },
    })
    const second = createPricingEngine({
      '2028': { holidays: [] },
      '2027': { makeupWorkdays: ['2027-03-13'], holidays: ['2027-04-05', '2027-03-10', '2027-03-08', '2027-03-09'] },
    })
    assert.equal(first.fingerprint, second.fingerprint)
    assert.equal(first.status(PEAK).revision, second.status(PEAK).revision)
    assert.notEqual(first.fingerprint, engine.fingerprint)
  })
  it('snapshots the input calendar and changes for a different effective policy', () => {
    const config = { '2027': { holidays: ['2027-03-10'] } }
    const initial = createPricingEngine(config)
    const fingerprint = initial.fingerprint
    config['2027'].holidays[0] = '2027-03-11'
    assert.equal(initial.fingerprint, fingerprint)
    assert.equal(initial.status(bj(2027, 3, 10, 10)).reason, 'holiday')
    assert.notEqual(createPricingEngine(config).fingerprint, fingerprint)
    assert.notEqual(createPricingEngine(config).status(PEAK).revision, initial.status(PEAK).revision)
  })
})
