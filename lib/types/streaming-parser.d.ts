import type { FtsMessageRow } from './fts.js';
import { type MessageIdentity } from './message-anchor.js';
import { type QueryMode } from './query-plan.js';
import { type CompatResumeState, type SessionCompatibilityVersion } from './session-compat.js';
export interface StreamParseOptions {
    signal?: AbortSignal;
    /** 解压输出总字节上限，超限抛错（默认 256MB） */
    maxDecompressedBytes?: number;
    /** 单行字节上限，超长行丢弃（默认 4MB） */
    maxLineBytes?: number;
    /** 压缩输入分块大小（默认 512KB；仅 fzstd 路径使用） */
    compressedChunkSize?: number;
    /** 解码器：'native'（node:zlib 逐帧，失败自动回退 fzstd）| 'fzstd'（强制） */
    decoder?: 'native' | 'fzstd';
    /** P1 delta：压缩输入从该字节偏移开始读（须为帧边界；之前视为已索引） */
    startOffset?: number;
}
export interface StreamStats {
    lines: number;
    bytes: number;
    oversized: number;
    stopped: boolean;
    discoveredBytes?: number;
    readBytes?: number;
    allocatedBytes?: number;
    decodedBytes?: number;
    validationDecodedBytes?: number;
    /** 实际压缩尾段读取字节；失败重试/解码器回退也累计，full 为 0。 */
    deltaBytes?: number;
}
/** Collection budgets are separate from snippet length and decompression limits. */
export declare const MAX_FTS_ROWS = 50000;
export declare const MAX_INDEXED_TEXT_BYTES: number;
export interface MessageCoverage {
    complete: boolean;
    reasons: string[];
    indexedMessages: number;
    indexedTextBytes: number;
    maxMessages: number;
    maxTextBytes: number;
}
/**
 * 流式解压 JSONL：逐行回调 onLine。返回 false 提前停止（head/search 早停）。
 * 解码器：默认 native（node:zlib 逐帧解压，~3-4x fzstd）；任何帧失败/不可用
 * 自动回退 fzstd 流式路径（保留拼接多帧支持）。每个 chunk 检查一次
 * signal.aborted（cooperative cancellation）。
 */
export declare function streamJsonlLines(file: string, onLine: (line: string) => boolean | void, options?: StreamParseOptions): Promise<StreamStats>;
export interface HeadSummary {
    id: string;
    createdAt: number;
    cwd: string;
    agentPreset: string;
    title: string;
    firstUserText: string;
    lastTime: number;
    sawSessionMeta: boolean;
    records: number;
    compatibility: SessionCompatibilityVersion;
    /** P3 lineage：父会话 id（header 帧字段） */
    parentSession?: string;
}
/**
 * 只流式解压文件头部（对应 list.rs::read_head_summary）：
 * - 基础窗口 maxRecords（默认 10）条非空记录；
 * - 若已见 session meta 但 firstUserText/title 未齐，最多再扫
 *   maxRecords + userEventScanLimit(200) 条（Codex USER_EVENT_SCAN_LIMIT 同款
 *   扩展：title 事件常出现在首条 user 消息之后）。
 * id/createdAt/cwd/agentPreset/title/firstUserText 基本都在头部。
 */
