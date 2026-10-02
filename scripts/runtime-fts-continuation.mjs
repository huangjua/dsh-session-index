/** Installed-runtime, sequential, affected FTS correctness regression only. */
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
const runtimeRoot=resolve('..'),runId=randomUUID(),label='FTS_CONTINUATION_'+runId
const evidence=join(runtimeRoot,'evidence'),validation=join(runtimeRoot,'validation',label)
const pattern=process.argv[2]
const files=pattern?['runtime-transport']:['fts-client','fts-recovery','fts-message-contract','runtime-sql-migration','runtime-transport','runtime-transport-errors','fts-filter-safety']
for(const name of ['temp','dsh-home','data','sessions'])await mkdir(join(validation,name),{recursive:true})
await mkdir(evidence,{recursive:true})
const output=join(evidence,label+'.txt'),reportFile=join(evidence,label+'.json')
await writeFile(output,'')
const sourceDigests={}
for(const file of ['src/fts-client.ts','src/fts-worker.ts','src/fts.ts',...files.map(name=>'test/'+name+'.test.ts')])
  sourceDigests[file]=createHash('sha256').update(await readFile(file)).digest('hex')
const env={...process.env,ELECTRON_RUN_AS_NODE:'1',DSH_HOME:join(validation,'dsh-home'),TEMP:join(validation,'temp'),TMP:join(validation,'temp'),
  DSH_SESSION_INDEX_DATA_DIR:join(validation,'data'),DSH_SESSION_INDEX_SESSIONS_ROOT:join(validation,'sessions')}
delete env.NODE_OPTIONS
const args=['--no-warnings','--test','--test-concurrency=1','--test-reporter=tap',...(pattern?['--test-name-pattern='+pattern]:[]),...files.map(name=>'.fts-continuation-build/test/'+name+'.test.js')]
const beganAt=Date.now(),child=spawn(process.env.DSH_RUNTIME_EXE??'E:/Program Files (x86)/DSH-D/DeepSeek Harness.exe',args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
let transcript='',writeChain=Promise.resolve(),spawnErrorCode
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
  const text=chunk.toString();transcript+=text;writeChain=writeChain.then(()=>appendFile(output,text))
})
child.once('error',error=>{spawnErrorCode=error.code??'unknown'})
const exit=await new Promise(accept=>child.once('close',(code,signal)=>accept({exitCode:code,signal})))
await writeChain
const summary=Object.fromEntries(['tests','suites','pass','fail','cancelled','skipped','todo'].map(key=>[key,Number(transcript.match(new RegExp('^# '+key+' (\\d+)$','m'))?.[1]??-1)]))
const report={startedAt:new Date(beganAt).toISOString(),...exit,elapsedMs:Date.now()-beganAt,spawnErrorCode,args,summary,sourceDigests,
  compile:'node node_modules/typescript/bin/tsc -p tsconfig.test.json --outDir .fts-continuation-build: exit0',
  environment:{ELECTRON_RUN_AS_NODE:'1',DSH_HOME:env.DSH_HOME,TEMP:env.TEMP,TMP:env.TMP,dataDir:env.DSH_SESSION_INDEX_DATA_DIR,sessionsRoot:env.DSH_SESSION_INDEX_SESSIONS_ROOT},
  boundary:{installedRuntime:true,testConcurrency:1,performanceMeasurement:false,productionOpened:false,compiledOutput:'.fts-continuation-build',workLibModified:false}}
await writeFile(reportFile,JSON.stringify(report,null,2)+'\n')
console.log(transcript.split(/\r?\n/).slice(-14).join('\n'))
console.log(JSON.stringify({reportFile,output,...exit,summary,elapsedMs:report.elapsedMs}))
process.exitCode=exit.exitCode??1
