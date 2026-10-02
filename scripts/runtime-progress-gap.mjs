import {mkdir,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
const root=resolve('..'),runId=randomUUID(),directory=join(root,'validation','fts-progress-gap-'+runId)
await mkdir(directory,{recursive:true})
if(process.argv[2]!=='--child') {
  const env={...process.env,ELECTRON_RUN_AS_NODE:'1',TEMP:directory,TMP:directory,DSH_HOME:directory};delete env.NODE_OPTIONS
  const child=spawn('E:/Program Files (x86)/DSH-D/DeepSeek Harness.exe',['--no-warnings',resolve('scripts/runtime-progress-gap.mjs'),'--child',directory,runId],{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',chunk=>process.stdout.write(chunk));let stderrBytes=0;child.stderr.on('data',chunk=>{stderrBytes+=chunk.length})
  const exit=await new Promise(accept=>child.once('close',accept));console.log(JSON.stringify({exitCode:exit,stderrBytes}));process.exitCode=exit??1
} else {
  const {FtsClient}=await import('../.fts-continuation-build/src/fts-client.js')
  const results=[]
  for(const [number,budget,totalBudget] of [[3,1000,10000]]) {
    const beganAt=Date.now(),events=[]
    const client=new FtsClient(join(process.argv[3],number+'-migration-progress.db'),{
      workerUrl:pathToFileURL(resolve('.fts-continuation-build/test/runtime-transport-fixture.js')),
      startupTimeoutMs:1000,migrationStallTimeoutMs:budget,migrationTimeoutMs:totalBudget,
      onStartupProgress:event=>events.push({atMs:Date.now()-beganAt,state:event.state,phase:event.progress?.phase,completed:event.progress?.completed}),
      onStartupFailure:event=>events.push({atMs:Date.now()-beganAt,state:event.state,phase:event.progress?.phase,completed:event.progress?.completed,errorCode:event.error?.code}),
    })
    let ready=false,errorCode,closeErrorCode
    try{ready=await client.ready()}catch(error){errorCode=error.code??'unknown'}
    try{await client.close()}catch(error){closeErrorCode=error.code??'unknown'}
    const progress=events.filter(event=>event.state==='migrating'),maxGapMs=Math.max(0,...progress.slice(1).map((event,index)=>event.atMs-progress[index].atMs))
    results.push({budgetMs:budget,totalBudgetMs:totalBudget,ready,errorCode,closeErrorCode,maxObservedProgressGapMs:maxGapMs,elapsedMs:Date.now()-beganAt,events})
  }
  const output=join(root,'evidence','FTS_PROGRESS_GAP_'+process.argv[4]+'.json')
  await writeFile(output,JSON.stringify({scope:'real SQLite autocommit test fixture; production budgets unchanged',results},null,2)+'\n')
  console.log(JSON.stringify({output,results:results.map(({events,...value})=>value)}))
}
