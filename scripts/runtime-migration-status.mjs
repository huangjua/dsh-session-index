/**
 * Public apply/default-FtsClient schema2 migration and status responsiveness.
 * Usage (from isolated work):
 *   node scripts/runtime-migration-status.mjs <inactive-complete-schema2-db> [frozen-index-json] [deadline-ms]
 * The caller must provide a consistent, inactive backup. If present, its WAL and
 * SHM companions are copied together. Only a fresh isolated copy is upgraded.
 * This is a migration/status test: source parsing, backfill and directory scanning
 * are frozen. Dirty checkpoints therefore remain real and are not a pass gate.
 */
import {readFile,writeFile,mkdir,copyFile,stat} from 'node:fs/promises'
import {resolve,join,dirname,relative,isAbsolute} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {spawn} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {performance} from 'node:perf_hooks'

const scriptFile=fileURLToPath(import.meta.url)
const workDir=dirname(dirname(scriptFile)),runtimeRoot=dirname(workDir),workspaceRoot=dirname(runtimeRoot)
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]))
const errorCode=error=>typeof error?.code==='string'&&/^[A-Za-z0-9_]{1,80}$/.test(error.code)?error.code:'unknown'
const safeStartup=value=>value?{
  ...pick(value,['role','generation','state','startedAt','updatedAt','elapsedMs']),
  ...(value.progress?{progress:pick(value.progress,['phase','completed','total','elapsedMs','at'])}:{}),
  ...(value.error?{error:pick(value.error,['name','code','sqliteErrorCode'])}:{}),
}:null
const safeWorker=value=>value?pick(value,['workerReady','readerReady','degraded','restarts','writerRestarts','readerRestarts',
  'writerGeneration','readerGeneration','writerTransport','readerTransport','requestTimeouts','queueTimeouts',
  'writerTransportFailures','readerTransportFailures','pendingRequests','pendingWrites','activeStreams','queueBytes']):null
const safeStatus=value=>({
  ...pick(value,['fts','ftsSessions','active','sessions','sourceLagging']),
  health:pick(value.ftsHealth,['ok','sessions','messages','schemaVersion','dirtySessions','dirtySessionsExact',
    'dirtySessionsObservedAt','pendingWrites','failedSessions','acceptingWrites','incompleteSessions']),
  startup:safeStartup(value.ftsHealth?.startup),worker:safeWorker(value.ftsHealth?.worker),
})
const quantile=(values,p)=>values.length?[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor((values.length-1)*p))]:null
const sleep=ms=>new Promise(accept=>setTimeout(accept,ms))
const within=(root,path)=>{const part=relative(root,path);return part!==''&&!part.startsWith('..')&&!isAbsolute(part)}

