import { DatabaseSync } from 'node:sqlite'
import { writeFileSync } from 'node:fs'
import { SessionFts as Before } from '../baseline/S6-20261002/lib/fts.js'
import { SessionFts as After } from '../work/lib/fts.js'

const localPath = name => decodeURIComponent(new URL('../datasets/'+name, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
let db
const captured = []
class CaptureDb {
  constructor() {}
  exec(sql) { db.exec(sql) }
  close() {}
  prepare(sql) {
    const statement = db.prepare(sql)
    return {
      run: (...args) => statement.run(...args),
      get: (...args) => statement.get(...args),
      all: (...args) => {
        if (sql.startsWith('WITH ')) { captured.push({sql,args}); return [] }
        return statement.all(...args)
      },
    }
  }
}
const report = {createdAt:new Date().toISOString(),datasets:{before:'baseline-query.db',after:'candidate-query.db'},query:{word:'session',role:'assistant',mode:'and',limit:5},search:{},scroll:{},notes:[
  'Read-only EXPLAIN QUERY PLAN only on the actual baseline/candidate same-scale copies used by the completed performance runs; no search/SCROLL body rows were executed or retained.',
  'Both copies originate from the verified schema5 331-session/47092-message/47870-chunk snapshot. Candidate opens installed idx_messages_source_order. Count preservation is established by the separate runtime benchmark, not an additional scan here.',
  'Both search variants retain original LIKE verification and exact independent-session totals; candidate windows carry only identity/score fields before fetching final message bodies.',
  'SCROLL parameters are fixed non-sensitive representative values; EXPLAIN does not return or inspect a session body or original identity.',
]}
for (const [name, Constructor] of [['before',Before],['after',After]]) {
  const database=name==='before'?'baseline-query.db':'candidate-query.db'
  db = new DatabaseSync(localPath(database), {readOnly:true})
  const f = new Constructor(localPath(database), CaptureDb, {readOnly:true})
  captured.length = 0
  await f.searchPage('session','',5,{role:'assistant',queryMode:'and'})
  const {sql,args} = captured[0]
  report.search[name] = {
    dataset:database,sql,params:args,plan:db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args),
    carriesFullBodiesThroughWindow:/SELECT m\.\*,s.id AS session_id[\s\S]*representatives/.test(sql),
  }
  const select='SELECT id,anchor_id,event_seq,role,text,tool_name FROM messages WHERE session_file=?'
  const operations = name==='before' ? {
    before:select+' AND (COALESCE(event_seq,id)<? OR (COALESCE(event_seq,id)=? AND id<?)) ORDER BY COALESCE(event_seq,id) DESC,id DESC LIMIT ?',
    after:select+' AND (COALESCE(event_seq,id)>? OR (COALESCE(event_seq,id)=? AND id>?)) ORDER BY COALESCE(event_seq,id),id LIMIT ?',
  } : {
    before:select+' AND COALESCE(event_seq,id)<=? AND (COALESCE(event_seq,id)<? OR id<?) ORDER BY COALESCE(event_seq,id) DESC,id DESC LIMIT ?',
    after:select+' AND COALESCE(event_seq,id)>=? AND (COALESCE(event_seq,id)>? OR id>?) ORDER BY COALESCE(event_seq,id),id LIMIT ?',
  }
  operations.start=select+' ORDER BY COALESCE(event_seq,id),id LIMIT 3'
  operations.end=select+' ORDER BY COALESCE(event_seq,id) DESC,id DESC LIMIT 3'
  report.scroll[name]={dataset:database,operations:Object.fromEntries(Object.entries(operations).map(([operation,sql])=>[operation,{sql,
    plan:db.prepare('EXPLAIN QUERY PLAN '+sql).all(...(operation==='start'||operation==='end'?['/representative/session.jsonl.zstd']:['/representative/session.jsonl.zstd',10,10,10,5]))}]))}
  await f.close();db.close()
}
writeFileSync(new URL('./SQL_PLAN_ACTUAL_EVIDENCE.json',import.meta.url),JSON.stringify(report,null,2)+'\n')
process.stdout.write(JSON.stringify({searchBefore:report.search.before.plan,searchAfter:report.search.after.plan,scrollBefore:report.scroll.before.operations,scrollAfter:report.scroll.after.operations})+'\n')
