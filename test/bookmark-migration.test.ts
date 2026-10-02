import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,readFile,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { addBookmark,migrateBookmarks,readBookmarks } from '../src/bookmark.js'
import type { BookmarkResolver } from '../src/bookmark.js'

const old=(id:string)=>({v:1,id,sessionId:'session',sessionFile:'/session',messageId:7,label:'标签',note:'备注',title:'标题',workspace:'/test',createdAt:1,updatedAt:2,tags:['keep'],custom:{keep:true}})
const resolver:BookmarkResolver=async b=>b.id==='proven' ? {status:'resolved',anchorId:'stable',evidence:'durable-proof'} : b.id==='guess' ? {status:'resolved',anchorId:'bad-guess',evidence:'durable-proof'} : {status:b.id==='missing' ? 'session-missing' : b.id==='replaced' ? 'anchor-replaced' : 'ambiguous'}

it('dry-run is read only; migration preserves all physical records and legacy fields; unproven mapping remains unresolved',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'s3-bookmark-'));const path=join(dir,'bookmarks.jsonl'),backup=join(dir,'before.jsonl')
  const records=[{...old('proven'),legacyEvidence:{identityEvidence:'durable-proof',anchorId:'stable'}},old('guess'),old('ambiguous'),old('missing'),old('replaced'),{...old('session'),messageId:null}]
  const original=records.map(b=>JSON.stringify(b)).join('\n')+'\n';await writeFile(path,original)
  const dry=await migrateBookmarks(path,resolver)
  assert.equal(await readFile(path,'utf8'),original);assert.equal(dry.counts.resolved,1);assert.equal(dry.counts.unresolved,1)
  assert.equal(dry.counts.ambiguous,1);assert.equal(dry.counts['session-missing'],1);assert.equal(dry.counts['anchor-replaced'],1);assert.equal(dry.counts.session,1)
  const migrated=await migrateBookmarks(path,resolver,{dryRun:false,backupPath:backup})
  assert.equal(migrated.records,6);assert.equal(await readFile(backup,'utf8'),original)
  const raw=(await readFile(path,'utf8')).trim().split('\n').map(s=>JSON.parse(s))
  assert.equal(raw.length,6)
  for(const b of raw) {assert.deepEqual(b.tags,['keep']);assert.deepEqual(b.custom,{keep:true});assert.equal(b.createdAt,1);assert.equal(b.updatedAt,2);assert.equal(b.note,'备注')}
  assert.equal(raw[0].anchorId,'stable');assert.equal(raw[0].messageId,7)
  assert.equal(raw[1].anchorId,undefined);assert.equal(raw[1].anchorStatus,'unresolved')
  const bytes=await readFile(path,'utf8')
  const again=await migrateBookmarks(path,resolver,{dryRun:false,backupPath:backup})
  assert.equal(again.counts.alreadyMigrated,6);assert.equal(await readFile(path,'utf8'),bytes)
})

it('stable bookmarks are independent of legacy rowid, updates remain idempotent and unknown old fields survive reading',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'s3-bookmark-stable-'));const path=join(dir,'bookmarks.jsonl')
  const input={sessionId:'s',sessionFile:'/s',anchorId:'anchor',label:'first',title:'title',workspace:'/test'}
  const first=await addBookmark(path,input,1),second=await addBookmark(path,{...input,label:'second',messageId:99},2)
  assert.equal(first.bookmark.id,second.bookmark.id);assert.equal(second.replaced,true)
  const read=await readBookmarks(path);assert.equal(read.bookmarks.length,1);assert.equal(read.bookmarks[0].anchorId,'anchor')
})

it('backup created before interrupted migration can be reused, but a different unique backup is never overwritten',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'s3-bookmark-retry-')),path=join(dir,'bookmarks.jsonl'),backup=join(dir,'backup.jsonl')
  const original=JSON.stringify(old('guess'))+'\n';await writeFile(path,original);await writeFile(backup,'other protected data')
  await assert.rejects(migrateBookmarks(path,resolver,{dryRun:false,backupPath:backup}))
  assert.equal(await readFile(path,'utf8'),original);assert.equal(await readFile(backup,'utf8'),'other protected data')
  const good=join(dir,'good-backup.jsonl');await writeFile(good,original)
  await migrateBookmarks(path,resolver,{dryRun:false,backupPath:good})
  assert.equal(await readFile(good,'utf8'),original)
})
