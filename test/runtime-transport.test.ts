import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createFtsClient, FtsClient } from '../src/fts-client.js'
import type { FtsRequestDiagnostic, FtsStartupDiagnostic } from '../src/fts-client.js'
import { FTS_PARSER_VERSION } from '../src/fts.js'
import type { SyncSessionRequest } from '../src/fts.js'

const fixture = new URL('./runtime-transport-fixture.js', import.meta.url)
async function scratch(work: (directory: string) => Promise<void>): Promise<void> {
  const parent = resolve(tmpdir())
  const directory = await mkdtemp(join(parent, 'dsh-runtime-transport-'))
  try { await work(directory) }
  finally {
    assert.equal(dirname(resolve(directory)), parent)
    assert.ok(basename(directory).startsWith('dsh-runtime-transport-'))
    await rm(directory, { recursive: true, force: true })
  }
}
const errorCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('bounded condition did not converge')
    await new Promise<void>(accept => setTimeout(accept, 10))
  }
}
function request(version: number): SyncSessionRequest {
  const file = '/isolated/runtime-session'
  return { meta: { file, id: 'runtime-session', workspace: '/isolated', title: 'isolated', agentPreset: '', createdAt: 1, lastTime: 1 },
    sourceFingerprint: { file, sessionId: 'runtime-session', size: version * 100, mtimeMs: version, ctimeMs: version,
      indexedBytes: version * 100, indexedSeq: version, complete: true }, parserVersion: FTS_PARSER_VERSION, mode: 'replace',
    messages: Array.from({ length: 1000 }, (_, index) => ({ sessionFile: file, role: 'user', toolName: '', text: `isolatedneedle ${version} ${index}` })) }
}

