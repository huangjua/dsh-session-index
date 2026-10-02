// S3 synthetic migration audit. No default DSH or production directory is consulted.
// Usage: node scripts/migration-dry-run.mjs [compiledDirectory=.test-build/src]
//        [report=validation/MIGRATION_DRY_RUN.json]
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsPromises, { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const checkout = fileURLToPath(new URL('../', import.meta.url))
const validation = resolve(checkout, 'validation')
function isWithin(root, path) {
  const part = relative(resolve(root), resolve(path))
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}
function fixturePath(path) {
  assert.ok(isWithin(validation, path), `Refusing a path outside the checkout validation directory: ${path}`)
  return resolve(path)
}
for (const variable of ['DSH_HOME', 'TEMP', 'TMP']) {
  assert.ok(process.env[variable] && isAbsolute(process.env[variable]), `${variable} must explicitly be an absolute isolated directory`)
  fixturePath(process.env[variable])
}
const modules = resolve(checkout, process.argv[2] ?? '.test-build/src')
assert.ok(isWithin(checkout, modules), 'Compiled modules must be inside this checkout')
const output = fixturePath(resolve(checkout, process.argv[3] ?? 'validation/MIGRATION_DRY_RUN.json'))
await mkdir(dirname(output), { recursive: true })
const evidenceDirectory = fixturePath(join(validation, 'MIGRATION_EVIDENCE'))
await mkdir(evidenceDirectory, { recursive: true })
const fixtureRoot = fixturePath(await mkdtemp(join(evidenceDirectory, 'synthetic-')))
const { migrateBookmarks, parseBookmarkLines, readBookmarks } = await import(pathToFileURL(join(modules, 'bookmark.js')).href)
const { createSessionFts, SessionFts } = await import(pathToFileURL(join(modules, 'fts.js')).href)
const { messageIdentity } = await import(pathToFileURL(join(modules, 'message-anchor.js')).href)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const normalizePath = (value) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
const log = []
const checks = []
const report = {
  version: 1, generatedAt: new Date().toISOString(), node: process.version,
  scope: 'synthetic-fixtures-only', productionDataRead: false, productionDataWritten: false,
  status: 'running', fixtureRoot, compiledDirectory: modules, reportPath: output,
  environment: Object.fromEntries(['DSH_HOME', 'TEMP', 'TMP'].map(name => [name, process.env[name]])),
  checks, failures: [], schemaMigration: {}, bookmarkMigration: {},
  limits: [
    'Counts describe freshly generated synthetic records, not production bookmarks.',
    'A historical numeric rowid is never evidence by itself.',
    'Resolved fixtures persist both the exact stable anchor and the exact source identity evidence.',
    'The interrupted bookmark case injects a rename failure after backup fsync; it does not kill a real host.',
  ],
}
let engine
let lookup
function passed(name, details = {}) {
  checks.push({ name, passed: true, ...details })
  log.push(`PASS ${name}`)
}
function dbRows(path, sql, ...args) {
  fixturePath(path)
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare(sql).all(...args).map(row => ({ ...row })) }
  finally { db.close() }
}
function oldVersion(path) {
  return String(dbRows(path, "SELECT value FROM state_meta WHERE key='schema_version'")[0].value)
}

