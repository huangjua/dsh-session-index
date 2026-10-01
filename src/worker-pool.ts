/**
 * worker-pool.ts — 有界 worker 池 + mapLimit
 *
 * 对应 Codex compression.rs 的 JoinSet 有界调度：
 *   while jobs.len() >= MAX_CONCURRENT { join_next() }
 * 池大小 Math.min(4, Math.max(1, availableParallelism - 1))；
 * 单 worker 同时只处理 1 个文件 → 内存有界；
 * 单文件失败 → 结果 { ok:false, error }，池内换新 worker 继续，构建不中断；
 * worker 不可用（构造失败/环境限制）→ inline 回退（同一解析函数，cooperative）。
 */
import { Worker } from 'node:worker_threads'
import os from 'node:os'
import { CancelError, isCancelError } from './cancel.js'
import { parseHead, parseFull, parseSearch } from './streaming-parser.js'
import type { HeadSummary, FullSummary, SearchHit } from './streaming-parser.js'

export type WorkerTaskMode = 'head' | 'full' | 'search'
export type WorkerTaskData = HeadSummary | FullSummary | SearchHit[]

export interface WorkerTaskSpec {
  mode: WorkerTaskMode
  file: string
  query?: string
  maxSnippets?: number
  maxDecompressedBytes?: number
  /** P1 delta：压缩输入从该字节偏移开始读（须为帧边界；仅 full 模式） */
  startOffset?: number
  /** 仅 builder 内部记账用：本次是否为 delta 解析（worker 无需感知） */
  delta?: boolean
  /** C9b：delta 窗口的起始事件 seq（worker 内 parseFull 用它判定 replace 是否跨窗口） */
  startSeq?: number
  /** P2 FTS：full 模式下收集消息行（user/assistant 文本 + tool 名） */
  collectMessages?: boolean
}

export type TaskResult<T = WorkerTaskData> =
  | { ok: true; data: T; aborted: boolean }
  | { ok: false; aborted: boolean; error: string }

export interface WorkerPoolOptions {
  /** 池大小；缺省 Math.min(4, Math.max(1, availableParallelism - 1)) */
  size?: number
  /** worker 脚本 URL；缺省在 WorkerPool 构造时由调用方给出（null = 仅 inline） */
  workerUrl?: URL | null
  /** 单任务超时（毫秒），超时杀死 worker 换新（默认 15 分钟） */
  timeoutMs?: number
}

interface PendingTask {
  id: number
  spec: WorkerTaskSpec
  resolve: (r: TaskResult) => void
  reject: (e: unknown) => void
  controller: AbortController
  timeout?: NodeJS.Timeout
  dispatched: boolean
}

interface Slot {
  worker: Worker
  pending: PendingTask | null
  dead: boolean
  /** 本次 pump 循环中刚 spawn（用于 spawn 后让出主线程） */
  spawned: boolean
}

export class WorkerPool {
  private readonly size: number
  private readonly workerUrl: URL | null
  private readonly timeoutMs: number
  private readonly slots: Slot[] = []
  private readonly queue: PendingTask[] = []
  private seq = 0
  private inlineMode = false
  private terminated = false
  /** inline 回退模式下的并发上限（主线程同步 CPU 活，必须限流） */
  private readonly inlineMax: number
  private inlineActive = 0

  constructor(options: WorkerPoolOptions = {}) {
    const avail =
      typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
    this.size = options.size ?? Math.min(4, Math.max(1, avail - 1))
    this.workerUrl = options.workerUrl ?? null
    this.timeoutMs = options.timeoutMs ?? 15 * 60 * 1000
    this.inlineMax = Math.min(2, Math.max(1, this.size))
    if (!this.workerUrl) this.inlineMode = true
  }

