import type { PricingEngine } from '../pricing/index.js';
import type { GateConfig, GateView } from '../shared/contracts.js';
export interface GateClock {
    now(): number;
    /** Resolve `true` when the delay elapsed, `false` when `signal` aborted first. */
    sleep(milliseconds: number, signal?: AbortSignal | undefined): Promise<boolean>;
}
export interface HoldOutcome {
    readonly released: boolean;
    readonly waitedMs: number;
}
export interface GateStore {
    /** The choice stored for exactly this session, or `undefined` when that session has none / it is unreadable. */
    read(sessionId: string): boolean | undefined;
    /** Persist this session's choice; `true` when the write is durable. Never throws. */
    write(sessionId: string, enabled: boolean): boolean;
}
export interface OffPeakGate {
    /** This session's control surface. Pure read; never throws. */
    readonly view: (sessionId: string) => GateView;
    /** The only mutation; it touches exactly one session. Never rejects; persistence failure is reported, not thrown. */
    readonly setEnabled: (sessionId: string, enabled: boolean) => Promise<GateView>;
    /** Hold this session's dispatch until the tier is off-peak. Resolves as soon as dispatch may proceed. Never rejects. */
    readonly wait: (sessionId: string, signal?: AbortSignal | undefined) => Promise<HoldOutcome>;
    /**
     * Record the delegation link this session was announced with (`session/created`).
     * Links are live runtime state, not durable state: the durable file keeps only
     * explicit per-session choices. Never throws.
     */
    readonly observeSession: (sessionId: string, parentSession: string | undefined) => void;
    /**
     * The `llm/stream` middleware. SYNCHRONOUS: returns an `AsyncIterable`, never a Promise.
     * When the gate does not apply to `options.sessionId` it must return `next()` — the very same object.
     */
    readonly middleware: <T>(options: {
        readonly signal?: AbortSignal | undefined;
        readonly sessionId?: string | undefined;
    }, next: () => AsyncIterable<T>) => AsyncIterable<T>;
    readonly dispose: () => void;
}
export interface CreateGateOptions {
    readonly engine: PricingEngine;
    readonly config?: GateConfig | undefined;
    readonly clock?: GateClock | undefined;
    readonly store?: GateStore | undefined;
    /**
     * Synchronous live fallback for a parent link we have not been told about. Used
     * for a session that was never announced (e.g. one that existed before this
     * plugin loaded); a throwing or unknown resolver means "root".
     */
    readonly parentOf?: ((sessionId: string) => string | undefined) | undefined;
    /** Called after every observable change, so a transport can publish it. */
    readonly onChange?: (() => void) | undefined;
}
export declare function createOffPeakGate(options: CreateGateOptions): OffPeakGate;
/**
 * The default durable store: `<dsh home>/state/dsh-api-cost/gate.json`, holding at
 * most 512 sessions. It keeps only explicit per-session choices and their
 * `changedAt`; the delegation links are never written (they are live runtime
 * state), so inheritance is reconstructed from the live tree after a restart.
 */
export declare function defaultGateStore(path?: string | undefined): GateStore;
