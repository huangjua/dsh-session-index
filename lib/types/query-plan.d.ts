/** Shared substring query semantics for SQLite and original-log search. */
export type QueryMode = 'and' | 'or';
export interface QueryPlan {
    query: string;
    tokens: string[];
}
/** Hermes-compatible query cleaning, kept independent of the storage backend. */
export declare function sanitizeFts5Query(raw: string): string;
export declare function createQueryPlan(raw: string): QueryPlan;
export declare function matchesQuery(text: string, plan: QueryPlan, mode?: QueryMode): boolean;
/** The earliest matched term supplies the excerpt; matching still uses every term. */
export declare function queryMatchToken(text: string, plan: QueryPlan): string;
