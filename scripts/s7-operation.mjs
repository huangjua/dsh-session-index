/** Approved S7 file backup/deployment evidence. Run only after host writers are stopped. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
const implementation = resolve('.')
assert.equal(implementation.toLowerCase(), 'e:\\do something\\dsh备份\\dsh-session-index work\\implementation-session-index'.toLowerCase())
const candidate = join(implementation, 'release', 'S6-20261002')
const runtime = 'G:\\AI-Agent\\deepseek harness\\dsh-session-index'
const data = 'E:\\Do Something\\DSH备份\\session-index-data'
const evidence = join(implementation, 'DEPLOYMENT_RESULTS')
const statePath = join(evidence, 'S7_STATE.json')
const expectedManifest = 'a7ebe5aa640c1b37c2be8f122bd5f4968af802838d46231099e835c60a800ffb'
await mkdir(evidence, { recursive: true })
async function hash(file) {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(file)) digest.update(bytes)
  return digest.digest('hex')
}
async function manifest(root) {
  const files = {}
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name), info = await lstat(file)
      assert.ok(!info.isSymbolicLink(), `Refuse linked persistent input: ${file}`)
      if (info.isDirectory()) await visit(file)
      else if (info.isFile()) files[relative(root, file).split(sep).join('/')] = { bytes: info.size, sha256: await hash(file) }
      else throw new Error(`Unexpected persistent file type: ${file}`)
    }
  }
  await visit(root); return files
}
function git(args) {
  const result = spawnSync('git', args, { cwd: runtime, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim()
}
async function verifyCandidate() {
  assert.equal(await hash(join(candidate, 'SHA256.json')), expectedManifest)
  const list = JSON.parse(await readFile(join(candidate, 'SHA256.json'), 'utf8'))
  for (const [file, expected] of Object.entries(list)) assert.equal(await hash(join(candidate, file)), expected, file)
  return list
}
async function record(state) { await writeFile(statePath, JSON.stringify(state, null, 2) + '\n') }
const phase = process.argv[2]
if (phase === 'backup') {
  await verifyCandidate()
  assert.equal(git(['rev-parse', 'HEAD']), '70800ed7be77b31527a955ea2f6cc6a750dafef8')
  assert.equal(git(['status', '--porcelain']), '')
  const tag = `S7-20261002-${new Date().toISOString().slice(11, 19).replaceAll(':', '')}-${randomUUID().slice(0, 8)}`
  const backup = join(implementation, 'deployment-backups', tag)
  const before = await manifest(data)
  await mkdir(backup, { recursive: true })
  await cp(data, join(backup, 'data-before-switch'), { recursive: true, errorOnExist: true, force: false })
  const copied = await manifest(join(backup, 'data-before-switch'))
  const after = await manifest(data)
  assert.deepEqual(after, before, 'Production changed during backup; keep hosts stopped')
  assert.deepEqual(copied, before, 'Backup differs from stopped source')
  const codeBackup = join(backup, 'runtime-before-switch')
  await mkdir(codeBackup)
  await cp(join(runtime, 'lib'), join(codeBackup, 'lib'), { recursive: true, errorOnExist: true, force: false })
  for (const file of ['package.json', 'README.md', 'README_zh.md']) await cp(join(runtime, file), join(codeBackup, file), { errorOnExist: true, force: false })
  const sourceCodeManifest = { ...(await manifest(join(runtime, 'lib'))) }
  const copiedLibManifest = await manifest(join(codeBackup, 'lib'))
  assert.deepEqual(copiedLibManifest, sourceCodeManifest)
  await cp(join(backup, 'data-before-switch'), join(backup, 'migration-evidence-work'), { recursive: true, errorOnExist: true, force: false })
  assert.deepEqual(await manifest(join(backup, 'migration-evidence-work')), before)
  const state = { tag, candidate, candidateManifestSha256: expectedManifest, runtime, productionData: data, backup,
    authorization: 'User approved option 1 for this exact candidate, E data backup/migration, code deployment, host stop/restart and acceptance; C old index relocation separately approved.',
    codeHead: git(['rev-parse', 'HEAD']), statusBefore: [], phase: 'offline-backups-verified', generatedAt: new Date().toISOString(),
    dataBefore: before, codeBefore: await manifest(codeBackup), migrationEvidence: join(backup, 'migration-evidence-work'),
    productionBookmarkBytes: before['bookmarks.jsonl']?.bytes ?? null, noPush: true }
  await record(state)
  await writeFile(join(backup, 'RESTORE_MANIFEST.json'), JSON.stringify({ tag, data: before, code: state.codeBefore }, null, 2) + '\n')
  console.log(JSON.stringify({ phase: state.phase, backup, dataFiles: Object.keys(before).length, bookmarkBytes: state.productionBookmarkBytes }))
} else if (phase === 'deploy') {
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(state.phase, 'bookmark-migration-verified')
  const list = await verifyCandidate()
  const lib = join(runtime, 'lib'), preserved = join(runtime, `lib.before-${state.tag}`)
  assert.equal((await realpath(lib)).toLowerCase(), resolve(runtime, 'lib').toLowerCase())
  assert.equal(resolve(preserved).toLowerCase().startsWith(resolve(runtime).toLowerCase() + sep), true)
  await rename(lib, preserved)
  await cp(join(candidate, 'lib'), lib, { recursive: true, errorOnExist: true, force: false })
  for (const file of ['package.json', 'README.md', 'README_zh.md']) await cp(join(candidate, file), join(runtime, file))
  for (const [file, expected] of Object.entries(list)) if (file.startsWith('lib/') || ['package.json', 'README.md', 'README_zh.md'].includes(file)) {
    assert.equal(await hash(join(runtime, file)), expected, `Deployed file differs: ${file}`)
  }
  state.preservedRuntimeLib = preserved; state.phase = 'code-deployed-awaiting-host-acceptance'; state.deployedAt = new Date().toISOString()
  state.runtimeVersion = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).version
  await record(state)
  console.log(JSON.stringify({ phase: state.phase, version: state.runtimeVersion, preservedRuntimeLib: preserved }))
} else if (phase === 'migration-verified') {
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  const dry = JSON.parse(await readFile(join(state.backup, 'bookmarks-dry-run.json'), 'utf8'))
  const applied = JSON.parse(await readFile(join(state.backup, 'bookmarks-applied.json'), 'utf8'))
  assert.deepEqual(applied.counts, dry.counts); assert.equal(applied.sourceHash, dry.sourceHash)
  const stateCounts = { records: dry.records, counts: dry.counts, changed: applied.changed }
  state.bookmarkMigration = stateCounts; state.phase = 'bookmark-migration-verified'; await record(state)
  console.log(JSON.stringify({ phase: state.phase, ...stateCounts }))
} else throw new Error('Choose backup, migration-verified or deploy')
