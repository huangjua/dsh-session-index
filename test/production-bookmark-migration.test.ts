import { it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const cli = resolve('scripts/production-bookmark-migration.mjs')
const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
const old = (id: string, sessionId = 'session') => ({ v: 1, id, sessionId, sessionFile: '/synthetic/session',
  messageId: 999, label: 'private-label-sentinel', note: 'private-note-sentinel', title: 'private-title-sentinel',
  workspace: '/synthetic', createdAt: 1, updatedAt: 2, tags: ['preserved'], custom: { preserved: true } })
const proof = (id: string, anchorId: string, identityEvidence = 'durable-proof') => ({ ...old(id),
  legacyEvidence: { anchorId, identityEvidence } })

function within(parent: string, path: string): boolean {
  const part = relative(resolve(parent), resolve(path))
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

interface Fixture { root: string; candidate: string; bookmarks: string; database: string; original: string }
async function fixture(schema: 2 | 5, records: unknown[], work: (fixture: Fixture) => Promise<void>): Promise<void> {
  const validation = resolve('validation')
  for (const key of ['DSH_HOME', 'TEMP', 'TMP', 'DSH_SESSION_INDEX_DATA_DIR', 'DSH_SESSION_INDEX_SESSIONS_ROOT']) {
    assert.ok(process.env[key] && within(validation, process.env[key]!), `${key} must be explicitly isolated`)
  }
  const root = await mkdtemp(join(process.env.TEMP!, 's7-bookmark-cli-'))
  assert.ok(within(validation, root))
  const candidate = process.env.S6_RELEASE_DIR ? resolve(process.env.S6_RELEASE_DIR) : join(root, 'candidate')
  if (!process.env.S6_RELEASE_DIR) {
    await mkdir(join(candidate, 'lib'), { recursive: true })
    await writeFile(join(candidate, 'package.json'), '{"type":"module"}')
    for (const name of ['bookmark.js', 'sidecar.js']) await copyFile(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), join(candidate, 'lib', name))
  }
  for (const name of ['dsh-home', 'data', 'sessions']) await mkdir(join(root, name))
  const bookmarks = join(root, 'bookmarks.jsonl'), database = join(root, 'fts.db')
  const original = records.map(value => JSON.stringify(value)).join('\n') + (records.length ? '\n' : '')
  await writeFile(bookmarks, original)
  const db = new DatabaseSync(database)
  try {
    db.exec(`CREATE TABLE state_meta(key TEXT PRIMARY KEY,value TEXT);
      INSERT INTO state_meta VALUES('schema_version','${schema}');
      CREATE TABLE sessions(file TEXT PRIMARY KEY,id TEXT);
      INSERT INTO sessions VALUES('/synthetic/session','session');`)
    if (schema === 2) db.exec(`CREATE TABLE messages(id INTEGER PRIMARY KEY,session_file TEXT,text TEXT);
      INSERT INTO messages VALUES(999,'/synthetic/session','private-body-sentinel');`)
    else {
      db.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY,session_file TEXT,anchor_id TEXT,identity_evidence TEXT,text TEXT)')
      const insert = db.prepare('INSERT INTO messages(session_file,anchor_id,identity_evidence,text) VALUES(?,?,?,?)')
      for (const [anchor, evidence] of [['stable', 'durable-proof'], ['ambiguous', 'durable-proof'], ['ambiguous', 'durable-proof'], ['replaced', 'different-proof']]) {
        insert.run('/synthetic/session', anchor, evidence, 'private-body-sentinel')
      }
    }
  } finally { db.close() }
  try { await work({ root, candidate, bookmarks, database, original }) }
  finally {
    assert.ok(within(validation, root)); assert.equal(dirname(root), resolve(process.env.TEMP!))
    assert.ok(basename(root).startsWith('s7-bookmark-cli-'))
    await rm(root, { recursive: true, force: true })
  }
}

