export declare const PACKAGE_NAME: "dsh-api-cost";
export declare const PROJECTION_KEY: "apiCost";
export declare const API_PREFIX: "/dsh-api-cost/v2";
export declare const SCHEMA_VERSION: 2;
export type Scope = 'auto' | 'self' | 'tree' | 'team';
export type EffectiveScope = Exclude<Scope, 'auto'>;
export type ModelKey = 'deepseek-flash' | 'deepseek-v4-pro';
export type Decimal = string;
export type IssueCode = 'unknown-model' | 'invalid-usage' | 'missing-usage' | 'holiday-data-missing' | 'before-rate-card' | 'routing-disputed' | 'session-unavailable' | 'scope-unavailable' | 'scope-truncated';
export interface Money {
    readonly cny: Decimal;
    readonly usd: Decimal;
}
export interface Tokens {
    readonly cacheHit: Decimal;
    readonly cacheMiss: Decimal;
    readonly output: Decimal;
    readonly reasoning: Decimal;
    readonly total: Decimal;
}
export interface Totals {
    readonly calls: number;
    readonly attempts: number;
    readonly unpricedCalls: number;
    readonly money: Money;
    readonly tokens: Tokens;
    readonly periods: {
        readonly peak: Money;
        readonly offPeak: Money;
    };
}
export interface Coverage {
    readonly status: 'complete' | 'partial' | 'unavailable';
    readonly issues: readonly IssueCode[];
    readonly failedSessions: number;
    readonly omittedSessions: number;
}
export interface ModelBreakdown {
    readonly model: ModelKey | 'unknown';
    readonly totals: Totals;
}
export interface RecentCall {
    readonly seq: number;
    readonly at: number;
    readonly model: string;
    readonly kind: 'message' | 'interrupted' | 'attempt';
    readonly money: Money;
    readonly tokens: Tokens;
    readonly peak: boolean;
    readonly issues: readonly IssueCode[];
}
/** A bounded whole value. The framework owns delivery and watermark ordering. */
export interface LedgerView {
    readonly revision: string;
    readonly totals: Totals;
    readonly byModel: readonly ModelBreakdown[];
    readonly recent: readonly RecentCall[];
    readonly coverage: Coverage;
}
export interface MemberView {
    readonly sessionId: string;
    readonly name: string;
    readonly role: 'lead' | 'teammate' | 'session';
    readonly money: Money;
    readonly ownMoney: Money;
}
export interface CostView {
    readonly schemaVersion: 2;
    readonly sessionId: string;
    readonly rootSessionId: string;
    readonly scope: EffectiveScope;
    readonly revision: string;
    readonly total: Totals;
    readonly own: Totals;
    readonly others: Totals;
    readonly coverage: Coverage;
    readonly sessionCount: number;
    readonly byModel?: readonly ModelBreakdown[];
    readonly recent?: readonly RecentCall[];
    readonly members?: readonly MemberView[];
}
export interface Rates {
    readonly cacheHit: Decimal;
    readonly cacheMiss: Decimal;
    readonly output: Decimal;
}
export interface ModelRates {
    readonly label: string;
    readonly peak: {
        readonly cny: Rates;
        readonly usd: Rates;
    };
    readonly offPeak: {
        readonly cny: Rates;
        readonly usd: Rates;
    };
}
export interface PricingView {
    readonly schemaVersion: 2;
    readonly revision: string;
    readonly now: number;
    readonly validUntil: number;
    readonly peak: boolean;
    readonly reason: string;
    readonly next: {
        readonly at: number;
        readonly peak: boolean;
    } | null;
    readonly issues: readonly IssueCode[];
    readonly rateCard: Readonly<Record<ModelKey, ModelRates>>;
    readonly source: string;
    readonly effectiveFrom: string;
}
export type HolidayRange = string | readonly [string, string];
export type HolidayOverrides = Readonly<Record<string, {
    readonly holidays?: readonly HolidayRange[] | undefined;
    readonly makeupWorkdays?: readonly HolidayRange[] | undefined;
}>>;
export interface PluginConfig {
    readonly holidays?: HolidayOverrides | undefined;
    readonly defaultScope?: Scope | undefined;
    readonly tool?: boolean | undefined;
    readonly command?: boolean | undefined;
}
export interface ApiError {
    readonly ok: false;
    readonly code: string;
    readonly message: string;
}
