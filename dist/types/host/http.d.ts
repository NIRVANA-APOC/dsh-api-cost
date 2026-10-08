import type { Context } from '@deepseek-ai/cordis';
import type { PricingEngine } from '../pricing/index.js';
import type { ApiError, Scope } from '../shared/contracts.js';
import { CostQueries } from './query.js';
export declare function publicError(error: unknown): {
    status: number;
    body: ApiError;
};
export declare function registerHttp(ctx: Context, queries: CostQueries, engine: PricingEngine, defaultScope: Scope): void;