function run(f: Fixture, reportName: string, options: string[] = []) {
  const report = join(f.root, reportName)
  const result = spawnSync(process.execPath, [cli, '--candidate', f.candidate, '--bookmarks', f.bookmarks,
    '--fts-db', f.database, '--report', report, ...options], { cwd: resolve('.'), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, DSH_HOME: join(f.root, 'dsh-home'), TEMP: f.root, TMP: f.root,
      DSH_SESSION_INDEX_DATA_DIR: join(f.root, 'data'), DSH_SESSION_INDEX_SESSIONS_ROOT: join(f.root, 'sessions') } })
  assert.equal(result.error, undefined)
  return { ...result, report }
}
function applyOptions(f: Fixture, backupName: string, sourceHash: string) {
  return ['--apply', '--backup', join(f.root, backupName), '--expect-source-sha256', sourceHash, '--ack-stopped-writers', 'all']
}
async function assertMissing(path: string): Promise<void> { await assert.rejects(readFile(path), { code: 'ENOENT' }) }
function noPrivateText(text: string): void {
  for (const sentinel of ['private-body-sentinel', 'private-label-sentinel', 'private-note-sentinel', 'private-title-sentinel']) assert.ok(!text.includes(sentinel))
}

it('production CLI defaults to read-only dry-run; schema2 numeric rowid never becomes eventSeq or anchor evidence', async () => {
  await fixture(2, [old('numeric'), proof('preexisting-proof', 'stable')], async f => {
    const databaseBefore = hash(await readFile(f.database))
    const result = run(f, 'dry-run.json')
    assert.equal(result.status, 0, result.stderr)
    const text = await readFile(result.report, 'utf8'), report = JSON.parse(text)
    assert.equal(report.dryRun, true); assert.equal(report.records, 2); assert.equal(report.counts.unresolved, 2)
    assert.equal(report.counts.resolved, 0); assert.equal(report.evidenceDatabase.schemaVersion, '2')
    assert.equal(report.evidenceDatabase.hasPersistedIdentityColumns, false)
    assert.equal(report.diagnosticCounts['legacy-schema-without-persisted-anchor-evidence'], 2)
    assert.equal(report.sourceHash, hash(f.original)); assert.equal(await readFile(f.bookmarks, 'utf8'), f.original)
    assert.equal(hash(await readFile(f.database)), databaseBefore)
    noPrivateText(text + result.stdout + result.stderr)
    const readonly = new DatabaseSync(f.database, { readOnly: true })
    try { assert.equal(readonly.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get()?.value, '2') }
    finally { readonly.close() }
  })
})

it('production CLI requires unique persisted anchor and exact evidence, reports ambiguity/missing/replaced, and preserves physical records on apply', async () => {
  const records = [proof('proven', 'stable'), proof('proven', 'stable'), proof('duplicate-anchor', 'ambiguous'),
    old('missing-session', 'missing'), proof('wrong-proof', 'replaced'), old('without-evidence'),
    { ...old('session-bookmark'), messageId: null }, { ...old('already-migrated'), v: 2, anchorId: 'stable' }]
  await fixture(5, records, async f => {
    const databaseBefore = hash(await readFile(f.database))
    const dry = run(f, 'dry-run.json'); assert.equal(dry.status, 0, dry.stderr)
    const plan = JSON.parse(await readFile(dry.report, 'utf8'))
    assert.deepEqual(plan.counts, { resolved: 2, unresolved: 1, ambiguous: 1, 'session-missing': 1,
      'anchor-replaced': 1, session: 1, alreadyMigrated: 1 })
    const applied = run(f, 'apply.json', applyOptions(f, 'unique-backup.jsonl', plan.sourceHash))
    assert.equal(applied.status, 0, applied.stderr)
    const reportText = await readFile(applied.report, 'utf8'), report = JSON.parse(reportText)
    assert.equal(report.dryRun, false); assert.equal(report.changed, true); assert.deepEqual(report.counts, plan.counts)
    assert.equal(await readFile(join(f.root, 'unique-backup.jsonl'), 'utf8'), f.original)
    const migratedText = await readFile(f.bookmarks, 'utf8')
    const migrated = migratedText.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(migrated.length, records.length)
    for (let index = 0; index < records.length; index++) {
      const before = records[index]
      for (const key of ['id', 'sessionId', 'sessionFile', 'messageId', 'label', 'note', 'title', 'workspace', 'createdAt', 'updatedAt', 'tags', 'custom']) {
        assert.deepEqual(migrated[index][key], (before as Record<string, unknown>)[key])
      }
    }
    assert.equal(migrated[0].anchorId, 'stable'); assert.equal(migrated[0].messageId, 999)
    for (const index of [2, 3, 4, 5]) { assert.equal(migrated[index].anchorId, undefined); assert.equal(migrated[index].anchorStatus, 'unresolved') }
    assert.equal(hash(await readFile(f.database)), databaseBefore)
    noPrivateText(reportText + applied.stdout + applied.stderr)
    const again = run(f, 'again.json', applyOptions(f, 'unused-new-backup.jsonl', hash(migratedText)))
    assert.equal(again.status, 0, again.stderr)
    const againReport = JSON.parse(await readFile(again.report, 'utf8'))
    assert.equal(againReport.counts.alreadyMigrated, 8); assert.equal(againReport.changed, false)
    assert.equal(await readFile(f.bookmarks, 'utf8'), migratedText)
    await assertMissing(join(f.root, 'unused-new-backup.jsonl'))
  })
})

