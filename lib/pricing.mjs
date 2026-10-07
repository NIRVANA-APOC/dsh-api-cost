/**
 * dsh-api-cost / lib/pricing.mjs
 * DeepSeek API 峰谷计费引擎 —— DeepSeek API peak / off-peak cost engine.
 *
 * ---------------------------------------------------------------------------
 * 设计约束 / Design constraints
 * ---------------------------------------------------------------------------
 * - Pure ESM, zero dependencies, ZERO imports. This file is imported by the
 *   plugin's host half *and* by its client half, so it must stay portable.
 * - Side-effect free: importing this module must not touch the network, the
 *   clock or any global state.
 * - Deterministic: every exported function receives an explicit instant
 *   (`ms`, epoch milliseconds). This module NEVER calls `Date.now()`.
 *   Timestamps are always interpreted as Asia/Shanghai (UTC+8, no DST), which
 *   makes the arithmetic exact.
 * - All rate-card money values are **per 1,000,000 tokens**.
 *
 * ---------------------------------------------------------------------------
 * 峰谷规则 / Peak rules (Beijing time, UTC+8)
 * ---------------------------------------------------------------------------
 * An instant is PEAK if and only if all of the following hold:
 *   1. it is on/after the policy epoch (`PEAK_POLICY_FROM`);
 *   2. the +08:00 local year is present in the Chinese holiday table;
 *   3. the local date is not a public holiday (节假日);
 *   4. the local date is not a 调休 makeup workday;
 *   5. the local weekday is Mon–Fri;
 *   6. the local time-of-day is in [09:00, 12:00) or [14:00, 18:00).
 * Everything else is OFF-PEAK. The official page states the same two windows in
 * UTC as 01:00-04:00 and 06:00-10:00 Mon–Fri; the two framings are equivalent
 * because both windows live inside 01:00-10:00 UTC (asserted in the tests).
 *
 * Conservative bias: if holiday data for the local year is missing, the instant
 * resolves OFF-PEAK and `holidayDataMissing` is true. We never bill an unknown
 * day at the peak rate. 保守起见：节假日数据缺失时一律按低谷计价，绝不误收峰时高价。
 *
 * ---------------------------------------------------------------------------
 * 缓存计价 / Cache accounting
 * ---------------------------------------------------------------------------
 * DeepSeek 官方未公布单独的 cache-write 溢价 / DeepSeek publishes no separate
 * cache-write premium: cache-write tokens are therefore billed at the
 * cache-MISS rate (see `priceUsage`).
 *
 * DSH `TokenUsage` buckets are DISJOINT. DSH's own llm-streaming documentation
 * states that the counts are "disjoint: inputTokens is uncached input only;
 * cached input is reported separately … billed input is the sum of the three",
 * and that `reasoningTokens` is "informational detail already included in
 * outputTokens". So:
 *   - `inputTokens` is the UNCACHED (cache-miss) input count, NOT the provider's
 *     `prompt_tokens` total;
 *   - `cacheReadTokens` (cache hit) is NOT a subset of `inputTokens`;
 *   - `reasoningTokens` is a subset of `outputTokens` and is never billed again;
 *   - `totalTokens` is OPTIONAL; when present it equals
 *     inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens.
 * This was re-verified against 594 real usage records decoded from this
 * machine's `session.v4.jsonl.zstd` logs (2026-09-30): the identity above held
 * in every record, e.g. `{ inputTokens: 903, outputTokens: 152,
 * cacheReadTokens: 7808, cacheWriteTokens: 0, totalTokens: 8863 }`.
 * ---------------------------------------------------------------------------
 */

/** @typedef {{ cacheHit: number, cacheMiss: number, output: number, reasoning: number, total: number }} TokenBuckets */
/** @typedef {{ key: string|null, label: string, guessed: boolean, known: boolean }} ResolvedModel */
/** @typedef {'peak-window'|'weekend'|'holiday'|'makeup-workday'|'outside-window'|'holiday-data-missing'|'before-policy'} PeakReason */
/**
 * @typedef {object} Classification
 * @property {boolean} peak
 * @property {boolean} offPeak
 * @property {PeakReason} reason
 * @property {{ date: string, weekday: number, minutes: number }} local
 * @property {boolean} holidayDataMissing
 * @property {boolean} beforePeakPolicy instants before `PEAK_POLICY_FROM`
 * @property {boolean} beforeCurrentCard instants before `RATE_CARD_EFFECTIVE_FROM`
 */

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
/** Asia/Shanghai is a fixed offset (UTC+8, no DST) → plain arithmetic is exact. */
const BEIJING_OFFSET_MS = 8 * 60 * MS_PER_MINUTE;
const MINUTES_PER_DAY = 1440;

