import type { SessionMeta } from './core.js';
export { sanitizeFts5Query } from './query-plan.js';
export interface FtsMessageRow {
    sessionFile: string;
    role: 'user' | 'assistant' | 'tool';
    /** user/assistant 文本；role=tool 时为 '' */
    text: string;
    toolName: string;
    anchorId?: string;
    eventSeq?: number;
    eventType?: string;
    sourceMessageId?: string;
    callId?: string;
    generation?: number;
    identityEvidence?: string;
}
export interface FtsHit {
    sessionId: string;
    sessionFile: string;
    workspace: string;
    title: string;
    role: string;
    text: string;
    toolName: string;
    snippet: string;
    /** P3 SCROLL 锚点：messages 表行 id（按序 = 时间序） */
    messageId: number;
    textTruncated?: boolean;
    matchCount?: number;
    anchorId?: string;
    eventSeq?: number;
    /** P3 lineage：lineage root id（parent_session 或自身 id） */
    lineageRoot: string;
    /**
     * STAGE-1 Part A（可选、加性字段）：bm25(messages_fts_trigram) 原值（≤0，越小越
     * 相关）。仅 trigram 路径填充；LIKE 兜底路径无此列 → 缺省 undefined。
     * 供会话级 best-rank 聚合（src/rank.ts）使用；既有消费方无感。
     */
    bm25?: number;
}
/**
 * STAGE-1 Part B：session_index_search 的 filter 参数底座（消息级 role + 会话级
 * 时间范围）。
 * - role='tool' 判定 = tool_name 非空（消息行由 builder 写入 role='tool' +
 *   toolName，见 streaming-parser.ts pushMessage），与 fts.ts 的 role/toolName
 *   列语义对齐；
 * - messages 表无时间列（id 仅自增 = 插入序）→ sinceMs/untilMs 降级为
 *   sessions.last_time 会话级过滤，与 meta / worker 回退路径口径一致
 *   （schema 描述已注明）。
 */
export interface SearchFilter {
    queryMode?: 'and' | 'or';
    role?: 'user' | 'assistant' | 'tool' | 'any';
    sinceMs?: number;
    untilMs?: number;
}
export interface FtsSessionMeta {
    file: string;
    id: string;
    workspace: string;
    title: string;
    agentPreset: string;
    createdAt: number;
    lastTime: number;
    parentSession?: string;
}
/** 正常应用路径由 fts-worker 持有引擎；原消息和 chunk 在同一事务内提交。 */
export declare const FTS_PARSER_VERSION = "session-index/3-chunks";
export interface FtsSearchPage {
    hits: FtsHit[];
    total: number;
    totalExact: boolean;
    hasMore: boolean;
}
export interface FtsSourceFingerprint {
    file: string;
    sessionId: string;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    indexedBytes: number;
    indexedSeq?: number;
    complete: boolean;
}
export interface FtsCheckpoint extends FtsSourceFingerprint {
    parserVersion: string;
    messageCount: number;
}
export interface SyncSessionRequest {
    meta: FtsSessionMeta;
    sourceFingerprint: FtsSourceFingerprint;
    parserVersion: string;
    mode: 'replace' | 'append';
    expectedBase?: FtsCheckpoint;
    messages: FtsMessageRow[];
}
export interface SyncReceipt {
    checkpoint: FtsCheckpoint;
    duplicate: boolean;
}
export declare function checkpointOf(meta: SessionMeta): FtsSourceFingerprint;
type DatabaseSyncCtor = new (path: string, options?: {
    readOnly?: boolean;
}) => FtsDbLike;
export interface FtsOptions {
    readOnly?: boolean;
    busyTimeoutMs?: number;
    /** Called between synchronous migration batches, not from a blocked interval. */
    onMigrationProgress?: (progress: FtsMigrationProgress) => void;
    migrationLockTimeoutMs?: number;
    /** Worker startup must distinguish a database failure from unsupported SQLite. */
    throwOnError?: boolean;
    onQueryTiming?: (timing: {
        op: string;
        sqlMs: number;
        processingMs: number;
    }) => void;
}
export interface FtsMigrationProgress {
    phase: string;
    completed: number;
    total?: number;
    elapsedMs: number;
    at?: number;
}
interface FtsDbLike {
    exec(sql: string): void;
    prepare(sql: string): {
        run(...args: unknown[]): unknown;
        all(...args: unknown[]): unknown[];
        get(...args: unknown[]): unknown;
    };
    close(): void;
}
/**
 * 异步工厂：动态 import node:sqlite（Node <22.5 时模块不存在 → 静默降级）。
 * 任何一步失败返回 null（绝不抛出，绝不影响主索引构建）。
 */