export declare function parseHead(file: string, options?: {
    signal?: AbortSignal;
    maxRecords?: number;
    compressedChunkSize?: number;
    decoder?: 'native' | 'fzstd';
    maxDecompressedBytes?: number;
    maxLineBytes?: number;
    startOffset?: number;
}): Promise<HeadSummary>;
export interface FullSummary {
    id: string;
    createdAt: number;
    cwd: string;
    agentPreset: string;
    title: string;
    firstUserText: string;
    lastAssistantText: string;
    lastTime: number;
    counts: Record<string, number>;
    toolCallCounts: Record<string, number>;
    events: number;
    /** P3 lineage：父会话 id */
    parentSession?: string;
    /** P2 FTS：collectMessages=true 时收集的消息行（user/assistant 文本 + tool 名） */
    messages?: FtsMessageRow[];
    compatibility: SessionCompatibilityVersion;
    /**
     * C9：本次解析（可能是 delta 窗口）内发生过 surface 替换——delta 结果不可信，
     * 调用方应回退全量重解析。
     *
     * 保守判据（实测代价可忽略：24 个真实会话 1,145,638 事件里仅 13 次 replace，
     * 0.0011%，且近窗口内为 0）。**跨窗口** replace 另有结构性兜底：窗口内的
     * surface 数组不含被替换的原帧，`foldSurface` 找不到 start/end 会直接抛错，
     * 走调用方既有的 `!r.ok` → 全量回退路径。
     */
    hadSurfaceReplace?: boolean;
    /** C9b：已解析到的最大事件 seq（delta 合并后写回 indexedSeq，作为下次窗口起点）。 */
    lastSeq?: number;
    generation?: number;
    coverage?: MessageCoverage;
    discoveredBytes?: number;
    readBytes?: number;
    allocatedBytes?: number;
    decodedBytes?: number;
    validationDecodedBytes?: number;
    deltaBytes?: number;
}
export declare function parseFull(file: string, options?: {
    signal?: AbortSignal;
    lastTextLimit?: number;
    compressedChunkSize?: number;
    decoder?: 'native' | 'fzstd';
    maxDecompressedBytes?: number;
    maxLineBytes?: number;
    startOffset?: number;
    /** P2 FTS：为 true 时逐条收集 user/assistant 文本与 tool 名（供 SQLite FTS） */
    collectMessages?: boolean;
    maxMessages?: number;
    maxIndexedTextBytes?: number;
    /**
     * C9b（resume delta）：续读状态。传入后按"上一轮已解析到这里"播种 compat，
     * 使**不含 header 的增量窗口**（startOffset > 0）可被解析。
     *
     * 必要性：DSH 会话文件 append-only 且只有第一帧带 header（实测 349 个真实
     * 文件 0 个在后续帧重复写 header）。没有它，窗口首行会被当成 header 解析并抛
     * "unsupported or malformed session header"——这正是此前 delta 恒失败的原因。
     */
    resume?: CompatResumeState;
}): Promise<FullSummary>;
export interface SearchHit extends Partial<MessageIdentity> {
    type: string;
    snippet: string;
    /**
     * STAGE-1 Part B（可选、加性字段）：消息级 role（user/assistant/tool），供
     * worker 回退路径的 filter.role 按行过滤（与 src/fts.ts 的 SearchFilter 对齐：
     * tool 判定 = tool name 非空）。既有消费方（index.ts 仅用 type/snippet）无感。
     */
    role?: 'user' | 'assistant' | 'tool';
    /** STAGE-1 Part B：tool/call 行的工具名（工具行 snippet 与 FTS 侧一致留空）。 */
    toolName?: string;
}
export interface SearchOptions {
    signal?: AbortSignal;
    maxSnippets?: number;
    /** 消息角色限制；在命中计数与 maxSnippets 截断前应用。 */
    role?: 'user' | 'assistant' | 'tool' | 'any';
    /** Global AND/OR orchestration belongs to the caller; no per-file relaxation. */
    queryMode?: QueryMode;
    /** 命中前上下文字符数（Codex MATCH_CONTEXT_BEFORE_CHARS=48） */
    contextBefore?: number;
    /** 命中后上下文字符数（Codex MATCH_CONTEXT_AFTER_CHARS=96） */
    contextAfter?: number;
    /** 压缩输入分块大小（测试跨块场景用） */
    compressedChunkSize?: number;
    decoder?: 'native' | 'fzstd';
    maxDecompressedBytes?: number;
    maxLineBytes?: number;
    startOffset?: number;
}
/** Search complete original-message text under one caller-selected global query mode. */
export declare function parseSearch(file: string, query: string, options?: SearchOptions): Promise<SearchHit[]>;