async function parent() {
  const [backupArg,indexArg=join(runtimeRoot,'datasets','schema5-index.json'),deadlineArg='240000']=process.argv.slice(2)
  if(!backupArg)throw Object.assign(new Error('Provide an inactive, consistent schema2 backup'),{code:'EBACKUPARG'})
  const sourceDb=resolve(backupArg),sourceIndex=resolve(indexArg),deadlineMs=Number(deadlineArg)
  if(!within(workspaceRoot,sourceDb)||!within(workspaceRoot,sourceIndex))throw Object.assign(new Error('Inputs must be workspace backup files'),{code:'EBACKUPBOUNDARY'})
  if(!Number.isInteger(deadlineMs)||deadlineMs<20000||deadlineMs>600000)throw Object.assign(new Error('deadline-ms must be 20000..600000'),{code:'EDEADLINEARG'})
  const runId=randomUUID(),runRoot=join(runtimeRoot,'datasets','migration-public-status-'+runId)
  const dataDir=join(runRoot,'data'),sessionsRoot=join(runRoot,'sessions'),evidenceDir=join(runtimeRoot,'evidence','migration-public-status-'+runId)
  await mkdir(dataDir,{recursive:true});await mkdir(sessionsRoot,{recursive:true});await mkdir(evidenceDir,{recursive:true})
  const dbPath=join(dataDir,'fts.db'),indexPath=join(dataDir,'index.json'),output=join(evidenceDir,'RESULTS.json')
  const backupCopies=[]
  for(const suffix of ['','-wal','-shm']) {
    const source=sourceDb+suffix
    try {
      const info=await stat(source)
      if(!info.isFile())throw Object.assign(new Error('Backup input must be a file'),{code:'EBACKUPFILE'})
      await copyFile(source,dbPath+suffix);backupCopies.push({suffix,bytes:info.size})
    } catch(error) {if(suffix&&error.code==='ENOENT')continue;throw error}
  }
  const frozen=JSON.parse(await readFile(sourceIndex,'utf8'))
  if(!Array.isArray(frozen.sessions)||frozen.sessions.length!==331)throw Object.assign(new Error('Expected 331 frozen sessions'),{code:'EINDEXCOUNT'})
  frozen.root=sessionsRoot
  await writeFile(indexPath,JSON.stringify(frozen)+'\n')
  await writeFile(join(evidenceDir,'BOUNDARY.json'),JSON.stringify({
    runId,input:'caller-provided inactive complete schema2 backup; main/WAL/SHM copied if present',backupCopies,
    index:'frozen 331-session metadata; only index.root changed',
    defaultFactory:true,sourceParsing:false,directoryScan:false,productionWrites:false,
    backfill:false,expectedMigratedMessages:47089,
  },null,2)+'\n')
  const environment={...process.env,ELECTRON_RUN_AS_NODE:'1'}
  delete environment.NODE_OPTIONS
  const executable=process.env.DSH_RUNTIME_EXE??'E:/Program Files (x86)/DSH-D/DeepSeek Harness.exe'
  let stderrBytes=0
  const child=spawn(executable,['--no-warnings',scriptFile,'--child',dbPath,indexPath,sessionsRoot,output,String(deadlineMs)],
    {cwd:workDir,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']})
  child.stdout.on('data',chunk=>process.stdout.write(chunk))
  child.stderr.on('data',chunk=>{stderrBytes+=chunk.length})
  const exit=await new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>accept({code,signal}))})
  await writeFile(join(evidenceDir,'PROCESS.json'),JSON.stringify({...exit,stderrBytes,rawStderrStored:false},null,2)+'\n')
  console.log(JSON.stringify({evidenceDirectory:evidenceDir,...exit,stderrBytes,rawStderrStored:false}))
  if(exit.code!==0)process.exitCode=exit.code??1
}

