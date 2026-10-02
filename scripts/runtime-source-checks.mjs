import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {readFileSync,writeFileSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
const tag=process.argv[2]??'';assert.match(tag,/^[A-Z0-9_]*$/)
const evidence=resolve('..','evidence'),output=join(evidence,'FINAL_SOURCE_CHECKS'+tag+'.json')
assert.ok(!existsSync(output),'Preserve previous check output')
const report={generatedAt:new Date().toISOString(),node:process.version,runs:[],exitCode:0}
for(const [label,args] of [
  ['source-typecheck',['node_modules/typescript/bin/tsc','-p','tsconfig.json','--noEmit']],
  ['test-typecheck',['node_modules/typescript/bin/tsc','-p','tsconfig.test.json','--noEmit']],
  ['contract',['scripts/check-dsh-contract.mjs']],
  ['work-runtime-build',['node_modules/typescript/bin/tsc','-p','tsconfig.json']],
]){
  const log=join(evidence,'FINAL_'+label+tag+'.txt');assert.ok(!existsSync(log))
  const result=spawnSync(process.execPath,args,{windowsHide:true,encoding:'utf8',timeout:60000})
  writeFileSync(log,(result.stdout??'')+(result.stderr??''))
  report.runs.push({label,args,exitCode:result.status,signal:result.signal,errorCode:result.error?.code??null})
  if(result.status!==0){report.exitCode=result.status??1;break}
}
writeFileSync(output,JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report))
process.exitCode=report.exitCode
