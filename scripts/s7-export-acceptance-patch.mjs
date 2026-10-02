// Review/replay the S7 E-only helpers and reports against immutable S6 documents.
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const patchRoot = join(root, 'PATCHES', 'S7')
const candidate = join(root, 'release', 'S6-20261002')
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex')
const manifestFile = join(patchRoot, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
if (manifest.phase !== 'complete-with-recorded-runtime-limitations' || manifest.candidateManifestSha256 !== 'a7ebe5aa640c1b37c2be8f122bd5f4968af802838d46231099e835c60a800ffb') throw new Error('S7 completed state required')
const helpers = (await readdir(join(root, 'scripts'))).filter(file => /^(?:s7-.*\.(?:mjs|ps1)|finalize-s7-.*\.mjs)$/.test(file)).map(file => 'scripts/' + file)
const documents = ['DEPLOYMENT_RUNBOOK.txt','HANDOFF_S6_S7.txt','IMPLEMENTATION_STATUS.txt','RELEASE_READINESS.txt']
const additions = ['DEPLOYMENT_RESULTS.txt','LIVE_TEST_RESULTS.txt','DEPLOYMENT_RESULTS/LIVE_TEST_FINAL_SUMMARY.json', ...helpers]
const files = [...documents, ...additions]
const stage = join(patchRoot, 'review-replay-' + randomUUID())
const before = join(stage, 'before'), after = join(stage, 'after')
await mkdir(before, { recursive: true }); await mkdir(after, { recursive: true })
for (const file of documents) await copyFile(join(candidate, file), join(before, file))
for (const file of files) {
  await mkdir(dirname(join(after, file)), { recursive: true })
  await copyFile(join(root, file), join(after, file))
}
let diff
try { diff = execFileSync('git', ['-c','core.autocrlf=false','diff','--no-index','--binary','--src-prefix=a/','--dst-prefix=b/','before','after'], { cwd: stage, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true }) }
catch (error) { if (error.status !== 1 || typeof error.stdout !== 'string') throw error; diff = error.stdout }
const normalized = diff.split('\n').map(line => /^(?:diff --git |--- |\+\+\+ )/.test(line) ? line.replaceAll('a/before/','a/').replaceAll('b/after/','b/') : line).join('\n')
const patchFile = join(patchRoot, 'S7-live-acceptance.patch')
await writeFile(patchFile, normalized, { flag: 'wx' })
const directory = relative(root, before).replaceAll('\\','/')
execFileSync('git', ['-c','core.autocrlf=false','apply','--check','--directory=' + directory, patchFile], { cwd: root, windowsHide: true })
execFileSync('git', ['-c','core.autocrlf=false','apply','--directory=' + directory, patchFile], { cwd: root, windowsHide: true })
for (const file of files) if (await digest(join(before, file)) !== await digest(join(after, file))) throw new Error('Replay hash mismatch: ' + file)
const proofFile = join(patchRoot, 'S7-review-replay.json')
const proof = { generatedAt: new Date().toISOString(), scope: 'E-only S7 helper/document review patch; not a runtime deployment or production-data replay',
  candidateManifestSha256: manifest.candidateManifestSha256, base: 'four immutable S6 candidate documents, remaining S7 helpers/reports added',
  patch: patchFile, patchSha256: await digest(patchFile), files: files.length, gitApplyCheck: true, gitApplyReplay: true,
  replayByteHashesAllMatch: true, replayDirectory: before, noProductionOrRuntimeWrites: true }
await writeFile(proofFile, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' })
await copyFile(manifestFile, join(stage, 'manifest-before-review-patch.json'))
manifest.operationManifest['scripts/s7-export-acceptance-patch.mjs'] = await digest(fileURLToPath(import.meta.url))
manifest.operationManifest['PATCHES/S7/S7-live-acceptance.patch'] = await digest(patchFile)
manifest.operationManifest['PATCHES/S7/S7-review-replay.json'] = await digest(proofFile)
manifest.reviewPatch = proof
await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(proof))
