import {writeFileSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
import {performance} from 'node:perf_hooks'
import {createHash} from 'node:crypto'
const [moduleFile,dbPath,output,round,hotCount='30']=process.argv.slice(2)
const diagnostics=[],progress=[]
const report={round:Number(round),runtime:{node:process.version,electron:process.versions.electron,sqlite:process.versions.sqlite,platform:process.platform},coldCondition:'independent process/new SQLite connections; OS disk cache is uncontrolled and may be warm',cache:'unknown OS cache; no machine cache clearing',operations:[],diagnostics,progress}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const cpuStart=process.cpuUsage(),start=performance.now()
const {createFtsClient}=await import(pathToFileURL(moduleFile).href)
const readyStart=performance.now()
const client=await createFtsClient(dbPath,{onRequestDiagnostic:e=>diagnostics.push(e),onStartupProgress:e=>progress.push(e),onStartupFailure:e=>progress.push(e)})
report.readyMs=performance.now()-readyStart
if(!client) {report.error='factory-returned-null';writeFileSync(output,JSON.stringify(report,null,2));process.exitCode=1}
else {
  const measure=async(label,condition,operation,expectedAnchor)=>{
    const since=performance.now(),index=diagnostics.length
    try{
      const result=await operation()
      const hits=Array.isArray(result.hits)?result.hits:Array.isArray(result.messages)?result.messages:[]
      const correctness={identityPresent:label==='search'?hits.every(h=>h.sessionId&&h.anchorId):true,roleFilter:label==='search'?hits.every(h=>h.role==='assistant'):true,requestedAnchorPresent:expectedAnchor?hits.some(h=>h.anchorId===expectedAnchor):!label.startsWith('SCROLL')}
      report.operations.push({label,condition,backend:'fts',fallbackMs:0,totalMs:performance.now()-since,returned:hits.length,total:result.total,totalExact:result.totalExact,ok:(result.ok??true)&&Object.values(correctness).every(Boolean),correctness,identityDigest:hash(hits.map(h=>({sessionId:h.sessionId,anchorId:h.anchorId,id:h.id,role:h.role}))),contentDigest:hash(hits),rpc:diagnostics.slice(index)})
      return result
    }catch(e){report.operations.push({label,condition,backend:'fts',fallbackMs:0,totalMs:performance.now()-since,ok:false,errorCode:e.code??'unknown',rpc:diagnostics.slice(index)});return null}
  }
  const first=await measure('search','process-cold',()=>client.searchPage('session','',5,{role:'assistant',queryMode:'and'}))
  const anchors=(first?.hits??[]).filter(h=>h.anchorId).slice(0,2)
  for(let n=0;n<2;n++) await measure('SCROLL'+(n+1),'process-cold',()=>anchors[n]?client.around(anchors[n].sessionId,anchors[n].anchorId,5):Promise.resolve({ok:false,messages:[]}),anchors[n]?.anchorId)
  await measure('health','process-cold',()=>client.health())
  report.coldSequenceMs=report.operations.slice(0,3).reduce((s,o)=>s+o.totalMs,0)
  for(let n=0;n<Number(hotCount);n++) {
    await measure('search','hot',()=>client.searchPage('session','',5,{role:'assistant',queryMode:'and'}))
    if(anchors.length) await measure('SCROLL','hot',()=>client.around(anchors[n%anchors.length].sessionId,anchors[n%anchors.length].anchorId,5),anchors[n%anchors.length].anchorId)
  }
  report.health=await client.health().catch(e=>({errorCode:e.code}))
  report.worker=client.diagnostics()
  await client.close().catch(e=>{report.closeError=e.code??'unknown'})
  report.cpuMicroseconds=process.cpuUsage(cpuStart)
  report.totalMs=performance.now()-start
  writeFileSync(output,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({round:report.round,readyMs:report.readyMs,coldSequenceMs:report.coldSequenceMs,operations:report.operations.length,failures:report.operations.filter(o=>!o.ok).length,restarts:report.worker.restarts}))
}
