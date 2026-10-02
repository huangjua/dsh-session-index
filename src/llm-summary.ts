/**
 * llm-summary.ts — STAGE-4：可选 LLM 一句话会话摘要（全局红线 3 的唯一例外路径）
 *
 * ── 红线 3 修订（用户 2026-08-27 批准，见 work/PLAN_v4.md 修订记录）──
 * 「零 LLM 文本生成；唯一例外 = llmSummary 可选路径：llmSummaryEnabled 开关内、
 * 按需单会话、缓存 sidecar、成本护栏（maxTokens=64 / 10s 超时 / 失败不重试 /
 * 只在 session_summary 工具路径触发，构建/扫描路径禁止调用）。」
 *
 * ── 借鉴来源（共同前提：pinned 副本与 SHA 见 work/reference/borrow/）──
 * 1. hermes PR#51125（`reference/borrow/hermes-session-search-pr51125/upstream.patch`，
 *    patch 模式）—— EmbeddingProvider ABC + resolve 工厂（Strategy + DI 的形状）
 *    → 本模块 `LlmSummaryProvider` 接口 + `createHostLlmProvider` 工厂：
 *    测试注入 fake（DI），生产实现从宿主 `ctx.llm`（LlmRuntime）取流式对话 API；
 * 2. google-gemini/gemini-cli @ `3c311beac2e78336816dd4a123db39743f9fbf85`
 *    （Apache-2.0，`reference/borrow/gemini-cli/`）—— **prompt 模板与截断策略直接搬**：
 *    `packages/core/src/services/sessionSummaryService.ts` 的 `SUMMARY_PROMPT`
 *    （ONE sentence / max 80 characters / 意图聚焦 / 示例 / "Summary (max 80 chars):"
 *    结尾）逐字沿用；其 `MAX_MESSAGE_LENGTH=500`（单条消息截断）与
 *    `DEFAULT_MAX_MESSAGES=20`（条数上限）策略映射为本模块的逐字段码点上限
 *    （title 120 / firstUser 200 / lastAssistant 500 / counts 8 / tools 5）。
 *    会话列表示题截断（`packages/cli/src/utils/sessions.ts` 100→97+…）仅参考。
 * 3. openai/codex @9ded177（Apache-2.0）—— 上游补查结论 = **core/tui 无 LLM
 *    标题/摘要 prompt**：`codex-rs/tui/src/terminal_title.rs` 仅 OSC 清洗+240 上限、
 *    `app-server/.../thread_summary.rs` 摘要/标题从 rollout 确定性派生 → 按共同
 *    前提 0.3 降级记录（核对证据见 `reference/borrow/codex-tui-llm/`），不搬。
 * 4. 存储/并发照抄自家 `src/bookmark.ts`（其又对照 codex session_index.rs @9ded177）：
 *    append-only JSONL + 逐行容错读（坏行跳过并计数）+ mtime/size 指纹缓存 +
 *    per-path 互斥追加 + fsync（flush）。
 * 5. continuedev/continue summarize.py —— 指定文件不可达/不存在（main tree /
 *    推测 tag / PyPI sdist 三路核对），降级记录见 `reference/borrow/continue-summarize/`。
 *
 * ── 成本护栏（本模块全部路径）──
 * - 只在 `session_summary` 工具路径单会话触发一次；构建/扫描路径禁止调用；
 * - `maxTokens=64`（max_tokens 硬上限）+ 输出再按 80 码点截断（双保险）；
 * - 10s 超时（AbortSignal.timeout）；失败不重试（单次调用即释放）；
 * - 缓存 sidecar：`%DSH_HOME%\session-index\llm-summary.jsonl`，key=sessionId，
 *   指纹 = 会话文件 (size, mtimeMs) 变化即失效；命中零调用；
 *   同 session 在飞 Promise 复用（并发单飞）；
 * - `llmSummaryEnabled=false` → 完全零执行：不读/写缓存、不触碰 `ctx.llm`。
 *
 * ── 红线 ──
 * - 零新 npm 依赖（仅 node: 内建 + 宿主 @deepseek-ai/dsh-llm 类型/运行时）；
 * - 只写本模块 sidecar（llm-summary.jsonl）；绝不写 index.json / fts.db /
 *   官方库 / 会话文件；主线程不阻塞（全部异步 IO + 流式聚合）。
 */
