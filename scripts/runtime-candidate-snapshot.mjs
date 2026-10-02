/** Normalize a closed isolated candidate database via SQLite backup, including WAL. */
import {DatabaseSync,backup} from 'node:sqlite'
import {existsSync,writeFileSync} from 'node:fs'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {performance} from 'node:perf_hooks'
const root=resolve('..'),source=resolve(process.argv[2]),target=join(root,'datasets','candidate-schema5-verified.db')
const part=relative(join(root,'datasets'),source)
if(part.startsWith('..')||isAbsolute(part)||existsSync(target))throw new Error('Fresh isolated candidate snapshot required')
const started=performance.now(),db=new DatabaseSync(source,{readOnly:true})
try{db.exec('PRAGMA query_only=ON');await backup(db,target)}finally{db.close()}
const copy=new DatabaseSync(target,{readOnly:true})
let report
try{
  copy.exec('PRAGMA query_only=ON;BEGIN')
  const count=table=>copy.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
  report={source,target,method:'read-only SQLite backup API includes committed WAL',backupMs:performance.now()-started,
    schema:copy.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get().value,
    sourceOrderIndex:!!copy.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_messages_source_order' AND type='index'").get(),
    counts:{sessions:count('sessions'),messages:count('messages'),chunks:count('message_chunks'),checkpoints:count('fts_checkpoints')},
    incompleteCheckpoints:copy.prepare("SELECT COUNT(*) AS n FROM fts_checkpoints WHERE json_extract(checkpoint_json,'$.complete')<>1").get().n,
    mismatch:copy.prepare("SELECT COUNT(*) AS n FROM fts_checkpoints c WHERE json_extract(c.checkpoint_json,'$.messageCount')<>(SELECT COUNT(*) FROM messages m WHERE m.session_file=c.file)").get().n,
    generatedAt:new Date().toISOString()}
  copy.exec('ROLLBACK')
}finally{copy.close()}
report.valid=report.schema==='5'&&report.sourceOrderIndex&&report.counts.sessions===331&&report.counts.messages===47092&&report.counts.chunks===47870&&report.counts.checkpoints===331&&report.incompleteCheckpoints===0&&report.mismatch===0
writeFileSync(join(root,'evidence','CANDIDATE_QUERY_SNAPSHOT.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify(report));process.exitCode=report.valid?0:1
