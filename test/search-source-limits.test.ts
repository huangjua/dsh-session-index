import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { apply, DEFAULT_SEARCH_LINE_BYTES, MAX_SEARCH_LINE_BYTES, MAX_SEARCH_DECOMPRESSED_BYTES } from '../src/index.js'
import { alpha3Assistant, alpha3Jsonl, alpha3User, type Alpha3Event } from './support/alpha3-log.js'

interface Tool {
  description: string
  parameters: Record<string, any>
  execute(args: Record<string, unknown>): Promise<any>
  output: { render(args: Record<string, unknown>, value: Record<string, unknown>): { type: string; text: string }[] }
}

async function setup(ftsEnabled: boolean, logs: { id: string; events: Alpha3Event[] }[]) {
  assert.ok(process.env.DSH_HOME, 'DSH_HOME must be isolated explicitly')
  assert.ok(process.env.TEMP, 'TEMP must be isolated explicitly')
  assert.ok(process.env.TMP, 'TMP must be isolated explicitly')
  const validation = resolve('validation', 'search-source-limits')
  await mkdir(validation, { recursive: true })
  const root = await mkdtemp(join(validation, 'run-'))
  const sessionsRoot = join(root, 'sessions'), dataDir = join(root, 'data')
  await mkdir(sessionsRoot, { recursive: true })
  for (const log of logs) {
    const file = join(sessionsRoot, log.id, 'session.jsonl.zstd')
    await mkdir(dirname(file), { recursive: true })
    const lines = alpha3Jsonl({ id: log.id, createdAt: Date.now(), cwd: '/synthetic-limit-test', events: log.events })
    await writeFile(file, zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
  }
  const tools: Record<string, Tool> = {}, cleanups: (() => unknown)[] = []
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    tools: { register(tool: Tool & { name: string }) { tools[tool.name] = tool } },
    effect(callback: () => unknown) { const result = callback(); if (typeof result === 'function') cleanups.push(result as () => unknown) },
  }
  apply(ctx as never, { sessionsRoot, dataDir, indexFile: join(dataDir, 'index.json'), ftsEnabled,
    retentionDays: 0, llmSummaryEnabled: false, maxHits: 10, maxSnippetsPerSession: 3 })
  const close = async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
    assert.ok(root.startsWith(validation))
    await rm(root, { recursive: true, force: true })
  }
  try {
    await tools.session_index_list.execute({ refresh: true })
    if (ftsEnabled) {
      const deadline = Date.now() + 10_000
      for (;;) {
        const status = await tools.session_index_status.execute({})
        if (status.ftsHealth.ok && !status.active) break
        assert.ok(Date.now() < deadline, 'FTS worker should initialize in the isolated test')
        await new Promise(resolveWait => setTimeout(resolveWait, 20))
      }
    }
    return { tools, close }
  } catch (error) { await close(); throw error }
}

const render = (tool: Tool, value: any, args: Record<string, unknown> = {}) => tool.output.render(args, value).map(block => block.text).join('\n')

it('default big-line omissions are explicit; raised bounded source queries recover final and middle rows identically with FTS on/off', async () => {
  const body = 'x'.repeat(DEFAULT_SEARCH_LINE_BYTES) + ' tailneedle'
  const logs = [
    { id: 'last', events: [alpha3User('intro', 'last-intro'), alpha3Assistant(body, 'last-large')] },
    { id: 'middle', events: [alpha3User('intro', 'middle-intro'), alpha3Assistant(body, 'middle-large'), alpha3User('after', 'middle-after')] },
  ]
  const recovered: string[][] = []
  for (const ftsEnabled of [true, false]) {
    const env = await setup(ftsEnabled, logs)
    try {
      const tool = env.tools.session_index_search
      const args = { mode: 'full', query: 'tailneedle', filter: { role: 'assistant' } }
      const limited = await tool.execute(args)
      assert.deepEqual(limited.hits, [])
      assert.equal(limited.coverage.complete, false)
      assert.equal(limited.totalExact, false)
      assert.equal(limited.hasMore, true)
      assert.equal(limited.coverage.sourceLimits.maxLineBytes, DEFAULT_SEARCH_LINE_BYTES)
      assert.equal(limited.coverage.sourceLimits.hardMaxLineBytes, MAX_SEARCH_LINE_BYTES)
      assert.equal(limited.coverage.sourceLimits.failedSessions, 2)
      assert.deepEqual(limited.coverage.reasons, ['oversized-jsonl-lines'])
      assert.equal(limited.coverage.diagnostics.length, 2)
      assert.ok(limited.coverage.diagnostics.every((item: any) => item.reason === 'oversized-jsonl-lines'))
      assert.ok(limited.coverage.diagnostics.every((item: any) => item.skipped && item.error && item.maxLineBytes === DEFAULT_SEARCH_LINE_BYTES))
      assert.match(render(tool, limited, args), /原文覆盖不完整.*maxLineBytes=4194304/)
      const full = await tool.execute({ ...args, maxLineBytes: 8 * 1024 * 1024 })
      assert.equal(full.coverage.complete, true)
      assert.equal(full.totalExact, true)
      assert.deepEqual(full.coverage.diagnostics, [])
      assert.equal(full.coverage.sourceLimits.maxDecompressedBytes, MAX_SEARCH_DECOMPRESSED_BYTES)
      assert.equal(full.coverage.sourceLimits.failedSessions, 0)
      assert.deepEqual(full.hits.map((hit: any) => hit.sessionId).sort(), ['last', 'middle'])
      assert.ok(full.hits.every((hit: any) => /^a1:/.test(hit.anchorId) && !('messageId' in hit)))
      assert.match(render(tool, full, args), /跳回：session_id=.* anchor_id=a1:/)
      recovered.push(full.hits.map((hit: any) => hit.anchorId).sort())
    } finally { await env.close() }
  }
  assert.deepEqual(recovered[0], recovered[1])
})

