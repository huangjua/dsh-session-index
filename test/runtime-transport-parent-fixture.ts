/** Isolated parent dies forcibly while its writer has synchronous migration lock wait. */
import { fork } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const directory = process.argv[2]!
const child = fork(fileURLToPath(new URL('../src/fts-worker.js', import.meta.url)), [JSON.stringify({
  dbPath: join(directory, 'parent-crash.db'), spoolDirectory: join(directory, `.fts-staging-${process.pid}-${randomUUID()}`),
  role: 'writer', readOnly: false, batchBytes: 512 * 1024, queueBytes: 8 * 1024 * 1024,
})], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' })
child.on('message', (message: any) => {
  if (message.startup?.progress?.phase === 'lock-wait') {
    process.send?.({ running: true, pid: child.pid })
  }
})
process.on('message', () => {})
