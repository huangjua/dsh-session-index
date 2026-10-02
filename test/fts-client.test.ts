import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createFtsClient, FtsClient, FTS_BATCH_BYTES, FTS_QUEUE_BYTES } from '../src/fts-client.js'
import { FTS_PARSER_VERSION } from '../src/fts.js'
import type { SyncSessionRequest, FtsMessageRow } from '../src/fts.js'

const fixture = new URL('./fts-transport-fixture.js', import.meta.url)
const file = '/isolated/worker-session'
function request(version: number, messages: FtsMessageRow[], suffix = ''): SyncSessionRequest {
  const sessionFile = file + suffix
  return { meta: { file: sessionFile, id: 'worker-session' + suffix, workspace: '/fake', title: 'worker test', agentPreset: 'fake', createdAt: 1, lastTime: 10 },
    sourceFingerprint: { file: sessionFile, sessionId: 'worker-session' + suffix, size: 100 * version, mtimeMs: version, ctimeMs: version,
      indexedBytes: 100 * version, indexedSeq: version, complete: true }, parserVersion: FTS_PARSER_VERSION, mode: 'replace', messages }
}
function row(text: string, suffix = ''): FtsMessageRow { return { sessionFile: file + suffix, role: 'user', text, toolName: '' } }
async function scratch(work: (directory: string) => Promise<void>): Promise<void> {
  const parent = resolve(tmpdir())
  const directory = await mkdtemp(join(parent, 'dsh-fts-client-'))
  try { await work(directory) }
  finally {
    assert.equal(dirname(resolve(directory)), parent)
    assert.ok(basename(directory).startsWith('dsh-fts-client-'))
    await rm(directory, { recursive: true, force: true })
  }
}
async function real(directory: string): Promise<FtsClient> {
  const client = await createFtsClient(join(directory, 'fts.db'))
  assert.ok(client, 'Node SQLite is available in the validation runtime')
  return client
}
const errorCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code

