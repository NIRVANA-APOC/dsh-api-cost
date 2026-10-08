import type { HolidayOverrides, IssueCode, ModelKey, ModelRates, PricingView } from '../shared/contracts.js';
export type { HolidayOverrides, IssueCode, ModelKey, PricingView } from '../shared/contracts.js';
export interface NormalizedTokens {
    readonly cacheHit: bigint;
    readonly cacheMiss: bigint;
    readonly output: bigint;
    /** Informational subset of output; never charged a second time. */
    readonly reasoning: bigint;
    readonly total: bigint;
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
    readonly model: ModelKey | null;
    readonly modelId: string;
    readonly peak: boolean;
    readonly moneyNano: {
        readonly cny: bigint;
        readonly usd: bigint;
    };
    readonly tokens: NormalizedTokens;
    readonly issues: readonly IssueCode[];
}
export interface PricingEngine {
    /** Canonical static data, not a hash. The host owns the stateVersion hash. */
    readonly fingerprint: string;
    price(usage: unknown, model: unknown, at: number): PricedUsage;
    status(now: number): PricingView;
}
export declare const PEAK_POLICY_FROM = "2026-08-17T00:00:00+08:00";
export declare const PEAK_POLICY_FROM_MS: number;
export declare const RATE_CARD_EFFECTIVE_FROM = "2026-09-10T12:00:00+08:00";
export declare const RATE_CARD_EFFECTIVE_FROM_MS: number;
export declare const ROUTING_DISPUTED_AFTER = "2026-09-14T12:00:00+08:00";
export declare const ROUTING_DISPUTED_AFTER_MS: number;
/** No Number conversions, rounding, exponent notation, or locale formatting. */
export declare function nanoToDecimal(value: bigint): string;
/** Strict signed base-10 decimal, at most nine fractional digits. */
export declare function decimalToNano(value: string): bigint;
/** Published columns are independent literals, NOT a currency exchange rate. */
export declare const RATE_CARD: Readonly<Record<ModelKey, ModelRates>>;
export declare const RATE_CARD_AUDIT: {
    source: string;
    retrievedAt: string;
    effectiveFrom: string;
    currencyRelation: {
        note: string;
        publishedFactors: {
            'deepseek-flash': string;
            'deepseek-v4-pro': string;
        };
    };
    aliases: {
        'deepseek-flash': string[];
        'deepseek-v4-pro': never[];
    };
    disputedRouting: {
        model: string;
        disputedAfter: string;
        note: string;
    };
    holidaySources: string[];
};
export declare const BUNDLED_HOLIDAYS: HolidayOverrides;
export declare function createPricingEngine(holidays?: HolidayOverrides): PricingEngine;
