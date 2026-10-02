/**
 * Candidate -> approved S6 -> candidate public FtsClient compatibility.
 * The sole input is an inactive, consistent workspace snapshot. Each run creates
 * a unique copy (including WAL/SHM), and never opens production or source logs.
 * Full logical contents are hashed inside the child; no body/identity is emitted.
 */
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

const scriptFile = fileURLToPath(import.meta.url)
const workDir = dirname(dirname(scriptFile)), runtimeRoot = dirname(workDir)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const within = (root, path) => { const part = relative(root, path); return part !== '' && !part.startsWith('..') && !isAbsolute(part) }
const safeCode = error => /^[A-Za-z0-9_]{1,80}$/.test(error?.code ?? '') ? error.code : 'unknown'
const assert = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }) }
const moduleDigest = async directory => Object.fromEntries(await Promise.all(['fts-client.js', 'fts-worker.js', 'fts.js'].map(async name =>
  [name, createHash('sha256').update(await readFile(join(directory, name))).digest('hex')]
)))

async function parent() {
  const sourceDb = resolve(process.argv[2] ?? join(runtimeRoot, 'datasets', 'schema5-snapshot.db'))
  assert(within(join(runtimeRoot, 'datasets'), sourceDb), 'ESNAPSHOTBOUNDARY')
  const runId = randomUUID(), runRoot = join(runtimeRoot, 'datasets', 'rollback-compat-' + runId)
  const evidence = join(runtimeRoot, 'evidence', 'rollback-compat-' + runId), dbPath = join(runRoot, 'fts.db')
  await mkdir(runRoot, { recursive: true }); await mkdir(evidence, { recursive: true })
  const companions = []
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      const source = sourceDb + suffix, info = await stat(source)
      assert(info.isFile(), 'ESNAPSHOTFILE')
      await copyFile(source, dbPath + suffix)
      companions.push({ suffix, bytes: info.size })
    } catch (error) { if (suffix && error.code === 'ENOENT') continue; throw error }
  }
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_OPTIONS
  const child = spawn(process.env.DSH_RUNTIME_EXE ?? 'E:/Program Files (x86)/DSH-D/DeepSeek Harness.exe',
    ['--no-warnings', scriptFile, '--child', dbPath, join(evidence, 'RESULTS.json')],
    { cwd: workDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderrBytes = 0
  child.stdout.on('data', chunk => process.stdout.write(chunk))
  child.stderr.on('data', chunk => { stderrBytes += chunk.length })
  const exit = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code, signal) => accept({ code, signal })) })
  await writeFile(join(evidence, 'BOUNDARY.json'), JSON.stringify({
    runId, input: 'inactive complete schema5 SQLite backup in runtime datasets; main/WAL/SHM copied if present',
    companions, scope: 'public candidate -> approved S6 -> candidate factories on one unique isolated copy',
    sourceLogsRead: false, productionOpened: false, logicalBodiesStored: false,
    ...exit, stderrBytes, rawStderrStored: false,
  }, null, 2) + '\n')
  console.log(JSON.stringify({ evidenceDirectory: evidence, ...exit, stderrBytes }))
  if (exit.code !== 0) process.exitCode = exit.code ?? 1
}

