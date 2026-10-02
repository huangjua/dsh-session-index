#!/usr/bin/env node
// Explicit offline-bookmark migration. No DSH initialization, schema changes, or body reads.
import { createHash } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const usage = `Default: dry run. Run only against a consistent, stopped-writer snapshot.
node scripts/production-bookmark-migration.mjs --candidate <release-dir> --bookmarks <jsonl>
  --fts-db <preserved-offline-fts.db> --report <new-report.json>
Apply additionally requires --apply --backup <unique-backup.jsonl>
  --expect-source-sha256 <dry-run-sourceHash> --ack-stopped-writers all
The FTS database is opened readOnly and never upgraded. Numeric messageId is never a seq.`

function parseArgs(argv) {
  const args = { apply: false }
  const allowed = new Set(['candidate', 'bookmarks', 'fts-db', 'report', 'backup', 'expect-source-sha256', 'ack-stopped-writers'])
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help') return { help: true }
    if (arg === '--apply') { args.apply = true; continue }
    const key = arg.slice(2)
    if (!arg.startsWith('--') || !allowed.has(key) || args[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error('EARGS: unknown, repeated, or incomplete option')
    }
    args[key] = argv[++index]
  }
  for (const key of ['candidate', 'bookmarks', 'fts-db', 'report']) if (!args[key]) throw new Error(`EARGS: --${key} required`)
  if (args.apply && (!args.backup || !/^[a-f0-9]{64}$/i.test(args['expect-source-sha256'] ?? '') || args['ack-stopped-writers'] !== 'all')) {
    throw new Error('EARGS: apply requires a unique backup, expected source hash, and stopped-writer acknowledgment')
  }
  if (!args.apply && (args.backup || args['expect-source-sha256'] || args['ack-stopped-writers'])) throw new Error('EARGS: apply-only options in dry run')
  for (const key of ['candidate', 'bookmarks', 'fts-db', 'report', 'backup']) if (args[key]) args[key] = resolve(args[key])
  return args
}

async function missing(path) {
  try { await stat(path); return false } catch (error) { if (error.code === 'ENOENT') return true; throw error }
}