describe('runtime reader isolation and request deadline', () => {
  it('production worker cannot execute a write without the parent start permit', async () => scratch(async directory => {
    const spoolDirectory = join(directory, `.fts-staging-${process.pid}-${randomUUID()}`)
    const child = fork(fileURLToPath(new URL('../src/fts-worker.js', import.meta.url)), [JSON.stringify({
      dbPath: join(directory, 'permit.db'), spoolDirectory, role: 'writer', readOnly: false,
      batchBytes: 512 * 1024, queueBytes: 8 * 1024 * 1024,
    })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' })
    try {
      await new Promise<void>((accept, reject) => {
        const timer = setTimeout(() => reject(new Error('production worker startup deadline')), 3000)
        const ready = (message: any) => {
          if (!message.ready) return
          clearTimeout(timer)
          child.off('message', ready)
          if (message.available) accept()
          else reject(new Error(JSON.stringify(message.error)))
        }
        child.on('message', ready)
      })
      const invoke = (id: number, op: string, args: unknown[], permit: boolean) => new Promise<any>((accept, reject) => {
        const timer = setTimeout(() => { child.off('message', response); reject(new Error('production permit response deadline')) }, 3000)
        const response = (message: any) => {
          if (message.id !== id) return
          if (message.started) { if (permit) child.send({ startAck: id }); return }
          clearTimeout(timer)
          child.off('message', response)
          accept(message)
        }
        child.on('message', response)
        child.send({ id, op, args, deadline: Date.now() + (permit ? 1000 : 60) })
      })
      const rejected = await invoke(1, 'markPruned', [77], false)
      assert.equal(rejected.error?.code, 'EFTSQUEUETIMEOUT')
      const health = await invoke(2, 'health', [], true)
      assert.equal(health.result?.lastPruneCount, 0)
      assert.ok(health.timing?.sqlMs >= 0)
    } finally {
      const exited = new Promise<void>(accept => child.once('exit', () => accept()))
      child.kill('SIGTERM')
      await exited
    }
  }))

  it('terminates real synchronous SQLite read only; concurrent writer receipt and checkpoint survive', async () => scratch(async directory => {
    const diagnostics: FtsRequestDiagnostic[] = []
    const client = await createFtsClient(join(directory, 'slow-read.db'), { workerUrl: fixture, onRequestDiagnostic: event => diagnostics.push(event) })
    assert.ok(client)
    try {
      await client.syncSession(request(1))
      const generation = client.diagnostics().writerGeneration
      const slowRead = assert.rejects(client.search('__sqlite_slow', '', 1, undefined, { timeoutMs: 100 }), errorCode('EFTSTIMEOUT'))
      const committed = await client.syncSession(request(2))
      await slowRead
      await until(() => client.diagnostics().readerReady)
      assert.equal(client.diagnostics().writerGeneration, generation)
      assert.equal(client.diagnostics().writerRestarts, 0)
      assert.equal(client.diagnostics().readerRestarts, 1)
      assert.ok(client.diagnostics().lastReaderTerminationMs < 1000, 'OS reader cancellation must be bounded while native SQL is running')
      assert.deepEqual(await client.getCheckpoint('/isolated/runtime-session'), committed.checkpoint)
      assert.equal((await client.search('isolatedneedle', '', 1)).length, 1)
      await client.flush()
      assert.equal(client.diagnostics().pendingRequests, 0)
      assert.equal(client.diagnostics().activeStreams, 0)
      assert.equal(diagnostics.find(event => event.op === 'search' && event.outcome === 'error')?.timeoutPhase, 'execution')
    } finally { await client.close() }
  }))

  it('queued request expiry does not replace the running healthy reader; health uses writer', async () => scratch(async directory => {
    const diagnostics: FtsRequestDiagnostic[] = []
    const client = await createFtsClient(join(directory, 'queued.db'), { workerUrl: fixture, onRequestDiagnostic: event => diagnostics.push(event) })
    assert.ok(client)
    try {
      const held = client.search('__hold', '', 1, undefined, { timeoutMs: 1000 })
      await new Promise<void>(accept => setTimeout(accept, 30))
      const beganAt = Date.now()
      await assert.rejects(client.search('queuedneedle', '', 1, undefined, { timeoutMs: 60 }), errorCode('EFTSQUEUETIMEOUT'))
      assert.ok(Date.now() - beganAt < 250)
      const healthAt = Date.now()
      const health = await client.health()
      assert.ok(Date.now() - healthAt < 250)
      assert.equal(health.writerRestarts, 0)
      assert.equal(health.readerRestarts, 0)
      await held
      assert.equal(client.diagnostics().pendingRequests, 0)
      assert.equal(client.diagnostics().queueTimeouts, 1)
      assert.equal(diagnostics.find(event => event.errorCode === 'EFTSQUEUETIMEOUT')?.timeoutPhase, 'queue')
    } finally { await client.close() }
  }))

  it('recovery wait spends the same query deadline and retains historical failures', async () => scratch(async directory => {
    const diagnostics: FtsRequestDiagnostic[] = []
    const client = await createFtsClient(join(directory, 'recovery-delay.db'), { workerUrl: fixture, onRequestDiagnostic: event => diagnostics.push(event) })
    assert.ok(client)
    try {
      await assert.rejects(client.search('__exit', '', 1), errorCode('EFTSEXIT'))
      const beganAt = Date.now()
      await assert.rejects(client.search('ordinary', '', 1, undefined, { timeoutMs: 80 }), errorCode('EFTSTIMEOUT'))
      assert.ok(Date.now() - beganAt < 250)
      await until(() => client.diagnostics().readerReady)
      assert.equal(client.diagnostics().writerGeneration, 1)
      assert.equal(client.diagnostics().readerTransportFailures, 1)
      assert.ok(client.diagnostics().readerLastTransportError)
      assert.equal(diagnostics.at(-1)?.timeoutPhase, 'recovery')
      assert.equal(client.diagnostics().pendingRequests, 0)
    } finally { await client.close() }
  }))

  it('public ready waits for reader replacement rather than returning the retired actor readiness', async () => scratch(async directory => {
    const client = await createFtsClient(join(directory, 'recovery-delay.db'), { workerUrl: fixture })
    assert.ok(client)
    try {
      await assert.rejects(client.search('__exit', '', 1), errorCode('EFTSEXIT'))
      assert.equal(client.diagnostics().readerReady, false)
      let settled = false
      const ready = client.ready().then(value => { settled = true; return value })
      await new Promise<void>(accept => setTimeout(accept, 80))
      assert.equal(settled, false, 'replacement startup deliberately needs 300 ms')
      assert.equal(await ready, true)
      assert.equal(client.diagnostics().readerGeneration, 2)
      assert.equal(client.diagnostics().writerGeneration, 1)
      assert.equal((await client.search('ordinary', '', 1)).length, 0)
    } finally { await client.close() }
    assert.equal(await client.ready(), false)
  }))

  it('active read abort replaces only reader and leaves no pending cancellation', async () => scratch(async directory => {
    const client = await createFtsClient(join(directory, 'cancel-read.db'), { workerUrl: fixture })
    assert.ok(client)
    try {
      const abort = new AbortController()
      const read = assert.rejects(client.search('__sqlite_slow', '', 1, undefined, { signal: abort.signal }), errorCode('EFTSCANCELLED'))
      await new Promise<void>(accept => setTimeout(accept, 60))
      abort.abort()
      await read
      await until(() => client.diagnostics().readerReady)
      assert.equal(client.diagnostics().writerRestarts, 0)
      assert.equal(client.diagnostics().pendingRequests, 0)
      assert.equal(client.diagnostics().cancelledRequests, 1)
    } finally { await client.close() }
  }))
})

describe('runtime migration state and bounded initialization', () => {
  it('forced parent exit cannot leave a synchronous migrating SQLite process alive', async () => scratch(async directory => {
    const dbPath = join(directory, 'parent-crash.db')
    const initialized = await createFtsClient(dbPath)
    assert.ok(initialized)
    await initialized.close()
    const db = new DatabaseSync(dbPath)
    db.exec('DROP INDEX idx_messages_source_order; BEGIN IMMEDIATE')
    const parent = fork(fileURLToPath(new URL('./runtime-transport-parent-fixture.js', import.meta.url)), [directory], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    let sqlitePid: number | undefined
    try {
      sqlitePid = await new Promise<number>((accept, reject) => {
        const timer = setTimeout(() => reject(new Error('isolated migration did not reach synchronous lock wait')), 3000)
        const received = (message: any) => {
          if (!message.running) return
          clearTimeout(timer)
          parent.off('message', received)
          accept(message.pid)
        }
        parent.on('message', received)
      })
      const beganAt = Date.now()
      parent.kill('SIGKILL')
      await until(() => {
        try { process.kill(sqlitePid!, 0); return false }
        catch (error) { if ((error as { code?: string }).code === 'ESRCH') return true; throw error }
      })
      assert.ok(Date.now() - beganAt < 1500, 'independent guardian must stop a synchronously blocked child after parent death')
    } finally {
      parent.kill('SIGKILL')
      if (sqlitePid) { try { process.kill(sqlitePid, 'SIGKILL') } catch {} }
      db.exec('ROLLBACK')
      db.close()
    }
  }))

  it('ready deadline does not kill progressing migration; status returns parent progress', async () => scratch(async directory => {
    const progress: FtsStartupDiagnostic[] = []
    const requests: FtsRequestDiagnostic[] = []
    // This fixture autocommits each real SQLite batch. On the isolated Windows
    // store, measured gaps reached 274 ms and all 20 batches needed ~3.5 s.
    // Keep that progress test separate from the 100/180 ms stall/total faults.
    const client = new FtsClient(join(directory, 'migration-progress.db'), { workerUrl: fixture, startupTimeoutMs: 1000,
      migrationStallTimeoutMs: 1000, migrationTimeoutMs: 10000, onStartupProgress: event => progress.push(event), onRequestDiagnostic: event => requests.push(event) })
    try {
      await until(() => client.diagnostics().startup.writer?.state === 'migrating')
      await assert.rejects(client.search('ordinary', '', 1, undefined, { timeoutMs: 50 }), errorCode('EFTSTIMEOUT'))
      const beganAt = Date.now()
      const health = await client.health()
      assert.ok(Date.now() - beganAt < 100)
      assert.equal(health.healthSnapshot, true)
      assert.equal(health.startup.writer?.state, 'migrating')
      assert.equal(await client.ready(), true)
      assert.ok(progress.filter(event => event.progress && event.progress.completed > 0).length >= 10)
      assert.equal(requests.at(-1)?.timeoutPhase, 'ready')
      assert.equal(client.diagnostics().writerRestarts, 0)
    } finally { await client.close() }
  }))

  for (const [mode, code] of [['migration-stall', 'EFTSMIGRATIONSTALL'], ['migration-total', 'EFTSMIGRATIONTOTAL'], ['opening-stall', 'EFTSOPENING']] as const) {
    it(`${mode} fails within its own bound and factory preserves error/progress`, async () => scratch(async directory => {
      const failures: FtsStartupDiagnostic[] = []
      const beganAt = Date.now()
      const client = await createFtsClient(join(directory, `${mode}.db`), { workerUrl: fixture, startupTimeoutMs: 500,
        migrationStallTimeoutMs: 100, migrationTimeoutMs: 180, onStartupFailure: event => failures.push(event) })
      assert.equal(client, null)
      assert.ok(Date.now() - beganAt < 3000)
      assert.equal(failures.length, 1)
      assert.equal(failures[0].state, 'failed')
      assert.equal(failures[0].error?.code, code)
      if (mode !== 'opening-stall') assert.ok(failures[0].progress)
    }))
  }

  it('public factory allows actual SQLite batches beyond original 15 seconds', { timeout: 24000 }, async () => scratch(async directory => {
    const progress: FtsStartupDiagnostic[] = []
    const failures: FtsStartupDiagnostic[] = []
    const beganAt = Date.now()
    const client = await createFtsClient(join(directory, 'migration-long.db'), { workerUrl: fixture, startupTimeoutMs: 1000,
      migrationStallTimeoutMs: 3000, migrationTimeoutMs: 20000, onStartupProgress: event => progress.push(event), onStartupFailure: event => failures.push(event) })
    assert.ok(client, JSON.stringify(failures))
    try {
      assert.ok(Date.now() - beganAt > 15000)
      assert.equal(client.diagnostics().writerRestarts, 0)
      assert.equal(progress.filter(event => event.state === 'migrating' && event.progress && event.progress.completed > 0).length, 17)
    } finally { await client.close() }
  }))

  it('native SQLite migration stall exits its process, rolls back, and releases the writer lock before factory returns', async () => scratch(async directory => {
    const dbPath = join(directory, 'migration-native-stall.db')
    const failures: FtsStartupDiagnostic[] = []
    const beganAt = Date.now()
    const client = await createFtsClient(dbPath, { workerUrl: fixture, startupTimeoutMs: 1000,
      migrationStallTimeoutMs: 100, migrationTimeoutMs: 1000, onStartupFailure: event => failures.push(event) })
    assert.equal(client, null)
    assert.ok(Date.now() - beganAt < 2000)
    assert.equal(failures[0]?.error?.code, 'EFTSMIGRATIONSTALL')
    const db = new DatabaseSync(dbPath)
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')
      assert.equal((db.prepare('SELECT COUNT(*) n FROM migration_batches').get() as { n: number }).n, 0)
      assert.equal((db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get() as { value: string }).value, '2')
      db.exec('ROLLBACK')
    } finally { db.close() }
  }))
})
