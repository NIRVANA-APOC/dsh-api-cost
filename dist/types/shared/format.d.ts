export declare function isMoneyString(value: unknown): value is string;
export declare function isTokenString(value: unknown): value is string;
/** Adaptive currency precision; an absent/invalid amount is not a zero. */
export declare function moneyString(value: string | null | undefined, currency?: 'cny' | 'usd'): string;
/** Group exact counts below 10k, compact larger counts without Infinity. */
export declare function tokenString(value: string | null | undefined): string;
export declare function countdownString(ms: number): string;
