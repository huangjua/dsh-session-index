import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { SessionIndexBuilder, type DeltaDiagnostic } from '../src/session-index-builder.js'
import { loadIndex, saveIndex, type SessionMeta } from '../src/core.js'
import { WorkerPool } from '../src/worker-pool.js'
import { CancelError } from '../src/cancel.js'
import type { FtsMessageRow } from '../src/fts.js'
import { alpha3Jsonl, alpha3EventJson, alpha3User, alpha3Assistant, type Alpha3Event } from './support/alpha3-log.js'

const evidenceRoot = fileURLToPath(new URL('../../../evidence/', import.meta.url))
const evidenceTag = new Date().toISOString().replace(/[:.]/g, '-')
const samplesRoot = join(evidenceRoot, 'delta-samples')
const cases: Record<string, unknown>[] = []
const builders: SessionIndexBuilder[] = []

const frame = (lines: string[]): Buffer => zstdCompressSync(Buffer.from(lines.join('\n') + '\n'))
async function sample(name: string) {
  await mkdir(samplesRoot, { recursive: true })
  const root = await mkdtemp(join(samplesRoot, name + '-'))
  const sessions = join(root, 'sessions')
  const sourceDir = join(sessions, 'controlled')
  await mkdir(sourceDir, { recursive: true })
  const file = join(sourceDir, 'session.jsonl.zstd')
  const initial = frame(alpha3Jsonl({ id: 'controlled', createdAt: 1_790_000_000_000,
    events: [alpha3User('controlled original', 'u0')] }))
  await writeFile(file, initial)
  await writeFile(join(root, 'before.zstd'), initial)
  const indexFile = join(root, 'index.json')
  const builder = new SessionIndexBuilder({ root: sessions, indexFile, poolSize: 1 })
  builders.push(builder)
  let rows: FtsMessageRow[] = []
  const options = {
    collectMessages: true,
    onSessionParsed: (_file: string, _meta: SessionMeta, next: FtsMessageRow[], append: boolean) => {
      rows = append ? [...rows, ...next] : next
    },
  }
  assert.equal((await builder.build(options)).status, 'completed')
  const before = loadIndex(indexFile)!.sessions[0]
  return { root, sessions, file, builder, before, initial, options, rows: () => rows }
}

async function compareFull(s: Awaited<ReturnType<typeof sample>>) {
  const fullIndex = join(s.root, 'full-index.json')
  const full = new SessionIndexBuilder({ root: s.sessions, indexFile: fullIndex, poolSize: 1 })
  builders.push(full)
  let fullRows: FtsMessageRow[] = []
  const report = await full.build({ force: true, collectMessages: true,
    onSessionParsed: (_file, _meta, rows) => { fullRows = rows } })
  assert.equal(report.status, 'completed')
  const expected = loadIndex(fullIndex)!.sessions[0]
  const actual = loadIndex(s.builder.indexFile)!.sessions[0]
  for (const key of ['id', 'counts', 'indexedBytes', 'indexedSeq', 'firstUserText',
    'lastAssistantText', 'lastTime', 'coverage'] as const) assert.deepEqual(actual[key], expected[key], key)
  assert.deepEqual(s.rows(), fullRows, 'surface messages and stable anchor identity must equal full')
  await writeFile(join(s.root, 'after.zstd'), await readFile(s.file))
  return { equal: true, checkpointBytes: actual.indexedBytes, checkpointSeq: actual.indexedSeq, messages: fullRows.length }
}

function complete(events: readonly DeltaDiagnostic[]) {
  const event = events.findLast(value => value.phase === 'commit' || value.phase === 'complete')
  assert.ok(event)
  return event
}

test('pure append reads only the compressed tail and equals full including anchors', async () => {
  const s = await sample('append')
  const tail = frame([alpha3EventJson(alpha3Assistant('controlled appended', 'a1'), 1, 1_790_000_000_000)])
  await appendFile(s.file, tail)
  const report = await s.builder.build(s.options)
  assert.equal(report.deltaParsed, 1)
  assert.equal(report.deltaFallbacks, 0)
  assert.equal(report.readBytes, tail.length)
  const event = complete(s.builder.lastDeltaDiagnostics)
  assert.equal(event.readBytes, tail.length)
  assert.equal(event.metricsExact, true)
  assert.equal(event.finalConsistency, 'source_stable')
  assert.equal(event.published, true)
  assert.equal(event.ftsSynced, true)
  assert.equal(event.finalIndexedBytes, event.currentBytes)
  assert.equal(event.previousBytes, s.initial.length)
  assert.equal(event.currentBytes, s.initial.length + tail.length)
  assert.equal(event.previousSeq, 0)
  assert.equal(event.currentSeq, 1)
  cases.push({ name: 'pure_append', sample: s.root, event, full: await compareFull(s), readClosure: { tail: tail.length, actual: report.readBytes } })
})

