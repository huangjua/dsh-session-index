/**
 * watcher.ts — sessions 目录递归监听（P0-2）
 *
 * 把"每次工具调用全目录 stat 对账"变成"变更驱动"：fs.watch(recursive)
 * 捕获新会话创建/会话文件追加（DSH 持久化是 append-only，rename/change 都会触发），
 * debounce 后回调。构造失败（无权限/平台限制）返回 ok:false，调用方回退节流轮询。
 */
import { watch, type FSWatcher } from 'node:fs'

export interface SessionWatcher {
  /** false = 构造失败（调用方回退节流 stat 对账） */
  ok: boolean
  close: () => void
}

export interface SessionWatcherOptions {
  /** 持续事件也必须在本窗口内送出一次更新。 */
  maxWaitMs?: number
  /** 注入式监听入口，便于模拟监听失效。 */
  watch?: (root: string, onChange: () => void) => FSWatcher
}

export function createSessionWatcher(
  root: string,
  debounceMs: number,
  onChange: () => void,
  onError?: () => void,
  options: SessionWatcherOptions = {},
): SessionWatcher {
  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null
  let maxWaitTimer: NodeJS.Timeout | null = null
  let closed = false
  const result: SessionWatcher = { ok: true, close }
  const maxWaitMs = Math.max(debounceMs, options.maxWaitMs ?? 5000)

  const clearTimers = () => {
    if (timer) clearTimeout(timer)
    if (maxWaitTimer) clearTimeout(maxWaitTimer)
    timer = null
    maxWaitTimer = null
  }
  const deliver = () => {
    clearTimers()
    if (!closed) onChange()
  }

  function close(): void {
    if (closed) return
    closed = true
    result.ok = false
    clearTimers()
    try { watcher?.close() } catch { /* ignore */ }
    watcher = null
  }

  const schedule = () => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(deliver, debounceMs)
    if (!maxWaitTimer) maxWaitTimer = setTimeout(deliver, maxWaitMs)
  }

  try {
    watcher = options.watch ? options.watch(root, schedule) : watch(root, { recursive: true }, schedule)
    watcher.on('error', () => {
      // 监听中途失效（目录被删/权限变化/平台限制）：通知调用方切回节流 stat 回退，
      // 否则索引会静默停止保鲜。
      if (closed) return
      close()
      onError?.()
    })
  } catch {
    close()
  }

  return result
}
