import type { HeadSummary, FullSummary, SearchHit, SearchOptions, StreamStats } from './streaming-parser.js';
import { type SessionFailureDiagnostic } from './session-compat.js';
import type { CompatResumeState } from './session-compat.js';
export type WorkerTaskMode = 'head' | 'full' | 'search';
export type WorkerTaskData = HeadSummary | FullSummary | SearchHit[];
export interface WorkerTaskSpec {
    mode: WorkerTaskMode;
    file: string;
    query?: string;
    maxSnippets?: number;
    /** search 模式：过滤在 parser 命中计数前完成。 */
    role?: SearchOptions['role'];
    queryMode?: SearchOptions['queryMode'];
    maxDecompressedBytes?: number;
    maxLineBytes?: number;
    /** P1 delta：压缩输入从该字节偏移开始读（须为帧边界；仅 full 模式） */
    startOffset?: number;
    /** 仅 builder 内部记账用：本次是否为 delta 解析（worker 无需感知） */
    delta?: boolean;
    /** 仅 builder 内部记账用：本次是 delta 回退后的全量重解析（观测用） */
    deltaFellBack?: boolean;
    /** C9b：delta 续读状态（窗口无 header，需播种 version/generation/header/seq） */
    resume?: CompatResumeState;
    /** P2 FTS：full 模式下收集消息行（user/assistant 文本 + tool 名） */
    collectMessages?: boolean;
    maxMessages?: number;
    maxIndexedTextBytes?: number;
}
export type TaskResult<T = WorkerTaskData> = {
    ok: true;
    data: T;
    aborted: boolean;
} | {
    ok: false;
    aborted: boolean;
    error: string;
    stats?: Partial<StreamStats>;
    raced?: boolean;
    diagnostic?: SessionFailureDiagnostic;
};
export interface WorkerPoolOptions {
    /** 池大小；缺省 Math.min(4, Math.max(1, availableParallelism - 1)) */
    size?: number;
    /** worker 脚本 URL；缺省在 WorkerPool 构造时由调用方给出（null = 仅 inline） */
    workerUrl?: URL | null;
    /** 单任务超时（毫秒），超时杀死 worker 换新（默认 15 分钟） */
    timeoutMs?: number;
}
export declare class WorkerPool {
    private readonly size;
    private readonly workerUrl;
    private readonly timeoutMs;
    private readonly slots;
    private readonly queue;
    private seq;
    private inlineMode;
    private terminated;
    /** inline 回退模式下的并发上限（主线程同步 CPU 活，必须限流） */
    private readonly inlineMax;
    private inlineActive;
    constructor(options?: WorkerPoolOptions);
    /**
     * 提交一个任务。返回 TaskResult：
     * - 取消（caller signal / 池终止）→ reject CancelError；
     * - 单文件失败 → resolve { ok:false, error }（错误隔离，不 reject）。
     */
    run<T extends WorkerTaskData = WorkerTaskData>(spec: WorkerTaskSpec, signal?: AbortSignal): Promise<TaskResult<T>>;
    /** 终止池：取消排队任务、reject 在飞任务、杀死 worker。插件卸载时调用。 */
    terminate(): void;
    get sizeLimit(): number;
    /** inline 回退模式下当前在飞任务数（测试/观测用） */
    get inlineInFlight(): number;
    private pump;
    private pumpAsync;
    private nextSlot;
    private spawnSlot;
    private dispatch;
    private dispatchInline;
    private onMessage;
    private onWorkerError;
    private onTimeout;
}
/**
 * 通用有界并发映射（对应 PORT_TO_TS.md 的 mapLimit）。
 * 取消后不再调度新任务；已启动任务自然跑完。
 *
 * @internal C11：生产的构建并发由 SessionIndexBuilder.runPoolTasks 自行调度
 * （分波派发 + 池上限），本函数仅 worker-pool.test.ts 使用。保留勿删。
 */
export declare function mapLimit<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<Array<R | undefined>>;