async function child() {
  const [,dbArg,indexArg,rootArg,outputArg,deadlineArg]=process.argv.slice(2)
  const dbPath=resolve(dbArg),indexPath=resolve(indexArg),sessionsRoot=resolve(rootArg),output=resolve(outputArg),deadlineMs=Number(deadlineArg)
  const runRoot=dirname(dirname(dbPath))
  if(dirname(dbPath)!==dirname(indexPath)||!within(runRoot,sessionsRoot)||!within(runtimeRoot,dbPath))throw Object.assign(new Error('Child paths must be isolated'),{code:'EISOLATION'})
  const frozen=JSON.parse(await readFile(indexPath,'utf8'))
  if(resolve(frozen.root)!==sessionsRoot||frozen.sessions.length!==331)throw Object.assign(new Error('Frozen index boundary mismatch'),{code:'EFROZENINDEX'})
  const files=frozen.sessions.map(meta=>({file:meta.file,size:meta.size,mtimeMs:meta.mtimeMs,ctimeMs:meta.ctimeMs}))
  const samples=[],startupEvents=[],sourceDenials=[],cleanups=[],tools={}
  const report={generatedAt:new Date().toISOString(),defaultFactory:true,expectedMigratedMessages:47089,
    runtime:pick(process.versions,['node','electron','sqlite']),
    boundary:{frozenMetadata:true,actualDirectoryScan:false,actualSourceParsing:false,officialSourceLogsRead:false,
      sourceFingerprint:hash(files),sessions:files.length,backfill:false,
      build:'process-local no-op; completed report with zero source bytes',
      sqlite:'real public apply default FtsClient; isolated database',
      dirtyCheckpointMeaning:'observed cache only; legacy checkpoints are not repaired by this test'},
    buildNoopCalls:0,frozenScanCalls:0,samples,startupEvents,sourceDenials}
  const moduleDir=join(workDir,'lib')
  const [{apply},{SessionIndexBuilder},{WorkerPool}]=await Promise.all([
    import(pathToFileURL(join(moduleDir,'index.js')).href),
    import(pathToFileURL(join(moduleDir,'session-index-builder.js')).href),
    import(pathToFileURL(join(moduleDir,'worker-pool.js')).href),
  ])
  const originalBuild=SessionIndexBuilder.prototype.build,originalRun=WorkerPool.prototype.run
  SessionIndexBuilder.prototype.build=function() {
    report.buildNoopCalls++
    const result={status:'completed',scanComplete:true,scanTruncated:false,failedSubtrees:[],totalFiles:files.length,
      processed:0,headParsed:0,fullParsed:0,added:0,updated:0,skipped:files.length,removed:0,raced:0,failed:0,pruned:0,
      errors:[],scannedBytes:0,discoveredBytes:0,readBytes:0,decodedBytes:0,deltaBytes:0,deltaParsed:0,deltaFallbacks:0,
      ftsSynced:0,ftsFailed:0,incompleteSessions:0,indexFile:this.indexFile,durationMs:0,maxEventLoopDelayMs:0,existingNoop:true}
    this.lastReport=result
    return Promise.resolve(result)
  }
  WorkerPool.prototype.run=function(task) {
    sourceDenials.push({mode:task.mode,fileFingerprint:hash(task.file),errorCode:'EFROZENSOURCE'})
    return Promise.reject(Object.assign(new Error('Source parsing prohibited at the frozen boundary'),{code:'EFROZENSOURCE'}))
  }
  const ctx={logger:()=>({info(){},warn(){},error(){}}),tools:{register(tool){tools[tool.name]=tool}},
    effect(effect){const cleanup=effect();if(typeof cleanup==='function')cleanups.push(cleanup)}}
  Object.defineProperty(ctx,'llm',{get(){throw Object.assign(new Error('LLM forbidden in migration status test'),{code:'EFROZENLLM'})}})
  const started=performance.now()
  try {
    // Intentionally omit createSessionFts: exercise apply's actual public default.
    apply(ctx,{sessionsRoot,dataDir:dirname(dbPath),indexFile:indexPath,retentionDays:0,ftsEnabled:true,
      llmSummaryEnabled:false,deltaEnabled:true,maxHits:50,maxSnippetsPerSession:3},{
      createSessionWatcher:()=>({ok:true,close(){}}),
      scanSessionFiles:async root=>{
        if(resolve(root)!==sessionsRoot)throw Object.assign(new Error('Unexpected scan root'),{code:'EFROZENROOT'})
        report.frozenScanCalls++
        return {files:files.map(file=>({...file})),complete:true,truncated:false,errors:[],failedSubtrees:[]}
      },
      onRuntimeDiagnostic:event=>{
        if(event.kind==='fts-startup'||event.kind==='fts-startup-failure')startupEvents.push({atMs:performance.now()-started,kind:event.kind,...safeStartup(event)})
      },
    })
    if(!tools.session_index_status)throw Object.assign(new Error('Public status tool missing'),{code:'ESTATUSTOOL'})
    while(performance.now()-started<deadlineMs) {
      const requestAt=performance.now()
      let timer
      const result=await Promise.race([
        tools.session_index_status.execute({}),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Status request exceeded its bound'),{code:'ESTATUSSTALL'})),5000)}),
      ]).finally(()=>clearTimeout(timer))
      const rendered=tools.session_index_status.output.render({},result).map(block=>block.text??'').join('\n')
      // Never retain rendered paths, errors, metadata or body. Only verify the
      // actual parent-held startup values are visible to the normal tool UI.
      const startupLine=rendered.split(/\r?\n/).find(line=>line.startsWith('ftsStartup:'))??''
      const tokens=new Set(startupLine.split(/\s+/)),startup=result.ftsHealth?.startup
      const presentation={
        startupLinePresent:!!startupLine,
        stateRendered:!!startup&&tokens.has(`state=${startup.state}`),
        roleRendered:!!startup&&tokens.has(`role=${startup.role}`),
        phaseRendered:!!startup&&tokens.has(`phase=${startup.progress?.phase??'-'}`),
        completedRendered:!!startup&&tokens.has(`completed=${startup.progress?.completed??'-'}`),
        totalRendered:!!startup&&tokens.has(`total=${startup.progress?.total??'-'}`),
      }
      const sample={atMs:requestAt-started,requestMs:performance.now()-requestAt,...safeStatus(result),presentation}
      samples.push(sample)
      if(result.fts&&result.ftsSessions===331&&String(result.ftsHealth?.schemaVersion)==='5'&&result.ftsHealth?.messages===47089
        &&result.ftsHealth?.worker?.workerReady&&result.ftsHealth?.worker?.readerReady) {
        report.finalStatus=sample;report.readyMs=performance.now()-started;break
      }
      if(sample.startup?.state==='failed')throw Object.assign(new Error('Public startup reported failure'),{code:sample.startup.error?.code??'ESTARTUPFAILED'})
      await sleep(100)
    }
    if(!report.finalStatus)throw Object.assign(new Error('Migration did not reach public ready within bound'),{code:'EMIGRATIONREADY'})
    const migrating=samples.filter(sample=>sample.startup?.state==='migrating')
    const completed=new Map()
    let monotonic=true,bounded=true
    for(const event of startupEvents) {
      if(!event.progress)continue
      const {phase,completed:count,total}=event.progress,key=`${event.role}:${event.generation}:${phase}`
      if(completed.has(key)&&count<completed.get(key))monotonic=false
      if(!Number.isInteger(count)||count<0||(total!==undefined&&count>total))bounded=false
      completed.set(key,count)
    }
    report.statusTiming={samples:samples.length,p50Ms:quantile(samples.map(s=>s.requestMs),.5),p95Ms:quantile(samples.map(s=>s.requestMs),.95),
      maxMs:Math.max(...samples.map(s=>s.requestMs)),migratingSamples:migrating.length,
      migratingP95Ms:quantile(migrating.map(s=>s.requestMs),.95),migratingMaxMs:migrating.length?Math.max(...migrating.map(s=>s.requestMs)):null}
    const worker=report.finalStatus.worker
    report.checks={defaultFactory:true,publicMigrationObserved:migrating.length>0,
      realChunkProgressObserved:startupEvents.some(e=>e.progress?.phase==='chunks'&&e.progress.completed>0),
      finalChunkCount:startupEvents.some(e=>['chunks','commit','complete'].includes(e.progress?.phase)&&e.progress.completed===47089&&e.progress.total===47089),
      progressMonotonicPerPhase:monotonic,progressWithinDeclaredTotal:bounded,
      migratingStatusWithinOneSecond:migrating.length>0&&migrating.every(s=>s.requestMs<1000),
      migratingStateAndRoleRendered:migrating.length>0&&migrating.every(s=>s.presentation.stateRendered&&s.presentation.roleRendered),
      migratingRealProgressRendered:migrating.length>0&&migrating.every(s=>s.presentation.phaseRendered&&s.presentation.completedRendered&&s.presentation.totalRendered),
      publicReady:true,messageCount:report.finalStatus.health.messages===47089,schemaVersion:report.finalStatus.health.schemaVersion==='5',
      noSourceReads:sourceDenials.length===0,noRestarts:worker?.restarts===0,
      noRequestTimeouts:worker?.requestTimeouts===0&&worker?.queueTimeouts===0,
      noTransportFailures:worker?.writerTransportFailures===0&&worker?.readerTransportFailures===0}
    report.valid=Object.values(report.checks).every(Boolean)
  } catch(error) {report.errorCode=errorCode(error);report.valid=false}
  finally {
    const closeAt=performance.now()
    for(const cleanup of cleanups.reverse()) {try{await cleanup()}catch(error){report.closeErrorCode=errorCode(error)}}
    report.closeMs=performance.now()-closeAt
    SessionIndexBuilder.prototype.build=originalBuild;WorkerPool.prototype.run=originalRun
    report.totalMs=performance.now()-started
    await writeFile(output,JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify({valid:report.valid,readyMs:report.readyMs,statusTiming:report.statusTiming,checks:report.checks,
      errorCode:report.errorCode,closeErrorCode:report.closeErrorCode,blockedSourceReads:sourceDenials.length}))
    if(!report.valid||report.closeErrorCode)process.exitCode=1
  }
}

try {if(process.argv[2]==='--child')await child();else await parent()}
catch(error){console.log(JSON.stringify({valid:false,errorCode:errorCode(error)}));process.exitCode=1}
