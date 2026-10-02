import {spawn} from 'node:child_process'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
const label=process.argv[2]??'MINIMAL_FINAL'
const files=process.argv.slice(3)
if(!files.length || !/^[A-Z0-9_-]+$/.test(label))throw new Error('explicit test selection required')
const root=resolve('..'),dir=join(root,'evidence'),temp=resolve('validation','temp')
mkdirSync(temp,{recursive:true})
const env={...process.env,ELECTRON_RUN_AS_NODE:'1',TEMP:temp,TMP:temp,DSH_HOME:resolve('validation','dsh-home'),DSH_SESSION_INDEX_DATA_DIR:resolve('validation','data'),DSH_SESSION_INDEX_SESSIONS_ROOT:resolve('validation','sessions')};delete env.NODE_OPTIONS
const args=['--no-warnings','--test','--test-concurrency=1','--test-timeout=60000',...files.map(n=>`.test-build/test/${n}.test.js`)]
const child=spawn('E:/Program Files (x86)/DSH-D/DeepSeek Harness.exe',args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
let log='';child.stdout.on('data',b=>{log+=b});child.stderr.on('data',b=>{log+=b})
const exitCode=await new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',accept)})
writeFileSync(join(dir,label+'.txt'),log)
writeFileSync(join(dir,label+'.json'),JSON.stringify({label,args,exitCode,scope:'explicit minimal tests selected from runtime diff',runtime:'installed Electron Node24.18.1/SQLite3.53.1',environment:{temp,isolatedData:env.DSH_SESSION_INDEX_DATA_DIR,isolatedSources:env.DSH_SESSION_INDEX_SESSIONS_ROOT}},null,2)+'\n')
console.log(log.split(/\r?\n/).slice(-26).join('\n'));process.exitCode=exitCode??1
