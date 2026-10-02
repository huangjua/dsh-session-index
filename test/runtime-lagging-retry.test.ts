/** Public apply with real compressed input, parser workers and FtsClient processes.
 * Only watcher delivery is injected so completing a frame cannot send a new event.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { apply } from '../src/index.js'
import { loadIndex } from '../src/core.js'
import { checkpointOf, FTS_PARSER_VERSION, type FtsCheckpoint, type FtsMessageRow } from '../src/fts.js'
import { SessionIndexBuilder } from '../src/session-index-builder.js'
import { alpha3Jsonl, alpha3EventJson, alpha3User, alpha3Assistant } from './support/alpha3-log.js'

const evidenceRoot = fileURLToPath(new URL('../../../evidence/', import.meta.url))
const evidenceTag = new Date().toISOString().replace(/[:.]/g, '-')
const sampleRoot = join(evidenceRoot, 'lagging-retry-samples')
const observations: Record<string, unknown>[] = []
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const compress = (lines: string[]) => zstdCompressSync(Buffer.from(lines.join('\n') + '\n'))
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex')
interface Tool { execute(args: Record<string, unknown>): Promise<Record<string, any>> }

async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean,
  label: string, timeoutMs = 20000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    last = await read()
    if (accepts(last)) return last
    await pause(30)
  }
  throw new Error(`Public lagging retry timeout: ${label}; last=${JSON.stringify(last)}`)
}

async function fixture(name: string, completeDuringThirdFailure = false) {
  await mkdir(sampleRoot, { recursive: true })
  const root = await mkdtemp(join(sampleRoot, name + '-'))
  const sessionsRoot = join(root, 'sessions'), dataDir = join(root, 'data')
  const file = join(sessionsRoot, 'controlled', 'session.jsonl.zstd')
  const indexFile = join(dataDir, 'index.json'), dbPath = join(dataDir, 'fts.db')
  await mkdir(join(sessionsRoot, 'controlled'), { recursive: true })
  const createdAt = 1_790_000_000_000
  const initial = compress(alpha3Jsonl({ id: 'controlled', createdAt,
    events: [alpha3User('lagretryoriginal complete prior message', 'u0')] }))
  const tail = compress([alpha3EventJson(alpha3Assistant('lagretryappended complete later message', 'a1'), 1, createdAt)])
  const split = tail.length - 3
  await writeFile(file, initial)
  await writeFile(join(root, 'before.zstd'), initial)
  await writeFile(join(root, 'partial.zstd'), Buffer.concat([initial, tail.subarray(0, split)]))
  await writeFile(join(root, 'complete.zstd'), Buffer.concat([initial, tail]))
  const tools: Record<string, Tool> = {}, logs: string[] = [], diagnostics: Record<string, unknown>[] = []
  const cleanups: (() => unknown)[] = []
  let onWatch: (() => void) | undefined, watchDeliveries = 0, watcherClosed = false
  let completedDuringFailedPublication = false
  const ctx = {
    logger: () => ({ info: (message: string) => logs.push(message), warn() {}, error() {} }),
    tools: { register(tool: { name: string }) { tools[tool.name] = tool as unknown as Tool } },
    effect(fn: () => unknown) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup as () => unknown) },
  }
  Object.defineProperty(ctx, 'llm', { get() { throw new Error('Controlled lagging replay must not call a real LLM') } })
  apply(ctx as never, { sessionsRoot, dataDir, indexFile, ftsEnabled: true,
    llmSummaryEnabled: false, retentionDays: 0, maxHits: 10, maxSnippetsPerSession: 3 }, {
    createSessionWatcher: (_root, _debounce, callback) => {
      onWatch = callback
      return { ok: true, close() { watcherClosed = true } }
    },
    onRuntimeDiagnostic: event => {
      diagnostics.push(event)
      if (completeDuringThirdFailure && !completedDuringFailedPublication && event.kind === 'delta'
        && event.phase === 'commit' && event.finalConsistency === 'source_lagging'
        && diagnostics.filter(value => value.kind === 'delta' && value.phase === 'commit'
          && value.finalConsistency === 'source_lagging').length === 3) {
        appendFileSync(file, tail.subarray(split))
        completedDuringFailedPublication = true
      }
    },
  })
  const status = () => tools.session_index_status.execute({})
  const rounds = () => logs.filter(line => line.startsWith('[session-index] auto refresh (')).length
  const dbSnapshot = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      db.exec('BEGIN')
      const cp = db.prepare('SELECT checkpoint_json FROM fts_checkpoints WHERE file=?').get(file) as { checkpoint_json: string } | undefined
      const rows = db.prepare('SELECT anchor_id AS anchorId,event_seq AS eventSeq,role,text,tool_name AS toolName FROM messages WHERE session_file=? ORDER BY event_seq,id').all(file).map(row => ({ ...row }))
      return { checkpoint: cp ? JSON.parse(cp.checkpoint_json) as FtsCheckpoint : null, rows }
    } finally { db.close() }
  }
  const record: Record<string, unknown> = { name, root, watchDeliveries: 0,
    samples: { initial: { bytes: initial.length, sha256: hash(initial) },
      partial: { bytes: initial.length + split, sha256: hash(Buffer.concat([initial, tail.subarray(0, split)])) },
      complete: { bytes: initial.length + tail.length, sha256: hash(Buffer.concat([initial, tail])) } } }
  observations.push(record)
  const close = async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
    record.watchDeliveries = watchDeliveries
    record.autoRefreshLogs = logs.filter(line => line.startsWith('[session-index] auto refresh'))
    record.deltaDiagnostics = diagnostics.filter(event => event.kind === 'delta')
    record.closedWatcher = watcherClosed
    record.completedDuringFailedPublication = completedDuringFailedPublication
  }
  try {
    await waitFor(status, state => state.fts && state.ftsSessions === 1 && state.ftsHealth.messages === 1 &&
      !state.active && !state.sourceLagging && logs.some(line => line.includes('retention disabled')), 'initial real FTS checkpoint')
    assert.ok(onWatch)
    const initialFound = await tools.session_index_search.execute({ mode: 'full', query: 'lagretryoriginal', limit: 5 })
    assert.equal(initialFound.runtime.backend, 'fts')
    const initialHit = initialFound.hits.find((hit: any) => hit.anchorId)
    assert.ok(initialHit?.anchorId)
    const before = dbSnapshot()
    const beforeMeta = loadIndex(indexFile)!.sessions[0]
    assert.ok(before.checkpoint?.complete)
    assert.equal(before.checkpoint.indexedBytes, initial.length)
    assert.equal(before.checkpoint.messageCount, 1)
    record.before = before
    const baselineRounds = rounds()
    const baselineDiagnostics = diagnostics.length
    return { root, file, indexFile, initial, tail, split, tools, status, rounds: () => rounds() - baselineRounds,
      dbSnapshot, before, beforeMeta, initialHit, record, close,
      dbExec(sql: string) { const db = new DatabaseSync(dbPath); try { db.exec(sql) } finally { db.close() } },
      diagnostics: () => diagnostics.slice(baselineDiagnostics),
      async appendPartialAndWatch() {
        await appendFile(file, tail.subarray(0, split))
        assert.equal(watchDeliveries, 0)
        watchDeliveries++
        onWatch!()
      },
      async completeWithoutWatch() { await appendFile(file, tail.subarray(split)); assert.ok(watchDeliveries >= 1) },
      async appendCompleteAndWatch() { await appendFile(file, tail); watchDeliveries++; onWatch!() },
      repeatWatch() { watchDeliveries++; onWatch!() },
    }
  } catch (error) { await close(); throw error }
}

async function assertComplete(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await waitFor(f.status, value => !value.active && !value.sourceLagging &&
    value.ftsHealth.messages === 2 && loadIndex(f.indexFile)?.sessions[0]?.indexedBytes === f.initial.length + f.tail.length,
  'automatic completed frame without a second watch', 25000)
  assert.equal(state.unstableRefreshAttempts, 0)
  const actual = f.dbSnapshot(), meta = loadIndex(f.indexFile)!.sessions[0], fingerprint = await stat(f.file)
  assert.ok(actual.checkpoint?.complete)
  assert.deepEqual(actual.checkpoint, { ...checkpointOf(meta), parserVersion: FTS_PARSER_VERSION, messageCount: 2 })
  assert.equal(actual.checkpoint.size, fingerprint.size)
  assert.equal(actual.checkpoint.indexedBytes, fingerprint.size)
  assert.equal(actual.checkpoint.indexedSeq, 1)
  const full = new SessionIndexBuilder({ root: join(f.root, 'sessions'), indexFile: join(f.root, 'full-index.json'), poolSize: 1 })
  let expected: FtsMessageRow[] = []
  try {
    const report = await full.build({ force: true, collectMessages: true, onSessionParsed: (_file, _meta, rows) => { expected = rows } })
    assert.equal(report.status, 'completed')
  } finally { full.dispose() }
  assert.deepEqual(actual.rows, expected.map(row => ({ anchorId: row.anchorId ?? null, eventSeq: row.eventSeq ?? null,
    role: row.role, text: row.text, toolName: row.toolName })), 'actual committed rows and anchors equal an independent full parse')
  const found = await f.tools.session_index_search.execute({ mode: 'full', query: 'lagretryoriginal', limit: 5 })
  assert.equal(found.runtime.backend, 'fts')
  assert.equal(found.hits[0].anchorId, f.initialHit.anchorId, 'old full anchor must survive partial and subsequent append')
  const added = await f.tools.session_index_search.execute({ mode: 'full', query: 'lagretryappended', limit: 5 })
  assert.equal(added.runtime.backend, 'fts')
  assert.equal(added.hits.length, 1)
  const scroll = await f.tools.session_index_search.execute({ session_id: added.hits[0].sessionId, anchor_id: added.hits[0].anchorId, window: 2 })
  assert.equal(scroll.runtime.backend, 'fts')
  assert.deepEqual(scroll.messages.map((row: any) => row.anchorId), expected.map(row => row.anchorId))
  f.record.complete = { sourceLagging: state.sourceLagging, unstableRefreshAttempts: state.unstableRefreshAttempts,
    automaticRounds: f.rounds(), database: actual, anchorsEqualFull: true, fullSearchBackend: found.runtime.backend, scrollBackend: scroll.runtime.backend }
}

function assertRetainedPartial(f: Awaited<ReturnType<typeof fixture>>, rounds: number): void {
  const { raced: _beforeRaced, ...beforeMeta } = f.beforeMeta
  const { raced: _afterRaced, ...afterMeta } = loadIndex(f.indexFile)!.sessions[0]
  assert.deepEqual(afterMeta, beforeMeta, 'verified incomplete append must preserve all prior complete metadata')
  const commits = f.diagnostics().filter(event => event.kind === 'delta' && event.phase === 'commit'
    && event.finalConsistency === 'source_lagging')
  assert.equal(commits.length, rounds)
  for (const event of commits) {
    assert.equal(event.reasonCode, 'partial_frame')
    assert.equal(event.retainedPrevious, true)
    assert.equal(event.indexAccepted, false)
    assert.equal(event.published, false)
    assert.equal(event.metricsExact, true)
    assert.equal(event.attempt, 4, 'one round retains bounded two delta and two necessary full attempts')
    assert.equal(event.deltaBytes, 2 * f.split)
    assert.equal(event.readBytes, 2 * f.split + 2 * (f.initial.length + f.split), 'all actual delta and fallback reads must close')
    assert.equal(event.finalIndexedBytes, f.initial.length)
  }
  f.record.partialReadClosure = { rounds, deltaAttemptsPerRound: 2, fullAttemptsPerRound: 2,
    deltaBytesPerRound: 2 * f.split, readBytesPerRound: 2 * f.split + 2 * (f.initial.length + f.split),
    oldMetaEqual: true, exact: true }
}

test('public apply retries a stable partial frame and catches up without a second watcher event', { timeout: 45000 }, async () => {
  const f = await fixture('one-event-completion')
  try {
    await f.appendPartialAndWatch()
    const first = await waitFor(f.status, state => !state.active && state.sourceLagging && state.unstableRefreshAttempts === 1,
      'first static half-frame attempt completes')
    const partial = f.dbSnapshot()
    f.record.partial = { sourceLagging: first.sourceLagging, unstableRefreshAttempts: first.unstableRefreshAttempts,
      automaticRounds: f.rounds(), database: partial, indexedBytes: loadIndex(f.indexFile)?.sessions[0]?.indexedBytes }
    assert.deepEqual(partial, f.before, 'a verified partial append must retain the previous complete rows and checkpoint')
    assertRetainedPartial(f, 1)
    assert.ok(f.diagnostics().some(event => event.kind === 'delta' && event.reasonCode === 'partial_frame'))
    await f.completeWithoutWatch()
    await assertComplete(f)
    assert.ok(f.rounds() >= 2 && f.rounds() <= 3, 'completion must use a bounded automatic follow-up round')
    f.record.valid = true
  } finally { await f.close() }
})

test('persistent partial frame stops after three rounds; a later fingerprint change recovers without watcher delivery', { timeout: 65000 }, async () => {
  const f = await fixture('bounded-persistent-partial')
  try {
    await f.appendPartialAndWatch()
    await waitFor(f.status, state => !state.active && state.sourceLagging && state.unstableRefreshAttempts === 1,
      'first static half-frame attempt before duplicate watcher')
    f.repeatWatch()
    const exhausted = await waitFor(f.status, state => !state.active && state.sourceLagging && state.unstableRefreshAttempts === 3,
      'three-round partial-frame budget exhausted', 30000)
    assert.equal(f.rounds(), 3)
    assert.deepEqual(f.dbSnapshot(), f.before, 'persistent partial input must retain the prior complete database')
    assertRetainedPartial(f, 3)
    f.record.exhausted = { sourceLagging: exhausted.sourceLagging, unstableRefreshAttempts: exhausted.unstableRefreshAttempts,
      automaticRounds: f.rounds(), database: f.dbSnapshot() }
    const stablePartial = await readFile(f.file)
    f.repeatWatch()
    await pause(6200)
    const unchanged = await f.status()
    assert.equal(f.rounds(), 3, 'unchanged partial frame must not receive a fourth parse after its retry interval')
    assert.equal(unchanged.sourceLagging, true)
    assert.equal(unchanged.unstableRefreshAttempts, 3)
    assert.equal(unchanged.active, false)
    assert.deepEqual(await readFile(f.file), stablePartial)
    await f.completeWithoutWatch()
    await assertComplete(f)
    assert.ok(f.rounds() > 3 && f.rounds() <= 6, 'a newly observed source fingerprint receives another bounded round budget')
    f.record.valid = true
  } finally { await f.close() }
})

test('completion during the third rejected publication is detected without a watcher event', { timeout: 45000 }, async () => {
  const f = await fixture('complete-during-third-failure', true)
  try {
    await f.appendPartialAndWatch()
    await assertComplete(f)
    assert.equal(f.rounds(), 4, 'the completed fingerprint must receive one recovery build')
    assert.equal(f.diagnostics().filter(event => event.kind === 'delta' && event.phase === 'commit'
      && event.finalConsistency === 'source_lagging').length, 3)
    f.record.valid = true
  } finally { await f.close() }
})

test('writer recovery reopens an exhausted FTS retry budget for unchanged complete source', { timeout: 45000 }, async () => {
  const f = await fixture('unchanged-source-writer-recovery')
  try {
    f.dbExec("CREATE TRIGGER controlled_insert_failure BEFORE INSERT ON messages BEGIN SELECT RAISE(FAIL, 'controlled isolated insertion failure'); END")
    await f.appendCompleteAndWatch()
    const exhausted = await waitFor(f.status, value => !value.active && value.sourceLagging
      && value.unstableRefreshAttempts === 3 && value.lastReport.ftsFailed === 1,
    'three actual SQL insertion failures exhaust automatic budget', 25000)
    assert.equal(f.rounds(), 3)
    assert.deepEqual(f.dbSnapshot(), f.before, 'failed transactions must preserve the old committed FTS checkpoint')
    const sourceBeforeRecovery = await readFile(f.file)
    const worker = exhausted.ftsHealth.worker
    assert.ok(Number.isInteger(worker.writerPid) && worker.writerPid !== process.pid)
    f.record.exhausted = { sourceLagging: true, automaticRounds: f.rounds(),
      writerGeneration: worker.writerGeneration, ftsFailed: exhausted.lastReport.ftsFailed }
    f.dbExec('DROP TRIGGER controlled_insert_failure')
    process.kill(worker.writerPid)
    await waitFor(() => f.status().catch(() => ({} as Record<string, any>)), value => value.ftsHealth?.worker?.writerGeneration > worker.writerGeneration
      && !value.ftsHealth.worker.degraded, 'real writer restart completes', 10000)
    await assertComplete(f)
    assert.equal(f.rounds(), 4, 'the actual worker recovery must schedule one same-source retry')
    assert.deepEqual(await readFile(f.file), sourceBeforeRecovery, 'worker recovery must not require another source write')
    f.record.valid = true
  } finally { await f.close() }
})

after(async () => {
  await mkdir(evidenceRoot, { recursive: true })
  await writeFile(join(evidenceRoot, `RUNTIME_LAGGING_RETRY_CONTINUATION_${evidenceTag}.json`), JSON.stringify({
    scope: 'Controlled public apply; real zstd/parser/SQLite/client, captured watcher only; no production actions',
    exitCode: observations.every(value => value.valid === true && value.closedWatcher === true) ? 0 : 1,
    valid: observations.every(value => value.valid === true && value.closedWatcher === true),
    realRetryIntervalMs: 5000,
    fingerprintPollIntervalMs: 10000,
    observations,
  }, null, 2) + '\n')
})
