import {readFileSync,writeFileSync,readdirSync,copyFileSync,mkdirSync,existsSync} from 'node:fs'
import {resolve,join,relative,dirname,basename} from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
const work=resolve('.'),root=resolve('..')
if(basename(work)!=='work'||basename(root)!=='runtime-fix-20261002')throw new Error('Expected isolated repair workspace')
const generatedAt=new Date().toISOString(),checkpoint=join(root,'checkpoints','PAUSED-'+generatedAt.replace(/[:.]/g,'-'))
mkdirSync(checkpoint,{recursive:true})
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex')
const json=path=>JSON.parse(readFileSync(path,'utf8'))
const write=(path,value)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n')
const walk=directory=>readdirSync(directory,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(join(directory,item.name)):[join(directory,item.name)])
const checked=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.test.json','--noEmit'],{cwd:work,windowsHide:true,encoding:'utf8',timeout:30000})
writeFileSync(join(root,'evidence','PAUSED_TYPECHECK.txt'),(checked.stdout??'')+(checked.stderr??'')+'\n'+JSON.stringify({exitCode:checked.status,signal:checked.signal,errorCode:checked.error?.code??null})+'\n')
const selections=['src','test','scripts','lib'].flatMap(name=>walk(join(work,name))).concat(['package.json','tsconfig.json','tsconfig.test.json','README.md','README_zh.md','cordis.patch.yml','LICENSE'].filter(name=>existsSync(join(work,name))).map(name=>join(work,name)))
const manifest={}
for(const file of selections.sort()){
  const name=relative(work,file).replaceAll('\\','/'),target=join(checkpoint,name)
  mkdirSync(dirname(target),{recursive:true});copyFileSync(file,target);manifest[name]=hash(target)
}
write(join(checkpoint,'FILE_SHA256.json'),manifest)
const original=resolve(root,'..','implementation-session-index'),oldManifest=json(join(root,'baseline','S6-20261002','SOURCE_SHA256.json'))
const originalChecks=Object.entries(oldManifest).map(([name,expected])=>({name,expected,actual:hash(join(original,name)),matched:hash(join(original,name))===expected}))
const sourceChanges=Object.entries(oldManifest).filter(([name,expected])=>existsSync(join(work,name))&&hash(join(work,name))!==expected).map(([name])=>name)
const quantile=(values,p)=>values.length?values.toSorted((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null
const summarize=report=>({round:report.round,readyMs:report.readyMs,coldSequenceMs:report.coldSequenceMs,
  cold:(report.operations??[]).filter(o=>o.condition==='process-cold').map(o=>({op:o.label,totalMs:o.totalMs,backend:o.backend,ok:o.ok,returned:o.returned,correctness:o.correctness,checks:o.checks,rpc:o.rpc})),
  hot:Object.fromEntries(['search','SCROLL'].map(label=>{const operations=(report.operations??[]).filter(o=>o.condition==='hot'&&o.label===label),values=operations.map(o=>o.totalMs);return [label,{count:values.length,p50:quantile(values,.5),p95:quantile(values,.95),max:values.length?Math.max(...values):null,failures:operations.filter(o=>!o.ok).length}]})),
  restarts:report.worker?.restarts??report.finalStatus?.worker?.restarts,valid:report.valid,runChecks:report.runChecks,afterCloseWorker:report.afterCloseWorker})
const querySets=[]
for(const name of readdirSync(join(root,'evidence')).filter(name=>/^(baseline|candidate)(-tool)?-queries/.test(name))){
  const path=join(root,'evidence',name,'RESULTS.json')
  if(existsSync(path)){
    const result=json(path)
    querySets.push({name,evidence:relative(root,path),loadRecorded:existsSync(join(dirname(path),'WINDOWS_LOAD.jsonl')),valid:result.valid,reports:result.reports.map(summarize)})
  }
}
write(join(root,'QUERY_LATENCY.json'),{status:'paused; incomplete acceptance',generatedAt,cache:'Independent processes/connections only; OS disk cache uncontrolled. No cache clearing.',
  instrumentation:'SQL/queue/serialization/recovery recorded by candidate; legacy breakdown unknown. dispatch includes SQL; transport residual is not an independent exact measurement.',
  pendingBoundary:'with-load public-tool rounds 1/3/5 checked pending before background checkpoint reconciliation completed; afterClose zero. Runner now records bounded idle drain but corrected rerun not performed.',sets:querySets})
const normal=json(join(root,'evidence','migration-normal-final','RESULTS.json')),interrupted=json(join(root,'evidence','migration-interrupt-final','RESULTS.json')),dual=json(join(root,'evidence','MIGRATION_DUAL.json'))
write(join(root,'STARTUP_MIGRATION.json'),{status:'paused; incomplete final acceptance',generatedAt,
  normal:normal.runs.map(run=>({phase:run.phase,exitCode:run.exitCode,available:run.report.available,startupMs:run.report.startupMs,before:run.report.before,after:run.report.after,restarts:run.report.worker?.restarts,progressEvents:run.report.events.length})),
  interruption:{exitCode:interrupted.runs[0].exitCode,atCompleted:1000,recovery:interrupted.runs.filter(run=>run.report).map(run=>({phase:run.phase,available:run.report.available,startupMs:run.report.startupMs,before:run.report.before,after:run.report.after}))},
  dual:{available:dual.available,startupMs:dual.startupMs,counts:dual.counts,processedRows:dual.events.map(events=>Math.max(0,...events.filter(e=>e.progress?.phase==='chunks').map(e=>e.progress.completed)))},
  finalDefaults:{handshakeMs:15000,migrationTotalMs:90000,migrationLockMs:60000,migrationStallMs:20000,readMs:10000},
  calibration:'largest measured factory startup 30.092 seconds; normal commit progress gap 8.383 seconds. Large tests preceded final tightening from180/120 to90/60 seconds; final default public apply/status migration still pending.',
  pending:['public default factory migration status test','isolated full quick_check measured separately','final-default candidate verification and package'],
  historical:'Original production quick_check322103ms and offline wrapper600s timeout remain unchanged; no new production check performed.'})
const state={status:'paused by explicit user request',generatedAt,checkpoint,checkpointManifestSha256:hash(join(checkpoint,'FILE_SHA256.json')),
  typecheck:{scope:'latest src and test, --noEmit only',exitCode:checked.status,signal:checked.signal,errorCode:checked.error?.code??null,evidence:'evidence/PAUSED_TYPECHECK.txt'},
  originalSourcePreserved:originalChecks.every(check=>check.matched),originalSourceChecks:originalChecks,sourceChanges,
  compiledRuntimeMatchesLatestSource:false,compiledRuntimeBoundary:'work/lib and checkpoint/lib predate final partial-frame retention and lagging fingerprint polling patches; do not deploy.',
  newReleaseGenerated:false,productionDeploymentPerformed:false,productionHostRestartPerformed:false,productionDataChanged:false,
  pending:['static partial-frame preservation green test','persistent partial frame: bounded3 retries then lost-watch fingerprint recovery test','delta regressions after final builder patch','bounded-idle corrected public performance rerun','public default-factory migration progress/status test','separate full integrity verification on isolated copy','final build, candidate hashes and completed deployment/rollback runbook','separate production deployment/restart authorization and normal UI acceptance']}
write(join(root,'PAUSED_STATE_20261002.json'),state)
write(join(checkpoint,'PAUSED_STATE_20261002.json'),state)
const direct=querySets.find(set=>set.name==='candidate-queries-with-load'),tool=querySets.find(set=>set.name==='candidate-tool-queries-final-ae61e469')
const hot=direct.reports.flatMap(report=>report.hot.search)
const report=`定向运行修复暂停交接（2026-10-02）\n\n状态：用户明确要求最小固化收尾后暂停。任务未完成，不可部署。\n隔离根：${root}\n冻结副本：${checkpoint}\n冻结清单摘要：${state.checkpointManifestSha256}\n最新源码/测试 --noEmit：${checked.status===0?'通过':'未通过/未确认，见evidence/PAUSED_TYPECHECK.txt'}。\n原E实现的22项旧SOURCE清单：${state.originalSourcePreserved?'全部仍匹配，未提交新版未丢失':'发现变化，需要复核'}。G盘未build、未部署、未重启宿主、未修改生产数据。\n\n已完成证据\n1. 根因：实际同规模SCROLL旧计划有TEMP B-TREE，新表达式顺序索引无临时排序；query窗口只携带identity/rank，LIMIT后取正文，完整原消息复核/过滤保留；读超时恢复与writer隔离，实际native SQL取消/退出故障已测。76秒历史仅组合耗时，backend与各SQL耗时仍unknown，未倒推。\n2. FtsClient候选带Windows负载5轮：冷序列ms ${direct.reports.map(r=>r.coldSequenceMs.toFixed(1)).join(', ')}，每轮30热搜索和跳回、正常请求零失败/零重启。公开工具初次5轮全部有效，热搜索p95约163ms、SCROLL p95约26ms；source scan/build冻结且禁止源读取。后续带负载工具轮请求全部通过，但3轮即时pending判定失败，停止请求后排空判定已修脚本，尚未重跑，不能写最终通过。所有异常轮/日志均保留。\n3. 同规模331/47089 schema2经公开createFtsClient自动升级约25.491s，第二次598.944ms无重复迁移；中断在实际1000行后退出，重新打开仍schema2且旧行数保留，再自动升级20.165s；双客户端30.092s，仅一个处理47089行，最终schema5/47089 chunks/0旧checkpoint。进度真实，零重启。默认期限依据实测改为90s/60s/20s，普通读10s不放宽。\n4. 查询/API30项、SQL6项、错误分类5项、实际慢读取消/退出与writer提交隔离、50k长事务并发测试已有通过证据；此前组合回归75项74通过的唯一ready预算用例随后修正并通过定向集。日志保留失败→修复边界，不按重复测试次数包装通过。\n5. delta原因10个可控用例此前通过：确定性拒绝一次delta后必要full；unknown仍有界重试；纯append尾读与full等价；历史18263B的原因仍unknown，无可信历史帧快照，未伪造重放。\n\n最后发现且尚未验收的关键问题\n真实静态半帧红测试发现通用full失败分支会删除旧完整SQL checkpoint、rows清空（evidence/RUNTIME_LAGGING_RETRY_RED.txt）。最小保留旧meta/checkpoint补丁已落盘，并明确source_lagging/retainedPrevious；最新绿测试未执行。index已补最多3次解析及10秒指纹轮询，仅来源新变化重开预算，避免同一半帧无限full与末次watch丢失永久悬空；持久半帧恢复仍未跑。\n\n编译产物边界\nwork/lib及冻结lib不含最后半帧/指纹补丁。SOURCE与runtime分别固化，不声称对应，不发布rc.2完整候选。package已标rc.2草稿；release/RUNTIME-20261002尚未生成。DEPLOYMENT_AND_ROLLBACK.txt是未签署草稿，hash占位与最终验收未填，不可直接执行。\n\n恢复顺序\n1. 先跑runtime-lagging-retry两项绿验证和delta共享回归，确认旧checkpoint/anchors保留、3轮后不重复解析、无watch补齐恢复。\n2. 跑已修idle-drain公开工具基准；保留当前全部异常轮；必要时依据新diff最小补测。\n3. 执行已写未跑的默认factory迁移status脚本及隔离完整quick_check，分别计时，不对生产重扫。\n4. 最终编译、源码/runtime同版验证、生成独立候选与SOURCE/SHA清单、填部署/回滚方案。\n5. 上述完成后再单独请求生产部署及必要宿主重启授权，使用正常界面当前健康/每次backend与耗时验收。\n\n详细数据：QUERY_LATENCY.json、STARTUP_MIGRATION.json、evidence/DELTA_FALLBACK.json、PAUSED_STATE_20261002.json。\n`
writeFileSync(join(root,'RUNTIME_FIX_REPORT.txt'),report)
writeFileSync(join(checkpoint,'RUNTIME_FIX_REPORT.txt'),report)
console.log(JSON.stringify({status:state.status,checkpoint,typecheckExitCode:checked.status,originalSourcePreserved:state.originalSourcePreserved,files:Object.keys(manifest).length,sourceChanges,report:join(root,'RUNTIME_FIX_REPORT.txt')}))
if(checked.status!==0)process.exitCode=1
