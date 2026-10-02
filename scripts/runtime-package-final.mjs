/** Seal the isolated candidate only after its concrete final acceptance exists. */
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,copyFileSync,mkdirSync,readdirSync,existsSync,realpathSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {dirname,join,resolve,relative,isAbsolute,sep} from 'node:path'
import {fileURLToPath} from 'node:url'

const work=dirname(dirname(fileURLToPath(import.meta.url))),root=dirname(work)
assert.equal(resolve('.'),work)
const candidate=join(root,'release','RUNTIME-20261002')
assert.ok(!existsSync(join(candidate,'SHA256.json'))&&!existsSync(join(candidate,'CANDIDATE.json')),'Never change a sealed candidate')
const json=file=>JSON.parse(readFileSync(file,'utf8'))
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
assert.equal(json(join(root,'FINAL_ACCEPTANCE.json')).ready,true)
const listPath=join(root,'evidence','FINAL_PACKAGING_EVIDENCE_LIST.json'),list=json(listPath)
const paths=new Set()
for(const item of list.evidenceAllowlist){
  assert.equal(item.exists,true,'Required evidence exists')
  assert.equal(sha(join(root,item.path)),item.sha256,'Evidence changed after independent inventory')
  paths.add(item.path)
}
for(const part of ['FINAL_PACKAGING_EVIDENCE_LIST.json','FINAL_QUERY_INTEGRITY_BOUNDARY.json',
  'STARTUP_FIRST_INDEX_ANALYSIS_20261002.json','DEPENDENCY_LOCK_PROVENANCE.json','SOURCE_RESUME_CHECK_20261002.json',
  'PERFORMANCE_HISTORY_SUMMARY_20261002.json','RELEASE_BUILD_BOUNDARY.json','RELEASE_REPRODUCIBLE.json'])paths.add('evidence/'+part)
const collect=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?collect(join(dir,e.name)):[join(dir,e.name)])
const realWork=realpathSync(work)
const copied=[]
function archive(file,part){
  const realPart=relative(realWork,realpathSync(file))
  assert.ok(!realPart.startsWith('..')&&!isAbsolute(realPart),'Archive only isolated work files')
  const target=join(candidate,part)
  mkdirSync(dirname(target),{recursive:true});copyFileSync(file,target)
  copied.push({path:part.replaceAll('\\','/'),sha256:sha(target)})
}
// Include synthetic test fixtures as well as TypeScript; affected builder/pool
// tests reference compressed fixtures outside the compiled test output.
for(const file of collect(join(work,'test')))archive(file,'test/'+relative(join(work,'test'),file))
for(const file of collect(join(work,'scripts')).filter(f=>/runtime-.*\.(mjs|ps1)$/.test(f)))
  archive(file,'validation-scripts/'+relative(join(work,'scripts'),file))
const assemblyFile=join(root,'evidence','PACKAGE_ASSEMBLY_BOUNDARY.json')
assert.ok(!existsSync(assemblyFile),'Preserve assembly evidence')
writeFileSync(assemblyFile,JSON.stringify({generatedAt:new Date().toISOString(),candidate,
  inventory:{path:'evidence/FINAL_PACKAGING_EVIDENCE_LIST.json',sha256:sha(listPath)},
  copied,scope:'Latest workflow scripts archived for review/replay from original isolated work; complete synthetic test fixtures included. No runtime/source changes, production files, private session logs, or node_modules.'},null,2)+'\n')
paths.add('evidence/PACKAGE_ASSEMBLY_BOUNDARY.json')
for(const part of paths){
  const full=resolve(root,part),rel=relative(root,full)
  assert.ok(rel.startsWith('evidence'+sep)&&!rel.startsWith('..')&&!isAbsolute(rel))
  assert.ok(existsSync(full))
}
const result=spawnSync(process.execPath,['scripts/runtime-release.mjs','manifest',...[...paths].sort()],
  {cwd:work,windowsHide:true,encoding:'utf8',timeout:60000})
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'')
assert.equal(result.status,0,'Final manifest assembly')
