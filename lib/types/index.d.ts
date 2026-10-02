/**
 * @dsh-external/dsh-session-index — DSH 会话索引（toolkit）
 *
 * v2 非阻塞重构（对照 openai/codex@9ded177）：
 *  - 两阶段构建：head pass 先出 quick index 崩溃检查点，full pass 补齐详情；
 *  - worker 池流式解压解析（不整读文件、不阻塞事件循环）；
 *  - 原子提交 + durable run-marker 跨进程防重；
 *  - session_list 稳定分页（cursor/nextCursor/truncated）；
 *  - session_index_status 可查 active/progress 并可 cancel；
 *  - 全文搜索走同一 worker 池，Codex 式 48/96 字符上下文 snippet，命中即停。
 */
import type { Context } from '@deepseek-ai/cordis';
import { scanSessionFiles } from './core.js';
import type { SessionIndex, ScanSessionFilesResult } from './core.js';
import { createSessionWatcher } from './watcher.js';
import type { FtsClient } from './fts-client.js';
import type { SessionFts } from './fts.js';
export declare const name = "@dsh-external/dsh-session-index";
export declare const inject: string[];
export declare const DEFAULT_SEARCH_LINE_BYTES: number;
export declare const MAX_SEARCH_LINE_BYTES: number;
export declare const MAX_SEARCH_DECOMPRESSED_BYTES: number;
export interface Config {
    sessionsRoot: string;
    indexFile: string;
    /** 派生数据的落盘目录（index.json / fts.db / bookmarks.jsonl / llm-summary.jsonl）。
     * 缺省空 → `$DSH_HOME/session-index`；设为绝对路径可把整份索引搬到别的盘
     * （例如 C 盘吃紧时指向大容量盘），目录不存在会自动创建。 */
    dataDir?: string;
    maxHits: number;
    maxSnippetsPerSession: number;
    /** P2.1：FTS 总开关（默认开）。false 时完全跳过 createSessionFts（不 import
     * node:sqlite、不打开/创建 fts.db），mode=full 自动走 worker 流式回退，
     * SCROLL 返回既有"FTS 不可用"错误对象。 */
    ftsEnabled: boolean;
    /** P3：索引保留策略天数（0=关闭，默认 90）。只清理 index.json 条目与
     * fts.db（sessions+messages）行，**绝不删除/重命名/截断会话文件**。 */
    retentionDays: number;
    /** STAGE-4：可选 LLM 一句话摘要开关（默认开，用户 2026-08-27 批准）。
     * 红线 3 修订：零 LLM 文本生成；唯一例外 = 本开关内、按需单会话、缓存、
     * 成本护栏（maxTokens=64/10s 超时/失败不重试/只在 session_summary 路径）。
     * false → 完全零执行（不读/写缓存、不触碰 ctx.llm）。 */
    llmSummaryEnabled: boolean;
    /** C9：增量（delta）索引开关（默认开）。活跃会话每 5s 被 watcher 重建时只解
     * 新增帧；窗口内出现 surface 替换会自动回退全量（正确性优先）。
     * false → 一律全量重解析（回归排查/故障时的即时退路）。 */
    deltaEnabled?: boolean;
}
export declare const Config: Schemastery<any, any>;
/** 默认使用真实资源；故障回归可注入可控的扫描/监听/初始化。 */
export interface PluginDependencies {
    scanSessionFiles?: typeof scanSessionFiles;
    createSessionWatcher?: typeof createSessionWatcher;
    createSessionFts?: (path: string) => Promise<SessionFts | FtsClient | null>;
    /** Structured timings and reason codes only; never query/body/bookmark text. */
    onRuntimeDiagnostic?: (event: Record<string, unknown>) => void;
}
/** 用 scanner 已取得的指纹对账，不重复 stat；不完整扫描不判缺席删除。 */
export declare function indexNeedsReconcile(idx: SessionIndex, root: string, scan: ScanSessionFilesResult, retentionDays: number, now?: number): boolean;
export declare function apply(ctx: Context, config: Config, dependencies?: PluginDependencies): void;
