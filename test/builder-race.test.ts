import { it } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { SessionIndexBuilder, type BuildOptions } from '../src/session-index-builder.js'
import { createSessionFts, checkpointOf, FTS_PARSER_VERSION } from '../src/fts.js'
import { loadIndex } from '../src/core.js'
import { alpha3Assistant, alpha3EventJson, alpha3Jsonl, alpha3User } from './support/alpha3-log.js'

it('two deterministic compressed-read races retain committed metadata and searchable FTS, counting both attempts', async () => {
  assert.ok(process.env.DSH_HOME, 'DSH_HOME must be isolated explicitly')
  assert.ok(process.env.TEMP, 'TEMP must be isolated explicitly')
  assert.ok(process.env.TMP, 'TMP must be isolated explicitly')
  const validation = resolve('validation', 'builder-race')
  await mkdir(validation, { recursive: true })
  const root = await mkdtemp(join(validation, 'run-'))
  const sessions = join(root, 'sessions')
  const sessionDir = join(sessions, 'racing')
  await mkdir(sessionDir, { recursive: true })
  const file = join(sessionDir, 'session.jsonl.zstd')
  const indexFile = join(root, 'index.json')
  await writeFile(file, zstdCompressSync(Buffer.from(alpha3Jsonl({
    id: 'racing-session', createdAt: 100,
    events: [alpha3User('committed oldneedle remains searchable', 'original')],
  }).join('\n') + '\n')))
  const builder = new SessionIndexBuilder({ root: sessions, indexFile, poolSize: 1 })
  const fts = await createSessionFts(join(root, 'fts.db'))
  assert.ok(fts)
  let removals = 0
  const options: BuildOptions = {
    collectMessages: true, retentionDays: 0, deltaEnabled: false,
    onSessionParsed: (_file, meta, messages) => fts.syncSession({
      meta, messages, sourceFingerprint: checkpointOf(meta), parserVersion: FTS_PARSER_VERSION, mode: 'replace',
    }),
    onSessionRemoved: async removed => { removals++; await fts.removeSession(removed) },
    flushFts: () => fts.flush(),
  }
  try {
    assert.equal((await builder.build(options)).status, 'completed')
    const before = loadIndex(indexFile)!.sessions[0]
    const checkpoint = await fts.getCheckpoint(file)
    assert.equal((await fts.search('oldneedle', '', 10)).length, 1)
    await appendFile(file, zstdCompressSync(Buffer.from(alpha3EventJson(alpha3Assistant('new append', 'new'), 1, 100) + '\n')))
    let attempts = 0
    const original = builder.pool.run.bind(builder.pool)
    builder.pool.run = (async (spec, signal) => {
      if (spec.mode !== 'full') return original(spec, signal)
      attempts++
      return { ok: false, aborted: false, raced: true, error: 'injected NativeZstdRaceError', stats: { readBytes: 4, decodedBytes: 0 } }
    }) as typeof builder.pool.run
    const report = await builder.build(options)
    assert.equal(attempts, 2)
    assert.equal(report.raced, 1)
    assert.equal(report.failed, 0)
    assert.equal((report as typeof report & { readBytes?: number }).readBytes, 8)
    const after = loadIndex(indexFile)!.sessions[0]
    assert.equal(after.raced, true)
    assert.equal(after.unindexable, undefined)
    assert.equal(after.indexedBytes, before.indexedBytes)
    assert.equal(after.firstUserText, before.firstUserText)
    assert.equal(removals, 0, 'transient source races must not remove the committed FTS snapshot')
    assert.deepEqual(await fts.getCheckpoint(file), checkpoint)
    assert.equal((await fts.search('oldneedle', '', 10)).length, 1)
  } finally {
    builder.dispose()
    await fts.close()
    assert.ok(root.startsWith(validation))
    await rm(root, { recursive: true, force: true })
  }
})
