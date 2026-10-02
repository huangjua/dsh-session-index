/** Run alone after benchmark-fts-worker: first fill, incremental writes, queries, maintenance and lifecycle. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createFtsClient } from '../.test-build/src/fts-client.js'
import { FTS_PARSER_VERSION } from '../.test-build/src/fts.js'

const root = resolve('validation', `fts-scenarios-${Date.now()}`)
for (const name of ['dsh-home', 'temp', 'sessions', 'data']) await mkdir(join(root, name), { recursive: true })
process.env.DSH_HOME = join(root, 'dsh-home')
process.env.TEMP = process.env.TMP = join(root, 'temp')
process.env.DSH_SESSION_INDEX_DATA_DIR = join(root, 'data')
process.env.DSH_SESSION_INDEX_SESSIONS_ROOT = join(root, 'sessions')
const result = { node: process.version, isolatedRoot: root, phases: [], samples: [] }
let last = performance.now()
const timer = setInterval(() => { const now = performance.now(); result.samples.push(now - last); last = now }, 5)
async function measure(name, operation) {
  const first = result.samples.length
  const began = performance.now()
  const value = await operation()
  await new Promise(accept => setTimeout(accept, 15))
  result.phases.push({ name, elapsedMs: performance.now() - began, value, maxTimerGapMs: Math.max(0, ...result.samples.slice(first)), samples: result.samples.length - first })
  return value
}
const file = '/scenario'
const meta = { file, id: 'scenario', workspace: '/synthetic', title: 'Scenario', agentPreset: 'fake', createdAt: 1, lastTime: 2 }
const messages = Array.from({ length: 2500 }, (_, eventSeq) => ({ sessionFile: file, role: 'assistant', toolName: '', eventSeq,
  anchorId: `scenario-message-${eventSeq}`, anchorEvidence: `evidence-${eventSeq}`,
  text: (String(eventSeq) + ' 模型调用历史记录以及索引构建和全文搜索性能验证 windows deployment project alpha beta gamma delta ').repeat(16).slice(0, 1000) }))
const source = version => ({ file, sessionId: 'scenario', size: version * 2500000, mtimeMs: version, ctimeMs: version,
  indexedBytes: version * 2500000, indexedSeq: version === 1 ? 2499 : 2509, complete: true })
let client
try {
  client = await measure('cold worker/schema', async () => {
    const client = await createFtsClient(join(root, 'data', 'fts.db'))
    assert.ok(client)
    return client
  })
  result.phases.at(-1).value = { available: true }
  const receipt = await measure('first full syncSession backfill 2500x1000', () => client.syncSession({ meta, sourceFingerprint: source(1), parserVersion: FTS_PARSER_VERSION, mode: 'replace', messages }))
  await measure('active small increment 10x1000', async () => {
    const increment = messages.slice(0, 10).map((message, index) => ({ ...message, eventSeq: 2500 + index, anchorId: `increment-${index}`, text: 'increment ' + message.text }))
    const receipt = await client.syncSession({ meta, sourceFingerprint: source(2), parserVersion: FTS_PARSER_VERSION,
      mode: 'append', expectedBase: await client.getCheckpoint(file), messages: increment })
    assert.equal(receipt.checkpoint.messageCount, 2510)
    return receipt
  })
  await measure('concurrent trigram and short-term LIKE queries', async () => {
    const latencies = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
      const began = performance.now()
      const page = await client.searchPage(index % 2 ? '索引' : 'alpha beta', '', 5)
      assert.equal(page.total, 1, 'session candidates are deduplicated before their limit')
      assert.ok(page.hits.length)
      return { path: index % 2 ? 'LIKE' : 'trigram', elapsedMs: performance.now() - began }
    }))
    return latencies
  })
  await measure('queries during optimize/VACUUM', async () => {
    const maintenance = client.vacuum()
    const queries = Promise.all([client.search('索引', '', 5), client.search('alpha', '', 5), client.health()])
    const [, results] = await Promise.all([maintenance, queries])
    return { queriesCompleted: results.length, checkpointCount: (await client.getCheckpoint(file)).messageCount }
  })
  await measure('query cancellation', async () => {
    const controller = new AbortController()
    const pending = client.search('索引', '', 5, undefined, { signal: controller.signal })
    setTimeout(() => controller.abort(), 1)
    await assert.rejects(pending, error => error.code === 'EFTSCANCELLED')
    return { pendingRequests: client.diagnostics().pendingRequests }
  })
  await measure('worker restart and committed checkpoint recovery', async () => {
    await client.restart()
    assert.equal((await client.getCheckpoint(file)).messageCount, 2510)
    assert.ok((await client.search('increment', '', 5)).length)
    return { restarts: client.diagnostics().restarts, recoveredMessages: 2510 }
  })
  result.health = await client.health()
  result.metrics = client.diagnostics()
  await measure('close drains transport', async () => { await client.close(); return client.diagnostics() })
} finally {
  clearInterval(timer)
  if (client) await client.close().catch(() => {})
  const directory = join('BENCHMARK_RESULTS', 'fts-worker', process.env.FTS_BENCHMARK_LABEL ?? 'first-run')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'scenarios.json'), JSON.stringify(result, null, 2))
}
assert.ok(result.phases.every(phase => phase.maxTimerGapMs <= 100))
console.log(JSON.stringify({ phases: result.phases.map(({ name, elapsedMs, maxTimerGapMs, samples }) => ({ name, elapsedMs, maxTimerGapMs, samples })),
  maxQueueBytes: result.metrics.maxQueueBytes, maxBatchBytes: result.metrics.maxBatchBytes, maxInFlightBatches: result.metrics.maxInFlightBatches }, null, 2))
