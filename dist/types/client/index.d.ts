import type { ClientContext } from './types.js';
/** The dock declaration is the only hard service; locale and timers stay optional. */
export declare const inject: string[];
/**
 * Client half of dsh-api-cost 2.0.
 *
 * Own-session money is read straight from the Host's `apiCost` projection through
 * the framework `useProjection` seat; this half only bridges cross-session scope
 * discovery over the plugin's own GET routes. Every resource is registered
 * through `ctx.effect`, so unloading the plugin removes styles, dictionaries,
 * listeners and in-flight requests.
 */
export declare function apply(ctx: ClientContext): void;