import { join } from 'node:path'
// C10：与 bookmark.ts 共享的旁车文件公共层（锁 / 追加 / 指纹缓存 / 校验守卫）
import { withPathLock, appendLine, isRecord, str, num, createFingerprintCache } from './sidecar.js'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionMeta } from './core.js'

/* ── 常量与预算（成本护栏的显式数值）──────────────────────────────────── */

/** sidecar 文件名（与 fts.db / bookmarks.jsonl 同级） */
export const SUMMARY_CACHE_FILE_NAME = 'llm-summary.jsonl'
/** 行结构版本（读取只接受 v===1） */
export const SUMMARY_CACHE_VERSION = 1
/** 输出一句话上限（任务：≤80 字；按 Unicode 码点计） */
export const SUMMARY_CHAR_CAP = 80
/** 单次模型调用输出 token 上限（max_tokens=64） */
export const LLM_MAX_TOKENS = 64
/** 单次模型调用超时（10s；AbortSignal.timeout） */
export const LLM_TIMEOUT_MS = 10_000
/** 摘要温度（确定性优先；无 LLM 语义变化，仅采样参数） */
export const LLM_TEMPERATURE = 0

/* ── prompt 输入预算（任务执行细节 2：确定性、禁全文）──────────────────── */

/** title 参与 prompt 的码点上限 */
export const PROMPT_TITLE_CAP = 120
/** firstUserText 参与 prompt 的码点上限（任务：前 200 字） */
export const PROMPT_FIRST_USER_CAP = 200
/** lastAssistantText 参与 prompt 的码点上限（任务：前 500 字） */
export const PROMPT_LAST_ASSISTANT_CAP = 500
/** counts 参与 prompt 的类别数上限（任务：前 8 类） */
export const PROMPT_COUNTS_TOP = 8
/** toolCallCounts 参与 prompt 的条目数上限（任务：top5） */
export const PROMPT_TOOL_TOP = 5
/** counts 单条目文本长度上限（条目长尾截断，保证总预算收敛） */
export const PROMPT_COUNT_ENTRY_CAP = 40
/** toolCallCounts 单条目文本长度上限 */
export const PROMPT_TOOL_ENTRY_CAP = 48
/**
 * prompt 总字符硬上限：固定段（120+200+500=820 码点）+ counts/tools（≤~560）
 * + 模板脚手架（~280）→ 上限 2000 字符。token 粗估（见 estimateTokens）：
 * 全中文最坏 ≈ (820+560+280)/1.5 ≈ 1107 tokens，仍 ≤ 任务预算 ~1.2k；
 * 全 ASCII ≈ 415 tokens。该上限同时被测试锁定（超长会话仍 ≤ 上限）。
 */
export const PROMPT_MAX_CHARS = 2000
/** 任务预算：≈1.2k tokens（估计口径见 estimateTokens 注释） */
export const PROMPT_TOKEN_BUDGET = 1200

/** 按 Unicode 码点截断字符串（超过 cap 取前 cap 个码点，不加省略号） */
export function truncateUnicode(s: string, cap: number): string {
  const chars = [...s]
  return chars.length <= cap ? s : chars.slice(0, cap).join('')
}

/**
 * prompt 的 token 粗估（成本护栏用确定性公式，非精确计费）：
 * ASCII 按 4 字符/token、CJK 及其余按 1.5 字符/token（保守上界）。
 * 仅用于预算断言，不参与任何计费。
 */
export function estimateTokens(s: string): number {
  let ascii = 0
  let cjk = 0
  for (const ch of s) {
    if (/[\u0000-\u007F]/.test(ch)) ascii++
    else cjk++
  }
  return Math.ceil(ascii / 4 + cjk / 1.5)
}

