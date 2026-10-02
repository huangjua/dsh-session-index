/** Deterministic, independent-process SQLite write lock for isolated S2 tests. */
import { DatabaseSync } from 'node:sqlite'

const dbPath = process.argv[2]
if (!dbPath || !process.send) throw new Error('sqlite-lock-child requires a database path and IPC')
const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 0')
db.exec('BEGIN IMMEDIATE')
process.send({ type: 'locked' })

let closed = false
function close(commit: boolean): void {
  if (closed) return
  closed = true
  try { db.exec(commit ? 'COMMIT' : 'ROLLBACK') }
  finally { db.close() }
}

process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || (message as { type?: string }).type !== 'release') return
  close(true)
  process.send!({ type: 'released' }, () => process.disconnect())
})
process.on('disconnect', () => close(false))