/** 上午峰时 / morning peak window: [09:00, 12:00) local. */
const PEAK_MORNING_START_MINUTE = 9 * 60;
const PEAK_MORNING_END_MINUTE = 12 * 60;
/** 下午峰时 / afternoon peak window: [14:00, 18:00) local. */
const PEAK_AFTERNOON_START_MINUTE = 14 * 60;
const PEAK_AFTERNOON_END_MINUTE = 18 * 60;

/**
 * Minute offsets inside a local day at which the peak/off-peak classification can
 * change: local midnight, the four window edges, and the next local midnight.
 */
const DAY_EDGE_MINUTES = Object.freeze([
  0,
  PEAK_MORNING_START_MINUTE,
  PEAK_MORNING_END_MINUTE,
  PEAK_AFTERNOON_START_MINUTE,
  PEAK_AFTERNOON_END_MINUTE,
  MINUTES_PER_DAY,
]);

/** `nextBoundary` scans at most this many local days forward. */
const MAX_BOUNDARY_SCAN_DAYS = 40;

/**
 * Instant the peak/off-peak scheme itself took effect (Beijing time).
 * 官方公告：新价格将于北京时间 2026 年 8 月 17 日 0 时开始生效
 * (EN: 16:00 UTC on 2026-08-16). Instants before this carry
 * `beforePeakPolicy: true` and resolve OFF-PEAK — no peak surcharge existed yet.
 * @type {string}
 */
export const PEAK_POLICY_FROM = '2026-08-17T00:00:00+08:00';

/**
 * Epoch milliseconds of {@link PEAK_POLICY_FROM} (2026-08-16T16:00:00Z).
 * @type {number}
 */
export const PEAK_POLICY_FROM_MS = Date.UTC(2026, 7, 17) - BEIJING_OFFSET_MS;

/**
 * Instant the CURRENT rate card took effect — note the mid-day boundary.
 * zh news260910: 新价格于 2026 年 9 月 10 日 12:00 开始生效 /
 * the current card started at 12:00 Beijing time on 2026-09-10. Instants before
 * this carry `beforeCurrentCard: true`: they belong to the previous card, so a
 * caller must not present today's numbers as that period's bill.
 * @type {string}
 */
export const RATE_CARD_EFFECTIVE_FROM = '2026-09-10T12:00:00+08:00';

/**
 * Epoch milliseconds of {@link RATE_CARD_EFFECTIVE_FROM} (2026-09-10T04:00:00Z).
 * @type {number}
 */
export const RATE_CARD_EFFECTIVE_FROM_MS = Date.UTC(2026, 8, 10, 12) - BEIJING_OFFSET_MS;

/* -------------------------------------------------------------------------- */
/* Rate card                                                                  */
/* -------------------------------------------------------------------------- */

/** Recursively freeze a plain data structure (keeps the published card immutable). */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * DeepSeek published rate card, per 1,000,000 tokens.
 *
 * Both tiers (`peak`, `offPeak`) and both currencies (CNY, USD) are stored
 * EXPLICITLY — never derived at runtime — so a future page edit only requires
 * touching this literal. CNY and USD are two separate published columns and the
 * conversion factor differs per model (6.666667 for flash, 6.818182 = 75/11 for
 * v4-pro), so no single global factor may be applied to the whole card.
 *
 * @type {{
 *   source: string,
 *   retrievedAt: string,
 *   currencyRelation: { note: string, factors: Record<string, number> },
 *   models: Record<string, {
 *     label: string,
 *     aliases: string[],
 *     peak: { cacheHitCny: number, cacheMissCny: number, outputCny: number },
 *     offPeak: { cacheHitCny: number, cacheMissCny: number, outputCny: number },
 *     peakUsd: { cacheHitUsd: number, cacheMissUsd: number, outputUsd: number },
 *     offPeakUsd: { cacheHitUsd: number, cacheMissUsd: number, outputUsd: number },
 *     disputedAfter?: string,
 *     dispute?: string
 *   }>
 * }}
 */
