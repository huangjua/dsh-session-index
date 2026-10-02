import {spawn} from 'node:child_process'
import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {recordLoad} from './runtime-load.mjs'
const root=resolve('..'),label=process.argv[2],rounds=Number(process.argv[3]??5),hot=process.argv[4]??'30'
if(!['baseline','candidate'].includes(label))throw new Error('baseline or candidate')
const dir=join(root,'evidence',label+'-queries'+(process.argv[5]??''));mkdirSync(dir,{recursive:true})
const db=join(root,'datasets',label+'-query'+(process.argv[5]??'')+'.db');copyFileSync(join(root,'datasets','schema5-snapshot.db'),db)
const module=label==='baseline'?join(root,'baseline','S6-20261002','lib','fts-client.js'):resolve('lib','fts-client.js')
const exe='E:/Program Files (x86)/DSH-D/DeepSeek Harness.exe',env={...process.env,ELECTRON_RUN_AS_NODE:'1'};delete env.NODE_OPTIONS
const reports=[]
const stopLoad=recordLoad(dir)
try {
for(let n=1;n<=rounds;n++){
  const output=join(dir,`round-${n}.json`),args=['--no-warnings',resolve('scripts','runtime-query-child.mjs'),module,db,output,String(n),hot]
  const child=spawn(exe,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
  let log='';child.stdout.on('data',b=>{log+=b;process.stdout.write(b)});child.stderr.on('data',b=>{log+=b})
  const code=await new Promise((accept,reject)=>{child.on('error',reject);child.on('exit',accept)})
  writeFileSync(join(dir,`round-${n}.txt`),log)
  reports.push({...JSON.parse(readFileSync(output,'utf8')),exitCode:code})
}
} finally { await stopLoad() }
const summary={label,generatedAt:new Date().toISOString(),reports}
writeFileSync(join(dir,'RESULTS.json'),JSON.stringify(summary,null,2)+'\n')
