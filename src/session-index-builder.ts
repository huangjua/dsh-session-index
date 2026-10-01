/**
 * session-index-builder.ts — 非阻塞两阶段索引构建器
 *
 * 对齐 openai/codex@9ded177 reference/codex/codex-rs/rollout/src/compression.rs：
 * - 进程内 single-flight（模块级 active Promise，重复 build() 复用）；
 * - durable run-marker（open 'wx' + pid/started_at，>15min 陈旧抢占，finally 释放）；
 * - 启动清理 stale .tmp（>24h）；
 * - Phase A head pass：变更文件只流式解压前 10 条 → 先原子提交 quick index
 *   （完整合法 JSON，detail 缺的条目带 detailMissing 标记）→ 崩溃/取消时旧索引或
 *   quick index 一定可用；
 * - Phase B full pass：变更文件流式全量解析（worker 池，单 worker 单文件）；
 * - merge：prune 已消失文件；解析失败保留旧条目 + error；指纹竞态标记 raced；
 * - 原子提交（唯一 tmp → fsync → 读回校验 → rename，可选 hardlink 备份）；
 * - 取消：orCancel 语义 + worker 逐 chunk cooperative cancel；取消不提交最终快照。
 */
import { join, dirname, basename } from 'node:path'
import { stat } from 'node:fs/promises'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { RunMarker, atomicWriteJson, cleanupStaleTemps } from './atomic-write.js'
import { WorkerPool } from './worker-pool.js'
import type { WorkerTaskSpec, TaskResult } from './worker-pool.js'
import type { HeadSummary, FullSummary } from './streaming-parser.js'
import { isCancelError, throwIfAborted } from './cancel.js'
import { loadIndex, scanSessionFiles, invalidateIndexCache } from './core.js'
import type { SessionMeta, SessionIndex, BuildReport, ScanFile } from './core.js'
import type { FtsMessageRow } from './fts.js'

export const STALE_MARKER_MS = 15 * 60 * 1000
export const STALE_TMP_MS = 24 * 60 * 60 * 1000
export const MAX_SCAN_FILES = 10000
const MAX_ERRORS = 50

export interface BuildOptions {
  force?: boolean
  signal?: AbortSignal
  onProgress?: (p: BuildProgress) => void
  /** P2 FTS：full 任务收集消息行（需配合 onSessionParsed 才有效） */
  collectMessages?: boolean
  /** P2 FTS：某会话成功解析（full/delta）后回调；append=是否 delta 追加 */
  onSessionParsed?: (file: string, meta: SessionMeta, messages: FtsMessageRow[], append: boolean) => void
  /** P2 FTS：某会话被 prune 删除后回调 */
  onSessionRemoved?: (file: string) => void
  /** P3 保留策略：>0 时 merge 阶段把 max(lastTime, mtimeMs) 超龄的文件仍在磁盘
   * 的条目从索引移除（照 Hermes maybe_auto_prune_and_vacuum；绝不碰会话文件）。 */
  retentionDays?: number
}

export interface BuildProgress {
  phase: 'scan' | 'head' | 'full' | 'commit'
  processed: number
  total: number
  scannedBytes: number
  delayMs: number
}

interface PoolResult {
  ok: boolean
  aborted: boolean
  data?: HeadSummary | FullSummary
  error?: string
}

const emptyReport = (indexFile: string): BuildReport => ({
  status: 'failed',
  totalFiles: 0,
  processed: 0,
  headParsed: 0,
  fullParsed: 0,
  added: 0,
  updated: 0,
  skipped: 0,
  removed: 0,
  raced: 0,
  failed: 0,
  pruned: 0,
  errors: [],
  scannedBytes: 0,
  indexFile,
  durationMs: 0,
  maxEventLoopDelayMs: 0,
})

export interface BuilderTestHooks {
  /** 每个文件解析任务派发前调用（测试用：确定性模拟 raced） */
  onFileRead?: (file: string) => void
}

export class SessionIndexBuilder {
  readonly root: string
  readonly indexFile: string
  readonly markerFile: string
  readonly pool: WorkerPool
  readonly testHooks?: BuilderTestHooks