for (const crossWindow of [false, true]) test(`${crossWindow ? 'cross-window' : 'within-window'} replacement keeps full fallback with one delta attempt`, async () => {
  const s = await sample(crossWindow ? 'cross-window' : 'surface-replace')
  const replaced = crossWindow ? 0 : 1
  const replacement: Alpha3Event = { ...alpha3User('controlled replacement', 'replacement'),
    surfaceOp: { op: 'replace', start: replaced, end: replaced }, sourceEventSeqs: [replaced] }
  const events = crossWindow ? [replacement] : [alpha3User('controlled shadowed', 'u1'), replacement]
  const tail = frame(events.map((event, i) => alpha3EventJson(event, 1 + i, 1_790_000_000_000)))
  await appendFile(s.file, tail)
  const report = await s.builder.build(s.options)
  assert.equal(report.deltaFallbacks, 1)
  const diagnostics = s.builder.lastDeltaDiagnostics
  assert.equal(diagnostics.filter(event => event.phase === 'attempt' && event.mode === 'delta').length, 1)
  const fallback = diagnostics.find(event => event.phase === 'fallback')!
  assert.equal(fallback.reasonCode, crossWindow ? 'cross_window_reference' : 'surface_replace')
  const final = complete(diagnostics)
  assert.equal(report.readBytes, tail.length + (await stat(s.file)).size)
  assert.equal(final.readBytes, report.readBytes)
  assert.equal(final.metricsExact, true)
  assert.equal(final.finalConsistency, 'source_stable')
  cases.push({ name: crossWindow ? 'cross_window_reference' : 'surface_replace', sample: s.root,
    diagnostics, full: await compareFull(s), readClosure: { tail: tail.length, full: (await stat(s.file)).size, actual: report.readBytes } })
})

test('invalid persisted frame offset is classified without repeating deterministic delta', async () => {
  const s = await sample('invalid-offset')
  const index = loadIndex(s.builder.indexFile)!
  index.sessions[0].indexedBytes = s.initial.length - 1
  saveIndex(s.builder.indexFile, index)
  const tail = frame([alpha3EventJson(alpha3User('controlled offset append', 'u1'), 1, 1_790_000_000_000)])
  await appendFile(s.file, tail)
  const report = await s.builder.build(s.options)
  assert.equal(report.deltaFallbacks, 1)
  const diagnostics = s.builder.lastDeltaDiagnostics
  assert.equal(diagnostics.find(event => event.phase === 'fallback')!.reasonCode, 'invalid_offset')
  assert.equal(diagnostics.filter(event => event.phase === 'attempt' && event.mode === 'delta').length, 1)
  assert.equal(report.readBytes, tail.length + 1 + (await stat(s.file)).size)
  cases.push({ name: 'invalid_offset', sample: s.root, diagnostics, full: await compareFull(s), actualReadBytes: report.readBytes })
})

test('sequence mismatch is explicit and one full pass restores the correct checkpoint', async () => {
  const s = await sample('sequence-mismatch')
  const index = loadIndex(s.builder.indexFile)!
  index.sessions[0].indexedSeq = 5
  saveIndex(s.builder.indexFile, index)
  const tail = frame([alpha3EventJson(alpha3Assistant('controlled sequence append', 'a1'), 1, 1_790_000_000_000)])
  await appendFile(s.file, tail)
  const report = await s.builder.build(s.options)
  const diagnostics = s.builder.lastDeltaDiagnostics
  assert.equal(diagnostics.find(event => event.phase === 'fallback')!.reasonCode, 'sequence_mismatch')
  assert.equal(diagnostics.filter(event => event.phase === 'attempt' && event.mode === 'delta').length, 1)
  assert.equal(report.readBytes, tail.length + (await stat(s.file)).size)
  cases.push({ name: 'sequence_mismatch', sample: s.root, diagnostics, full: await compareFull(s) })
})

