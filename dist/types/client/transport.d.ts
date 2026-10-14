import type { CostView, Coverage, GateView, LedgerView, PricingView, Scope, Totals } from '../shared/contracts.js';
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
/** The off-peak gate control surface: exact enums, non-negative counters, nullable instants. */
export declare function validGateView(v: unknown): v is GateView;
/** v2 transport: cost, pricing and gate reads, plus the single gate mutation. */
export declare class CostTransport {
    private readonly fetcher;
    constructor(fetcher?: Fetcher);
    private get;
    private post;
    view(sessionId: string, scope: Scope, detail: Detail, signal: AbortSignal): Promise<CostView>;
    pricing(signal: AbortSignal): Promise<PricingView>;
    gate(signal: AbortSignal): Promise<GateView>;
    /** The one mutation: the published value is the host's answer, never the request's. */
    setGate(enabled: boolean, signal: AbortSignal): Promise<GateView>;
}