describe('FTS worker RPC and bounded transport', () => {
  it('all reads, checkpoints, short-word search, metadata and maintenance work through RPC', async () => scratch(async directory => {
    const client = await real(directory)
    try {
      const receipt = await client.syncSession(request(1, [row('中文 短词 SQL safety'), { ...row('assistant SQL answer'), role: 'assistant' }]))
      assert.equal(receipt.checkpoint.messageCount, 2)
      assert.equal(await client.sessionCount(), 1)
      assert.equal((await client.getCheckpoint(file))?.indexedSeq, 1)
      assert.deepEqual(await client.listSessionFiles(), [file])
      assert.equal((await client.search('中文', '', 5)).length, 1)
      assert.equal((await client.search('SQL', '', 5, { role: 'assistant' })).length, 1)
      await client.markPruned(3)
      assert.equal(await client.lastPruneCount(), 3)
      assert.ok(await client.lastPruneAt())
      await client.optimize()
      await client.maybeMaintenance()
      await client.vacuum()
      const health = await client.health()
      assert.equal(health.messages, 2)
      assert.equal(health.degraded, false)
      assert.ok(health.workerMemory)
      await client.flush()
    } finally { await client.close() }
  }))

  it('failed multi-batch replace preserves old complete snapshot and checkpoint, and flush reports it', async () => scratch(async directory => {
    const client = await real(directory)
    try {
      await client.syncSession(request(1, [row('old snapshot keeper')]))
      const rows = Array.from({ length: 2500 }, (_, index) => row(`new version ${index} ` + 'a'.repeat(1000)))
      rows.push({ ...row('wrong session'), sessionFile: '/wrong' })
      await assert.rejects(client.syncSession(request(2, rows)), /another session/)
      assert.equal((await client.search('keeper', '', 10)).length, 1)
      assert.equal((await client.search('new version', '', 10)).length, 0)
      assert.equal((await client.getCheckpoint(file))?.indexedSeq, 1)
      await assert.rejects(client.flush(), /another session/)
      await client.flush()
      const receipt = await client.syncSession(request(1, [row('must not overwrite duplicate')]))
      assert.equal(receipt.duplicate, true)
      assert.equal((await client.search('keeper', '', 10)).length, 1)
    } finally { await client.close() }
  }))

  it('concurrent flush calls both observe their accepted write failure boundary', async () => scratch(async directory => {
    const client = await real(directory)
    try {
      await client.syncSession(request(1, [row('old snapshot')]))
      await assert.rejects(client.syncSession(request(2, [{ ...row('invalid'), sessionFile: '/wrong' }])))
      const results = await Promise.allSettled([client.flush(), client.flush()])
      assert.ok(results.every(result => result.status === 'rejected'))
      assert.equal((await client.health()).failedSessions, 1)
      await client.flush()
      await client.syncSession(request(2, [row('successful recovery')]))
      assert.equal((await client.health()).failedSessions, 0)
    } finally { await client.close() }
  }))

  it('two producers obey the shared two-batch, 512 KiB and 8 MiB limits, including Unicode slice boundaries', async () => scratch(async directory => {
    const client = await real(directory)
    try {
      const large = '\\"\n'.repeat(6000) + 'a'.repeat(16380) + '😀尾部标识'.repeat(100000) + ' unique-tail-token'
      await Promise.all([
        client.syncSession(request(1, [row(large)])),
        client.syncSession(request(1, Array.from({ length: 500 }, () => row('other transfer ' + 'z'.repeat(1500), '-2')), '-2')),
      ])
      assert.equal((await client.search('unique-tail-token', '', 10)).length, 1)
      assert.equal((await client.search('😀尾部标识', '', 10)).length, 1)
      const metrics = client.diagnostics()
      assert.ok(metrics.maxBatchBytes <= FTS_BATCH_BYTES)
      assert.ok(metrics.maxInFlightBatches <= 2)
      assert.ok(metrics.maxQueueBytes <= FTS_QUEUE_BYTES)
      assert.ok(metrics.maxActiveSourceBytes >= large.length * 2)
      assert.ok(metrics.maxActiveBodyBytes <= 2 * 64 * 1024 * 1024)
      assert.equal(metrics.activeBodyBytes, 0)
      assert.equal(metrics.activeSourceBytes, 0)
      console.log('FTS source memory evidence', JSON.stringify({ maxActiveSourceBytes: metrics.maxActiveSourceBytes,
        maxActiveBodyBytes: metrics.maxActiveBodyBytes, maxQueueBytes: metrics.maxQueueBytes,
        maxBatchBytes: metrics.maxBatchBytes, maxInFlightBatches: metrics.maxInFlightBatches }))
      assert.equal(metrics.queueBytes, 0)
      assert.equal(metrics.pendingRequests, 0)
    } finally { await client.close() }
    assert.ok(!(await readdir(directory)).some(name => name.startsWith('.fts-staging-')))
  }))

  it('queries can observe the old complete snapshot while disk staging is still in progress', async () => scratch(async directory => {
    const client = await real(directory)
    try {
      await client.syncSession(request(1, [row('old visible keeper')]))
      const replacement = client.syncSession(request(2, Array.from({ length: 5000 }, () => row('new visible keeper ' + 'a'.repeat(1000)))))
      const page = await client.search('old visible', '', 5)
      assert.ok(page.length === 0 || page.every(hit => hit.text.includes('old visible')))
      await replacement
      assert.equal((await client.getCheckpoint(file))?.messageCount, 5000)
      assert.equal((await client.search('old visible', '', 5)).some(hit => hit.text.includes('old visible')), false)
    } finally { await client.close() }
  }))

  it('restart releases pending operations and retains committed checkpoints', async () => scratch(async directory => {
    const client = await real(directory)
    try {
      await client.syncSession(request(1, [row('checkpoint survives restart')]))
      await client.restart()
      assert.equal(client.diagnostics().restarts, 1)
      assert.equal((await client.getCheckpoint(file))?.messageCount, 1)
      assert.equal((await client.search('survives', '', 5)).length, 1)
    } finally { await client.close() }
  }))

  it('waiting producers retain a bounded input queue and all admitted sessions settle', async () => scratch(async directory => {
    const client = await real(directory)
    try {
      const operations = Array.from({ length: 5 }, (_, index) => client.syncSession(request(1,
        Array.from({ length: 100 }, () => row('bounded queue ' + 'q'.repeat(1000), `-${index}`)), `-${index}`)))
      assert.ok(client.diagnostics().queuedProducers > 0)
      assert.ok(client.diagnostics().queueBytes <= FTS_QUEUE_BYTES)
      await Promise.all(operations)
      assert.equal(await client.sessionCount(), 5)
      assert.equal(client.diagnostics().queuedSourceBytes, 0)
      assert.equal(client.diagnostics().queuedProducers, 0)
    } finally { await client.close() }
  }))

  it('cancelling before staging acknowledgement cleans the known client staging token', async () => scratch(async directory => {
    const client = await real(directory)
    try {
      await client.syncSession(request(1, [row('old complete record')]))
      const controller = new AbortController()
      const operation = client.syncSession(request(2, Array.from({ length: 5000 }, () => row('replacement ' + 'x'.repeat(1000)))), { signal: controller.signal })
      setTimeout(() => controller.abort(), 1)
      await assert.rejects(operation)
      await assert.rejects(client.flush())
      assert.equal((await client.getCheckpoint(file))?.indexedSeq, 1)
      assert.equal((await client.health()).stagedSessions, 0)
      assert.equal((await client.search('old complete record', '', 10)).length, 1)
    } finally { await client.close() }
  }))

  it('cancelled queries settle promptly and do not retain queue bytes', async () => scratch(async directory => {
    const client = await createFtsClient(join(directory, 'fixture.db'), { workerUrl: fixture })
    assert.ok(client)
    try {
      const controller = new AbortController()
      const started = Date.now()
      const search = client.search('__slow', '', 5, undefined, { signal: controller.signal })
      setTimeout(() => controller.abort(), 20)
      await assert.rejects(search, errorCode('EFTSCANCELLED'))
      assert.ok(Date.now() - started < 250)
      assert.equal(client.diagnostics().pendingRequests, 0)
      assert.equal(client.diagnostics().queueBytes, 0)
      assert.equal(await client.sessionCount(), 7)
    } finally { await client.close() }
  }))

  it('hang timeout rejects pending reader requests; readiness waits for isolated recovery before a fresh short request', async () => scratch(async directory => {
    const client = await createFtsClient(join(directory, 'fixture.db'), { workerUrl: fixture, queryTimeoutMs: 100, startupTimeoutMs: 5000 })
    assert.ok(client)
    try {
      const outcomes = await Promise.allSettled([client.search('__hang', '', 5), client.sessionCount()])
      assert.ok(outcomes.every(result => result.status === 'rejected'))
      assert.ok(client.diagnostics().lastTransportError.includes('exceeded'))
      await client.ready()
      assert.equal(await client.sessionCount(), 7)
      assert.equal(client.diagnostics().restarts, 1)
      assert.equal(client.diagnostics().pendingRequests, 0)
    } finally { await client.close() }
  }))

  it('worker exit rejects pending requests and bounded request admission returns a structured error', async () => scratch(async directory => {
    const client = await createFtsClient(join(directory, 'fixture.db'), { workerUrl: fixture, maxPendingRequests: 2 })
    assert.ok(client)
    try {
      await assert.rejects(client.search('__exit', '', 5), /exited/)
      assert.equal(await client.sessionCount(), 7)
      const searches = [client.search('__slow', '', 5), client.search('__slow', '', 5)]
      await assert.rejects(client.search('__slow', '', 5), errorCode('EFTSQUEUE'))
      await Promise.all(searches)
    } finally { await client.close() }
  }))

  it('reconnection runs its recovery callback exactly once, and callback errors keep the transport usable', async () => scratch(async directory => {
    let recovered = 0
    const client = await createFtsClient(join(directory, 'fixture.db'), { workerUrl: fixture, onRecovered: () => { recovered++; throw new Error('reconcile callback fault') } })
    assert.ok(client)
    try {
      assert.equal(recovered, 0, 'first initialization is not a restart')
      await client.restart()
      assert.equal(recovered, 1)
      assert.equal(client.diagnostics().lastRecoveryCallbackError, 'reconcile callback fault')
      assert.equal(await client.sessionCount(), 7)
    } finally { await client.close() }
  }))

  it('unload suppresses a recovery callback during a pending restart', async () => scratch(async directory => {
    let recovered = 0
    const client = await createFtsClient(join(directory, 'fixture.db'), { workerUrl: fixture, onRecovered: () => { recovered++ } })
    assert.ok(client)
    const restarting = client.restart()
    const closing = client.close()
    await Promise.allSettled([restarting, closing])
    assert.equal(recovered, 0)
    assert.equal(client.diagnostics().pendingRequests, 0)
    assert.equal(client.ok, false)
  }))

  it('repeated crashes stop automatic restart loops and can be recovered explicitly', async () => scratch(async directory => {
    const client = await createFtsClient(join(directory, 'fixture.db'), { workerUrl: fixture })
    assert.ok(client)
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(client.search('__exit', '', 5))
        assert.equal(await client.sessionCount(), 7)
      }
      await assert.rejects(client.search('__exit', '', 5))
      await assert.rejects(client.sessionCount())
      assert.equal(client.diagnostics().restartSuspended, true)
      await client.restart()
      assert.equal(await client.sessionCount(), 7)
      assert.equal(client.diagnostics().restartSuspended, false)
    } finally { await client.close() }
  }))

  it('oversized query DTO limits fail explicitly', async () => scratch(async directory => {
    const client = await createFtsClient(join(directory, 'fixture.db'), { workerUrl: fixture })
    assert.ok(client)
    try {
      await assert.rejects(client.search('hello', '', 501), RangeError)
      await assert.rejects(client.searchPage('hello', '', Number.POSITIVE_INFINITY), RangeError)
      assert.equal(client.diagnostics().pendingRequests, 0)
    } finally { await client.close() }
  }))

  it('legacy search and searchPage truncate message DTOs explicitly, retaining tail-match snippets', async () => scratch(async directory => {
    const client = await real(directory)
    try {
      await client.syncSession(request(1, [row('x'.repeat(10000) + ' tailneedle')]))
      const legacy = await client.search('tailneedle', '', 5)
      assert.equal(legacy[0]?.text.length, 4096)
      assert.equal(legacy[0]?.textTruncated, true)
      assert.ok(legacy[0]?.snippet.includes('tailneedle'))
      const page = await client.searchPage('tailneedle', '', 5)
      assert.equal(page.hits[0]?.text.length, 4096)
      assert.equal(page.hits[0]?.textTruncated, true)
    } finally { await client.close() }
  }))

  it('a session body exceeding 64 MiB fails before transport and preserves its checkpoint', async () => scratch(async directory => {
    const client = await real(directory)
    try {
      await client.syncSession(request(1, [row('old checkpoint')]))
      await assert.rejects(client.syncSession(request(2, [row('a'.repeat(64 * 1024 * 1024 + 1))])), errorCode('EFTSSOURCE'))
      await assert.rejects(client.flush(), /64 MiB/)
      assert.equal((await client.getCheckpoint(file))?.indexedSeq, 1)
      assert.equal(client.diagnostics().activeStreams, 0)
    } finally { await client.close() }
  }))

  it('a response beyond 8 MiB fails explicitly and leaves the worker usable', async () => scratch(async directory => {
    const client = await real(directory)
    try {
      const input = request(1, Array.from({ length: 500 }, () => row('huge-response-match')))
      input.meta.title = 't'.repeat(20000)
      await client.syncSession(input)
      await assert.rejects(client.search('huge-response-match', '', 500), errorCode('EFTSRESPONSE'))
      assert.equal(await client.sessionCount(), 1)
      assert.equal(client.diagnostics().queueBytes, 0)
    } finally { await client.close() }
  }))

  it('close has a bounded drain even when its worker is unresponsive', async () => scratch(async directory => {
    const client = await createFtsClient(join(directory, 'hang-writer.db'), { workerUrl: fixture, closeTimeoutMs: 50 })
    assert.ok(client)
    const hanging = client.vacuum()
    void hanging.catch(() => {})
    await new Promise<void>(accept => setTimeout(accept, 10))
    await assert.rejects(client.close(), errorCode('EFTSCLOSETIMEOUT'))
    await assert.rejects(hanging)
    assert.equal(client.diagnostics().pendingRequests, 0)
    assert.equal(client.diagnostics().queueBytes, 0)
  }))

  it('close drains accepted staged writes, refuses new work and terminates every transport', async () => scratch(async directory => {
    const dbPath = join(directory, 'fts.db')
    const client = await real(directory)
    const write = client.syncSession(request(1, Array.from({ length: 1500 }, () => row('drained before unload ' + 'a'.repeat(1000)))))
    const close = client.close()
    await assert.rejects(client.removeSession(file), errorCode('EFTSCLOSED'))
    await write
    await close
    assert.equal(client.diagnostics().pendingRequests, 0)
    assert.equal(client.diagnostics().queueBytes, 0)
    const reopened = await createFtsClient(dbPath)
    assert.ok(reopened)
    try { assert.equal((await reopened.getCheckpoint(file))?.messageCount, 1500) }
    finally { await reopened.close() }
  }))

  it('FTS unavailable returns null, and repeated apply/dispose removes staging resources', async () => scratch(async directory => {
    assert.equal(await createFtsClient(join(directory, 'unavailable.db'), { workerUrl: fixture }), null)
    for (let cycle = 0; cycle < 4; cycle++) { const client = await real(directory); await client.close() }
    assert.ok(!(await readdir(directory)).some(name => name.startsWith('.fts-staging-')))
  }))
})