  private activePromise: Promise<BuildReport> | null = null
  private currentController: AbortController | null = null
  private currentProgress: BuildProgress | null = null
  private lastReport: BuildReport | null = null
  /** 在飞构建是否为 force（决定后续 force 请求是复用还是排队补跑） */
  private activeForce = false
  /** force 请求撞上非 force 在飞构建时排队的补跑 Promise（单飞语义下的 force 兜底） */
  private queuedForcePromise: Promise<BuildReport> | null = null

  constructor(options: {
    root: string
    indexFile: string
    workerUrl?: URL
    poolSize?: number
    testHooks?: BuilderTestHooks
  }) {
    this.root = options.root
    this.indexFile = options.indexFile
    this.markerFile = join(dirname(options.indexFile), '.tmp', 'build.lock')
    this.pool = new WorkerPool({
      workerUrl: options.workerUrl ?? new URL('./session-worker.js', import.meta.url),
      size: options.poolSize,
    })
    this.testHooks = options.testHooks
  }

  get active(): boolean {
    return this.activePromise !== null
  }

  get progress(): BuildProgress | null {
    return this.currentProgress
  }

  get lastBuildReport(): BuildReport | null {
    return this.lastReport
  }

  /** 取消进行中的构建（插件卸载 / session_index_status cancel=true）。 */
  cancel(): void {
    this.currentController?.abort()
  }

  /**
   * 释放资源（插件卸载时调用）：取消构建 + 终止 worker 池，
   * 并从单例注册表注销，保证热重载后新实例重建全新池。
   */
  dispose(): void {
    this.cancel()
    this.pool.terminate()
    const key = `${this.root}\u0000${this.indexFile}`
    if (builders.get(key) === this) builders.delete(key)
  }

  /** 进程内 single-flight：active 存在时直接复用同一 Promise。 */
  build(options: BuildOptions = {}): Promise<BuildReport> {
    if (this.activePromise) {
      // force 请求不能被非 force 的增量构建吸收（用户 refresh=true / FTS 回填要求全量）：
      // 等当前构建结束后补跑一次 force；已排队则复用同一排队 Promise。
      if (options.force && !this.activeForce) {
        if (!this.queuedForcePromise) {
          const base = this.activePromise
          this.queuedForcePromise = base.then((r) => {
            this.queuedForcePromise = null
            // cancelled 不补跑（用户已取消）；其余状态（completed/skipped/failed）
            // 都值得补跑一次真正的 force（全量解析可绕过 delta 路径的偶发失败）。
            if (r.status !== 'cancelled') return this.build({ ...options })
            return r
          })
        }
        return this.queuedForcePromise
      }
      // 排队期间的非 force 调用：等排队 force 完成，保持“拿到最终状态”语义
      if (this.queuedForcePromise && !options.force) return this.queuedForcePromise
      return this.activePromise
    }
    const controller = new AbortController()
    this.currentController = controller
    this.activeForce = !!options.force
    const onAbort = () => controller.abort()
    if (options.signal) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    const promise = this.doBuild({ ...options, signal: controller.signal }).finally(() => {
      if (this.activePromise === promise) this.activePromise = null
      if (this.currentController === controller) this.currentController = null
      if (this.activeForce) this.activeForce = false
      options.signal?.removeEventListener('abort', onAbort)
    })
    this.activePromise = promise
    return promise
  }

