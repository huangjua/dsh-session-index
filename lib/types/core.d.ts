import { readdir, stat } from 'node:fs/promises';
import type { SessionCompatibilityVersion } from './session-compat.js';
/** 命中区间标记（Hermes MATCH_OPEN/CLOSE，dsh-local-memory 同款 >>> <<<） */
export declare const MATCH_OPEN = ">>>";
export declare const MATCH_CLOSE = "<<<";
/**
 * 对应 search.rs::excerpt_around_match：归一化空白后取 charsBefore/charsAfter
 * 字符上下文，并用 >>> <<< 包住命中区间（P1.4）。
 */
export declare function excerptAroundMatch(text: string, query: string, charsBefore: number, charsAfter: number): string;
export interface TextCoverage {
    complete: boolean;
    reasons: string[];
    indexedMessages: number;
    indexedTextBytes: number;
    maxMessages: number;
    maxTextBytes: number;
}
export interface SessionMeta {
    generation?: number;
    coverage?: TextCoverage;
    id: string;
    file: string;
    workspace: string;
    size: number;
    mtimeMs: number;
    /** 指纹第三元：ctimeMs（旧索引无此字段，视为需重扫） */
    ctimeMs?: number;
    createdAt: number;
    lastTime: number;
    title: string;
    firstUserText: string;
    lastAssistantText: string;
    agentPreset: string;
    counts: Record<string, number>;
    toolNames: string[];
    toolCallCounts: Record<string, number>;
    /** 仅 head pass 的 quick 条目：counts/lastAssistantText 等字段缺失 */
    detailMissing?: boolean;
    /** P3 lineage：父会话 id（DSH header 的 parentSession）；子代理/续会话用它归并 */
    parentSession?: string;
    /**
     * P1 delta：已索引到的最后一个完整帧末字节偏移（append-only 会话文件）。
     * 下次增量只解 [indexedBytes, EOF) 的新帧，累加 counts/lastTime/lastAssistantText。
     * 缺省/0 → 全量重解析（旧索引迁移 / detailMissing 条目 / 文件被替换）。
     */
    indexedBytes?: number;
    /**
     * C9b：已解析到的最大事件 seq（与 indexedBytes 配套）。
     * 下次增量的窗口起点 = indexedSeq + 1；用于判定 delta 窗口内的 surface
     * replace 是否跨越窗口边界（引用窗口外旧帧 → 必须回退全量）。
     */
    indexedSeq?: number;
    /** 构建期间文件被改写：条目保留旧值 */
    raced?: boolean;
    /** 本次构建解析失败：保留旧条目，只追加 error */
    error?: string;
    /** Audited JSONL compatibility gate that accepted this log. */
    compatibility?: SessionCompatibilityVersion;
    /**
     * The raw file remains untouched, but this entry must not be surfaced or
     * searched because a required/unknown event made semantic reconstruction
     * unsafe.  Kept in index.json solely as a diagnostic marker.
     */
    unindexable?: true;
    /** Parsed JSON metadata may lead FTS; retry until its independent commit catches up. */
    ftsDirty?: boolean;
}
export interface SessionIndex {
    version: number;
    root: string;
    updatedAt: number;
    sessions: SessionMeta[];
}
export interface BuildReport {
    status: 'completed' | 'degraded' | 'cancelled' | 'failed' | 'skipped';
    scanComplete?: boolean;
    scanTruncated?: boolean;
    failedSubtrees?: string[];
    ftsSynced?: number;
    ftsFailed?: number;
    totalFiles: number;
    processed: number;
    headParsed: number;
    fullParsed: number;
    added: number;
    updated: number;
    skipped: number;
    removed: number;
    raced: number;
    failed: number;
    /** P3 保留策略：文件仍在磁盘、仅因超龄（max(lastTime, mtimeMs) < cutoff）
     * 从索引/派生层移除的条目数。可选字段，既有断言不受影响。 */
    pruned: number;
    errors: string[];
    discoveredBytes?: number;
    readBytes?: number;
    decodedBytes?: number;
    deltaBytes?: number;
    incompleteSessions?: number;
    scannedBytes: number;
    /**
     * C9b：本次构建**成功走完增量窗口**的文件数（真正只解了新增帧）。
     * 与 `scannedBytes` 配合可判定增量是否生效：scannedBytes 记的是"逻辑上纳入
     * 考虑的文件总大小"，增量生效时它会明显小于全量（旧实现恒等于全量）。
     */
    deltaParsed?: number;
    /** C9b：delta 尝试后回退全量重解析的文件数（replace 命中 / 偏移失效）。 */
    deltaFallbacks?: number;
    indexFile: string;
    durationMs: number;
    maxEventLoopDelayMs: number;
    /** 取消时若 Phase A 已提交 quick index 则为 true */
    partialCommitted?: boolean;
}
/** 扫描得到的文件指纹（size, mtimeMs, ctimeMs） */
export interface ScanFile {
    file: string;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
}
export interface ScanSessionFilesResult {
    files: ScanFile[];
    complete: boolean;
    truncated: boolean;
    errors: string[];
    failedSubtrees: string[];
}
export interface ScanSessionFilesOptions {
    signal?: AbortSignal;
    cap?: number;
    /** Fault injection uses the same I/O contract without changing real permissions. */
    io?: {
        readdir: typeof readdir;
        stat: typeof stat;
    };
}
export declare function isRetainedSession(file: ScanFile, previous: SessionMeta | undefined, cutoff: number): boolean;
export interface SearchHit {
    sessionId: string;
    workspace: string;
    file: string;
    kind: 'meta' | 'content';
    type: string;
    snippet: string;
    /** P3 SCROLL 锚点：FTS messages 行 id（meta/worker 路径为 0） */
    messageId?: number;
    anchorId?: string;
    lineageRoot?: string;
}
export interface SessionSummary {
    id: string;
    file: string;
    workspace: string;
    createdAt: number;
    lastTime: number;
    durationMs: number;
    title: string;
    firstUserText: string;
    lastAssistantText: string;
    agentPreset: string;
    counts: Record<string, number>;
    toolCalls: {
        name: string;
        count: number;
    }[];
}
/** @legacy 整读整解压（仅测试对比用） */
export declare function decompressZstd(file: string): string;
export declare function parseSession(text: string): {
    id: string;
    createdAt: number;
    cwd: string;
    agentPreset: string;
    title: string;
    firstUserText: string;
    lastAssistantText: string;
    lastTime: number;
    counts: Record<string, number>;
    toolCalls: {
        name: string;
        arguments: string;
    }[];
};
export declare function findSessionFiles(root: string): string[];
/**
 * 异步扫描会话文件 + 指纹（size, mtimeMs, ctimeMs）。
 * 每 20 个文件让出一次主线程并检查取消；超 cap（默认 10000）停止并置 truncated。
 *
 * DSH 升级时会把旧代际日志原地迁移成新文件，旧文件不删除（例如同一会话目录
 * 同时存在 `session.jsonl.zstd` 与 `session.v3.jsonl.zstd`），DSH 自身按最高
 * 代际读取。索引同样只收每个目录的最高代际：低代际条目随后走 merge 的 prune
 * 路径（连同 FTS 行），否则同一会话会在搜索结果里出现两次。
 */