/* ── prompt 构造（确定性、禁全文；模板文本见顶部 TODO-LLM-PROMPT）───────── */

const compactEntries = (obj: Record<string, number> | undefined, top: number, cap: number, fmt: (k: string, n: number) => string): string => {
  if (!obj) return '-'
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)) // 同数按 key 升序（确定性）
    .slice(0, top)
    .map(([k, n]) => truncateUnicode(fmt(k, n), cap))
    .join(' ')
}

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
export function buildLlmPrompt(meta: SessionMeta): string {
  const title = truncateUnicode(meta.title || '(untitled)', PROMPT_TITLE_CAP)
  const firstUser = truncateUnicode(meta.firstUserText || '', PROMPT_FIRST_USER_CAP)
  const lastAssistant = truncateUnicode(meta.lastAssistantText || '', PROMPT_LAST_ASSISTANT_CAP)
  const counts = compactEntries(meta.counts, PROMPT_COUNTS_TOP, PROMPT_COUNT_ENTRY_CAP, (k, n) => `${k}=${n}`)
  const tools = compactEntries(meta.toolCallCounts, PROMPT_TOOL_TOP, PROMPT_TOOL_ENTRY_CAP, (k, n) => `${k}×${n}`)
  const createdAt = new Date(meta.createdAt || 0).toISOString()
  const lastTime = new Date(meta.lastTime || 0).toISOString()
  const duration = Math.round(Math.max(0, (meta.lastTime || 0) - (meta.createdAt || 0)) / 1000)
  // 模板逐字来自 gemini-cli sessionSummaryService.ts（SUMMARY_PROMPT 常量）；
  // Conversation 槽位内容为本插件的确定性输入构造（禁全文）。
  const template = `Summarize the user's primary intent or goal in this conversation in ONE sentence (max 80 characters).
Focus on what the user was trying to accomplish.

Examples:
- "Add dark mode to the app"
- "Fix authentication bug in login flow"
- "Understand how the API routing works"
- "Refactor database connection logic"
- "Debug memory leak in production"

Conversation:
会话标题：${title}
用户首条消息（前 ${PROMPT_FIRST_USER_CAP} 字）：${firstUser || '(空)'}
助手末条消息（前 ${PROMPT_LAST_ASSISTANT_CAP} 字）：${lastAssistant || '(空)'}
事件统计（前 ${PROMPT_COUNTS_TOP} 类）：${counts}
工具调用（top${PROMPT_TOOL_TOP}）：${tools}
时间跨度：${createdAt} → ${lastTime}（${duration}s）

Summary (max 80 chars):`
  return template
}

/* ── provider 抽象（hermes EmbeddingProvider 的 DI 形状：接口 + 工厂）────── */

/**
 * 摘要 provider 抽象：生产实现走宿主 LLM 流式聚合；测试注入 fake。
 * 约定：实现方负责 10s 超时与 maxTokens=64（成本护栏集中在 host 实现内）；
 * summarize 失败 → throw（服务层捕获 → fail-open + lastError，不重试）。
 */
export interface LlmSummaryProvider {
  /** 供 status 快照展示的 provider 路由 id（决议失败的服务为 ''） */
  readonly providerId: string
  summarize(prompt: string, signal: AbortSignal | undefined): Promise<string>
}

/** provider 决议失败原因回调（供 index.ts 打日志；可观测性） */
export type ProviderUnavailableHandler = (reason: string) => void

/**
 * 从宿主 ctx 取 LlmRuntime（fail-open）：
 * 1) 属性访问 `ctx.llm` —— cordis 会在未把 'llm' 声明进插件 inject 时抛出
 *    "cannot get property llm without inject"（线上实证，见 work/PLAN_v4.md
 *    STAGE-4 记录）；
 * 2) 被拦截 → 回退 `ctx.get('llm')`（cordis 免注入读 store 的 API，未提供时
 *    返回 undefined，不抛）——**不把 llm 变成插件硬依赖**（红线 7 fail-open：
 *    无 llm 部署本插件照常加载，确定性摘要可用）。
 */