  private async doBuild(options: BuildOptions): Promise<BuildReport> {
    const t0 = Date.now()
    const report = emptyReport(this.indexFile)
    const signal = options.signal
    const delay =
      typeof monitorEventLoopDelay === 'function'
        ? monitorEventLoopDelay({ resolution: 10 })
        : null
    delay?.enable()
    const emitProgress = (phase: BuildProgress['phase'], processed: number, total: number) => {
      this.currentProgress = {
        phase,
        processed,
        total,
        scannedBytes: report.scannedBytes,
        delayMs: delay ? Math.round(delay.max / 1e6) : 0,
      }
      options.onProgress?.(this.currentProgress)
    }
    let marker: RunMarker | null = null
    let quickCommitted = false
    const parsedFiles = new Set<string>()
    try {
      throwIfAborted(signal)

      // durable run-marker：跨进程防重
      marker = await RunMarker.acquire(this.markerFile, STALE_MARKER_MS)
      if (!marker) {
        report.status = 'skipped'
        return report
      }
      // 启动清理 stale .tmp
      await cleanupStaleTemps(dirname(this.indexFile), {
        match: /\.tmp\.\d+\.\d+$/,
        maxAgeMs: STALE_TMP_MS,
      })

      // 主线程扫描文件列表 + 指纹
      emitProgress('scan', 0, 0)
      const { files, truncated } = await scanSessionFiles(this.root, { signal, cap: MAX_SCAN_FILES })
      report.totalFiles = files.length
      if (truncated) report.errors.push(`scan capped at ${MAX_SCAN_FILES} files`)
      emitProgress('scan', files.length, files.length)

      const old = loadIndex(this.indexFile)
      const oldByFile = new Map<string, SessionMeta>()
      if (old) for (const s of old.sessions) oldByFile.set(s.file, s)
      const byFile = new Map(oldByFile)

      // 增量判断：指纹 (size, mtimeMs, ctimeMs)；旧条目无 ctimeMs → 视为变更
      const force = !!options.force
      const retentionCutoff =
        options.retentionDays && options.retentionDays > 0
          ? Date.now() - options.retentionDays * 86400e3
          : 0
      const headFiles: ScanFile[] = []
      const fullFiles: ScanFile[] = []
      for (const f of files) {
        const prev = byFile.get(f.file)
        // P3 修复：超龄文件在变更检测阶段直接跳过（不进 head/full 解析）。
        // 此前只在 merge 阶段过滤：保留策略丢弃的旧会话每次构建都被全量
        // head+full 重解析一遍、再被过滤掉——每个 watcher 触发的构建都白付
        // 一轮全量成本。merge 阶段过滤仍保留（处理旧索引里残留的超龄条目，
        // pruned 计数不变）。会话文件本身绝不触碰（红线）。
        if (retentionCutoff > 0) {
          const staleAt = Math.max(prev?.lastTime ?? 0, f.mtimeMs)
          if (staleAt > 0 && staleAt < retentionCutoff) continue
        }
        const same =
          prev !== undefined &&
          prev.ctimeMs !== undefined &&
          prev.size === f.size &&
          prev.mtimeMs === f.mtimeMs &&
          prev.ctimeMs === f.ctimeMs
        // detailMissing 的 quick 条目即使指纹未变也必须 full pass 补齐
        if (same && !force && !prev?.detailMissing) {
          report.skipped++
          continue
        }
        fullFiles.push(f)
        if (force || prev === undefined || prev.detailMissing) headFiles.push(f)
      }

      // ── Phase A：head pass → quick index 崩溃检查点 ──
      if (headFiles.length > 0) {
        await this.runPoolTasks(
          headFiles,
          (f) => ({ mode: 'head' as const, file: f.file }),
          signal,
          (p, t) => emitProgress('head', p, t),
          (f, r) => {
            if (r.aborted) return // 取消：跳过记账
            if (r.ok && r.data) {
              report.headParsed++
              report.scannedBytes += f.size
              parsedFiles.add(f.file)
              byFile.set(f.file, quickMeta(f, r.data as HeadSummary))
            }
          },
        )
        if (report.headParsed > 0) {
          quickCommitted = true
          await this.commit(byFile)
          emitProgress('commit', parsedFiles.size, files.length)
        }
      }
      throwIfAborted(signal)

      // ── Phase B：full pass（worker 池全量解析变更文件）──
      if (fullFiles.length > 0) {
        await this.runPoolTasks(
          fullFiles,
          (f) => {
            // A suffix cannot be treated as an independent session: a later
            // surface replacement may shadow messages in an earlier frame.
            // Full reparse is the safe compatibility boundary.
            const delta = false
            return {
              mode: 'full' as const,
              file: f.file,
              startOffset: 0,
              delta,
              collectMessages: !!options.collectMessages,
            }
          },
          signal,
          (p, t) => emitProgress('full', p, t),
          async (f, r, fpBefore, spec) => {
            if (r.aborted) return // 取消：跳过失败记账（failed/errors 不被取消信号污染）
            if (!r.ok) {
              // Retain only a diagnostic marker.  Required unknown events and
              // invalid surface history must never remain searchable from an
              // earlier snapshot.
              report.failed++
              const err = (r.error ?? 'unknown error').slice(0, 160)
              report.errors.push(`${f.file}: ${err}`)
              if (report.errors.length > MAX_ERRORS) report.errors.length = MAX_ERRORS
              const entry = byFile.get(f.file)
              if (entry) byFile.set(f.file, { ...entry, error: err.slice(0, 200), unindexable: true })
              options.onSessionRemoved?.(f.file)
              return
            }
            // 发布前复检：解析期间指纹又变 → raced，保留旧值。
            // C8：改异步 stat（fs.promises），避免主线程同步阻塞
            const cur = await currentFingerprintAsync(f.file)
            if (
              !cur ||
              !fpBefore ||
              cur.size !== fpBefore.size ||
              cur.mtimeMs !== fpBefore.mtimeMs ||
              cur.ctimeMs !== fpBefore.ctimeMs
            ) {
              report.raced++
              const entry = byFile.get(f.file)
              if (entry) byFile.set(f.file, { ...entry, raced: true })
              return
            }
            report.fullParsed++
            // scannedBytes 每个文件只计一次（head 已计过的跳过）
            if (!parsedFiles.has(f.file)) report.scannedBytes += f.size
            parsedFiles.add(f.file)
            // 用解析前指纹（比扫描时指纹更贴近实际读取内容）；delta 合并到旧条目
            const prev = byFile.get(f.file)
            const meta =
              spec.delta && prev
                ? mergeDelta(prev, r.data as FullSummary, { ...f, ...fpBefore })
                : fullMeta({ ...f, ...fpBefore }, r.data as FullSummary)
            byFile.set(f.file, meta)
            // P2 FTS：成功解析后同步消息行（append = delta 追加）
            if (options.collectMessages && options.onSessionParsed) {
              try {
                const d = r.data as FullSummary
                options.onSessionParsed(f.file, meta, d.messages ?? [], !!spec.delta)
              } catch (e) {
                report.errors.push(`fts sync ${f.file}: ${String(e).slice(0, 120)}`)
              }
            }
          },
        )
      }
      throwIfAborted(signal)

      // ── merge：prune 已消失文件 + P3 保留策略（retentionDays>0）──
      const seen = new Set(files.map((f) => f.file))
      const scanMtime = new Map(files.map((f) => [f.file, f.mtimeMs] as const))
      for (const [file, meta] of [...byFile]) {
        if (!seen.has(file)) {
          byFile.delete(file)
          report.removed++
          options.onSessionRemoved?.(file)
          continue
        }
        // P3：文件仍在磁盘，但 max(lastTime, 文件 mtimeMs) 超龄 → 只清索引/派生层
        //（index.json 条目 + 经 onSessionRemoved 的 fts.db 行），**绝不删会话文件**。
        // 照 Hermes maybe_auto_prune_and_vacuum 语义：状态库清理、永不抛错。
        if (retentionCutoff > 0) {
          const mtime = scanMtime.get(file) ?? meta.mtimeMs ?? 0
          const staleAt = Math.max(meta.lastTime ?? 0, mtime)
          if (staleAt > 0 && staleAt < retentionCutoff) {
            byFile.delete(file)
            report.pruned++
            options.onSessionRemoved?.(file)
          }
        }
      }
      // 计数：added = 新文件；updated = 本次成功重新解析的既有条目（raced 除外）
      for (const [file, meta] of byFile) {
        const was = oldByFile.get(file)
        if (was === undefined) report.added++
        else if (parsedFiles.has(file) && !meta.raced) report.updated++
      }
      report.processed = parsedFiles.size

      // ── 最终原子提交 ──
      await this.commit(byFile)
      report.status = 'completed'
      return report
    } catch (e) {
      if (isCancelError(e) || signal?.aborted) report.status = 'cancelled'
      else {
        report.status = 'failed'
        report.errors.push(String(e).slice(0, 300))
      }
      return report
    } finally {
      if (marker) await marker.release()
      delay?.disable()
      report.maxEventLoopDelayMs = delay ? Math.round(delay.max / 1e6) : 0
      report.durationMs = Date.now() - t0
      report.partialCommitted = quickCommitted && report.status === 'cancelled'
      this.currentProgress = null
      this.lastReport = report
    }
  }

