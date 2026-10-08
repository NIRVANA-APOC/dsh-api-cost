import type { SessionHeader } from '@deepseek-ai/dsh-session';
import type { TeamProjection } from '@deepseek-ai/dsh-experimental-agent-team';
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent';
import type { CostView, LedgerView, Scope } from '../shared/contracts.js';
export declare class QueryError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number, message: string);
}
export interface CostCut {
    readonly header: Pick<SessionHeader, 'id' | 'parentSession' | 'origin'>;
    readonly ledger: LedgerView;
    readonly catalog: readonly SubagentCatalogEntry[] | undefined;
    readonly team: TeamProjection | undefined;
}
export interface QuerySource {
    /** The adapter owns and releases each native observation before returning. */
    read(id: string, signal: AbortSignal): Promise<CostCut>;
    membershipRoot?(id: string): string | undefined;
}
export interface ViewRequest {
    readonly sessionId: string;
    readonly scope?: Scope;
    readonly detail?: 'summary' | 'full';
    readonly force?: boolean;
    readonly signal?: AbortSignal;
}
export declare function validateSessionId(value: string): string;
export declare function parseScope(value: unknown, fallback?: Scope): Scope;
/** Only bounded result caches. The host owns log restoration and projection state. */
export declare class CostQueries {
    private readonly cache;
    private readonly flights;
    private readonly dependents;
    private disposed;
    private readonly source;
    private readonly defaultScope;
    private readonly now;
    constructor(source: QuerySource, defaultScope?: Scope, now?: () => number);
    invalidate(sessionId: string): void;
    dispose(): void;
    get stats(): {
        cached: number;
        flights: number;
        dependencySessions: number;
    };
    view(request: ViewRequest): Promise<CostView>;
    private removeCache;
    private store;
    private compute;
}
