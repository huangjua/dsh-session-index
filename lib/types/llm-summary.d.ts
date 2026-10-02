import type { Context } from '@deepseek-ai/cordis';
import type { SessionMeta } from './core.js';
/** sidecar 文件名（与 fts.db / bookmarks.jsonl 同级） */
export declare const SUMMARY_CACHE_FILE_NAME = "llm-summary.jsonl";
/** 行结构版本（读取只接受 v===1） */
export declare const SUMMARY_CACHE_VERSION = 1;
/** 输出一句话上限（任务：≤80 字；按 Unicode 码点计） */
export declare const SUMMARY_CHAR_CAP = 80;
/** 单次模型调用输出 token 上限（max_tokens=64） */
export declare const LLM_MAX_TOKENS = 64;
/** 单次模型调用超时（10s；AbortSignal.timeout） */
export declare const LLM_TIMEOUT_MS = 10000;
/** 摘要温度（确定性优先；无 LLM 语义变化，仅采样参数） */
export declare const LLM_TEMPERATURE = 0;
/** title 参与 prompt 的码点上限 */
export declare const PROMPT_TITLE_CAP = 120;
/** firstUserText 参与 prompt 的码点上限（任务：前 200 字） */
export declare const PROMPT_FIRST_USER_CAP = 200;
/** lastAssistantText 参与 prompt 的码点上限（任务：前 500 字） */
export declare const PROMPT_LAST_ASSISTANT_CAP = 500;
/** counts 参与 prompt 的类别数上限（任务：前 8 类） */
export declare const PROMPT_COUNTS_TOP = 8;
/** toolCallCounts 参与 prompt 的条目数上限（任务：top5） */
export declare const PROMPT_TOOL_TOP = 5;
/** counts 单条目文本长度上限（条目长尾截断，保证总预算收敛） */
export declare const PROMPT_COUNT_ENTRY_CAP = 40;
/** toolCallCounts 单条目文本长度上限 */
export declare const PROMPT_TOOL_ENTRY_CAP = 48;
/**
 * prompt 总字符硬上限：固定段（120+200+500=820 码点）+ counts/tools（≤~560）
 * + 模板脚手架（~280）→ 上限 2000 字符。token 粗估（见 estimateTokens）：
 * 全中文最坏 ≈ (820+560+280)/1.5 ≈ 1107 tokens，仍 ≤ 任务预算 ~1.2k；
 * 全 ASCII ≈ 415 tokens。该上限同时被测试锁定（超长会话仍 ≤ 上限）。
 */
export declare const PROMPT_MAX_CHARS = 2000;
/** 任务预算：≈1.2k tokens（估计口径见 estimateTokens 注释） */
export declare const PROMPT_TOKEN_BUDGET = 1200;
/** 按 Unicode 码点截断字符串（超过 cap 取前 cap 个码点，不加省略号） */
export declare function truncateUnicode(s: string, cap: number): string;
/**
 * prompt 的 token 粗估（成本护栏用确定性公式，非精确计费）：
 * ASCII 按 4 字符/token、CJK 及其余按 1.5 字符/token（保守上界）。
 * 仅用于预算断言，不参与任何计费。
 */
export declare function estimateTokens(s: string): number;
/**
 * 从会话元数据构造单次摘要的 prompt（确定性、禁全文）。
 *
 * 模板 = google-gemini/gemini-cli `sessionSummaryService.ts` 的 SUMMARY_PROMPT
 * 逐字沿用（@ 3c311bea，见文件头来源 2）：ONE sentence / max 80 characters /
 * 意图聚焦 / 示例 / "Summary (max 80 chars):" 结尾；`{conversation}` 槽位替换为
 * 本插件的确定性结构化会话摘录（title + firstUserText 前 200 码点 +
 * lastAssistantText 前 500 码点 + counts 前 8 类 + toolCallCounts top5 +
 * 时间跨度）——各段上限对应 gemini 的 MAX_MESSAGE_LENGTH=500 截断策略。
 */
export declare function buildLlmPrompt(meta: SessionMeta): string;
/**
 * 摘要 provider 抽象：生产实现走宿主 LLM 流式聚合；测试注入 fake。
 * 约定：实现方负责 10s 超时与 maxTokens=64（成本护栏集中在 host 实现内）；
 * summarize 失败 → throw（服务层捕获 → fail-open + lastError，不重试）。
 */
export interface LlmSummaryProvider {
    /** 供 status 快照展示的 provider 路由 id（决议失败的服务为 ''） */
    readonly providerId: string;
    summarize(prompt: string, signal: AbortSignal | undefined): Promise<string>;
}
/** provider 决议失败原因回调（供 index.ts 打日志；可观测性） */
export type ProviderUnavailableHandler = (reason: string) => void;
/**
 * 生产实现（宿主 LlmRuntime 的 DSH 适配；E1：宿主只有流式对话 API）：
 * - provider = 首个已注册路由（listProviders()[0].id）；
 * - model = 该 provider 首个 advertised 模型（listModels()[0].id）；
 *   两者任一缺失 → 抛错（服务层 fail-open），绝不写死 provider/model；
 * - 消息构造用 createUserMessage（dsh-llm 不可变消息契约）；
 * - 流式聚合用 BlockAssembler（唯一共享组装算法）；
 * - finish kind ∈ {error, aborted, max-tokens} 视为失败抛错；空文本抛错；
 * - 超时 = AbortSignal.timeout(10s)（调用方未给 signal 时）。
 * - 决议失败（无 llm 服务 / 未注册 provider / 无模型目录）→ null，并回调
 *   onUnavailable 携带具体原因（可观测性：status lastError + 插件日志）。
 */
