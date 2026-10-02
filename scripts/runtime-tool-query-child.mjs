/** Public apply/tools benchmark over a frozen, converged metadata snapshot.
 * Official source logs are never opened: building is a process-local no-op and
 * parser-pool requests are denied. SQLite, the public tool path, ranking, filters,
 * anchors, and the actual FtsClient/process transport remain real.
 */
import {readFileSync,writeFileSync} from 'node:fs'
import {dirname,resolve,join,relative,isAbsolute} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {performance} from 'node:perf_hooks'

const [moduleFileArg,dbPathArg,indexPathArg,sessionsRootArg,outputArg,roundArg,hotArg='30']=process.argv.slice(2)
if(!outputArg)throw new Error('Expected moduleFile dbPath indexPath isolatedSessionsRoot output round hotCount')
const moduleFile=resolve(moduleFileArg),dbPath=resolve(dbPathArg),indexPath=resolve(indexPathArg),sessionsRoot=resolve(sessionsRootArg),output=resolve(outputArg)
const hotCount=Number(hotArg)
if(!Number.isInteger(hotCount)||hotCount<0||hotCount>300)throw new Error('hotCount must be 0..300')
if(dirname(dbPath)!==dirname(indexPath))throw new Error('Database and index must share the isolated dataDir')
const rootDir=dirname(dirname(dbPath))
for(const path of [sessionsRoot,dbPath,indexPath]) {
  const part=relative(rootDir,path)
  if(part.startsWith('..')||isAbsolute(part))throw new Error('Benchmark paths must stay in one isolated run directory')
}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const pick=(object,keys)=>Object.fromEntries(keys.filter(key=>object?.[key]!==undefined).map(key=>[key,object[key]]))
const safeRpc=event=>pick(event,['requestId','parentRequestId','op','backend','role','generation','startedAt','totalMs','readyWaitMs','recoveryWaitMs','admissionMs','queueMs','sqlMs','dispatchMs','serializationMs','transportMs','responseTransportMs','transportIsResidual','outcome','errorCode','timeoutPhase'])
const safeRuntime=event=>pick(event,['requestId','op','backend','readyMs','sourceMs','ftsMs','recoveryMs','fallbackMs','totalMs','outcome','returned','coverageComplete','reason','errorCode'])
const safeStartup=event=>({...pick(event,['role','generation','state','startedAt','updatedAt','elapsedMs']),
  ...(event.progress?{progress:pick(event.progress,['phase','completed','total','elapsedMs','at'])}:{}),
  ...(event.error?{error:pick(event.error,['name','code','sqliteErrorCode'])}:{})})
const safeWorker=worker=>({...pick(worker,['workerReady','readerReady','degraded','restarts','writerRestarts','readerRestarts','writerGeneration','readerGeneration','writerTransport','readerTransport','writerPid','readerPid','writerTransportFailures','readerTransportFailures','requestTimeouts','queueTimeouts','cancelledRequests','pendingRequests','writerPendingRequests','readerPendingRequests','pendingWrites','activeStreams','queueBytes','queuedProducers','restartSuspended','readerRestartSuspended','writerRestartSuspended','acceptingWrites','lastReaderTerminationMs','maxReaderTerminationMs']),
  lastTransportErrorPresent:!!worker?.lastTransportError,writerLastTransportErrorPresent:!!worker?.writerLastTransportError,readerLastTransportErrorPresent:!!worker?.readerLastTransportError})
const safeStatus=status=>({fts:status.fts,ftsSessions:status.ftsSessions,active:status.active,sessions:status.sessions,
  ...pick(status,['sourceLagging','unstableRefreshAttempts']),
  ftsHealth:pick(status.ftsHealth,['ok','sessions','messages','schemaVersion','dirtySessions','dirtySessionsExact','dirtySessionsObservedAt','pendingWrites','failedSessions','acceptingWrites','incompleteSessions']),
  worker:safeWorker(status.ftsHealth?.worker)})
