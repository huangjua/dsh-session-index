import {copyFileSync,mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {performance} from 'node:perf_hooks'
import {createFtsClient} from '../lib/fts-client.js'
const root=resolve('..'),directory=join(root,'datasets','schema2-dual');mkdirSync(directory,{recursive:true})
const source='E:/Do Something/DSH备份/dsh-session-index work/implementation-session-index/deployment-backups/S7-20261002-090316-e1190a1f/data-before-switch/fts.db'
const dbPath=join(directory,'fts.db');copyFileSync(source,dbPath)
const events=[[],[]],began=performance.now()
const clients=await Promise.all([0,1].map(n=>createFtsClient(dbPath,{onStartupProgress:e=>events[n].push({...e,client:n}),onStartupFailure:e=>events[n].push({...e,client:n})})))
const startupMs=performance.now()-began
const workers=clients.map(c=>c?.diagnostics()??null)
await Promise.all(clients.map(c=>c?.close()))
const db=new DatabaseSync(dbPath,{readOnly:true})
let counts
try{counts={schema:db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get()?.value,sessions:db.prepare('SELECT COUNT(*) n FROM sessions').get().n,messages:db.prepare('SELECT COUNT(*) n FROM messages').get().n,chunks:db.prepare('SELECT COUNT(*) n FROM message_chunks').get().n,checkpoints:db.prepare('SELECT COUNT(*) n FROM fts_checkpoints').get().n}}
finally{db.close()}
const report={publicPath:'two concurrent createFtsClient factories on one isolated schema2 database',available:clients.map(Boolean),startupMs,events,workers,counts,totalMs:performance.now()-began}
writeFileSync(join(root,'evidence','MIGRATION_DUAL.json'),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({available:report.available,startupMs,counts,processedRows:events.map(list=>Math.max(0,...list.filter(e=>e.state==='migrating'&&e.progress?.phase==='chunks').map(e=>e.progress.completed))),lockWaits:events.map(list=>list.filter(e=>e.progress?.phase==='lock-wait').length)}))
process.exitCode=clients.every(Boolean)?0:1