const legacyText = 'schema2-head Äbc 😀😀 ' + 'x'.repeat(5200) + ' schema2-tail'
const legacySessions = [
  { file: join(fixtureRoot, 'sources', 'legacy-a.zstd'), id: 'legacy-a', workspace: '/Synthetic/Ärea', title: 'legacy title A', agent_preset: 'fake', created_at: 100, last_time: 300, updated_at: 301 },
  { file: join(fixtureRoot, 'sources', 'legacy-b.zstd'), id: 'legacy-b', workspace: '/Synthetic/B', title: 'legacy title B', agent_preset: 'fake', created_at: 101, last_time: 302, updated_at: 303 },
]
function createSchema2(path) {
  fixturePath(path)
  const db = new DatabaseSync(path)
  try {
    db.exec(`
CREATE TABLE sessions(file TEXT PRIMARY KEY,id TEXT NOT NULL,workspace TEXT NOT NULL,title TEXT NOT NULL,
  agent_preset TEXT NOT NULL,created_at INTEGER NOT NULL,last_time INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_file TEXT NOT NULL,role TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',tool_name TEXT NOT NULL DEFAULT '');
CREATE INDEX idx_messages_session ON messages(session_file);
CREATE VIRTUAL TABLE messages_fts_trigram USING fts5(text,tool_name,
  content='messages',content_rowid='id',tokenize='trigram');
CREATE TRIGGER messages_fts_trigram_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts_trigram(rowid,text,tool_name) VALUES(new.id,new.text,new.tool_name);
END;
CREATE TRIGGER messages_fts_trigram_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts_trigram(messages_fts_trigram,rowid,text,tool_name)
    VALUES('delete',old.id,old.text,old.tool_name);
END;
CREATE TABLE state_meta(key TEXT PRIMARY KEY,value TEXT);
INSERT INTO state_meta VALUES('schema_version','2');
INSERT INTO state_meta VALUES('last_optimize','1600000000000');
INSERT INTO state_meta VALUES('synthetic_custom_state','preserve-me');`)
    const insertSession = db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)')
    for (const session of legacySessions) insertSession.run(...Object.values(session))
    const insertMessage = db.prepare('INSERT INTO messages(session_file,role,text,tool_name) VALUES(?,?,?,?)')
    insertMessage.run(legacySessions[0].file, 'user', legacyText, '')
    insertMessage.run(legacySessions[1].file, 'tool', '', 'legacy-tool')
    insertMessage.run(legacySessions[0].file, 'assistant', 'schema2-last assistant', '')
  } finally { db.close() }
}
function snapshotLegacy(path) {
  return {
    version: oldVersion(path),
    sessions: dbRows(path, 'SELECT file,id,workspace,title,agent_preset,created_at,last_time,updated_at FROM sessions ORDER BY file'),
    messages: dbRows(path, 'SELECT id,session_file,role,text,tool_name FROM messages ORDER BY id'),
    customState: dbRows(path, "SELECT key,value FROM state_meta WHERE key!='schema_version' ORDER BY key"),
  }
}
function stableRow(sessionId, seq, type, sourceId, text, toolName = '') {
  const role = type === 'tool/call' ? 'tool' : type.startsWith('user/') ? 'user' : 'assistant'
  const data = type === 'user/message' ? { id: sourceId } : type === 'tool/call' ? { callId: sourceId } : { message: { id: sourceId } }
  return { sessionFile: join(fixtureRoot, 'sources', `${sessionId}.zstd`), role, text, toolName,
    ...messageIdentity(sessionId, 3, { seq, type, data }, text, toolName) }
}
async function insertSession(id, rows) {
  const file = join(fixtureRoot, 'sources', `${id}.zstd`)
  await engine.upsertSession({ file, id, workspace: '/Synthetic', title: `synthetic ${id}`, agentPreset: 'fake', createdAt: 1000, lastTime: 2000 })
  await engine.syncMessages(file, rows, false)
}

