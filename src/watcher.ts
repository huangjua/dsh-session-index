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

export function createSessionWatcher(
  root: string,
  debounceMs: number,
  onChange: () => void,
  onError?: () => void,
): SessionWatcher {
  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null
  let closed = false

  const schedule = () => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onChange()
    }, debounceMs)
  }

  try {
    watcher = watch(root, { recursive: true }, schedule)
    watcher.on('error', () => {
      // 监听中途失效（目录被删/权限变化/平台限制）：通知调用方切回节流 stat 回退，
      // 否则索引会静默停止保鲜。
      if (!closed) onError?.()
    })
  } catch {
    return { ok: false, close: () => {} }
  }

  return {
    ok: true,
    close: () => {
      closed = true
      if (timer) clearTimeout(timer)
      try {
        watcher?.close()
      } catch {
        /* ignore */
      }
    },
  }
}
