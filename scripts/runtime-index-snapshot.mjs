import {copyFileSync,readFileSync,writeFileSync,statSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {createHash} from 'node:crypto'
const root=resolve('..'),source='E:/Do Something/DSH备份/session-index-data/index.json',destination=join(root,'datasets','schema5-index.json')
const before=statSync(source);copyFileSync(source,destination);const after=statSync(source)
const index=JSON.parse(readFileSync(destination,'utf8')),db=new DatabaseSync(join(root,'datasets','schema5-snapshot.db'),{readOnly:true})
let converged=0,dirty=0
try{
  const cps=new Map(db.prepare('SELECT file,checkpoint_json FROM fts_checkpoints').all().map(r=>[r.file,JSON.parse(r.checkpoint_json)]))
  for(const m of index.sessions){const c=cps.get(m.file);if(m.ftsDirty)dirty++;if(c && c.sessionId===m.id && c.size===m.size && c.mtimeMs===m.mtimeMs && c.ctimeMs===(m.ctimeMs??-1) && c.indexedBytes===(m.indexedBytes??m.size) && c.indexedSeq===m.indexedSeq && c.complete===true && m.coverage?.complete===true)converged++}
}finally{db.close()}
writeFileSync(join(root,'evidence','INDEX_SNAPSHOT_CHECK.json'),JSON.stringify({entries:index.sessions.length,converged,dirty,jsonStableDuringCopy:before.size===after.size && before.mtimeMs===after.mtimeMs,sha256:createHash('sha256').update(readFileSync(destination)).digest('hex'),boundary:'JSON copied separately from SQL backup; checkpoint fingerprints matched; no cross-file atomicity claim'},null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({entries:index.sessions.length,converged,dirty}))
if(converged!==index.sessions.length || dirty)process.exitCode=1