export const RATE_CARD = deepFreeze({
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  retrievedAt: '2026-09-30',
  currencyRelation: {
    note: 'CNY and USD are separate published columns and are never derived from each other; the published conversion factor is per model.',
    factors: { 'deepseek-flash': 6.666667, 'deepseek-v4-pro': 6.818182 },
  },
  models: {
    'deepseek-flash': {
      label: 'DeepSeek Flash',
      aliases: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
      peak: { cacheHitCny: 0.04, cacheMissCny: 2.0, outputCny: 8.0 },
      offPeak: { cacheHitCny: 0.02, cacheMissCny: 1.0, outputCny: 4.0 },
      peakUsd: { cacheHitUsd: 0.006, cacheMissUsd: 0.3, outputUsd: 1.2 },
      offPeakUsd: { cacheHitUsd: 0.003, cacheMissUsd: 0.15, outputUsd: 0.6 },
    },
    'deepseek-v4-pro': {
      label: 'DeepSeek V4 Pro',
      aliases: [],
      peak: { cacheHitCny: 0.3, cacheMissCny: 9.0, outputCny: 27.0 },
      offPeak: { cacheHitCny: 0.15, cacheMissCny: 4.5, outputCny: 13.5 },
      peakUsd: { cacheHitUsd: 0.044, cacheMissUsd: 1.32, outputUsd: 3.96 },
      offPeakUsd: { cacheHitUsd: 0.022, cacheMissUsd: 0.66, outputUsd: 1.98 },
      disputedAfter: '2026-09-14T12:00:00+08:00',
      dispute:
        'official sources conflict: routed-and-repriced at Flash rates vs billing unchanged (news260910 vs the 2026-09-10 changelog)',
    },
  },
});

/**
 * Cross-cutting audit notes that do not belong in a single rate row.
 *
 * The `deepseek-v4-pro` routing dispute is deliberately NOT resolved by this
 * module: pricing stays on the pro table (never silently switched to Flash) and
 * `priceUsage` reports `modelRoutingDisputed: true` for instants after the
 * boundary so the caller can surface the uncertainty.
 *
 * @type {{ disputedRouting: { model: string, disputedAfter: string, note: string } }}
 */
export const RATE_CARD_AUDIT = deepFreeze({
  disputedRouting: {
    model: 'deepseek-v4-pro',
    disputedAfter: '2026-09-14T12:00:00+08:00',
    note: 'official sources conflict: news260910 says V4 Pro requests are all routed to V4.1 Flash and billed at Flash prices, while the 2026-09-10 changelog says V4 Pro keeps serving and billing unchanged. This module bills V4 Pro from the pro table and flags the instant instead of switching rates.',
  },
});

/* -------------------------------------------------------------------------- */
/* Chinese public-holiday data (国务院办公厅 notices)                          */
/* -------------------------------------------------------------------------- */

/**
 * Bundled holiday data, compact range encoding:
 *   holidays:        `'YYYY-MM-DD'` (single day) | `[from, to]` (inclusive range)
 *   makeupWorkdays:  `'YYYY-MM-DD'` (调休上班日)
 *
 * Sources: 国办发明电〔2025〕7号 (2026) and 国办发明电〔2024〕12号 (2025).
 * 2027+ is intentionally absent: the State Council has not published it yet, and
 * inventing dates would risk over-billing. Users can patch/extend the table via
 * the `holidays` option of {@link classifyInstant}.
 */
const BUNDLED_HOLIDAYS = deepFreeze({
  2025: {
    holidays: [
      '2025-01-01',
      ['2025-01-28', '2025-02-04'],
      ['2025-04-04', '2025-04-06'],
      ['2025-05-01', '2025-05-05'],
      ['2025-05-31', '2025-06-02'],
      ['2025-10-01', '2025-10-08'],
    ],
    makeupWorkdays: ['2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11'],
  },
  2026: {
    holidays: [
      ['2026-01-01', '2026-01-03'],
      ['2026-02-15', '2026-02-23'],
      ['2026-04-04', '2026-04-06'],
      ['2026-05-01', '2026-05-05'],
      ['2026-06-19', '2026-06-21'],
      ['2026-09-25', '2026-09-27'],
      ['2026-10-01', '2026-10-07'],
    ],
    makeupWorkdays: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'],
  },
});