test('an explicit compatibility rejection runs one necessary full pass and deindexes the incompatible surface', async () => {
  const s = await sample('compatibility-reject')
  const tail = frame([JSON.stringify({ type: 'future/required', seq: 1, time: 1_790_000_000_000, data: {} })])
  await appendFile(s.file, tail)
  let removed = false
  const report = await s.builder.build({ ...s.options, onSessionRemoved: file => { assert.equal(file, s.file); removed = true } })
  const diagnostics = s.builder.lastDeltaDiagnostics
  const final = complete(diagnostics)
  assert.equal(report.failed, 1)
  assert.equal(removed, true, 'an incompatible required event must remove its old searchable FTS snapshot')
  assert.equal(loadIndex(s.builder.indexFile)!.sessions[0].unindexable, true)
  assert.equal(diagnostics.find(event => event.phase === 'fallback')!.reasonCode, 'compatibility_reject')
  assert.equal(diagnostics.filter(event => event.phase === 'attempt' && event.mode === 'delta').length, 1)
  assert.equal(diagnostics.filter(event => event.phase === 'attempt' && event.mode === 'full').length, 1)
  assert.equal(final.reasonCode, 'compatibility_reject')
  assert.equal(final.retainedPrevious, false)
  assert.equal(final.finalConsistency, 'parse_failed')
  assert.equal(final.published, false)
  assert.equal(final.metricsExact, true)
  assert.equal(report.readBytes, tail.length + (await stat(s.file)).size)
  assert.equal(final.readBytes, report.readBytes)
  const full = new SessionIndexBuilder({ root: s.sessions, indexFile: join(s.root, 'full-index.json'), poolSize: 1 })
  try {
    const independent = await full.build({ force: true, collectMessages: true })
    assert.equal(independent.failed, 1)
    assert.ok(loadIndex(full.indexFile)!.sessions.every(meta => meta.unindexable || meta.detailMissing))
  } finally { full.dispose() }
  await writeFile(join(s.root, 'after.zstd'), await readFile(s.file))
  cases.push({ name: 'compatibility_reject', sample: s.root, diagnostics,
    full: { equal: true, rejected: true, failed: 1, searchable: false },
    readClosure: { tail: tail.length, full: (await stat(s.file)).size, actual: report.readBytes } })
})

test('insufficient delta coverage budget retains the necessary full rebuild', async () => {
  const s = await sample('coverage-incomplete')
  const index = loadIndex(s.builder.indexFile)!
  const coverage = index.sessions[0].coverage!
  coverage.maxMessages = coverage.indexedMessages + 1
  saveIndex(s.builder.indexFile, index)
  const tail = frame([
    alpha3EventJson(alpha3User('controlled coverage user', 'u1'), 1, 1_790_000_000_000),
    alpha3EventJson(alpha3Assistant('controlled coverage assistant', 'a2'), 2, 1_790_000_000_000),
  ])
  await appendFile(s.file, tail)
  const report = await s.builder.build(s.options)
  const diagnostics = s.builder.lastDeltaDiagnostics
  assert.equal(diagnostics.find(event => event.phase === 'fallback')!.reasonCode, 'coverage_incomplete')
  assert.equal(report.deltaFallbacks, 1)
  assert.equal(complete(diagnostics).published, true)
  assert.equal(report.readBytes, tail.length + (await stat(s.file)).size)
  cases.push({ name: 'coverage_incomplete', sample: s.root, diagnostics, full: await compareFull(s) })
})