export declare function createHostLlmProvider(ctx: Context, onUnavailable?: ProviderUnavailableHandler): LlmSummaryProvider | null;
/** 单条缓存（v:1 行结构；key=sessionId） */
export interface SummaryCacheEntry {
    v: number;
    sessionId: string;
    file: string;
    /** 会话文件指纹：size */
    size: number;
    /** 会话文件指纹：mtimeMs */
    mtimeMs: number;
    /** 已截断到 80 码点的一句话摘要（成功结果才入库） */
    summary: string;
    createdAt: number;
}
/** 缺省 sidecar 路径：%DSH_HOME%\session-index\llm-summary.jsonl（与 fts.db 同级） */
export declare function defaultSummaryCacheFile(dshHome: string): string;
/** 会话文件指纹（缓存的失效判据：任一变化 → 重新生成） */
export interface SessionFingerprint {
    size: number;
    mtimeMs: number;
}
/** 指纹命中判定（size + mtimeMs 全等才算命中） */
export declare function fingerprintMatches(entry: Pick<SummaryCacheEntry, 'size' | 'mtimeMs'>, fp: SessionFingerprint): boolean;
/** 校验并归一化一行缓存；形状不符（含 v!==1）→ null（计坏行）。 */
export declare function normalizeSummaryEntry(obj: unknown): SummaryCacheEntry | null;
/** 解析 JSONL 文本：逐行容错（坏行跳过并计数）；同 sessionId 最新行胜出。 */
export declare function parseSummaryLines(text: string): {
    entries: SummaryCacheEntry[];
    skippedBad: number;
};
/** 显式失效（追加后调用），防同 ms 同 size 撞车。 */
export declare function invalidateSummaryCache(path: string): void;
/**
 * 整读 + 容错 + 最新胜出；mtimeMs+size 指纹缓存（照 bookmark.ts readBookmarks /
 * core.ts loadIndex 模式）。文件缺失/读失败 → 空列表（fail-open，绝不抛）。
 */
export declare function readSummaryCache(path: string): Promise<{
    entries: SummaryCacheEntry[];
    skippedBad: number;
}>;
/** 追加一条缓存行（append + flush；per-path 互斥，照 bookmark addBookmark）。 */
export declare function appendSummaryEntry(path: string, entry: SummaryCacheEntry): Promise<void>;
export interface LlmSummaryResult {
    /** 成功 → 一句话（≤80 码点）；禁用/失败/未命中且调用失败 → undefined */
    summary?: string;
    /** 本次是否走缓存命中（零调用） */
    cached: boolean;
    /** 最近一次失败的摘要（供状态快照，不进输出） */
    lastError?: string;
}
export interface LlmSummaryServiceOptions {
    /** llmSummaryEnabled 开关（false → 完全零执行） */
    enabled: boolean;
    /**
     * 生产 = createHostLlmProvider(ctx)；测试注入 fake；null = fail-open。
     * 也接受 () => provider|null 的**懒解析**：宿主 llm 服务可能晚于插件 apply
     * 就绪（或适配器后注册），首次 getSummary/health 时才决议（线上实证：apply
     * 期决议为空，需懒解析——见 work/PLAN_v4.md STAGE-4 记录）。disabled 时
     * 不调用该函数（零执行，不触碰 ctx.llm）。
     */
    provider: LlmSummaryProvider | null | (() => LlmSummaryProvider | null);
    /** sidecar 路径（%DSH_HOME%\session-index\llm-summary.jsonl） */
    cacheFile: string;
    /** 时间源（测试注入） */
    now?: () => number;
}
export interface LlmSummaryHealth {
    enabled: boolean;
    ok: boolean;
    cached: number;
    lastError: string | null;
    provider: string;
}
/**
 * 摘要服务（唯一挂接点 = session_summary 工具路径 + status 健康快照）：
 * - enabled=false → 零执行（不读/写缓存、不触碰 provider）；
 * - 缓存命中（指纹全等）→ 零调用直接返回；
 * - 未命中 → 单飞复用（同 session 并发只发一次模型调用）；
 * - 失败 → lastError + 确定性回退（调用方不附加 llmSummary），不缓存不重试；
 * - 成功 → 截断到 80 码点后 append 入库（写失败只忽略，不影响当次结果）。
 */
export declare function createLlmSummaryService(opts: LlmSummaryServiceOptions): {
    getSummary(meta: SessionMeta, fp: SessionFingerprint): Promise<LlmSummaryResult>;
    health(): Promise<LlmSummaryHealth>;
};
