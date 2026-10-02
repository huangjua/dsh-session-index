/**
 * Explicit read-only production audit. Does not start a host, migrate a schema,
 * import SessionFts, read source log bytes or select message/chunk text.
 * The only write is one new, exclusively-created E-drive evidence JSON file.
 * Run only after the root agent chooses a stable observation point.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const implementation = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const expectedImplementation = 'E:\\Do Something\\DSH备份\\dsh-session-index work\\implementation-session-index'
const productionData = 'E:\\Do Something\\DSH备份\\session-index-data'
const sessionsRoot = 'C:\\Users\\admin\\.dsh\\sessions'
const legacyCIndex = 'C:\\Users\\admin\\.dsh\\session-index'
const runtime = 'G:\\AI-Agent\\deepseek harness\\dsh-session-index'
const candidate = join(expectedImplementation, 'release', 'S6-20261002')
const evidence = join(expectedImplementation, 'DEPLOYMENT_RESULTS')
// This is the candidate's src/fts.ts contract, not an imported writer factory.
const parserVersion = 'session-index/3-chunks'
const report = { generatedAt: new Date().toISOString(), auditSucceeded: false }
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase()
const inside = (root, file) => {
  const part = relative(root, file)
  return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep)
}
const digest = async file => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
const count = (db, sql) => Number(db.prepare(sql).get().n)
const fingerprint = meta => ({ file: meta.file, sessionId: meta.id, size: meta.size,
  mtimeMs: meta.mtimeMs, ctimeMs: meta.ctimeMs ?? -1,
  indexedBytes: meta.indexedBytes ?? meta.size, indexedSeq: meta.indexedSeq,
  complete: !meta.detailMissing && !meta.unindexable && meta.coverage?.complete !== false })
const checkpointValid = value => value && typeof value === 'object' && !Array.isArray(value) &&
  typeof value.file === 'string' && typeof value.sessionId === 'string' &&
  ['size', 'mtimeMs', 'ctimeMs', 'indexedBytes', 'messageCount'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key])) &&
  typeof value.complete === 'boolean' && typeof value.parserVersion === 'string' &&
  (value.indexedSeq === undefined || Number.isSafeInteger(value.indexedSeq))

try {
  if (!samePath(implementation, expectedImplementation)) throw Object.assign(new Error(), { code: 'EAUDITROOT' })
  const state = JSON.parse(await readFile(join(evidence, 'S7_STATE.json'), 'utf8'))
  if (!samePath(state.productionData, productionData) || !samePath(state.runtime, runtime) || !samePath(state.candidate, candidate)) {
    throw Object.assign(new Error(), { code: 'EAUDITSTATE' })
  }
  const expectedBookmark = state.dataBefore?.['bookmarks.jsonl']
  const bookmarkFile = join(productionData, 'bookmarks.jsonl')
  const bookmarkStart = await stat(bookmarkFile)
  const bookmarkStartHash = await digest(bookmarkFile)
  report.bookmarks = { bytes: bookmarkStart.size, zeroBytes: bookmarkStart.size === 0,
    deploymentSnapshotWasZeroBytes: expectedBookmark?.bytes === 0,
    hashMatchesDeploymentSnapshot: bookmarkStartHash === expectedBookmark?.sha256 }
  try { await stat(legacyCIndex); report.legacyCIndexAbsent = false }
  catch (error) { if (error?.code !== 'ENOENT') throw error; report.legacyCIndexAbsent = true }

  const manifestFile = join(candidate, 'SHA256.json')
  const hashes = JSON.parse(await readFile(manifestFile, 'utf8'))
  const deployed = Object.entries(hashes).filter(([file]) => file.startsWith('lib/') || ['package.json', 'README.md', 'README_zh.md'].includes(file))
  report.deployed = { expectedFiles: 69, manifestFiles: deployed.length, matchedFiles: 0, mismatchedFiles: 0, unavailableFiles: 0,
    manifestMatchesApprovedSha256: await digest(manifestFile) === state.candidateManifestSha256 }
  for (const [file, expected] of deployed) {
    const path = resolve(runtime, file)
    if (!inside(runtime, path)) throw Object.assign(new Error(), { code: 'EAUDITMANIFEST' })
    try { if (await digest(path) === expected) report.deployed.matchedFiles++; else report.deployed.mismatchedFiles++ }
    catch { report.deployed.unavailableFiles++ }
  }
  report.deployed.all69Match = report.deployed.manifestMatchesApprovedSha256 && deployed.length === 69 &&
    report.deployed.matchedFiles === 69 && report.deployed.mismatchedFiles === 0 && report.deployed.unavailableFiles === 0

  const indexFile = join(productionData, 'index.json')
  const indexBytes = await readFile(indexFile)
  const indexStartHash = createHash('sha256').update(indexBytes).digest('hex')
  const index = JSON.parse(indexBytes.toString('utf8'))
  if (!Array.isArray(index.sessions)) throw Object.assign(new Error(), { code: 'EAUDITINDEXSHAPE' })
  report.json = { entries: index.sessions.length, rootMatchesOfficialSessions: samePath(index.root, sessionsRoot),
    invalidEntries: 0, duplicateSourceEntries: 0, dirtyEntries: 0, incompleteEntries: 0, detailMissingEntries: 0, unindexableEntries: 0,
    databaseSessionMissingEntries: 0, databaseCheckpointMissingEntries: 0 }
  const metas = []
  const byFile = new Map()
  for (const meta of index.sessions) {
    if (!meta || typeof meta.file !== 'string' || typeof meta.id !== 'string' ||
        !['size', 'mtimeMs'].every(key => typeof meta[key] === 'number' && Number.isFinite(meta[key]))) {
      report.json.invalidEntries++; continue
    }
    metas.push(meta)
    if (byFile.has(meta.file)) report.json.duplicateSourceEntries++
    byFile.set(meta.file, meta)
    if (meta.ftsDirty) report.json.dirtyEntries++
    if (meta.coverage?.complete === false) report.json.incompleteEntries++
    if (meta.detailMissing) report.json.detailMissingEntries++
    if (meta.unindexable) report.json.unindexableEntries++
  }

  const db = new DatabaseSync(join(productionData, 'fts.db'), { readOnly: true })
  let snapshot = false
  try {
    // Connection-local settings only; no DDL, DML, optimization or checkpoint PRAGMA.
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2500; BEGIN')
    snapshot = true
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name))
    const schemaValue = tables.has('state_meta') ? db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get()?.value : undefined
    report.database = { queryOnly: Number(db.prepare('PRAGMA query_only').get().query_only) === 1,
      schemaVersion: typeof schemaValue === 'string' && /^\d+$/.test(schemaValue) ? Number(schemaValue) : null,
      sessions: tables.has('sessions') ? count(db, 'SELECT COUNT(*) AS n FROM sessions') : null,
      messages: tables.has('messages') ? count(db, 'SELECT COUNT(*) AS n FROM messages') : null,
      checkpoints: tables.has('fts_checkpoints') ? count(db, 'SELECT COUNT(*) AS n FROM fts_checkpoints') : null,
      chunks: tables.has('message_chunks') ? count(db, 'SELECT COUNT(*) AS n FROM message_chunks') : null,
      chunkedMessages: tables.has('message_chunks') ? count(db, 'SELECT COUNT(DISTINCT message_id) AS n FROM message_chunks') : null,
      missingRequiredTables: ['sessions', 'messages', 'fts_checkpoints', 'message_chunks'].filter(table => !tables.has(table)).length }
    const sessions = new Map(tables.has('sessions') ? db.prepare('SELECT file, id FROM sessions').all().map(row => [row.file, row.id]) : [])
    const messages = new Map(tables.has('messages') ? db.prepare('SELECT session_file, COUNT(*) AS n FROM messages GROUP BY session_file').all().map(row => [row.session_file, Number(row.n)]) : [])
    const checkpoints = new Map()
    report.checkpoints = { valid: 0, invalid: 0, orphanToJson: 0, eligibleJsonEntries: 0, fullyConvergedEntries: 0,
      candidateNeedsSyncEntries: 0, fingerprintMatchedEntries: 0, fingerprintMismatchedEntries: 0,
      indexedBytesMatchedEntries: 0, indexedBytesMismatchedEntries: 0, indexedSeqMatchedEntries: 0, indexedSeqMismatchedEntries: 0,
      parserVersionMatchedEntries: 0, parserVersionMismatchedEntries: 0, messageCountMatchedEntries: 0, messageCountMismatchedEntries: 0,
      sessionIdentityMatchedEntries: 0, sessionIdentityMismatchedEntries: 0 }
    for (const row of tables.has('fts_checkpoints') ? db.prepare('SELECT file, checkpoint_json FROM fts_checkpoints').all() : []) {
      let value
      try { value = JSON.parse(row.checkpoint_json) } catch {}
      if (!checkpointValid(value) || value.file !== row.file) { report.checkpoints.invalid++; continue }
      report.checkpoints.valid++
      if (!byFile.has(row.file)) report.checkpoints.orphanToJson++
      checkpoints.set(row.file, value)
    }
    for (const meta of metas) {
      if (!sessions.has(meta.file)) report.json.databaseSessionMissingEntries++
      const checkpoint = checkpoints.get(meta.file)
      if (!checkpoint) report.json.databaseCheckpointMissingEntries++
      const eligible = !meta.detailMissing && !meta.unindexable
      if (eligible) report.checkpoints.eligibleJsonEntries++
      if (!checkpoint) { if (eligible) report.checkpoints.candidateNeedsSyncEntries++; continue }
      const expected = fingerprint(meta)
      const checks = {
        fingerprint: ['file', 'sessionId', 'size', 'mtimeMs', 'ctimeMs', 'complete'].every(key => checkpoint[key] === expected[key]),
        indexedBytes: checkpoint.indexedBytes === expected.indexedBytes,
        indexedSeq: checkpoint.indexedSeq === expected.indexedSeq,
        parserVersion: checkpoint.parserVersion === parserVersion,
        messageCount: checkpoint.messageCount === (messages.get(meta.file) ?? 0),
        sessionIdentity: sessions.get(meta.file) === checkpoint.sessionId,
      }
      for (const [name, equal] of Object.entries(checks)) report.checkpoints[`${name}${equal ? 'Matched' : 'Mismatched'}Entries`]++
      const converged = Object.values(checks).every(Boolean) && !meta.ftsDirty
      if (eligible && converged) report.checkpoints.fullyConvergedEntries++
      if (eligible && !converged) report.checkpoints.candidateNeedsSyncEntries++
    }
    report.database.orphanSessionsToJson = [...sessions.keys()].filter(file => !byFile.has(file)).length
    report.database.orphanMessageSourcesToSessions = [...messages.keys()].filter(file => !sessions.has(file)).length
    report.database.orphanChunks = tables.has('message_chunks') && tables.has('messages') ? count(db,
      'SELECT COUNT(*) AS n FROM message_chunks c LEFT JOIN messages m ON m.id=c.message_id WHERE m.id IS NULL') : null
    db.exec('ROLLBACK')
    snapshot = false
  } finally {
    if (snapshot) { try { db.exec('ROLLBACK') } catch {} }
    db.close()
  }

  report.sources = { indexedEntriesChecked: 0, unchanged: 0, changed: 0, missing: 0, unavailable: 0,
    outsideApprovedRoot: 0, nonRegularFiles: 0, rootAvailable: true }
  let actualRoot
  try { actualRoot = await realpath(sessionsRoot) }
  catch { report.sources.rootAvailable = false }
  for (const meta of metas) {
    report.sources.indexedEntriesChecked++
    if (!isAbsolute(meta.file) || !inside(sessionsRoot, resolve(meta.file))) { report.sources.outsideApprovedRoot++; continue }
    if (!actualRoot) { report.sources.unavailable++; continue }
    try {
      const actual = await realpath(meta.file)
      if (!inside(actualRoot, actual)) { report.sources.outsideApprovedRoot++; continue }
      const info = await stat(actual)
      if (!info.isFile()) { report.sources.nonRegularFiles++; continue }
      if (info.size === meta.size && info.mtimeMs === meta.mtimeMs && info.ctimeMs === (meta.ctimeMs ?? -1)) report.sources.unchanged++
      else report.sources.changed++
    } catch (error) { if (error?.code === 'ENOENT') report.sources.missing++; else report.sources.unavailable++ }
  }
  const bookmarkEnd = await stat(bookmarkFile)
  report.bookmarks.hashUnchangedDuringAudit = bookmarkStartHash === await digest(bookmarkFile) && bookmarkStart.size === bookmarkEnd.size
  report.json.unchangedDuringAudit = indexStartHash === await digest(indexFile)
  report.observation = { sqlSnapshotConsistent: true, jsonAndSqlNotAtomic: true,
    sourceCheckIsStatOnly: true, stableJsonDuringAudit: report.json.unchangedDuringAudit }
  report.auditSucceeded = true
} catch (error) {
  // Never persist error messages/stacks, which may contain paths, IDs or SQL.
  report.error = { name: typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name) ? error.name : 'Error',
    code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,60}$/.test(error.code) ? error.code : 'UNSPECIFIED' }
}

const filename = `LIVE_DB_AUDIT_${report.generatedAt.replace(/[^0-9]/g, '')}_${randomUUID()}.json`
try {
  await writeFile(join(evidence, filename), JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  console.log(JSON.stringify(report))
  if (!report.auditSucceeded) process.exitCode = 1
} catch {
  console.error(JSON.stringify({ generatedAt: report.generatedAt, auditSucceeded: false, reportWriteFailed: true }))
  process.exitCode = 1
}
