/** Preserve prior patches, export S6 increment and complete review patch, replay both in fresh clones. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
const checkout = resolve('.')
const stamp = Date.now()
const scratch = resolve('validation', `s6-export-${stamp}`)
const base = '70800ed7be77b31527a955ea2f6cc6a750dafef8'
const out = resolve('PATCHES', 'S6')
mkdirSync(out, { recursive: true })
const log = []
function git(args, cwd = checkout) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  log.push({ args, cwd, exitCode: result.status, error: result.stderr })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout
}
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const old = JSON.parse(readFileSync('PATCHES/S3-S5/manifest.json'))
assert.equal(hash('PATCHES/FULL-S0-S2.patch'), old.previousHandoffSha256)
for (const patch of old.patches) assert.equal(hash(patch.path), patch.sha256)
function clone(path, previous) {
  git(['clone', '--no-hardlinks', '--no-checkout', checkout, path])
  git(['checkout', '--detach', base], path)
  if (previous) {
    git(['apply', resolve('PATCHES/FULL-S0-S2.patch')], path)
    for (const patch of old.patches) git(['apply', resolve(patch.path)], path)
  }
}
clone(scratch, true)
git(['add', '--all'], scratch)
const previousTree = git(['write-tree'], scratch).trim()
const changed = git(['diff', '--name-only', '-z']).split('\0').filter(Boolean)
const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
const files = [...new Set([...changed, ...untracked])].filter(file =>
  /^(src\/|test\/|scripts\/)/.test(file) || /^(README(?:_zh)?\.md|package\.json|\.gitignore|IMPLEMENTATION_STATUS.*\.txt|HANDOFF_.*\.txt|RELEASE_READINESS\.txt|DEPLOYMENT_RUNBOOK\.txt|MIGRATION_DRY_RUN\.json|S5_.*\.txt)$/.test(file)).sort()
for (const file of files) {
  mkdirSync(dirname(join(scratch, file)), { recursive: true }); copyFileSync(file, join(scratch, file))
}
git(['add', '--all'], scratch)
const increment = git(['diff', '--cached', '--binary', '--no-ext-diff', previousTree], scratch)
const full = git(['diff', '--cached', '--binary', '--no-ext-diff', base], scratch)
writeFileSync(join(out, 'S6-release-preparation.patch'), increment)
writeFileSync(join(out, 'FULL-S0-S6.patch'), full)
const incrementFiles = git(['diff', '--cached', '--name-only', previousTree], scratch).trim().split('\n')
const normalized = file => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
for (const [name, previous, patch] of [['increment', true, 'S6-release-preparation.patch'], ['full', false, 'FULL-S0-S6.patch']]) {
  const replay = `${scratch}-${name}`
  clone(replay, previous)
  git(['apply', '--check', join(out, patch)], replay); git(['apply', join(out, patch)], replay)
  for (const file of files) assert.equal(normalized(join(replay, file)), normalized(file), `Replay differs: ${file}`)
}
const manifest = { base, generatedAt: new Date().toISOString(), preservedPriorManifest: hash('PATCHES/S3-S5/manifest.json'),
  increment: { path: 'PATCHES/S6/S6-release-preparation.patch', sha256: hash(join(out, 'S6-release-preparation.patch')), files: incrementFiles },
  full: { path: 'PATCHES/S6/FULL-S0-S6.patch', sha256: hash(join(out, 'FULL-S0-S6.patch')), verifiedFiles: files.length },
  scratch, rootIndexModified: false, note: 'Full is standalone against base; increment follows ALL preserved S0-S2 and S3-S5 patches. No push or runtime deployment.' }
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
writeFileSync('TEST_RESULTS/s6-patch-verification.json', JSON.stringify({ ...manifest, log }, null, 2) + '\n')
console.log(JSON.stringify(manifest, null, 2))
