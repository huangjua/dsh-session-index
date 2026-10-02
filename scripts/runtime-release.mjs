/** Assemble an independently reproducible candidate; never build/deploy on G. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, existsSync, realpathSync, symlinkSync, rmdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const work = dirname(dirname(fileURLToPath(import.meta.url))), root = dirname(work)
assert.equal(resolve('.'), work, 'Run from isolated work')
const candidate = join(root, 'release', 'RUNTIME-20261002')
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const collect = dir => readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? collect(join(dir,e.name)) : [join(dir,e.name)])
const manifest = dir => Object.fromEntries(collect(dir).sort().map(file => [relative(dir,file).split(sep).join('/'), sha(file)]))
function copy(source, target) { mkdirSync(dirname(target),{recursive:true}); copyFileSync(source,target) }
function compile(label,args) {
  const file = join(root,'evidence',label+'.txt')
  assert.ok(!existsSync(file),'Preserve earlier evidence')
  assert.ok(!existsSync(join(root,'evidence',label+'.json')),'Preserve earlier compiler metadata')
  const r=spawnSync(process.execPath,['node_modules/typescript/bin/tsc',...args],{cwd:work,windowsHide:true,encoding:'utf8',timeout:60000})
  writeFileSync(file,(r.stdout??'')+(r.stderr??''))
  writeJson(join(root,'evidence',label+'.json'),{args,node:process.version,exitCode:r.status,signal:r.signal,errorCode:r.error?.code??null})
  assert.equal(r.status,0,label)
}

const mode = process.argv[2]
const tag=mode==='manifest'?'':process.argv[3]??''
assert.match(tag,/^[A-Z0-9_]*$/)
if (mode==='build') {
  assert.ok(!existsSync(candidate),'Use a new candidate; never overwrite release')
  mkdirSync(candidate,{recursive:true})
  for(const part of ['package.json','pnpm-lock.yaml','LICENSE','README.md','README_zh.md','tsconfig.json','tsconfig.test.json']) copy(join(work,part),join(candidate,part))
  for(const file of collect(join(work,'src'))) copy(file,join(candidate,'src',relative(join(work,'src'),file)))
  for(const file of collect(join(work,'test')).filter(f=>f.endsWith('.ts'))) copy(file,join(candidate,'test',relative(join(work,'test'),file)))
  for(const file of collect(join(work,'scripts')).filter(f=>/\/(build\.sh|check-dsh-contract\.mjs)$/.test(f.replaceAll('\\','/')))) copy(file,join(candidate,'scripts',relative(join(work,'scripts'),file)))
  for(const file of collect(join(work,'scripts')).filter(f=>/runtime-.*\.(mjs|ps1)$/.test(f)&&!/(runtime-release|runtime-finalize)\.mjs$/.test(f))) copy(file,join(candidate,'validation-scripts',relative(join(work,'scripts'),file)))
  writeFileSync(join(candidate,'validation-scripts','REPLAY.txt'),'These scripts are archived for review. Replay from the original isolated runtime-fix-20261002/work directory; their companion verified datasets are intentionally not bundled. They are not deployment commands. Rebuild source independently with the included tsconfig and locked dependencies; release evidence records a byte-for-byte independent rebuild.\n')
  writeFileSync(join(candidate,'cordis.patch.yml'),"# Portable default bundle; preserve the existing user configuration.\n- insert:\n    - id: dsh-session-index\n      name: '@dsh-external/dsh-session-index'\n")
  // Compile copied source with this workspace's locked dependencies. All relative
  // source-map targets then resolve inside the standalone candidate.
  const config=json(join(work,'tsconfig.json'))
  config.compilerOptions={...config.compilerOptions,baseUrl:work,typeRoots:[join(work,'node_modules','@types')],
    rootDir:join(candidate,'src'),outDir:join(candidate,'lib'),declarationDir:join(candidate,'lib','types')}
  config.include=[join(candidate,'src')]
  const configPath=join(root,'evidence','RELEASE_BUILD_CONFIG'+tag+'.json');assert.ok(!existsSync(configPath));writeJson(configPath,config)
  const dependencyLink=join(candidate,'node_modules')
  assert.ok(!existsSync(dependencyLink))
  symlinkSync(join(work,'node_modules'),dependencyLink,'junction')
  try {compile('RELEASE_BUILD'+tag,['-p',configPath])}
  finally {rmdirSync(dependencyLink)} // remove only our temporary junction, never its target
  const src=Object.fromEntries(collect(join(candidate,'src')).sort().map(file=>['src/'+relative(join(candidate,'src'),file).split(sep).join('/'),sha(file)]))
  assert.equal(Object.keys(src).length,22)
  writeJson(join(candidate,'SOURCE_SHA256.json'),src)
  writeJson(join(candidate,'RUNTIME_SHA256.json'),Object.fromEntries(Object.entries(manifest(candidate)).filter(([file])=>file.startsWith('lib/')||['package.json','README.md','README_zh.md'].includes(file))))
  writeJson(join(root,'evidence','RELEASE_BUILD_BOUNDARY.json'),{candidate,configPath,node:process.version,sourceFiles:22,sourceDigest:sha(join(candidate,'SOURCE_SHA256.json')),
    runtimeDigest:sha(join(candidate,'RUNTIME_SHA256.json')),scope:'copied verified source; locked work dependencies; no G build; portable template excluded from deployment',generatedAt:new Date().toISOString()})
  console.log(JSON.stringify({candidate,sourceFiles:22,runtimeFiles:Object.keys(json(join(candidate,'RUNTIME_SHA256.json'))).length}))
} else if (mode==='verify-build') {
  // Recompile the same copied source into a separate sibling lib, then compare
  // every JS/declaration/map with the actual candidate. No duplicate tests.
  const verification=join(root,'release','REPRODUCE-RUNTIME-20261002')
  assert.ok(!existsSync(verification),'Preserve earlier verification')
  mkdirSync(verification,{recursive:true})
  copy(join(candidate,'package.json'),join(verification,'package.json'))
  for(const file of collect(join(candidate,'src'))) copy(file,join(verification,'src',relative(join(candidate,'src'),file)))
  const config=json(json(join(root,'evidence','RELEASE_BUILD_BOUNDARY.json')).configPath)
  config.compilerOptions.rootDir=join(verification,'src');config.compilerOptions.outDir=join(verification,'lib');config.compilerOptions.declarationDir=join(verification,'lib','types')
  config.include=[join(verification,'src')]
  const configPath=join(root,'evidence','RELEASE_REPRODUCE_CONFIG'+tag+'.json');assert.ok(!existsSync(configPath));writeJson(configPath,config)
  const dependencyLink=join(verification,'node_modules')
  symlinkSync(join(work,'node_modules'),dependencyLink,'junction')
  try {compile('RELEASE_REPRODUCE'+tag,['-p',configPath])}
  finally {rmdirSync(dependencyLink)}
  const expected=manifest(join(candidate,'lib')),actual=manifest(join(verification,'lib'))
  assert.deepEqual(actual,expected,'Compiled candidate must reproduce byte for byte')
  assert.deepEqual(manifest(join(work,'lib')),expected,'Candidate must equal the runtime used by actual installed-runtime benchmarks')
  for(const name of ['package.json','README.md','README_zh.md'])assert.equal(sha(join(candidate,name)),sha(join(work,name)),'Latest metadata must match the build snapshot')
  for(const [part,hash] of Object.entries(json(join(candidate,'SOURCE_SHA256.json')))) {
    assert.equal(sha(join(candidate,part)),hash)
    assert.equal(sha(join(work,part)),hash,'Live source changed after copied source was built')
  }
  const original=join(root,'..','implementation-session-index')
  for(const [part,hash] of Object.entries(json(join(root,'baseline','S6-20261002','SOURCE_SHA256.json')))) {
    assert.equal(sha(join(original,part)),hash,'Original uncommitted implementation must remain preserved')
  }
  writeJson(join(root,'evidence','RELEASE_REPRODUCIBLE.json'),{ok:true,files:Object.keys(expected).length,sourceFiles:22,compiledSourceMatchesWork:true,generatedAt:new Date().toISOString()})
  console.log(JSON.stringify({reproducible:true,files:Object.keys(expected).length}))
} else if (mode==='manifest') {
  assert.equal(json(join(root,'evidence','RELEASE_REPRODUCIBLE.json')).ok,true)
  assert.equal(json(join(root,'FINAL_ACCEPTANCE.json')).ready,true)
  for(const file of ['RUNTIME_FIX_REPORT.txt','QUERY_LATENCY.json','STARTUP_MIGRATION.json','DELTA_FALLBACK.json','DEPLOYMENT_AND_ROLLBACK.txt','DEPLOYMENT_DIFF.json','FINAL_ACCEPTANCE.json']) copy(join(root,file),join(candidate,file))
  const evidence=process.argv.slice(3)
  assert.ok(evidence.length>0,'Explicit evidence allowlist required')
  for(const file of evidence) {
    const source=resolve(root,file),part=relative(root,source)
    assert.ok(!part.startsWith('..')&&part.startsWith('evidence'+sep),'Only isolated evidence')
    const actual=relative(realpathSync(root),realpathSync(source))
    assert.ok(!actual.startsWith('..')&&!actual.startsWith(sep),'Evidence must not follow an external link')
    copy(source,join(candidate,part))
  }
  const deployment=json(join(candidate,'RUNTIME_SHA256.json'))
  for(const [part,hash] of Object.entries(deployment)) assert.equal(sha(join(candidate,part)),hash)
  const hashes=Object.fromEntries(Object.entries(manifest(candidate)).filter(([part])=>!['SHA256.json','CANDIDATE.json'].includes(part)))
  writeJson(join(candidate,'SHA256.json'),hashes)
  const meta={candidateId:'session-index-0.0.3-rc.2-RUNTIME-20261002',packageVersion:'0.0.3-rc.2',ftsSchema:'5',bookmarkFormat:'2',
    scope:'isolated validated candidate; production deployment pending separate authorization',
    base:'verified S6 SOURCE 22/22 plus uncommitted implementation; never checkout HEAD70800ed as replacement',
    files:Object.keys(hashes).length,deploymentFiles:Object.keys(deployment).length,sha256Manifest:sha(join(candidate,'SHA256.json')),
    sourceManifest:sha(join(candidate,'SOURCE_SHA256.json')),runtimeManifest:sha(join(candidate,'RUNTIME_SHA256.json')),
    compiledNode:process.version,testedRuntime:{electron:'44.0.0',node:'24.18.1',sqlite:'3.53.1'},testedDSH:'0.2.0-rc.2',
    runtimeDependencies:'existing compatible locked fzstd and host peers; node_modules not bundled',
    userConfiguration:'preserve production config; portable cordis.patch.yml excluded from RUNTIME_SHA256 deployment allowlist',
    excluded:['production data','source session logs','node_modules','credentials'],generatedAt:new Date().toISOString()}
  writeJson(join(candidate,'CANDIDATE.json'),meta)
  for(const [part,hash] of Object.entries(hashes)) assert.equal(sha(join(candidate,part)),hash)
  writeJson(join(root,'CANDIDATE_READY.json'),{...meta,candidatePath:candidate,candidateMetadataSha256:sha(join(candidate,'CANDIDATE.json')),verified:true,
    productionDeploymentPerformed:false,productionHostRestartPerformed:false,productionDataChanged:false})
  console.log(JSON.stringify(meta))
} else throw new Error('Choose build, verify-build or manifest')
