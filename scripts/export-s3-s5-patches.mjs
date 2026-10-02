/** Review patches against the preserved S0-S2 handoff, with an isolated replay check. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const repository = resolve('.')
const scratch = resolve('validation', `s3-s5-patch-replay-${Date.now()}`)
const original = JSON.parse(readFileSync('PATCHES/manifest.json', 'utf8'))
const log = []
function git(args, cwd = repository) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  log.push({ args, cwd, exitCode: result.status, output: result.stderr })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout
}
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
mkdirSync('TEST_RESULTS', { recursive: true })
mkdirSync('PATCHES/S3-S5', { recursive: true })
git(['clone', '--no-hardlinks', '--no-checkout', repository, scratch])
git(['checkout', '--detach', original.base], scratch)
git(['apply', resolve('PATCHES/FULL-S0-S2.patch')], scratch)
// Index only belongs to the scratch clone. It preserves the exact prior handoff as our comparison base.
git(['add', '--all'], scratch)
const changed = git(['diff', '--name-only', '-z']).split('\0').filter(Boolean)
const fresh = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
const files = [...new Set([...changed, ...fresh])].filter(file =>
  /^(src\/|test\/|scripts\/)/.test(file) || /^(HANDOFF_S3_S5|IMPLEMENTATION_STATUS|MIGRATION_DRY_RUN|S5_)/.test(file))
  .sort()
for (const file of files) {
  mkdirSync(dirname(join(scratch, file)), { recursive: true })
  copyFileSync(file, join(scratch, file))
}
const before = git(['ls-files', '-z'], scratch).split('\0').filter(Boolean)
const actualChanged = git(['diff', '--name-only', '-z'], scratch).split('\0').filter(Boolean)
const actualNew = files.filter(file => !before.includes(file))
const additions = actualNew.map(file => {
  const content = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return [file, `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n` +
    lines.map(line => `+${line}\n`).join('') + (content.endsWith('\n') ? '' : '\\ No newline at end of file\n')]
})
function group(file) {
  if (/^(src\/(bookmark|message-anchor)\.ts|test\/bookmark|scripts\/migration-dry-run)/.test(file)) return 'S3-anchors-and-bookmark-migration'
  if (/^(src\/query-plan\.ts|test\/(session-message-contract|fts-message-contract|rank-integration))/.test(file)) return 'S4-query-and-coverage-contract'
  if (/^(src\/(fts-client|fts-worker|fts-spool|native-zstd)\.ts|test\/(fts-client|fts-transport|fts-spool|native-zstd)|scripts\/benchmark)/.test(file)) return 'S5-background-storage-and-tail-io'
  return 'S3-S5-shared-integration'
}
const touched = [...actualChanged, ...actualNew].sort()
const names = [...new Set(touched.map(group))].sort()
const patches = []
for (const name of names) {
  const owned = touched.filter(file => group(file) === name)
  const modified = owned.filter(file => actualChanged.includes(file))
  const text = (modified.length ? git(['diff', '--binary', '--no-ext-diff', '--', ...modified], scratch) : '') +
    additions.filter(([file]) => owned.includes(file)).map(([, patch]) => patch).join('')
  const path = `PATCHES/S3-S5/${name}.patch`
  writeFileSync(path, text)
  patches.push({ name, path, sha256: hash(path), files: owned })
}
// Replay all additive groups from the S0-S2 index and compare normalized file contents.
// New files already in scratch would prevent replay: verify through a second fresh clone instead of deleting them.
const replay = `${scratch}-verify`
git(['clone', '--no-hardlinks', '--no-checkout', repository, replay])
git(['checkout', '--detach', original.base], replay)
git(['apply', resolve('PATCHES/FULL-S0-S2.patch')], replay)
for (const { path } of patches) {
  git(['apply', '--check', resolve(path)], replay)
  git(['apply', resolve(path)], replay)
}
for (const file of touched) {
  if (!existsSync(join(replay, file)) || readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !==
      readFileSync(join(replay, file), 'utf8').replace(/\r\n/g, '\n')) throw new Error(`Replay differs: ${file}`)
}
const manifest = { base: original.base, previousHandoff: 'PATCHES/FULL-S0-S2.patch', previousHandoffSha256: hash('PATCHES/FULL-S0-S2.patch'),
  note: 'Additive file ownership groups. Apply ALL four after the preserved S0-S2 patch; shared parser/SQL/app wiring crosses S3-S5. Individual groups are review units, not independently runnable releases.',
  patches, verifiedFiles: touched.length, replayDirectory: replay }
writeFileSync('PATCHES/S3-S5/manifest.json', JSON.stringify(manifest, null, 2) + '\n')
writeFileSync('TEST_RESULTS/s3-s5-patch-verification.json', JSON.stringify({ ...manifest, log }, null, 2) + '\n')
console.log(JSON.stringify({ groups: names, verifiedFiles: touched.length, replayDirectory: replay }))
