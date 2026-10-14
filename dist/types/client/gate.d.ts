import type { GateView } from '../shared/contracts.js';
import { CostTransport } from './transport.js';
import type { Scheduler, Visibility } from './store.js';
/** The snapshot `useSyncExternalStore` reads. Identity is stable between publishes. */
export interface GateStoreState {
    /** Last server-confirmed view. `null` until one read has succeeded, and kept on every later failure. */
    readonly gate: GateView | null;
    /** A read is in flight. */
    readonly loading: boolean;
    /** A write is in flight; the switch is frozen until the host answers. */
    readonly saving: boolean;
    /** Last failure, or `null`. Never used as a substitute for state. */
    readonly error: string | null;
}
/**
 * The client's mirror of the off-peak gate (`src/host/gate.ts`).
 *
 * It is not a second source of truth: every value it publishes came back from
 * the host, a failed read keeps the last confirmed value, and a failed write
 * keeps the previous flag. The two things this store adds are the cadence the
 * panel needs (re-read at the next tier boundary, and every 2 s while requests
 * are actually parked) and a visibility pause, both copied from `PricingStore`.
 *
 * The hold itself lives in the host process: this store only observes it, so a
 * closed panel, a hidden tab or a disposed plugin can never release or invent a
 * parked request.
 */
export declare class GateStore {
    private state;
    private readonly listeners;
    private controller;
    private flight;
    private generation;
    private boundary;
    private poll;
    private deadline;
    private stopVisibility;
    private disposed;
    private readonly transport;
    private readonly clock;
    private readonly page;
    constructor(transport?: CostTransport, clock?: Scheduler, page?: Visibility);
    snapshot: () => GateStoreState;
    subscribe: (listener: () => void) => (() => void);
    /**
     * The only mutation. Optimistic-free: the switch holds its last confirmed
     * value until the host returns the view it actually stored, so the panel can
     * never claim a flag the host did not accept.
     */
    setEnabled: (enabled: boolean) => Promise<void>;
    dispose(): void;
    private publish;
    private cancel;
    /** A view that describes an instant already past must be re-read, not trusted. */
    private stale;
    private ensure;
    refresh: () => Promise<void>;
    /**
     * Exactly two timers, never both idle while something is pending:
     *   * the boundary — the earlier of the next tier change and the hold release;
     *   * the poll — 2 s only while a request is really parked (the count and the
     *     hold duration move), 15 s while peak holds nothing, and never while the
     *     document is hidden or the gate is `off`/`open`.
     */
    private arm;
}
