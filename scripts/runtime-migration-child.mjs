import {createFtsClient} from '../lib/fts-client.js'
import {DatabaseSync} from 'node:sqlite'
import {appendFileSync,writeFileSync} from 'node:fs'
import {performance} from 'node:perf_hooks'
const [dbPath,output,faultAt]=process.argv.slice(2)
const observe=()=>{
  const db=new DatabaseSync(dbPath,{readOnly:true})
  try {return {schema:db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get()?.value,sessions:db.prepare('SELECT COUNT(*) n FROM sessions').get().n,messages:db.prepare('SELECT COUNT(*) n FROM messages').get().n,checkpoints:db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE type='table' AND name='fts_checkpoints'").get().n?db.prepare('SELECT COUNT(*) n FROM fts_checkpoints').get().n:0}}
  finally{db.close()}
}
const before=observe(),events=[],start=performance.now()
const report={startedAt:new Date().toISOString(),publicPath:'createFtsClient(dbPath) -> FtsClient workers -> automatic SessionFts initialization',runtime:{node:process.version,electron:process.versions.electron,sqlite:process.versions.sqlite},before,events}
writeFileSync(output+'.progress.jsonl','')
const progress=e=>{events.push(e);appendFileSync(output+'.progress.jsonl',JSON.stringify(e)+'\n');if(faultAt&&e.state==='migrating'&&e.progress?.phase==='chunks'&&e.progress.completed>=Number(faultAt))process.exit(73)}
const client=await createFtsClient(dbPath,{onStartupProgress:progress,onStartupFailure:progress})
report.startupMs=performance.now()-start;report.available=!!client
if(client){report.health=await client.health();report.worker=client.diagnostics();await client.close()}
report.after=observe();report.totalMs=performance.now()-start;report.completedAt=new Date().toISOString()
writeFileSync(output,JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({available:report.available,startupMs:report.startupMs,before,after:report.after,events:events.length,restarts:report.worker?.restarts}))
process.exitCode=client?0:1
