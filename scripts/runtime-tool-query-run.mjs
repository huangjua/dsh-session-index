/** Serial public-tool benchmark runner. All mutations stay in a fresh isolated run. */
import {spawn} from 'node:child_process'
import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {recordLoad} from './runtime-load.mjs'

const label=process.argv[2]??'candidate',rounds=Number(process.argv[3]??5),hot=Number(process.argv[4]??30),suffix=process.argv[5]??''
if(label!=='candidate')throw new Error('Public runtime/backend benchmark uses the candidate apply/tools implementation')
if(!Number.isInteger(rounds)||rounds<1||rounds>20||!Number.isInteger(hot)||hot<0||hot>300)throw new Error('Invalid rounds/hot counts')
if(!/^[A-Za-z0-9_-]*$/.test(suffix))throw new Error('Invalid evidence suffix')
const root=resolve('..'),id=randomUUID(),runRoot=join(root,'datasets',`tool-${label}-${id}`),dataDir=join(runRoot,'data'),sessionsRoot=join(runRoot,'sessions')
const evidence=join(root,'evidence',`candidate-tool-queries${suffix}-${id.slice(0,8)}`)
mkdirSync(dataDir,{recursive:true});mkdirSync(sessionsRoot,{recursive:true});mkdirSync(evidence,{recursive:true})
const db=join(dataDir,'fts.db'),index=join(dataDir,'index.json')
const snapshotInput=resolve(process.env.DSH_QUERY_DATASET_DB??join(root,'datasets','schema5-snapshot.db'))
if(!snapshotInput.startsWith(join(root,'datasets')+'\\')&&!snapshotInput.startsWith(join(root,'datasets')+'/'))throw new Error('Input snapshot must stay in isolated datasets')
copyFileSync(snapshotInput,db)
const frozen=JSON.parse(readFileSync(join(root,'datasets','schema5-index.json'),'utf8'))
frozen.root=sessionsRoot
writeFileSync(index,JSON.stringify(frozen)+'\n')
const exe=process.env.DSH_RUNTIME_EXE??'E:/Program Files (x86)/DSH-D/DeepSeek Harness.exe'
const environment={...process.env,ELECTRON_RUN_AS_NODE:'1'};delete environment.NODE_OPTIONS
const module=resolve('lib','index.js'),script=resolve('scripts','runtime-tool-query-child.mjs'),reports=[]
writeFileSync(join(evidence,'RUN_BOUNDARY.json'),JSON.stringify({generatedAt:new Date().toISOString(),id,label,rounds,hotCount:hot,
  dataDir,sessionsRoot,db,index,module,runtimeExecutable:exe,inputSnapshot:snapshotInput,
  boundary:'Frozen metadata only; original file/session identity preserved; source parsing denied; no actual scanner/watcher/build throughput measurement',
  cache:'Independent child process per round, same isolated database; OS disk cache uncontrolled. No machine cache clearing.'},null,2)+'\n')
const stopLoad=recordLoad(evidence)
try {
for(let n=1;n<=rounds;n++) {
  const output=join(evidence,`round-${n}.json`)
  const child=spawn(exe,['--no-warnings',script,module,db,index,sessionsRoot,output,String(n),String(hot)],{env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']})
  let log=''
  child.stdout.on('data',bytes=>{log+=bytes;process.stdout.write(bytes)})
  // Reports retain only structured code/name diagnostics; unexpected stderr is
  // discarded to avoid preserving SQLite messages or paths with private content.
  let stderrBytes=0;child.stderr.on('data',bytes=>{stderrBytes+=bytes.length})
  const code=await new Promise((accept,reject)=>{child.on('error',reject);child.on('exit',accept)})
  writeFileSync(join(evidence,`round-${n}.txt`),log)
  try {reports.push({...JSON.parse(readFileSync(output,'utf8')),exitCode:code,stderrBytes})}
  catch {reports.push({round:n,valid:false,exitCode:code,stderrBytes,errorCode:'EBENCHREPORT'})}
}
} finally { await stopLoad() }
const summarize=label=>{
  const values=reports.flatMap(report=>report.operations??[]).filter(operation=>operation.condition==='hot'&&operation.label===label).map(operation=>operation.totalMs).sort((a,b)=>a-b)
  return {count:values.length,p50:values.length?values[Math.ceil(values.length*.5)-1]:null,p95:values.length?values[Math.ceil(values.length*.95)-1]:null,max:values.at(-1)??null}
}
const summary={label,generatedAt:new Date().toISOString(),boundary:'Frozen metadata public apply/tools benchmark; source scans/parsing/build are explicitly excluded',
  valid:reports.every(report=>report.valid&&report.exitCode===0),hot:{search:summarize('search'),scroll:summarize('SCROLL')},reports}
writeFileSync(join(evidence,'RESULTS.json'),JSON.stringify(summary,null,2)+'\n')
console.log(JSON.stringify({evidence,valid:summary.valid,hot:summary.hot}))
if(!summary.valid)process.exitCode=1
