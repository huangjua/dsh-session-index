import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, stat, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { modernJsonl, modernUser } from './support/modern-log.js'
import { scanSessionFiles, saveIndex, loadIndex } from '../src/core.js'
import type { SessionMeta, ScanSessionFilesOptions } from '../src/core.js'
import { SessionIndexBuilder } from '../src/session-index-builder.js'

const meta = (file: string): SessionMeta => ({ file, id: 'old', workspace: '', size: 1, mtimeMs: 1, ctimeMs: 1,
  createdAt: 1, lastTime: 1, title: '', firstUserText: '', lastAssistantText: '', agentPreset: '', counts: {}, toolNames: [], toolCallCounts: {} })

it('S1 #07: missing root, permission failure, subtree failure and stat failure are incomplete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scan-safety-'))
  try {
    const missing = await scanSessionFiles(join(root, 'missing'))
    assert.equal(missing.complete, false)
    assert.match(missing.errors[0], /ENOENT/)
    const denied: ScanSessionFilesOptions['io'] = {
      readdir: (async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }) as typeof readdir, stat,
    }
    assert.match((await scanSessionFiles(root, { io: denied })).errors[0], /EACCES/)
    const sub = join(root, 'sub')
    await mkdir(sub)
    await writeFile(join(sub, 'session.v3.jsonl.zstd'), 'synthetic')
    const subtree: ScanSessionFilesOptions['io'] = {
      readdir: (async (path: string, opts: unknown) => {
        if (path === sub) throw new Error('subtree EIO')
        return readdir(path, opts as { withFileTypes: true })
      }) as typeof readdir, stat,
    }
    const partial = await scanSessionFiles(root, { io: subtree })
    assert.equal(partial.complete, false)
    assert.deepEqual(partial.failedSubtrees, [sub])
    const badStat: ScanSessionFilesOptions['io'] = { readdir, stat: (async () => { throw new Error('stat EIO') }) as typeof stat }
    const failedStat = await scanSessionFiles(root, { io: badStat })
    assert.equal(failedStat.complete, false)
    assert.equal(failedStat.files.length, 0)
    assert.match(failedStat.errors[0], /stat EIO/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('S1 #07: generation selection precedes the session budget; extra sessions mark truncation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scan-cap-'))
  try {
    const dir = join(root, 'a')
    await mkdir(dir)
    for (const name of ['session.jsonl.zstd', 'session.v2.jsonl.zstd', 'session.v4.jsonl.zstd']) await writeFile(join(dir, name), 'synthetic')
    const one = await scanSessionFiles(root, { cap: 1 })
    assert.equal(one.complete, true)
    assert.equal(one.truncated, false)
    assert.equal(one.files[0].file, join(dir, 'session.v4.jsonl.zstd'))
    await mkdir(join(root, 'b'))
    await writeFile(join(root, 'b', 'session.jsonl.zstd'), 'synthetic')
    const capped = await scanSessionFiles(root, { cap: 1 })
    assert.equal(capped.complete, false)
    assert.equal(capped.truncated, true)
    assert.equal(capped.files.length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('S1 #07: incomplete scans preserve absent and expired entries; complete emptiness confirms deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scan-prune-'))
  const sessions = join(root, 'sessions')
  const indexFile = join(root, 'index.json')
  const oldFile = join(sessions, 'old', 'session.jsonl.zstd')
  const builders: SessionIndexBuilder[] = []
  const run = async (scanOptions?: ScanSessionFilesOptions) => {
    const builder = new SessionIndexBuilder({ root: sessions, indexFile, poolSize: 1, testHooks: { scanOptions } })
    builders.push(builder)
    return builder.build({ retentionDays: 1 })
  }
  try {
    saveIndex(indexFile, { version: 1, root: sessions, updatedAt: 0, sessions: [meta(oldFile)] })
    const missing = await run()
    assert.equal(missing.status, 'degraded')
    assert.equal(missing.removed, 0)
    assert.equal(missing.pruned, 0)
    assert.equal(loadIndex(indexFile)!.sessions.length, 1)
    await mkdir(join(sessions, 'old'), { recursive: true })
    await writeFile(oldFile, 'synthetic')
    const capped = await run({ cap: 0 })
    assert.equal(capped.status, 'degraded')
    assert.equal(loadIndex(indexFile)!.sessions.length, 1)
    const io = { readdir, stat: (async () => { throw new Error('EIO') }) as typeof stat }
    const unread = await run({ io })
    assert.equal(unread.status, 'degraded')
    assert.equal(loadIndex(indexFile)!.sessions.length, 1)
    await unlink(oldFile) // Only this test's synthetic file.
    const removed = await run()
    assert.equal(removed.status, 'completed')
    assert.equal(removed.scanComplete, true)
    assert.equal(removed.removed, 1)
    assert.equal(loadIndex(indexFile)!.sessions.length, 0)
  } finally {
    for (const builder of builders) builder.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('S1 #07: partial updates commit confirmed files while retaining the failed subtree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scan-partial-update-'))
  const sessions = join(root, 'sessions')
  const good = join(sessions, 'good')
  const unavailable = join(sessions, 'unavailable')
  const indexFile = join(root, 'index.json')
  await mkdir(good, { recursive: true })
  await mkdir(unavailable)
  const oldFile = join(unavailable, 'session.jsonl.zstd')
  const goodFile = join(good, 'session.v3.jsonl.zstd')
  await writeFile(goodFile, zstdCompressSync(Buffer.from(modernJsonl({ id: 'good', createdAt: 100,
    events: [modernUser('confirmed content', 'u')] }).join('\n') + '\n')))
  saveIndex(indexFile, { version: 1, root: sessions, updatedAt: 0, sessions: [meta(oldFile)] })
  const io = { stat, readdir: (async (path: string, opts: unknown) => {
    if (path === unavailable) throw new Error('injected subtree EIO')
    return readdir(path, opts as { withFileTypes: true })
  }) as typeof readdir }
  const builder = new SessionIndexBuilder({ root: sessions, indexFile, poolSize: 1, testHooks: { scanOptions: { io } } })
  try {
    const report = await builder.build({ retentionDays: 1 })
    assert.equal(report.status, 'degraded')
    assert.equal(report.fullParsed, 1)
    assert.equal(report.removed, 0)
    assert.equal(report.pruned, 0)
    const index = loadIndex(indexFile)!
    assert.equal(index.sessions.length, 2)
    assert.equal(index.sessions.find(session => session.file === goodFile)!.firstUserText, 'confirmed content')
    assert.ok(index.sessions.some(session => session.file === oldFile))
  } finally { builder.dispose(); await rm(root, { recursive: true, force: true }) }
})
