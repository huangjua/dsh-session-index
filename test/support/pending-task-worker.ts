/** Test barrier: confirm receipt, then remain pending until the pool terminates us. */
import { parentPort } from 'node:worker_threads'
import { renameSync, writeFileSync } from 'node:fs'

if (!parentPort) throw new Error('pending-task-worker must run as a worker')
parentPort.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object') return
  const task = message as { type?: string; file?: string; taskId?: number }
  if (task.type !== 'task' || typeof task.file !== 'string') return
  const temp = `${task.file}.ready`
  writeFileSync(temp, JSON.stringify({ taskId: task.taskId, received: true }))
  renameSync(temp, task.file)
  // No done response: this deterministic task cannot finish ahead of terminate().
})
