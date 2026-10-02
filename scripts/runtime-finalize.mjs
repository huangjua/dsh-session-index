/** Summarize actual acceptance evidence, retaining unsuccessful historical runs. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, resolve, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const work=dirname(dirname(fileURLToPath(import.meta.url))),root=dirname(work)
const json=file=>JSON.parse(readFileSync(file,'utf8'))
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const write=(file,value)=>writeFileSync(join(root,file),JSON.stringify(value,null,2)+'\n')
const args=process.argv.slice(2)
assert.equal(args.length,8,'tool/status/integrity/rollback/delta/FTS/shared/lagging evidence required')
const files=args.map(file=>resolve(root,file))
for(const file of files){const part=relative(root,file);assert.ok(!part.startsWith('..')&&!isAbsolute(part))}
const [tools,status,integrity,rollback,delta,fts,shared,lagging]=files.map(json)
const queryIntegrityFile=join(root,'evidence','FINAL_QUERY_INTEGRITY.json'),queryIntegrity=json(queryIntegrityFile)
assert.equal(queryIntegrity.ok,true,'Actual final query dataset integrity')
assert.equal(json(join(root,'evidence','RELEASE_REPRODUCIBLE.json')).ok,true,'Final runtime must reproduce')
assert.equal(json(join(root,'evidence','FINAL_SOURCE_CHECKS_VERIFIED.json')).exitCode,0,'Latest source/test checks')
assert.equal(tools.valid,true,'Public-tool performance acceptance')
assert.equal(status.valid,true,'Public default-factory migration/status')
assert.equal(integrity.ok,true,'Isolated full quick_check')
assert.equal(rollback.valid,true,'Actual old S6 public-path rollback compatibility')
assert.ok(!status.closeErrorCode&&!rollback.closeErrorCode,'Startup/rollback close must also pass')
assert.equal(delta.valid,true,'Delta classification/equivalence and bounded lagging recovery')
for(const [name,value] of [['FTS',fts],['shared',shared],['lagging',lagging]])assert.equal(value.exitCode,0,name)

const quantile=(a,p)=>{a=[...a].sort((x,y)=>x-y);return a.length?a[Math.ceil(a.length*p)-1]:null}
const stats=values=>({count:values.length,p50:quantile(values,.5),p95:quantile(values,.95),max:values.length?Math.max(...values):null})
const summarize=result=>{
  const reports=result.reports??[],ops=reports.flatMap(r=>r.operations??[])
  return {rounds:reports.length,processCold:reports.map(r=>({round:r.round,readyMs:r.readyMs,coldSequenceMs:r.coldSequenceMs,
    startupPlusColdMs:r.startupPlusColdMs??r.readyMs+r.coldSequenceMs,valid:r.valid,
    operations:(r.operations??[]).filter(o=>o.condition==='process-cold').map(o=>({op:o.label,totalMs:o.totalMs,backend:o.backend,ok:o.ok,returned:o.returned,rpc:o.rpc})),
    restarts:(r.finalStatus?.worker??r.worker)?.restarts,runChecks:r.runChecks,idleDrainMs:r.idleDrainMs})),
    hot:{search:stats(ops.filter(o=>o.condition==='hot'&&o.label==='search').map(o=>o.totalMs)),
      scroll:stats(ops.filter(o=>o.condition==='hot'&&o.label==='SCROLL').map(o=>o.totalMs))},
    failures:ops.filter(o=>!o.ok).length,restarts:reports.map(r=>(r.finalStatus?.worker??r.worker)?.restarts??null)}
}
const latest=summarize(tools)
assert.equal(latest.rounds,5)
assert.ok(latest.processCold.every(r=>r.startupPlusColdMs<=10000&&r.coldSequenceMs<=10000&&r.operations.filter(o=>o.op==='search').every(o=>o.totalMs<=5000)&&r.operations.filter(o=>o.op.startsWith('SCROLL')).every(o=>o.totalMs<=1000)))
assert.ok(tools.reports.every(r=>r.startup.every(s=>s.state!=='migrating')),'Normal cold rounds must not hide one-time migration')
assert.ok(latest.hot.search.count>=30&&latest.hot.scroll.count>=30&&latest.hot.search.p95<=1000&&latest.hot.scroll.p95<=300)
assert.equal(latest.failures,0)
assert.ok(latest.restarts.every(n=>n===0))
assert.ok(tools.reports.every(r=>r.operations.every(o=>o.label==='status'||o.backend==='fts')),'No silent source fallback')
const firstInstallFile=join(root,'evidence','candidate-tool-queries-verified-continuation-cd94f5fd','RESULTS.json')
const firstInstall=json(firstInstallFile),firstInstallSummary=summarize(firstInstall)
assert.equal(firstInstall.valid,true)
assert.ok(firstInstall.reports[0].startup.some(s=>s.state==='migrating'),'Retain actual first-index installation round')
const firstIndexInstallation={...firstInstallSummary.processCold[0],targetMs:10000,
  initializationPlusQueryTargetPassed:firstInstallSummary.processCold[0].startupPlusColdMs<=10000,
  annotation:'Original converged schema5 snapshot lacked the new compatibility expression index; first candidate startup built it. This slow round remains separate and unchanged, not removed from the history.',
  startup:firstInstall.reports[0].startup}
const now=new Date().toISOString(),history=join(root,'reports-history','before-final-'+now.replaceAll(':','-'))
assert.ok(!existsSync(history),'Preserve previous report snapshots')
mkdirSync(history,{recursive:true})
for(const file of ['RUNTIME_FIX_REPORT.txt','QUERY_LATENCY.json','STARTUP_MIGRATION.json','DEPLOYMENT_AND_ROLLBACK.txt'])if(existsSync(join(root,file)))copyFileSync(join(root,file),join(history,file))
const ref=file=>({path:relative(root,file).replaceAll('\\','/'),sha256:sha(file)})
const previous=json(join(history,'STARTUP_MIGRATION.json'))
const historySets=[]
for(const name of readdirSync(join(root,'evidence')).filter(name=>/^(baseline|candidate)(-tool)?-queries/.test(name))) {
  const file=join(root,'evidence',name,'RESULTS.json')
  if(!existsSync(file))continue
  historySets.push({name,evidence:ref(file),valid:json(file).valid??null,...summarize(json(file)),
    windowsLoadRecorded:existsSync(join(dirname(file),'WINDOWS_LOAD.jsonl'))})
}
const loadFile=join(dirname(files[0]),'WINDOWS_LOAD.jsonl')
assert.ok(existsSync(loadFile),'Windows CPU/disk load must be recorded')
const load=readFileSync(loadFile,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
assert.ok(load.length>0&&load.some(s=>Number.isFinite(s.cpuPercent)&&Array.isArray(s.disks)&&s.disks.some(d=>Number.isFinite(d.DiskReadBytesPerSec)&&Number.isFinite(d.DiskWriteBytesPerSec))),'Windows CPU and disk samples must be valid, not merely present')
const baselineComparisonFile=join(root,'evidence','baseline-queries-with-load','RESULTS.json')
const candidateComparisonFile=join(root,'evidence','candidate-queries-with-load','RESULTS.json')
const baselineComparison=summarize(json(baselineComparisonFile)),candidateComparison=summarize(json(candidateComparisonFile))
write('QUERY_LATENCY.json',{status:'isolated acceptance passed; current production pending',generatedAt:now,
  dataset:{schema:5,sessions:331,messages:47092,chunks:47870,checkpoints:331,
    sourceEvidence:ref(join(root,'evidence','DATASET_SNAPSHOT.json')),method:'read-only SQLite backup API includes committed WAL; frozen metadata converged',
    candidateUpgradedSnapshot:ref(join(root,'evidence','CANDIDATE_QUERY_SNAPSHOT.json')),
    storage:'same E storage; every round has independent process/new connections; OS cache uncontrolled, no global cache clearing'},
  historicalProduction:{combinedSearchTwoScrollMs:76000,readerRestarts:2,perOperationMs:'unknown',backend:'unknown',sqlAttribution:'unknown'},
  latest:{...latest,evidence:ref(files[0]),boundary:tools.boundary,reports:tools.reports},
  firstIndexInstallation:{...firstIndexInstallation,evidence:ref(firstInstallFile)},
  initializationCostAnalysis:ref(join(root,'evidence','STARTUP_FIRST_INDEX_ANALYSIS_20261002.json')),
  acceptance:{scope:'ordinary independent-process startup on the verified already-indexed schema5 snapshot plus first search/two SCROLL',
    normalColdStartupPlusQueryTargetPassed:true,normalColdOperationTargetsPassed:true,hotTargetsPassed:true,
    firstIndexInstallationPlusQueryTargetPassed:firstIndexInstallation.initializationPlusQueryTargetPassed,
    allInitializationConditionsBelowTenSeconds:firstIndexInstallation.initializationPlusQueryTargetPassed},
  integrity:{...queryIntegrity,evidence:ref(queryIntegrityFile),scope:'full quick_check of the exact final public-tool isolated dataset after its workers closed'},
  windowsLoad:{samples:load.length,evidence:ref(loadFile),scope:'system CPU/physical disks sampled at 3 seconds; measured, no synthetic load injection'},
  comparison:{before:{...baselineComparison,evidence:ref(baselineComparisonFile)},after:{...candidateComparison,evidence:ref(candidateComparisonFile)},
    scope:'stored same-scale/same-E-storage public FtsClient API runs with Windows load; final public apply/tools additionally measured above',
    limitations:'Sequential rounds, uncontrolled OS cache and variable system load; these timings are not a guaranteed speedup factor or reproduction of historical 76s. The older candidate comparison predates the final delta/index recovery fixes; final runtime correctness and tool targets are verified separately.'},
  historicalSets:historySets,
  interpretation:'Later old-code rounds also meet targets under warm OS cache. Historical76s cannot be ascribed to one SQL or claimed reproduced on every round; all failed/anomalous rounds retained.',
  timingContract:'SQL is inside dispatch; IPC/transport remainder is an estimate marked transportIsResidual. Tool runtime contains source/FTS/fallback/total; RPC contains readiness/recovery/admission/queue/SQL/serialization/transport/role/generation.'})
write('STARTUP_MIGRATION.json',{status:'isolated public-path acceptance passed; production pending',generatedAt:now,
  normal:previous.normal,interruption:previous.interruption,dual:previous.dual,finalDefaults:previous.finalDefaults,
  calibration:'Defaults90s total/60s lock/20s stall: measured prior largest30.092s and commit gap8.383s. The new public apply default factory/status run verifies final defaults; query remains10s.',
  publicDefaultFactory:{...status,evidence:ref(files[1])},integrity:{...integrity,evidence:ref(files[2]),scope:'full quick_check on isolated copy, separately measured; outside startup/query path'},
  rollback:{...rollback,evidence:ref(files[3])},
  historical:{quickCheckMs:322103,offlineWrapperDeadlineMs:600000,offlineWrapperResult:'ETIMEDOUT/SIGTERM failure, never rewritten as success'},
  checkpointBoundary:'Legacy schema2 backup has zero verifiable source checkpoints; migration preserves that reality.331 converged checkpoints belong to the separate schema5 query dataset; full source backfill is not faked in status migration test.',
  backupBoundary:'schema2 main195182592B SHA45760a512054354c78ac34a562479792215de7c1d22d984801aaa7766868b7c5 matches original backup manifest; later0B WAL/32768B SHM are recorded separately, not falsely called original manifest entries.'})
write('DELTA_FALLBACK.json',{...delta,status:'controlled samples passed; historical reason unknown',generatedAt:now,evidence:ref(files[4]),
  portableSamples:(delta.cases??[]).map(c=>({name:c.name,folder:relative(root,c.sample).replaceAll('\\','/'),files:c.sampleSha256})),
  historical:{windowBytes:18263,reason:'unknown',why:'No reliable before/after frame snapshot; historical root cause cannot be reconstructed',
    windowsGrowthBytes:[239,18263,1167],growthBytes:19669,readBytes:117790,deltaAttemptBytes:36526,
    replayClaim:false,longTermFallbackRate:'not measured',nextNaturalSample:'requires later user-authorized normal continuation; no production log fabrication'}})
const evidenceRefs=files.map(ref)
write('FINAL_ACCEPTANCE.json',{ready:true,generatedAt:now,candidateId:'session-index-0.0.3-rc.2-RUNTIME-20261002',
  scope:'R1/R2 isolated correctness/performance/migration; R3 reliable causes and controlled replay; historicalunknown retained',
  queryTargetsPassed:{normalIndexedSchema5ColdStartupPlusQuery:true,normalColdOperations:true,hot:true,
    firstCompatibilityIndexInstallationPlusQuery:firstIndexInstallation.initializationPlusQueryTargetPassed},
  limitations:[{code:'first_index_installation_over_10s',measuredMs:firstIndexInstallation.startupPlusColdMs,targetMs:10000,
    scope:'one-time compatible schema5 index installation plus initial query; ordinary already-indexed cold rounds pass',evidence:ref(firstInstallFile)},
    {code:'production_current_ui_acceptance_pending'},{code:'historical_delta_reason_unknown'}],
  defaultFactoryMigrationPassed:true,integrityPassed:true,rollbackCompatibilityPassed:true,deltaPassed:true,
  evidence:[...evidenceRefs,ref(queryIntegrityFile),ref(firstInstallFile),ref(join(root,'evidence','CANDIDATE_QUERY_SNAPSHOT.json'))],tests:{fts,shared,lagging},
  productionDeploymentPerformed:false,productionHostRestartPerformed:false,productionDataChanged:false,productionToolAcceptance:'pending new deployment authorization and normal current UI diagnostics'})

const build=json(join(root,'evidence','RELEASE_BUILD_BOUNDARY.json')),rounds=latest.processCold.map(r=>r.coldSequenceMs.toFixed(1)).join(', ')
const report=`定向运行修复候选验证完成（2026-10-02，Asia/Hong_Kong）\n生成时间UTC：${now}\n\n状态：隔离候选验证、正确性回归、性能、迁移故障与delta记录已完成；生产部署/宿主重启/生产数据变更尚未执行，待另行确认。\n候选：session-index-0.0.3-rc.2-RUNTIME-20261002\n目录：${build.candidate}\n运行allowlist摘要：${build.runtimeDigest}\nSOURCE22项摘要：${build.sourceDigest}\n完整SHA清单及其摘要以候选CANDIDATE.json与根CANDIDATE_READY.json为准。\n\n一、来源与证据保全\n原E实现22项源码仍与S6 SOURCE清单匹配，未提交新版保留；修复来自隔离work的新源码，未checkout旧HEAD替代。G/lib已部署新版而G/src旧：本轮未在G运行build、未部署、未重启宿主、未变更生产数据。旧S6 release、验收、超时日志、backup及PAUSED checkpoint原样保留。旧报告此次固化于${relative(root,history)}。\n\n二、R1查询根因、修复与实际结果\n已证明：SCROLL旧COALESCE顺序计划存在TEMP B-TREE；候选表达式顺序索引支持seek且无需临时排序。检索的GROUP/window/排序仅携带identity与rank，在LIMIT后才取正文；完整原消息复核、跨块、多词、过滤、会话聚合、准确total及锚点校验保留。schema5普通打开不再重复全部workspace写入。\n已证明：旧call超时会failWorker并连带终止reader与writer。候选独立SQLite子进程可实际取消正在执行的native SQL；reader超时/退出只恢复reader，writer提交/checkpoint保留。排队超时不重启健康通道，执行前须父进程permit。ready/recovery/admission/queue/execution共用10s query预算，有界角色恢复；长writer事务health返回带时间/忙状态快照。历史错误与恢复数不清零。\n历史76秒仍只是full+2SCROLL组合耗时，分项SQL与backend unknown；不把数据损坏、单条SQL或某个fallback猜成历史根因。\n最终安装Electron公开apply/tools五轮，schema5 331/47092/47870/331，冷search+2SCROLL ms：${rounds}。每轮30热搜索+30跳回，聚合search p50/p95/max=${latest.hot.search.p50.toFixed(2)}/${latest.hot.search.p95.toFixed(2)}/${latest.hot.search.max.toFixed(2)}ms，SCROLL=${latest.hot.scroll.p50.toFixed(2)}/${latest.hot.scroll.p95.toFixed(2)}/${latest.hot.scroll.max.toFixed(2)}ms。正常请求失败0/重启0/超时0，backend=fts，source读取0，过滤/身份/anchor/coverage通过。停止请求后有界idle drain确认pending/stream/queue排空，原即时pending误判轮仍保留，未改写原失败。\n冷只指独立进程/新连接；OS缓存未知，不清全机缓存。Windows CPU/磁盘指标留存。元数据扫描/构建在公开工具性能夹具中冻结且源解析禁止，不能称实际生产全源扫描或回填吞吐。回填/并发SQL/transport正确性由隔离事务故障与50k长写入测试覆盖。旧版暖缓存后也可达目标，不夸大性能改善或复现强度。\n分段指标与全部轮次见QUERY_LATENCY.json及其原始RESULTS引用。工程目标全部达到；新生产工具端到端结果仍待本次正常启动验收。\n\n三、R2自动迁移与故障验收\n旧schema2约331/47089经公开createFtsClient自动升级25.491s；第二启动598.944ms；1000行真实进度中断后仍schema2/旧行数，重新自动升级20.165s；双客户端30.092s仅一方处理47089行。新版默认公开apply/factory/status已通过，ready=${status.readyMs?.toFixed(2)}ms，迁移中status有真实阶段/批次数而无需排到同步SQL后。\n握手15s、迁移total90s/lock60s/stall20s分离，依据副本实测设定。同步100行批次之间上报真实进度，固定lock-wait计数不会假装推进。无进展/总期限/崩溃/并发互斥有定向故障测试；整事务推进schema版本，终止回滚可重新自动恢复，普通schema5无重复回填/维护。\n完整quick_check仅隔离库，单独耗时${integrity.quickCheckMs.toFixed(2)}ms，ok=${integrity.ok}；不置于生产启动关键路径。旧322103ms quick_check与600s wrapper ETIMEDOUT历史失败均保持。旧schema2副本checkpoint=0，不冒充331已收敛；本轮query dataset另有真实331checkpoint。\n\n四、R3 delta原因与安全回退\n原因码从解析器/worker结构化对象传递；surface_replace、cross_window_reference、partial_frame、invalid_offset、sequence_mismatch、compatibility_reject、source_changed、coverage_incomplete、worker_failure及unknown保留，未从笼统文本猜类别。记录offset、prev/current字节/seq、attempt、真实读取/解压累积、fallback耗时与最终一致性；不可得统计明确metricsExact=false。确定性拒绝只尝试一次delta然后必要full；unknown/瞬时错误仍有界重试。\n控制样本验证纯append仅读尾段且与full等价；必须full的替换与跨窗口依赖、半帧、偏移/序号错误、worker失败均可追踪。静态半帧保留原meta/SQL checkpoint/rows/anchor，sourceLagging显式可见；同指纹最多3轮，10秒指纹轮询发现补齐。新发现并已修复publication竞态：失败后的重扫会吞补齐指纹，改为以实际解析扫描作基线；重复watch不续同一输入预算，实际FTS恢复可开新的恢复预算。\n历史18263B没有可信帧快照，根因仍unknown，没有伪造历史重放。三窗口真实新增19669B/实际读取117790B保留，不宣称回退归零或长期33%。详见DELTA_FALLBACK.json和新增控制样本日志。\n\n五、最小回归与候选\n按11个共享源码diff选择FTS/query/migration/transport/error、builder/index恢复、delta/native/worker/compat回归；未重新实施14项。旧失败日志保留，新通过以独立输出和exitCode为准，禁止把重复运行次数包装成新增用例数。通过证据：${evidenceRefs.map(e=>e.path).join('; ')}。\n源码/测试typecheck、隔离编译、独立源码重新编译与全部66个lib文件字节比对通过；最终候选与实测work/lib一致，SOURCE22项可核对。产物、源码、测试/脚本、脱敏证据独立打包；不包含生产库、原始会话正文、凭证或node_modules。\n新→旧S6→新公开FtsClient的search/SCROLL/checkpoint逻辑摘要与合成replace/append收据通过，schema5计数/身份/内容/checkpoint保持，可执行保留现有schema5的运行产物回滚。\n\n六、部署边界与待验证项\n部署与回滚步骤详见DEPLOYMENT_AND_ROLLBACK.txt，执行对象为具体RUNTIME_SHA256 allowlist，保留现有用户配置与依赖。部署前正常停写、全产物/配置/dataDir一致性备份并逐文件校验，禁止只copy活跃主db、禁止G盘build。\n候选准备完成后单独请求新版本部署及必要正常宿主重启授权；数据恢复另行确认。获准后通过当前正常界面/支持诊断获取新PID健康、每请求backend/分段/总耗时、身份/coverage及自然delta证据。没有安全认证入口时用用户正常工具/导出，不绕401、不提hostCookie、不注入ASAR/NODE_OPTIONS。生产验收待验证，旧PID15916结果不能代替。\n`
const migrationEvents=status.startupEvents.filter(s=>s.state==='migrating')
const migrationPhaseMs=migrationEvents.at(-1).atMs-migrationEvents[0].atMs
const writerReadyMs=status.startupEvents.find(s=>s.role==='writer'&&s.state==='ready').atMs
const finalReport=report
  .replace('（2026-10-02，Asia/Hong_Kong）',`（任务日期2026-10-02；完成日期${new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now))}，Asia/Hong_Kong）`)
  .replace('旧版暖缓存后也可达目标，不夸大性能改善或复现强度。',
    `相同E位置、同规模FtsClient对比（每版5进程、每轮30+30热请求）：旧版冷查询序列=${baselineComparison.processCold.map(r=>r.coldSequenceMs.toFixed(1)).join(', ')}ms，search热p95=${baselineComparison.hot.search.p95.toFixed(2)}ms、SCROLL=${baselineComparison.hot.scroll.p95.toFixed(2)}ms；候选对应序列=${candidateComparison.processCold.map(r=>r.coldSequenceMs.toFixed(1)).join(', ')}ms，热p95=${candidateComparison.hot.search.p95.toFixed(2)}/${candidateComparison.hot.scroll.p95.toFixed(2)}ms。该API对比与最终公开工具计时分开列出，缓存和系统负载不受控，不承诺固定提升倍率。旧版暖缓存后也可达目标，不夸大性能改善或复现强度。`)
  .replace('工程目标全部达到；新生产工具端到端结果仍待本次正常启动验收。',
    `已升级且已有新索引的正常schema5副本五轮：启动+冷查询=${latest.processCold.map(r=>r.startupPlusColdMs.toFixed(1)).join(', ')}ms；各冷操作与冷热目标均达到。首次兼容索引安装另列：ready=${firstIndexInstallation.readyMs.toFixed(1)}ms，查询=${firstIndexInstallation.coldSequenceMs.toFixed(1)}ms，合计=${firstIndexInstallation.startupPlusColdMs.toFixed(1)}ms，包含首次初始化时未达到10秒目标。该慢轮与CPU/磁盘/迁移阶段完整保留，不将后续暖OS缓存轮替代首轮，不宣称所有首次安装条件都达标。新生产工具端到端结果仍待正常启动验收。`)
  .replace('握手15s、迁移total90s/lock60s/stall20s分离，依据副本实测设定。',
    `默认factory真实迁移阶段=${migrationPhaseMs.toFixed(2)}ms、writerReady=${writerReadyMs.toFixed(2)}ms，均超过旧15秒；迁移中${status.statusTiming.migratingSamples}次status p95=${status.statusTiming.migratingP95Ms.toFixed(3)}ms/max=${status.statusTiming.migratingMaxMs.toFixed(3)}ms，公开render中的role/state/phase/实际计数通过。握手15s、迁移total90s/lock60s/stall20s分离，依据副本实测设定。`)
  .replace('无进展/总期限/崩溃/并发互斥有定向故障测试；',
    '公开client故障夹具以缩短的期限验证真实native SQL卡死/总期限/父进程退出和隔离恢复；生产默认期限另由上述全规模factory运行校准验证，未声称故障测试等待过完整20/60/90秒。无进展/总期限/崩溃/并发互斥有定向故障测试；')
  .replace('分段指标与全部轮次见QUERY_LATENCY.json',
    `最终公开工具性能副本在所有workers关闭后另做完整quick_check：${queryIntegrity.quickCheckMs.toFixed(2)}ms、ok=true，作为该同规模数据集的完整性标志；不与迁移副本检查混用。分段指标与全部轮次见QUERY_LATENCY.json`)
  .replace('通过证据：',
    'FTS原63例中62例通过，1例progressing fixture失败保留；按实测274ms批次间隙修正测试夹具后仅该1例复测通过，生产超时未放宽。共享9文件93/93与半帧/竞态/实际FTS恢复4/4通过，不称重复运行增加覆盖。通过证据：')
  .replace('可执行保留现有schema5的运行产物回滚。',
    '可执行保留现有schema5的运行产物回滚。旧S6部分验证的是公开读API及schema5普通初始化，不宣称旧S6写入兼容已实测；生产回滚尚未执行。')
  .replace('三、R2自动迁移与故障验收',
    '首次初始化进一步分析见evidence/STARTUP_FIRST_INDEX_ANALYSIS_20261002.json：迁移receipt约7.320s，complete→writer ready约2.884s；后者仅能定位到startup health/stat/telemetry/IPC范围，SQL与传输分项unknown。必要表达式索引只安装一次。schema5首次兼容初始化尚有create/drop旧trigger的重复DDL，可能优化方案未量化收益，不声称这是历史76s或本轮慢初始化的主因、硬件I/O下限或已证明最小成本。\n\n三、R2自动迁移与故障验收')
  .replace('源码/测试typecheck、隔离编译、',
    `DEPLOYMENT_DIFF.json对批准S6保存件逐文件核对：${json(join(root,'DEPLOYMENT_DIFF.json')).deploymentFiles}个运行文件，${json(join(root,'DEPLOYMENT_DIFF.json')).changedDeploymentFiles}个变化；新SOURCE22项中11项变化。该比较基线为保存的批准release，部署前仍须核对当前停写G目标并备份。源码/测试typecheck、隔离编译、`)
writeFileSync(join(root,'RUNTIME_FIX_REPORT.txt'),finalReport)
let runbook=readFileSync(join(history,'DEPLOYMENT_AND_ROLLBACK.txt'),'utf8')
runbook=runbook.replace(/^暂停标记：.*$/m,'验证完成：最终最小回归、公开工具5轮性能、默认factory迁移status、隔离完整检查和旧S6回滚兼容均通过；生产执行待用户另行批准。')
runbook=runbook.replace(/^新 CANDIDATE.json 摘要：.*$/m,'新 CANDIDATE.json：candidateId=session-index-0.0.3-rc.2-RUNTIME-20261002，schema5；完整摘要与数量读取CANDIDATE_READY.json/CANDIDATE.json并核对，不自包含循环哈希。')
runbook=runbook.replace(/^新 SHA256.json 文件摘要：.*$/m,'新 SHA256.json文件摘要：精确值为CANDIDATE.json.sha256Manifest（根CANDIDATE_READY.json同值），逐项验证清单后执行。')
runbook=runbook.replace(/^新 SOURCE_SHA256.json 文件摘要：.*$/m,'新 SOURCE_SHA256.json 文件摘要：'+build.sourceDigest)
runbook=runbook.replace(/^本次部署文件清单及摘要：.*$/m,'本次部署文件清单：RUNTIME_SHA256.json；摘要：'+build.runtimeDigest+'；仅lib/package/README，通用portable模板不替换用户配置。')
runbook=runbook.replace(/^已完成正确性、冷\/热性能、故障、迁移与 delta 证据：.*$/m,'已完成证据：FINAL_ACCEPTANCE.json及QUERY_LATENCY/STARTUP_MIGRATION/DELTA_FALLBACK；运行产物可复现。当前生产正常UI验收待部署后执行。')
runbook=runbook.replace('一、执行对象与待填清单','一、执行对象与验证清单')
runbook=runbook.replace('以及清单中明确声明为 portable 的发布模板。','portable模板在此次部署allowlist外。')
runbook=runbook.replace('与被明确批准的 portable 模板。','；此次portable模板不在allowlist，不复制。')
runbook=runbook.replace('二、授权边界与部署前必须具备的可审查结果',
  `已知性能边界：正常已索引schema5启动+查询五轮均≤10s；首次安装兼容表达式索引的一个真实慢轮为${firstIndexInstallation.startupPlusColdMs.toFixed(1)}ms，含初始化未达10s，保留原始记录。生产首次启动应观察迁移状态与实际耗时，不能承诺该条件总耗时≤10s。\n\n二、授权边界与部署前必须具备的可审查结果`)
runbook=runbook.replace(/^  若实际打包位置.*$/m,'')
assert.ok(!runbook.includes('[由 root 填写'),'All placeholders must be resolved')
writeFileSync(join(root,'DEPLOYMENT_AND_ROLLBACK.txt'),runbook)
console.log(JSON.stringify({ready:true,generatedAt:now,query:latest.hot,coldMs:latest.processCold.map(r=>r.coldSequenceMs),migrationReadyMs:status.readyMs,integrityMs:integrity.quickCheckMs,history}))
