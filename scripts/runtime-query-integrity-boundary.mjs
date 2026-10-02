/** Record the actual controller-observed integrity run without rerunning SQL. */
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {dirname,join,relative,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const folder=join(root,'evidence','candidate-tool-queries-normal-upgraded-final-c0ae6e50')
const boundaryPath=join(folder,'RUN_BOUNDARY.json'),boundary=JSON.parse(readFileSync(boundaryPath,'utf8'))
const results=JSON.parse(readFileSync(join(folder,'RESULTS.json'),'utf8'))
const resultPath=join(root,'evidence','FINAL_QUERY_INTEGRITY.json'),result=JSON.parse(readFileSync(resultPath,'utf8'))
const part=relative(join(root,'datasets'),boundary.db)
assert.ok(!part.startsWith('..')&&!isAbsolute(part),'Only isolated dataset')
assert.equal(result.ok,true)
assert.ok(results.reports.every(r=>r.exitCode===0&&!r.afterCloseWorker.workerReady&&!r.afterCloseWorker.readerReady&&r.afterCloseWorker.pendingRequests===0))
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const output=join(root,'evidence','FINAL_QUERY_INTEGRITY_BOUNDARY.json')
assert.ok(!existsSync(output))
writeFileSync(output,JSON.stringify({generatedAt:new Date().toISOString(),db:boundary.db,
  toolBoundary:{path:relative(root,boundaryPath),sha256:sha(boundaryPath)},
  integrityResult:{path:relative(root,resultPath),sha256:sha(resultPath),startedAt:result.startedAt,quickCheckMs:result.quickCheckMs,ok:true},
  command:{cwd:join(root,'work'),launcher:'node scripts/runtime-installed-run.mjs',
    args:['scripts/runtime-integrity.mjs',boundary.db,resultPath]},
  exitEvidence:{source:'controller observed exec session 18623 final write_stdin result; installed-run propagates actual Electron child exit code',exitCode:0},
  allQueryProcessesClosed:true,productionOpened:false},null,2)+'\n')
console.log(JSON.stringify({ok:true,output}))
