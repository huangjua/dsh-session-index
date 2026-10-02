import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createSessionFts } from '../src/fts.js'
import type { FtsMessageRow, SessionFts } from '../src/fts.js'

async function scratch(work:(fts:SessionFts,dir:string)=>Promise<void>) {
  const dir=await mkdtemp(join(tmpdir(),'s3-s4-fts-'))
  const f=await createSessionFts(join(dir,'fts.db'));assert.ok(f)
  try {await work(f,dir)} finally {await f.close()}
}
const meta=(id:string)=>({id,file:`/${id}`,workspace:'/isolated',title:'unrelated',agentPreset:'fake',createdAt:1,lastTime:10})
const row=(id:string,seq:number,text:string):FtsMessageRow=>({sessionFile:`/${id}`,role:'assistant',text,toolName:'',anchorId:`anchor:${id}:${seq}`,eventSeq:seq,eventType:'assistant/message',sourceMessageId:`message-${seq}`,generation:3,identityEvidence:`proof:${seq}`})

it('SCROLL neighbors use session source order despite A/B/A writes; force and new database keep stable anchor',async()=>scratch(async(f,dir)=>{
  await f.upsertSession(meta('a'));await f.upsertSession(meta('b'))
  await f.syncMessages('/a',[row('a',0,'before')],false)
  await f.syncMessages('/b',Array.from({length:10},(_,i)=>row('b',i,'other')),false)
  await f.syncMessages('/a',[row('a',2,'centerneedle'),row('a',4,'after')],true)
  const first=(await f.search('centerneedle','',5))[0]
  assert.deepEqual((await f.around('a',first.anchorId!,1)).messages.map(m=>m.text),['before','centerneedle','after'])
  assert.equal((await f.around('b',first.anchorId!,1)).ok,false)
  assert.equal((await f.around('a',first.messageId,1)).ok,false,'new stable messages do not silently accept historical numeric aliases')
  await f.syncMessages('/a',[row('a',0,'before'),row('a',2,'centerneedle'),row('a',4,'after')],false)
  const second=(await f.search('centerneedle','',5))[0]
  assert.notEqual(first.messageId,second.messageId);assert.equal(first.anchorId,second.anchorId)
  const rebuilt=await createSessionFts(join(dir,'rebuilt.db'));assert.ok(rebuilt)
  try {await rebuilt.upsertSession(meta('a'));await rebuilt.syncMessages('/a',[row('a',2,'centerneedle')],false)
    assert.equal((await rebuilt.around('a',first.anchorId!)).messages[0].text,'centerneedle')
  } finally {await rebuilt.close()}
}))

it('full original text verifies head/middle/tail, distributed AND, Unicode and longer-than-overlap queries',async()=>scratch(async f=>{
  await f.upsertSession(meta('long'))
  const longToken='q'.repeat(200)+'unique'
  const text='headneedle Äbc '+ '😀😀 a😀 '+ 'x'.repeat(1201)+' middleneedle '+ '中😀'.repeat(2000)+' alpha '+ 'z'.repeat(5000)+' beta '+longToken+' tailneedle'
  await f.syncMessages('/long',[row('long',0,text)],false)
  for(const q of ['headneedle','middleneedle','tailneedle','alpha beta',longToken,'中😀中😀','beta tailneedle','😀😀','中😀','äbc','ä','a😀']) {
    const hits=await f.searchPage(q,'',5)
    assert.equal(hits.total,1,q);assert.equal(hits.hits[0].anchorId,'anchor:long:0',q)
  }
  assert.equal((await f.searchPage('alpha absentword','',5,{queryMode:'and'})).total,0)
  assert.equal((await f.searchPage('alpha absentword','',5)).total,1,'global OR after zero AND')
}))

it('40/500 repeated messages cannot starve another session; independent-session total and cap are explicit',async()=>scratch(async f=>{
  for(const count of [40,500]) {
    await f.upsertSession(meta('many'));await f.upsertSession(meta('one'))
    await f.syncMessages('/many',Array.from({length:count},(_,i)=>row('many',i,'needle repeated')),false)
    await f.syncMessages('/one',[row('one',0,'needle')],false)
    const all=await f.searchPage('needle','',10)
    assert.deepEqual(all.hits.map(h=>h.sessionId).sort(),['many','one']);assert.equal(all.total,2)
    const capped=await f.searchPage('needle','',1)
    assert.equal(capped.total,2);assert.equal(capped.totalExact,true);assert.equal(capped.hasMore,true)
  }
}))

it('schema v2 adds identity columns without interpreting rowid as eventSeq and retains numeric compatibility only for legacy rows',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'s3-v2-'));const path=join(dir,'fts.db')
  const old=new DatabaseSync(path)
  old.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,session_file TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',tool_name TEXT NOT NULL DEFAULT ''); INSERT INTO messages(session_file,role,text,tool_name) VALUES('/legacy','user','oldneedle',''); CREATE TABLE state_meta(key TEXT PRIMARY KEY,value TEXT);INSERT INTO state_meta VALUES('schema_version','2')")
  old.close()
  const f=await createSessionFts(path);assert.ok(f)
  try {await f.upsertSession(meta('legacy'))
    const hit=(await f.search('oldneedle','',5))[0]
    assert.equal(hit.anchorId,undefined);assert.equal(hit.eventSeq,undefined)
    assert.equal((await f.around('legacy',hit.messageId)).ok,true)
    assert.equal((await f.resolveLegacyAnchor('legacy',hit.messageId)).reason,'unresolved-no-source-identity')
    assert.equal(f.health().schemaVersion,'5')
  } finally {await f.close()}
})
