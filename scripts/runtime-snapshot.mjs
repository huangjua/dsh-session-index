import {DatabaseSync,backup} from 'node:sqlite'
import {mkdirSync,existsSync,writeFileSync,statSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {performance} from 'node:perf_hooks'
const root=resolve('..'), target=join(root,'datasets','schema5-snapshot.db')
if(existsSync(target)) throw new Error('Snapshot already exists; preserve existing evidence')
mkdirSync(join(root,'datasets'),{recursive:true})
const source='E:/Do Something/DSH备份/session-index-data/fts.db'
const report={startedAt:new Date().toISOString(),method:'node:sqlite backup API from read-only connection; includes committed WAL; no source DDL/DML',source,target,progress:[]}
const started=performance.now(), db=new DatabaseSync(source,{readOnly:true})
try {
  db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2500')
  report.pages=await backup(db,target,{rate:2048,progress:p=>{if(report.progress.length<80)report.progress.push({...p,elapsedMs:performance.now()-started})}})
}finally{db.close()}
report.backupMs=performance.now()-started
const copy=new DatabaseSync(target,{readOnly:true})
try {
  copy.exec('PRAGMA query_only=ON; BEGIN')
  report.schema=copy.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get()?.value
  report.counts=Object.fromEntries(['sessions','messages','message_chunks','fts_checkpoints'].map(table=>[table,copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]))
  report.checkpointMessageMismatches=copy.prepare("SELECT COUNT(*) AS n FROM fts_checkpoints c WHERE json_extract(c.checkpoint_json,'$.messageCount')<>(SELECT COUNT(*) FROM messages m WHERE m.session_file=c.file)").get().n
  report.incompleteCheckpoints=copy.prepare("SELECT COUNT(*) AS n FROM fts_checkpoints WHERE json_extract(checkpoint_json,'$.complete')<>1").get().n
  report.orphanChunks=copy.prepare('SELECT COUNT(*) AS n FROM message_chunks c LEFT JOIN messages m ON m.id=c.message_id WHERE m.id IS NULL').get().n
  report.bytes=statSync(target).size
  copy.exec('ROLLBACK')
}finally{copy.close()}
report.totalMs=performance.now()-started
report.completedAt=new Date().toISOString()
writeFileSync(join(root,'evidence','DATASET_SNAPSHOT.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({schema:report.schema,counts:report.counts,backupMs:report.backupMs,totalMs:report.totalMs,checkpointMessageMismatches:report.checkpointMessageMismatches,incompleteCheckpoints:report.incompleteCheckpoints,orphanChunks:report.orphanChunks}))