it('raising the source budget never accepts an unknown required event or presents an old FTS anchor', async () => {
  for (const ftsEnabled of [true, false]) {
    const env = await setup(ftsEnabled, [{ id: 'unsafe', events: [alpha3User('intro', 'u'), alpha3Assistant('hiddenneedle', 'a'), { type: 'unknown/required', data: {} }] }])
    try {
      const value = await env.tools.session_index_search.execute({ mode: 'full', query: 'hiddenneedle', maxLineBytes: MAX_SEARCH_LINE_BYTES, filter: { role: 'assistant' } })
      assert.deepEqual(value.hits, [])
      assert.equal(value.coverage.complete, false)
      assert.equal(value.totalExact, false)
      assert.equal(value.coverage.sourceLimits.maxLineBytes, MAX_SEARCH_LINE_BYTES)
      assert.equal(value.coverage.sourceLimits.failedSessions, 1)
      assert.match(value.coverage.diagnostics[0].error, /unknown required event type/)
    } finally { await env.close() }
  }
})

it('source line budgets enforce integer lower and hard upper bounds before starting a query', async () => {
  const env = await setup(false, [])
  try {
    const tool = env.tools.session_index_search
    assert.equal(tool.parameters.properties.maxLineBytes.type, 'integer')
    assert.match(tool.parameters.properties.maxLineBytes.description, /4194304.*33554432/)
    for (const invalid of [0, DEFAULT_SEARCH_LINE_BYTES - 1, MAX_SEARCH_LINE_BYTES + 1, DEFAULT_SEARCH_LINE_BYTES + 0.5, NaN, Infinity, '8388608']) {
      await assert.rejects(tool.execute({ mode: 'full', query: 'needle', maxLineBytes: invalid }), /maxLineBytes/)
    }
  } finally { await env.close() }
})

it('SCROLL renders stable anchors and selects the center by anchorId, retaining explicit legacy rowid support', async () => {
  const env = await setup(true, [{ id: 'navigation', events: [alpha3User('intro', 'u'), alpha3Assistant('navigationneedle', 'a')] }])
  try {
    const tool = env.tools.session_index_search
    const found = await tool.execute({ mode: 'full', query: 'navigationneedle', filter: { role: 'assistant' } })
    const anchor = found.hits[0].anchorId
    assert.match(tool.description, /session_id\+anchor_id/)
    const scroll = await tool.execute({ session_id: 'navigation', anchor_id: anchor, window: 1 })
    assert.equal(scroll.anchor_id, anchor)
    assert.ok(!('message_id' in scroll))
    const text = render(tool, scroll)
    assert.match(text, /▶ assistant anchor_id=a1:/)
    assert.match(text, /目标消息的 anchorId 作为 anchor_id/)
    const expired = await tool.execute({ session_id: 'navigation', anchor_id: 'missing-stable' })
    assert.equal(expired.anchor_id, 'missing-stable')
    assert.match(render(tool, expired), /anchor_id=missing-stable/)
    const legacy = render(tool, { mode: 'scroll', session_id: 'old', message_id: 3, window: 1, messages: [{ id: 3, role: 'user', text: 'legacy' }] })
    assert.match(legacy, /▶ user message_id=3/)
    assert.match(env.tools.session_index_bookmark.description, /sessionId\+anchorId/)
  } finally { await env.close() }
})