/** @type {Map<number, { holidays: Array<[number, number]>, makeup: Set<number>, rawHolidays: unknown[], rawMakeup: unknown[] }>} */
const DEFAULT_YEAR_TABLE = new Map(
  Object.entries(BUNDLED_HOLIDAYS).map(([year, entry]) => [Number(year), parseYearEntry(entry)]),
);

/** Cache of parsed override tables, keyed by the caller's `options.holidays` object. */
const OVERRIDE_YEAR_CACHE = new WeakMap();

/**
 * Parse `'YYYY-MM-DD'` into a local-day index (days since 1970-01-01 in +08:00).
 * Returns null for anything malformed so bad config can never throw.
 * @param {unknown} value
 * @returns {number|null}
 */
function parseDay(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(utc)) return null;
  const probe = new Date(utc);
  // Reject impossible dates (e.g. 2026-02-30) and 2-digit years that Date.UTC shifted.
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return Math.floor(utc / MS_PER_DAY);
}

/**
 * Normalize one year entry into day-index ranges.
 * @param {{ holidays?: unknown, makeupWorkdays?: unknown }} entry
 */
function parseYearEntry(entry) {
  const rawHolidays = Array.isArray(entry?.holidays) ? entry.holidays : [];
  const rawMakeup = Array.isArray(entry?.makeupWorkdays) ? entry.makeupWorkdays : [];

  /** @type {Array<[number, number]>} */
  const holidays = [];
  for (const item of rawHolidays) {
    if (typeof item === 'string') {
      const day = parseDay(item);
      if (day !== null) holidays.push([day, day]);
      continue;
    }
    if (Array.isArray(item) && item.length >= 2) {
      const from = parseDay(item[0]);
      const to = parseDay(item[1]);
      if (from !== null && to !== null) holidays.push(from <= to ? [from, to] : [to, from]);
    }
  }

  /** @type {Set<number>} */
  const makeup = new Set();
  for (const item of rawMakeup) {
    const day = parseDay(item);
    if (day !== null) makeup.add(day);
  }

  return { holidays, makeup, rawHolidays, rawMakeup };
}

/**
 * Effective holiday entry for a local year, honoring `options.holidays`.
 *
 * Override semantics (so the plugin config can PATCH the bundled data):
 *   `{ 2027: { holidays: [...], makeupWorkdays: [...] } }`
 * - a provided year replaces/extends the bundled entry for that year;
 * - a missing key inside the year entry falls back to the bundled list (so you
 *   can patch only `holidays` and keep the bundled 调休 days);
 * - a year entry with neither key is ignored (the year stays "missing").
 *
 * @param {number} year local (+08:00) calendar year
 * @param {any} options
 * @returns {{ holidays: Array<[number, number]>, makeup: Set<number>, rawHolidays: unknown[], rawMakeup: unknown[] }|null}
 */