try {
  report.sourceHashes = {}
  for (const name of ['bookmark.ts', 'fts.ts', 'core.ts', 'query-plan.ts', 'message-anchor.ts', 'sidecar.ts', 'cancel.ts', 'session-compat.ts']) {
    report.sourceHashes[name] = hash(await readFile(join(checkout, 'src', name)))
  }
  report.compiledHashes = {}
  for (const name of ['bookmark.js', 'fts.js', 'core.js', 'query-plan.js', 'message-anchor.js', 'sidecar.js']) {
    report.compiledHashes[name] = hash(await readFile(join(modules, name)))
  }
  const dbPath = fixturePath(join(fixtureRoot, 'schema2.db'))
  createSchema2(dbPath)
  const before = snapshotLegacy(dbPath)
  assert.equal(before.version, '2')
  engine = await createSessionFts(dbPath)
  assert.ok(engine?.ok, 'schema2 migration must produce an available engine')
  const after = snapshotLegacy(dbPath)
  assert.equal(after.version, '5')
  assert.deepEqual(after.messages, before.messages)
  assert.deepEqual(after.sessions, before.sessions)
  assert.deepEqual(after.customState, before.customState)
  const identities = dbRows(dbPath, 'SELECT anchor_id,event_seq,event_type,source_message_id,call_id,generation,identity_evidence FROM messages ORDER BY id')
  assert.ok(identities.every(row => Object.values(row).every(value => value === null)), 'legacy numeric rowids cannot be reinterpreted as source identity')
  const chunks = Number(dbRows(dbPath, 'SELECT COUNT(*) AS n FROM message_chunks')[0].n)
  assert.ok(chunks > before.messages.length)
  for (const query of ['schema2-tail', 'äbc', '😀😀']) assert.equal((await engine.searchPage(query, '', 10)).total, 1, query)
  const around = await engine.around('legacy-a', 1, 1)
  assert.ok(around.ok)
  assert.deepEqual(around.messages.map(row => row.id), [1, 3], 'A/B/A legacy rows retain same-session numeric neighbors')
  assert.equal((await engine.resolveLegacyAnchor('legacy-a', 1)).reason, 'unresolved-no-source-identity')
  report.schemaMigration = {
    from: '2', to: '5', databasePath: dbPath, originalSessions: before.sessions.length,
    originalMessages: before.messages.length, originalRowsPreserved: true,
    legacyIdentityColumnsRemainNull: true, chunks, legacyNumericNeighbors: around.messages.map(row => row.id),
    originalSnapshotHash: hash(JSON.stringify(before)), migratedOriginalFieldsHash: hash(JSON.stringify({ ...after, version: '2' })),
  }
  passed('schema2-to-5-preserves-original-fields-and-row-order')
  passed('legacy-numeric-scroll-remains-rowid-without-invented-eventSeq')
  passed('schema2-full-text-backfill-covers-tail-and-unicode')

  const verified = [
    stableRow('verified', 0, 'user/message', 'source-u', 'verified message'),
    stableRow('verified', 1, 'tool/call', 'source-call', '', 'verified-tool'),
    stableRow('verified', 2, 'assistant/message', 'source-a', 'verified assistant'),
  ]
  const ambiguous = [stableRow('ambiguous', 0, 'user/message', 'same-source', 'duplicate identity'), stableRow('ambiguous', 1, 'user/message', 'same-source', 'duplicate identity')]
  const replaced = stableRow('replaced', 0, 'user/message', 'old-source', 'old replaced source')
  await insertSession('verified', verified)
  await insertSession('ambiguous', ambiguous)
  await insertSession('replaced', [stableRow('replaced', 1, 'user/message', 'new-source', 'replacement current source')])
  await engine.flush()
  lookup = new DatabaseSync(dbPath, { readOnly: true })
  const currentIds = lookup.prepare('SELECT id FROM messages WHERE session_file=? ORDER BY event_seq').all(verified[0].sessionFile).map(row => Number(row.id))
  assert.equal((await engine.around('verified', verified[0].anchorId)).ok, true)
  assert.equal((await engine.around('verified', currentIds[0])).ok, false, 'new anchored messages do not acquire implicit numeric aliases')
  const legacy = (id, sessionId, messageId, extra = {}) => ({
    v: 1, id, sessionId, sessionFile: join(fixtureRoot, 'sources', `${sessionId}.zstd`), messageId,
    label: `标签 ${id}`, note: `备注\n${id} "quoted"`, title: `title ${id}`, workspace: '/Synthetic',
    createdAt: 1700000000000, updatedAt: 1700000000123, tags: ['保持', id],
    custom: { keep: true, original: id, nested: [1, { value: 'unchanged' }] }, ...extra,
  })
  const evidence = row => ({ anchorId: row.anchorId, identityEvidence: row.identityEvidence })
  const proven = legacy('proven', 'verified', 777, { legacyEvidence: evidence(verified[0]), legacyBinding: { originalRowid: 777, sourceSnapshot: 'synthetic-durable-map' } })
  const records = [
    proven,
    legacy('no-proof', 'verified', currentIds[2]),
    legacy('ambiguous', 'ambiguous', 900, { legacyEvidence: evidence(ambiguous[0]) }),
    legacy('session-missing', 'missing', 901, { legacyEvidence: { anchorId: 'a1:missing', identityEvidence: 'missing' } }),
    legacy('anchor-replaced', 'replaced', 902, { legacyEvidence: evidence(replaced) }),
    legacy('session-only', 'verified', null),
    { ...legacy('already-migrated', 'verified', 903), v: 2, anchorId: verified[1].anchorId, anchorStatus: 'resolved' },
    legacy('wrong-evidence', 'verified', 904, { legacyEvidence: { anchorId: verified[0].anchorId, identityEvidence: 'not-the-source-evidence' } }),
    legacy('missing-anchor-proof', 'verified', currentIds[0], { legacyEvidence: { identityEvidence: verified[0].identityEvidence } }),
    { ...proven, note: 'latest duplicate note', updatedAt: 1700000000999, custom: { ...proven.custom, revision: 2 } },
  ]
  // Keep an empty physical line and no trailing newline as additional preservation boundaries.
  const original = records.map((record, index) => `${index === 2 ? '\n' : ''}${JSON.stringify(record)}`).join('\n')
  const bookmarkPath = fixturePath(join(fixtureRoot, 'bookmarks.jsonl'))
  const backupPath = fixturePath(join(fixtureRoot, 'bookmarks-before.jsonl'))
  await writeFile(bookmarkPath, original, 'utf8')
  const resolver = async bookmark => {
    const sessions = lookup.prepare('SELECT file FROM sessions WHERE id=?').all(bookmark.sessionId)
    if (!sessions.length) return { status: 'session-missing' }
    if (sessions.length !== 1) return { status: 'ambiguous' }
    const anchor = bookmark.legacyEvidence?.anchorId
    if (!anchor) {
      const current = await engine.resolveLegacyAnchor(bookmark.sessionId, bookmark.messageId)
      return current.anchorId ? { status: 'resolved', anchorId: current.anchorId, evidence: current.evidence } : { status: 'unresolved' }
    }
    const rows = lookup.prepare('SELECT anchor_id,identity_evidence FROM messages WHERE session_file=? AND anchor_id=?').all(sessions[0].file, anchor)
    if (!rows.length) return { status: 'anchor-replaced' }
    if (rows.length !== 1) return { status: 'ambiguous' }
    return { status: 'resolved', anchorId: String(rows[0].anchor_id), evidence: String(rows[0].identity_evidence) }
  }
  const dryRun = await migrateBookmarks(bookmarkPath, resolver)
  assert.equal(await readFile(bookmarkPath, 'utf8'), original)
  assert.equal(dryRun.sourceHash, hash(original))
  assert.deepEqual(dryRun.counts, { resolved: 2, unresolved: 3, ambiguous: 1, 'session-missing': 1, 'anchor-replaced': 1, session: 1, alreadyMigrated: 1 })
  assert.equal(dryRun.records, records.length)
  assert.ok(!(await readdir(fixtureRoot)).includes('bookmarks-before.jsonl'), 'dry run must not create a backup')
  passed('bookmark-dry-run-is-byte-identical-and-does-not-create-backup')
  passed('bookmark-all-resolution-statuses-are-real-database-lookups', { counts: dryRun.counts })

  const applied = await migrateBookmarks(bookmarkPath, resolver, { dryRun: false, backupPath })
  const migratedText = await readFile(bookmarkPath, 'utf8')
  const physical = migratedText.split('\n').filter(line => line.trim()).map(line => JSON.parse(line))
  assert.equal(await readFile(backupPath, 'utf8'), original)
  assert.equal(physical.length, records.length)
  assert.deepEqual(physical.map(record => record.id), records.map(record => record.id))
  for (let index = 0; index < records.length; index++) {
    for (const [key, value] of Object.entries(records[index])) {
      if (key === 'v') continue
      assert.deepEqual(physical[index][key], value, `record ${index + 1} preserved field ${key}`)
    }
    assert.equal(physical[index].v, 2)
  }
  assert.equal(physical[0].anchorId, verified[0].anchorId)
  for (const index of [1, 2, 3, 4, 7, 8]) assert.equal(physical[index].anchorStatus, 'unresolved')
  const effective = await readBookmarks(bookmarkPath)
  assert.equal(effective.skippedBad, 0)
  assert.equal(effective.bookmarks.find(record => record.id === 'proven').note, 'latest duplicate note')
  assert.equal(parseBookmarkLines(original).skippedBad, 0)
  const repeated = await migrateBookmarks(bookmarkPath, resolver, { dryRun: false, backupPath })
  assert.equal(repeated.counts.alreadyMigrated, records.length)
  assert.equal(await readFile(bookmarkPath, 'utf8'), migratedText)
  assert.equal(await readFile(backupPath, 'utf8'), original)
  passed('bookmark-apply-preserves-physical-order-duplicates-fields-notes-tags-times-and-ids')
  passed('bookmark-apply-retains-an-exact-unique-backup')
  passed('bookmark-repeat-is-byte-identical-and-does-not-overwrite-backup')
  report.bookmarkMigration = { sourcePath: bookmarkPath, backupPath, physicalRecords: records.length,
    effectiveRecords: effective.bookmarks.length, dryRun, applied, repeated,
    originalHash: hash(original), backupHash: hash(await readFile(backupPath)), migratedHash: hash(migratedText),
    allOriginalFieldsPreserved: true, physicalOrderPreserved: true, idempotent: true }

  const interruptedPath = fixturePath(join(fixtureRoot, 'interrupted-bookmarks.jsonl'))
  const interruptedBackup = fixturePath(join(fixtureRoot, 'interrupted-before.jsonl'))
  await writeFile(interruptedPath, original)
  const originalRename = fsPromises.rename
  let injections = 0
  fsPromises.rename = async (from, to) => {
    if (normalizePath(String(to)) === normalizePath(interruptedPath)) {
      injections++
      throw Object.assign(new Error('Synthetic interruption after backup fsync and before source rename'), { code: 'EMIGRATIONINJECTED' })
    }
    return originalRename(from, to)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(migrateBookmarks(interruptedPath, resolver, { dryRun: false, backupPath: interruptedBackup }), error => error.code === 'EMIGRATIONINJECTED')
  } finally { fsPromises.rename = originalRename; syncBuiltinESMExports() }
  assert.equal(injections, 1)
  assert.equal(await readFile(interruptedPath, 'utf8'), original)
  assert.equal(await readFile(interruptedBackup, 'utf8'), original)
  const interruptionRetry = await migrateBookmarks(interruptedPath, resolver, { dryRun: false, backupPath: interruptedBackup })
  assert.equal(await readFile(interruptedPath, 'utf8'), migratedText)
  assert.equal(await readFile(interruptedBackup, 'utf8'), original)
  const interruptionAgain = await migrateBookmarks(interruptedPath, resolver, { dryRun: false, backupPath: interruptedBackup })
  assert.equal(interruptionAgain.counts.alreadyMigrated, records.length)
  report.bookmarkMigration.interruptedRetry = { sourcePath: interruptedPath, backupPath: interruptedBackup,
    injectedFailures: injections, sourceUnchangedAfterFailure: true, backupUnchangedAcrossRetry: true,
    retry: interruptionRetry, repeated: interruptionAgain }
  passed('bookmark-interruption-after-backup-fsync-retains-original-source-and-reuses-identical-backup')

  const protectedSource = fixturePath(join(fixtureRoot, 'protected-bookmarks.jsonl'))
  const protectedBackup = fixturePath(join(fixtureRoot, 'protected-backup.jsonl'))
  await writeFile(protectedSource, original)
  await writeFile(protectedBackup, 'other protected synthetic backup\n')
  await assert.rejects(migrateBookmarks(protectedSource, resolver, { dryRun: false, backupPath: protectedBackup }), error => error.code === 'EEXIST')
  assert.equal(await readFile(protectedSource, 'utf8'), original)
  assert.equal(await readFile(protectedBackup, 'utf8'), 'other protected synthetic backup\n')
  await assert.rejects(migrateBookmarks(protectedSource, resolver, { dryRun: false, backupPath: protectedSource }), /separate file/)
  passed('bookmark-different-backup-and-source-as-backup-are-rejected-without-overwrite')

  const corruptPath = fixturePath(join(fixtureRoot, 'corrupt-bookmarks.jsonl'))
  const corruptOriginal = JSON.stringify(records[0]) + '\n{broken-json\n'
  await writeFile(corruptPath, corruptOriginal)
  await assert.rejects(migrateBookmarks(corruptPath, resolver), /EBOOKMARKCORRUPT/)
  await assert.rejects(migrateBookmarks(corruptPath, resolver, { dryRun: false, backupPath: fixturePath(join(fixtureRoot, 'corrupt-before.jsonl')) }), /EBOOKMARKCORRUPT/)
  assert.equal(await readFile(corruptPath, 'utf8'), corruptOriginal)
  passed('bookmark-corrupt-physical-record-is-diagnostic-and-never-overwritten')

  // Inject after one chunk INSERT has already run, inside the actual schema migration transaction.
  const faultDbPath = fixturePath(join(fixtureRoot, 'schema2-interrupted.db'))
  createSchema2(faultDbPath)
  const faultOriginal = snapshotLegacy(faultDbPath)
  let chunkInsertAttempts = 0
  class InterruptedDatabase {
    constructor(path) { this.inner = new DatabaseSync(fixturePath(path)) }
    exec(sql) { return this.inner.exec(sql) }
    close() { this.inner.close() }
    prepare(sql) {
      const statement = this.inner.prepare(sql)
      return {
        get: (...args) => statement.get(...args), all: (...args) => statement.all(...args),
        run: (...args) => {
          if (/^INSERT INTO message_chunks\(/.test(sql) && ++chunkInsertAttempts === 2) throw Object.assign(new Error('Synthetic schema migration interruption during second chunk INSERT'), { code: 'EMIGRATIONINJECTED' })
          return statement.run(...args)
        },
      }
    }
  }
  const interruptedEngine = new SessionFts(faultDbPath, InterruptedDatabase)
  assert.equal(interruptedEngine.ok, false)
  assert.equal(chunkInsertAttempts, 2)
  assert.deepEqual(snapshotLegacy(faultDbPath), faultOriginal)
  assert.equal(dbRows(faultDbPath, "SELECT name FROM sqlite_master WHERE name='message_chunks'").length, 0)
  const retriedEngine = await createSessionFts(faultDbPath)
  assert.ok(retriedEngine?.ok)
  try {
    assert.equal(retriedEngine.health().schemaVersion, '5')
    assert.deepEqual(snapshotLegacy(faultDbPath).messages, faultOriginal.messages)
    assert.equal((await retriedEngine.searchPage('schema2-tail', '', 10)).total, 1)
  } finally { await retriedEngine.close() }
  report.schemaMigration.interruptedRetry = { databasePath: faultDbPath, failedChunkInsertAttempt: chunkInsertAttempts,
    schemaAfterFailure: '2', originalRowsAfterFailurePreserved: true, partialChunkTableRolledBack: true, schemaAfterRetry: '5' }
  passed('schema2-interruption-rolls-back-partial-chunks-and-retries-to-5')

  lookup.close(); lookup = undefined
  await engine.close(); engine = undefined
  const reopened = await createSessionFts(dbPath)
  assert.ok(reopened?.ok)
  try {
    assert.equal(reopened.health().schemaVersion, '5')
    assert.deepEqual((await reopened.around('verified', verified[0].anchorId, 1)).messages.map(row => row.eventSeq), [0, 1])
    assert.equal((await reopened.around('verified', currentIds[0], 1)).ok, false)
  } finally { await reopened.close() }
  passed('schema5-reopen-retains-stable-anchor-order-and-does-not-reinterpret-numeric-rowid')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.failures.push({ name: error.name, message: error.message, stack: error.stack })
  log.push(`FAIL ${error.stack ?? String(error)}`)
  process.exitCode = 1
} finally {
  lookup?.close()
  await engine?.close().catch(error => { report.failures.push({ phase: 'close', message: String(error) }); report.status = 'failed'; process.exitCode = 1 })
  report.completedAt = new Date().toISOString()
  report.checkCount = checks.length
  const evidenceLog = fixturePath(join(fixtureRoot, 'migration-checks.log'))
  report.evidenceLog = evidenceLog
  await writeFile(evidenceLog, `${log.join('\n')}\n`)
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ status: report.status, checkCount: checks.length, reportPath: output,
    fixtureRoot, schema: report.schemaMigration.to, counts: report.bookmarkMigration.dryRun?.counts, failures: report.failures }, null, 2)}\n`)
}