  /** worker 池批量执行（错误隔离：单文件失败不中断；取消则中止调度）。 */
  private async runPoolTasks(
    files: ScanFile[],
    makeSpec: (f: ScanFile) => WorkerTaskSpec,
    signal: AbortSignal | undefined,
    onTick: (processed: number, total: number) => void,
    onResult: (f: ScanFile, r: PoolResult, fpBefore: ScanFile | null, spec: WorkerTaskSpec) => void | Promise<void>,
  ): Promise<void> {
    let done = 0
    onTick(0, files.length)
    const tasks = files.map(async (f) => {
      // C8：直接复用 scan 阶段指纹（ScanFile 已含 size/mtimeMs/ctimeMs）——
      // 旧实现此处对每个文件再 statSync 一次，10000 文件上限下主线程连续阻塞
      // 数千次同步 stat（Phase A/B 各一轮），与 p95 < 23ms 目标冲突。
      const fpBefore: ScanFile | null = f
      this.testHooks?.onFileRead?.(f.file)
      let spec = makeSpec(f)
      let r = await this.runWithRetry(spec, signal)
      // P1 delta 回退：delta 解析失败（偏移失效/尾帧截断）→ 全量重解析一次，
      // 保证 indexedBytes 被外部改写/截断后能自愈，而不是永远失败。
      if (!r.ok && !r.aborted && spec.delta) {
        spec = { ...spec, startOffset: 0, delta: false }
        r = await this.runWithRetry(spec, signal)
      }
      await onResult(f, r, fpBefore, spec)
      done++
      if (done % 20 === 0) {
        onTick(done, files.length)
        await new Promise<void>((r) => setImmediate(r))
      }
    })
    await Promise.all(tasks)
    onTick(files.length, files.length)
  }

