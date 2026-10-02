/** Faults affect only the injected transport. Writer operations use the real worker. */
import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { createSessionFts } from '../src/fts.js'

const port = parentPort ?? { postMessage: (message: unknown) => process.send?.(message as Parameters<NonNullable<typeof process.send>>[0]),
  on: (_event: string, listener: (message: any) => void) => { process.on('message', listener) } }
const config = (parentPort ? workerData : JSON.parse(process.argv[2] ?? '{}')) as { dbPath: string; readOnly?: boolean; generation?: number }
const mode = config.dbPath.replace(/.*[\\/]/, '')
const startupFixture = /migration|opening-stall/.test(mode)
if (!config.readOnly && !startupFixture) {
  await import('../src/fts-worker.js')
} else {
  port.postMessage({ startup: { state: 'booted' } })
  port.postMessage({ startup: { state: 'opening' } })
  if (!config.readOnly && startupFixture) {
    const db = new DatabaseSync(config.dbPath)
    db.exec('CREATE TABLE IF NOT EXISTS migration_batches(id INTEGER PRIMARY KEY)')
    if (mode.includes('opening-stall')) {
      port.on('message', () => {})
    } else if (mode.includes('native-stall')) {
      db.exec("CREATE TABLE state_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO state_meta VALUES('schema_version','2'); BEGIN IMMEDIATE; INSERT INTO migration_batches DEFAULT VALUES")
      port.postMessage({ startup: { state: 'migrating', progress: { phase: 'batch-copy', completed: 0, total: 17, elapsedMs: 0 } } })
      db.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n').get()
    } else {
      let completed = 0
      const beganAt = Date.now()
      const total = mode.includes('long') ? 17 : 20
      const delay = mode.includes('long') ? 1000 : 20
      const progress = () => port.postMessage({ startup: { state: 'migrating', progress: {
        phase: 'batch-copy', completed, total, elapsedMs: Date.now() - beganAt,
      } } })
      progress()
      const timer = setInterval(() => {
        if (!mode.includes('stall')) {
          db.prepare('INSERT INTO migration_batches DEFAULT VALUES').run()
          completed++
        }
        progress()
        if (!mode.includes('total') && completed === total) {
          clearInterval(timer)
          db.close()
          port.postMessage({ ready: true, available: true })
        }
      }, delay)
      port.on('message', (request: { id?: number; op?: string }) => {
        if (request.id !== undefined) port.postMessage({ id: request.id, started: true })
        if (request.op === 'close') { clearInterval(timer); try { db.close() } catch {} }
        if (request.id !== undefined) port.postMessage({ id: request.id, result: undefined })
      })
    }
  } else {
    const engine = startupFixture ? null : await createSessionFts(config.dbPath, { readOnly: true, throwOnError: true })
    const sql = startupFixture ? null : new DatabaseSync(config.dbPath, { readOnly: true })
    if ((config.generation ?? 1) > 1 && mode.includes('recovery-delay')) await new Promise<void>(accept => setTimeout(accept, 300))
    port.postMessage({ ready: true, available: true })
    type Request = { id: number; op: string; args: unknown[]; deadline?: number; enqueuedAt: number }
    const queue: Request[] = []
    const startPermits = new Map<number, (accepted: boolean) => void>()
    let running = false
    async function drain(): Promise<void> {
      if (running) return
      running = true
      while (queue.length) {
        const request = queue.shift()!
        if (request.deadline !== undefined && Date.now() >= request.deadline) {
          port.postMessage({ id: request.id, error: { code: 'EFTSQUEUETIMEOUT', message: 'fixture queue deadline' } })
          continue
        }
        const canStart = await new Promise<boolean>(accept => {
          const timer = setTimeout(() => finish(false), Math.max(0, (request.deadline ?? Date.now() + 120000) - Date.now()))
          const finish = (accepted: boolean) => { clearTimeout(timer); startPermits.delete(request.id); accept(accepted) }
          startPermits.set(request.id, finish)
          port.postMessage({ id: request.id, started: true })
        })
        if (!canStart) continue
        const query = String(request.args[0] ?? '')
        if (query === '__exit') process.exit(42)
        if (query === '__sqlite_slow') {
          // SQLite runs synchronously. A cancel postMessage cannot be handled
          // while this statement is in progress; its isolated read process exits.
          sql!.prepare('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n').get()
        }
        const beganAt = Date.now()
        if (query === '__hold') await new Promise<void>(accept => setTimeout(accept, 300))
        const result = startupFixture ? request.op === 'sessionCount' ? 7 : []
          : query.startsWith('__') ? [] : await (engine as unknown as Record<string, (...args: unknown[]) => unknown>)[request.op]!(...request.args)
        port.postMessage({ id: request.id, result, timing: { queueMs: beganAt - request.enqueuedAt,
          dispatchMs: Date.now() - beganAt, serializationMs: 0, responseAt: Date.now() } })
      }
      running = false
    }
    port.on('message', (message: Omit<Request, 'enqueuedAt'> | { cancel: number } | { startAck: number }) => {
      if ('startAck' in message) { startPermits.get(message.startAck)?.(true); return }
      if ('cancel' in message) {
        const index = queue.findIndex(request => request.id === message.cancel)
        if (index !== -1) queue.splice(index, 1)
        startPermits.get(message.cancel)?.(false)
        return
      }
      queue.push({ ...message, enqueuedAt: Date.now() })
      void drain()
    })
  }
}
