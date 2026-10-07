/**
 * dsh-api-cost / test/pricing.test.mjs
 *
 * Zero-dependency unit tests for the pricing engine.
 * Run from the package directory:
 *   <node> --test test/pricing.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  RATE_CARD,
  RATE_CARD_AUDIT,
  RATE_CARD_EFFECTIVE_FROM,
  RATE_CARD_EFFECTIVE_FROM_MS,
  PEAK_POLICY_FROM,
  PEAK_POLICY_FROM_MS,
  classifyInstant,
  describeInstant,
  formatCny,
  formatTokens,
  formatUsd,
  nextBoundary,
  priceUsage,
  resolveModel,
} from '../lib/pricing.mjs';

/** Beijing wall-clock (+08:00) → epoch ms. Handles hour overflow correctly. */
const bj = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h - 8, mi, s);

const closeTo = (actual, expected, epsilon = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);

/** Assert a priceUsage result is numerically sane everywhere. */
const assertSane = (result) => {
  for (const [name, value] of Object.entries(result.tokens)) {
    assert.ok(Number.isFinite(value), `tokens.${name} must be finite, got ${value}`);
    assert.ok(value >= 0, `tokens.${name} must be >= 0, got ${value}`);
  }
  assert.ok(Number.isFinite(result.costCny) && result.costCny >= 0, `costCny=${result.costCny}`);
  assert.ok(Number.isFinite(result.costUsd) && result.costUsd >= 0, `costUsd=${result.costUsd}`);
};

/* -------------------------------------------------------------------------- */
/* Published rate card                                                        */
/* -------------------------------------------------------------------------- */

const PUBLISHED_CNY = {
  'deepseek-flash': {
    peak: { cacheHitCny: 0.04, cacheMissCny: 2.0, outputCny: 8.0 },
    offPeak: { cacheHitCny: 0.02, cacheMissCny: 1.0, outputCny: 4.0 },
  },
  'deepseek-v4-pro': {
    peak: { cacheHitCny: 0.3, cacheMissCny: 9.0, outputCny: 27.0 },
    offPeak: { cacheHitCny: 0.15, cacheMissCny: 4.5, outputCny: 13.5 },
  },
};

const PUBLISHED_USD = {
  'deepseek-flash': {
    peak: { cacheHitUsd: 0.006, cacheMissUsd: 0.3, outputUsd: 1.2 },
    offPeak: { cacheHitUsd: 0.003, cacheMissUsd: 0.15, outputUsd: 0.6 },
  },
  'deepseek-v4-pro': {
    peak: { cacheHitUsd: 0.044, cacheMissUsd: 1.32, outputUsd: 3.96 },
    offPeak: { cacheHitUsd: 0.022, cacheMissUsd: 0.66, outputUsd: 1.98 },
  },
};

const BUCKETS = ['cacheHit', 'cacheMiss', 'output'];

/** Published CNY↔USD factor, per model (never a single global factor). */
const PUBLISHED_FACTORS = { 'deepseek-flash': 6.666667, 'deepseek-v4-pro': 6.818182 };

