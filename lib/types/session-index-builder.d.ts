import { WorkerPool } from './worker-pool.js';
import { type SessionFailureDiagnostic } from './session-compat.js';
import type { SessionMeta, SessionIndex, BuildReport, ScanSessionFilesOptions, ScanSessionFilesResult } from './core.js';
import type { FtsMessageRow } from './fts.js';
export declare const STALE_MARKER_MS: number;
export declare const STALE_TMP_MS: number;
export declare const MAX_SCAN_FILES = 10000;
/** The exact stat observation consumed by a build; no source body reads. */
export declare function sourceScanFingerprint(scan: ScanSessionFilesResult): string;
export interface BuildOptions {
    force?: boolean;
    signal?: AbortSignal;
    onProgress?: (p: BuildProgress) => void;
    /** P2 FTS：full 任务收集消息行（需配合 onSessionParsed 才有效） */
    collectMessages?: boolean;
    /** P2 FTS：某会话成功解析（full/delta）后回调；append=是否 delta 追加 */
    onSessionParsed?: (file: string, meta: SessionMeta, messages: FtsMessageRow[], append: boolean, previous?: SessionMeta) => void | Promise<unknown>;
    /** P2 FTS：某会话被 prune 删除后回调 */
    onSessionRemoved?: (file: string) => unknown | Promise<unknown>;
    /** Independent FTS commit state, never inferred from index.json progress. */
    needsFtsSync?: (meta: SessionMeta) => boolean | Promise<boolean>;
    canAppendFts?: (meta: SessionMeta) => boolean | Promise<boolean>;
    flushFts?: () => Promise<void>;
    /** P3 保留策略：>0 时 merge 阶段把 max(lastTime, mtimeMs) 超龄的文件仍在磁盘
     * 的条目从索引移除（照 Hermes maybe_auto_prune_and_vacuum；绝不碰会话文件）。 */
    retentionDays?: number;
    /** C9：增量（delta）开关，缺省 true。false → 所有 full 任务一律从 0 全量解析
     * （故障/回归时的即时退路，无需改代码）。 */
    deltaEnabled?: boolean;
    /** Bounded structured metrics; contains no paths, message bodies, or raw errors. */
    onDeltaDiagnostic?: (event: DeltaDiagnostic) => void;
}
export interface DeltaDiagnostic {
    sourceId: string;
    phase: 'attempt' | 'fallback' | 'complete' | 'commit';
    parsePhase: SessionFailureDiagnostic['phase'];
    reasonCode: SessionFailureDiagnostic['reasonCode'];
    mode: 'delta' | 'full';
    previousBytes: number;
    currentBytes: number;
    scannedBytes: number;
    previousSeq: number | null;
    currentSeq: number | null;
    startOffset: number;
    attempt: number;
    readBytes: number;
    decodedBytes: number;
    validationDecodedBytes: number;
    deltaBytes: number;
    metricsExact: boolean;
    fallbackMs: number;
    totalMs: number;
    ok: boolean;
    finalConsistency: 'pending' | 'source_stable' | 'source_changed' | 'source_lagging' | 'parse_failed';
    retainedPrevious: boolean;
    published: boolean;
    indexAccepted: boolean;
    observedAtMs: number;
    finalIndexedBytes: number | null;
    finalIndexedSeq: number | null;
    ftsSynced: boolean | null;
}
export interface BuildProgress {
    phase: 'scan' | 'head' | 'full' | 'commit';
    processed: number;
    total: number;
    scannedBytes: number;
    delayMs: number;
}
export interface BuilderTestHooks {
    /** 每个文件解析任务派发前调用（测试用：确定性模拟 raced） */
    onFileRead?: (file: string) => void;
    scanOptions?: Omit<ScanSessionFilesOptions, 'signal'>;
    onCommit?: (index: SessionIndex) => void;
}
export declare class SessionIndexBuilder {
    readonly root: string;
    readonly indexFile: string;
    readonly markerFile: string;
    readonly pool: WorkerPool;
    readonly testHooks?: BuilderTestHooks;
    private activePromise;
    private currentController;
    private currentProgress;
    private lastReport;
    private deltaEvents;
    private sourceFingerprint;
    get lastDeltaDiagnostics(): readonly DeltaDiagnostic[];
    get lastSourceScanFingerprint(): string | undefined;
    /** 在飞构建是否为 force（决定后续 force 请求是复用还是排队补跑） */
    private activeForce;
    /** force 请求撞上非 force 在飞构建时排队的补跑 Promise（单飞语义下的 force 兜底） */
    private queuedForcePromise;
    private disposed;
    constructor(options: {
        root: string;
        indexFile: string;
        workerUrl?: URL;
        poolSize?: number;
        testHooks?: BuilderTestHooks;
    });
    get active(): boolean;
    get progress(): BuildProgress | null;
    get lastBuildReport(): BuildReport | null;
    /** 取消进行中的构建（插件卸载 / session_index_status cancel=true）。 */
    cancel(): void;
    /**
     * 释放资源（插件卸载时调用）：取消构建 + 终止 worker 池，
     * 并从单例注册表注销，保证热重载后新实例重建全新池。
     */
    dispose(): void;
    /** 进程内 single-flight：active 存在时直接复用同一 Promise。 */
    build(options?: BuildOptions): Promise<BuildReport>;
    private doBuild;
    /** worker 池批量执行（错误隔离：单文件失败不中断；取消则中止调度）。 */
    private runPoolTasks;
    /**
     * 单任务执行 + 失败重试一次（对应 Codex MAX_NOT_FOUND_RETRIES 的
     * “文件可能正被并发追加写入”处理）：会话文件是 append-only，构建期间可能
     * 读到半帧（EOF/invalid data）；等 150ms 重试一次可消除大部分瞬时失败。
     *
     * aborted 语义：仅调用方取消才为 true（isCancelError / signal.aborted）。
     * worker 崩溃/超时等基础设施错误按普通失败处理（可重试一次），
     * 不能与“用户取消”混为一谈。
     */
    private runWithRetry;
    private commit;
}
export declare function getBuilder(root: string, indexFile: string): SessionIndexBuilder;
