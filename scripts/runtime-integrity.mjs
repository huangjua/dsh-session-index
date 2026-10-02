import {DatabaseSync} from 'node:sqlite'
import {performance} from 'node:perf_hooks'
import {writeFileSync} from 'node:fs'
const [dbPath,output]=process.argv.slice(2),db=new DatabaseSync(dbPath,{readOnly:true}),start=performance.now()
const report={startedAt:new Date().toISOString(),scope:'full quick_check on isolated candidate copy only; not on production and not in factory/query critical path'}
try{db.exec('PRAGMA query_only=ON');const rows=db.prepare('PRAGMA quick_check').all();report.quickCheckMs=performance.now()-start;report.rows=rows.length;report.ok=rows.length===1 && Object.values(rows[0])[0]==='ok';report.errorCount=rows.filter(r=>Object.values(r)[0]!=='ok').length}
finally{db.close()}
report.totalMs=performance.now()-start;writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));process.exitCode=report.ok?0:1
