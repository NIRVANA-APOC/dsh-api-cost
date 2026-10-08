import { z } from 'zod';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import type { PricingEngine } from '../pricing/index.js';
import type { Coverage, LedgerView, Money, Totals } from '../shared/contracts.js';
export interface LedgerState {
    readonly fingerprint: string;
    readonly inheritedEventCount: number;
    readonly model: string;
    readonly view: LedgerView;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionMap {
        apiCost: LedgerView;
    }
    interface SessionProjectionStateMap {
        apiCost: LedgerState;
    }
}
export declare const ledgerViewSchema: z.ZodType<LedgerView>;
export declare function zeroMoney(): Money;
export declare function zeroTotals(): Totals;
export declare function addMoney(a: Money, b: Money, sign?: 1 | -1): Money;
export declare function addTotals(a: Totals, b: Totals, sign?: 1 | -1): Totals;
export declare function completeCoverage(): Coverage;
export declare function emptyLedgerView(revision?: string): LedgerView;
/** Stateless pure fold; durable seq watermarks and history recovery belong to DSH. */
export type CostProjectionDefinition = Omit<ProjectionDefinition<'apiCost'>, 'wire'> & {
    wire: NonNullable<ProjectionDefinition<'apiCost'>['wire']>;
};
export declare function createCostProjection(engine: PricingEngine): CostProjectionDefinition;
