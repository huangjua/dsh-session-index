import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { SessionIndexBuilder } from '../src/session-index-builder.js'
import type { BuildOptions } from '../src/session-index-builder.js'
import { SessionFts, checkpointOf, FTS_PARSER_VERSION } from '../src/fts.js'
import { loadIndex } from '../src/core.js'
import { modernJsonl, modernUser, modernAssistant, modernEventJson } from './support/modern-log.js'

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function sandbox(work: (env: {
  file: string; indexFile: string; builder: SessionIndexBuilder; fts: SessionFts;
  append: () => Promise<void>; armJsonFailure: () => void
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'builder-fts-sync-'))
  const sessions = join(root, 'sessions')
  const file = join(sessions, 's', 'session.v3.jsonl.zstd')
  const indexFile = join(root, 'index.json')
  await mkdir(join(sessions, 's'), { recursive: true })
  await writeFile(file, zstdCompressSync(Buffer.from(modernJsonl({ id: 's', createdAt: 100,
    events: [modernUser('oldneedle', 'u')] }).join('\n') + '\n')))
  let failJson = false
  const builder = new SessionIndexBuilder({ root: sessions, indexFile, poolSize: 1,
    testHooks: { onCommit: () => { if (failJson) { failJson = false; throw new Error('injected JSON commit failure') } } } })
  const fts = new SessionFts(join(root, 'fts.db'), DatabaseSync)
  try {
    await work({ file, indexFile, builder, fts,
      append: () => appendFile(file, zstdCompressSync(Buffer.from(modernEventJson(modernAssistant('newneedle', 'a'), 1, 100) + '\n'))),
      armJsonFailure: () => { failJson = true } })
  } finally {
    builder.dispose()
    await fts.close()
    await rm(root, { recursive: true, force: true })
  }
}

function options(fts: SessionFts): BuildOptions {
  return { collectMessages: true, retentionDays: 0,
    needsFtsSync: meta => fts.needsSync(meta), canAppendFts: meta => !fts.needsSync(meta),
    onSessionParsed: (_file, meta, messages, append, previous) => fts.syncSession({ meta,
      sourceFingerprint: checkpointOf(meta), parserVersion: FTS_PARSER_VERSION,
      mode: append ? 'append' : 'replace', messages,
      expectedBase: append && previous ? fts.getCheckpoint(previous.file) ?? undefined : undefined }),
    onSessionRemoved: file => fts.removeSession(file), flushFts: () => fts.flush() }
}

it('S2 builder awaits async FTS receipt before releasing the run marker or reporting completion', async () => sandbox(async env => {
  const entered = barrier()
  const release = barrier()
  const opts = options(env.fts)
  const callback = opts.onSessionParsed!
  opts.onSessionParsed = async (...args) => {
    entered.resolve()
    await release.promise
    return callback(...args)
  }
  let completed = false
  const building = env.builder.build(opts).then(report => { completed = true; return report })
  try {
    await entered.promise
    assert.equal(completed, false)
    assert.equal(existsSync(env.builder.markerFile), true)
    const competing = new SessionIndexBuilder({ root: env.builder.root, indexFile: env.indexFile, poolSize: 1 })
    try { assert.equal((await competing.build()).status, 'skipped') }
    finally { competing.dispose() }
  } finally { release.resolve() }
  const report = await building
  assert.equal(report.status, 'completed')
  assert.equal(report.ftsSynced, 1)
  assert.equal(env.fts.needsSync(loadIndex(env.indexFile)!.sessions[0]), false)
  assert.equal(existsSync(env.builder.markerFile), false)
}))

it('S2 JSON can lead failed FTS; unchanged-file retry performs a full parse from the committed base', async () => sandbox(async env => {
  await env.builder.build(options(env.fts))
  const committed = env.fts.getCheckpoint(env.file)
  await env.append()
  const failed = await env.builder.build({ ...options(env.fts), onSessionParsed: async () => { throw new Error('injected FTS callback failure') } })
  assert.equal(failed.status, 'degraded')
  assert.equal(failed.ftsFailed, 1)
  const parsed = loadIndex(env.indexFile)!.sessions[0]
  assert.equal(parsed.ftsDirty, true)
  assert.ok(parsed.indexedBytes! > committed!.indexedBytes)
  assert.deepEqual(env.fts.getCheckpoint(env.file), committed)
  assert.equal((await env.fts.search('oldneedle', '', 10)).length, 1)
  const retry = await env.builder.build(options(env.fts))
  assert.equal(retry.status, 'completed')
  assert.equal(retry.deltaParsed, 0)
  assert.equal(retry.fullParsed, 1)
  assert.equal(loadIndex(env.indexFile)!.sessions[0].ftsDirty, undefined)
  assert.equal(env.fts.getCheckpoint(env.file)!.messageCount, 2)
  assert.equal((await env.fts.search('newneedle', '', 10)).length, 1)
  assert.equal((await env.builder.build(options(env.fts))).fullParsed, 0)
}))

it('S2 FTS COMMIT followed by JSON failure recovers without duplicate append or checkpoint regression', async () => sandbox(async env => {
  await env.builder.build(options(env.fts))
  const oldJson = loadIndex(env.indexFile)!.sessions[0]
  await env.append()
  env.armJsonFailure()
  const failed = await env.builder.build(options(env.fts))
  assert.equal(failed.status, 'failed')
  assert.match(failed.errors.join('\n'), /JSON commit failure/)
  const committed = env.fts.getCheckpoint(env.file)!
  assert.ok(committed.indexedBytes > oldJson.indexedBytes!)
  assert.equal(loadIndex(env.indexFile)!.sessions[0].indexedBytes, oldJson.indexedBytes)
  const retry = await env.builder.build(options(env.fts))
  assert.equal(retry.status, 'completed')
  assert.equal(retry.deltaParsed, 0)
  assert.deepEqual(env.fts.getCheckpoint(env.file), committed)
  assert.equal(env.fts.health().messages, 2)
  assert.equal(env.fts.needsSync(loadIndex(env.indexFile)!.sessions[0]), false)
}))

it('S2 builder dispose drains the dispatched callback and refuses later builds', async () => sandbox(async env => {
  const entered = barrier()
  const release = barrier()
  const opts = options(env.fts)
  const callback = opts.onSessionParsed!
  opts.onSessionParsed = async (...args) => { entered.resolve(); await release.promise; return callback(...args) }
  const building = env.builder.build(opts)
  await entered.promise
  env.builder.dispose()
  assert.equal((await env.builder.build()).status, 'cancelled')
  release.resolve()
  assert.equal((await building).status, 'cancelled')
  assert.equal(existsSync(env.builder.markerFile), false)
  assert.equal(env.fts.health().pendingWrites, 0)
}))