function getLlmRuntime(ctx: Context): unknown {
  try {
    return (ctx as unknown as { llm?: unknown }).llm
  } catch {
    const get = (ctx as unknown as { get?: (name: string, strict?: boolean) => unknown }).get
    if (typeof get === 'function') {
      try {
        return get.call(ctx, 'llm')
      } catch {
        return undefined
      }
    }
    return undefined
  }
}

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
export function createHostLlmProvider(
  ctx: Context,
  onUnavailable?: ProviderUnavailableHandler,
): LlmSummaryProvider | null {
  try {
    const llm = getLlmRuntime(ctx)
    const runtime = llm as {
      stream?: (o: GenerateOptions) => AsyncIterable<StreamChunk>
      listProviders?: () => { id: string }[] | null
      listModels?: (provider: string) => Promise<{ id: string }[]> | { id: string }[]
    } | null
    if (!runtime || typeof runtime.stream !== 'function' || typeof runtime.listProviders !== 'function') {
      onUnavailable?.('ctx.llm 不可用（未注入 llm 或宿主无 llm 服务）')
      return null
    }
    const providers = runtime.listProviders()
    if (!providers || providers.length === 0) {
      onUnavailable?.('宿主无已注册 provider 路由')
      return null
    }
    const providerId = providers[0].id
    if (!providerId) {
      onUnavailable?.('首个 provider 路由 id 为空')
      return null
    }
    if (typeof runtime.listModels !== 'function') {
      onUnavailable?.('ctx.llm 无 listModels（模型目录不可用）')
      return null // 模型目录缺失 → fail-open
    }
    return {
      providerId,
      async summarize(prompt: string, signal: AbortSignal | undefined): Promise<string> {
        const models = await runtime.listModels!(providerId)
        const model = models?.[0]?.id
        if (!model) throw new Error(`llm-summary: provider ${providerId} 无可用模型`)
        const messages: Message[] = [
          createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }),
        ]
        const usedSignal = signal ?? AbortSignal.timeout(LLM_TIMEOUT_MS)
        const chunks = runtime.stream!({
          provider: providerId,
          model,
          messages,
          maxTokens: LLM_MAX_TOKENS,
          temperature: LLM_TEMPERATURE,
          signal: usedSignal,
        })
        const assembler = new BlockAssembler()
        try {
          for await (const chunk of chunks) assembler.push(chunk)
        } catch (e) {
          throw new Error(`llm-summary: stream 中断: ${String(e)}`)
        }
        const fin = assembler.finish
        if (fin.kind === 'error' || fin.kind === 'aborted') {
          throw new Error(`llm-summary: ${fin.kind} ${fin.failure?.message ?? fin.failure?.code ?? ''}`.trim())
        }
        const text = assembler
          .blocks()
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim()
        if (!text) throw new Error('llm-summary: 空响应')
        return text
      },
    }
  } catch (e) {
    onUnavailable?.(`决议异常: ${e instanceof Error ? e.message : String(e)}`)
    return null // fail-open：宿主无 llm 服务/决议失败 → 确定性回退
  }
}

/* ── 缓存 sidecar（C10：append-only + 容错读 + 指纹 + per-path 互斥，公共层 sidecar.ts）─ */

/** 单条缓存（v:1 行结构；key=sessionId） */
export interface SummaryCacheEntry {
  v: number
  sessionId: string
  file: string
  /** 会话文件指纹：size */
  size: number
  /** 会话文件指纹：mtimeMs */
  mtimeMs: number
  /** 已截断到 80 码点的一句话摘要（成功结果才入库） */
  summary: string
  createdAt: number
}

/** 缺省 sidecar 路径：%DSH_HOME%\session-index\llm-summary.jsonl（与 fts.db 同级） */
export function defaultSummaryCacheFile(dshHome: string): string {
  return join(dshHome, 'session-index', SUMMARY_CACHE_FILE_NAME)
}

/** 会话文件指纹（缓存的失效判据：任一变化 → 重新生成） */
export interface SessionFingerprint {
  size: number
  mtimeMs: number
}

