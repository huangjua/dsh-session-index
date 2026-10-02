import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createSessionFts } from '../src/fts.js'
import type { FtsMigrationProgress } from '../src/fts.js'

async function legacyDatabase(rows = 250) {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-sql-migration-')), path = join(dir, 'fts.db')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE state_meta(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO state_meta VALUES('schema_version','2');
    CREATE TABLE sessions(file TEXT PRIMARY KEY,id TEXT NOT NULL DEFAULT '',workspace TEXT NOT NULL DEFAULT '',title TEXT NOT NULL DEFAULT '',agent_preset TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL DEFAULT 0,last_time INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL DEFAULT 0,parent_session TEXT NOT NULL DEFAULT '');
    INSERT INTO sessions(file,id,workspace) VALUES('/legacy','legacy','C:/MiXeD');
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_file TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',tool_name TEXT NOT NULL DEFAULT '');
    BEGIN`)
  const insert = db.prepare("INSERT INTO messages(session_file,role,text) VALUES('/legacy','user',?)")
  for (let i = 0; i < rows; i++) insert.run(`migrationneedle ${i} ` + 'x'.repeat(500))
  db.exec('COMMIT'); db.close()
  return path
}

it('schema2 reports completed real batches; schema5 reopen changes no rows and performs no migration', async () => {
  const path = await legacyDatabase(), progress: FtsMigrationProgress[] = []
  const f = await createSessionFts(path, { throwOnError: true, onMigrationProgress: p => progress.push(p) })
  assert.ok(f)
  try {
    assert.equal(f.health().schemaVersion, '5')
    assert.deepEqual(progress.filter(p => p.phase === 'chunks').map(p => p.completed), [0, 100, 200, 250])
    assert.ok(progress.filter(p => p.phase === 'chunks').every(p => p.total === 250))
    assert.ok(progress.every((p, i) => p.elapsedMs >= 0 && (!i || p.elapsedMs >= progress[i - 1].elapsedMs)))
    assert.equal((await f.searchPage('migrationneedle', 'mixed', 5)).hits.length, 1)
  } finally { await f.close() }
  progress.length = 0
  const reopened = await createSessionFts(path, { throwOnError: true, onMigrationProgress: p => progress.push(p) })
  assert.ok(reopened)
  try {
    const db = (reopened as unknown as { db: DatabaseSync }).db
    assert.equal((db.prepare('SELECT total_changes() AS n').get() as {n:number}).n, 0)
    assert.deepEqual(progress, [])
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM message_chunks').get() as {n:number}).n, 250)
    assert.equal((db.prepare("SELECT search_workspace FROM sessions WHERE file='/legacy'").get() as {search_workspace:string}).search_workspace, 'c:/mixed')
  } finally { await reopened.close() }
})

it('migration interruption rolls back schema/chunks/version together; public factory can then safely retry', async () => {
  const path = await legacyDatabase()
  await assert.rejects(createSessionFts(path, { throwOnError: true, onMigrationProgress: p => {
    if (p.phase === 'chunks' && p.completed === 100) throw new Error('controlled batch interruption')
  } }), /controlled batch interruption/)
  const old = new DatabaseSync(path, {readOnly:true})
  try {
    assert.equal((old.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get() as {value:string}).value, '2')
    assert.equal((old.prepare('SELECT COUNT(*) AS n FROM messages').get() as {n:number}).n, 250)
    assert.equal(old.prepare("SELECT name FROM sqlite_master WHERE name='message_chunks'").get(), undefined)
    assert.ok(!(old.prepare('PRAGMA table_info(messages)').all() as {name:string}[]).some(c => c.name === 'anchor_id'))
  } finally { old.close() }
  const f = await createSessionFts(path, {throwOnError:true}); assert.ok(f)
  try { assert.equal(f.health().schemaVersion, '5'); assert.equal(f.health().messages, 250) }
  finally { await f.close() }
})

it('migration lock wait is real contention with unchanged work counts and a bounded deadline', async () => {
  const path = await legacyDatabase(5), blocker = new DatabaseSync(path), progress: FtsMigrationProgress[] = []
  blocker.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE')
  const started = Date.now()
  try {
    await assert.rejects(createSessionFts(path, {throwOnError:true,migrationLockTimeoutMs:60,onMigrationProgress:p => progress.push(p)}), {code:'EFTSMIGRATIONLOCK'})
    assert.ok(Date.now() - started < 2000)
    assert.ok(progress.some(p => p.phase === 'lock-wait'))
    assert.ok(progress.every(p => p.completed === 0))
    assert.equal((blocker.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get() as {value:string}).value, '2')
  } finally { blocker.exec('ROLLBACK'); blocker.close() }
  const f = await createSessionFts(path, {throwOnError:true}); assert.ok(f)
  try { assert.equal(f.health().schemaVersion, '5'); assert.equal(f.health().messages, 5) }
  finally { await f.close() }
})

it('unsupported future schema fails explicitly without downgrading its version or data', async () => {
  const path = await legacyDatabase(5), db = new DatabaseSync(path)
  db.exec("UPDATE state_meta SET value='6' WHERE key='schema_version'"); db.close()
  await assert.rejects(createSessionFts(path, {throwOnError:true}), {code:'EFTSSCHEMA'})
  const inspect = new DatabaseSync(path, {readOnly:true})
  try {
    assert.equal((inspect.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get() as {value:string}).value, '6')
    assert.equal((inspect.prepare('SELECT COUNT(*) AS n FROM messages').get() as {n:number}).n, 5)
    assert.equal(inspect.prepare("SELECT name FROM sqlite_master WHERE name='message_chunks'").get(), undefined)
  } finally { inspect.close() }
})

it('SCROLL expression seek preserves mixed legacy/source order and tie identity without a temp sort', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-sql-order-')), path = join(dir, 'fts.db')
  const f = await createSessionFts(path, {throwOnError:true}); assert.ok(f)
  try {
    await f.upsertSession({file:'/mix',id:'mix',workspace:'',title:'',agentPreset:'',createdAt:0,lastTime:0})
    await f.syncMessages('/mix', [
      {sessionFile:'/mix',role:'user',toolName:'',text:'late',eventSeq:30,anchorId:'late'},
      {sessionFile:'/mix',role:'user',toolName:'',text:'legacy-middle'},
      {sessionFile:'/mix',role:'user',toolName:'',text:'early',eventSeq:1,anchorId:'early'},
      {sessionFile:'/mix',role:'user',toolName:'',text:'pivot',eventSeq:2,anchorId:'pivot'},
      {sessionFile:'/mix',role:'user',toolName:'',text:'tie-after',eventSeq:2,anchorId:'tie-after'},
      {sessionFile:'/mix',role:'user',toolName:'',text:'legacy-end'},
    ], false)
    const scroll = await f.around('mix', 'pivot', 2)
    assert.equal(scroll.ok, true)
    assert.deepEqual(scroll.messages.map(r => r.text), ['early','legacy-middle','pivot','tie-after','legacy-end'])
    assert.deepEqual(scroll.bookends.start.map(r => r.text), ['early','legacy-middle','pivot'])
    assert.deepEqual(scroll.bookends.end.map(r => r.text), ['tie-after','legacy-end','late'])
    assert.equal((await f.around('mix', 4)).ok, false)
    assert.equal((await f.around('mix', 2)).ok, true)
    const db = (f as unknown as {db:DatabaseSync}).db
    for (const [op, predicate, direction] of [
      ['before','COALESCE(event_seq,id)<=? AND (COALESCE(event_seq,id)<? OR id<?)','DESC'],
      ['after','COALESCE(event_seq,id)>=? AND (COALESCE(event_seq,id)>? OR id>?)','ASC'],
    ]) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id,anchor_id,event_seq,role,text,tool_name FROM messages WHERE session_file=? AND ${predicate} ORDER BY COALESCE(event_seq,id) ${direction},id ${direction} LIMIT ?`).all('/mix',2,2,4,2) as {detail:string}[]
      assert.ok(plan.some(p => /idx_messages_source_order.*<expr>/.test(p.detail)), `${op}: ${JSON.stringify(plan)}`)
      assert.ok(!plan.some(p => /TEMP B-TREE/.test(p.detail)), `${op}: ${JSON.stringify(plan)}`)
    }
  } finally { await f.close() }
})

it('query timings separate SQLite from processing for search/page/scroll/health', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-sql-timing-')), timings: {op:string;sqlMs:number;processingMs:number}[] = []
  const f = await createSessionFts(join(dir, 'fts.db'), {throwOnError:true,onQueryTiming:t => timings.push(t)}); assert.ok(f)
  try {
    await f.upsertSession({file:'/timing',id:'timing',workspace:'',title:'',agentPreset:'',createdAt:0,lastTime:0})
    await f.syncMessages('/timing', [{sessionFile:'/timing',role:'user',text:'timingneedle',toolName:'',anchorId:'timing'}],false)
    timings.length = 0
    await f.search('timingneedle','',5); await f.searchPage('timingneedle','',5); await f.around('timing','timing'); f.health()
    assert.deepEqual(timings.map(t => t.op), ['search','searchPage','around','health'])
    assert.ok(timings.every(t => Number.isFinite(t.sqlMs) && t.sqlMs > 0 && Number.isFinite(t.processingMs) && t.processingMs >= 0))
  } finally { await f.close() }
})
