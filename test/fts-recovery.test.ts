/** S2: atomic snapshots, committed checkpoints, retries, close, and process contention. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FTS_PARSER_VERSION, SessionFts } from '../src/fts.js'
import type { FtsMessageRow, FtsSourceFingerprint, SyncSessionRequest } from '../src/fts.js'
import type { SessionMeta } from '../src/core.js'

const file = '/isolated/session.v3.jsonl.zstd'
const metadata = (title = 'old-title'): SessionMeta => ({
  file, id: 'isolated', workspace: '/test', title, agentPreset: 'fake',
  createdAt: 1, lastTime: 10, size: 128, mtimeMs: 10, ctimeMs: 10,
  indexedBytes: 128, indexedSeq: 0, counts: {}, toolNames: [], toolCallCounts: {},
  firstUserText: '', lastAssistantText: '',
})
const source = (version = 1): FtsSourceFingerprint => ({
  file, sessionId: 'isolated', size: version * 128, mtimeMs: version * 10,
  ctimeMs: version * 10, indexedBytes: version * 128, indexedSeq: version - 1, complete: true,
})
const row = (text: string): FtsMessageRow => ({ sessionFile: file, role: 'user', text, toolName: '' })
const request = (version: number, messages: FtsMessageRow[], title?: string): SyncSessionRequest => ({
  meta: metadata(title), sourceFingerprint: source(version), parserVersion: FTS_PARSER_VERSION,
  mode: 'replace', messages,
})

async function withScratch(work: (dir: string) => Promise<void>): Promise<void> {
  const parent = resolve(tmpdir())
  const dir = await mkdtemp(join(parent, 'dsh-fts-recovery-'))
  try { await work(dir) }
  finally {
    assert.equal(dirname(resolve(dir)), parent, 'cleanup target must be our direct scratch directory')
    assert.ok(basename(dir).startsWith('dsh-fts-recovery-'))
    await rm(dir, { recursive: true, force: true })
  }
}

type FaultPoint = 'after-delete' | 'first-insert' | 'middle-insert' | 'commit' | 'remove-meta'
interface Fault { point: FaultPoint; armed: boolean; inserts: number }
function faultDatabase(fault: Fault) {
  return class FaultDatabase {
    private readonly db: DatabaseSync
    constructor(path: string) { this.db = new DatabaseSync(path) }
    exec(sql: string): void {
      if (fault.armed && fault.point === 'commit' && /^COMMIT\b/i.test(sql.trim())) {
        fault.armed = false
        throw new Error('injected S2 commit failure')
      }
      this.db.exec(sql)
    }
    prepare(sql: string) {
      const statement = this.db.prepare(sql)
      return {
        run: (...args: unknown[]) => {
          if (fault.armed && /^INSERT INTO messages\(/i.test(sql.trim())) {
            fault.inserts++
            const ordinal = fault.point === 'middle-insert' ? 2001 : 1
            if ((fault.point === 'first-insert' || fault.point === 'middle-insert') && fault.inserts === ordinal) {
              fault.armed = false
              throw new Error(`injected S2 ${fault.point} failure`)
            }
          }
          const result = statement.run(...args as SQLInputValue[])
          if (fault.armed && ((fault.point === 'after-delete' && /^DELETE FROM messages WHERE/i.test(sql.trim())) ||
            (fault.point === 'remove-meta' && /^DELETE FROM sessions WHERE/i.test(sql.trim())))) {
            fault.armed = false
            throw new Error(`injected S2 ${fault.point} failure`)
          }
          return result
        },
        all: (...args: unknown[]) => statement.all(...args as SQLInputValue[]),
        get: (...args: unknown[]) => statement.get(...args as SQLInputValue[]),
      }
    }
    close(): void { this.db.close() }
  }
}

function waitForMessage(child: ChildProcess, type: string): Promise<void> {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => finish(new Error(`child IPC ${type} timed out`)), 5000)
    const onMessage = (message: unknown) => {
      if (message && typeof message === 'object' && (message as { type?: string }).type === type) finish()
    }
    const onError = (error: Error) => finish(error)
    const onExit = (code: number | null) => finish(new Error(`SQLite lock child exited before ${type}: ${code}`))
    function finish(error?: Error): void {
      clearTimeout(timeout)
      child.off('message', onMessage)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolveMessage()
    }
    child.on('message', onMessage)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function acquireChildLock(dbPath: string): Promise<{ child: ChildProcess; release: () => Promise<void> }> {
  const child = fork(fileURLToPath(new URL('./support/sqlite-lock-child.js', import.meta.url)), [dbPath], {
    execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  try { await waitForMessage(child, 'locked') }
  catch (error) { child.kill(); throw new Error(`${String(error)} ${stderr}`) }
  let released = false
  return { child, release: async () => {
    if (released) return
    released = true
    const exited = new Promise<void>((done, reject) => {
      if (child.exitCode !== null) { done(); return }
      child.once('exit', (code) => code === 0 ? done() : reject(new Error(`lock child exit=${code}: ${stderr}`)))
      child.once('error', reject)
    })
    const response = waitForMessage(child, 'released')
    child.send({ type: 'release' })
    await response
    await exited
  } }
}

describe('S2 FTS 原子提交与恢复', () => {
  for (const point of ['after-delete', 'first-insert', 'middle-insert', 'commit'] as const) {
    it(`${point} 故障保留旧正文/metadata/checkpoint，flush 报错，重试收敛`, async () => withScratch(async dir => {
      const fault: Fault = { point, armed: false, inserts: 0 }
      const fts = new SessionFts(join(dir, 'fts.db'), faultDatabase(fault))
      assert.ok(fts.ok)
      try {
        await fts.syncSession(request(1, [row('oldneedle stable content')]))
        await fts.flush()
        const before = fts.getCheckpoint(file)
        const replacement = point === 'middle-insert'
          ? Array.from({ length: 2105 }, (_, index) => row(`newneedle message ${index}`))
          : [row('newneedle replacement')]
        fault.armed = true
        fault.inserts = 0
        await assert.rejects(fts.syncSession(request(2, replacement, 'new-title')), /injected S2/)
        await assert.rejects(fts.flush(), /injected S2/)
        assert.deepEqual(fts.getCheckpoint(file), before)
        const old = await fts.search('oldneedle', '', 10)
        assert.equal(old.length, 1)
        assert.equal(old[0].title, 'old-title')
        assert.equal((await fts.search('newneedle', '', 10)).length, 0)
        assert.match(fts.health().lastWriteError, /injected S2/)
        assert.equal(fts.health().failedSessions, 1)
        const receipt = await fts.syncSession(request(2, replacement, 'new-title'))
        await fts.flush()
        assert.equal(receipt.checkpoint.messageCount, replacement.length)
        assert.equal(receipt.checkpoint.indexedBytes, 256)
        assert.equal(fts.health().failedSessions, 0)
        assert.equal((await fts.search('oldneedle', '', 10)).length, 0)
        assert.equal((await fts.search('newneedle', '', 1))[0].title, 'new-title')
        const repeat = await fts.syncSession(request(2, replacement, 'new-title'))
        assert.equal(repeat.duplicate, true)
        assert.deepEqual(repeat.checkpoint, receipt.checkpoint)
        assert.equal(fts.health().messages, replacement.length)
      } finally { await fts.close() }
    }))
  }

  it('FTS 已提交而 JSON 尚旧：重启重投 delta 幂等；错误基点不能追加', async () => withScratch(async dir => {
    const dbPath = join(dir, 'fts.db')
    let fts = new SessionFts(dbPath, DatabaseSync)
    try {
      const base = (await fts.syncSession(request(1, [row('oldneedle base')]))).checkpoint
      const delta = { ...request(2, [row('newneedle appended')]), mode: 'append' as const, expectedBase: base }
      const receipt = await fts.syncSession(delta)
      assert.equal(receipt.checkpoint.messageCount, 2)
      await fts.close()
      fts = new SessionFts(dbPath, DatabaseSync)
      assert.deepEqual(fts.getCheckpoint(file), receipt.checkpoint)
      const repeat = await fts.syncSession(delta)
      assert.equal(repeat.duplicate, true)
      assert.equal(fts.health().messages, 2)
      assert.equal((await fts.search('newneedle', '', 10)).length, 1)
      await assert.rejects(fts.syncSession({ ...request(3, [row('wrongneedle')]), mode: 'append', expectedBase: base }), /delta base mismatch/i)
      await assert.rejects(fts.flush(), /delta base mismatch/i)
      assert.equal(fts.health().messages, 2)
      assert.deepEqual(fts.getCheckpoint(file), receipt.checkpoint)
      assert.equal((await fts.search('wrongneedle', '', 10)).length, 0)
    } finally { await fts.close() }
  }))

  it('FTS 删除失败保留孤儿标记，重启可发现并重试清理', async () => withScratch(async dir => {
    const dbPath = join(dir, 'fts.db')
    const fault: Fault = { point: 'remove-meta', armed: false, inserts: 0 }
    let fts = new SessionFts(dbPath, faultDatabase(fault))
    try {
      await fts.syncSession(request(1, [row('oldneedle retained orphan')]))
      const checkpoint = fts.getCheckpoint(file)
      fault.armed = true
      await assert.rejects(fts.removeSession(file), /injected S2/)
      await assert.rejects(fts.flush(), /injected S2/)
      assert.deepEqual(fts.getCheckpoint(file), checkpoint)
      assert.equal((await fts.search('oldneedle', '', 10)).length, 1)
      await fts.close()
      fts = new SessionFts(dbPath, DatabaseSync)
      assert.deepEqual(fts.listSessionFiles(), [file])
      await fts.removeSession(file)
      await fts.flush()
      assert.deepEqual(fts.listSessionFiles(), [])
      assert.equal(fts.getCheckpoint(file), null)
      assert.equal(fts.health().messages, 0)
    } finally { await fts.close() }
  }))

  it('append rejects parser-version mismatch and regressing committed progress without changing the snapshot', async () => withScratch(async dir => {
    const fts = new SessionFts(join(dir, 'fts.db'), DatabaseSync)
    try {
      const base = (await fts.syncSession(request(2, [row('oldneedle')]))).checkpoint
      for (const invalid of [
        { ...request(3, [row('badneedle')]), mode: 'append' as const, expectedBase: { ...base, parserVersion: 'obsolete' } },
        { ...request(1, [row('badneedle')]), mode: 'append' as const, expectedBase: base },
      ]) {
        await assert.rejects(fts.syncSession(invalid), /delta base mismatch/i)
        await assert.rejects(fts.flush(), /delta base mismatch/i)
        assert.deepEqual(fts.getCheckpoint(file), base)
        assert.equal(fts.health().messages, 1)
        assert.equal((await fts.search('oldneedle', '', 10)).length, 1)
      }
    } finally { await fts.close() }
  }))

  it('会话数量相等但正文缺失需要回填；已提交空会话及坏会话不反复回填', async () => withScratch(async dir => {
    const dbPath = join(dir, 'fts.db')
    const fts = new SessionFts(dbPath, DatabaseSync)
    try {
      await fts.syncSession(request(1, [row('oldneedle expected')]))
      assert.equal(fts.needsSync(metadata()), false)
      const damage = new DatabaseSync(dbPath)
      try { damage.prepare('DELETE FROM messages WHERE session_file = ?').run(file) }
      finally { damage.close() }
      assert.equal(fts.sessionCount(), 1)
      assert.equal(fts.needsSync(metadata()), true)
      const restored = await fts.syncSession(request(1, [row('oldneedle expected')]))
      assert.equal(restored.duplicate, false)
      assert.equal(fts.needsSync(metadata()), false)
      assert.equal((await fts.search('oldneedle', '', 10)).length, 1)
      await fts.syncSession(request(2, []))
      const emptyMeta = { ...metadata(), size: 256, mtimeMs: 20, ctimeMs: 20, indexedBytes: 256, indexedSeq: 1 }
      assert.equal(fts.needsSync(emptyMeta), false)
      assert.equal(fts.needsSync({ ...metadata(), unindexable: true }), false)
      assert.equal(fts.needsSync({ ...metadata(), detailMissing: true }), false)
    } finally { await fts.close() }
  }))

  it('close 停止接单并排空已接受写入；所有 Promise settle 后可重开数据库', async () => withScratch(async dir => {
    const dbPath = join(dir, 'fts.db')
    const fts = new SessionFts(dbPath, DatabaseSync)
    const write = fts.syncSession(request(1, Array.from({ length: 2105 }, (_, index) => row(`queuedneedle ${index}`))))
    const closed = fts.close()
    assert.equal(fts.health().acceptingWrites, false)
    const late = assert.rejects(fts.syncSession(request(2, [row('lateneedle')])), /closed|unavailable/i)
    const receipt = await write
    await Promise.all([closed, late])
    await assert.rejects(fts.flush(), /closed|unavailable/i)
    assert.equal(fts.health().pendingWrites, 0)
    const reopened = new SessionFts(dbPath, DatabaseSync)
    try {
      assert.ok(reopened.ok)
      assert.deepEqual(reopened.getCheckpoint(file), receipt.checkpoint)
      assert.equal(reopened.health().messages, 2105)
      assert.equal((await reopened.search('lateneedle', '', 10)).length, 0)
    } finally { await reopened.close() }
  }))

  it('flush 仅报告调用边界前的写失败，后续失败仍由后续 flush 报告', async () => withScratch(async dir => {
    const fault: Fault = { point: 'first-insert', armed: false, inserts: 0 }
    const fts = new SessionFts(join(dir, 'fts.db'), faultDatabase(fault))
    try {
      await fts.syncSession(request(1, [row('oldneedle')]))
      const beforeFailure = fts.flush()
      fault.armed = true
      const failure = assert.rejects(fts.syncSession(request(2, [row('newneedle')])), /injected S2/)
      await beforeFailure
      await failure
      await assert.rejects(fts.flush(), /injected S2/)
      await fts.flush()
      assert.equal((await fts.search('oldneedle', '', 10)).length, 1)
    } finally { await fts.close() }
  }))

  it('同一写边界的并发 flush 都报告失败，后续 flush 可在消费后成功', async () => withScratch(async dir => {
    const fault: Fault = { point: 'first-insert', armed: false, inserts: 0 }
    const fts = new SessionFts(join(dir, 'fts.db'), faultDatabase(fault))
    try {
      await fts.syncSession(request(1, [row('oldneedle')]))
      fault.armed = true
      const write = fts.syncSession(request(2, [row('newneedle')]))
      const first = fts.flush()
      const second = fts.flush()
      await Promise.all([
        assert.rejects(write, /injected S2/),
        assert.rejects(first, /injected S2/),
        assert.rejects(second, /injected S2/),
      ])
      await fts.flush()
      assert.equal((await fts.search('oldneedle', '', 10)).length, 1)
    } finally { await fts.close() }
  }))
})

describe('S2 SQLite 独立进程锁竞争', () => {
  it('持锁子进程释放后，等待的写入成功提交且未阻塞计时器', async () => withScratch(async dir => {
    const dbPath = join(dir, 'fts.db')
    const fts = new SessionFts(dbPath, DatabaseSync, { busyTimeoutMs: 1000 })
    await fts.syncSession(request(1, [row('oldneedle')]))
    const holder = await acquireChildLock(dbPath)
    assert.notEqual(holder.child.pid, process.pid)
    let ticks = 0
    const heartbeat = setInterval(() => { ticks++ }, 10)
    let release: Promise<void> | undefined
    const releaseTimer = setTimeout(() => { release = holder.release() }, 100)
    try {
      const result = await fts.syncSession(request(2, [row('newneedle after release')]))
      await release
      assert.equal(result.checkpoint.indexedBytes, 256)
      assert.ok(ticks >= 3, `busy retry must yield; heartbeat ticks=${ticks}`)
      assert.equal((await fts.search('newneedle', '', 10)).length, 1)
    } finally {
      clearTimeout(releaseTimer)
      clearInterval(heartbeat)
      await holder.release()
      await fts.close()
    }
  }))

  it('持锁超过等待上限明确失败，旧快照保留；释放后重试成功', async () => withScratch(async dir => {
    const dbPath = join(dir, 'fts.db')
    const fts = new SessionFts(dbPath, DatabaseSync, { busyTimeoutMs: 200 })
    await fts.syncSession(request(1, [row('oldneedle')]))
    const checkpoint = fts.getCheckpoint(file)
    const holder = await acquireChildLock(dbPath)
    let ticks = 0
    const heartbeat = setInterval(() => { ticks++ }, 10)
    const started = Date.now()
    try {
      await assert.rejects(fts.syncSession(request(2, [row('newneedle')])), /SQLITE_BUSY|locked/i)
      const elapsed = Date.now() - started
      assert.ok(elapsed < 3000, `bounded lock wait took ${elapsed}ms`)
      assert.ok(ticks >= 3, `busy retry must yield; heartbeat ticks=${ticks}`)
      await assert.rejects(fts.flush(), /SQLITE_BUSY|locked/i)
      assert.deepEqual(fts.getCheckpoint(file), checkpoint)
      assert.equal((await fts.search('oldneedle', '', 10)).length, 1)
      assert.match(fts.health().lastWriteError, /SQLITE_BUSY|locked/i)
      await holder.release()
      await fts.syncSession(request(2, [row('newneedle')]))
      await fts.flush()
      assert.equal((await fts.search('newneedle', '', 10)).length, 1)
      assert.equal(fts.health().failedSessions, 0)
    } finally {
      clearInterval(heartbeat)
      await holder.release()
      await fts.close()
    }
  }))
})