async function writeNew(path, text) {
  const file = await open(path, 'wx')
  try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { process.stdout.write(usage + '\n'); return }
  if (!(await stat(args.bookmarks)).isFile()) throw new Error('EINPUT: bookmarks must be an existing file')
  if (!(await stat(args['fts-db'])).isFile()) throw new Error('EINPUT: evidence database must be an existing file')
  if (!(await stat(dirname(args.report))).isDirectory() || !(await missing(args.report))) throw new Error('EOUTPUT: report requires an existing directory and a new filename')
  const { migrateBookmarks, normalizeBookmark } = await import(pathToFileURL(resolve(args.candidate, 'lib/bookmark.js')).href)
  const { withFileLock, canonicalFilePath, atomicWriteText } = await import(pathToFileURL(resolve(args.candidate, 'lib/sidecar.js')).href)
  const inputPath = await canonicalFilePath(args.bookmarks)
  const evidencePath = await canonicalFilePath(args['fts-db'])
  const reportPath = await canonicalFilePath(args.report)
  if (reportPath === inputPath || reportPath === evidencePath) throw new Error('EOUTPUT: report must be separate from inputs')
  if (args.apply) {
    const backupPath = await canonicalFilePath(args.backup)
    if ([inputPath, evidencePath, reportPath].includes(backupPath) || !(await missing(args.backup)) || !(await stat(dirname(args.backup))).isDirectory()) {
      throw new Error('EBACKUP: backup requires a separate, unused filename in an existing directory')
    }
  }
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(evidencePath, { readOnly: true })
  let transaction = false
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0; BEGIN')
    transaction = true
    const tableNames = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name))
    const sessionColumns = tableNames.has('sessions') ? new Set(database.prepare('PRAGMA table_info(sessions)').all().map(row => row.name)) : new Set()
    const messageColumns = tableNames.has('messages') ? new Set(database.prepare('PRAGMA table_info(messages)').all().map(row => row.name)) : new Set()
    const canFindSession = sessionColumns.has('id') && sessionColumns.has('file')
    const hasIdentity = ['session_file', 'anchor_id', 'identity_evidence'].every(column => messageColumns.has(column))
    const schemaVersion = tableNames.has('state_meta') ? String(database.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get()?.value ?? '') : ''
    const diagnosticCounts = {}
    const diagnostic = reason => { diagnosticCounts[reason] = (diagnosticCounts[reason] ?? 0) + 1 }
    const resolver = async bookmark => {
      const answer = (status, reason, extra = {}) => { diagnostic(reason); return { status, ...extra } }
      if (!canFindSession) return answer('unresolved', 'evidence-database-without-session-identity')
      const sessions = database.prepare('SELECT file FROM sessions WHERE id=?').all(bookmark.sessionId)
      if (sessions.length === 0) return answer('session-missing', 'session-not-in-preserved-database')
      if (sessions.length !== 1) return answer('ambiguous', 'multiple-session-files')
      if (!hasIdentity) return answer('unresolved', 'legacy-schema-without-persisted-anchor-evidence')
      const proof = bookmark.legacyEvidence
      if (!proof || typeof proof.anchorId !== 'string' || !proof.anchorId || typeof proof.identityEvidence !== 'string' || !proof.identityEvidence) {
        return answer('unresolved', 'bookmark-without-persisted-anchor-evidence')
      }
      // Historical rowid is intentionally unused. Both persisted identity fields must match.
      const matches = database.prepare('SELECT anchor_id,identity_evidence FROM messages WHERE session_file=? AND anchor_id=?').all(sessions[0].file, proof.anchorId)
      if (matches.length > 1) return answer('ambiguous', 'multiple-anchor-candidates')
      if (!matches.length || matches[0].identity_evidence !== proof.identityEvidence) return answer('anchor-replaced', 'persisted-anchor-evidence-no-longer-matches')
      return answer('resolved', 'unique-persisted-anchor-evidence', { anchorId: proof.anchorId, evidence: proof.identityEvidence })
    }
    let migration
    let backupPath
    if (!args.apply) migration = await migrateBookmarks(inputPath, resolver, { dryRun: true })
    else {
      // Hold the same cross-process bookmark lock while checking the expected hash and applying
      // the existing migration planner. The planner's dry-run path does not acquire another lock.
      migration = await withFileLock(inputPath, async actualPath => {
        const original = await readFile(actualPath, 'utf8')
        const hash = createHash('sha256').update(original).digest('hex')
        if (hash !== args['expect-source-sha256'].toLowerCase()) throw new Error('ESOURCECHANGED: run dry-run again; source hash differs')
        const plan = await migrateBookmarks(actualPath, resolver, { dryRun: true })
        if (plan.sourceHash !== hash) throw new Error('ESOURCECHANGED: source changed despite bookmark lock')
        const lines = original.split('\n')
        for (const entry of plan.entries) {
          const index = entry.line - 1
          const object = JSON.parse(lines[index])
          const bookmark = normalizeBookmark(object)
          const anchorId = entry.status === 'resolved' ? bookmark.legacyEvidence.anchorId : undefined
          lines[index] = JSON.stringify({ ...object, v: 2, anchorId,
            anchorStatus: entry.status === 'session' ? 'session' : anchorId ? 'resolved' : 'unresolved',
            unresolvedReason: entry.reason })
        }
        if (plan.entries.length) {
          await writeNew(args.backup, original)
          backupPath = args.backup
          await atomicWriteText(actualPath, lines.join('\n'))
        }
        return { ...plan, dryRun: false, changed: plan.entries.length > 0 }
      })
    }
    database.exec('COMMIT')
    transaction = false
    const report = { ...migration, generatedAt: new Date().toISOString(), tool: 'production-bookmark-migration-v1',
      evidenceDatabase: { path: evidencePath, readOnly: true, schemaVersion, hasPersistedIdentityColumns: hasIdentity },
      diagnosticCounts, ...(backupPath ? { backupPath } : {}),
      limitations: ['No numeric rowid-to-seq inference.', 'Only persisted anchorId plus identical identityEvidence permits resolution.',
        'Database snapshot must be preserved before any schema migration or FTS rebuild.', 'No session bodies are read or included.'] }
    await writeNew(args.report, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(JSON.stringify({ dryRun: report.dryRun, records: report.records, counts: report.counts,
      sourceHash: report.sourceHash, schemaVersion, diagnosticCounts, report: args.report, ...(backupPath ? { backupPath } : {}) }) + '\n')
  } finally {
    if (transaction) { try { database.exec('ROLLBACK') } catch {} }
    database.close()
  }
}

main().catch(error => {
  // Error messages contain paths/status only, never bookmark labels, notes, or session bodies.
  process.stderr.write(`${error.code ?? 'EMIGRATION'}: ${error.message}\n`)
  process.exitCode = 1
})
