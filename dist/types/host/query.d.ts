import type { SessionHeader } from '@deepseek-ai/dsh-session';
import type { SubagentCatalogEntry } from '@deepseek-ai/dsh-subagent';
import type { CostView, LedgerView, Scope } from '../shared/contracts.js';
export declare class QueryError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status: number, message: string);
}
/** One durable roster row of the 0.2.0 experimental Agent Team projection. */
export interface TeamMemberRow {
    readonly id: string;
    readonly name: string;
    readonly role: 'lead' | 'teammate';
    readonly phase?: string | undefined;
}
/**
 * The `agentTeam` projection in either shape DSH has published. 0.2.0 published
 * a durable `members` roster; 0.2.2 publishes only the saved Team selection and
 * task board (`enabled`, `tasks`) and derives the roster from the subagent
 * catalog. This host reads `members` when it is there and never assumes it.
 */
export interface TeamProjectionLike {
    readonly failure?: string | undefined;
    readonly members?: readonly TeamMemberRow[] | undefined;
    readonly enabled?: boolean | undefined;
}
export interface CostCut {
    readonly header: Pick<SessionHeader, 'id' | 'parentSession' | 'origin'>;
    readonly ledger: LedgerView;
    readonly catalog: readonly SubagentCatalogEntry[] | undefined;
    readonly team: TeamProjectionLike | undefined;
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