describe('published rate card', () => {
  it('carries provenance and the per-model currency factors', () => {
    assert.equal(RATE_CARD.source, 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/');
    assert.equal(RATE_CARD.retrievedAt, '2026-09-30');
    assert.deepEqual(RATE_CARD.currencyRelation.factors, PUBLISHED_FACTORS);
    assert.equal(typeof RATE_CARD.currencyRelation.note, 'string');
    assert.ok(RATE_CARD.currencyRelation.note.length > 0);
  });

  it('exposes exactly the two published models with their aliases', () => {
    assert.deepEqual(Object.keys(RATE_CARD.models).sort(), ['deepseek-flash', 'deepseek-v4-pro']);
    assert.equal(RATE_CARD.models['deepseek-flash'].label, 'DeepSeek Flash');
    assert.equal(RATE_CARD.models['deepseek-v4-pro'].label, 'DeepSeek V4 Pro');
    assert.deepEqual(RATE_CARD.models['deepseek-flash'].aliases, [
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
    ]);
    assert.deepEqual(RATE_CARD.models['deepseek-v4-pro'].aliases, []);
  });

  it('matches the published CNY table exactly (both models, both tiers, all buckets)', () => {
    for (const [model, tiers] of Object.entries(PUBLISHED_CNY)) {
      for (const tier of ['peak', 'offPeak']) {
        assert.deepEqual(RATE_CARD.models[model][tier], tiers[tier], `${model}.${tier} CNY`);
      }
    }
  });

  it('matches the published USD table exactly (both models, both tiers, all buckets)', () => {
    for (const [model, tiers] of Object.entries(PUBLISHED_USD)) {
      for (const tier of ['peak', 'offPeak']) {
        assert.deepEqual(RATE_CARD.models[model][tier === 'peak' ? 'peakUsd' : 'offPeakUsd'], tiers[tier], `${model}.${tier} USD`);
      }
    }
  });

  it('uses the published off-peak numbers verbatim (never derived by halving)', () => {
    // Written out as literals so a change in either column fails loudly.
    assert.deepEqual(RATE_CARD.models['deepseek-flash'].offPeak, {
      cacheHitCny: 0.02,
      cacheMissCny: 1.0,
      outputCny: 4.0,
    });
    assert.deepEqual(RATE_CARD.models['deepseek-flash'].offPeakUsd, {
      cacheHitUsd: 0.003,
      cacheMissUsd: 0.15,
      outputUsd: 0.6,
    });
    assert.deepEqual(RATE_CARD.models['deepseek-v4-pro'].offPeak, {
      cacheHitCny: 0.15,
      cacheMissCny: 4.5,
      outputCny: 13.5,
    });
    assert.deepEqual(RATE_CARD.models['deepseek-v4-pro'].offPeakUsd, {
      cacheHitUsd: 0.022,
      cacheMissUsd: 0.66,
      outputUsd: 1.98,
    });
  });

  it('satisfies cny ≈ usd * factor for every cell, using the per-model factor', () => {
    for (const [model, tiers] of Object.entries(RATE_CARD.models)) {
      const factor = PUBLISHED_FACTORS[model];
      assert.ok(Number.isFinite(factor), `no published factor for ${model}`);
      for (const [tier, cnyRow, usdRow] of [
        ['peak', tiers.peak, tiers.peakUsd],
        ['offPeak', tiers.offPeak, tiers.offPeakUsd],
      ]) {
        for (const bucket of BUCKETS) {
          const cny = cnyRow[`${bucket}Cny`];
          const usd = usdRow[`${bucket}Usd`];
          const relative = Math.abs(cny - usd * factor) / Math.abs(cny);
          assert.ok(relative <= 1e-6, `${model}.${tier}.${bucket}: ${cny} vs ${usd} * ${factor} (rel ${relative})`);
        }
      }
    }
  });

  it('documents the v4-pro routing dispute on the model row and in the audit', () => {
    const pro = RATE_CARD.models['deepseek-v4-pro'];
    assert.equal(pro.disputedAfter, '2026-09-14T12:00:00+08:00');
    assert.match(pro.dispute, /conflict/i);
    assert.equal(RATE_CARD_AUDIT.disputedRouting.model, 'deepseek-v4-pro');
    assert.equal(RATE_CARD_AUDIT.disputedRouting.disputedAfter, pro.disputedAfter);
    assert.equal(RATE_CARD.models['deepseek-flash'].disputedAfter, undefined);
  });

  it('freezes the card so consumers cannot mutate published rates', () => {
    assert.ok(Object.isFrozen(RATE_CARD));
    assert.ok(Object.isFrozen(RATE_CARD.models['deepseek-flash'].peak));
  });
});

/* -------------------------------------------------------------------------- */
/* Model resolution                                                           */
/* -------------------------------------------------------------------------- */

describe('resolveModel', () => {
  it('resolves card keys exactly', () => {
    assert.deepEqual(resolveModel('deepseek-flash'), {
      key: 'deepseek-flash',
      label: 'DeepSeek Flash',
      guessed: false,
      known: true,
    });
    assert.deepEqual(resolveModel('deepseek-v4-pro'), {
      key: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      guessed: false,
      known: true,
    });
  });

  it('resolves the declared legacy aliases as known ids', () => {
    for (const alias of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
      const resolved = resolveModel(alias);
      assert.equal(resolved.key, 'deepseek-flash', alias);
      assert.equal(resolved.known, true, alias);
      assert.equal(resolved.guessed, false, alias);
    }
  });

  it('is case- and whitespace-insensitive for exact ids', () => {
    assert.deepEqual(resolveModel('  DeepSeek-V4-Pro '), {
      key: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      guessed: false,
      known: true,
    });
  });

  it('heuristically maps pro-ish and other deepseek ids, flagged as guessed', () => {
    for (const id of ['deepseek-v4-pro-0711', 'deepseek-pro', 'DeepSeek-V4-PRO-max']) {
      const resolved = resolveModel(id);
      assert.equal(resolved.key, 'deepseek-v4-pro', id);
      assert.equal(resolved.guessed, true, id);
      assert.equal(resolved.known, false, id);
    }
    for (const id of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3', 'deepseekv4flash']) {
      const resolved = resolveModel(id);
      assert.equal(resolved.key, 'deepseek-flash', id);
      assert.equal(resolved.guessed, true, id);
      assert.equal(resolved.known, false, id);
    }
  });

  it('returns an explicit unknown result for non-DeepSeek ids', () => {
    assert.deepEqual(resolveModel('gpt-4o'), { key: null, label: 'gpt-4o', guessed: true, known: false });
    assert.deepEqual(resolveModel('claude-sonnet'), { key: null, label: 'claude-sonnet', guessed: true, known: false });
    assert.deepEqual(resolveModel(undefined), { key: null, label: '', guessed: true, known: false });
    assert.deepEqual(resolveModel('   '), { key: null, label: '', guessed: true, known: false });
    assert.deepEqual(resolveModel(123), { key: null, label: '123', guessed: true, known: false });
  });
});

/* -------------------------------------------------------------------------- */
/* Peak classification                                                        */
/* -------------------------------------------------------------------------- */

describe('peak classification (Beijing time)', () => {
  it('marks a Mon-Fri 10:00 +08:00 instant as peak', () => {
    const result = classifyInstant(bj(2026, 9, 30, 10, 0));
    assert.equal(result.peak, true);
    assert.equal(result.offPeak, false);
    assert.equal(result.reason, 'peak-window');
    assert.deepEqual(result.local, { date: '2026-09-30', weekday: 3, minutes: 600 });
    assert.equal(result.holidayDataMissing, false);
    assert.equal(result.beforePeakPolicy, false);
    assert.equal(result.beforeCurrentCard, false);
  });

  it('flips tier exactly four times across the eight second-precision edges', () => {
    const edges = [
      [8, 59, 59],
      [9, 0, 0],
      [11, 59, 59],
      [12, 0, 0],
      [13, 59, 59],
      [14, 0, 0],
      [17, 59, 59],
      [18, 0, 0],
    ];
    const tiers = edges.map(([h, mi, s]) => classifyInstant(bj(2026, 9, 30, h, mi, s)).peak);
    assert.deepEqual(tiers, [false, true, true, false, false, true, true, false]);
    assert.equal(tiers.filter(Boolean).length, 4, 'exactly four instants must be peak');
  });

  it('treats the window edges as half-open [09:00,12:00) and [14:00,18:00)', () => {
    const cases = [
      [8, 59, false, 'outside-window'],
      [9, 0, true, 'peak-window'],
      [11, 59, true, 'peak-window'],
      [12, 0, false, 'outside-window'],
      [13, 59, false, 'outside-window'],
      [14, 0, true, 'peak-window'],
      [17, 59, true, 'peak-window'],
      [18, 0, false, 'outside-window'],
      [23, 59, false, 'outside-window'],
    ];
    for (const [hour, minute, peak, reason] of cases) {
      const result = classifyInstant(bj(2026, 9, 30, hour, minute));
      assert.equal(result.peak, peak, `${hour}:${String(minute).padStart(2, '0')}`);
      assert.equal(result.reason, reason, `${hour}:${String(minute).padStart(2, '0')}`);
      assert.equal(result.offPeak, !peak);
    }
  });

  it('treats ordinary Saturday and Sunday as off-peak weekends', () => {
    for (const [d, weekday] of [[12, 6], [13, 0]]) {
      const result = classifyInstant(bj(2026, 9, d, 10, 0));
      assert.equal(result.peak, false, `2026-09-${d}`);
      assert.equal(result.reason, 'weekend', `2026-09-${d}`);
      assert.equal(result.local.weekday, weekday);
    }
  });

  it('agrees with the official UTC 01:00-04:00 / 06:00-10:00 Mon-Fri framing', () => {
    // 2026-09-29 Tue, 2026-09-30 Wed, 2026-10-08 Thu are known workdays, so the
    // holiday overlay is constant and the two window framings can be compared
    // minute by minute across all 1440 minutes of each day.
    for (const [y, mo, d] of [[2026, 9, 29], [2026, 9, 30], [2026, 10, 8]]) {
      for (let minute = 0; minute < 1440; minute += 1) {
        const ms = bj(y, mo, d, 0, minute);
        const utc = new Date(ms);
        const utcWeekday = utc.getUTCDay();
        const utcMinutes = utc.getUTCHours() * 60 + utc.getUTCMinutes();
        const utcPeak =
          utcWeekday >= 1 &&
          utcWeekday <= 5 &&
          ((utcMinutes >= 60 && utcMinutes < 240) || (utcMinutes >= 360 && utcMinutes < 600));
        const beijingPeak = (minute >= 540 && minute < 720) || (minute >= 840 && minute < 1080);
        const classified = classifyInstant(ms);
        assert.equal(classified.peak, beijingPeak, `Beijing framing at ${y}-${mo}-${d} ${minute}`);
        assert.equal(classified.peak, utcPeak, `UTC framing at ${y}-${mo}-${d} ${minute}`);
      }
    }
  });

  it('is deterministic and never consults the wall clock', () => {
    const realNow = Date.now;
    Date.now = () => {
      throw new Error('pricing.mjs must not call Date.now()');
    };
    try {
      const instant = bj(2026, 9, 30, 10, 0);
      classifyInstant(instant);
      describeInstant(instant);
      nextBoundary(instant);
      priceUsage({ inputTokens: 10, outputTokens: 10 }, 'deepseek-flash', instant);
    } finally {
      Date.now = realNow;
    }
  });

  it('describeInstant mirrors classifyInstant', () => {
    const instant = bj(2026, 10, 1, 10, 0);
    assert.deepEqual(describeInstant(instant), classifyInstant(instant));
  });
});

/* -------------------------------------------------------------------------- */
/* Holiday data and overrides                                                 */
/* -------------------------------------------------------------------------- */

describe('Chinese holiday data', () => {
  it('marks a 2026 holiday weekday as off-peak with reason holiday', () => {
    // 2026-10-01 (Thu) is inside the National Day range 10-01..10-07.
    const result = classifyInstant(bj(2026, 10, 1, 10, 0));
    assert.equal(result.peak, false);
    assert.equal(result.offPeak, true);
    assert.equal(result.reason, 'holiday');
    assert.equal(result.local.weekday, 4);
    assert.equal(result.holidayDataMissing, false);
  });

  it('covers every published 2026 holiday range, including its edges', () => {
    const holidayInstants = [
      bj(2026, 1, 1, 10, 0), // New Year
      bj(2026, 1, 3, 10, 0),
      bj(2026, 2, 15, 10, 0), // Spring Festival
      bj(2026, 2, 23, 10, 0),
      bj(2026, 4, 4, 10, 0), // Qingming
      bj(2026, 4, 6, 10, 0),
      bj(2026, 5, 1, 10, 0), // Labour Day
      bj(2026, 5, 5, 10, 0),
      bj(2026, 6, 19, 10, 0), // Dragon Boat
      bj(2026, 6, 21, 10, 0),
      bj(2026, 9, 25, 10, 0), // Mid-Autumn
      bj(2026, 9, 27, 10, 0),
      bj(2026, 10, 7, 10, 0),
    ];
    for (const instant of holidayInstants) {
      const result = classifyInstant(instant);
      assert.equal(result.reason, 'holiday', new Date(instant).toISOString());
      assert.equal(result.peak, false, new Date(instant).toISOString());
    }
  });

  it('marks 2026 makeup workdays as off-peak with reason makeup-workday', () => {
    // 09-20 Sun, 02-14 Sat, 01-04 Sun, 02-28 Sat, 05-09 Sat, 10-10 Sat
    const makeupInstants = [
      [9, 20, 0],
      [2, 14, 6],
      [1, 4, 0],
      [2, 28, 6],
      [5, 9, 6],
      [10, 10, 6],
    ];
    for (const [mo, d, weekday] of makeupInstants) {
      const result = classifyInstant(bj(2026, mo, d, 10, 0));
      assert.equal(result.local.weekday, weekday, `2026-${mo}-${d} weekday`);
      assert.equal(result.reason, 'makeup-workday', `2026-${mo}-${d}`);
      assert.equal(result.peak, false, `2026-${mo}-${d}`);
    }
  });

  it('resolves the working day after the National Day holiday at peak', () => {
    const result = classifyInstant(bj(2026, 10, 8, 9, 0));
    assert.equal(result.peak, true);
    assert.equal(result.reason, 'peak-window');
  });

  it('covers the published 2025 table, with the calendar reason winning pre-policy', () => {
    const result = classifyInstant(bj(2025, 10, 6, 10, 0)); // National Day holiday, pre-policy
    assert.equal(result.peak, false);
    assert.equal(result.beforePeakPolicy, true);
    assert.equal(result.beforeCurrentCard, true);
    assert.equal(result.holidayDataMissing, false);
    assert.equal(result.reason, 'holiday');
  });

  it('reports before-policy only for a plain pre-policy weekday inside a peak window', () => {
    const result = classifyInstant(bj(2026, 3, 4, 10, 0)); // Wednesday, not a holiday
    assert.equal(result.peak, false);
    assert.equal(result.reason, 'before-policy');
    assert.equal(result.beforePeakPolicy, true);
    assert.equal(result.beforeCurrentCard, true);
    // Outside the window the era is irrelevant to the reason.
    assert.equal(classifyInstant(bj(2026, 3, 4, 3, 0)).reason, 'outside-window');
    assert.equal(classifyInstant(bj(2026, 3, 4, 3, 0)).beforePeakPolicy, true);
    // Pre-policy holiday/makeup/weekend keep their calendar reason.
    assert.equal(classifyInstant(bj(2026, 2, 14, 10, 0)).reason, 'makeup-workday');
    assert.equal(classifyInstant(bj(2026, 1, 1, 10, 0)).reason, 'holiday');
    assert.equal(classifyInstant(bj(2026, 3, 7, 10, 0)).reason, 'weekend');
  });

  it('falls back to off-peak and flags missing data for unpublished years', () => {
    const result = classifyInstant(bj(2027, 3, 10, 10, 0)); // Wed, in a peak window
    assert.equal(result.local.weekday, 3);
    assert.equal(result.peak, false);
    assert.equal(result.offPeak, true);
    assert.equal(result.reason, 'holiday-data-missing');
    assert.equal(result.holidayDataMissing, true);
    assert.equal(result.beforePeakPolicy, false);
  });

  it('accepts a config override that adds an unpublished year', () => {
    const holidays = {
      2027: {
        holidays: [['2027-03-08', '2027-03-12'], '2027-04-05'],
        makeupWorkdays: ['2027-03-13'],
      },
    };
    const holiday = classifyInstant(bj(2027, 3, 10, 10, 0), { holidays });
    assert.equal(holiday.reason, 'holiday');
    assert.equal(holiday.holidayDataMissing, false);

    const single = classifyInstant(bj(2027, 4, 5, 10, 0), { holidays });
    assert.equal(single.reason, 'holiday');

    const makeup = classifyInstant(bj(2027, 3, 13, 10, 0), { holidays });
    assert.equal(makeup.reason, 'makeup-workday');

    const workday = classifyInstant(bj(2027, 3, 15, 10, 0), { holidays });
    assert.equal(workday.peak, true);
    assert.equal(workday.holidayDataMissing, false);
  });

  it('patches a published year without losing the bundled makeup days', () => {
    const holidays = { 2026: { holidays: [] } };
    // Holiday removed → the Thursday becomes a normal peak day.
    assert.equal(classifyInstant(bj(2026, 10, 1, 10, 0), { holidays }).peak, true);
    // Makeup list falls back to the bundled data.
    assert.equal(classifyInstant(bj(2026, 9, 20, 10, 0), { holidays }).reason, 'makeup-workday');
    // The bundled table itself is untouched.
    assert.equal(classifyInstant(bj(2026, 10, 1, 10, 0)).reason, 'holiday');
    assert.equal(classifyInstant(bj(2026, 9, 20, 10, 0)).reason, 'makeup-workday');
  });

  it('ignores malformed override entries instead of throwing', () => {
    const holidays = {
      2027: { holidays: ['not-a-date', ['2027-02-30', '2027-03-01'], 42, null], makeupWorkdays: ['bogus'] },
    };
    assert.doesNotThrow(() => classifyInstant(bj(2027, 3, 10, 10, 0), { holidays }));
    const result = classifyInstant(bj(2027, 3, 10, 10, 0), { holidays });
    assert.equal(result.holidayDataMissing, false); // year was explicitly configured
    assert.equal(result.peak, true);
  });
});

/* -------------------------------------------------------------------------- */
/* Policy epoch                                                               */
/* -------------------------------------------------------------------------- */

describe('policy epoch and current-card epoch', () => {
  it('exports both documented instants', () => {
    assert.equal(PEAK_POLICY_FROM, '2026-08-17T00:00:00+08:00');
    assert.equal(PEAK_POLICY_FROM_MS, bj(2026, 8, 17, 0, 0));
    assert.equal(RATE_CARD_EFFECTIVE_FROM, '2026-09-10T12:00:00+08:00');
    assert.equal(RATE_CARD_EFFECTIVE_FROM_MS, bj(2026, 9, 10, 12, 0, 0));
  });

  it('flags earlier instants and prices them off-peak', () => {
    const before = classifyInstant(bj(2026, 8, 14, 10, 0)); // Friday, inside a peak window
    assert.equal(before.beforePeakPolicy, true);
    assert.equal(before.peak, false);
    assert.equal(before.reason, 'before-policy');
    assert.equal(before.local.weekday, 5);
    assert.equal(before.beforeCurrentCard, true);
  });

  it('switches beforePeakPolicy exactly at the policy instant', () => {
    assert.equal(classifyInstant(PEAK_POLICY_FROM_MS - 1).beforePeakPolicy, true);
    const atPolicy = classifyInstant(PEAK_POLICY_FROM_MS);
    assert.equal(atPolicy.beforePeakPolicy, false);
    assert.equal(atPolicy.reason, 'outside-window');
    assert.equal(classifyInstant(bj(2026, 8, 17, 9, 0)).peak, true); // Monday 09:00
  });

  it('classifies normally between the policy and the current card, but flags the card', () => {
    const between = classifyInstant(bj(2026, 8, 20, 10, 0)); // Thursday, inside a peak window
    assert.equal(between.peak, true);
    assert.equal(between.beforePeakPolicy, false);
    assert.equal(between.beforeCurrentCard, true);
  });

  it('switches beforeCurrentCard exactly at 2026-09-10T12:00+08:00', () => {
    const justBefore = classifyInstant(bj(2026, 9, 10, 11, 59, 59));
    assert.equal(justBefore.beforeCurrentCard, true);
    assert.equal(justBefore.peak, true); // Thursday morning window
    assert.equal(classifyInstant(RATE_CARD_EFFECTIVE_FROM_MS - 1).beforeCurrentCard, true);
    const atBoundary = classifyInstant(bj(2026, 9, 10, 12, 0, 0));
    assert.equal(atBoundary.beforeCurrentCard, false);
    assert.equal(atBoundary.peak, false); // 12:00 is outside the window
  });

  it('sets both flags for 2025 instants', () => {
    const result = classifyInstant(bj(2025, 10, 6, 10, 0));
    assert.equal(result.beforePeakPolicy, true);
    assert.equal(result.beforeCurrentCard, true);
  });
});

/* -------------------------------------------------------------------------- */
/* nextBoundary                                                               */
/* -------------------------------------------------------------------------- */

describe('nextBoundary', () => {
  it('finds the 12:00 switch on the same day', () => {
    const result = nextBoundary(bj(2026, 9, 30, 10, 0));
    assert.deepEqual(result, { at: bj(2026, 9, 30, 12, 0), peak: false, label: 'off-peak' });
  });

  it('is strictly forward-looking and minute aligned', () => {
    // Already at the 12:00 boundary → the next flip is 14:00, not 12:00 itself.
    assert.deepEqual(nextBoundary(bj(2026, 9, 30, 12, 0)), {
      at: bj(2026, 9, 30, 14, 0),
      peak: true,
      label: 'peak',
    });
    // Mid-minute input is aligned up to the next minute.
    assert.deepEqual(nextBoundary(bj(2026, 9, 30, 10, 0) + 30_000), {
      at: bj(2026, 9, 30, 12, 0),
      peak: false,
      label: 'off-peak',
    });
  });

  it('skips the weekend when leaving Friday evening', () => {
    const result = nextBoundary(bj(2026, 9, 11, 18, 0)); // Friday 18:00 (off-peak)
    assert.deepEqual(result, { at: bj(2026, 9, 14, 9, 0), peak: true, label: 'peak' }); // Monday 09:00
  });

  it('skips the whole National Day holiday', () => {
    const result = nextBoundary(bj(2026, 10, 1, 0, 0));
    assert.deepEqual(result, { at: bj(2026, 10, 8, 9, 0), peak: true, label: 'peak' });
  });

  it('returns the first peak after the policy epoch', () => {
    const result = nextBoundary(bj(2026, 8, 14, 10, 0));
    assert.deepEqual(result, { at: bj(2026, 8, 17, 9, 0), peak: true, label: 'peak' });
  });

  it('reports at: null when no flip exists inside the 40-day horizon', () => {
    const result = nextBoundary(bj(2027, 3, 10, 10, 0)); // year without holiday data → all off-peak
    assert.equal(result.at, null);
    assert.equal(result.peak, false);
    assert.equal(result.label, 'off-peak');
  });

  it('never throws on a missing instant', () => {
    assert.doesNotThrow(() => nextBoundary());
    assert.doesNotThrow(() => nextBoundary(NaN));
  });
});

/* -------------------------------------------------------------------------- */
/* priceUsage                                                                 */
/* -------------------------------------------------------------------------- */

describe('priceUsage', () => {
  it('prices a hand-checked flash peak computation exactly', () => {
    // 0.6M cache-hit * 0.04 + 0.4M cache-miss * 2 + 0.1M output * 8 = CNY 1.624
    // (USD: 0.6M * 0.006 + 0.4M * 0.3 + 0.1M * 1.2 = USD 0.2436)
    const result = priceUsage(
      { inputTokens: 400_000, cacheReadTokens: 600_000, outputTokens: 100_000 },
      'deepseek-flash',
      bj(2026, 9, 30, 10, 0),
    );
    assert.equal(result.peak, true);
    assert.equal(result.unknownModel, false);
    assert.deepEqual(result.tokens, {
      cacheHit: 600_000,
      cacheMiss: 400_000,
      output: 100_000,
      reasoning: 0,
      total: 1_100_000,
    });
    assert.equal(result.costCny, 1.624); // exact in IEEE-754 for this bucket set
    assert.equal(result.costCny.toFixed(4), '1.6240');
    closeTo(result.costUsd, 0.2436);
    assert.equal(result.costUsd.toFixed(4), '0.2436');
    assert.deepEqual(result.ratesCny, RATE_CARD.models['deepseek-flash'].peak);
    assert.deepEqual(result.ratesUsd, RATE_CARD.models['deepseek-flash'].peakUsd);
    assertSane(result);
  });

  it('applies the published off-peak rates outside the windows', () => {
    const result = priceUsage(
      { inputTokens: 400_000, cacheReadTokens: 600_000, outputTokens: 100_000 },
      'deepseek-flash',
      bj(2026, 9, 30, 12, 0),
    );
    assert.equal(result.peak, false);
    assert.equal(result.classification.reason, 'outside-window');
    closeTo(result.costCny, 0.812);
    closeTo(result.costUsd, 0.1218);
    assert.equal(result.costCny.toFixed(3), '0.812');
    assert.deepEqual(result.ratesCny, RATE_CARD.models['deepseek-flash'].offPeak);
  });

  it('prices a real DSH usage record with disjoint buckets, exactly', () => {
    // Recorded verbatim from this machine's session.v4.jsonl.zstd logs.
    const usage = {
      inputTokens: 459,
      outputTokens: 294,
      cacheReadTokens: 10_496,
      cacheWriteTokens: 0,
      totalTokens: 11_249,
    };
    const peak = priceUsage(usage, 'deepseek-flash', bj(2026, 9, 30, 10, 0));
    assert.deepEqual(peak.tokens, {
      cacheHit: 10_496,
      cacheMiss: 459,
      output: 294,
      reasoning: 0,
      total: 11_249,
    });
    assert.equal(peak.tokens.total, usage.totalTokens);
    // 10496 * 0.04 / 1e6 + 459 * 2 / 1e6 + 294 * 8 / 1e6
    closeTo(peak.costCny, 0.00368984);
    closeTo(peak.costUsd, 0.000553476);
    assert.equal(peak.costCny.toFixed(8), '0.00368984');
    assert.equal(peak.costUsd.toFixed(9), '0.000553476');
    assertSane(peak);

    const offPeak = priceUsage(usage, 'deepseek-flash', bj(2026, 9, 30, 20, 0));
    assert.equal(offPeak.peak, false);
    closeTo(offPeak.costCny, 0.00184492);
    closeTo(offPeak.costUsd, 0.000276738);
    assert.equal(offPeak.costCny.toFixed(8), '0.00184492');
    assert.equal(offPeak.costUsd.toFixed(9), '0.000276738');
    assertSane(offPeak);
  });

  it('never yields a negative cost for non-negative bucket tuples', () => {
    const tuples = [
      { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      { inputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, outputTokens: 1 },
      { inputTokens: 1e9, cacheReadTokens: 1e9, cacheWriteTokens: 1e9, outputTokens: 1e9 },
      { inputTokens: 0.5, cacheReadTokens: 0.25, outputTokens: 0.125 },
    ];
    for (const modelId of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat']) {
      for (const instant of [bj(2026, 9, 30, 10, 0), bj(2026, 9, 30, 20, 0)]) {
        for (const usage of tuples) {
          const result = priceUsage(usage, modelId, instant);
          assert.ok(result.costCny >= 0, `${modelId} costCny=${result.costCny}`);
          assert.ok(result.costUsd >= 0, `${modelId} costUsd=${result.costUsd}`);
        }
      }
    }
  });

  it('bills cache-write tokens at the cache-miss rate', () => {
    const result = priceUsage(
      { inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 500, outputTokens: 0 },
      'deepseek-flash',
      bj(2026, 9, 30, 10, 0),
    );
    assert.equal(result.tokens.cacheHit, 0);
    assert.equal(result.tokens.cacheMiss, 1_500);
    assert.equal(result.tokens.total, 1_500);
  });

  it('never bills reasoning tokens twice', () => {
    const base = { inputTokens: 100, outputTokens: 1_000 };
    const withReasoning = priceUsage(
      { ...base, reasoningTokens: 400 },
      'deepseek-flash',
      bj(2026, 9, 30, 10, 0),
    );
    const without = priceUsage(base, 'deepseek-flash', bj(2026, 9, 30, 10, 0));
    assert.equal(withReasoning.tokens.reasoning, 400);
    assert.equal(withReasoning.tokens.output, 1_000);
    assert.equal(withReasoning.costCny, without.costCny);
  });

  it('uses v4-pro rates for v4-pro and guessed pro ids', () => {
    const usage = { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 };
    const pro = priceUsage(usage, 'deepseek-v4-pro', bj(2026, 9, 30, 10, 0));
    assert.equal(pro.costCny, 9.0);
    const guessed = priceUsage(usage, 'deepseek-v4-pro-0711', bj(2026, 9, 30, 10, 0));
    assert.equal(guessed.model.guessed, true);
    assert.equal(guessed.unknownModel, false);
    assert.equal(guessed.costCny, 9.0);
  });

  it('flags the disputed v4-pro routing but keeps pricing on the pro table', () => {
    const usage = { inputTokens: 1_000_000 };
    const before = priceUsage(usage, 'deepseek-v4-pro', bj(2026, 9, 14, 11, 59, 59)); // Monday morning
    assert.equal(before.peak, true);
    assert.equal(before.modelRoutingDisputed, false);
    assert.equal(before.costCny, 9.0);

    const atBoundary = priceUsage(usage, 'deepseek-v4-pro', bj(2026, 9, 14, 12, 0, 0));
    assert.equal(atBoundary.modelRoutingDisputed, false); // strictly after the boundary
    assert.equal(atBoundary.costCny, 4.5); // 12:00 is off-peak

    const after = priceUsage(usage, 'deepseek-v4-pro', bj(2026, 9, 15, 10, 0));
    assert.equal(after.modelRoutingDisputed, true);
    assert.equal(after.model.key, 'deepseek-v4-pro');
    assert.equal(after.peak, true);
    assert.equal(after.costCny, 9.0); // pro table — never silently switched to Flash

    assert.equal(priceUsage(usage, 'deepseek-flash', bj(2026, 9, 15, 10, 0)).modelRoutingDisputed, false);
    assert.equal(priceUsage(usage, 'gpt-4o', bj(2026, 9, 15, 10, 0)).modelRoutingDisputed, false);
    assert.equal(priceUsage(usage, 'deepseek-v4-pro', bj(2026, 9, 14, 11, 0)).modelRoutingDisputed, false);
  });

  it('mirrors beforeCurrentCard onto the priceUsage result', () => {
    const usage = { inputTokens: 1_000 };
    const preCard = priceUsage(usage, 'deepseek-flash', bj(2026, 9, 10, 11, 59, 59));
    assert.equal(preCard.beforeCurrentCard, true);
    assert.equal(preCard.beforeCurrentCard, preCard.classification.beforeCurrentCard);
    const postCard = priceUsage(usage, 'deepseek-flash', bj(2026, 9, 10, 12, 0, 0));
    assert.equal(postCard.beforeCurrentCard, false);
    assert.equal(postCard.classification.beforeCurrentCard, false);
  });

  it('never silently bills an unknown model', () => {
    const result = priceUsage(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'gpt-4o',
      bj(2026, 9, 30, 10, 0),
    );
    assert.equal(result.unknownModel, true);
    assert.equal(result.model.known, false);
    assert.equal(result.model.key, null);
    assert.equal(result.costCny, 0);
    assert.equal(result.costUsd, 0);
    assert.deepEqual(result.ratesCny, { cacheHitCny: 0, cacheMissCny: 0, outputCny: 0 });
    assert.equal(result.peak, true); // classification is still reported truthfully
    assertSane(result);
  });

  it('guesses deepseek-flash for unlisted deepseek ids but marks the guess', () => {
    const result = priceUsage({ inputTokens: 1_000_000 }, 'deepseek-chat', bj(2026, 9, 30, 10, 0));
    assert.equal(result.model.key, 'deepseek-flash');
    assert.equal(result.model.guessed, true);
    assert.equal(result.model.known, false);
    assert.equal(result.unknownModel, false);
    assert.equal(result.costCny, 2.0);
  });

  it('keeps tokens.cacheHit + cacheMiss + output === total for every usage shape', () => {
    const shapes = [
      undefined,
      null,
      {},
      { inputTokens: 459, outputTokens: 294, cacheReadTokens: 10_496, cacheWriteTokens: 0, totalTokens: 11_249 },
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 1 },
      { inputTokens: 1e12, outputTokens: 1e12, cacheReadTokens: 1e12 },
    ];
    for (const usage of shapes) {
      const { tokens } = priceUsage(usage, 'deepseek-flash', bj(2026, 9, 30, 10, 0));
      assert.equal(tokens.cacheHit + tokens.cacheMiss + tokens.output, tokens.total, JSON.stringify(usage));
      // `totalTokens` is optional — cross-check it only when the caller supplied one.
      if (usage && Number.isFinite(usage.totalTokens)) {
        assert.equal(tokens.total, usage.totalTokens, JSON.stringify(usage));
      }
    }
  });

  it('never throws and never yields NaN for malformed usage', () => {
    const shapes = [
      undefined,
      null,
      {},
      { inputTokens: NaN, outputTokens: NaN },
      { inputTokens: -5, outputTokens: -1, cacheReadTokens: -100 },
      { inputTokens: Infinity, outputTokens: -Infinity, cacheReadTokens: Infinity },
      { cacheReadTokens: 'abc', outputTokens: '12' },
      { inputTokens: '1000', cacheWriteTokens: 250 },
      { inputTokens: {}, outputTokens: [] },
    ];
    for (const usage of shapes) {
      let result;
      assert.doesNotThrow(() => {
        result = priceUsage(usage, 'deepseek-v4-pro', bj(2026, 9, 30, 10, 0));
      }, JSON.stringify(usage));
      assertSane(result);
      assert.equal(result.tokens.cacheHit + result.tokens.cacheMiss + result.tokens.output, result.tokens.total);
    }
  });

  it('is deterministic for identical inputs', () => {
    const usage = { inputTokens: 459, outputTokens: 294, cacheReadTokens: 10_496 };
    const ms = bj(2026, 9, 30, 10, 0);
    assert.deepEqual(priceUsage(usage, 'deepseek-flash', ms), priceUsage(usage, 'deepseek-flash', ms));
  });

  it('honours the holidays override when pricing', () => {
    const holidays = { 2027: { holidays: [['2027-03-08', '2027-03-12']] } };
    const result = priceUsage({ inputTokens: 1_000_000 }, 'deepseek-v4-pro', bj(2027, 3, 10, 10, 0), { holidays });
    assert.equal(result.peak, false);
    assert.equal(result.classification.reason, 'holiday');
    assert.equal(result.costCny, 4.5); // off-peak cache-miss rate
  });
});

/* -------------------------------------------------------------------------- */
/* Formatters                                                                 */
/* -------------------------------------------------------------------------- */

describe('formatters', () => {
  it('formats CNY with adaptive precision', () => {
    assert.equal(formatCny(0.004), '¥0.0040');
    assert.equal(formatCny(0.00999), '¥0.0100');
    assert.equal(formatCny(0.01), '¥0.010');
    assert.equal(formatCny(0.2436), '¥0.244');
    assert.equal(formatCny(1), '¥1.00');
    assert.equal(formatCny(1.624), '¥1.62');
    assert.equal(formatCny(0), '¥0.0000');
    assert.equal(formatCny(NaN), '¥0.0000');
    assert.equal(formatCny(undefined), '¥0.0000');
  });

  it('formats USD with adaptive precision', () => {
    assert.equal(formatUsd(0.006), '$0.0060');
    assert.equal(formatUsd(0.2436), '$0.244');
    assert.equal(formatUsd(3.96), '$3.96');
    assert.equal(formatUsd(-1), '$-1.00');
  });

  it('formats token counts compactly', () => {
    assert.equal(formatTokens(950), '950');
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(1000), '1k');
    assert.equal(formatTokens(1500), '1.5k');
    assert.equal(formatTokens(12_400), '12.4k');
    assert.equal(formatTokens(1_280_000), '1.28M');
    assert.equal(formatTokens(999_999), '1M');
    assert.equal(formatTokens(0), '0');
    assert.equal(formatTokens(-5), '0');
    assert.equal(formatTokens(NaN), '0');
  });

  it('formats priced usage end to end', () => {
    const result = priceUsage(
      { inputTokens: 400_000, cacheReadTokens: 600_000, outputTokens: 100_000 },
      'deepseek-flash',
      bj(2026, 9, 30, 10, 0),
    );
    assert.equal(formatCny(result.costCny), '¥1.62');
    assert.equal(formatUsd(result.costUsd), '$0.244');
    assert.equal(formatTokens(result.tokens.total), '1.1M');
  });
});