  /**
   * 单任务执行 + 失败重试一次（对应 Codex MAX_NOT_FOUND_RETRIES 的
   * “文件可能正被并发追加写入”处理）：会话文件是 append-only，构建期间可能
   * 读到半帧（EOF/invalid data）；等 150ms 重试一次可消除大部分瞬时失败。
   *
   * aborted 语义：仅调用方取消才为 true（isCancelError / signal.aborted）。
   * worker 崩溃/超时等基础设施错误按普通失败处理（可重试一次），
   * 不能与“用户取消”混为一谈。
   */
  private async runWithRetry(
    spec: WorkerTaskSpec,
    signal: AbortSignal | undefined,
  ): Promise<PoolResult> {
    let last: PoolResult = { ok: false, aborted: false, error: 'unknown error' }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await this.pool.run(spec, signal)
        last = { ok: r.ok, aborted: r.aborted, data: r.ok ? (r.data as HeadSummary | FullSummary) : undefined, error: r.ok ? undefined : r.error }
      } catch (e) {
        last = isCancelError(e) || signal?.aborted
          ? { ok: false, aborted: true, error: String(e) }
          : { ok: false, aborted: false, error: String(e) }
      }
      if (last.ok || last.aborted) return last
      if (attempt === 0) {
        throwIfAborted(signal)
        await new Promise<void>((r) => setTimeout(r, 150))
        throwIfAborted(signal)
      }
    }
    return last
  }

  private async commit(byFile: Map<string, SessionMeta>): Promise<void> {
    // 排序 tie-break 必须与 cursor 跳过逻辑一致（lastTime desc, id asc）
    const sessions = [...byFile.values()].sort(
      (a, b) => b.lastTime - a.lastTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    const index: SessionIndex = {
      version: 1,
      root: this.root,
      updatedAt: Date.now(),
      sessions,
    }
    await atomicWriteJson(this.indexFile, index, {
      backup: true,
      validate: (text) => {
        const obj = JSON.parse(text) as SessionIndex
        return obj.version === 1 && Array.isArray(obj.sessions)
      },
    })
    // P0-1：提交后显式失效内存缓存（防同 ms 同 size 撞车）
    invalidateIndexCache(this.indexFile)
  }
}

/** 按 (root, indexFile) 的单例注册表（进程内 single-flight 的入口）。 */
const builders = new Map<string, SessionIndexBuilder>()

