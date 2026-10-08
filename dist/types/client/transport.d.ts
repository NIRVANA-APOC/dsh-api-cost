import type { CostView, Coverage, LedgerView, PricingView, Scope, Totals } from '../shared/contracts.js';
export type Detail = 'summary' | 'full';
export interface HttpResponse {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
}
export type Fetcher = (url: string, options: RequestInit) => Promise<HttpResponse>;
export declare const validCoverage: (v: unknown) => v is Coverage;
export declare const validTotals: (v: unknown) => v is Totals;
export declare function validLedger(v: unknown): v is LedgerView;
export declare function validCostView(v: unknown): v is CostView;
export declare function validPricingView(v: unknown): v is PricingView;
/** GET-only v2 transport: no billing, replay, reconcile, or legacy DTO adapters. */
export declare class CostTransport {
    private readonly fetcher;
    constructor(fetcher?: Fetcher);
    private get;
    view(sessionId: string, scope: Scope, detail: Detail, signal: AbortSignal): Promise<CostView>;
    pricing(signal: AbortSignal): Promise<PricingView>;
}
