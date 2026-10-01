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
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { join, basename, dirname, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { statSync, mkdirSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  loadIndex,
  metaMatch,
  findSession,
  summarizeSession,
  resolveRoot,
  parseCursor,
  formatCursor,
  cursorStartIndex,
  scanSessionFiles,
} from './core.js'
import type { SessionIndex, SessionMeta, SearchHit } from './core.js'
import { getBuilder } from './session-index-builder.js'
import type { BuildProgress, BuildOptions } from './session-index-builder.js'
import { createSessionWatcher } from './watcher.js'
import { createSessionFts } from './fts.js'
import type { SessionFts, FtsHit, SearchFilter } from './fts.js'
import { MATCH_OPEN, MATCH_CLOSE, normalizeReservedMarkers, queryUsesLikePath } from './fts.js'
// STAGE-1 Part A：会话级相关性排序（fzy 打分 + atuin 档位 + mcfly 特征 + tiebreak）
import { sortSessions } from './rank.js'
// STAGE-2 Part A：书签 sidecar 存储（codex session_index.rs 语义 + aider 幂等）
import {
  addBookmark,
  readBookmarks,
  removeBookmarks,
  bookmarkMatches,
  sortBookmarks,
  defaultLabel,
  BOOKMARK_FILE_NAME,
  BOOKMARK_LIST_LIMIT_DEFAULT,
  BOOKMARK_LIST_LIMIT_MAX,
} from './bookmark.js'
// STAGE-4：可选 LLM 一句话摘要（红线 3 修订的唯一例外路径；provider 抽象 + 缓存单飞）
import {
  createHostLlmProvider,
  createLlmSummaryService,
  SUMMARY_CACHE_FILE_NAME,
} from './llm-summary.js'

export const name = '@dsh-external/dsh-session-index'
export const inject = ['tools']

export interface Config {
  sessionsRoot: string
  indexFile: string
  /** 派生数据的落盘目录（index.json / fts.db / bookmarks.jsonl / llm-summary.jsonl）。
   * 缺省空 → `$DSH_HOME/session-index`；设为绝对路径可把整份索引搬到别的盘
   * （例如 C 盘吃紧时指向大容量盘），目录不存在会自动创建。 */
  dataDir?: string
  maxHits: number
  maxSnippetsPerSession: number
  /** P2.1：FTS 总开关（默认开）。false 时完全跳过 createSessionFts（不 import
   * node:sqlite、不打开/创建 fts.db），mode=full 自动走 worker 流式回退，
   * SCROLL 返回既有"FTS 不可用"错误对象。 */
  ftsEnabled: boolean
  /** P3：索引保留策略天数（0=关闭，默认 90）。只清理 index.json 条目与
   * fts.db（sessions+messages）行，**绝不删除/重命名/截断会话文件**。 */
  retentionDays: number
  /** STAGE-4：可选 LLM 一句话摘要开关（默认开，用户 2026-08-27 批准）。
   * 红线 3 修订：零 LLM 文本生成；唯一例外 = 本开关内、按需单会话、缓存、
   * 成本护栏（maxTokens=64/10s 超时/失败不重试/只在 session_summary 路径）。
   * false → 完全零执行（不读/写缓存、不触碰 ctx.llm）。 */
  llmSummaryEnabled: boolean
  /** C9：增量（delta）索引开关（默认开）。活跃会话每 5s 被 watcher 重建时只解
   * 新增帧；窗口内出现 surface 替换会自动回退全量（正确性优先）。
   * false → 一律全量重解析（回归排查/故障时的即时退路）。 */
  deltaEnabled?: boolean
}

export const Config: Schemastery<any, any> = z.object({
  sessionsRoot: z.string().default(''),
  indexFile: z.string().default(''),
  dataDir: z.string().default(''),
  maxHits: z.number().min(1).max(500).default(50),
  maxSnippetsPerSession: z.number().min(1).max(20).default(3),
  ftsEnabled: z.boolean().default(true),
  retentionDays: z.number().min(0).default(90),
  llmSummaryEnabled: z.boolean().default(true),
  deltaEnabled: z.boolean().default(true),
})

const text = (s: string): ContentBlock[] => [{ type: 'text', text: s }]

/**
 * P1.4：meta snippet 的命中区间标记（静态，无 LLM）。
 * 先归一化正文里已有的 >>> <<<（保留标记让位 snippet 专用），再包住首个命中。
 */
const markMatches = (raw: string, q: string): string => {
  const t = normalizeReservedMarkers(raw)
  const idx = t.toLowerCase().indexOf(q.toLowerCase())
  if (idx === -1) return t
  return t.slice(0, idx) + MATCH_OPEN + t.slice(idx, idx + q.length) + MATCH_CLOSE + t.slice(idx + q.length)
}

/** 从 session 文件路径取会话 id（与 builder 的 id 回退一致） */
const sessionIdFromFile = (file: string): string => basename(dirname(file))

/**
 * C11：删除无引用的 synthMeta——FTS 命中若缺少索引条目，搜索路径直接
 * `if (!meta) continue` 丢弃，从不合成兜底 meta（函数建成后从未被接线）。
 */

/** session_list 扫描上限（Codex MAX_SCAN_FILES=10000；DSH 暂定 2000） */
const MAX_LIST_SCAN = 2000

/* ── STAGE-1 Part B：session_index_search 的 filter 参数（消息级 role + 会话级时间）── */

interface SearchFilterArg {
  role?: string
  sinceMs?: number
  untilMs?: number
}

const ROLES = ['user', 'assistant', 'tool', 'any'] as const

/**
 * 归一化 filter 参数：非法 role 回退 'any'；非有限数字忽略；全默认（any + 无时间）
 * 返回 undefined（= 不带 filter，行为与改动前完全一致，逻辑零分支开销）。
 */
const normFilter = (f?: SearchFilterArg): SearchFilter | undefined => {
  if (!f || typeof f !== 'object') return undefined
  const rawRole = f.role ?? 'any'
  const role = (ROLES as readonly string[]).includes(rawRole) ? (rawRole as SearchFilter['role']) : 'any'
  const out: SearchFilter = { role }
  const since = Number(f.sinceMs)
  const until = Number(f.untilMs)
  if (Number.isFinite(since)) out.sinceMs = since
  if (Number.isFinite(until)) out.untilMs = until
  if (out.role === 'any' && out.sinceMs === undefined && out.untilMs === undefined) return undefined
  return out
}

/**
 * 会话级时间范围（降级口径：messages 无时间列 → meta.lastTime / sessions.last_time，
 * 三路径统一；schema 描述已注明）。
 */
const timePass = (s: SessionMeta, f?: SearchFilter): boolean => {
  if (!f) return true
  if (typeof f.sinceMs === 'number' && s.lastTime < f.sinceMs) return false
  if (typeof f.untilMs === 'number' && s.lastTime > f.untilMs) return false
  return true
}

/**
 * meta 路径的 role 判定：无消息粒度 → role='tool' 用 toolCallCounts 总和>0 近似
 * （schema 注明"会话级近似"）；user/assistant 无近似手段 → 恒 true 不过滤；
 * 'any' 恒 true。
 */
const metaRolePass = (s: SessionMeta, role: SearchFilter['role'] | undefined): boolean => {
  if (!role || role === 'any' || role === 'user' || role === 'assistant') return true
  if (role === 'tool') {
    let n = 0
    for (const v of Object.values(s.toolCallCounts ?? {})) n += Number(v) || 0
    return n > 0
  }
  return true
}

export function apply(ctx: Context, config: Config): void {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  // 派生数据目录：默认 $DSH_HOME/session-index；dataDir 可把整份索引移出系统盘。
  const dataDir = config.dataDir
    ? (isAbsolute(config.dataDir) ? resolve(config.dataDir) : resolve(process.cwd(), config.dataDir))
    : join(dshHome, 'session-index')
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch (error) {
    // 目录建不出来不阻断装载：后续写入会各自报错，这里只留一条诊断。
    console.warn(`[session-index] cannot create dataDir ${dataDir}: ${String(error)}`)
  }
  const sessionsRoot = resolveRoot(config.sessionsRoot)
  const indexFile = config.indexFile || join(dataDir, 'index.json')

  /* ── STAGE-4：可选 LLM 一句话摘要（红线 3 修订的唯一例外路径）────────────
   * 服务只挂 session_summary 工具路径与 status 健康快照；构建/扫描路径零调用。
   * llmSummaryEnabled=false → 完全不构造 provider、不触碰 ctx.llm（零执行）。
   * 生产 provider 走宿主 ctx.llm 流式聚合（E1：宿主只有流式对话 API）。
   * **懒解析**：宿主 llm 服务可能晚于插件 apply 就绪（线上实证 apply 期决议为
   * 空），故每次 getSummary/health 时才 createHostLlmProvider(ctx)；决议失败 →
   * session_summary 回退确定性摘要 + status 记 lastError + 本日志记录原因。 */
  const llmSummaryEnabled = config.llmSummaryEnabled !== false
  /** 懒解析（宿主 llm 服务可能晚于 apply 就绪/适配器后注册）：
   * - 成功结果记忆复用；失败不记忆（每次 health/getSummary 重试，晚起的服务
   *   可被拾起），失败原因日志按 30s 节流避免 status 轮询刷屏；
   * - createHostLlmProvider 内部经 ctx.get 免注入读取（cordis 守卫 + fail-open）；
   * - llmSummaryEnabled=false → 完全不触碰 ctx.llm（零执行）。 */
  let hostProvider: ReturnType<typeof createHostLlmProvider> = null
  let lastUnavailableLogAt = 0
  const onProviderUnavailable = (reason: string): void => {
    const now = Date.now()
    if (now - lastUnavailableLogAt > 30_000) {
      lastUnavailableLogAt = now
      log(`[session-index] llmSummary provider 不可用: ${reason}（确定性回退）`)
    }
  }
  const resolveLlmProvider = (): ReturnType<typeof createHostLlmProvider> => {
    if (!llmSummaryEnabled) return null
    if (hostProvider) return hostProvider
    const p = createHostLlmProvider(ctx, onProviderUnavailable)
    if (p) hostProvider = p
    return p
  }
  const llmSummary = createLlmSummaryService({
    enabled: llmSummaryEnabled,
    provider: resolveLlmProvider,
    cacheFile: join(dataDir, SUMMARY_CACHE_FILE_NAME),
  })

  let log: (msg: string) => void
  try {
    const logger = ctx.logger('session-index')
    log = (msg) => logger.info(msg)
  } catch {
    log = (msg) => console.info(msg)
  }

  const builder = getBuilder(sessionsRoot, indexFile)
  const abortController = new AbortController()

  /* ── P2：SQLite + FTS5 全文索引（异步启用，失败静默降级）────────────── */
  let fts: SessionFts | null = null
  const ftsDbPath = join(dataDir, 'fts.db')
  /** 统一 build 选项：任何构建都带上 FTS 钩子（collectMessages + 解析/删除回调）
 * 与 P3 保留过滤（retentionDays 进底座：任何顺序的构建（watcher 事件/对账/
 * 回填/保留专用）都按策略过滤超龄条目——实测竞态：若只有保留专用构建带
 * retentionDays，先起的无过滤构建会把保留构建单飞吸收（选项丢失 → pruned=0），
 * 或 prune 后的对账/事件构建把超龄条目重拾回索引。底座统一后任何构建先跑
 * 结果一致，watermark 只门控启动日的 VACUUM 专用通道。 */
  const ftsBuildOptions = (extra: { force?: boolean; signal?: AbortSignal; retentionDays?: number } = {}): BuildOptions => ({
    ...extra,
    onProgress,
    retentionDays: extra.retentionDays ?? config.retentionDays ?? 90,
    deltaEnabled: config.deltaEnabled !== false,
    collectMessages: fts?.ok ?? false,
    onSessionParsed: (file, meta, messages, append) => {
      if (!fts?.ok) return
      fts.upsertSession({
        file: meta.file,
        id: meta.id,
        workspace: meta.workspace,
        title: meta.title,
        agentPreset: meta.agentPreset,
        createdAt: meta.createdAt,
        lastTime: meta.lastTime,
        parentSession: meta.parentSession,
      })
      fts.syncMessages(file, messages, append)
    },
    onSessionRemoved: (file) => fts?.removeSession(file),
  })
  /* ── P3：索引保留策略（Hermes maybe_auto_prune_and_vacuum 的 DSH 适配）──────
   *
   * 启动期执行一次（FTS 就绪后、回填之后——保留清理必须是启动序列最后一次构建，
   * 否则在飞/后续构建会按事实源重拾磁盘上的超龄条目）：
   * - retentionDays<=0 → 策略关闭（log 注明）；
   * - fts 未启用 → 整个策略跳过（watermark 放在 fts.db state_meta，log 注明）；
   * - last_prune 距今 <24h → 跳过（照 Hermes 每日一次语义）；
   * - 经 builder.build({ retentionDays }) 在 merge 阶段把 max(lastTime, mtimeMs)
   *   超龄条目从 index.json 移除，并经 onSessionRemoved 通道同步删 fts.db 行
   *   （fts.removeSession）——**绝不触碰 ~/.dsh/sessions 下的会话文件**；
   * - 写 last_prune watermark（无论数量；跨进程共享于 fts.db）；
   * - 仅当本次 pruned>0 时 fts.vacuum()（其内部先 optimize；照 Hermes
   *   "VACUUM only when pruned>0"）；
   * - 任何失败只 log 不抛出（照 Hermes "never raises"）；VACUUM 是同步重型操作，
   *   只出现在本启动路径，绝不出现在工具调用路径。
   *
   * 已知行为（文档化）：本策略的执行点是"启动期每日一次对账"。运行中的工具构建
   * 按磁盘事实源重建索引（会话文件仍在则重新收录），下次启动再行清理；由于
   * DSH 部署重启频繁，索引实际大部分时间保持策略约束内。
   */
  async function maybeRetentionPrune(): Promise<void> {
    const days = config.retentionDays ?? 90
    if (!(days > 0)) {
      log('[session-index] retention disabled (retentionDays=0)')
      return
    }
    if (!fts?.ok) {
      log('[session-index] retention skipped: FTS unavailable (watermark 需要 fts.db)')
      return
    }
    try {
      const last = fts.lastPruneAt()
      if (last > 0 && Date.now() - last < 24 * 3600 * 1000) {
        log(`[session-index] retention skipped: last prune <24h ago (${new Date(last).toISOString()})`)
        return
      }
      const report = await builder.build(ftsBuildOptions({ retentionDays: days }))
      // 注意：即便本调用被在飞构建单飞吸收，底座也已统一携带 retentionDays——任一
      // 构建都会过滤超龄条目，pruned 计数来自实际执行的构建，语义一致。
      // ⚠️ 只有 completed 才算一次成功的保留尝试：skipped/failed（如 reload 期间
      // 旧 fiber 的 run-marker 未及释放）不写 watermark——否则按"已尝试"记账，
      // 24h 内不再重试，而实际 prune 可能根本没跑。
      if (report.status !== 'completed') {
        log(`[session-index] retention attempt ${report.status}; watermark 未写入（下次启动重试）`)
        return
      }
      fts.markPruned(report.pruned)
      if (report.pruned > 0) {
        // 等 onSessionRemoved（removeSession）写链落盘，再 VACUUM（内部先 optimize）
        await fts.flush()
        fts.vacuum()
      }
      log(
        `[session-index] retention day=${days}d pruned=${report.pruned} status=${report.status} vacuum=${report.pruned > 0} (会话文件未动)`,
      )
    } catch (e) {
      log(`[session-index] retention prune failed (never raises): ${String(e)}`)
    }
  }

  void (config.ftsEnabled !== false
    ? createSessionFts(ftsDbPath).then(async (f) => {
        fts = f
        if (f?.ok) {
          f.maybeMaintenance()
          log(`[session-index] FTS enabled: ${ftsDbPath}`)
          try {
            // 回填：DB 会话数 < 索引会话数（FTS 首次启用 / 索引已领先）→ 后台 force 一次。
            // builder.build 的 force 兜底（非 force 在飞时不吸收）+ 这里的事后复检：
            // 任何一步被打断都不会让 FTS 永久缺会话。
            const idx = loadIndex(indexFile)
            // C3 回填收敛：unindexable 条目保留在 index 但没有 FTS 行（builder 经
            // onSessionRemoved 删行，永久性）；detailMissing 条目尚未全量解析（可自愈）。
            // 两者都不构成"FTS 落后"信号——否则存在一个坏文件就会每次启动 force 全量
            // 重建 + 3 次重试，永不收敛（unindexable 恒在 → 判据恒真）。
            const ftsEligible = (s: SessionMeta): boolean => !s.unindexable && !s.detailMissing
            const idxEligible = idx?.sessions.filter(ftsEligible).length ?? 0
            if (idx && f.sessionCount() < idxEligible) {
              log(`[session-index] FTS backfill (db=${f.sessionCount()} index=${idxEligible})`)
              const backfill = async (attempt: number): Promise<void> => {
                try {
                  const r = await builder.build(ftsBuildOptions({ force: true }))
                  if (r.status === 'completed') log(`[session-index] FTS backfill done: ${r.durationMs}ms`)
                } catch (e) {
                  log(`[session-index] FTS backfill failed: ${String(e)}`)
                }
                const nowIdx = loadIndex(indexFile)
                const nowEligible = nowIdx?.sessions.filter(ftsEligible).length ?? 0
                if (nowIdx && f.sessionCount() < nowEligible && attempt < 3) {
                  log(`[session-index] FTS still behind (db=${f.sessionCount()} index=${nowEligible}); retry ${attempt + 1}/3`)
                  await new Promise((r) => setTimeout(r, 1000))
                  await backfill(attempt + 1)
                }
              }
              // ⚠️ 先等回填完成再执行保留清理：回填（force 全量）会按事实源重拾
              // 磁盘上的超龄条目，保留清理必须排在启动序列的最后一次构建，否则
              // prune 结果会被回填即时覆盖。
              await backfill(0)
            }
            await maybeRetentionPrune()
          } catch (e) {
            log(`[session-index] startup sequence error: ${String(e)}`)
          }
        } else {
          log('[session-index] FTS unavailable; mode=full falls back to streaming search')
        }
      })
    : (() => {
        // P2.1：配置关闭 → 不 import node:sqlite、不建库；回退路径与 SCROLL 错误对象已存在。
        // P3：fts 未启用时整个保留策略跳过（watermark 需要 fts.db）
        log('[session-index] FTS disabled by config (ftsEnabled=false); mode=full falls back to streaming search; retention skipped (watermark 需要 fts.db)')
      })())

  // 进度日志：节流 500ms（对应 BuildReport 的可观测性设计）
  let lastLogAt = 0
  const onProgress = (p: BuildProgress) => {
    const now = Date.now()
    if (now - lastLogAt < 500) return
    lastLogAt = now
    log(`[session-index] ${p.processed}/${p.total} (${p.phase}) scanned=${(p.scannedBytes / 1e6).toFixed(1)}MB delay=${p.delayMs}ms`)
  }

  async function ensureIndex(refresh: boolean, signal?: AbortSignal): Promise<SessionIndex> {
    if (!refresh) {
      const existing = loadIndex(indexFile)
      if (existing) {
        // 自愈（P0-2 改造）：detailMissing 条目 → 后台增量补齐；磁盘对账交给
        // watcher（变更驱动），不再每次调用全目录 stat。watcher 不可用时走
        // 10s 节流 stat 回退。single-flight 保证不并发重复构建。
        maybeAutoRefresh(existing)
        return existing
      }
    }
    const report = await builder.build(ftsBuildOptions({ force: refresh, signal: signal ?? abortController.signal }))
    if (report.status === 'skipped') {
      const existing = loadIndex(indexFile)
      if (existing) return existing
      throw new Error('索引构建被其他进程占用且无可用索引')
    }
    const loaded = loadIndex(indexFile)
    if (!loaded) throw new Error('会话索引构建后仍无法加载')
    return loaded
  }

  /* ── P0-2：自动增量补扫（watcher 变更驱动 + dirty/单飞循环 + 频率上限）── */
  const MIN_AUTO_BUILD_INTERVAL_MS = 5000
  let autoRefreshRunning = false
  let autoRefreshDirty = false
  let lastAutoBuildAt = 0
  let deferTimer: NodeJS.Timeout | null = null
  let watcherOk = false

  function clearDeferTimer(): void {
    if (deferTimer) {
      clearTimeout(deferTimer)
      deferTimer = null
    }
  }

  /**
   * P3：磁盘对账可比计数——保留策略启用时两侧都做同样的保留调整，对账才自洽：
   * - 磁盘侧：扣除 mtime 超龄文件（扫描无 lastTime，用文件 mtime 近似）；
   * - 索引侧：扣除 max(lastTime, mtimeMs) 超龄条目（与 builder merge 判定同构）。
   *
   * 实测竞态（2026-08，两轮）：①仅磁盘侧调整时，索引里若残留上一轮重拾的
   * 超龄条目（318 vs 319），对账会误判"漏索引"提前触发 auto-refresh，其构建
   * （无 retentionDays）把 maybeRetentionPrune 的 prune build 单飞吸收 → pruned=0；
   * ②不做调整时，prune 提交后对账（319 vs 318）又把超龄条目重拾回索引。
   * 两侧对称调整后：prune 前后对账都看到 318=318，既不误触发也不回卷。
   */
  function comparableDiskCount(files: { mtimeMs: number }[]): number {
    const days = config.retentionDays ?? 90
    const cutoff = days > 0 ? Date.now() - days * 86400e3 : 0
    if (cutoff <= 0) return files.length
    return files.filter((f) => f.mtimeMs >= cutoff).length
  }

  function comparableIndexCount(idx: SessionIndex): number {
    const days = config.retentionDays ?? 90
    const cutoff = days > 0 ? Date.now() - days * 86400e3 : 0
    if (cutoff <= 0) return idx.sessions.length
    return idx.sessions.filter((s) => Math.max(s.lastTime ?? 0, s.mtimeMs ?? 0) >= cutoff).length
  }

  function triggerAutoRefresh(reason: string): void {
    if (abortController.signal.aborted) return
    if (autoRefreshRunning) {
      autoRefreshDirty = true
      return
    }
    const now = Date.now()
    const wait = lastAutoBuildAt + MIN_AUTO_BUILD_INTERVAL_MS - now
    if (wait > 0) {
      // 频率上限内：标记 dirty + 定时器兜底（避免事件停止后 dirty 悬空）
      autoRefreshDirty = true
      if (!deferTimer) {
        deferTimer = setTimeout(() => {
          deferTimer = null
          if (autoRefreshDirty && !autoRefreshRunning && !abortController.signal.aborted) {
            autoRefreshDirty = false
            triggerAutoRefresh('deferred')
          }
        }, wait + 50)
      }
      return
    }
    lastAutoBuildAt = now
    autoRefreshRunning = true
    log(`[session-index] auto refresh (${reason})`)
    builder
      .build(ftsBuildOptions({ force: false, signal: abortController.signal }))
      .then((r) => {
        if (r.status === 'completed') {
          log(`[session-index] auto refresh done: added=${r.added} updated=${r.updated} removed=${r.removed}`)
        }
      })
      .catch((e) => log(`[session-index] auto refresh failed: ${String(e)}`))
      .finally(() => {
        autoRefreshRunning = false
        if (autoRefreshDirty && !abortController.signal.aborted) {
          autoRefreshDirty = false
          triggerAutoRefresh('dirty-while-running')
        }
      })
  }

  /**
   * 工具调用时的自愈检查（轻量，绝不 stat 目录）：
   * - detailMissing 条目 → 后台增量补齐；
   * - watcher 不可用 → 回退 10s 节流 disk-count 对账。
   */
  let lastFallbackScanAt = 0
  function maybeAutoRefresh(idx: SessionIndex): void {
    if (idx.sessions.some((s) => s.detailMissing)) {
      triggerAutoRefresh('detailMissing')
      return
    }
    if (watcherOk) return // watcher 已覆盖磁盘对账
    const now = Date.now()
    if (now - lastFallbackScanAt < 10_000) return
    lastFallbackScanAt = now
    void scanSessionFiles(sessionsRoot, { cap: 2000 })
      .then(({ files }) => {
        const current = loadIndex(indexFile)
        if (current && comparableDiskCount(files) !== comparableIndexCount(current)) {
          triggerAutoRefresh(`disk=${files.length} index=${current.sessions.length}`)
        }
      })
      .catch(() => { /* 扫描失败静默（下次再试） */ })
  }

  // watcher：变更驱动自动增量（P0-2）。失败回退到上面的 10s 节流 stat。
  const watcher = createSessionWatcher(
    sessionsRoot,
    500,
    () => triggerAutoRefresh('watch'),
    () => {
      if (watcherOk) {
        watcherOk = false
        log('[session-index] watcher lost; fall back to throttled scan')
      }
    },
  )
  watcherOk = watcher.ok
  if (watcherOk) {
    log(`[session-index] watcher active on ${sessionsRoot}`)
  } else {
    log(`[session-index] watcher unavailable; fall back to throttled scan`)
  }

  // 启动一次性对账：插件加载前可能已新增/删除会话（watcher 只覆盖加载后）。
  // P3：两侧保留调整后的可比计数（磁盘侧扣超龄 mtime、索引侧扣超龄条目，
  // 与 merge 判定同构）——否则对账会把保留清理成果即时重拾，或提前误触发
  // auto-refresh 吸收 prune build（实测两轮竞态，见 comparableDiskCount 注释）。
  void (async () => {
    try {
      const { files } = await scanSessionFiles(sessionsRoot, { cap: 2000 })
      const idx = loadIndex(indexFile)
      if (
        idx &&
        (comparableDiskCount(files) !== comparableIndexCount(idx) || idx.sessions.some((s) => s.detailMissing))
      ) {
        triggerAutoRefresh(`reconcile disk=${files.length} index=${idx.sessions.length}`)
      }
    } catch { /* 静默 */ }
  })()

  async function statusSnapshot(): Promise<Record<string, unknown>> {
    const idx = loadIndex(indexFile)
    const progress = builder.progress
    const last = builder.lastBuildReport
    // P2.2：FTS 健康数据只取一次（3 个 SQL + 1 stat）
    const ftsHealthData = fts?.ok ? fts.health() : null
    const out: Record<string, unknown> = {
      root: sessionsRoot,
      indexFile,
      sessions: idx?.sessions.length ?? 0,
      files: idx?.sessions.length ?? 0,
      updatedAt: idx?.updatedAt ?? 0,
      active: builder.active,
      // P2：FTS 全文索引状态（平铺字段，v1 兼容，保持原键名与原类型）
      fts: fts?.ok ?? false,
      ftsSessions: fts?.ok ? fts.sessionCount() : 0,
      // P2.2：FTS 健康快照。注意 fts 平铺是 boolean（v1 兼容），嵌套健康组另用
      // ftsHealth 键避免冲突：enabled=配置开关 / ok=运行状态 / sessions=会话行 /
      // messages=消息行 / dbSizeBytes=库字节（stat 失败 0）/ lastOptimizeAt=水印 /
      // schemaVersion=库 schema 版本（state_meta，缺省 ''）/ lastPruneAt+lastPruneCount=
      // 最近一次保留清理时间与数量（P3，state_meta，缺省 0）。
      ftsHealth: {
        enabled: config.ftsEnabled !== false,
        ok: fts?.ok ?? false,
        sessions: fts?.ok ? fts.sessionCount() : 0,
        messages: ftsHealthData?.messages ?? 0,
        dbSizeBytes: ftsHealthData?.dbSizeBytes ?? 0,
        lastOptimizeAt: ftsHealthData?.lastOptimizeAt ?? 0,
        schemaVersion: ftsHealthData?.schemaVersion ?? '',
        lastPruneAt: ftsHealthData?.lastPruneAt ?? 0,
        lastPruneCount: ftsHealthData?.lastPruneCount ?? 0,
      },
      // P3：保留策略配置（可观测；0=关闭）
      retentionDays: config.retentionDays ?? 90,
      // STAGE-4：LLM 摘要健康快照（enabled=开关 / ok=最近调用成功且 provider 可用 /
      // cached=sidecar 有效条目数 / lastError=最近失败原因（无则 null）/
      // provider=决议出的 provider 路由 id（不可用为 ''））。只读缓存计数，
      // 绝不在此路径触发任何 LLM 调用（成本护栏）。
      llmSummaryHealth: await llmSummary.health(),
      // P2-7：v1 兼容字段平铺到顶层（旧调用方无感）
      detailMissing: idx ? idx.sessions.filter((s) => s.detailMissing).length : 0,
      added: last?.added ?? 0,
      updated: last?.updated ?? 0,
      skipped: last?.skipped ?? 0,
      removed: last?.removed ?? 0,
      raced: last?.raced ?? 0,
      failed: last?.failed ?? 0,
      scannedBytes: last?.scannedBytes ?? 0,
      errors: last?.errors ?? [],
    }
    if (progress) {
      out.progress = { phase: progress.phase, processed: progress.processed, total: progress.total, scannedBytes: progress.scannedBytes, delayMs: progress.delayMs }
    }
    if (last) {
      out.lastReport = {
        status: last.status,
        totalFiles: last.totalFiles,
        processed: last.processed,
        headParsed: last.headParsed,
        fullParsed: last.fullParsed,
        added: last.added,
        updated: last.updated,
        skipped: last.skipped,
        removed: last.removed,
        raced: last.raced,
        failed: last.failed,
        scannedBytes: last.scannedBytes,
        // C9b 后续：观测管道修复——漏拷这两个字段导致 status 渲染行恒显
        // deltaParsed=0/deltaFallbacks=0（builder 计数正确，只是没送达渲染层）。
        deltaParsed: last.deltaParsed,
        deltaFallbacks: last.deltaFallbacks,
        durationMs: last.durationMs,
        maxEventLoopDelayMs: last.maxEventLoopDelayMs,
        partialCommitted: last.partialCommitted ?? false,
        errors: last.errors,
      }
    }
    return out
  }

  /* ── 工具 1：索引状态 ── */
  const toolStatus = defineTool({
    name: 'session_index_status',
    description: '查看/刷新 DSH 会话索引状态与构建进度。refresh=后台重建（可轮询 progress）；cancel=取消构建。',
    parameters: {
      refresh: { type: 'boolean', description: '后台强制重建（不阻塞，随后可查 progress）' },
      cancel: { type: 'boolean', description: '取消进行中的构建' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          indexFile: { type: 'string' },
          sessions: { type: 'integer' },
          files: { type: 'integer' },
          updatedAt: { type: 'integer' },
          active: { type: 'boolean' },
          fts: { type: 'boolean' },
          ftsSessions: { type: 'integer' },
          detailMissing: { type: 'integer' },
          // STAGE-4：LLM 摘要健康快照（lastError 用 oneOf 允许 null，防 defineTool
          // 严格校验拒绝——书签 messageId 同款坑，见 STAGE-2 记录）
          llmSummaryHealth: {
            type: 'object',
            additionalProperties: true,
            properties: {
              enabled: { type: 'boolean' },
              ok: { type: 'boolean' },
              cached: { type: 'integer' },
              lastError: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              provider: { type: 'string' },
            },
          },
          progress: {
            type: 'object',
            additionalProperties: true,
            properties: {
              phase: { type: 'string' },
              processed: { type: 'integer' },
              total: { type: 'integer' },
              delayMs: { type: 'integer' },
            },
          },
          lastReport: {
            type: 'object',
            additionalProperties: true,
            properties: {
              status: { type: 'string' },
              totalFiles: { type: 'integer' },
              added: { type: 'integer' },
              updated: { type: 'integer' },
              removed: { type: 'integer' },
              failed: { type: 'integer' },
              durationMs: { type: 'integer' },
              errors: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, v) => {
        const lines: string[] = [
          `[session-index] root=${v.root}`,
          `sessions=${v.sessions} files=${v.files} updatedAt=${v.updatedAt}`,
        ]
        // P2.2：FTS 健康摘要行（与返回对象 ftsHealth 一致）
        const fh = v.ftsHealth as {
          enabled?: boolean
          ok?: boolean
          sessions?: number
          messages?: number
          dbSizeBytes?: number
          lastOptimizeAt?: number
          schemaVersion?: string
          lastPruneAt?: number
          lastPruneCount?: number
        } | undefined
        if (fh) {
          const opt = fh.lastOptimizeAt && fh.lastOptimizeAt > 0 ? new Date(fh.lastOptimizeAt).toISOString() : '-'
          lines.push(`fts: ${fh.enabled ? 'on' : 'off'} ${fh.ok ? 'ok' : 'unavailable'} sessions=${fh.sessions ?? 0} messages=${fh.messages ?? 0} db=${((fh.dbSizeBytes ?? 0) / 1048576).toFixed(2)}MB lastOptimize=${opt} schema=${fh.schemaVersion ?? ''}`)
        }
        // P3：保留策略摘要（retentionDays + 最近一次 prune 时间/数量）
        const lp = fh?.lastPruneAt && fh.lastPruneAt > 0 ? new Date(fh.lastPruneAt).toISOString() : '-'
        lines.push(`retention: days=${v.retentionDays ?? 90} lastPrune=${lp} count=${fh?.lastPruneCount ?? 0}`)
        // STAGE-4：LLM 摘要健康摘要行（与返回对象 llmSummaryHealth 一致）
        const lh = v.llmSummaryHealth as {
          enabled?: boolean
          ok?: boolean
          cached?: number
          lastError?: string | null
          provider?: string
        } | undefined
        if (lh) {
          lines.push(`llmSummary: ${lh.enabled ? 'on' : 'off'} ${lh.ok ? 'ok' : 'unavailable'} cached=${lh.cached ?? 0} provider=${lh.provider ?? ''}${lh.lastError ? ` lastError=${String(lh.lastError).slice(0, 120)}` : ''}`)
        }
        if (v.active) {
          const p = v.progress as { phase: string; processed: number; total: number; scannedBytes: number; delayMs: number } | null
          lines.push(p ? `building: ${p.phase} ${p.processed}/${p.total} scanned=${(p.scannedBytes / 1e6).toFixed(1)}MB delay=${p.delayMs}ms` : 'building…')
        }
        const last = v.lastReport as {
          status: string
          added?: number
          updated?: number
          skipped?: number
          removed?: number
          raced?: number
          failed?: number
          scannedBytes?: number
          deltaParsed?: number
          deltaFallbacks?: number
          durationMs?: number
          partialCommitted?: boolean
          errors?: string[]
        } | null
        if (last) {
          lines.push(`lastBuild: status=${last.status} added=${last.added ?? 0} updated=${last.updated ?? 0} skipped=${last.skipped ?? 0} removed=${last.removed ?? 0} raced=${last.raced ?? 0} failed=${last.failed ?? 0} scannedBytes=${last.scannedBytes ?? 0} deltaParsed=${last.deltaParsed ?? 0} deltaFallbacks=${last.deltaFallbacks ?? 0} durationMs=${last.durationMs ?? 0}${last.partialCommitted ? ' partialCommitted' : ''}`)
          if (last.errors?.length) lines.push(`errors=${last.errors.length}`)
        }
        if (v.detailMissing) lines.push(`detailMissing=${v.detailMissing}（自动补扫中）`)
        return text(lines.filter(Boolean).join('\n'))
      },
    },
    execute: async (args) => {
      if (args.cancel) {
        builder.cancel()
        return { ...(await statusSnapshot()), cancelled: true } as any
      }
      if (args.refresh) {
        // 后台触发，不阻塞：单飞保证不会重复构建
        void builder
          .build(ftsBuildOptions({ force: true, signal: abortController.signal }))
          .then((report) => {
            if (report.status === 'completed') {
              log(`[session-index] build completed: added=${report.added} updated=${report.updated} skipped=${report.skipped} removed=${report.removed} raced=${report.raced} failed=${report.failed} ${report.durationMs}ms`)
            } else if (report.status !== 'cancelled') {
              log(`[session-index] build ${report.status}: ${report.errors.join('; ').slice(0, 300)}`)
            }
          })
          .catch((e) => log(`[session-index] build failed: ${String(e)}`))
      }
      return (await statusSnapshot()) as any
    },
  })

  /* ── 工具 2：会话列表（cursor 稳定分页） ── */
  const toolList = defineTool({
    name: 'session_index_list',
    description: '列出 DSH 历史会话（workspace/标题/消息子串过滤），nextCursor 稳定分页。',
    parameters: {
      workspace: { type: 'string', description: '工作目录子串，如 StudyDesk' },
      query: { type: 'string', description: '标题/首条用户消息/工具名子串' },
      limit: { type: 'integer', description: '返回上限，缺省 maxHits' },
      refresh: { type: 'boolean', description: '先刷新索引' },
      cursor: { type: 'string', description: '上页 nextCursor，原样传回续页' },
      // STAGE-1 Part A：可选排序。relevance 为单页 top-k 语义，**不支持翻页**。
      sort: { type: 'string', enum: ['time', 'relevance'], description: '排序：time=时间倒序（默认，支持 cursor 翻页）；relevance=按相关性 top-k（单页，不支持翻页）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          root: { type: 'string' },
          total: { type: 'integer' },
          returned: { type: 'integer' },
          nextCursor: { type: 'string' },
          truncated: { type: 'boolean' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string' },
                workspace: { type: 'string' },
                title: { type: 'string' },
                toolCalls: { type: 'integer' },
                lastTime: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, v) => {
        const lines: string[] = [`[session-list] total=${v.total}, 输出 ${v.returned} 条${v.nextCursor ? ', nextCursor=' + v.nextCursor : ''}${v.truncated ? ' (truncated)' : ''}`]
        for (const s of v.sessions ?? []) {
          lines.push(` ${s.id} | ${s.workspace} | ${s.title || '(untitled)'} | calls=${s.toolCalls ?? 0} | ${new Date(s.lastTime ?? 0).toISOString()}`)
        }
        // P1.2 续页提示（静态，无 LLM）：nextCursor 原样传回
        if (v.nextCursor) lines.push('（续页：把 nextCursor 原样传回 cursor 参数）')
        // STAGE-1 Part A：relevance 模式单页语义提示（静态，无 LLM）
        if ((v as { sort?: string }).sort === 'relevance' && v.truncated) {
          lines.push('（relevance 模式为单页 top-k：本页已是相关性最优，不支持翻页）')
        }
        return text(lines.join('\n'))
      },
    },
    execute: async (args) => {
      const idx = await ensureIndex(!!args.refresh)
      const limit = Math.max(1, Math.floor(args.limit ?? config.maxHits))
      const q = (args.query || '').toLowerCase()
      const ws = (args.workspace || '').toLowerCase()
      const sort = args.sort ?? 'time'
      const all = idx.sessions.filter((s) => {
        if (s.unindexable) return false
        if (ws && !s.workspace.toLowerCase().includes(ws)) return false
        if (q && !metaMatch(s, q)) return false
        return true
      })
      // 扫描/过滤硬上限（Codex MAX_SCAN_FILES 语义；DSH 2000）
      let truncated = false
      let scanWindow = all
      if (all.length > MAX_LIST_SCAN) {
        scanWindow = all.slice(0, MAX_LIST_SCAN)
        truncated = true
      }

      // STAGE-1 Part A：sort='relevance' —— 单页 top-k 语义。过滤后排序截断，
      // **不返回可续游标、不参与 cursor 逻辑**（schema 注明不支持翻页）。
      // 排序为 rank.ts 纯函数（红线 4：只对已过滤条目排序，严禁扩全集）；
      // 未传 query 时 fzy/tier 恒 0 → 天然退化为 frecency（衰减+频率）排序。
      if (sort === 'relevance') {
        const ranked = sortSessions(
          scanWindow.map((s) => ({ meta: s })),
          q,
          { queryWorkspace: args.workspace || '' },
        )
        const kept = ranked.slice(0, limit)
        const more = ranked.length > limit
        const out: Record<string, unknown> = {
          root: sessionsRoot,
          total: all.length,
          returned: kept.length,
          truncated: truncated || more, // relevance 无 nextCursor，剩余量用 truncated 表达
          sort: 'relevance',
          sessions: kept.map((s) => ({
            id: s.meta.id,
            workspace: s.meta.workspace,
            file: s.meta.file,
            title: s.meta.title,
            firstUserText: s.meta.firstUserText.slice(0, 300),
            createdAt: s.meta.createdAt,
            lastTime: s.meta.lastTime,
            size: s.meta.size,
            toolCalls: s.meta.counts['tool/call'] || 0,
          })),
        }
        return out as any
      }

      // sort='time'（默认）：行为与改动前完全一致（含 cursor 稳定分页）。
      // AnchorState：按 {ts, id} 跳过已返回区间（排序键 = lastTime desc, id asc，
      // 与 builder commit 一致），分页期间新增文件不错位
      const anchor = typeof args.cursor === 'string' ? parseCursor(args.cursor) : null
      const start = cursorStartIndex(scanWindow, anchor)
      const kept = scanWindow.slice(start, start + limit)
      const more = start + limit < scanWindow.length
      const nextCursor =
        more && kept.length > 0 ? formatCursor(kept[kept.length - 1]) : undefined
      // 线上实测修复：末页时 nextCursor=undefined 会破坏框架 lossless-JSON 校验
      //（undefined 字段被 JSON.stringify 丢弃 → round-trip 不等）。改为"有下一页才带
      // 字段"：schema 未 required、render 判 truthy，调用方语义完全等价。
      const out: Record<string, unknown> = {
        root: sessionsRoot,
        total: all.length,
        returned: kept.length,
        truncated, // 仅扫描上限触发；分页由 nextCursor 表达
        sessions: kept.map((s) => ({
          id: s.id,
          workspace: s.workspace,
          file: s.file,
          title: s.title,
          firstUserText: s.firstUserText.slice(0, 300),
          createdAt: s.createdAt,
          lastTime: s.lastTime,
          size: s.size,
          toolCalls: s.counts['tool/call'] || 0,
        })),
      }
      if (nextCursor !== undefined) out.nextCursor = nextCursor
      return out as any
    },
  })

  /* ── 工具 3：会话搜索（mode=full 走 FTS/worker；SCROLL 模式看上下文窗口） ── */
  const toolSearch = defineTool({
    name: 'session_index_search',
    description: '搜索 DSH 历史会话：meta=元数据，full=正文（FTS trigram，零解压）。SCROLL：session_id+message_id 取锚点上下文窗口。',
    parameters: {
      // P1 修复：query 不再是 required——SCROLL 模式（session_id+message_id）不需要
      // 查询词，此前必须传占位词才能过校验。meta/full 模式缺 query 时 execute 仍会
      // 返回明确错误。STAGE-5：短词（<3 字）走 LIKE 兜底较慢，建议 ≥3 字走 trigram
      // 快速路径（静态提示，零 LLM）。
      query: { type: 'string', description: '搜索关键词（meta/full 必填；SCROLL 忽略）。短词（<3 字）走 LIKE 较慢，建议 ≥3 字' },
      workspace: { type: 'string', description: '限定工作目录子串' },
      mode: { type: 'string', enum: ['meta', 'full'], description: 'meta=元数据；full=正文（默认 meta）' },
      limit: { type: 'integer', description: '返回上限' },
      refresh: { type: 'boolean', description: '先刷新索引' },
      session_id: { type: 'string', description: 'SCROLL 会话 id' },
      message_id: { type: 'integer', description: 'SCROLL 锚点 messageId' },
      window: { type: 'integer', description: 'SCROLL 窗口半径 1..20（默认 5）' },
      // STAGE-1 Part B：消息级筛选。meta 模式仅 role='tool' 可近似（toolCallCounts>0
      // 会话级），user/assistant 无消息粒度不过滤；时间范围因消息行无时间列降级为
      // 会话 lastTime（三路径统一）。
      filter: {
        type: 'object',
        additionalProperties: false,
        description: '消息级筛选：role=消息角色；sinceMs/untilMs=会话 lastTime 范围（消息行无时间列→会话级）',
        properties: {
          role: { type: 'string', enum: ['user', 'assistant', 'tool', 'any'], description: '消息角色；any=不过滤；meta 模式 tool=toolCallCounts>0 近似、user/assistant 不过滤' },
          sinceMs: { type: 'integer', description: '起始（>= 会话 lastTime，epoch 毫秒）' },
          untilMs: { type: 'integer', description: '截止（<= 会话 lastTime，epoch 毫秒）' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          query: { type: 'string' },
          mode: { type: 'string' },
          total: { type: 'integer' },
          returned: { type: 'integer' },
          truncated: { type: 'boolean' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                sessionId: { type: 'string' },
                workspace: { type: 'string' },
                file: { type: 'string' },
                kind: { type: 'string' },
                type: { type: 'string' },
                snippet: { type: 'string' },
                messageId: { type: 'integer' },
              },
            },
          },
          messages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'integer' },
                role: { type: 'string' },
                text: { type: 'string' },
                toolName: { type: 'string' },
              },
            },
          },
          bookends: { type: 'object', additionalProperties: true },
        },
      },
      render: (args, v) => {
        if (v.mode === 'scroll') {
          const lines: string[] = [`[session-scroll] ${v.session_id} 锚点 ${v.message_id} (window=${v.window})`]
          // P1 修复：SCROLL 失败（FTS 不可用/会话不存在/锚点无消息）必须显式展示
          // 错误行，而不是渲染成"空窗口"误导模型以为只是没有消息。
          if (v.ok === false) {
            lines.push(`（SCROLL 失败：${(v as { error?: string }).error ?? '未知原因'}）`)
            return text(lines.join('\n'))
          }
          for (const m of (v.messages ?? []) as { id: number; role: string; text: string; toolName?: string }[]) {
            lines.push(` ${m.id === v.message_id ? '▶' : ' '} ${m.role}${m.toolName ? `[${m.toolName}]` : ''}: ${(m.text || '').slice(0, 160)}`)
          }
          const b = v.bookends as { start?: { role: string; text: string }[]; end?: { role: string; text: string }[] } | undefined
          if (b?.start?.length) lines.push(`— 开头: ${b.start.map((m) => `${m.role}:${(m.text || '').slice(0, 40)}`).join(' | ')}`)
          if (b?.end?.length) lines.push(`— 结尾: ${b.end.map((m) => `${m.role}:${(m.text || '').slice(0, 40)}`).join(' | ')}`)
          // P1.2 翻页提示（静态，无 LLM）：以窗口内消息 id 为新锚点继续滚
          lines.push('（翻页：把目标消息的 id 作为 message_id 与新 session_id 再滚，window 可调 1..20）')
          return text(lines.join('\n'))
        }
        const lines: string[] = [`[session-search] "${v.query}" mode=${v.mode} → ${v.total} hits, 输出 ${v.returned}${v.truncated ? ' (truncated)' : ''}`]
        // STAGE-1 Part B：回显 filter 生效情况（仅非默认字段；静态，无 LLM）
        const farg = (args as { filter?: SearchFilterArg }).filter
        const fbits: string[] = []
        const frole = farg?.role && farg.role !== 'any' ? farg.role : undefined
        const fsince = farg && Number.isFinite(Number(farg.sinceMs)) ? Number(farg.sinceMs) : undefined
        const funtil = farg && Number.isFinite(Number(farg.untilMs)) ? Number(farg.untilMs) : undefined
        if (frole) fbits.push(`role=${frole}`)
        if (fsince !== undefined) fbits.push(`sinceMs=${fsince}`)
        if (funtil !== undefined) fbits.push(`untilMs=${funtil}`)
        if (fbits.length) lines.push(`filter: ${fbits.join(' ')}`)
        for (const h of v.hits ?? []) {
          lines.push(` ${h.kind === 'meta' ? 'META' : h.type} | ${h.sessionId} | ${h.workspace}`)
          lines.push(`   ${h.snippet}`)
        }
        // P1.2 零命中提示（静态，无 LLM）：FTS 语法放宽只在零命中这一刻出现
        if (v.total === 0) lines.push('（零命中提示：多词用 OR 连接、引号试精确短语、或换更短关键词）')
        // STAGE-5：短词慢路径提示（静态，无 LLM）——full 模式 + 含 <3 字词 → 已走/将走
        // LIKE 兜底（全表扫描较慢），提醒模型下次用 ≥3 字查询走 trigram 快速路径。
        if (args.mode === 'full' && typeof args.query === 'string' && queryUsesLikePath(args.query)) {
          lines.push('（提示：短词（<3 字）走 LIKE 兜底较慢，建议加长到 ≥3 字用 trigram 快速路径）')
        }
        return text(lines.join('\n'))
      },
    },
    execute: async (args) => {
      // SCROLL 模式：session_id + message_id → 锚点上下文窗口（照 hermes scroll 形状）
      if (typeof args.session_id === 'string' && args.session_id && args.message_id != null) {
        if (!fts?.ok) {
          return {
            mode: 'scroll',
            session_id: args.session_id,
            message_id: args.message_id,
            window: args.window ?? 5,
            ok: false,
            error: 'FTS 不可用，无法 SCROLL（检查 node:sqlite，或用 mode=full 搜索后再滚）',
          } as any
        }
        const sc = await fts.around(args.session_id, args.message_id, args.window ?? 5)
        if (sc.ok) {
          return {
            mode: 'scroll',
            session_id: args.session_id,
            message_id: args.message_id,
            window: args.window ?? 5,
            returned: sc.messages.length,
            messages: sc.messages,
            bookends: sc.bookends,
          } as any
        }
        return {
          mode: 'scroll',
          session_id: args.session_id,
          message_id: args.message_id,
          window: args.window ?? 5,
          ok: false,
          error: `会话 ${args.session_id} 未找到或无锚点消息（messageId=${args.message_id}）`,
        } as any
      }
      const idx = await ensureIndex(!!args.refresh)
      const q = (args.query || '').trim()
      if (!q) throw new Error('query 不能为空')
      const mode = args.mode || 'meta'
      const ws = (args.workspace || '').toLowerCase()
      const limit = Math.max(1, Math.floor(args.limit ?? config.maxHits))
      const maxPer = Math.max(1, Math.floor(config.maxSnippetsPerSession))
      // STAGE-1 Part B：归一化 filter（非法/全默认 → undefined = 与不带 filter 一致）
      const filter = normFilter(args.filter as SearchFilterArg | undefined)

      // STAGE-1 Part A：会话级相关性排序的统一收集窗口。红线 4 要求 rank 只对
      // "已过滤后的 ≤maxHits(≤500) 条目"排序——本窗口在过滤（metaMatch / workspace /
      // FTS MATCH）之后才装候选，上限 3×limit 且 ≤500；排序永远发生在过滤之后、
      // 截断之前（"先过滤 → 聚合 → sortSessions → 截断"，严禁为排序扩全集）。
      const collectCap = Math.min(Math.max(limit, config.maxHits) * 3, 500)

      const candidates = idx.sessions.filter((s) => !s.unindexable && (!ws || s.workspace.toLowerCase().includes(ws)))
      const scanned = candidates.slice(0, MAX_LIST_SCAN)
      let truncated = candidates.length > MAX_LIST_SCAN

      // 会话级聚合池：key = lineageRoot||id（延续 P3 dedup-by-lineage 语义，meta
      // 路径无 parentSession 时即会话 id）。同一 key 保留一条"代表行"（正文优先），
      // 多条正文行按 best-rank 聚合（规则与 rank.aggregateBm25Rows 完全一致）。
      interface AggEntry {
        meta: SessionMeta
        hitRows: number
        bestBm25?: number
        content?: { type: string; snippet: string; messageId: number }
      }
      const agg = new Map<string, AggEntry>()
      const byFile = new Map(idx.sessions.filter((s) => !s.unindexable).map((s) => [s.file, s]))
      let total = 0
      const addMeta = (s: SessionMeta): void => {
        const key = s.parentSession || s.id
        if (agg.has(key)) return // 同族已有条目（正文优先）→ 不重复计数
        if (agg.size >= collectCap) return
        agg.set(key, { meta: s, hitRows: 0 })
      }
      const addContent = (
        key: string,
        meta: SessionMeta,
        hit: { type: string; snippet: string; messageId: number },
        bm25?: number,
      ): void => {
        const prev = agg.get(key)
        if (!prev) {
          if (agg.size >= collectCap) return
          agg.set(key, {
            meta,
            hitRows: 1,
            bestBm25: bm25,
            content: { type: hit.type, snippet: hit.snippet, messageId: hit.messageId },
          })
          return
        }
        prev.hitRows += 1
        // best-rank：最小 bm25 的行作为代表（更相关的正文 snippet 上位）
        if (typeof bm25 === 'number' && (prev.bestBm25 === undefined || bm25 < prev.bestBm25)) {
          prev.bestBm25 = bm25
          prev.content = { type: hit.type, snippet: hit.snippet, messageId: hit.messageId }
        } else if (!prev.content) {
          prev.content = { type: hit.type, snippet: hit.snippet, messageId: hit.messageId }
        }
      }

      // 1) meta 快速路径（meta/full 模式都先跑；过滤 = metaMatch + filter，命中即会话级条目）
      // STAGE-1 Part B：
      //  - 时间范围对所有模式生效（会话级降级口径）；
      //  - role='tool'：meta 路径用 toolCallCounts>0 近似（schema 注明会话级）；
      //  - role='user'/'assistant'：meta 路径无消息粒度判定不了 → 纯 meta 模式
      //    不过滤（恒真）；full 模式下 meta 补充贡献跳过（避免元数据-only 命中
      //    冒充消息命中，消息级语义由 FTS/worker 内容路径裁决）。
      const metaSkipInFull = mode === 'full' && filter !== undefined && filter.role !== 'any' && filter.role !== 'tool'
      for (const s of scanned) {
        if (!timePass(s, filter)) continue
        if (!metaMatch(s, q)) continue
        if (metaSkipInFull) continue
        if (!metaRolePass(s, filter?.role)) continue
        total++
        addMeta(s)
      }

      // 2) full 路径：SQLite FTS（零解压、BM25 排序、CJK trigram）；FTS 不可用 →
      //    worker 池流式解压回退。FTS 行级 over-fetch 到 collectCap，再在 JS 侧
      //    做会话级聚合（先过滤后排序；聚合绝不改变 snippet 生成逻辑）。
      if (mode === 'full') {
        if (fts?.ok) {
          const fhits = await fts.search(q, args.workspace ?? '', collectCap, filter)
          for (const h of fhits) {
            const key = h.lineageRoot || h.sessionId || sessionIdFromFile(h.sessionFile)
            // Never revive a stale FTS row when its source session is marked
            // unindexable by the compatibility gate.
            const meta = byFile.get(h.sessionFile)
            if (!meta) continue
            if (!agg.has(key)) total++
            addContent(key, meta, { type: h.role, snippet: h.snippet, messageId: h.messageId }, h.bm25)
          }
        } else {
          // 分波调度（P3-11）：每次只派一波（poolSize×2 在飞），收满 collectCap 个
          // 会话或扫完才停派（"命中即停"升级为"收满窗口才停"，保证排序候选完整；
          // 命中稀缺时扫描范围与改动前一致）。
          const wave = Math.max(1, builder.pool.sizeLimit * 2)
          // STAGE-1 Part B：时间范围在派发前按会话级 lastTime 过滤（先过滤后排序，
          // 严禁扩集合）；role 在命中行上 JS 侧过滤（消息级，与 FTS SQL 同语义）。
          const scanPool = scanned.filter((s) => timePass(s, filter))
          let dispatched = 0
          while (dispatched < scanPool.length && agg.size < collectCap) {
            const batch: Promise<{ s: SessionMeta; r: Awaited<ReturnType<typeof builder.pool.run>> | null }>[] = []
            for (let n = 0; n < wave && dispatched < scanPool.length; n++) {
              const s = scanPool[dispatched++]
              batch.push(
                builder.pool
                  .run({ mode: 'search', file: s.file, query: q, maxSnippets: maxPer }, abortController.signal)
                  .then((r) => ({ s, r }))
                  .catch(() => ({ s, r: null })),
              )
            }
            const settled = await Promise.all(batch)
            for (const { s, r } of settled) {
              if (!r?.ok || !Array.isArray(r.data)) continue
              const key = s.parentSession || s.id
              for (const hit of r.data as { type: string; snippet: string; role?: string; toolName?: string }[]) {
                // STAGE-1 Part B：按行 role 过滤（parseSearch 已带 role；兜底映射
                // type→role 以防旧编译产物/内置回退缺字段）
                if (filter && filter.role !== 'any') {
                  const hr = hit.role ?? (hit.type === 'user/message' ? 'user' : hit.type === 'assistant/message' ? 'assistant' : hit.type === 'tool/call' ? 'tool' : undefined)
                  if (hr !== filter.role) continue
                }
                if (!agg.has(key)) total++
                addContent(key, s, { type: hit.type, snippet: hit.snippet, messageId: 0 })
              }
            }
          }
        }
      }

      // 3) 统一会话级相关性排序（rank.ts 纯函数、确定性；三路径口径一致）
      const ranked = sortSessions([...agg.values()], q, { queryWorkspace: args.workspace || '' })

      // 4) 截断并物化输出行（snippet 生成与 >>> <<< 标记逻辑一行未改）
      const kept = ranked.slice(0, limit)
      const hits: SearchHit[] = kept.map((e) =>
        e.content
          ? {
              sessionId: e.meta.id,
              workspace: e.meta.workspace,
              file: e.meta.file,
              kind: 'content',
              type: e.content.type,
              snippet: e.content.snippet,
              messageId: e.content.messageId,
            }
          : {
              sessionId: e.meta.id,
              workspace: e.meta.workspace,
              file: e.meta.file,
              kind: 'meta',
              type: 'meta',
              // P1.4：meta snippet 同样带 >>> <<< 命中标记（静态）
              snippet: markMatches((e.meta.title ? `标题: ${e.meta.title} | ` : '') + (e.meta.firstUserText || '').slice(0, 200), q),
              messageId: 0,
            },
      )
      return {
        query: q,
        mode,
        total,
        returned: kept.length,
        truncated: truncated || total > limit,
        hits,
      } as any
    },
  })

  /* ── 工具 4：单会话摘要 ── */
  const toolSummary = defineTool({
    name: 'session_summary',
    description: '生成单个 DSH 会话的摘要（确定性字段；llmSummaryEnabled 开启且可用时附加 LLM 一句话 llmSummary，≤80 字，失败自动省略）。',
    parameters: {
      id: { type: 'string', description: '会话 id 或文件路径（子串匹配）', required: true },
      refresh: { type: 'boolean', description: '先刷新索引' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'string' },
          file: { type: 'string' },
          workspace: { type: 'string' },
          createdAt: { type: 'integer' },
          lastTime: { type: 'integer' },
          durationMs: { type: 'integer' },
          title: { type: 'string' },
          firstUserText: { type: 'string' },
          lastAssistantText: { type: 'string' },
          agentPreset: { type: 'string' },
          counts: { type: 'object', additionalProperties: true },
          toolCalls: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: { name: { type: 'string' }, count: { type: 'integer' } },
            },
          },
          // STAGE-4：可选 LLM 一句话摘要（仅 llmSummaryEnabled 且调用成功时出现；
          // 禁用/失败 → 字段缺席 → 输出与确定性摘要原样一致，fail-open）
          llmSummary: { type: 'string' },
        },
      },
      render: (_args, v) => {
        const lines: string[] = [
          `[session-summary] ${v.id}`,
          `workspace=${v.workspace}`,
          `title=${v.title || '(untitled)'}`,
          `time=${new Date(v.createdAt ?? 0).toISOString()} → ${new Date(v.lastTime ?? 0).toISOString()} (${Math.round((v.durationMs ?? 0) / 1000)}s)`,
          `agentPreset=${v.agentPreset || ''}`,
          `firstUser=${(v.firstUserText || '').slice(0, 300)}`,
          `lastAssistant=${(v.lastAssistantText || '').slice(0, 300)}`,
        ]
        // STAGE-4：可选 LLM 一句话摘要（成功才出现；禁用/失败无此行 → 确定性回退）
        if (typeof v.llmSummary === 'string' && v.llmSummary.length > 0) lines.push(`llmSummary=${v.llmSummary}`)
        const calls = (v.toolCalls ?? []) as { name: string; count: number }[]
        if (calls.length) lines.push(`tools=${calls.map((c) => `${c.name}×${c.count}`).join(', ')}`)
        const counts = v.counts as Record<string, number> | undefined
        if (counts) {
          const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k}=${n}`).join(' ')
          lines.push(`events: ${top}`)
        }
        return text(lines.join('\n'))
      },
    },
    execute: async (args) => {
      const idx = await ensureIndex(!!args.refresh)
      let meta: SessionMeta | undefined = findSession(idx, args.id)
      if (!meta) {
        const candidates = idx.sessions.filter((s) => !s.unindexable && (s.id.toLowerCase().includes(args.id.toLowerCase()) || s.file.toLowerCase().includes(args.id.toLowerCase())))
        if (candidates.length === 0) throw new Error(`未找到会话: ${args.id}`)
        meta = candidates[0]
      }
      // P1.5 Codex 式存在性复检（state DB first）：只走单会话路径、只 1 次 stat
      //（list/search 全量路径不引入 stat 风暴）。索引条目指向的文件已不存在 →
      // 返回明确错误而非僵尸数据，并后台触发一次增量构建自动清理该条目。
      // STAGE-4：stat 结果同时作为 llmSummary 缓存的会话文件指纹（(size, mtimeMs) 变化
      // = 会话有更新 → 缓存失效重生成），不额外 stat。
      let st
      try {
        st = statSync(meta.file)
      } catch {
        triggerAutoRefresh('stale-entry-summary')
        throw new Error(`会话文件已删除，索引将自动清理: ${args.id}`)
      }
      const out = summarizeSession(meta) as any
      // STAGE-4：仅在本工具路径、开关内触发一次（成本护栏）；失败/禁用 →
      // 不加 llmSummary 字段，确定性摘要原样返回（fail-open，绝不半死）。
      if (llmSummaryEnabled) {
        const r = await llmSummary.getSummary(meta, { size: st.size, mtimeMs: st.mtimeMs })
        if (r.summary !== undefined) out.llmSummary = r.summary
      }
      return out
    },
  })

  /* ── 工具 5：书签（STAGE-2 Part A：B3 书签导航 + C4 aider 幂等去重）──────── */
  const bookmarkFile = join(dataDir, BOOKMARK_FILE_NAME)
  const toolBookmark = defineTool({
    name: 'session_index_bookmark',
    description:
      '给重要会话点落书签（锚点=sessionId+messageId）并找回。add 同锚点重复写=替换更新（幂等，aider 思想）；list 对会话已不在索引的书签标 stale（不自动删）。跳回链：拿 sessionId（+messageId）后调 session_summary（无 messageId）或 session_index_search 的 SCROLL（session_id+message_id）完成跳回。',
    parameters: {
      action: {
        type: 'string',
        enum: ['add', 'list', 'remove'],
        required: true,
        description: 'add=落书签（sessionId 必填）；list=找回（支持过滤，stale 标注）；remove=删除书签（id 或 sessionId 之一）',
      },
      // add / remove 共用：会话 id 或文件路径子串（add 经索引解析，解析失败返回明确错误）
      sessionId: { type: 'string', description: '会话 id 或文件路径子串（add 必填；remove 与 id 二选一）' },
      // add
      messageId: { type: 'integer', description: '消息锚点 messageId（SCROLL 用；缺省=会话级书签）' },
      label: { type: 'string', description: '书签标签；缺省=标题或首条用户消息前 80 字符（确定性，无 LLM）' },
      note: { type: 'string', description: '备注（可选）' },
      // list
      query: { type: 'string', description: '对 label/note/title 做大小写不敏感子串过滤' },
      limit: { type: 'integer', description: 'list 返回上限，默认 20，≤100' },
      // remove
      id: { type: 'string', description: 'remove 用：书签 id（精确）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          action: { type: 'string' },
          replaced: { type: 'boolean' },
          removed: { type: 'integer' },
          file: { type: 'string' },
          indexReady: { type: 'boolean' },
          total: { type: 'integer' },
          matched: { type: 'integer' },
          returned: { type: 'integer' },
          skippedBad: { type: 'integer' },
          bookmark: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string' },
              sessionId: { type: 'string' },
              messageId: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
              label: { type: 'string' },
              note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
              stale: { type: 'boolean' },
            },
          },
          bookmarks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                id: { type: 'string' },
                sessionId: { type: 'string' },
                messageId: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                label: { type: 'string' },
                note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                title: { type: 'string' },
                workspace: { type: 'string' },
                stale: { type: 'boolean' },
                createdAt: { type: 'integer' },
                updatedAt: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, v) => {
        const lines: string[] = []
        if (v.action === 'add') {
          const b = v.bookmark as { id: string; sessionId: string; messageId?: number | null; label: string; note?: string | null }
          lines.push(
            `[bookmark-add] ${v.replaced ? '更新(幂等)' : '新增'} id=${b.id} session=${b.sessionId}${b.messageId != null ? ` message=${b.messageId}` : ''}`,
          )
          lines.push(` label=${b.label || '(untitled)'}`)
          if (b.note) lines.push(` note=${b.note}`)
          lines.push('（跳回：session_summary id=<sessionId>；或 session_index_search SCROLL session_id+message_id）')
        } else if (v.action === 'list') {
          lines.push(
            `[bookmark-list] total=${v.total ?? 0} matched=${v.matched ?? 0} returned=${v.returned ?? 0}${v.indexReady ? '' : ' (index 未就绪，未做 stale 判定)'}${v.skippedBad ? ` skippedBad=${v.skippedBad}` : ''}`,
          )
          for (const b of (v.bookmarks ?? []) as { id: string; sessionId: string; messageId?: number | null; label: string; note?: string | null; stale?: boolean; updatedAt?: number }[]) {
            lines.push(
              ` ${b.stale ? 'STALE ' : ''}${b.id} | ${b.sessionId}${b.messageId != null ? `#${b.messageId}` : ''} | ${b.label || '(untitled)'}${b.note ? ` | ${b.note}` : ''} | ${new Date(b.updatedAt ?? 0).toISOString()}`,
            )
          }
          if ((v.returned ?? 0) === 0) lines.push('（无书签：action=add 落一个，或用 session_index_search 找锚点）')
        } else if (v.action === 'remove') {
          lines.push(`[bookmark-remove] removed=${v.removed ?? 0}`)
        }
        return text(lines.join('\n'))
      },
    },
    execute: async (args) => {
      const action = args.action
      if (action === 'add') {
        const sid = (args.sessionId || '').trim()
        if (!sid) throw new Error('add 需要 sessionId（会话 id 或文件路径子串）')
        const idx = await ensureIndex(false)
        const meta = findSession(idx, sid)
        if (!meta) {
          throw new Error(`未找到会话: ${sid}（可用 session_index_list 确认 id 或文件路径）`)
        }
        let messageId: number | null = null
        if (args.messageId !== undefined && args.messageId !== null) {
          const m = Number(args.messageId)
          if (!Number.isFinite(m) || !Number.isInteger(m) || m < 0) {
            throw new Error('messageId 必须是非负整数')
          }
          messageId = m
        }
        const { bookmark, replaced } = await addBookmark(bookmarkFile, {
          sessionId: meta.id,
          sessionFile: meta.file,
          messageId,
          label: typeof args.label === 'string' && args.label ? args.label : defaultLabel(meta.title, meta.firstUserText),
          note: typeof args.note === 'string' && args.note ? args.note : null,
          title: meta.title,
          workspace: meta.workspace,
        })
        return { action: 'add', replaced, file: bookmarkFile, bookmark } as any
      }
      if (action === 'list') {
        const { bookmarks, skippedBad } = await readBookmarks(bookmarkFile)
        const q = typeof args.query === 'string' ? args.query : ''
        const limit = Math.max(1, Math.min(BOOKMARK_LIST_LIMIT_MAX, Math.floor(Number(args.limit) || BOOKMARK_LIST_LIMIT_DEFAULT)))
        const idx = loadIndex(indexFile)
        const indexReady = !!idx
        const matched = bookmarks.filter((b) => bookmarkMatches(b, q))
        const sorted = sortBookmarks(matched).slice(0, limit)
        const items = sorted.map((b) => {
          const stale = indexReady ? !findSession(idx!, b.sessionId) : false
          return { ...b, stale }
        })
        return {
          action: 'list',
          file: bookmarkFile,
          indexReady,
          total: bookmarks.length,
          matched: matched.length,
          returned: items.length,
          skippedBad,
          bookmarks: items,
        } as any
      }
      if (action === 'remove') {
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        const sid = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
        if (!id && !sid) throw new Error('remove 需要 id 或 sessionId 之一')
        const removed = await removeBookmarks(bookmarkFile, { id: id || undefined, sessionId: sid || undefined })
        return { action: 'remove', file: bookmarkFile, removed } as any
      }
      throw new Error(`未知 action: ${String(action)}（add|list|remove）`)
    },
  })

  const tools = [toolStatus, toolList, toolSearch, toolSummary, toolBookmark]

  // ctx.effect：热重载/卸载时自动注销工具（scaffold 规范）
  for (const t of tools) {
    ctx.effect(() => ctx.tools.register(t), `@dsh-external/dsh-session-index: ${t.name}`)
  }
  // 卸载时中止未完成构建 + 终止 worker 池 + 关 watcher + 关 FTS（热重载不留泄漏）
  ctx.effect(
    () => () => {
      abortController.abort()
      clearDeferTimer()
      watcher.close()
      builder.dispose()
      fts?.close()
    },
    '@dsh-external/dsh-session-index: build cleanup',
  )
}