export declare function createSessionFts(dbPath: string, options?: FtsOptions): Promise<SessionFts | null>;
export declare class SessionFts {
    private readonly options;
    readonly ok: boolean;
    private readonly dbPath;
    private db;
    /** All accepted writes serialize; their promises and flush propagate errors. */
    private syncChain;
    private closing;
    private closePromise;
    private nextWrite;
    private failures;
    private failedFiles;
    private pendingWrites;
    private lastWriteError;
    private lastWriteErrorAt;
    private readonly migrationStartedAt;
    private migrationCompleted;
    private migrationTotal;
    private querySqlMs;
    private measureSql;
    private timedQuery;
    private migrationProgress;
    constructor(dbPath: string, DatabaseSync: DatabaseSyncCtor, options?: FtsOptions);
    private initSchema;
    /**
     * Remove the unused unicode61 index inside the shared migration transaction.
     * Startup does not VACUUM; failure rolls back schema and version together.
     */
    private migrateSchemaV2;
    /** 派生库轻量迁移：旧库缺 parent_session 列 → ALTER ADD（不丢数据）。 */
    private migrateSessionsSchema;
    /** Add identity without inventing a source seq for historical rowids. */
    private migrateMessagesSchema;
    private insertChunks;
    private upsertNow;
    /** All writes, including maintenance and metadata, use this single entrance. */
    private enqueue;
    private transaction;
    private readSnapshot;
    upsertSession(meta: FtsSessionMeta): Promise<void>;
    private insertNow;
    /** Compatibility entry point. It intentionally leaves no trusted checkpoint. */
    syncMessages(file: string, rows: FtsMessageRow[], append: boolean): Promise<void>;
    syncMessagesIterable(file: string, rows: () => Iterable<FtsMessageRow>, append: boolean): Promise<void>;
    getCheckpoint(file: string): FtsCheckpoint | null;
    private checkpointIntact;
    needsSync(meta: SessionMeta): boolean;
    listSessionFiles(): string[];
    syncSession(request: SyncSessionRequest): Promise<SyncReceipt>;
    syncSessionIterable(request: Omit<SyncSessionRequest, 'messages'>, rows: () => Iterable<FtsMessageRow>): Promise<SyncReceipt>;
    /** Report every earlier failed write up to this call's queue boundary. */
    flush(): Promise<void>;
    removeSession(file: string): Promise<void>;
    sessionCount(): number;
    /**
     * P2.2 观测（只读；不改任何索引逻辑；任何失败返回 0/''，绝不抛错）：
     * messages 行数 / 库文件字节（stat）/ last_optimize 水印 / schema_version /
     * last_prune 水印与数量（P3 保留策略）。
     */
    health(): {
        sessions: number;
        messages: number;
        dbSizeBytes: number;
        lastOptimizeAt: number;
        schemaVersion: string;
        lastPruneAt: number;
        lastPruneCount: number;
        lastWriteError: string;
        lastWriteErrorAt: number;
        pendingWrites: number;
        failedSessions: number;
        acceptingWrites: boolean;
    };
    /** 最近一次保留清理时间（state_meta `last_prune`，缺省 0）。 */
    lastPruneAt(): number;
    /** 最近一次保留清理数量（state_meta `last_prune_count`，缺省 0）。 */
    lastPruneCount(): number;
    /** Queue both watermark fields in one transaction; await before observing them. */
    markPruned(count: number): Promise<void>;
    private queryRows;
    private shapeHit;
    search(query: string, workspace: string, limit: number, filter?: SearchFilter): Promise<FtsHit[]>;
    searchPage(query: string, workspace: string, limit: number, filter?: SearchFilter): Promise<FtsSearchPage>;
    /** Numeric IDs are read only as rowids. Source seq is never inferred from them. */
    resolveLegacyAnchor(sessionId: string, rowid: number): Promise<{
        anchorId?: string;
        evidence?: string;
        reason?: string;
    }>;
    around(sessionId: string, anchor: number | string, window?: number): Promise<{
        ok: boolean;
        reason?: string;
        messages: {
            id: number;
            anchorId?: string;
            eventSeq?: number;
            role: string;
            text: string;
            toolName: string;
        }[];
        bookends: {
            start: {
                id: number;
                anchorId?: string;
                role: string;
                text: string;
            }[];
            end: {
                id: number;
                anchorId?: string;
                role: string;
                text: string;
            }[];
        };
    }>;
    /** FTS 段合并（hermes: INSERT INTO ...(fts) VALUES('merge', N) 的简化：optimize）。 */
    optimize(): Promise<void>;
    vacuum(): Promise<void>;
    maybeMaintenance(): Promise<void>;
    /** Stop admission, drain every accepted write, then close, even on failure. */
    close(): Promise<void>;
}
/** 命中片段标记与 snippet 生成见 core.ts（C11 统一），本文件 re-export。 */
/**
 * P1.3：Hermes `_sanitize_fts5_query` 移植（原样照抄，不改净化语义）：
 * - 未配对引号移除；悬空布尔算子（AND/OR/NOT）去首尾
 * - 连字符词加引号；去掉 ()*^:[] 结构字符，保留布尔词/引号
 * 来源：Hermes session_search_tool.py `_sanitize_fts5_query`（MIT，Copyright
 * (c) 2025 Nous Research）；TS 移植出处 dsh-local-memory/src/session-index/query.ts。
 */
/**
 * P1.4：保留标记归一化。正文/工具名里已有的 >>> <<< 在入库前换成
 * » «（snippet 专用标记不得与正文碰撞，照 DSH 官方 session-query-sqlite
 * README「reserved highlight markers」约束）。幂等：» « 不含 > <。
 */
export declare function normalizeReservedMarkers(s: string): string;
/**
 * 派生搜索词（单一事实源：search() 的 trigram/LIKE 路由 与 queryUsesLikePath 共用）。
 * P1.3 净化后剥词级首尾引号（本管线 trigram/LIKE 会把每个词整体引号化，恢复
 * "引号是无意义包裹"的直觉），只保留净化后的词本身。
 */
/**
 * 判定该原始查询是否必然走 LIKE 兜底慢路径（含 <3 字词，如 1-2 字中文）。
 * 与 search() 同一套净化/分词（单一事实源）；trigram 0 命中再回退 LIKE 的情形
 * 不在判定内（罕见次优，非本提示针对的"短词慢路径"）。空查询返回 false。
 */
export declare function queryUsesLikePath(query: string): boolean;
export { MATCH_OPEN, MATCH_CLOSE, excerptAroundMatch } from './core.js';