function yearEntryFor(year, options) {
  const overrides = options && typeof options === 'object' ? options.holidays : undefined;
  if (!overrides || typeof overrides !== 'object') return DEFAULT_YEAR_TABLE.get(year) ?? null;

  let cache = OVERRIDE_YEAR_CACHE.get(overrides);
  if (!cache) {
    cache = new Map();
    OVERRIDE_YEAR_CACHE.set(overrides, cache);
  }
  if (cache.has(year)) return cache.get(year);

  const provided = overrides[year] ?? overrides[String(year)];
  const base = DEFAULT_YEAR_TABLE.get(year) ?? null;
  let entry = base;

  if (provided && typeof provided === 'object' && (provided.holidays !== undefined || provided.makeupWorkdays !== undefined)) {
    entry = parseYearEntry({
      holidays: provided.holidays !== undefined ? provided.holidays : base?.rawHolidays ?? [],
      makeupWorkdays: provided.makeupWorkdays !== undefined ? provided.makeupWorkdays : base?.rawMakeup ?? [],
    });
  }

  cache.set(year, entry);
  return entry;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function pad(value, width) {
  return String(value).padStart(width, '0');
}

/**
 * Resolve an explicit instant. `ms` wins; if it is not a finite number the
 * caller may pass `options.now` (number or Date). Never falls back to the real
 * clock — the last resort is the Unix epoch (0), which is deterministic.
 * @param {unknown} ms
 * @param {any} options
 * @returns {number}
 */
function toInstantMs(ms, options) {
  if (ms instanceof Date) {
    const time = ms.getTime();
    if (Number.isFinite(time)) return time;
  } else {
    const direct = typeof ms === 'number' ? ms : Number(ms);
    if (Number.isFinite(direct)) return direct;
  }
  const fallback = options && typeof options === 'object' ? options.now : undefined;
  if (fallback instanceof Date) {
    const time = fallback.getTime();
    if (Number.isFinite(time)) return time;
  }
  const numeric = Number(fallback);
  return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * Split an instant into Beijing (+08:00) civil parts.
 * @param {number} instant
 */
function localParts(instant) {
  const shifted = instant + BEIJING_OFFSET_MS;
  const date = new Date(shifted);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return {
    year,
    date: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`,
    weekday: date.getUTCDay(), // 0 = Sunday … 6 = Saturday
    minutes: date.getUTCHours() * 60 + date.getUTCMinutes(), // 0..1439
    dayIndex: Math.floor(shifted / MS_PER_DAY),
  };
}

/** @param {number} minutes */
function isPeakWindowMinutes(minutes) {
  return (
    (minutes >= PEAK_MORNING_START_MINUTE && minutes < PEAK_MORNING_END_MINUTE) ||
    (minutes >= PEAK_AFTERNOON_START_MINUTE && minutes < PEAK_AFTERNOON_END_MINUTE)
  );
}

/**
 * Sanitize one token count: non-finite, negative and non-numeric values → 0.
 * @param {unknown} value
 * @returns {number}
 */
function tokenCount(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * Normalize a DSH `TokenUsage` into the three DISJOINT billed buckets.
 * See the module header for the verified `totalTokens` identity.
 * @param {unknown} usage
 * @returns {TokenBuckets}
 */
function normalizeUsage(usage) {
  const source = usage && typeof usage === 'object' ? usage : {};
  const cacheHit = tokenCount(source.cacheReadTokens);
  const cacheWrite = tokenCount(source.cacheWriteTokens);
  const cacheMiss = tokenCount(source.inputTokens) + cacheWrite;
  const output = tokenCount(source.outputTokens);
  const reasoning = tokenCount(source.reasoningTokens);
  return { cacheHit, cacheMiss, output, reasoning, total: cacheHit + cacheMiss + output };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a model id to a rate-card key.
 *
 * Resolution order:
 *   1. exact rate-card key (case-insensitive) → `known: true, guessed: false`;
 *   2. declared legacy alias (`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`)
 *      → `known: true, guessed: false`;
 *   3. heuristic: contains `deepseek` and (`v4-pro` or `pro`) → `deepseek-v4-pro`,
 *      otherwise contains `deepseek` → `deepseek-flash`;
 *      heuristic matches are `known: false, guessed: true` (they are billed, but
 *      the caller may want to surface the guess in the UI);
 *   4. anything else → `{ key: null, label: <input>, guessed: true, known: false }`,
 *      i.e. an explicit unknown result that is never silently billed.
 *
 * @param {unknown} modelId
 * @returns {ResolvedModel}
 */
export function resolveModel(modelId) {
  const raw = modelId === null || modelId === undefined ? '' : String(modelId);
  const id = raw.trim();
  const lower = id.toLowerCase();
  const models = RATE_CARD.models;

  if (Object.prototype.hasOwnProperty.call(models, lower)) {
    return { key: lower, label: models[lower].label, guessed: false, known: true };
  }

  for (const key of Object.keys(models)) {
    const entry = models[key];
    if (entry.aliases.some((alias) => alias.toLowerCase() === lower)) {
      return { key, label: entry.label, guessed: false, known: true };
    }
  }

  if (lower.includes('deepseek')) {
    const key = lower.includes('v4-pro') || lower.includes('pro') ? 'deepseek-v4-pro' : 'deepseek-flash';
    return { key, label: models[key].label, guessed: true, known: false };
  }

  return { key: null, label: id, guessed: true, known: false };
}

/**
 * Classify an instant as peak or off-peak (Beijing time).
 *
 * The result carries two independent epoch flags: `beforePeakPolicy` (before
 * {@link PEAK_POLICY_FROM}, which also forces OFF-PEAK) and `beforeCurrentCard`
 * (before {@link RATE_CARD_EFFECTIVE_FROM} — the classification is still
 * computed, but the caller must not present today's prices as that bill).
 *
 * @param {number|Date} ms explicit instant (epoch ms); falls back to
 *   `options.now` only when `ms` is not a finite number. Never uses the wall clock.
 * @param {{ holidays?: Record<string|number, { holidays?: Array<string|[string,string]>, makeupWorkdays?: string[] }>, now?: number|Date }} [options]
 *   `holidays` patches/extends the bundled Chinese holiday table (keyed by year);
 *   `now` supplies a fallback instant.
 * @returns {Classification}
 */
export function classifyInstant(ms, options) {
  const instant = toInstantMs(ms, options);
  const local = localParts(instant);
  const beforePeakPolicy = instant < PEAK_POLICY_FROM_MS;
  const beforeCurrentCard = instant < RATE_CARD_EFFECTIVE_FROM_MS;
  const entry = yearEntryFor(local.year, options);
  const holidayDataMissing = entry === null;
  const isWorkday = local.weekday >= 1 && local.weekday <= 5;
  const inWindow = isPeakWindowMinutes(local.minutes);
  const isHoliday =
    !holidayDataMissing && entry.holidays.some(([from, to]) => local.dayIndex >= from && local.dayIndex <= to);
  const isMakeup = !holidayDataMissing && entry.makeup.has(local.dayIndex);

  let peak = false;
  /** @type {PeakReason} */
  let reason;

  // Reason precedence (most specific first):
  //   before-policy (only when the instant IS a peak window but the era forbids
  //   peak) > holiday-data-missing > holiday > makeup-workday > weekend
  //   > peak-window > outside-window.
  // The era therefore only chooses between 'peak-window' and 'before-policy'
  // inside the window branch; `beforePeakPolicy` / `beforeCurrentCard` carry the
  // era information independently.
  if (beforePeakPolicy && isWorkday && inWindow && !isHoliday && !isMakeup && !holidayDataMissing) {
    // 峰谷计价尚未实施：按当前规则本应峰时，但当时无峰时加价
    // Would be peak under today's rules, but no peak scheme existed yet.
    reason = 'before-policy';
  } else if (holidayDataMissing) {
    // 无节假日数据 → 保守按低谷 / missing data → never bill at peak.
    reason = 'holiday-data-missing';
  } else if (isHoliday) {
    reason = 'holiday';
  } else if (isMakeup) {
    reason = 'makeup-workday';
  } else if (!isWorkday) {
    reason = 'weekend';
  } else if (inWindow && !beforePeakPolicy) {
    peak = true;
    reason = 'peak-window';
  } else {
    reason = 'outside-window';
  }

  return {
    peak,
    offPeak: !peak,
    reason,
    local: { date: local.date, weekday: local.weekday, minutes: local.minutes },
    holidayDataMissing,
    beforePeakPolicy,
    beforeCurrentCard,
  };
}

/**
 * Human-readable alias of {@link classifyInstant} (same contract and result).
 *
 * @param {number|Date} ms
 * @param {{ holidays?: object, now?: number|Date }} [options]
 * @returns {Classification}
 */
export function describeInstant(ms, options) {
  return classifyInstant(ms, options);
}

/**
 * Find the next instant at which the peak/off-peak classification flips.
 *
 * Scans forward at most 40 local days, minute-aligned, over the candidate edges
 * (local midnight + the four window edges), which is where a flip can occur.
 * `peak`/`label` describe the state AT `at` (after the flip). When no flip
 * exists inside the horizon — e.g. a year with no holiday data is off-peak all
 * the way — `at` is `null` and `peak`/`label` repeat the current state.
 *
 * @param {number|Date} ms explicit instant (epoch ms)
 * @param {{ holidays?: object, now?: number|Date }} [options]
 * @returns {{ at: number|null, peak: boolean, label: 'peak'|'off-peak' }}
 */
export function nextBoundary(ms, options) {
  const instant = toInstantMs(ms, options);
  const current = classifyInstant(instant, options);
  const currentPeak = current.peak;
  const state = (peak) => ({ at: null, peak, label: peak ? 'peak' : 'off-peak' });

  const aligned = Math.ceil(instant / MS_PER_MINUTE) * MS_PER_MINUTE;
  const firstMs = aligned > instant ? aligned : aligned + MS_PER_MINUTE;
  if (!Number.isFinite(firstMs)) return state(currentPeak);

  const baseDayIndex = Math.floor((firstMs + BEIJING_OFFSET_MS) / MS_PER_DAY);

  for (let offset = 0; offset <= MAX_BOUNDARY_SCAN_DAYS; offset += 1) {
    const dayStartMs = (baseDayIndex + offset) * MS_PER_DAY - BEIJING_OFFSET_MS;
    for (const minute of DAY_EDGE_MINUTES) {
      // Never step past the end of the 40-day horizon.
      if (offset === MAX_BOUNDARY_SCAN_DAYS && minute === MINUTES_PER_DAY) continue;
      const at = dayStartMs + minute * MS_PER_MINUTE;
      if (at < firstMs) continue;
      const found = classifyInstant(at, options);
      if (found.peak !== currentPeak) {
        return { at, peak: found.peak, label: found.peak ? 'peak' : 'off-peak' };
      }
    }
  }

  return state(currentPeak);
}

/** Zero-rate rows used when a model id cannot be resolved (never silently billed). */
const ZERO_RATES_CNY = deepFreeze({ cacheHitCny: 0, cacheMissCny: 0, outputCny: 0 });
const ZERO_RATES_USD = deepFreeze({ cacheHitUsd: 0, cacheMissUsd: 0, outputUsd: 0 });

/**
 * Parse a rate row's optional `disputedAfter` boundary into epoch ms.
 * @param {{ disputedAfter?: string }|null} card
 * @returns {number|null}
 */
function disputedAfterMs(card) {
  if (!card || typeof card.disputedAfter !== 'string') return null;
  const parsed = Date.parse(card.disputedAfter);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Cost of one usage snapshot in a single currency.
 * @param {TokenBuckets} tokens
 * @param {number} hitRate per 1M tokens
 * @param {number} missRate per 1M tokens
 * @param {number} outputRate per 1M tokens
 */
function costOf(tokens, hitRate, missRate, outputRate) {
  const value =
    (tokens.cacheHit / 1e6) * hitRate + (tokens.cacheMiss / 1e6) * missRate + (tokens.output / 1e6) * outputRate;
  return Number.isFinite(value) ? value : 0;
}

/**
 * Price one DSH `TokenUsage` snapshot.
 *
 * 令牌口径 / Token buckets (verified against real DSH session logs — the buckets
 * are DISJOINT and `totalTokens` is their sum):
 *   `cacheHit  = max(0, cacheReadTokens  ?? 0)`   ← 缓存命中 / cache read
 *   `cacheMiss = max(0, inputTokens ?? 0) + max(0, cacheWriteTokens ?? 0)`
 *                                                 ← 未命中 + 缓存写入（写入按未命中计价，
 *                                                   DeepSeek 未公布独立写入溢价）
 *   `output    = max(0, outputTokens ?? 0)`
 *   `reasoning = max(0, reasoningTokens ?? 0)`    ← output 的子集，不重复计费
 *   `total     = cacheHit + cacheMiss + output`
 * Note: `inputTokens` is the UNCACHED input count, not the provider's
 * `prompt_tokens` total. Every field is guarded against non-finite/negative
 * input, so malformed usage never throws and never yields NaN.
 *
 * Unknown model ids resolve to zero rates and `unknownModel: true`; guessed ids
 * are billed against the guessed model (check `model.guessed` before trusting).
 *
 * `modelRoutingDisputed` is true when the resolved model's rate row declares a
 * `disputedAfter` boundary and the instant is strictly after it (currently only
 * `deepseek-v4-pro` after 2026-09-14T12:00+08:00, where official sources
 * conflict about routing/billing). Pricing stays on the declared table — we
 * never silently switch to Flash rates — and the caller surfaces the flag.
 *
 * @param {unknown} usage DSH `TokenUsage`
 * @param {unknown} modelId
 * @param {number|Date} ms explicit instant used for peak/off-peak pricing
 * @param {{ holidays?: object, now?: number|Date }} [options]
 * @returns {{
 *   model: ResolvedModel,
 *   peak: boolean,
 *   classification: Classification,
 *   tokens: TokenBuckets,
 *   costCny: number,
 *   costUsd: number,
 *   ratesCny: { cacheHitCny: number, cacheMissCny: number, outputCny: number },
 *   ratesUsd: { cacheHitUsd: number, cacheMissUsd: number, outputUsd: number },
 *   unknownModel: boolean,
 *   modelRoutingDisputed: boolean,
 *   beforeCurrentCard: boolean
 * }}
 */
export function priceUsage(usage, modelId, ms, options) {
  const instant = toInstantMs(ms, options);
  const model = resolveModel(modelId);
  const classification = classifyInstant(instant, options);
  const peak = classification.peak;
  const tokens = normalizeUsage(usage);

  const card = model.key === null ? null : RATE_CARD.models[model.key] ?? null;
  const ratesCny = card ? (peak ? card.peak : card.offPeak) : ZERO_RATES_CNY;
  const ratesUsd = card ? (peak ? card.peakUsd : card.offPeakUsd) : ZERO_RATES_USD;
  const disputeBoundary = disputedAfterMs(card);

  return {
    model,
    peak,
    classification,
    tokens,
    costCny: costOf(tokens, ratesCny.cacheHitCny, ratesCny.cacheMissCny, ratesCny.outputCny),
    costUsd: costOf(tokens, ratesUsd.cacheHitUsd, ratesUsd.cacheMissUsd, ratesUsd.outputUsd),
    ratesCny,
    ratesUsd,
    unknownModel: card === null,
    modelRoutingDisputed: disputeBoundary !== null && instant > disputeBoundary,
    // Convenience mirror of `classification.beforeCurrentCard` for callers that
    // fold priced entries into a ledger without carrying the whole classification.
    beforeCurrentCard: classification.beforeCurrentCard,
  };
}

/**
 * Adaptive-precision amount formatter.
 * < 0.01 → 4 decimals, < 1 → 3 decimals, otherwise 2. Non-finite → 0.
 * @param {unknown} value
 * @returns {string}
 */
function formatAmount(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  const safe = Number.isFinite(numeric) ? numeric : 0;
  const magnitude = Math.abs(safe);
  const digits = magnitude < 0.01 ? 4 : magnitude < 1 ? 3 : 2;
  return safe.toFixed(digits);
}

/**
 * Format a CNY amount for display, e.g. `¥0.0040`, `¥0.243`, `¥1.62`.
 * @param {unknown} value
 * @returns {string}
 */
export function formatCny(value) {
  return `¥${formatAmount(value)}`;
}

/**
 * Format a USD amount for display, e.g. `$0.0030`, `$0.244`, `$3.96`.
 * @param {unknown} value
 * @returns {string}
 */
export function formatUsd(value) {
  return `$${formatAmount(value)}`;
}

/** Strip trailing zeros from a fixed-precision string (`1.00` → `1`, `12.40` → `12.4`). */
function trimTrailingZeros(text) {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * Format a token count compactly: `950`, `12.4k`, `1.28M`.
 * Values below 1 keep one decimal at k-scale and two at M-scale; trailing zeros
 * are trimmed. Non-finite/negative → `0`.
 * @param {unknown} value
 * @returns {string}
 */
export function formatTokens(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '0';
  if (numeric < 1000) return String(Math.round(numeric));
  if (numeric < 1e6) {
    const thousands = numeric / 1000;
    // Promote 999.95k+ to the M scale so we never print "1000k".
    if (thousands < 999.95) return `${trimTrailingZeros(thousands.toFixed(1))}k`;
  }
  return `${trimTrailingZeros((numeric / 1e6).toFixed(2))}M`;
}