test('unclassified failures retain unknown and the existing bounded retry even when text resembles a known cause', async () => {
  const s = await sample('unknown')
  const tail = frame([alpha3EventJson(alpha3Assistant('controlled unclassified append', 'a1'), 1, 1_790_000_000_000)])
  await appendFile(s.file, tail)
  const run = s.builder.pool.run.bind(s.builder.pool)
  s.builder.pool.run = (async (spec, signal) => {
    const actual = await run(spec, signal)
    if (!spec.delta || !actual.ok) return actual
    return { ok: false, aborted: false, error: 'surface replace / partial frame descriptive text is not evidence',
      stats: actual.data as import('../src/streaming-parser.js').FullSummary }
  }) as typeof s.builder.pool.run
  const report = await s.builder.build(s.options)
  const diagnostics = s.builder.lastDeltaDiagnostics
  assert.equal(diagnostics.find(event => event.phase === 'fallback')!.reasonCode, 'unknown')
  assert.equal(diagnostics.filter(event => event.phase === 'attempt' && event.mode === 'delta').length, 2)
  assert.equal(report.readBytes, 2 * tail.length + (await stat(s.file)).size)
  cases.push({ name: 'unknown_not_guessed', sample: s.root, diagnostics, full: await compareFull(s),
    reads: { delta: 2 * tail.length, full: (await stat(s.file)).size, actual: report.readBytes } })
})

test('a temporarily incomplete frame is retried once; changed source is retained until stable follow-up', async () => {
  const s = await sample('partial-frame')
  const tail = frame([alpha3EventJson(alpha3Assistant('controlled complete after delay', 'a1'), 1, 1_790_000_000_000)])
  const split = tail.length - 3
  await appendFile(s.file, tail.subarray(0, split))
  let finished = false
  const firstEvents: DeltaDiagnostic[] = []
  const first = await s.builder.build({ ...s.options, onDeltaDiagnostic: event => {
    firstEvents.push(event)
    if (!finished && event.phase === 'attempt' && event.reasonCode === 'partial_frame') {
      finished = true
      appendFileSync(s.file, tail.subarray(split))
    }
  } })
  assert.ok(finished, 'typed UnexpectedEOF must be observed')
  assert.equal(first.raced, 1)
  assert.equal(first.readBytes, split + tail.length, 'both real attempts must close even when publication is raced')
  assert.equal(complete(firstEvents).reasonCode, 'source_changed')
  assert.equal(complete(firstEvents).published, false)
  assert.equal(loadIndex(s.builder.indexFile)!.sessions[0].indexedBytes, s.initial.length, 'changed source must not publish stale checkpoint')
  assert.equal(firstEvents.filter(event => event.phase === 'attempt' && event.mode === 'delta').length, 2)
  const retry = await s.builder.build(s.options)
  assert.equal(retry.deltaParsed, 1)
  assert.equal(retry.readBytes, tail.length)
  cases.push({ name: 'partial_frame', sample: s.root, firstEvents, firstReport: first,
    followUp: complete(s.builder.lastDeltaDiagnostics), full: await compareFull(s),
    bounded: { deltaAttempts: 2, stableFollowUpBuilds: 1 } })
})

test('parser worker exit is explicit and safely falls back without claiming unobserved read metrics', async () => {
  const s = await sample('worker-exit')
  const crashFile = join(s.root, 'controlled-exit-worker.mjs')
  await writeFile(crashFile, "import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => process.exit(17));\n")
  const crashed = new WorkerPool({ workerUrl: pathToFileURL(crashFile), size: 1 })
  const run = s.builder.pool.run.bind(s.builder.pool)
  s.builder.pool.run = ((spec, signal) => spec.delta ? crashed.run(spec, signal) : run(spec, signal)) as typeof s.builder.pool.run
  const tail = frame([alpha3EventJson(alpha3Assistant('controlled after worker exit', 'a1'), 1, 1_790_000_000_000)])
  await appendFile(s.file, tail)
  try {
    const report = await s.builder.build(s.options)
    assert.equal(report.deltaFallbacks, 1)
    const diagnostics = s.builder.lastDeltaDiagnostics
    assert.equal(diagnostics.find(event => event.phase === 'fallback')!.reasonCode, 'worker_failure')
    assert.equal(diagnostics.filter(event => event.phase === 'attempt' && event.mode === 'delta').length, 1)
    assert.equal(complete(diagnostics).metricsExact, false, 'terminated worker read amount is unknown')
    cases.push({ name: 'worker_failure', sample: s.root, diagnostics, full: await compareFull(s), unobservedWorkerBytes: true })
  } finally { crashed.terminate() }
})

