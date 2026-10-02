import {it} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {zstdCompressSync} from 'node:zlib'
import {apply} from '../src/index.js'
import {modernJsonl,modernUser} from './support/modern-log.js'
const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms))
async function fixture(enabled:boolean) {
  const root=await mkdtemp(join(tmpdir(),'runtime-tool-')),sessionsRoot=join(root,'sessions'),dataDir=join(root,'data')
  const file=join(sessionsRoot,'isolated','session.jsonl.zstd')
  await mkdir(dirname(file),{recursive:true})
  await writeFile(file,zstdCompressSync(Buffer.from(modernJsonl({id:'isolated',createdAt:Date.now(),events:[modernUser('private diagnosticneedle body','u0')]}).join('\n')+'\n')))
  const tools:Record<string,{execute(args:Record<string,unknown>):Promise<any>}>= {},cleanups:(()=>any)[]=[],events:Record<string,unknown>[]=[]
  const ctx={logger:()=>({info(){},warn(){},error(){}}),tools:{register(t:any){tools[t.name]=t}},effect(fn:()=>unknown){const value=fn();if(typeof value==='function')cleanups.push(value as ()=>unknown)}}
  apply(ctx as never,{sessionsRoot,dataDir,indexFile:join(dataDir,'index.json'),ftsEnabled:enabled,retentionDays:0,llmSummaryEnabled:false,maxHits:10,maxSnippetsPerSession:3},{onRuntimeDiagnostic:e=>events.push(e)})
  const close=async()=>{for(const c of cleanups.splice(0))await c();await pause(100);await rm(root,{recursive:true,force:true})}
  try{
  await tools.session_index_list.execute({refresh:true})
  if(enabled){const deadline=Date.now()+10000;while(true){const s=await tools.session_index_status.execute({});if(s.fts && s.ftsSessions===1 && !s.active && s.ftsHealth.dirtySessions===0)break;assert.ok(Date.now()<deadline);await pause(30)}}
  }catch(error){await close();throw error}
  return {tools,events,close}
}
it('public full/SCROLL expose actual FTS backend and bounded diagnostics without source/query/body text',async()=>{
  const f=await fixture(true)
  try{
    const found=await f.tools.session_index_search.execute({mode:'full',query:'diagnosticneedle',limit:5})
    assert.equal(found.runtime.backend,'fts');assert.equal(found.coverage.complete,true);assert.equal(found.runtime.fallbackMs>=0,true)
    const hit=found.hits.find((h:any)=>h.anchorId);assert.ok(hit)
    const sc=await f.tools.session_index_search.execute({session_id:hit.sessionId,anchor_id:hit.anchorId,window:1})
    assert.equal(sc.runtime.backend,'fts');assert.ok(sc.messages.some((m:any)=>m.anchorId===hit.anchorId));assert.ok(sc.runtime.totalMs>=sc.runtime.ftsMs)
    const state=await f.tools.session_index_status.execute({})
    assert.equal(state.ftsHealth.dirtySessionsExact,false);assert.ok(state.ftsHealth.startup)
    assert.ok(f.events.some(e=>e.kind==='fts-request' && e.role==='reader'))
    const encoded=JSON.stringify(f.events)
    for(const secret of ['diagnosticneedle','private diagnosticneedle body','session.jsonl.zstd'])assert.ok(!encoded.includes(secret),secret)
  }finally{await f.close()}
})
it('source backend is explicit when FTS is disabled and results retain full coverage',async()=>{
  const f=await fixture(false)
  try{
    const found=await f.tools.session_index_search.execute({mode:'full',query:'diagnosticneedle',limit:5})
    assert.equal(found.runtime.backend,'source');assert.equal(found.coverage.complete,true);assert.equal(found.hits.length,1)
    assert.ok(found.runtime.fallbackMs>0);assert.equal(found.runtime.ftsMs,0)
  }finally{await f.close()}
})
it('ordinary status rendering shows actual migration progress and a safe failure code',async()=>{
  const f=await fixture(false)
  try{
    const status=await f.tools.session_index_status.execute({})
    const render=(startup:Record<string,unknown>)=>(f.tools.session_index_status as unknown as {
      output:{render(args:unknown,value:Record<string,unknown>):{text:string}[]}
    }).output.render({}, {...status,ftsHealth:{...status.ftsHealth,startup}}).map(block=>block.text).join('\n')
    assert.match(render({role:'writer',state:'migrating',elapsedMs:15876,
      progress:{phase:'chunks',completed:1000,total:47089}}),
    /ftsStartup: role=writer state=migrating phase=chunks completed=1000 total=47089 elapsedMs=15876 code=-/)
    assert.match(render({role:'writer',state:'opening',elapsedMs:123}),
      /state=opening phase=- completed=- total=- elapsedMs=123 code=-/)
    const failed=render({role:'writer',state:'failed',elapsedMs:20000,
      error:{code:'EFTSMIGRATION_STALL',message:'private source body C:\\secret\\session.jsonl.zstd'}})
    assert.match(failed,/state=failed.*code=EFTSMIGRATION_STALL/)
    assert.ok(!failed.includes('private source body') && !failed.includes('C:\\secret'))
  }finally{await f.close()}
})
