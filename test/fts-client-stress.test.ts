/** Run independently: reader queries must not kill a long atomic writer transaction. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { createFtsClient } from '../src/fts-client.js'
import { FTS_PARSER_VERSION } from '../src/fts.js'
import type { FtsMessageRow, SyncSessionRequest } from '../src/fts.js'

const file = '/isolated/large-atomic-session'
function request(version: number, messages: FtsMessageRow[]): SyncSessionRequest {
  return { meta: { file, id: 'stress', workspace: '/synthetic', title: 'stress', agentPreset: '', createdAt: 1, lastTime: 2 },
    sourceFingerprint: { file, sessionId: 'stress', size: version * 50000000, mtimeMs: version, ctimeMs: version,
      indexedBytes: version * 50000000, indexedSeq: version === 1 ? 0 : 49999, complete: true }, parserVersion: FTS_PARSER_VERSION, mode: 'replace', messages }
}
it('50k x 1000 atomic replacement and failed rollback keep concurrent reader queries/status responsive', { timeout: 240000 }, async () => {
  const parent = resolve(tmpdir())
  const directory = await mkdtemp(join(parent, 'dsh-fts-reader-stress-'))
  const client = await createFtsClient(join(directory, 'fts.db'), { queryTimeoutMs: 2000, writeTimeoutMs: 120000 })
  assert.ok(client)
  const report: Record<string, unknown> = { node: process.version, rows: 50000, charsPerRow: 1000, queryTimeoutMs: 2000, phases: [] }
  const padding = 'x'.repeat(960)
  const rows = Array.from({ length: 50000 }, (_, eventSeq): FtsMessageRow => ({ sessionFile: file, role: 'assistant', toolName: '',
    eventSeq, anchorId: `large-message-${eventSeq}`, text: (`new indexed row ${eventSeq} ${padding}`).padEnd(1000, 'x') }))
  try {
    await client.syncSession(request(1, [{ sessionFile: file, role: 'user', text: 'oldkeeper old complete snapshot', toolName: '', eventSeq: 0, anchorId: 'old' }]))
    async function phase(name: string, input: FtsMessageRow[], expectedFailure: boolean): Promise<void> {
      let done = false
      const began = performance.now()
      const operation = client!.syncSession(request(2, input))
      void operation.then(() => { done = true }, () => { done = true })
      const latencies: number[] = []
      const counts = new Set<number>()
      while (!done) {
        const beganQuery = performance.now()
        const [page, health] = await Promise.all([client!.searchPage('oldkeeper', '', 5), client!.health()])
        latencies.push(performance.now() - beganQuery)
        counts.add(health.messages)
        assert.ok(health.messages === 1 || health.messages === 50000, 'reader sees old or new complete message count')
        assert.ok(page.total === 0 || page.total === 1)
        if (page.total === 1) assert.equal(page.hits[0]?.anchorId, 'old')
        await new Promise<void>(accept => setTimeout(accept, 30))
      }
      if (expectedFailure) { await assert.rejects(operation, /another session/); await assert.rejects(client!.flush()) }
      else await operation
      ;(report.phases as unknown[]).push({ name, elapsedMs: performance.now() - began, querySamples: latencies.length,
        queryMaxMs: Math.max(...latencies), rawQueryLatenciesMs: latencies, observedMessageCounts: [...counts] })
      assert.ok(latencies.length >= 2)
      assert.ok(Math.max(...latencies) < 2000, 'queries finish before the unchanged deadline')
      assert.equal(client!.diagnostics().restarts, 0, 'queries cannot terminate the writer to resolve queue starvation')
    }
    await phase('failed 50k replace rollback', [...rows, { ...rows[0]!, sessionFile: '/wrong' }], true)
    assert.equal((await client.getCheckpoint(file))?.messageCount, 1)
    assert.equal((await client.search('oldkeeper', '', 5)).length, 1)
    await phase('successful 50k replace commit', rows, false)
    assert.equal((await client.getCheckpoint(file))?.messageCount, 50000)
    assert.equal((await client.health()).messages, 50000)
    report.metrics = client.diagnostics()
    report.health = await client.health()
    console.log('FTS 50k concurrent reader evidence', JSON.stringify({ ...report,
      phases: (report.phases as { name: string; elapsedMs: number; querySamples: number; queryMaxMs: number; observedMessageCounts: number[] }[])
        .map(({ name, elapsedMs, querySamples, queryMaxMs, observedMessageCounts }) => ({ name, elapsedMs, querySamples, queryMaxMs, observedMessageCounts })) }))
  } finally {
    await client.close()
    const evidenceDirectory = join('BENCHMARK_RESULTS/fts-worker', process.env.FTS_BENCHMARK_LABEL ?? 'dual-reader')
    await mkdir(evidenceDirectory, { recursive: true })
    await writeFile(join(evidenceDirectory, 'stress-50k.json'), JSON.stringify(report, null, 2))
    assert.equal(dirname(resolve(directory)), parent)
    await rm(directory, { recursive: true, force: true })
  }
})