async function child() {
  const [, dbArg, outputArg] = process.argv.slice(2), dbPath = resolve(dbArg), output = resolve(outputArg)
  assert(within(join(runtimeRoot, 'datasets'), dbPath) && basenameIsIsolated(dbPath), 'EISOLATION')
  assert(within(join(runtimeRoot, 'evidence'), output), 'EEVIDENCEBOUNDARY')
  const { DatabaseSync } = await import('node:sqlite')
  const candidateDir = join(workDir, 'lib'), oldDir = join(runtimeRoot, 'baseline', 'S6-20261002', 'lib')
  const [{ createFtsClient: candidateFactory }, { createFtsClient: approvedFactory }, { FTS_PARSER_VERSION }] = await Promise.all([
    import(pathToFileURL(join(candidateDir, 'fts-client.js')).href),
    import(pathToFileURL(join(oldDir, 'fts-client.js')).href),
    import(pathToFileURL(join(candidateDir, 'fts.js')).href),
  ])
  const syntheticFile = join(dirname(dbPath), 'controlled.session.jsonl.zstd')
  const report = { startedAt: new Date().toISOString(), runtime: { node: process.version, electron: process.versions.electron, sqlite: process.versions.sqlite },
    boundary: { publicFactories: true, sourceLogsRead: false, productionOpened: false, identitiesAndBodies: 'in-process digests only',
      controlledWrites: 'one isolated synthetic session: replace then append through candidate syncSession' },
    modules: { candidate: await moduleDigest(candidateDir), approvedS6: await moduleDigest(oldDir) }, phases: [], checks: {} }
  const beganAt = performance.now()
  let active

  // SQL is only read through this isolated copy. Bodies never enter report/stdout.
  function logicalSnapshot() {
    const at = performance.now(), db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      db.exec('PRAGMA query_only=ON')
      const hashedRows = (sql, parameters = []) => {
        const hash = createHash('sha256'); let rows = 0
        for (const row of db.prepare(sql).iterate(...parameters)) { hash.update(JSON.stringify(row) + '\n'); rows++ }
        return { rows, sha256: hash.digest('hex') }
      }
      const counts = { schema: db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get().value,
        sessions: db.prepare('SELECT COUNT(*) n FROM sessions').get().n, messages: db.prepare('SELECT COUNT(*) n FROM messages').get().n,
        chunks: db.prepare('SELECT COUNT(*) n FROM message_chunks').get().n, checkpoints: db.prepare('SELECT COUNT(*) n FROM fts_checkpoints').get().n }
      const result = { counts, sourceOrderIndex: !!db.prepare("SELECT 1 present FROM sqlite_master WHERE name='idx_messages_source_order'").get(),
        sessions: hashedRows('SELECT * FROM sessions ORDER BY file'), messages: hashedRows('SELECT * FROM messages ORDER BY id'),
        chunks: hashedRows('SELECT * FROM message_chunks ORDER BY id'), checkpoints: hashedRows('SELECT * FROM fts_checkpoints ORDER BY file'),
        state: hashedRows('SELECT * FROM state_meta ORDER BY key'),
        originalSessions: hashedRows('SELECT * FROM sessions WHERE file<>? ORDER BY file', [syntheticFile]),
        originalMessages: hashedRows('SELECT * FROM messages WHERE session_file<>? ORDER BY id', [syntheticFile]),
        originalChunks: hashedRows('SELECT c.* FROM message_chunks c JOIN messages m ON m.id=c.message_id WHERE m.session_file<>? ORDER BY c.id', [syntheticFile]),
        originalCheckpoints: hashedRows('SELECT * FROM fts_checkpoints WHERE file<>? ORDER BY file', [syntheticFile]) }
      result.snapshotMs = performance.now() - at
      return result
    } finally { db.close() }
  }
  const sameOriginal = (left, right) => ['originalSessions', 'originalMessages', 'originalChunks', 'originalCheckpoints', 'state'].every(key => digest(left[key]) === digest(right[key]))
  const sameLogical = (left, right) => ['counts', 'sessions', 'messages', 'chunks', 'checkpoints', 'state'].every(key => digest(left[key]) === digest(right[key]))
  const safeHit = hit => ({ messageId: hit.messageId, anchor: digest(hit.anchorId ?? null), session: digest(hit.sessionId), file: digest(hit.sessionFile),
    eventSeq: hit.eventSeq, role: hit.role, tool: digest(hit.toolName), body: digest(hit.text), snippet: digest(hit.snippet), matchCount: hit.matchCount })
  const safeAround = value => ({ ok: value.ok, reason: value.reason,
    messages: value.messages.map(row => ({ id: row.id, anchor: digest(row.anchorId ?? null), seq: row.eventSeq, role: row.role, body: digest(row.text), tool: digest(row.toolName) })),
    bookends: Object.fromEntries(Object.entries(value.bookends).map(([key, rows]) => [key, rows.map(row => ({ id: row.id, anchor: digest(row.anchorId ?? null), role: row.role, body: digest(row.text) }))])) })
  async function publicReads(client, label) {
    const began = performance.now(), page = await client.searchPage('session', '', 5, { role: 'assistant' })
    assert(page.hits.length >= 2 && page.hits.every(hit => hit.role === 'assistant' && hit.anchorId), 'ESEARCHIDENTITY')
    const scrolls = []
    for (const hit of page.hits.slice(0, 2)) {
      const result = await client.around(hit.sessionId, hit.anchorId, 3)
      assert(result.ok && result.messages.some(row => row.anchorId === hit.anchorId && row.id === hit.messageId), 'EANCHORIDENTITY')
      scrolls.push(safeAround(result))
    }
    const controlled = await client.search('rollbackcompatneedle', '', 5)
    assert(controlled.length === 2 && controlled.every(hit => hit.sessionId === 'rollback-controlled' && hit.anchorId), 'ECONTROLLEDSEARCH')
    const controlledAround = await client.around('rollback-controlled', 'rollback-controlled:2', 3)
    assert(controlledAround.ok && controlledAround.messages.length === 2, 'ECONTROLLEDANCHOR')
    const files = (await client.listSessionFiles()).sort(), checkpoints = []
    for (const file of files) checkpoints.push(await client.getCheckpoint(file))
    assert(files.length === 332 && checkpoints.every(Boolean), 'ECHECKPOINTCOUNT')
    const checkpoint = await client.getCheckpoint(syntheticFile)
    assert(checkpoint?.messageCount === 2 && checkpoint.indexedSeq === 2 && checkpoint.complete, 'ECONTROLLEDCHECKPOINT')
    const result = { label, requestMs: performance.now() - began, backend: 'fts', total: page.total, totalExact: page.totalExact,
      hits: page.hits.map(safeHit), scrolls, controlledHits: controlled.map(safeHit), controlledAround: safeAround(controlledAround),
      files: files.length, filesDigest: digest(files), checkpoints: checkpoints.length, checkpointsDigest: digest(checkpoints),
      controlledCheckpointDigest: digest(checkpoint), worker: { restarts: client.diagnostics().restarts,
        pendingRequests: client.diagnostics().pendingRequests, pendingWrites: client.diagnostics().pendingWrites,
        activeStreams: client.diagnostics().activeStreams } }
    assert(result.worker.restarts === 0 && result.worker.pendingRequests === 0 && result.worker.pendingWrites === 0 && result.worker.activeStreams === 0, 'ETRANSPORTSTATE')
    return result
  }
  const equivalentReads = (left, right) => ['total', 'totalExact', 'hits', 'scrolls', 'controlledHits', 'controlledAround', 'files', 'filesDigest',
    'checkpoints', 'checkpointsDigest', 'controlledCheckpointDigest'].every(key => digest(left[key]) === digest(right[key]))
  try {
    report.before = logicalSnapshot()
    assert(report.before.counts.schema === '5' && report.before.counts.sessions === 331 && report.before.counts.messages === 47092 &&
      report.before.counts.chunks === 47870 && report.before.counts.checkpoints === 331, 'EDATASETCOUNT')
    const startup = [], readyAt = performance.now()
    active = await candidateFactory(dbPath, { onStartupProgress: event => startup.push(event) }); assert(active, 'ECANDIDATEFACTORY')
    report.candidateReadyMs = performance.now() - readyAt
    const meta = { file: syntheticFile, id: 'rollback-controlled', workspace: 'C:/Controlled', title: 'Controlled rollback', agentPreset: '', createdAt: 1, lastTime: 2 }
    const fingerprint = { file: syntheticFile, sessionId: meta.id, size: 100, mtimeMs: 1, ctimeMs: 1, indexedBytes: 100, indexedSeq: 1, complete: true }
    const first = await active.syncSession({ meta, sourceFingerprint: fingerprint, parserVersion: FTS_PARSER_VERSION, mode: 'replace',
      messages: [{ sessionFile: syntheticFile, role: 'assistant', text: 'rollbackcompatneedle first', toolName: '', anchorId: 'rollback-controlled:1', eventSeq: 1 }] })
    await active.syncSession({ meta, sourceFingerprint: { ...fingerprint, size: 200, mtimeMs: 2, indexedBytes: 200, indexedSeq: 2 }, parserVersion: FTS_PARSER_VERSION,
      mode: 'append', expectedBase: first.checkpoint,
      messages: [{ sessionFile: syntheticFile, role: 'assistant', text: 'rollbackcompatneedle second', toolName: '', anchorId: 'rollback-controlled:2', eventSeq: 2 }] })
    report.phases.push(await publicReads(active, 'candidate-after-controlled-append'))
    await active.close(); active = undefined
    report.afterCandidate = logicalSnapshot()
    report.checks.expressionIndexInstalled = report.afterCandidate.sourceOrderIndex
    report.checks.originalLogicalDataPreserved = sameOriginal(report.before, report.afterCandidate)
    report.checks.controlledCounts = report.afterCandidate.counts.sessions === 332 && report.afterCandidate.counts.messages === 47094 &&
      report.afterCandidate.counts.chunks === 47872 && report.afterCandidate.counts.checkpoints === 332

    const oldReadyAt = performance.now(); active = await approvedFactory(dbPath); assert(active, 'EAPPROVEDFACTORY')
    report.approvedReadyMs = performance.now() - oldReadyAt
    report.phases.push(await publicReads(active, 'approved-S6-reads-candidate-data'))
    await active.close(); active = undefined
    report.afterApproved = logicalSnapshot()
    report.checks.approvedS6ReadsEquivalent = equivalentReads(report.phases[0], report.phases[1])
    report.checks.approvedS6PreservesLogicalData = sameLogical(report.afterCandidate, report.afterApproved)
    report.checks.approvedS6PreservesExpressionIndex = report.afterApproved.sourceOrderIndex

    const reopening = [], reopenAt = performance.now()
    active = await candidateFactory(dbPath, { onStartupProgress: event => reopening.push(event) }); assert(active, 'ECANDIDATEREOPEN')
    report.candidateReopenMs = performance.now() - reopenAt
    report.phases.push(await publicReads(active, 'candidate-reopens-after-approved-S6'))
    await active.close(); active = undefined
    report.afterReopen = logicalSnapshot()
    report.checks.candidateReopensWithoutMigration = !reopening.some(event => event.state === 'migrating')
    report.checks.candidateReadsStillEquivalent = equivalentReads(report.phases[0], report.phases[2])
    report.checks.candidateReopenPreservesLogicalData = sameLogical(report.afterApproved, report.afterReopen)
    report.valid = Object.values(report.checks).every(Boolean)
  } catch (error) { report.valid = false; report.errorCode = safeCode(error) }
  finally {
    if (active) try { await active.close() } catch (error) { report.closeErrorCode = safeCode(error) }
    report.totalMs = performance.now() - beganAt
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ valid: report.valid, checks: report.checks, errorCode: report.errorCode, closeErrorCode: report.closeErrorCode,
      candidateReadyMs: report.candidateReadyMs, approvedReadyMs: report.approvedReadyMs, candidateReopenMs: report.candidateReopenMs, totalMs: report.totalMs }))
    if (!report.valid || report.closeErrorCode) process.exitCode = 1
  }
}
function basenameIsIsolated(dbPath) { return dirname(dbPath).startsWith(join(runtimeRoot, 'datasets', 'rollback-compat-')) }

try { if (process.argv[2] === '--child') await child(); else await parent() }
catch (error) { console.log(JSON.stringify({ valid: false, errorCode: safeCode(error) })); process.exitCode = 1 }
