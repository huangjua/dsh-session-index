/** Reproducible isolated release build and evidence runner. Never touches a host link or production data. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkout = resolve(fileURLToPath(new URL('../', import.meta.url)))
assert.equal(resolve('.'), checkout, 'Run from the isolated implementation checkout')
const candidate = join(checkout, 'release', 'S6-20261002')
const root = join(checkout, 'validation', 's6-environment')
const env = { ...process.env }
for (const [name, part] of Object.entries({ DSH_HOME: 'dsh-home', TEMP: 'temp', TMP: 'temp',
  DSH_SESSION_INDEX_DATA_DIR: 'data', DSH_SESSION_INDEX_SESSIONS_ROOT: 'sessions' })) {
  env[name] = join(root, part); mkdirSync(env[name], { recursive: true })
}
mkdirSync('TEST_RESULTS', { recursive: true })
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
function run(label, args, extra = {}) {
  assert.ok(!existsSync(`TEST_RESULTS/${label}.txt`), `Preserve previous evidence: ${label}`)
  const result = spawnSync(process.execPath, args, { cwd: checkout, env: { ...env, ...extra },
    windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  writeFileSync(`TEST_RESULTS/${label}.txt`, (result.stdout ?? '') + (result.stderr ?? ''))
  writeFileSync(`TEST_RESULTS/${label}.json`, JSON.stringify({ args, node: process.version, cwd: checkout,
    environment: Object.fromEntries(Object.keys(env).filter(key => ['DSH_HOME', 'TEMP', 'TMP', 'DSH_SESSION_INDEX_DATA_DIR', 'DSH_SESSION_INDEX_SESSIONS_ROOT'].includes(key)).map(key => [key, env[key]])),
    ...extra, exitCode: result.status, error: result.error?.message ?? null }, null, 2) + '\n')
  console.log(`${label}: ${result.status}`)
  if (result.status !== 0) throw new Error(`See TEST_RESULTS/${label}.txt`)
}
const phase = process.argv[2]
const label = process.argv[3] ?? 's6-final'
assert.match(label, /^[a-zA-Z0-9_-]+$/)
if (phase === 'checks') {
  run(`${label}-typecheck`, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--noEmit'])
  run(`${label}-contract`, ['scripts/check-dsh-contract.mjs'])
  run(`${label}-test-compile`, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json'])
} else if (phase === 'compile-tests') {
  run(`${label}-test-compile`, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json'])
} else if (phase === 'build') {
  assert.ok(!existsSync(candidate), 'Use a fresh candidate directory; never overwrite a prior release')
  mkdirSync(candidate, { recursive: true })
  run(`${label}-build`, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json', '--outDir', join(candidate, 'lib'), '--declarationDir', join(candidate, 'lib', 'types')])
  for (const file of ['package.json', 'pnpm-lock.yaml', 'LICENSE', 'README.md', 'README_zh.md']) copyFileSync(file, join(candidate, file))
  // A portable bundle has no user's absolute dataDir. Keep this user's configuration separately for review.
  writeFileSync(join(candidate, 'cordis.patch.yml'), "# Portable default bundle; select your own dataDir in the host profile.\n- insert:\n    - id: dsh-session-index\n      name: '@dsh-external/dsh-session-index'\n")
  mkdirSync(join(candidate, 'deployment'), { recursive: true })
  copyFileSync('cordis.patch.yml', join(candidate, 'deployment', 'cordis.patch.user.yml'))
  for (const worker of ['fts-worker.js', 'session-worker.js']) assert.ok(existsSync(join(candidate, 'lib', worker)), `Missing runtime worker ${worker}`)
  const sourceHashes = Object.fromEntries(readdirSync('src').filter(name => name.endsWith('.ts')).sort().map(name => [`src/${name}`, sha(join('src', name))]))
  writeFileSync(join(candidate, 'SOURCE_SHA256.json'), JSON.stringify(sourceHashes, null, 2) + '\n')
} else if (phase === 'smoke') {
  assert.ok(existsSync(join(candidate, 'lib', 'index.js')))
  run(`${label}-candidate-flow`, ['scripts/run-isolated-tests.mjs', `${label}-candidate-workflow`, 's6-release-flow'], { S6_RELEASE_DIR: candidate })
} else if (phase === 'migration') {
  run(`${label}-migration`, ['scripts/migration-dry-run.mjs', join(candidate, 'lib'), `validation/${label}-MIGRATION_DRY_RUN.json`])
  copyFileSync(`validation/${label}-MIGRATION_DRY_RUN.json`, `TEST_RESULTS/${label}-MIGRATION_DRY_RUN.json`)
  // Preserve historical report and use the candidate build for the new release report.
  if (!existsSync('TEST_RESULTS/MIGRATION_DRY_RUN-S3-S5.json')) copyFileSync('MIGRATION_DRY_RUN.json', 'TEST_RESULTS/MIGRATION_DRY_RUN-S3-S5.json')
  copyFileSync(`validation/${label}-MIGRATION_DRY_RUN.json`, 'MIGRATION_DRY_RUN.json')
} else if (phase === 'cli-tests') {
  run(`${label}-cli-execution`, ['scripts/run-isolated-tests.mjs', 's6-production-migration-cli', 'production-bookmark-migration'], { S6_RELEASE_DIR: candidate })
} else if (phase === 'manifest') {
  const extraFiles = ['RELEASE_READINESS.txt', 'DEPLOYMENT_RUNBOOK.txt', 'MIGRATION_DRY_RUN.json', 'IMPLEMENTATION_STATUS.txt', 'HANDOFF_S6_S7.txt']
  for (const file of extraFiles) { assert.ok(existsSync(file)); copyFileSync(file, join(candidate, file)) }
  for (const name of ['README.md', 'README_zh.md']) copyFileSync(name, join(candidate, name))
  mkdirSync(join(candidate, 'scripts'), { recursive: true })
  copyFileSync('scripts/production-bookmark-migration.mjs', join(candidate, 'scripts', 'production-bookmark-migration.mjs'))
  mkdirSync(join(candidate, 'patches'), { recursive: true })
  for (const name of ['FULL-S0-S6.patch', 'S6-release-preparation.patch']) copyFileSync(join('PATCHES', 'S6', name), join(candidate, 'patches', name))
  copyFileSync('PATCHES/S6/manifest.json', join(candidate, 'patches', 'manifest.json'))
  mkdirSync(join(candidate, 'evidence'), { recursive: true })
  for (const [source, name] of [
    ['TEST_RESULTS/S6_VALIDATION.json', 'S6_VALIDATION.json'],
    ['TEST_RESULTS/s6-final-protection.json', 'runtime-protection.json'],
    ['TEST_RESULTS/s6-patch-verification.json', 'patch-verification.json'],
    ['BENCHMARK_RESULTS/S3-S5_PERFORMANCE.json', 'S3-S5_PERFORMANCE.json'],
    ['BENCHMARK_RESULTS/delta-io/final.json', 'delta-io.json'],
    ['TEST_RESULTS/s6-integration.txt', 'integration.txt'],
    ['TEST_RESULTS/s6-final-candidate-workflow.txt', 'candidate-workflow.txt'],
    ['TEST_RESULTS/s6-production-migration-cli.txt', 'migration-cli.txt'],
    ['TEST_RESULTS/s6-final-test-compile.txt', 'initial-test-compile-error.txt'],
    ['TEST_RESULTS/s6-corrected-test-compile.json', 'corrected-test-compile.json'],
  ]) copyFileSync(source, join(candidate, 'evidence', name))
  // Retain the three historical references linked by both READMEs in a standalone candidate.
  for (const file of ['HANDOFF_S3_S5.txt', 'BENCHMARK_RESULTS/S3-S5_PERFORMANCE.json', 'TEST_RESULTS/S3-S5_VALIDATION.json']) {
    mkdirSync(dirname(join(candidate, file)), { recursive: true }); copyFileSync(file, join(candidate, file))
  }
  function collect(path) {
    return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? collect(join(path, entry.name)) : [join(path, entry.name)])
  }
  const files = collect(candidate).filter(file => !['SHA256.json', 'CANDIDATE.json'].includes(relative(candidate, file))).sort()
  const hashes = Object.fromEntries(files.map(file => [relative(candidate, file).split(sep).join('/'), sha(file)]))
  const hashList = JSON.stringify(hashes, null, 2) + '\n'
  writeFileSync(join(candidate, 'SHA256.json'), hashList)
  const manifest = { candidateId: 'session-index-0.0.3-rc.1-S6-20261002', packageVersion: '0.0.3-rc.1',
    base: '70800ed7be77b31527a955ea2f6cc6a750dafef8', scope: 'isolated candidate, not deployed',
    files: files.length, sha256Manifest: createHash('sha256').update(hashList).digest('hex'),
    testedNode: process.version, testedDSH: '0.2.0-rc.2', ftsSchema: '5', bookmarkFormat: '2',
    userConfiguration: 'deployment/cordis.patch.user.yml is user-specific and must not be published as portable configuration',
    runtimeDependencies: 'fzstd plus package peer dependencies are provided by the existing compatible runtime; node_modules is not bundled',
    excluded: ['production data', 'node_modules', 'test fixture data'], generatedAt: new Date().toISOString() }
  writeFileSync(join(candidate, 'CANDIDATE.json'), JSON.stringify(manifest, null, 2) + '\n')
  for (const [part, hash] of Object.entries(hashes)) { assert.ok(!isAbsolute(part) && !part.startsWith('..')); assert.equal(sha(join(candidate, part)), hash) }
  console.log(JSON.stringify(manifest, null, 2))
} else throw new Error('Choose checks, build, smoke, migration or manifest')