/** 指纹命中判定（size + mtimeMs 全等才算命中） */
export function fingerprintMatches(entry: Pick<SummaryCacheEntry, 'size' | 'mtimeMs'>, fp: SessionFingerprint): boolean {
  return entry.size === fp.size && entry.mtimeMs === fp.mtimeMs
}

/** 校验并归一化一行缓存；形状不符（含 v!==1）→ null（计坏行）。 */
export function normalizeSummaryEntry(obj: unknown): SummaryCacheEntry | null {
  if (!isRecord(obj)) return null
  if (obj.v !== SUMMARY_CACHE_VERSION) return null
  const sessionId = str(obj.sessionId)
  const file = str(obj.file)
  const summary = str(obj.summary)
  const size = num(obj.size)
  const mtimeMs = num(obj.mtimeMs)
  const createdAt = num(obj.createdAt)
  if (!sessionId || !file || summary === null || size === null || mtimeMs === null || createdAt === null) return null
  return { v: SUMMARY_CACHE_VERSION, sessionId, file, size, mtimeMs, summary, createdAt }
}

/** 解析 JSONL 文本：逐行容错（坏行跳过并计数）；同 sessionId 最新行胜出。 */
export function parseSummaryLines(text: string): { entries: SummaryCacheEntry[]; skippedBad: number } {
  const byKey = new Map<string, SummaryCacheEntry>()
  let skippedBad = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      skippedBad++
      continue
    }
    const e = normalizeSummaryEntry(obj)
    if (!e) {
      skippedBad++
      continue
    }
    byKey.set(e.sessionId, e) // 后写覆盖先写 → 最新胜出（照 bookmark 尾扫描语义）
  }
  return { entries: Array.from(byKey.values()), skippedBad }
}

const summaryCache = createFingerprintCache<{ entries: SummaryCacheEntry[]; skippedBad: number }>()

/** 显式失效（追加后调用），防同 ms 同 size 撞车。 */
export function invalidateSummaryCache(path: string): void {
  summaryCache.invalidate(path)
}

/**
 * 整读 + 容错 + 最新胜出；mtimeMs+size 指纹缓存（照 bookmark.ts readBookmarks /
 * core.ts loadIndex 模式）。文件缺失/读失败 → 空列表（fail-open，绝不抛）。
 */
export async function readSummaryCache(path: string): Promise<{ entries: SummaryCacheEntry[]; skippedBad: number }> {
  // C10：指纹缓存 + 整读容错下沉到 sidecar（与 bookmark 同一实现）
  return summaryCache.read(path, parseSummaryLines, () => ({ entries: [], skippedBad: 0 }))
}

/** 追加一条缓存行（append + flush；per-path 互斥，照 bookmark addBookmark）。 */
export function appendSummaryEntry(path: string, entry: SummaryCacheEntry): Promise<void> {
  return withPathLock(path, async () => {
    await appendLine(path, JSON.stringify(entry))
    invalidateSummaryCache(path)
  })
}

/* ── 服务：开关 + 缓存 + 单飞 + fail-open（index.ts 只在此挂接）────────────── */

export interface LlmSummaryResult {
  /** 成功 → 一句话（≤80 码点）；禁用/失败/未命中且调用失败 → undefined */
  summary?: string
  /** 本次是否走缓存命中（零调用） */
  cached: boolean
  /** 最近一次失败的摘要（供状态快照，不进输出） */
  lastError?: string
}

export interface LlmSummaryServiceOptions {
  /** llmSummaryEnabled 开关（false → 完全零执行） */
  enabled: boolean
  /**
   * 生产 = createHostLlmProvider(ctx)；测试注入 fake；null = fail-open。
   * 也接受 () => provider|null 的**懒解析**：宿主 llm 服务可能晚于插件 apply
   * 就绪（或适配器后注册），首次 getSummary/health 时才决议（线上实证：apply
   * 期决议为空，需懒解析——见 work/PLAN_v4.md STAGE-4 记录）。disabled 时
   * 不调用该函数（零执行，不触碰 ctx.llm）。
   */
  provider: LlmSummaryProvider | null | (() => LlmSummaryProvider | null)
  /** sidecar 路径（%DSH_HOME%\session-index\llm-summary.jsonl） */
  cacheFile: string
  /** 时间源（测试注入） */
  now?: () => number
}