export function getBuilder(root: string, indexFile: string): SessionIndexBuilder {
  const key = `${root}\u0000${indexFile}`
  let builder = builders.get(key)
  if (!builder) {
    builder = new SessionIndexBuilder({ root, indexFile })
    builders.set(key, builder)
  }
  return builder
}

function quickMeta(f: ScanFile, h: HeadSummary): SessionMeta {
  return {
    id: h.id || basename(dirname(f.file)),
    file: f.file,
    workspace: h.cwd || dirname(f.file),
    size: f.size,
    mtimeMs: f.mtimeMs,
    ctimeMs: f.ctimeMs,
    createdAt: h.createdAt,
    lastTime: h.lastTime,
    title: h.title || h.firstUserText.slice(0, 80),
    firstUserText: h.firstUserText,
    lastAssistantText: '',
    agentPreset: h.agentPreset,
    compatibility: h.compatibility,
    parentSession: h.parentSession,
    counts: {},
    toolNames: [],
    toolCallCounts: {},
    detailMissing: true,
    // 不设 indexedBytes：detailMissing 条目下次必须全量补齐，不能用 delta
  }
}

function fullMeta(f: ScanFile, d: FullSummary): SessionMeta {
  const toolNames = Object.keys(d.toolCallCounts).sort()
  return {
    id: d.id || basename(dirname(f.file)),
    file: f.file,
    workspace: d.cwd || dirname(f.file),
    size: f.size,
    mtimeMs: f.mtimeMs,
    ctimeMs: f.ctimeMs,
    createdAt: d.createdAt,
    lastTime: d.lastTime,
    title: d.title || d.firstUserText.slice(0, 80),
    firstUserText: d.firstUserText,
    lastAssistantText: d.lastAssistantText,
    agentPreset: d.agentPreset,
    compatibility: d.compatibility,
    parentSession: d.parentSession,
    counts: d.counts,
    toolNames,
    toolCallCounts: d.toolCallCounts,
    indexedBytes: f.size,
  }
}

/**
 * P1 delta：把新帧的解析结果合并到旧条目。
 * DSH 会话 append-only，字段要么单调（counts 累加 / lastTime max）、
 * 要么 last-wins（lastAssistantText 覆盖）、要么 first-wins（id/title/
 * firstUserText/agentPreset，旧值优先——新帧不含 header 帧）。
 */
function mergeDelta(prev: SessionMeta, d: FullSummary, f: ScanFile): SessionMeta {
  const counts = { ...prev.counts }
  for (const [k, v] of Object.entries(d.counts)) counts[k] = (counts[k] || 0) + v
  const toolCallCounts = { ...prev.toolCallCounts }
  for (const [k, v] of Object.entries(d.toolCallCounts)) toolCallCounts[k] = (toolCallCounts[k] || 0) + v
  return {
    ...prev,
    id: prev.id || d.id,
    workspace: prev.workspace,
    size: f.size,
    mtimeMs: f.mtimeMs,
    ctimeMs: f.ctimeMs,
    createdAt: prev.createdAt || d.createdAt,
    lastTime: Math.max(prev.lastTime, d.lastTime),
    // title 与 lastAssistantText 同语义：last-wins（全量解析里后到 title 事件覆盖先到）。
    // 用 d.title || prev.title 而非 prev.title || d.title：delta 窗口内的新 title 事件
    // 必须生效，否则重命名后的会话永远显示旧标题。
    title: d.title || prev.title,
    firstUserText: prev.firstUserText || d.firstUserText,
    lastAssistantText: d.lastAssistantText || prev.lastAssistantText,
    agentPreset: prev.agentPreset || d.agentPreset,
    compatibility: d.compatibility,
    parentSession: prev.parentSession || d.parentSession,
    counts,
    toolNames: Object.keys(toolCallCounts).sort(),
    toolCallCounts,
    indexedBytes: f.size,
  }
}

/** 解析后复检指纹（C8：异步 stat，主线程不被同步 stat 阻塞）。 */
async function currentFingerprintAsync(file: string): Promise<ScanFile | null> {
  try {
    const st = await stat(file)
    return { file, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs }
  } catch {
    return null
  }
}