  /**
   * 提交一个任务。返回 TaskResult：
   * - 取消（caller signal / 池终止）→ reject CancelError；
   * - 单文件失败 → resolve { ok:false, error }（错误隔离，不 reject）。
   */
  run<T extends WorkerTaskData = WorkerTaskData>(
    spec: WorkerTaskSpec,
    signal?: AbortSignal,
  ): Promise<TaskResult<T>> {
    return new Promise<TaskResult<T>>((resolve, reject) => {
      if (this.terminated) {
        reject(new CancelError('pool terminated'))
        return
      }
      if (signal?.aborted) {
        reject(new CancelError())
        return
      }
      const controller = new AbortController()
      // C5：调用方 signal 的 abort 监听必须在任务 settle 时自摘——once:true 只在
      // 触发时移除，正常完成的构建（signal 从不 abort）会按文件数累积监听器
      // （>10 触发 MaxListeners 告警）。挂到 wrapped resolve/reject 出口全覆盖。
      const onCallerAbort = (): void => controller.abort()
      const removeCallerAbort = (): void => {
        signal?.removeEventListener('abort', onCallerAbort)
      }
      const pending: PendingTask = {
        id: this.seq++,
        spec,
        resolve: (r: TaskResult) => {
          removeCallerAbort()
          resolve(r as TaskResult<T>)
        },
        reject: (e: unknown) => {
          removeCallerAbort()
          reject(e)
        },
        controller,
        dispatched: false,
      }
      if (signal) {
        signal.addEventListener('abort', onCallerAbort)
      }
      controller.signal.addEventListener(
        'abort',
        () => {
          if (!pending.dispatched) {
            const i = this.queue.indexOf(pending)
            if (i !== -1) this.queue.splice(i, 1)
            pending.reject(new CancelError())
          }
        },
        { once: true },
      )
      this.queue.push(pending)
      this.pump()
    })
  }

  /** 终止池：取消排队任务、reject 在飞任务、杀死 worker。插件卸载时调用。 */
  terminate(): void {
    this.terminated = true
    for (const slot of this.slots) {
      slot.dead = true
      const pending = slot.pending
      slot.pending = null
      if (pending) {
        if (pending.timeout) clearTimeout(pending.timeout)
        pending.reject(new CancelError('pool terminated'))
      }
      slot.worker.terminate().catch(() => {})
    }
    this.slots.length = 0
    for (const pending of this.queue) {
      pending.reject(new CancelError('pool terminated'))
    }
    this.queue.length = 0
    if (this.inlineActive > 0) {
      // inline 任务各自收尾时会 reject 自己的 pending（信号已随 terminate 不触发，
      // 靠任务自身 catch 收场）；这里只重置计数
      this.inlineActive = 0
    }
  }

  get sizeLimit(): number {
    return this.size
  }

  /** inline 回退模式下当前在飞任务数（测试/观测用） */
  get inlineInFlight(): number {
    return this.inlineActive
  }

  /* ── 调度 ─────────────────────────────────────────────── */

  private pump(): void {
    void this.pumpAsync()
  }

  private async pumpAsync(): Promise<void> {
    if (this.terminated) return
    while (this.queue.length > 0) {
      if (this.inlineMode) {
        // inline 回退：fzstd 解压是主线程同步 CPU 活，必须限并发 + 每任务让出事件循环，
        // 否则队列里所有任务被同时派发会直接卡死主线程（违反“主线程绝不长时间阻塞”）
        if (this.inlineActive >= this.inlineMax) return
        const pending = this.queue.shift()!
        this.inlineActive++
        this.dispatchInline(pending)
        continue
      }
      const slot = this.nextSlot()
      if (!slot) {
        // worker 全忙（或首次 spawn 失败已切 inline）→ 等完成事件再 pump
        if (this.inlineMode) continue
        return
      }
      const pending = this.queue.shift()!
      this.dispatch(slot, pending)
      // worker spawn 是主线程重活：每次 spawn 后让出事件循环，避免突发阻塞
      if (slot.spawned) await new Promise<void>((r) => setImmediate(r))
    }
  }

  private nextSlot(): Slot | null {
    for (const s of this.slots) {
      if (!s.dead && s.pending === null) {
        s.spawned = false
        return s
      }
    }
    if (this.slots.length < this.size) {
      const slot = this.spawnSlot()
      if (slot) return slot
    }
    return null
  }

  private spawnSlot(): Slot | null {
    const url = this.workerUrl
    if (!url || this.inlineMode) {
      this.inlineMode = true
      return null
    }
    let worker: Worker
    try {
      worker = new Worker(url)
    } catch {
      // 环境限制（无 worker 支持等）→ inline 回退
      this.inlineMode = true
      return null
    }
    const slot: Slot = { worker, pending: null, dead: false, spawned: true }
    worker.on('message', (msg: unknown) => this.onMessage(slot, msg))
    worker.on('error', (err: Error) => this.onWorkerError(slot, err))
    worker.on('exit', (code: number) => {
      if (code !== 0) this.onWorkerError(slot, new Error(`worker exited with code ${code}`))
    })
    this.slots.push(slot)
    return slot
  }