export interface LlmSummaryHealth {
  enabled: boolean
  ok: boolean
  cached: number
  lastError: string | null
  provider: string
}

/** 进程内单飞表：key = cacheFile + sessionId（跨 service 实例也复用） */
const inflight = new Map<string, Promise<LlmSummaryResult>>()

/**
 * 摘要服务（唯一挂接点 = session_summary 工具路径 + status 健康快照）：
 * - enabled=false → 零执行（不读/写缓存、不触碰 provider）；
 * - 缓存命中（指纹全等）→ 零调用直接返回；
 * - 未命中 → 单飞复用（同 session 并发只发一次模型调用）；
 * - 失败 → lastError + 确定性回退（调用方不附加 llmSummary），不缓存不重试；
 * - 成功 → 截断到 80 码点后 append 入库（写失败只忽略，不影响当次结果）。
 */
export function createLlmSummaryService(opts: LlmSummaryServiceOptions): {
  getSummary(meta: SessionMeta, fp: SessionFingerprint): Promise<LlmSummaryResult>
  health(): Promise<LlmSummaryHealth>
} {
  const cacheFile = opts.cacheFile
  const now = opts.now ?? Date.now
  let lastError: string | null = null
  /** 解析当前 provider（支持懒解析函数；disabled 时恒 null，不触碰 ctx.llm） */
  const resolveProvider = (): LlmSummaryProvider | null => {
    if (!opts.enabled) return null
    const p = opts.provider
    return typeof p === 'function' ? p() : p
  }

  async function getSummary(meta: SessionMeta, fp: SessionFingerprint): Promise<LlmSummaryResult> {
    if (!opts.enabled) return { cached: false } // 完全零执行
    const provider = resolveProvider()
    if (!provider) {
      lastError = 'llm provider 不可用（宿主无已注册路由或模型目录为空）'
      return { cached: false, lastError }
    }
    const key = `${cacheFile}\u0000${meta.id}`
    const inFlight = inflight.get(key)
    if (inFlight) return inFlight
    const run = (async (): Promise<LlmSummaryResult> => {
      const { entries } = await readSummaryCache(cacheFile)
      const hit = entries.find((e) => e.sessionId === meta.id)
      if (hit && hit.file === meta.file && fingerprintMatches(hit, fp)) {
        lastError = null
        return { summary: hit.summary, cached: true }
      }
      try {
        const raw = await provider.summarize(buildLlmPrompt(meta), undefined)
        const summary = truncateUnicode(raw, SUMMARY_CHAR_CAP)
        lastError = null
        try {
          await appendSummaryEntry(cacheFile, {
            v: SUMMARY_CACHE_VERSION,
            sessionId: meta.id,
            file: meta.file,
            size: fp.size,
            mtimeMs: fp.mtimeMs,
            summary,
            createdAt: now(),
          })
        } catch {
          /* 缓存写失败忽略（sidecar 可随时重建；不影响当次结果） */
        }
        return { summary, cached: false }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e) // fail-open，不缓存不重试
        return { cached: false, lastError }
      }
    })()
    inflight.set(key, run)
    try {
      return await run
    } finally {
      inflight.delete(key)
    }
  }

  async function health(): Promise<LlmSummaryHealth> {
    let cached = 0
    if (opts.enabled) {
      const { entries } = await readSummaryCache(cacheFile)
      cached = entries.length
    }
    const provider = resolveProvider()
    return {
      enabled: opts.enabled,
      ok: opts.enabled && !!provider && lastError === null,
      cached,
      lastError,
      provider: opts.enabled ? (provider?.providerId ?? '') : '',
    }
  }

  return { getSummary, health }
}
