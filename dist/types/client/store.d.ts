import type { CostView, PricingView } from '../shared/contracts.js';
import { CostTransport } from './transport.js';
export interface Scheduler {
    now(): number;
    later(callback: () => void, milliseconds: number): () => void;
}
export interface Visibility {
    visible(): boolean;
    subscribe(listener: () => void): () => void;
}
export interface ViewState {
    readonly view: CostView | null;
    readonly loading: boolean;
    readonly error: string | null;
}
export interface PricingState {
    readonly pricing: PricingView | null;
    readonly loading: boolean;
    readonly error: string | null;
}
export interface Observation {
    readonly running: boolean;
    readonly projectionReady: boolean;
    readonly projectionRevision: string;
    readonly catalogRevision: string;
    readonly catalogProjectionRevision: string;
}
/** A small HTTP bridge for scope discovery/cross-session views. Native own projections never live here. */
export declare class CostStore {
    private readonly entries;
    private stopVisibility;
    private disposed;
    readonly pricing: PricingStore;
    private readonly transport;
    private readonly clock;
    private readonly page;
    constructor(transport?: CostTransport, clock?: Scheduler, page?: Visibility);
    private entry;
    snapshot(sessionId: string): ViewState;
    subscribe(sessionId: string, listener: () => void): () => void;
    observe(sessionId: string, observation: Observation): void;
    /** Full detail is acquired only for an actually opened panel. Multiple seats share the flight. */
    open(sessionId: string): () => void;
    /** Refresh is GET-only; force replaces even a same-session in-flight request. */
    refresh(sessionId: string, force?: boolean): Promise<void>;
    private active;
    private publish;
    private stopPoll;
    private abort;
    private needsPolling;
    private schedule;
    private invalidate;
    private refreshEntry;
    private visibilityChanged;
    dispose(): void;
}
/** Pricing refreshes at its validity boundary, never on a recurring ticker. */
export declare class PricingStore {
    private state;
    private readonly listeners;
    private controller;
    private flight;
    private generation;
    private boundary;
    private deadline;
    private stopVisibility;
    private disposed;
    private readonly transport;
    private readonly clock;
    private readonly page;
    constructor(transport?: CostTransport, clock?: Scheduler, page?: Visibility);
    snapshot: () => PricingState;
    subscribe: (listener: () => void) => (() => void);
    private publish;
    private cancel;
    private ensure;
    private schedule;
    refresh: () => Promise<void>;
    dispose(): void;
}
