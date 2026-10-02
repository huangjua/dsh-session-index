import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,mkdir,writeFile,appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname,join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { apply } from '../src/index.js'
import { alpha3Jsonl,alpha3User,alpha3Assistant,alpha3EventJson } from './support/alpha3-log.js'

interface Tool {execute:(args:Record<string,unknown>)=>Promise<any>}
async function setup(ftsEnabled:boolean,extra?:{parent:boolean}) {
  const dir=await mkdtemp(join(tmpdir(),'stage-search-')),sessionsRoot=join(dir,'sessions'),dataDir=join(dir,'data')
  await mkdir(sessionsRoot,{recursive:true})
  const files:Record<string,string>={}
  for(const [id,body] of [['both','alpha distant beta'],['only','alpha unmatched'],['child','x'.repeat(1201)+' tailneedle']]) {
    const file=join(sessionsRoot,id,'session.jsonl.zstd');await mkdir(dirname(file),{recursive:true})
    const rows=alpha3Jsonl({id,createdAt:Date.now(),events:[alpha3User('intro','u-'+id),alpha3Assistant(body,'a-'+id)]})
    if(extra?.parent && id==='child') rows[0]=JSON.stringify({...JSON.parse(rows[0]),parentSession:'parent'})
    await writeFile(file,zstdCompressSync(Buffer.from(rows.join('\n')+'\n')));files[id]=file
  }
  if(extra?.parent) {
    const file=join(sessionsRoot,'parent','session.jsonl.zstd');await mkdir(dirname(file),{recursive:true})
    const rows=alpha3Jsonl({id:'parent',createdAt:Date.now(),events:[{type:'session/title',data:{title:'tailneedle'}},alpha3User('intro','up')]})
    await writeFile(file,zstdCompressSync(Buffer.from(rows.join('\n')+'\n')))
  }
  const tools:Record<string,Tool>={},cleanups:(()=>unknown)[]=[]
  const ctx={logger:()=>({info(){},warn(){},error(){}}),tools:{register(t:any){tools[t.name]=t}},effect(fn:()=>unknown){const value=fn();if(typeof value==='function') cleanups.push(value as ()=>unknown)}}
  const activate=()=>apply(ctx as never,{sessionsRoot,dataDir,indexFile:join(dataDir,'index.json'),ftsEnabled,retentionDays:0,llmSummaryEnabled:false,maxHits:10,maxSnippetsPerSession:3})
  activate()
  await tools.session_index_list.execute({refresh:true,limit:10})
  if(ftsEnabled) {
    const deadline=Date.now()+10000
    while(true) {
      const state=await tools.session_index_status.execute({})
      if(state.fts && state.ftsSessions>0 && !state.active && state.ftsHealth.dirtySessions===0) break
      assert.ok(Date.now()<deadline,'worker startup should converge');await new Promise(r=>setTimeout(r,20))
    }
  }
  return {tools,files,dataDir,activate,async close(){for(const c of cleanups.splice(0)) await c();await new Promise(r=>setTimeout(r,80))}}
}

it('FTS on/off use global message AND then OR and return identical stable anchors including long tails',async()=>{
  const on=await setup(true),off=await setup(false)
  try {
    for(const query of ['alpha beta','alpha absent','tailneedle']) {
      const args={mode:'full',query,filter:{role:'assistant'},limit:10}
      const a=await on.tools.session_index_search.execute(args),b=await off.tools.session_index_search.execute(args)
      assert.deepEqual(a.hits.map((h:any)=>h.sessionId).sort(),b.hits.map((h:any)=>h.sessionId).sort(),query)
      assert.equal(a.totalExact,true);assert.equal(b.totalExact,true)
      for(const h of a.hits) {assert.ok(h.anchorId);assert.ok(!('messageId' in h),'new external hits have stable identity')}
      assert.deepEqual(a.hits.map((h:any)=>h.anchorId).sort(),b.hits.map((h:any)=>h.anchorId).sort(),query)
      if(query==='alpha beta') assert.deepEqual(a.hits.map((h:any)=>h.sessionId),['both'])
    }
  } finally {await on.close();await off.close()}
})

it('parent metadata and child content aggregation replaces the complete representative tuple and metadata has no fake numeric anchor',async()=>{
  const env=await setup(true,{parent:true})
  try {
    const result=await env.tools.session_index_search.execute({mode:'full',query:'tailneedle'})
    const hit=result.hits.find((h:any)=>h.kind==='content');assert.ok(hit)
    assert.equal(hit.sessionId,'child');assert.equal(hit.file,env.files.child);assert.equal(hit.lineageRoot,'parent')
    const scroll=await env.tools.session_index_search.execute({session_id:hit.sessionId,anchor_id:hit.anchorId,window:1})
    assert.ok(scroll.messages.some((m:any)=>m.text.includes('tailneedle')))
    const meta=await env.tools.session_index_search.execute({mode:'meta',query:'tailneedle'})
    assert.ok(meta.hits.every((h:any)=>!('messageId' in h) && !('anchorId' in h)))
  } finally {await env.close()}
})

it('real worker stable bookmark survives delta, force and restart without a rowid alias',async()=>{
  const env=await setup(true)
  try {
    const found=await env.tools.session_index_search.execute({mode:'full',query:'tailneedle'})
    const anchor=found.hits[0].anchorId
    await env.tools.session_index_bookmark.execute({action:'add',sessionId:'child',anchorId:anchor,label:'keep',note:'user note'})
    const event=alpha3Assistant('after append','new-message')
    await appendFile(env.files.child,zstdCompressSync(Buffer.from(alpha3EventJson(event,2,Date.now())+'\n')))
    const deltaDeadline=Date.now()+10000
    while((await env.tools.session_index_status.execute({})).lastReport?.deltaParsed!==1) {assert.ok(Date.now()<deltaDeadline,'natural append must use delta');await new Promise(r=>setTimeout(r,50))}
    await env.tools.session_index_list.execute({refresh:true,limit:10})
    await env.close();env.activate()
    const deadline=Date.now()+10000
    while(!(await env.tools.session_index_status.execute({})).fts) {assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,20))}
    await env.tools.session_index_list.execute({refresh:true,limit:10})
    const bookmarks=await env.tools.session_index_bookmark.execute({action:'list'})
    assert.equal(bookmarks.bookmarks[0].anchorId,anchor);assert.equal(bookmarks.bookmarks[0].anchorAvailable,true)
    const scroll=await env.tools.session_index_search.execute({session_id:'child',anchor_id:anchor,window:1})
    assert.ok(scroll.messages.some((m:any)=>m.text.includes('tailneedle')))
  } finally {await env.close()}
})
