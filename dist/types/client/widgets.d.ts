import type { CostStore } from './store.js';
import type { CostPillProps } from './types.js';
import type { Translate } from './locale.js';
/** Factory captures the single scope-query bridge, not a framework or runtime DSH module. */
export declare function createCostPill(store: CostStore, t: Translate): (props: CostPillProps) => import("react").JSX.Element;