test('cancel after a real delta read without returned stats marks the reported zero as a lower bound', async () => {
  const s = await sample('cancel-unobserved')
  const tail = frame([alpha3EventJson(alpha3Assistant('controlled cancellation append', 'a1'), 1, 1_790_000_000_000)])
  await appendFile(s.file, tail)
  const run = s.builder.pool.run.bind(s.builder.pool)
  const controller = new AbortController()
  let independentlyObservedReadBytes = 0
  s.builder.pool.run = (async (spec, signal) => {
    const result = await run(spec, signal)
    if (spec.delta && result.ok) {
      independentlyObservedReadBytes = (result.data as import('../src/streaming-parser.js').FullSummary).readBytes ?? 0
      controller.abort()
      // Models the existing transport cancellation contract: the parent rejects
      // CancelError without the worker's completed or partial I/O stats.
      throw new CancelError()
    }
    return result
  }) as typeof s.builder.pool.run
  const report = await s.builder.build({ ...s.options, signal: controller.signal })
  assert.equal(report.status, 'cancelled')
  assert.equal(independentlyObservedReadBytes, tail.length)
  const diagnostics = s.builder.lastDeltaDiagnostics
  const cancelled = complete(diagnostics)
  assert.equal(cancelled.readBytes, 0)
  assert.equal(cancelled.metricsExact, false)
  assert.equal(cancelled.published, false)
  assert.equal(loadIndex(s.builder.indexFile)!.sessions[0].indexedBytes, s.initial.length)
  s.builder.pool.run = run as typeof s.builder.pool.run
  assert.equal((await s.builder.build(s.options)).deltaParsed, 1)
  cases.push({ name: 'cancelled_unobserved_read', sample: s.root, diagnostics,
    independentlyObservedReadBytes, reportedReadBytesIsLowerBound: true, full: await compareFull(s) })
})

after(async () => {
  for (const builder of builders) builder.dispose()
  await mkdir(evidenceRoot, { recursive: true })
  for (const entry of cases) {
    const sampleRoot = entry.sample as string
    entry.sampleSha256 = Object.fromEntries(await Promise.all(['before.zstd', 'after.zstd'].map(async name => {
      const data = await readFile(join(sampleRoot, name))
      return [name, { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }]
    })))
  }
  await writeFile(join(evidenceRoot, `DELTA_FALLBACK_CONTINUATION_${evidenceTag}.json`), JSON.stringify({
    scope: 'isolated controlled replay; no production operations',
    valid: cases.length === 11,
    exitCode: cases.length === 11 ? 0 : 1,
    historicalWindow: { previousBytes: 61595, currentBytes: 79858, appendedBytes: 18263,
      deltaAttempts: 2, fallbackFullReads: 1, deltaBytes: 36526, readBytes: 116384,
      reasonCode: 'unknown', replayAvailable: false,
      boundary: 'Historical numeric evidence contains no explicit rejection code or verified complete before/after frame snapshots.' },
    reasonTaxonomy: {
      surface_replace: 'Successful delta parse explicitly observed replaceOps > 0.',
      cross_window_reference: 'A validated replacement references seq below the resume base and cannot fold in this window.',
      partial_frame: 'Incomplete magic/skippable structure or UnexpectedEOF verified by fzstd across the whole compressed input.',
      invalid_offset: 'Negative/noninteger/out-of-range offset or no frame header at the expected delta boundary.',
      sequence_mismatch: 'Observed event seq differs from expected seq.',
      compatibility_reject: 'SessionCompatibilityError from an explicit schema/header/event/surface contract gate.',
      source_changed: 'Observed FileHandle/path fingerprint change or scan/publication fingerprint mismatch.',
      coverage_incomplete: 'Successful delta parse explicitly marks coverage.complete false.',
      worker_failure: 'Worker error, exit (including unexpected zero exit), postMessage failure, or parser task deadline.',
      unknown: 'Missing typed condition; raw error text is not used to infer a reason.',
    },
    metrics: {
      readBytes: 'Known FileHandle read returns, cumulatively including delta attempts, decoder fallback and full fallback.',
      decodedBytes: 'Observed decompressor output bytes including successful/native validation output; validationDecodedBytes is reported separately.',
      metricsExact: 'False after worker failure or cancellation without returned I/O stats; readBytes then is a measured lower bound.',
      currentBytes: 'Source size actually observed by the final successful parse, otherwise scan size; scannedBytes keeps the initial scan snapshot.',
      publication: 'complete means parser/publication check finished; commit means index.json atomic commit finished. published only becomes true after commit for accepted metadata.',
    },
    cases,
  }, null, 2) + '\n')
})
