/** S2 startup recovery and lifecycle through apply, with isolated injected FTS. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { apply } from '../src/index.js'
import type { PluginDependencies } from '../src/index.js'
import { loadIndex, saveIndex } from '../src/core.js'
import type { SessionMeta } from '../src/core.js'
import { SessionIndexBuilder } from '../src/session-index-builder.js'
import { checkpointOf, FTS_PARSER_VERSION, SessionFts } from '../src/fts.js'
import type { FtsMessageRow, SyncReceipt, SyncSessionRequest } from '../src/fts.js'
import { modernJsonl, modernUser } from './support/modern-log.js'

const pause = (ms: number) => new Promise<void>(resolvePause => setTimeout(resolvePause, ms))
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string, timeout = 8000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await predicate()) return
    await pause(20)
  }
  throw new Error(`S2 waitFor timeout: ${label}`)
}

interface Tool { execute(args: Record<string, unknown>): Promise<Record<string, any>> }
interface Runtime { tools: Record<string, Tool>; dispose(): Promise<void> }
interface Fixture {
  root: string
  sessionsRoot: string
  dataDir: string
  indexFile: string
  dbPath: string
  file: string
  rows: Map<string, FtsMessageRow[]>
  instances: TrackedFts[]
  logs: string[]
  runtimes: Runtime[]
}
class TrackedFts extends SessionFts {
  syncCalls = 0
  removeCalls = 0
  override syncSession(request: SyncSessionRequest): Promise<SyncReceipt> {
    this.syncCalls++
    return super.syncSession(request)
  }
  override removeSession(file: string): Promise<void> {
    this.removeCalls++
    return super.removeSession(file)
  }
}

interface Fault { failInserts: boolean; failDeletes: boolean; failMaintenance?: boolean }
function faultDatabase(fault: Fault) {
  return class FaultDatabase {
    private readonly db: DatabaseSync
    constructor(path: string) { this.db = new DatabaseSync(path) }
    exec(sql: string): void {
      if (fault.failMaintenance && /chunks_fts.*optimize/i.test(sql)) {
        throw new Error('injected startup FTS maintenance failure')
      }
      this.db.exec(sql)
    }
    prepare(sql: string) {
      const statement = this.db.prepare(sql)
      return {
        run: (...args: unknown[]) => {
          if ((fault.failInserts && /^INSERT INTO messages\(/i.test(sql.trim())) ||
            (fault.failDeletes && /^DELETE FROM sessions WHERE/i.test(sql.trim()))) {
            throw new Error('injected startup FTS sync failure')
          }
          return statement.run(...args as SQLInputValue[])
        },
        all: (...args: unknown[]) => statement.all(...args as SQLInputValue[]),
        get: (...args: unknown[]) => statement.get(...args as SQLInputValue[]),
      }
    }
    close(): void { this.db.close() }
  }
}

async function writeSession(env: Fixture, texts: string[]): Promise<void> {
  const jsonl = modernJsonl({
    id: 's', createdAt: 100, cwd: '/isolated', version: 3,
    events: texts.map((text, index) => modernUser(text, `u-${index}`, 101 + index)),
  })
  await writeFile(env.file, zstdCompressSync(Buffer.from(jsonl.join('\n') + '\n')))
}

async function seedJson(env: Fixture): Promise<SessionMeta[]> {
  const builder = new SessionIndexBuilder({ root: env.sessionsRoot, indexFile: env.indexFile, poolSize: 1 })
  try {
    const report = await builder.build({
      force: true, retentionDays: 0, collectMessages: true,
      onSessionParsed: (_file, meta, messages) => { env.rows.set(meta.file, messages) },
    })
    assert.equal(report.status, 'completed', JSON.stringify(report))
    assert.ok(report.fullParsed > 0, `seed must parse its fixture: ${JSON.stringify(report)}`)
    const index = loadIndex(env.indexFile)
    assert.ok(index)
    return index.sessions
  } finally { builder.dispose() }
}

async function seedFts(env: Fixture, metas: SessionMeta[], messages = true): Promise<void> {
  const fts = new SessionFts(env.dbPath, DatabaseSync)
  assert.ok(fts.ok)
  try {
    for (const meta of metas) {
      if (messages) await fts.syncSession({
        meta, sourceFingerprint: checkpointOf(meta), parserVersion: FTS_PARSER_VERSION,
        mode: 'replace', messages: env.rows.get(meta.file) ?? [],
      })
      else await fts.upsertSession(meta)
    }
    await fts.markPruned(0)
    await fts.flush()
  } finally { await fts.close() }
}

function start(env: Fixture, createFts?: PluginDependencies['createSessionFts']): Runtime {
  const tools: Record<string, Tool> = {}
  const cleanups: Array<() => unknown> = []
  const ctx = {
    logger: () => ({ info: (message: string) => env.logs.push(message), warn() {}, error() {} }),
    tools: { register(tool: { name: string }) { tools[tool.name] = tool as unknown as Tool } },
    effect(effect: () => unknown) {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => unknown)
    },
  }
  Object.defineProperty(ctx, 'llm', { get() { throw new Error('S2 must never inspect or call a real LLM') } })
  apply(ctx as never, {
    sessionsRoot: env.sessionsRoot, dataDir: env.dataDir, indexFile: env.indexFile,
    maxHits: 10, maxSnippetsPerSession: 3,
    retentionDays: 0, ftsEnabled: true, llmSummaryEnabled: false,
  }, {
    createSessionWatcher: () => ({ ok: true, close() {} }),
    createSessionFts: createFts ?? (async path => {
      const fts = new TrackedFts(path, DatabaseSync)
      env.instances.push(fts)
      return fts
    }),
  })
  let disposal: Promise<void> | undefined
  const runtime = { tools, dispose() {
    return disposal ??= Promise.all(cleanups.reverse().map(cleanup => cleanup())).then(() => {})
  } }
  env.runtimes.push(runtime)
  return runtime
}

async function withFixture(work: (env: Fixture) => Promise<void>): Promise<void> {
  const parent = resolve(tmpdir())
  const root = await mkdtemp(join(parent, 'dsh-index-fts-recovery-'))
  const sessionsRoot = join(root, 'home', 'sessions')
  const dataDir = join(root, 'data')
  const file = join(sessionsRoot, 's', 'session.v3.jsonl.zstd')
  await mkdir(dirname(file), { recursive: true })
  await mkdir(dataDir, { recursive: true })
  const env: Fixture = {
    root, sessionsRoot, dataDir, indexFile: join(dataDir, 'index.json'),
    dbPath: join(dataDir, 'fts.db'), file, rows: new Map(), instances: [], logs: [], runtimes: [],
  }
  try { await work(env) }
  finally {
    for (const runtime of env.runtimes) await runtime.dispose()
    for (const fts of env.instances) await fts.close().catch(() => {})
    assert.equal(dirname(resolve(root)), parent)
    assert.ok(basename(root).startsWith('dsh-index-fts-recovery-'))
    await rm(root, { recursive: true, force: true })
  }
}

describe('S2 apply 启动 FTS 恢复', () => {
  it('启动不执行重型维护，仍恢复 JSON 领先的正文与 checkpoint', async () => withFixture(async env => {
    await writeSession(env, ['oldneedle history'])
    await seedFts(env, await seedJson(env))
    await writeSession(env, ['oldneedle history', 'newneedle after maintenance failure'])
    const latest = (await seedJson(env))[0]
    const fault: Fault = { failInserts: false, failDeletes: false, failMaintenance: true }
    start(env, async path => {
      const fts = new TrackedFts(path, faultDatabase(fault))
      env.instances.push(fts)
      return fts
    })
    await waitFor(() => env.instances[0]?.getCheckpoint(env.file)?.size === latest.size &&
      !env.instances[0].needsSync(latest), 'reconciliation after maintenance failure')
    assert.equal((await env.instances[0].search('newneedle', '', 10)).length, 1)
    assert.equal(env.instances[0].health().messages, 2)
    assert.ok(!env.logs.some(message => /maintenance failed.*injected startup FTS maintenance/.test(message)))
  }))

  it('JSON 指纹/游标领先 FTS 而会话数相等，启动自动补齐当前完整正文', async () => withFixture(async env => {
    await writeSession(env, ['oldneedle source history'])
    const old = await seedJson(env)
    await seedFts(env, old)
    await writeSession(env, ['oldneedle source history', 'newneedle latest source'])
    const latest = (await seedJson(env))[0]
    const runtime = start(env)
    await waitFor(() => env.instances.length === 1, 'FTS initialized')
    const fts = env.instances[0]
    await waitFor(() => fts.getCheckpoint(env.file)?.size === latest.size && !fts.needsSync(latest), 'checkpoint caught up')
    assert.equal(fts.sessionCount(), 1)
    assert.equal(fts.health().messages, 2)
    assert.equal((await fts.search('newneedle', '', 10)).length, 1)
    const status = await runtime.tools.session_index_status.execute({})
    assert.equal(status.ftsHealth.pendingWrites, 0)
    assert.equal(status.ftsHealth.failedSessions, 0)
    assert.equal(loadIndex(env.indexFile)!.sessions[0].ftsDirty, undefined)
  }))

  it('会话数相等但 FTS 无正文/无 checkpoint，启动仍自动回填', async () => withFixture(async env => {
    await writeSession(env, ['needle missing database body'])
    const metas = await seedJson(env)
    await seedFts(env, metas, false)
    start(env)
    await waitFor(() => env.instances[0]?.getCheckpoint(env.file)?.messageCount === 1, 'missing body backfill')
    assert.equal(env.instances[0].sessionCount(), 1)
    assert.equal((await env.instances[0].search('needle', '', 10)).length, 1)
  }))

  it('INSERT 失败标记 dirty/降级与健康错误，恢复写入后后台重试成功', async () => withFixture(async env => {
    await writeSession(env, ['needle retryable source'])
    const metas = await seedJson(env)
    await seedFts(env, metas, false)
    const fault: Fault = { failInserts: true, failDeletes: false }
    const runtime = start(env, async path => {
      const fts = new TrackedFts(path, faultDatabase(fault))
      env.instances.push(fts)
      return fts
    })
    await waitFor(() => env.instances[0]?.health().failedSessions === 1 &&
      loadIndex(env.indexFile)?.sessions[0]?.ftsDirty === true, 'failure visible with JSON dirty')
    await waitFor(async ()=>(await runtime.tools.session_index_status.execute({})).lastReport?.status==='degraded','failed build report published')
    const failed = await runtime.tools.session_index_status.execute({})
    assert.match(failed.ftsHealth.lastWriteError, /injected startup FTS/)
    assert.equal(failed.lastReport.status, 'degraded')
    assert.equal(failed.lastReport.ftsFailed, 1)
    assert.equal(env.instances[0].getCheckpoint(env.file), null)
    fault.failInserts = false
    await waitFor(() => env.instances[0].getCheckpoint(env.file)?.messageCount === 1 &&
      !loadIndex(env.indexFile)?.sessions[0]?.ftsDirty, 'automatic successful retry')
    assert.equal((await env.instances[0].search('needle', '', 10)).length, 1)
    assert.equal(env.instances[0].health().failedSessions, 0)
  }))

  it('JSON 删除已提交但 FTS 删除失败，重启识别孤儿并继续清理', async () => withFixture(async env => {
    await writeSession(env, ['needle orphan source'])
    await seedFts(env, await seedJson(env))
    const fault: Fault = { failInserts: false, failDeletes: false }
    const runtime = start(env, async path => {
      const fts = new TrackedFts(path, faultDatabase(fault))
      env.instances.push(fts)
      return fts
    })
    await waitFor(() => env.instances[0]?.health().pendingWrites === 0, 'initial startup idle')
    fault.failDeletes = true
    assert.equal(dirname(resolve(env.file)), join(env.sessionsRoot, 's'))
    await rm(env.file)
    await runtime.tools.session_index_list.execute({ refresh: true, limit: 10 })
    assert.equal(loadIndex(env.indexFile)!.sessions.length, 0)
    assert.deepEqual(env.instances[0].listSessionFiles(), [env.file])
    assert.equal(env.instances[0].health().failedSessions, 1)
    runtime.dispose()
    await env.instances[0].close().catch(() => {})
    fault.failDeletes = false
    start(env)
    await waitFor(() => env.instances.length === 2 && env.instances[1].listSessionFiles().length === 0, 'restart orphan cleanup')
    assert.equal(env.instances[1].health().messages, 0)
    assert.equal(env.instances[1].getCheckpoint(env.file), null)
    assert.ok(env.instances[1].removeCalls >= 1)
  }))

  it('已提交空会话与已有 unindexable 坏条目不会触发回填循环', async () => withFixture(async env => {
    await writeSession(env, [])
    const [empty] = await seedJson(env)
    await seedFts(env, [empty])
    const badFile = join(env.sessionsRoot, 'bad', 'session.v3.jsonl.zstd')
    await mkdir(dirname(badFile), { recursive: true })
    await writeFile(badFile, Buffer.from('corrupt synthetic session'))
    const fingerprint = await stat(badFile)
    saveIndex(env.indexFile, {
      version: 1, root: env.sessionsRoot, updatedAt: Date.now(), sessions: [empty, {
        ...empty, id: 'bad', file: badFile, size: fingerprint.size,
        mtimeMs: fingerprint.mtimeMs, ctimeMs: fingerprint.ctimeMs,
        unindexable: true, error: 'synthetic pre-existing incompatibility marker',
      }],
    })
    start(env)
    await waitFor(() => env.instances[0]?.health().pendingWrites === 0, 'startup idle')
    await pause(1250)
    const fts = env.instances[0]
    assert.equal(fts.syncCalls, 0)
    assert.equal(fts.getCheckpoint(env.file)?.messageCount, 0)
    assert.equal(fts.sessionCount(), 1)
    assert.equal(fts.listSessionFiles().includes(badFile), false)
    assert.equal(env.logs.filter(message => /backfill|still behind/i.test(message)).length, 0)
  }))
})

describe('S2 apply 卸载生命周期', () => {
  it('dispose 期间已接受的 FTS 队列排空，停止新写入且无后台再建库', async () => withFixture(async env => {
    await writeSession(env, ['needle initial source'])
    const [meta] = await seedJson(env)
    await seedFts(env, [meta])
    const runtime = start(env)
    await waitFor(() => env.instances[0]?.health().pendingWrites === 0, 'initial startup idle')
    const fts = env.instances[0]
    const queued = fts.syncSession({
      meta, parserVersion: FTS_PARSER_VERSION, mode: 'replace',
      sourceFingerprint: { ...checkpointOf(meta), size: meta.size + 1, indexedBytes: meta.size + 1 },
      messages: [{ sessionFile: env.file, role: 'user', text: 'queuedneedle before unload', toolName: '' }],
    })
    runtime.dispose()
    assert.equal(fts.health().acceptingWrites, false)
    await queued
    await fts.close()
    assert.equal(fts.health().pendingWrites, 0)
    await assert.rejects(fts.syncSession({ meta, parserVersion: FTS_PARSER_VERSION, mode: 'replace',
      sourceFingerprint: checkpointOf(meta), messages: [] }), /closed|unavailable/i)
    await assert.rejects(fts.flush(), /closed|unavailable/i)
    const syncCalls = fts.syncCalls
    await pause(100)
    assert.equal(fts.syncCalls, syncCalls)
    const reopened = new SessionFts(env.dbPath, DatabaseSync)
    try { assert.equal((await reopened.search('queuedneedle', '', 10)).length, 1) }
    finally { await reopened.close() }
  }))

  it('dispose 后延迟 FTS 工厂返回的连接立即关闭，启动写入不会复活', async () => withFixture(async env => {
    await writeSession(env, ['needle delayed source'])
    await seedJson(env)
    let releaseFactory!: () => void
    const factoryBarrier = new Promise<void>(release => { releaseFactory = release })
    let factoryCalled = false
    const runtime = start(env, async path => {
      factoryCalled = true
      await factoryBarrier
      const fts = new TrackedFts(path, DatabaseSync)
      env.instances.push(fts)
      return fts
    })
    assert.equal(factoryCalled, true)
    const disposing = runtime.dispose()
    let disposalFinished = false
    void disposing.then(() => { disposalFinished = true })
    await pause(10)
    assert.equal(disposalFinished, false, '卸载应等待仍挂起的工厂及迟到连接关闭')
    releaseFactory()
    await disposing
    await waitFor(() => env.instances.length === 1 && !env.instances[0].health().acceptingWrites, 'late connection closed')
    await env.instances[0].close()
    assert.equal(env.instances[0].syncCalls, 0)
    assert.equal(env.instances[0].health().pendingWrites, 0)
    assert.equal(env.instances[0].getCheckpoint(env.file), null)
  }))
})
