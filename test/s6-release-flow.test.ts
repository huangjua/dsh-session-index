import { it } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { alpha3Assistant, alpha3EventJson, alpha3Jsonl, alpha3ToolCall, alpha3User } from './support/alpha3-log.js'

// The identical workflow can exercise compiled source or the final release's worker files.
const runtime = process.env.S6_RELEASE_DIR
const { apply } = await import(runtime
  ? pathToFileURL(join(resolve(runtime), 'lib', 'index.js')).href
  : new URL('../src/index.js', import.meta.url).href) as typeof import('../src/index.js')

function within(root: string, target: string): boolean {
  const part = relative(resolve(root), resolve(target))
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

it('S6 user flow: generations 0–4, cross-chunk/message semantics, bookmarks, natural delta, force, restart, derived-copy rebuild', async () => {
  const validation = resolve('validation')
  for (const name of ['DSH_HOME', 'TEMP', 'TMP', 'DSH_SESSION_INDEX_DATA_DIR', 'DSH_SESSION_INDEX_SESSIONS_ROOT']) {
    assert.ok(process.env[name] && within(validation, process.env[name]!), `${name} must explicitly use isolated validation`)
  }
  const root = await mkdtemp(join(process.env.TEMP!, 's6-release-flow-'))
  assert.ok(within(validation, root))
  const sessionsRoot = join(root, 'sessions'), dataDir = join(root, 'data')
  await mkdir(sessionsRoot, { recursive: true })
  const files: string[] = []
  const long = `headneedle ${'x'.repeat(4070)} boundaryneedle ${'y'.repeat(5100)} tailneedle`
  const timestamp = Date.now()
  for (let generation = 0; generation <= 4; generation++) {
    const id = `s6-generation-${generation}`, file = join(sessionsRoot, id, 'session.jsonl.zstd')
    await mkdir(join(sessionsRoot, id), { recursive: true })
    const lines = alpha3Jsonl({ id, createdAt: timestamp, events: [
      alpha3User('useronlyword', `u-${generation}`), alpha3ToolCall('flow_tool', `call-${generation}`),
      alpha3Assistant(long, `a-${generation}`),
    ] })
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), version: generation, ...(generation >= 2 ? { isSeeded: false } : {}) })
    await writeFile(file, zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
    files.push(file)
  }
  const tools: Record<string, { execute: (args: Record<string, unknown>) => Promise<any> }> = {}
  const cleanup: Array<() => unknown> = []
  const ctx = { logger: () => ({ info() {}, warn() {}, error() {} }),
    tools: { register(tool: any) { tools[tool.name] = tool } },
    effect(fn: () => unknown) { const value = fn(); if (typeof value === 'function') cleanup.push(value as () => unknown) },
  }
  const activate = () => apply(ctx as never, { sessionsRoot, dataDir, indexFile: join(dataDir, 'index.json'),
    ftsEnabled: true, retentionDays: 0, llmSummaryEnabled: false, maxHits: 10, maxSnippetsPerSession: 3 })
  const close = async () => { for (const fn of cleanup.splice(0)) await fn() }
  async function settle(predicate: (value: any) => boolean = () => true): Promise<any> {
    const deadline = Date.now() + 10000
    while (true) {
      const status = await tools.session_index_status.execute({})
      if (status.fts && status.ftsSessions === 5 && !status.active && status.ftsHealth.dirtySessions === 0 && status.ftsHealth.pendingWrites === 0 && predicate(status)) return status
      assert.ok(Date.now() < deadline, 'isolated release workflow must converge')
      await new Promise(accept => setTimeout(accept, 20))
    }
  }
  const anchors = new Map<string, string>()
  async function verifyBookmarks(): Promise<void> {
    const listed = await tools.session_index_bookmark.execute({ action: 'list' })
    assert.equal(listed.bookmarks.length, 5)
    for (const item of listed.bookmarks) {
      assert.equal(item.anchorId, anchors.get(item.sessionId)); assert.equal(item.anchorAvailable, true)
      assert.equal(item.note, 'S6 user note'); assert.equal(item.label, 'S6 preserved')
      const scroll = await tools.session_index_search.execute({ session_id: item.sessionId, anchor_id: item.anchorId, window: 1 })
      const original = scroll.messages.find((row: any) => row.anchorId === item.anchorId)
      assert.equal(original?.text, long)
      assert.equal(scroll.messages[0].role, 'tool', 'previous original message follows source sequence')
    }
  }
  try {
    activate()
    await tools.session_index_list.execute({ refresh: true, limit: 10 }); await settle()
    assert.deepEqual(Object.keys(tools).sort(), ['session_index_bookmark', 'session_index_list', 'session_index_search', 'session_index_status', 'session_summary'])
    for (const query of ['headneedle tailneedle', 'boundaryneedle']) {
      const result = await tools.session_index_search.execute({ mode: 'full', query, filter: { role: 'assistant' }, limit: 10 })
      assert.equal(result.total, 5); assert.equal(result.totalExact, true)
      for (const hit of result.hits) { assert.ok(hit.anchorId); anchors.set(hit.sessionId, hit.anchorId) }
    }
    // AND is per original message: terms in different messages only appear through zero-AND OR fallback.
    const across = await tools.session_index_search.execute({ mode: 'full', query: 'useronlyword tailneedle', limit: 10 })
    assert.equal(across.total, 5)
    assert.ok(across.hits.every((hit: any) => hit.anchorId))
    for (const [sessionId, anchorId] of anchors) {
      await tools.session_index_bookmark.execute({ action: 'add', sessionId, anchorId, label: 'S6 preserved', note: 'S6 user note' })
    }
    await verifyBookmarks()
    await tools.session_summary.execute({ id: 's6-generation-0' })
    const before = await readFile(join(dataDir, 'bookmarks.jsonl'))
    const tail = zstdCompressSync(Buffer.from(alpha3EventJson(alpha3Assistant('naturalappendneedle', 'append-a'), 3, timestamp) + '\n'))
    await appendFile(files[0], tail)
    const delta = await settle(status => status.lastReport?.deltaParsed === 1)
    assert.equal(delta.lastReport.deltaBytes, tail.length, 'natural delta reads only compressed tail')
    assert.equal((await tools.session_index_search.execute({ mode: 'full', query: 'naturalappendneedle' })).hits[0].sessionId, 's6-generation-0')
    await verifyBookmarks()
    await tools.session_index_list.execute({ refresh: true, limit: 10 }); await settle(); await verifyBookmarks()
    await close(); activate(); await settle(); await verifyBookmarks()
    await close()
    // Delete only this test's derived FTS copy after all connections have drained. Keep source, JSON and bookmarks.
    for (const suffix of ['', '-wal', '-shm']) {
      const target = join(dataDir, `fts.db${suffix}`)
      assert.ok(within(root, target) && within(validation, target), 'refuse deletion outside this synthetic fixture')
      await rm(target, { force: true })
    }
    assert.deepEqual(await readFile(join(dataDir, 'bookmarks.jsonl')), before)
    activate(); await settle(); await verifyBookmarks()
    assert.deepEqual(await readFile(join(dataDir, 'bookmarks.jsonl')), before)
    assert.ok((await stat(join(dataDir, 'fts.db'))).size > 0)
  } finally { await close() }
})
