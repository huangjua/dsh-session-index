import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createFtsClient } from '../src/fts-client.js'
import { FTS_PARSER_VERSION } from '../src/fts.js'
import { inspectFtsSpools, probeSpoolOwner, writeSpoolOwner } from '../src/fts-spool.js'
import type { FtsSpoolCleanupFailure } from '../src/fts-spool.js'
import type { SyncSessionRequest } from '../src/fts.js'
const fixture = new URL('./spool-cleanup-worker.js', import.meta.url)
const originalRm = fs.rm
const file = '/isolated/spool'
function request(version: number, invalid = false): SyncSessionRequest {
  return { meta: { file, id: 'spool', workspace: '', title: '', agentPreset: '', createdAt: 1, lastTime: 2 },
    sourceFingerprint: { file, sessionId: 'spool', size: version * 1000, mtimeMs: version, ctimeMs: version, indexedBytes: version * 1000, complete: true },
    parserVersion: FTS_PARSER_VERSION, mode: 'replace', messages: [{ sessionFile: invalid ? '/wrong' : file, role: 'user', text: `snapshot-version-${version}`, toolName: '' }] }
}
async function scratch(work: (directory: string) => Promise<void>): Promise<void> {
  const parent = resolve(tmpdir())
  const directory = await fs.mkdtemp(join(parent, 'dsh-fts-spool-'))
  try { await work(directory) }
  finally {
    fs.rm = originalRm
    syncBuiltinESMExports()
    assert.equal(dirname(resolve(directory)), parent)
    assert.ok(basename(directory).startsWith('dsh-fts-spool-'))
    await originalRm(directory, { recursive: true, force: true })
  }
}
const cleanupCode = (error: unknown) => (error as { code?: string }).code === 'EFTSSPOOLCLEANUP'
describe('FTS spool cleanup outcome and read-only owner diagnostics', () => {
  it('PID probes distinguish alive/dead/unknown without treating permission denial as dead', () => {
    assert.equal(probeSpoolOwner(process.pid).state, 'alive')
    assert.equal(probeSpoolOwner(123, () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) }).state, 'dead')
    const unknown = probeSpoolOwner(123, () => { throw Object.assign(new Error('permission'), { code: 'EPERM' }) })
    assert.equal(unknown.state, 'unknown')
    assert.equal(unknown.error?.code, 'EPERM')
  })
  it('inventory reports live owner, malformed metadata, legacy uncertainty and scan errors without deletion', async () => scratch(async directory => {
    const dbPath = join(directory, 'fts.db')
    const live = join(directory, `.fts-staging-${process.pid}-${randomUUID()}`)
    const unknown = join(directory, `.fts-staging-${process.pid}-${randomUUID()}`)
    const legacy = join(directory, `.fts-staging-${process.pid}-${randomUUID()}`)
    for (const path of [live, unknown, legacy]) await fs.mkdir(path)
    await writeSpoolOwner(live, dbPath)
    await fs.writeFile(join(unknown, 'owner.json'), 'not-json')
    await fs.writeFile(join(legacy, 'preserved.jsonl'), 'legacy-batch')
    const report = await inspectFtsSpools(dbPath)
    assert.equal(report.entries.find(entry => entry.path === live)?.ownerState, 'alive')
    assert.equal(report.entries.find(entry => entry.path === unknown)?.ownerState, 'unknown')
    assert.ok(report.entries.find(entry => entry.path === unknown)?.error)
    assert.equal(report.entries.find(entry => entry.path === legacy)?.verification, 'directory-pid-only')
    assert.equal(report.entries.find(entry => entry.path === legacy)?.ownerState, 'unknown')
    assert.equal(await fs.readFile(join(legacy, 'preserved.jsonl'), 'utf8'), 'legacy-batch')
    assert.equal((await inspectFtsSpools(join(directory, 'missing', 'fts.db'))).error?.code, 'ENOENT')
  }))
  it('inventory refuses to follow a spool junction', async () => scratch(async directory => {
    const target = join(directory, 'target')
    const link = join(directory, `.fts-staging-${process.pid}-${randomUUID()}`)
    await fs.mkdir(target)
    await fs.writeFile(join(target, 'sentinel'), 'untouched')
    await fs.symlink(target, link, 'junction')
    const report = await inspectFtsSpools(join(directory, 'fts.db'))
    assert.equal(report.entries.find(entry => entry.path === link)?.error?.code, 'EFTSSPOOLPATH')
    assert.equal(await fs.readFile(join(target, 'sentinel'), 'utf8'), 'untouched')
  }))
  it('client close surfaces its own cleanup failure and leaves unrelated historical paths alone', async () => scratch(async directory => {
    const historical = join(directory, `.fts-staging-${process.pid}-${randomUUID()}`)
    await fs.mkdir(historical)
    await fs.writeFile(join(historical, 'historical'), 'preserve')
    const events: FtsSpoolCleanupFailure[] = []
    const client = await createFtsClient(join(directory, 'fts.db'), { onSpoolDiagnostic: event => events.push(event) })
    assert.ok(client)
    let armed = true
    fs.rm = async (path, options) => {
      if (armed && dirname(String(path)) === directory && String(path).includes('.fts-staging-') && String(path) !== historical) {
        throw Object.assign(new Error('injected directory cleanup EACCES'), { code: 'EACCES' })
      }
      return originalRm(path, options)
    }
    syncBuiltinESMExports()
    await assert.rejects(client.close(), cleanupCode)
    assert.ok(events.some(event => event.phase === 'client-close' && event.code === 'EACCES' && event.path !== historical))
    assert.ok(client.diagnostics().spoolCleanupPendingDirectories.length)
    assert.equal(client.diagnostics().pendingRequests, 0)
    assert.equal(await fs.readFile(join(historical, 'historical'), 'utf8'), 'preserve')
    armed = false
  }))
  it('restart records cleanup warnings, still recovers SQLite, and close retries only its retired directories', async () => scratch(async directory => {
    const events: FtsSpoolCleanupFailure[] = []
    const client = await createFtsClient(join(directory, 'fts.db'), { onSpoolDiagnostic: event => events.push(event) })
    assert.ok(client)
    await client.syncSession(request(1))
    let armed = true
    fs.rm = async (path, options) => {
      if (armed && dirname(String(path)) === directory && String(path).includes('.fts-staging-')) throw Object.assign(new Error('restart cleanup EACCES'), { code: 'EACCES' })
      return originalRm(path, options)
    }
    syncBuiltinESMExports()
    await client.restart()
    assert.equal((await client.getCheckpoint(file))?.messageCount, 1)
    assert.ok(events.some(event => event.phase === 'restart'))
    assert.ok(client.diagnostics().spoolCleanupPendingDirectories.length)
    armed = false
    await client.close()
    assert.deepEqual(client.diagnostics().spoolCleanupPendingDirectories, [])
    assert.equal((await fs.readdir(directory)).some(name => name.startsWith('.fts-staging-')), false)
  }))
  it('unlink failure after COMMIT remains a cleanup warning, preserving the successful receipt and checkpoint', async () => scratch(async directory => {
    const events: FtsSpoolCleanupFailure[] = []
    const client = await createFtsClient(join(directory, 'cleanup-always.db'), { workerUrl: fixture, onSpoolDiagnostic: event => events.push(event) })
    assert.ok(client)
    const receipt = await client.syncSession(request(1))
    assert.equal(receipt.checkpoint.messageCount, 1)
    assert.equal((await client.getCheckpoint(file))?.messageCount, 1)
    assert.equal(client.diagnostics().lastWriteError, '')
    assert.equal(client.diagnostics().spoolCleanupPendingStages, 1)
    assert.ok(events.some(event => event.phase === 'commit' && event.writeCommitted === true && event.code === 'EACCES'))
    await assert.rejects(client.close(), cleanupCode)
    assert.equal(client.diagnostics().pendingRequests, 0)
  }))
  it('cleanup failure after rollback cannot replace the primary SQL error or lose stage diagnostics', async () => scratch(async directory => {
    const events: FtsSpoolCleanupFailure[] = []
    const client = await createFtsClient(join(directory, 'cleanup-always.db'), { workerUrl: fixture, onSpoolDiagnostic: event => events.push(event) })
    assert.ok(client)
    await client.syncSession(request(1))
    await assert.rejects(client.syncSession(request(2, true)), /another session/)
    assert.equal((await client.getCheckpoint(file))?.messageCount, 1)
    assert.match(client.diagnostics().lastWriteError, /another session/)
    assert.equal(client.diagnostics().spoolCleanupPendingStages, 2)
    assert.ok(events.some(event => event.phase === 'rollback' && event.writeCommitted === false))
    assert.ok(events.some(event => event.phase === 'abort' && event.writeCommitted === false))
    await assert.rejects(client.flush(), /another session/)
    await assert.rejects(client.close(), cleanupCode)
  }))
  it('a retained stage can retry cleanup on the next write without another failed transaction', async () => scratch(async directory => {
    const client = await createFtsClient(join(directory, 'cleanup-once.db'), { workerUrl: fixture, onSpoolDiagnostic: () => {} })
    assert.ok(client)
    await client.syncSession(request(1))
    assert.equal(client.diagnostics().spoolCleanupPendingStages, 1)
    await client.syncSession(request(2))
    assert.equal(client.diagnostics().spoolCleanupPendingStages, 0)
    assert.equal((await client.getCheckpoint(file))?.mtimeMs, 2)
    assert.equal(client.diagnostics().failedSessions, 0)
    await client.close()
  }))
  it('hard owner-process death leaves a diagnosed orphan that reopening never deletes', async () => scratch(async directory => {
    const dbPath = join(directory, 'parent-crash.db')
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/fts-orphan-process.js', import.meta.url)), dbPath], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let errors = ''
    child.stdout.on('data', value => { output += String(value) })
    child.stderr.on('data', value => { errors += String(value) })
    await new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Orphan fixture timed out')) }, 15000)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('exit', () => { clearTimeout(timer); accept() })
    })
    assert.ok(output.trim(), errors)
    const evidence = JSON.parse(output.trim()) as { pid: number; path: string; batch: string }
    let report = await inspectFtsSpools(dbPath)
    const deadline=Date.now()+2000
    while(report.entries.find(entry=>entry.path===evidence.path)?.ownerState!=='dead' && Date.now()<deadline){
      await new Promise<void>(accept=>setTimeout(accept,25))
      report=await inspectFtsSpools(dbPath)
    }
    assert.equal(report.entries.find(entry => entry.path === evidence.path)?.ownerState, 'dead')
    assert.equal(report.entries.find(entry => entry.path === evidence.path)?.ownerPid, evidence.pid)
    const size = (await fs.stat(evidence.batch)).size
    const client = await createFtsClient(dbPath)
    assert.ok(client)
    assert.ok((await client.health()).orphanSpoolCount >= 1)
    assert.equal((await fs.stat(evidence.batch)).size, size)
    await client.close()
    assert.equal((await fs.stat(evidence.batch)).size, size)
    console.log('Read-only orphan evidence', JSON.stringify(report))
  }))
})