const fixedIndex=JSON.parse(readFileSync(indexPath,'utf8'))
if(resolve(fixedIndex.root)!==sessionsRoot)throw new Error('Copied index.root must point to isolated sessionsRoot')
if(fixedIndex.sessions.length!==331)throw new Error('Expected the verified 331-session frozen snapshot')
const frozenFiles=fixedIndex.sessions.map(meta=>({file:meta.file,size:meta.size,mtimeMs:meta.mtimeMs,ctimeMs:meta.ctimeMs}))
const metadataByFile=new Map(fixedIndex.sessions.map(meta=>[meta.file,meta]))
const events=[],rpc=[],startup=[],operations=[],sourceDenials=[]
const report={round:Number(roundArg),generatedAt:new Date().toISOString(),
  runtime:{node:process.version,electron:process.versions.electron,sqlite:process.versions.sqlite,platform:process.platform},
  boundary:{frozenMetadata:true,actualDirectoryScan:false,actualSourceParsing:false,officialSourceLogsRead:false,
    build:'process-local SessionIndexBuilder.prototype.build no-op; existing index only',
    scan:'dependency returns frozen file fingerprints; paths/session identities remain unchanged',
    watcher:'injected ok:true watcher with no OS registration',
    sqlite:'real candidate FtsClient with isolated SQLite writer/reader processes',
    sessions:fixedIndex.sessions.length,metadataFingerprint:hash(frozenFiles),
    incompleteMetadata:fixedIndex.sessions.filter(meta=>meta.coverage?.complete!==true||meta.ftsDirty||meta.detailMissing||meta.unindexable).length},
  coldCondition:'independent process and new SQLite connections; OS disk cache uncontrolled and may already be warm',
  cache:'no global cache clearing; frozen metadata validated only',
  queryFingerprint:hash('session'),filter:{role:'assistant'},limit:5,hotCount,
  operations,rpc,startup,sourceDenials,buildNoopCalls:0,frozenScanCalls:0}
const beganAt=performance.now(),cpuStart=process.cpuUsage()
const moduleDir=dirname(moduleFile)
const [{apply},{SessionIndexBuilder},{WorkerPool},{createFtsClient}]=await Promise.all([
  import(pathToFileURL(moduleFile).href),import(pathToFileURL(join(moduleDir,'session-index-builder.js')).href),
  import(pathToFileURL(join(moduleDir,'worker-pool.js')).href),import(pathToFileURL(join(moduleDir,'fts-client.js')).href),
])
const originalBuild=SessionIndexBuilder.prototype.build,originalRun=WorkerPool.prototype.run
SessionIndexBuilder.prototype.build=function() {
  report.buildNoopCalls++
  const value={status:'completed',scanComplete:true,scanTruncated:false,failedSubtrees:[],totalFiles:frozenFiles.length,
    processed:0,headParsed:0,fullParsed:0,added:0,updated:0,skipped:frozenFiles.length,removed:0,raced:0,failed:0,
    pruned:0,errors:[],scannedBytes:0,discoveredBytes:0,readBytes:0,decodedBytes:0,deltaBytes:0,
    deltaParsed:0,deltaFallbacks:0,ftsSynced:0,ftsFailed:0,incompleteSessions:0,
    indexFile:this.indexFile,durationMs:0,maxEventLoopDelayMs:0,existingNoop:true}
  this.lastReport=value
  return Promise.resolve(value)
}
WorkerPool.prototype.run=function(task) {
  sourceDenials.push({mode:task.mode,fileFingerprint:hash(task.file),errorCode:'EFROZENSOURCE'})
  return Promise.reject(Object.assign(new Error('Source reading is prohibited in the frozen-metadata benchmark'),{code:'EFROZENSOURCE'}))
}
let client=null,firstIdentity=null
const tools={},cleanups=[]
const ctx={logger:()=>({info(){},warn(){},error(){}}),tools:{register(tool){tools[tool.name]=tool}},
  effect(effect){const cleanup=effect();if(typeof cleanup==='function')cleanups.push(cleanup)}}