  private dispatch(slot: Slot, pending: PendingTask): void {
    slot.pending = pending
    pending.dispatched = true
    try {
      slot.worker.postMessage({
        type: 'task',
        taskId: pending.id,
        mode: pending.spec.mode,
        file: pending.spec.file,
        query: pending.spec.query,
        maxSnippets: pending.spec.maxSnippets,
        maxDecompressedBytes: pending.spec.maxDecompressedBytes,
        startOffset: pending.spec.startOffset,
        collectMessages: pending.spec.collectMessages,
      })
    } catch (e) {
      slot.pending = null
      this.onWorkerError(slot, e instanceof Error ? e : new Error(String(e)))
      pending.reject(new Error(`postMessage failed: ${String(e)}`))
      return
    }
    if (this.timeoutMs > 0) {
      pending.timeout = setTimeout(() => this.onTimeout(slot, pending), this.timeoutMs)
    }
    pending.controller.signal.addEventListener(
      'abort',
      () => {
        if (slot.pending === pending && !slot.dead) {
          try {
            slot.worker.postMessage({ type: 'cancel', taskId: pending.id })
          } catch {
            /* worker 已死，等 error 事件 */
          }
        }
      },
      { once: true },
    )
  }

  private dispatchInline(pending: PendingTask): void {
    pending.dispatched = true
    void (async () => {
      const signal = pending.controller.signal
      try {
        let data: WorkerTaskData
        if (pending.spec.mode === 'head') data = await parseHead(pending.spec.file, { signal })
        else if (pending.spec.mode === 'full')
          data = await parseFull(pending.spec.file, {
            signal,
            startOffset: pending.spec.startOffset,
            collectMessages: pending.spec.collectMessages,
          })
        else if (pending.spec.mode === 'search')
          data = await parseSearch(pending.spec.file, pending.spec.query || '', {
            signal,
            maxSnippets: pending.spec.maxSnippets,
          })
        else throw new Error(`unknown task mode: ${pending.spec.mode}`)
        pending.resolve({ ok: true, data, aborted: signal.aborted })
      } catch (e) {
        if (isCancelError(e) || signal.aborted) pending.reject(new CancelError())
        else pending.resolve({ ok: false, aborted: false, error: e instanceof Error ? e.message : String(e) })
      } finally {
        this.inlineActive = Math.max(0, this.inlineActive - 1)
        this.pump()
      }
    })()
  }

  private onMessage(slot: Slot, msg: unknown): void {
    if (!msg || typeof msg !== 'object') return
    const m = msg as { type?: string; taskId?: number; ok?: boolean; aborted?: boolean; data?: unknown; error?: string }
    if (m.type !== 'done') return
    const pending = slot.pending
    if (!pending || pending.id !== m.taskId) return
    if (pending.timeout) clearTimeout(pending.timeout)
    slot.pending = null
    if (m.aborted && !m.ok) {
      pending.reject(new CancelError())
    } else if (m.ok) {
      pending.resolve({ ok: true, data: m.data as WorkerTaskData, aborted: !!m.aborted })
    } else {
      pending.resolve({ ok: false, aborted: false, error: String(m.error || 'unknown worker error') })
    }
    this.pump()
  }

  private onWorkerError(slot: Slot, err: unknown): void {
    if (slot.dead) return
    slot.dead = true
    const pending = slot.pending
    slot.pending = null
    const i = this.slots.indexOf(slot)
    if (i !== -1) this.slots.splice(i, 1)
    slot.worker.terminate().catch(() => {})
    if (pending) {
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.reject(new Error(`worker error: ${err instanceof Error ? err.message : String(err)}`))
    }
    if (!this.terminated) this.pump()
  }

  private onTimeout(slot: Slot, pending: PendingTask): void {
    slot.dead = true
    slot.pending = null
    const i = this.slots.indexOf(slot)
    if (i !== -1) this.slots.splice(i, 1)
    slot.worker.terminate().catch(() => {})
    pending.reject(new Error('task timeout'))
    if (!this.terminated) this.pump()
  }
}

/**
 * 通用有界并发映射（对应 PORT_TO_TS.md 的 mapLimit）。
 * 取消后不再调度新任务；已启动任务自然跑完。
 *
 * @internal C11：生产的构建并发由 SessionIndexBuilder.runPoolTasks 自行调度
 * （分波派发 + 池上限），本函数仅 worker-pool.test.ts 使用。保留勿删。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<Array<R | undefined>> {
  const out = new Array<R | undefined>(items.length)
  let next = 0
  let aborted = signal?.aborted ?? false
  const onAbort = () => {
    aborted = true
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const n = Math.max(1, Math.min(limit, items.length))
    const runners = Array.from({ length: n }, async () => {
      while (!aborted) {
        const i = next++
        if (i >= items.length) return
        out[i] = await worker(items[i], i)
      }
    })
    await Promise.all(runners)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  return out
}
