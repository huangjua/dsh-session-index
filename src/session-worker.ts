/**
 * session-worker.ts — worker_threads 入口（编译为 lib/session-worker.js）
 *
 * 单 worker 同时只处理 1 个文件；cooperative cancel：收到 { type: 'cancel' }
 * 消息后中止当前任务（解析循环逐 chunk 检查 signal.aborted），
 * 已启动的任务自然跑完、不再接收新任务。
 *
 * 错误隔离：任何任务异常都被捕获并作为 { ok: false, error } 回报，
 * 绝不把异常抛到 worker 顶层导致崩溃。
 */
import { parentPort } from 'node:worker_threads'
import { parseHead, parseFull, parseSearch } from './streaming-parser.js'
import type { HeadSummary, FullSummary, SearchHit } from './streaming-parser.js'
import type { CompatResumeState } from './session-compat.js'

interface TaskMessage {
  type: 'task'
  taskId: number
  mode: 'head' | 'full' | 'search'
  file: string
  query?: string
  maxSnippets?: number
  maxDecompressedBytes?: number
  startOffset?: number
  collectMessages?: boolean
  /** C9b：delta 续读状态（窗口无 header，需播种 version/generation/header/seq） */
  resume?: CompatResumeState
}

type TaskData = HeadSummary | FullSummary | SearchHit[]

if (parentPort) {
  let current: AbortController | null = null

  parentPort.on('message', (msg: unknown) => {
    if (!msg || typeof msg !== 'object') return
    const m = msg as { type?: string }
    if (m.type === 'cancel') {
      current?.abort()
      return
    }
    if (m.type !== 'task') return
    const task = msg as TaskMessage
    const controller = new AbortController()
    current = controller
    void (async () => {
      let data: TaskData
      try {
        const signal = controller.signal
        const maxDecompressedBytes = task.maxDecompressedBytes
        if (task.mode === 'head') {
          data = await parseHead(task.file, { signal, maxDecompressedBytes })
        } else if (task.mode === 'full') {
          data = await parseFull(task.file, {
            signal,
            maxDecompressedBytes,
            startOffset: task.startOffset,
            collectMessages: task.collectMessages,
            // C9b：增量窗口不含 header，需按上一轮结果播种 compat 状态
            resume: task.resume,
          })
        } else if (task.mode === 'search') {
          data = await parseSearch(task.file, task.query || '', {
            signal,
            maxSnippets: task.maxSnippets,
            maxDecompressedBytes,
          })
        } else {
          throw new Error(`unknown worker task mode: ${String(task.mode)}`)
        }
        parentPort!.postMessage({
          type: 'done',
          taskId: task.taskId,
          ok: true,
          aborted: controller.signal.aborted,
          data,
        })
      } catch (e) {
        parentPort!.postMessage({
          type: 'done',
          taskId: task.taskId,
          ok: false,
          aborted: controller.signal.aborted,
          error: e instanceof Error ? e.message : String(e),
        })
      } finally {
        if (current === controller) current = null
      }
    })()
  })
}
