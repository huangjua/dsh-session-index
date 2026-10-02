/** Read-only runtime/source protection evidence; intentionally never reads production data. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const label = process.argv[2] ?? 's6-final'
assert.match(label, /^[a-zA-Z0-9_-]+$/)
const runtime = 'G:\\AI-Agent\\deepseek harness\\dsh-session-index'
const expectedHead = '70800ed7be77b31527a955ea2f6cc6a750dafef8'
const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0); return result.stdout.trim()
}
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const baseline = JSON.parse(readFileSync('TEST_RESULTS/runtime-baseline-hashes.json'))
const sourceBaseline = JSON.parse(readFileSync('TEST_RESULTS/s3-s5-final-source-sha256.json'))
const sourceHashes = Object.fromEntries(readdirSync('src').filter(name => name.endsWith('.ts')).sort().map(name => [`src/${name}`, hash(join('src', name))]))
const runtimeDifferences = baseline.flatMap(row => hash(row.Path).toUpperCase() === row.Hash.toUpperCase() ? [] : [row.Path])
const sourceDifferences = Object.keys(sourceBaseline).filter(file => sourceBaseline[file] !== sourceHashes[file])
const head = git(runtime, ['rev-parse', 'HEAD']), status = git(runtime, ['status', '--porcelain'])
const junction = 'C:\\Users\\admin\\.dsh\\profiles\\desktop\\node_modules\\@dsh-external\\dsh-session-index'
const actualTarget = realpathSync(junction)
const result = { generatedAt: new Date().toISOString(), runtime, checked: baseline.length, runtimeDifferences,
  head, status, junction, actualTarget, sourceFiles: Object.keys(sourceHashes).length, sourceDifferences,
  inheritedPerformanceEvidence: sourceDifferences.length === 0, productionDataRead: false, productionDataWritten: false,
  deploymentPerformed: false, sourceHashes }
writeFileSync(`TEST_RESULTS/${label}-protection.json`, JSON.stringify(result, null, 2) + '\n')
assert.equal(head, expectedHead); assert.equal(status, ''); assert.equal(runtimeDifferences.length, 0)
assert.equal(actualTarget.toLowerCase(), realpathSync(runtime).toLowerCase())
assert.equal(sourceDifferences.length, 0, 'Historical tests/performance must match candidate sources')
console.log(JSON.stringify({ checked: baseline.length, unchanged: true, head, sourceFiles: result.sourceFiles, inheritedPerformanceEvidence: true }))