export declare function scanSessionFiles(root: string, options?: ScanSessionFilesOptions): Promise<ScanSessionFilesResult>;
/** 显式失效（builder commit / saveIndex 后调用），防同 ms 同 size 撞车。 */
export declare function invalidateIndexCache(indexFile: string): void;
export declare function loadIndex(indexFile: string): SessionIndex | null;
export declare function saveIndex(indexFile: string, index: SessionIndex): void;
/**
 * 旧版同步全量构建（保留纯函数导出，供测试/对比）。
 * 生产路径请用 async buildIndex（SessionIndexBuilder：两阶段 + worker 池 + 原子提交）。
 */
export declare function buildIndexSync(root: string, indexFile: string, force?: boolean): BuildReport;
/**
 * async 门面：非阻塞两阶段构建（head pass → quick index 检查点 → full pass → 原子提交）。
 * 进程内 single-flight：并发调用复用同一构建。
 */
export declare function buildIndex(root: string, indexFile: string, force?: boolean, signal?: AbortSignal): Promise<BuildReport>;
export declare function metaMatch(meta: SessionMeta, query: string): boolean;
export declare function searchSessionFile(file: string, query: string, maxSnippets: number): SearchHit[];
export declare function findSession(index: SessionIndex, idOrFile: string): SessionMeta | undefined;
export declare function summarizeSession(meta: SessionMeta): SessionSummary;
export declare function resolveRoot(input: string): string;
export interface Cursor {
    /** 时间戳（ms） */
    ts: number;
    /** tie-break：会话 id（排序键 (lastTime desc, id asc)） */
    id: string;
}
/** cursor 格式：`ts|id` 或 `ts`。解析失败返回 null。 */
export declare function parseCursor(token: string): Cursor | null;
export declare function formatCursor(meta: SessionMeta): string;
/**
 * AnchorState（Codex list.rs）：sessions 必须已按 (lastTime desc, id asc) 排序。
 * 返回跳过 anchor 及其之前已返回区间后的起始下标（新增/变更会话不会错位）。
 * P0-3：排序键已知 → 二分查找，O(n) → O(log n)。
 */
export declare function cursorStartIndex(sessions: readonly SessionMeta[], cursor: Cursor | null): number;
