import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import type { CostView, PluginConfig } from '../shared/contracts.js';
export type * from '../shared/contracts.js';
export declare const name: "dsh-api-cost";
/**
 * The projection registry and the observation reader are the whole purpose of
 * this plugin. `webServer`, `tools` and `commands` are used when the composition
 * has them, so a read-only or tool-less composition still meters correctly.
 * The checkpoint cache is deliberately NOT required here: cold recovery is the
 * query service's own optional peer, and this plugin never touches it.
 */
export declare const inject: string[];
export declare const configSchema: z.ZodType<PluginConfig>;
export declare function describe(view: CostView): string;
export declare function apply(ctx: Context, rawConfig?: PluginConfig): void;
