import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { parseFull, parseSearch, streamJsonlLines, type FullSummary } from '../src/streaming-parser.js'
import { messageIdentity, type MessageIdentity } from '../src/message-anchor.js'
import { createQueryPlan, matchesQuery } from '../src/query-plan.js'
import { WorkerPool } from '../src/worker-pool.js'
import { isCancelError } from '../src/cancel.js'
import { alpha3Assistant, alpha3EventJson, alpha3Jsonl, alpha3ToolCall, alpha3User, type Alpha3Event } from './support/alpha3-log.js'

let root = ''
before(async () => {
  assert.ok(process.env.DSH_HOME, 'DSH_HOME must be isolated explicitly')
  assert.ok(process.env.TEMP, 'TEMP must be isolated explicitly')
  assert.ok(process.env.TMP, 'TMP must be isolated explicitly')
  const validation = resolve('validation', 'parser-contract')
  await mkdir(validation, { recursive: true })
  root = await mkdtemp(join(validation, 'run-'))
})
after(async () => {
  assert.ok(root.startsWith(resolve('validation', 'parser-contract')))
  await rm(root, { recursive: true, force: true })
})

async function file(events: Alpha3Event[], name = 'session', generation = 0): Promise<string> {
  const lines = alpha3Jsonl({ id: 'stable-session', createdAt: 100, events })
  const header = JSON.parse(lines[0])
  header.version = generation
  if (generation >= 2) header.isSeeded = false
  lines[0] = JSON.stringify(header)
  const target = join(root, `${name}.zstd`)
  await writeFile(target, zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
  return target
}
const identities = (out: FullSummary): MessageIdentity[] => out.messages as unknown as MessageIdentity[]

describe('S3 stable message identity and source ordering', () => {
  it('full, search and resumed delta preserve user → tool → assistant identities', async () => {
    const first = alpha3User('needle beginning', 'u')
    const rest = [alpha3ToolCall('needle_tool', 'call'), alpha3Assistant('needle ending', 'a')]
    const lines = alpha3Jsonl({ id: 'stable-session', createdAt: 100, events: [first] })
    const prefix = zstdCompressSync(Buffer.from(lines.join('\n') + '\n'))
    const suffix = zstdCompressSync(Buffer.from(rest.map((event, i) => alpha3EventJson(event, i + 1, 100)).join('\n') + '\n'))
    const target = join(root, 'delta.zstd')
    await writeFile(target, prefix)
    const base = await parseFull(target, { collectMessages: true })
    await writeFile(target, Buffer.concat([prefix, suffix]))
    const full = await parseFull(target, { collectMessages: true })
    const delta = await parseFull(target, {
      collectMessages: true, startOffset: prefix.length, decoder: 'fzstd',
      resume: { version: 'alpha3', generation: 0, header: { id: 'stable-session', createdAt: 100, cwd: '', agentPreset: '' }, baseSeq: 1 },
    })
    assert.deepEqual(full.messages?.map(row => row.role), ['user', 'tool', 'assistant'])
    assert.deepEqual(identities(full).map(row => row.eventSeq), [0, 1, 2])
    assert.deepEqual([...identities(base), ...identities(delta)].map(row => row.anchorId), identities(full).map(row => row.anchorId))
    assert.deepEqual((await parseSearch(target, 'needle', { maxSnippets: 10 })).map(hit => hit.anchorId), identities(full).map(row => row.anchorId))
    assert.equal(delta.readBytes, suffix.length)
  })

  it('source IDs survive physical generations 0–4 and seq shifts', async () => {
    const anchors: string[][] = []
    for (let generation = 0; generation <= 4; generation++) {
      const events = [alpha3ToolCall('tool', 'call'), alpha3User('body😀中文', 'u'), alpha3Assistant('answer', 'a')]
      if (generation > 0) events.unshift({ type: 'session/title', data: { title: 'shift' } })
      const out = await parseFull(await file(events, `generation-${generation}`, generation), { collectMessages: true })
      anchors.push(identities(out).map(row => row.anchorId))
      assert.ok(identities(out).every(row => row.generation === generation))
    }
    assert.ok(anchors.every(row => JSON.stringify(row) === JSON.stringify(anchors[0])))
  })

  it('seq fallbacks bind generation and full body evidence', () => {
    const event = { seq: 1, type: 'user/message', data: { role: 'user' } }
    const original = messageIdentity('session', 0, event, 'head'.repeat(300) + 'tail')
    assert.match(original.anchorId, /^a1s:/)
    assert.notEqual(original.anchorId, messageIdentity('session', 1, event, 'head'.repeat(300) + 'tail').anchorId)
    assert.notEqual(original.anchorId, messageIdentity('session', 0, event, 'head'.repeat(300) + 'changed').anchorId)
    assert.notEqual(original.anchorId, messageIdentity('other-session', 0, event, 'head'.repeat(300) + 'tail').anchorId)
  })

  it('replacement folds first, then orders remaining surface and tools by source seq', async () => {
    const replacement = alpha3User('replacement', 'u2')
    replacement.surfaceOp = { op: 'replace', start: 0, end: 0 }
    replacement.sourceEventSeqs = [0]
    const out = await parseFull(await file([
      alpha3User('shadowed', 'u1'), alpha3ToolCall('tool', 'call'), alpha3Assistant('retained', 'a'), replacement,
    ], 'replacement'), { collectMessages: true })
    assert.deepEqual(identities(out).map(row => row.eventSeq), [1, 2, 3])
    assert.ok(out.messages?.every(row => row.text !== 'shadowed'))
  })
})

describe('S4 complete text and shared original-message query semantics', () => {
  it('indexes beyond 1201 characters, both distant terms, Unicode and long boundary substrings', async () => {
    const body = `alpha ${'x'.repeat(1201)} 😀中文 const value = ${'z'.repeat(6000)} omega`
    const target = await file([alpha3User(body, 'long')], 'long')
    const out = await parseFull(target, { collectMessages: true })
    assert.equal(out.messages?.[0].text, body)
    assert.equal(out.coverage?.complete, true)
    assert.equal((await parseSearch(target, 'alpha omega')).length, 1)
    assert.equal((await parseSearch(target, '😀中文 value')).length, 1)
    assert.equal((await parseSearch(target, 'z'.repeat(5000))).length, 1)
  })

  it('uses explicit AND/OR without relaxing one file; filters role before truncating', async () => {
    const target = await file([
      alpha3User('alpha only', 'u'), alpha3ToolCall('alpha_tool', 't'), alpha3Assistant('alpha omega', 'a'),
    ], 'semantics')
    assert.deepEqual((await parseSearch(target, 'alpha omega')).map(hit => hit.role), ['assistant'])
    assert.deepEqual((await parseSearch(target, 'alpha absent')).map(hit => hit.role), [])
    assert.deepEqual((await parseSearch(target, 'alpha absent', { queryMode: 'or', maxSnippets: 10 })).map(hit => hit.role), ['user', 'tool', 'assistant'])
    assert.equal((await parseSearch(target, 'alpha omega', { role: 'assistant', maxSnippets: 1 })).length, 1)
    const plan = createQueryPlan(' OR "alpha" (omega)* AND ')
    assert.deepEqual(plan.tokens, ['alpha', 'omega'])
    assert.equal(matchesQuery('alpha omega', plan), true)
  })

  it('byte budget preserves whole messages and explicitly marks incomplete coverage', async () => {
    const target = await file([alpha3User('😀'.repeat(100), 'u'), alpha3Assistant('tail', 'a')], 'budget')
    const out = await parseFull(target, { collectMessages: true, maxIndexedTextBytes: 8 })
    assert.deepEqual(out.messages?.map(row => row.text), ['tail'])
    assert.equal(out.coverage?.complete, false)
    assert.deepEqual(out.coverage?.reasons, ['text-byte-limit'])
    assert.equal(out.coverage?.indexedTextBytes, 4)
    assert.equal((await parseSearch(target, '😀')).length, 1, 'raw log fallback can search unindexed text')
  })

  it('oversized final JSONL messages report incomplete coverage and permit an explicit raw-log budget', async () => {
    const target = await file([alpha3User('needle ' + 'x'.repeat(2000), 'oversized')], 'line-budget')
    const out = await parseFull(target, { collectMessages: true, maxLineBytes: 512 })
    assert.equal(out.coverage?.complete, false)
    assert.deepEqual(out.coverage?.reasons, ['oversized-jsonl-lines'])
    await assert.rejects(parseSearch(target, 'needle', { maxLineBytes: 512 }), /incomplete original-log search/)
    assert.equal((await parseSearch(target, 'needle', { maxLineBytes: 4096 })).length, 1)
  })

  it('oversized middle lines retain diagnostics on the original envelope error in both decoders', async () => {
    const target = await file([alpha3User('x'.repeat(2000), 'large'), alpha3Assistant('needle after', 'after')], 'middle-line-budget')
    for (const decoder of ['native', 'fzstd'] as const) {
      await assert.rejects(parseFull(target, { maxLineBytes: 512, decoder }), error => {
        assert.match(String(error), /malformed event envelope/)
        assert.equal((error as Error & { stats: { oversized: number } }).stats.oversized, 1)
        return true
      })
    }
  })

  it('native and fzstd delta metrics both count compressed input rather than decoded text', async () => {
    const prefix = zstdCompressSync(Buffer.from('{"prefix":true}\n'))
    const tail = zstdCompressSync(Buffer.from(JSON.stringify({ text: 'x'.repeat(10000) }) + '\n'))
    const target = join(root, 'delta-metric.zstd')
    await writeFile(target, Buffer.concat([prefix, tail]))
    for (const decoder of ['native', 'fzstd'] as const) {
      const stats = await streamJsonlLines(target, () => {}, { startOffset: prefix.length, decoder })
      assert.equal(stats.readBytes, tail.length)
      assert.equal(stats.deltaBytes, tail.length)
      assert.ok(stats.decodedBytes! > tail.length)
    }
  })

  it('rejects invalid offsets and cancellation before I/O and retains both failed decoder attempts in workers', async () => {
    const missing = join(root, 'does-not-exist.zstd')
    await assert.rejects(parseFull(missing, { startOffset: -1, decoder: 'fzstd' }), RangeError)
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(parseFull(missing, { signal: aborted.signal }), isCancelError)
    const corrupt = join(root, 'invalid-frame.zstd')
    await writeFile(corrupt, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff]))
    for (const workerUrl of [null, new URL('../src/session-worker.js', import.meta.url)]) {
      const pool = new WorkerPool({ size: 1, workerUrl })
      try {
        const result = await pool.run({ mode: 'full', file: corrupt })
        assert.equal(result.ok, false)
        if (!result.ok) assert.equal(result.stats?.readBytes, 10, 'native 5 bytes + fzstd 5 bytes must both be recorded')
      } finally { pool.terminate() }
    }
  })

  it('50,000 rows report complete at the boundary and incomplete at 50,001', async () => {
    const events = Array.from({ length: 50_000 }, (_, i) => alpha3User(`body ${i}`, `u-${i}`))
    const exact = await parseFull(await file(events, 'at-limit'), { collectMessages: true })
    assert.equal(exact.messages?.length, 50_000)
    assert.equal(exact.coverage?.complete, true)
    events.push(alpha3User('beyond limit unique', 'u-beyond'))
    const target = await file(events, 'over-limit')
    const beyond = await parseFull(target, { collectMessages: true })
    assert.equal(beyond.messages?.length, 50_000)
    assert.equal(beyond.coverage?.complete, false)
    assert.ok(beyond.coverage?.reasons.includes('message-limit'))
    assert.equal((await parseSearch(target, 'beyond unique')).length, 1)
  })

  it('real worker and inline paths preserve query mode, complete bodies and collection budgets', async () => {
    const target = await file([alpha3User('alpha ' + '😀'.repeat(80_000), 'u'), alpha3Assistant('omega', 'a')], 'worker')
    for (const workerUrl of [null, new URL('../src/session-worker.js', import.meta.url)]) {
      const pool = new WorkerPool({ size: 1, workerUrl })
      try {
        const searched = await pool.run({ mode: 'search', file: target, query: 'alpha omega', queryMode: 'or' })
        assert.ok(searched.ok)
        if (searched.ok) assert.equal((searched.data as unknown[]).length, 2)
        const parsed = await pool.run<FullSummary>({ mode: 'full', file: target, collectMessages: true, maxMessages: 1 })
        assert.ok(parsed.ok)
        if (parsed.ok) {
          assert.equal(parsed.data.messages?.[0].text, 'alpha ' + '😀'.repeat(80_000))
          assert.equal(parsed.data.coverage?.complete, false)
        }
      } finally { pool.terminate() }
    }
  })
})