it('production CLI rejects changed source, missing apply acknowledgments, and existing unique backup/report without touching bookmarks', async () => {
  await fixture(5, [proof('proven', 'stable')], async f => {
    const wrongHash = run(f, 'wrong-hash.json', applyOptions(f, 'wrong-hash-backup.jsonl', '0'.repeat(64)))
    assert.notEqual(wrongHash.status, 0); assert.match(wrongHash.stderr, /ESOURCECHANGED/)
    await assertMissing(join(f.root, 'wrong-hash-backup.jsonl')); await assertMissing(wrongHash.report)
    const noAck = run(f, 'no-ack.json', ['--apply', '--backup', join(f.root, 'no-ack-backup.jsonl'), '--expect-source-sha256', hash(f.original)])
    assert.notEqual(noAck.status, 0); assert.match(noAck.stderr, /EARGS/)
    const backup = join(f.root, 'existing-backup.jsonl'); await writeFile(backup, 'unique-sentinel')
    const existingBackup = run(f, 'backup-rejected.json', applyOptions(f, 'existing-backup.jsonl', hash(f.original)))
    assert.notEqual(existingBackup.status, 0); assert.match(existingBackup.stderr, /EBACKUP/)
    assert.equal(await readFile(backup, 'utf8'), 'unique-sentinel')
    const report = join(f.root, 'existing-report.json'); await writeFile(report, 'report-sentinel')
    const existingReport = run(f, 'existing-report.json', applyOptions(f, 'must-not-create.jsonl', hash(f.original)))
    assert.notEqual(existingReport.status, 0); assert.match(existingReport.stderr, /EOUTPUT/)
    assert.equal(await readFile(report, 'utf8'), 'report-sentinel'); await assertMissing(join(f.root, 'must-not-create.jsonl'))
    assert.equal(await readFile(f.bookmarks, 'utf8'), f.original)
  })
})

it('production CLI refuses malformed JSONL and missing evidence database; it never creates a replacement database', async () => {
  await fixture(5, [old('original')], async f => {
    const corrupt = f.original + '{"note":"private-note-sentinel"\n'
    await writeFile(f.bookmarks, corrupt)
    const rejected = run(f, 'corrupt.json', applyOptions(f, 'corrupt-backup.jsonl', hash(corrupt)))
    assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /EBOOKMARKCORRUPT/)
    assert.equal(await readFile(f.bookmarks, 'utf8'), corrupt); await assertMissing(join(f.root, 'corrupt-backup.jsonl'))
    noPrivateText(rejected.stdout + rejected.stderr)
    const missingDatabase = join(f.root, 'missing.db')
    const absent = run({ ...f, database: missingDatabase }, 'missing-db.json')
    assert.notEqual(absent.status, 0); await assertMissing(missingDatabase); await assertMissing(absent.report)
    assert.equal(await readFile(f.bookmarks, 'utf8'), corrupt)
  })
})
