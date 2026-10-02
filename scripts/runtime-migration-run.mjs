import {spawn} from 'node:child_process'
import {mkdirSync,copyFileSync,writeFileSync,readFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {recordLoad} from './runtime-load.mjs'
const root=resolve('..'),mode=process.argv[2]??'normal'
if(!['normal','interrupt'].includes(mode))throw new Error('mode normal or interrupt')
const dir=join(root,'datasets','schema2-'+mode+'-final'),evidence=join(root,'evidence','migration-'+mode+'-final')
mkdirSync(dir,{recursive:true});mkdirSync(evidence,{recursive:true})
const db=join(dir,'fts.db')
copyFileSync('E:/Do Something/DSH备份/dsh-session-index work/implementation-session-index/deployment-backups/S7-20261002-090316-e1190a1f/data-before-switch/fts.db',db)
const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};delete env.NODE_OPTIONS
const run=async(output,fault)=>{
  const child=spawn('E:/Program Files (x86)/DSH-D/DeepSeek Harness.exe',['--no-warnings',resolve('scripts/runtime-migration-child.mjs'),db,output,...(fault?[String(fault)]:[])],{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
  let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});let stderrBytes=0;child.stderr.on('data',b=>{stderrBytes+=b.length})
  const exitCode=await new Promise((accept,reject)=>{child.on('error',reject);child.on('exit',accept)})
  writeFileSync(output+'.txt',log)
  return {exitCode,stderrBytes}
}
const stopLoad=recordLoad(evidence),runs=[]
try {
  if(mode==='interrupt'){
    const output=join(evidence,'INTERRUPTED.json')
    const result=await run(output,1000)
    runs.push({...result,publicPath:'createFtsClient factory; test parent exits at real migration chunks>=1000; own SQLite children killed by parent exit/guardian',events:readFileSync(output+'.progress.jsonl','utf8').trim().split(/\r?\n/).map(JSON.parse)})
    if(result.exitCode!==73)throw new Error('Expected controlled isolated parent exit73')
  }
  for(const phase of ['UPGRADE','SECOND_START']){
    const output=join(evidence,phase+'.json'),result=await run(output)
    runs.push({phase,...result,report:JSON.parse(readFileSync(output,'utf8'))})
    if(result.exitCode!==0)break
  }
} finally{await stopLoad()}
writeFileSync(join(evidence,'RESULTS.json'),JSON.stringify({mode,isolatedDb:db,runs},null,2)+'\n')
if(runs.some(run=>run.exitCode!==0&&run.exitCode!==73))process.exitCode=1
