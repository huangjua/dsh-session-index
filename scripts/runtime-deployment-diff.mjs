/** Reviewable comparison against the preserved approved S6 release, not live G. */
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,statSync,existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {resolve,dirname,join,relative,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'

const work=dirname(dirname(fileURLToPath(import.meta.url))),root=dirname(work)
assert.equal(resolve('.'),work)
const base=join(root,'baseline','S6-20261002'),candidate=join(root,'release','RUNTIME-20261002')
const json=file=>JSON.parse(readFileSync(file,'utf8'))
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const oldManifest=json(join(base,'SHA256.json')),runtime=json(join(candidate,'RUNTIME_SHA256.json'))
const entries=Object.entries(runtime).map(([part,hash])=>{
  assert.ok(part.startsWith('lib/')||['package.json','README.md','README_zh.md'].includes(part))
  const target=resolve(candidate,part),within=relative(candidate,target)
  assert.ok(!within.startsWith('..')&&!isAbsolute(within))
  assert.equal(sha(target),hash)
  const old=join(base,part),oldHash=oldManifest[part]??null
  assert.ok(oldHash,'Known approved baseline runtime file')
  assert.equal(sha(old),oldHash,'Preserved baseline must match its original manifest')
  return {path:part,changed:oldHash!==hash,beforeSha256:oldHash,afterSha256:hash,
    beforeBytes:statSync(old).size,afterBytes:statSync(target).size}
})
const sourceBase=json(join(base,'SOURCE_SHA256.json')),sourceNew=json(join(candidate,'SOURCE_SHA256.json'))
assert.deepEqual(Object.keys(sourceNew).sort(),Object.keys(sourceBase).sort())
const sourceDiff=Object.entries(sourceNew).map(([path,afterSha256])=>({path,changed:sourceBase[path]!==afterSha256,
  beforeSha256:sourceBase[path],afterSha256}))
const report={candidateId:'session-index-0.0.3-rc.2-RUNTIME-20261002',generatedAt:new Date().toISOString(),
  baseline:{path:base,candidateId:json(join(base,'CANDIDATE.json')).candidateId,
    sha256Manifest:sha(join(base,'SHA256.json')),scope:'preserved approved release; current live G not re-read or changed'},
  candidate:{path:candidate,runtimeManifest:sha(join(candidate,'RUNTIME_SHA256.json')),sourceManifest:sha(join(candidate,'SOURCE_SHA256.json'))},
  deploymentFiles:entries.length,changedDeploymentFiles:entries.filter(e=>e.changed).length,
  unchangedDeploymentFiles:entries.filter(e=>!e.changed).length,files:entries,
  sourceFiles:sourceDiff.length,changedSourceFiles:sourceDiff.filter(e=>e.changed).length,sourceDiff,
  operation:'After separate approval, replace complete verified lib and listed metadata; preflight must hash current stopped G runtime and create its own rollback backup.',
  excluded:['src','test','validation-scripts','node_modules','cordis.patch.yml','user configuration','production data'],
  productionDeploymentPerformed:false,productionHostRestartPerformed:false,productionDataChanged:false}
const output=join(root,'DEPLOYMENT_DIFF.json')
assert.ok(!existsSync(output),'Preserve prior deployment comparison')
writeFileSync(output,JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify({deploymentFiles:report.deploymentFiles,changedDeploymentFiles:report.changedDeploymentFiles,
  sourceFiles:report.sourceFiles,changedSourceFiles:report.changedSourceFiles,productionChanged:false}))