Object.defineProperty(ctx,'llm',{get(){throw new Error('Benchmark must never access an LLM')}})
const recordEvent=event=>{events.push(event)}
const factory=async path=>{
  if(resolve(path)!==dbPath)throw new Error('Factory database must be the isolated copy')
  client=await createFtsClient(path,{
    onRequestDiagnostic:event=>{const safe=safeRpc(event);rpc.push(safe);recordEvent({kind:'fts-request',...safe})},
    onStartupProgress:event=>startup.push(safeStartup(event)),onStartupFailure:event=>startup.push(safeStartup(event)),
    onRecovered:()=>recordEvent({kind:'fts-recovered'}),
  })
  return client
}
const measure=async(label,condition,args,anchor)=>{
  const since=performance.now(),eventOffset=events.length,rpcOffset=rpc.length
  try {
    const result=await tools[label==='status'?'session_index_status':'session_index_search'].execute(args)
    const item={label,condition,totalMs:performance.now()-since,ok:result.ok!==false,rpc:rpc.slice(rpcOffset),
      events:events.slice(eventOffset).filter(event=>event.kind!=='fts-request').map(event=>({kind:event.kind,...safeRuntime(event)}))}
    if(label==='status') {
      item.backend='fts-health';item.status=safeStatus(result)
      item.checks={ready:result.fts===true&&!result.active,sessionCount:result.ftsSessions===331,
        messageCount:result.ftsHealth?.messages===47092,checkpointCacheClean:result.ftsHealth?.dirtySessions===0,
        channelsReady:result.ftsHealth?.worker?.workerReady===true&&result.ftsHealth?.worker?.readerReady===true}
      item.ok&&=Object.values(item.checks).every(Boolean)
    }
    else {
      item.runtime=safeRuntime(result.runtime)
      item.backend=result.runtime?.backend??'unobserved'
      item.fallbackMs=result.runtime?.fallbackMs
      item.total=result.total;item.totalExact=result.totalExact;item.returned=result.returned
      if(result.mode==='scroll') {
        const messages=result.messages??[]
        item.identityDigest=hash(messages.map(message=>({id:message.id,anchorId:message.anchorId,role:message.role})))
        item.anchorIdentity={sessionIdFingerprint:hash(anchor.sessionId),anchorFingerprint:hash(anchor.anchorId)}
        item.checks={sessionMatches:result.session_id===anchor.sessionId,centerMatches:messages.some(message=>message.anchorId===anchor.anchorId),windowBounded:messages.length<=11}
      } else {
        const hits=result.hits??[]
        item.identityDigest=hash(hits.map(hit=>({sessionId:hit.sessionId,file:hit.file,anchorId:hit.anchorId,kind:hit.kind,type:hit.type})))
        item.identities=hits.map(hit=>({sessionIdFingerprint:hash(hit.sessionId),fileFingerprint:hash(hit.file),anchorFingerprint:hash(hit.anchorId),kind:hit.kind,type:hit.type}))
        item.coverage={complete:result.coverage?.complete,reasons:result.coverage?.reasons??[],sourceLimits:pick(result.coverage?.sourceLimits,['discoveredSessions','scannedSessions','sourceProbedSessions','rawSearchedSessions','failedSessions'])}
        item.checks={filterApplied:hits.every(hit=>hit.kind==='content'&&hit.type==='assistant'),
          identityMatchesMetadata:hits.every(hit=>metadataByFile.get(hit.file)?.id===hit.sessionId),
          stableAnchors:hits.every(hit=>typeof hit.anchorId==='string'&&hit.anchorId.length>0),
          limitRespected:hits.length<=5&&result.returned===hits.length,totalBounded:result.total>=hits.length,
          stableAgainstFirstSearch:firstIdentity===null||item.identityDigest===firstIdentity}
        if(firstIdentity===null)firstIdentity=item.identityDigest
      }
      item.ok&&=item.backend==='fts'&&Object.values(item.checks).every(Boolean)&&(result.mode==='scroll'||item.coverage.complete===true)
    }
    operations.push(item)
    return result
  } catch(error) {
    operations.push({label,condition,totalMs:performance.now()-since,ok:false,errorCode:error.code??'unknown',rpc:rpc.slice(rpcOffset),
      events:events.slice(eventOffset).filter(event=>event.kind!=='fts-request').map(event=>({kind:event.kind,...safeRuntime(event)}))})
    return null
  }
}
try {
  const activationAt=performance.now()
  apply(ctx,{sessionsRoot,dataDir:dirname(dbPath),indexFile:indexPath,maxHits:50,maxSnippetsPerSession:3,
    retentionDays:0,ftsEnabled:true,llmSummaryEnabled:false,deltaEnabled:true},{
    createSessionFts:factory,createSessionWatcher:()=>({ok:true,close(){}}),
    scanSessionFiles:async root=>{if(resolve(root)!==sessionsRoot)throw new Error('Unexpected scan root');report.frozenScanCalls++;return {files:frozenFiles.map(file=>({...file})),complete:true,truncated:false,errors:[],failedSubtrees:[]}},
    onRuntimeDiagnostic:recordEvent,
  })
  if(!tools.session_index_status||!tools.session_index_search)throw new Error('Public tools did not register')
  const readyDeadline=Date.now()+180000
  while(true) {
    const status=await tools.session_index_status.execute({})
    if(!status.active&&status.fts&&status.ftsSessions===331&&status.ftsHealth?.dirtySessions===0&&status.ftsHealth?.dirtySessionsObservedAt>0) {
      report.startupStatus=safeStatus(status);break
    }
    if(Date.now()>=readyDeadline)throw Object.assign(new Error('Public startup did not converge within its bound'),{code:'ETOOLREADY'})
    await new Promise(accept=>setTimeout(accept,40))
  }
  report.readyMs=performance.now()-activationAt
  report.startupRpcCount=rpc.length
  const first=await measure('search','process-cold',{mode:'full',query:'session',filter:{role:'assistant'},limit:5})
  const anchors=(first?.hits??[]).filter(hit=>hit.anchorId&&hit.kind==='content').slice(0,2).map(hit=>({sessionId:hit.sessionId,anchorId:hit.anchorId}))
  for(let n=0;n<2;n++) {
    if(anchors[n])await measure('SCROLL'+(n+1),'process-cold',{session_id:anchors[n].sessionId,anchor_id:anchors[n].anchorId,window:5},anchors[n])
    else operations.push({label:'SCROLL'+(n+1),condition:'process-cold',totalMs:0,backend:'unavailable',ok:false,errorCode:'EBENCHANCHOR'})
  }
  await measure('status','process-cold',{})
  report.coldSequenceMs=operations.filter(item=>item.condition==='process-cold'&&item.label!=='status').reduce((sum,item)=>sum+item.totalMs,0)
  report.startupPlusColdMs=report.readyMs+report.coldSequenceMs
  for(let n=0;n<hotCount;n++) {
    await measure('search','hot',{mode:'full',query:'session',filter:{role:'assistant'},limit:5})
    if(anchors.length) {const anchor=anchors[n%anchors.length];await measure('SCROLL','hot',{session_id:anchor.sessionId,anchor_id:anchor.anchorId,window:5},anchor)}
  }
  const final=await tools.session_index_status.execute({})
  report.finalStatus=safeStatus(final)
  report.beforeIdleWorker=safeWorker(client?.diagnostics())
  const idleStarted=performance.now()
  while(client&&client.diagnostics().pendingRequests>0&&performance.now()-idleStarted<2000)await new Promise(accept=>setTimeout(accept,20))
  report.idleDrainMs=performance.now()-idleStarted
  const state=client?.diagnostics()
  report.afterIdleWorker=safeWorker(state)
  report.runChecks={noRestarts:state?.restarts===0,noTimeouts:state?.requestTimeouts===0&&state?.queueTimeouts===0,
    noTransportFailures:state?.readerTransportFailures===0&&state?.writerTransportFailures===0,
    noPending:state?.pendingRequests===0&&state?.pendingWrites===0&&state?.activeStreams===0&&state?.queueBytes===0,
    noSourceReads:sourceDenials.length===0}
  report.valid=operations.every(item=>item.ok)&&Object.values(report.runChecks).every(Boolean)
} catch(error) {report.errorCode=error.code??'unknown';report.valid=false}
finally {
  for(const cleanup of cleanups.reverse()) {try {await cleanup()}catch(error){report.closeErrorCode=error.code??'unknown'}}
  if(client) {try{await client.close()}catch(error){report.closeErrorCode??=error.code??'unknown'}}
  if(client)report.afterCloseWorker=safeWorker(client.diagnostics())
  SessionIndexBuilder.prototype.build=originalBuild;WorkerPool.prototype.run=originalRun
  report.cpuMicroseconds=process.cpuUsage(cpuStart);report.totalMs=performance.now()-beganAt
  writeFileSync(output,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({round:report.round,valid:report.valid,readyMs:report.readyMs,coldSequenceMs:report.coldSequenceMs,operations:operations.length,failures:operations.filter(item=>!item.ok).length,blockedSourceReads:sourceDenials.length,restarts:report.finalStatus?.worker?.restarts}))
  if(!report.valid||report.closeErrorCode)process.exitCode=1
}
