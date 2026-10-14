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
    /** The stored flag, or `undefined` when nothing has been stored / it is unreadable. */
    read(): boolean | undefined;
    /** Persist `enabled`; `true` when the write is durable. Never throws. */
    write(enabled: boolean): boolean;
}
export interface OffPeakGate {
    /** Current value. Pure read; never throws. */
    readonly view: () => GateView;
    /** The only mutation. Never rejects; persistence failure is reported, not thrown. */
    readonly setEnabled: (enabled: boolean) => Promise<GateView>;
    /** Hold until the tier is off-peak. Resolves as soon as dispatch may proceed. Never rejects. */
    readonly wait: (signal?: AbortSignal | undefined) => Promise<HoldOutcome>;
    /**
     * The `llm/stream` middleware. SYNCHRONOUS: returns an `AsyncIterable`, never a Promise.
     * When the gate does not apply it must return `next()` — the very same object.
     */
    readonly middleware: <T>(options: {
        readonly signal?: AbortSignal | undefined;
    }, next: () => AsyncIterable<T>) => AsyncIterable<T>;
    readonly dispose: () => void;
}
export interface CreateGateOptions {
    readonly engine: PricingEngine;
    readonly config?: GateConfig | undefined;
    readonly clock?: GateClock | undefined;
    readonly store?: GateStore | undefined;
    /** Called after every observable change, so a transport can publish it. */
    readonly onChange?: (() => void) | undefined;
}
export declare function createOffPeakGate(options: CreateGateOptions): OffPeakGate;
/** The default durable flag: `<dsh home>/state/dsh-api-cost/gate.json`. */
export declare function defaultGateStore(path?: string | undefined): GateStore;
