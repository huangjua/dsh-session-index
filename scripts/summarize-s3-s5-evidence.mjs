/** Aggregate retained final evidence; no test, runtime or production mutation. */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const sourceSha256 = Object.fromEntries(readdirSync('src').filter(file => file.endsWith('.ts')).sort().map(file => [`src/${file}`, hash(join('src', file))]))
const labels = ['s3-s5-final-app-closed', 's5-final-worker-contract', 's5-delta-metrics-and-large-line', 's3-s5-final-anchor-store', 's5-final-50k-stress']
const tests = labels.map(label => {
  const execution = json(`TEST_RESULTS/${label}.json`)
  const log = readFileSync(`TEST_RESULTS/${label}.txt`, 'utf8')
  const count = key => Number([...log.matchAll(new RegExp(`ℹ ${key} (\\d+)`, 'g'))].at(-1)?.[1])
  assert.equal(execution.exitCode, 0, label)
  assert.equal(count('fail'), 0, label)
  assert.equal(count('pass'), count('tests'), label)
  assert.equal(count('skipped'), 0, label)
  return { label, tests: count('tests'), pass: count('pass'), fail: count('fail'), execution, log: `TEST_RESULTS/${label}.txt` }
})
const label = 'S5-final-20261002'
const directory = `BENCHMARK_RESULTS/fts-worker/${label}`
const summary = json(`${directory}/summary.json`)
assert.equal(summary.steadyAllMeetTarget, true)
const benchmark = summary.runs.map(run => json(`${directory}/${run.mode}-${run.temperature}-${run.run}.json`))
for (const run of benchmark.filter(run => run.mode === 'candidate')) {
  for (const [file, value] of Object.entries(run.sourceSha256)) assert.equal(sourceSha256[`src/${file}`], value, `Benchmark source drift: ${file}`)
}
const steady = benchmark.filter(run => run.mode === 'candidate' && run.temperature === 'steady')
assert.equal(steady.length, 5)
const maxSteadyGapMs = Math.max(...steady.map(run => run.gapsMs.max))
const scenarios = json(`${directory}/scenarios.json`)
assert.ok(scenarios.phases.every(phase => phase.maxTimerGapMs <= 100))
const stress = json(`${directory}/stress-50k.json`)
assert.equal(stress.metrics.restarts, 0)
assert.ok(stress.phases.every(phase => phase.queryMaxMs < stress.queryTimeoutMs))
const delta = json('BENCHMARK_RESULTS/delta-io/final.json')
assert.equal(delta.results.length, 3)
for (const result of delta.results) {
  assert.equal(result.rounds.length, 5)
  assert.ok(result.rounds.every(round => round.candidate.readBytes === 32 && round.candidate.allocatedBytes === 32))
}
const migration = json('MIGRATION_DRY_RUN.json')
assert.equal(migration.status, 'passed')
assert.equal(migration.checks.length, 13)
const migrationCounts = migration.checks.find(check => check.name === 'bookmark-all-resolution-statuses-are-real-database-lookups').counts
assert.equal(Object.values(migrationCounts).reduce((sum, count) => sum + count, 0), 10)
const report = { generatedAt: new Date().toISOString(), scope: 'S3-S5 only; synthetic fixtures, no deployment or production migration',
  finalTests: { total: tests.reduce((sum, batch) => sum + batch.tests, 0), batches: tests },
  migration: { checks: migration.checks.length, report: 'MIGRATION_DRY_RUN.json', counts: migrationCounts },
  performance: { directory, steadyRuns: steady.map(run => ({ run: run.run, elapsedMs: run.elapsedMs, gapsMs: run.gapsMs, maxRss: run.maxRss, load: run.load })),
    maxSteadyGapMs, improvementAgainst1199: 1 - maxSteadyGapMs / 1199, targetMaxGapMs: 100,
    baselineSteadyRuns: benchmark.filter(run => run.mode === 'baseline' && run.temperature === 'steady').map(run => ({ run: run.run, elapsedMs: run.elapsedMs, gapsMs: run.gapsMs })),
    scenarios: scenarios.phases.map(({ name, elapsedMs, maxTimerGapMs, samples }) => ({ name, elapsedMs, maxTimerGapMs, samples })),
    stress: { rows: stress.rows, phases: stress.phases.map(({ name, elapsedMs, querySamples, queryMaxMs, observedMessageCounts }) => ({ name, elapsedMs, querySamples, queryMaxMs, observedMessageCounts })),
      maxQueueBytes: stress.metrics.maxQueueBytes, maxBatchBytes: stress.metrics.maxBatchBytes, maxInFlightBatches: stress.metrics.maxInFlightBatches,
      maxActiveSourceBytes: stress.metrics.maxActiveSourceBytes, maxActiveBodyBytes: stress.metrics.maxActiveBodyBytes, endRss: stress.metrics.hostMemory.rss },
    delta: delta.results.map(result => ({ prefixMiB: result.prefixMiB, tailBytes: result.tailBytes, rounds: result.rounds.length, readBytes: 32, compressedInputAllocationBytes: 32 })),
    limits: ['Timer gaps are heartbeat intervals, not query latency. Baseline samples are too few for meaningful p99.',
      'The new complete-text/chunk schema increases total write time in this benchmark; responsiveness improved, not total indexing speed.',
      '8 MiB covers transport/queued producers, not all process RSS. Active sources are separately capped and measured.',
      'RSS is shared across worker threads; worker heap/external values are thread-local. Stress end RSS is not a measured peak.'] },
  sourceSha256, priorFailures: [
    { log: 'TEST_RESULTS/s3-s5-resume-core.txt', reason: '4 stale contract assertions (bookmark v1, old FTS maintenance table, numeric anchors); corrected and covered by final batches.' },
    { log: 'TEST_RESULTS/s3-s5-updated-contract.txt', reason: 'Async worker readiness/schema expectations and disposal race; fixed without increasing test timeouts.' },
    { log: 'TEST_RESULTS/s3-s5-final-app.txt', reason: 'Missing SCROLL description and teardown completing before late factory connection closed; final app batch passes after awaiting initialization and close.' } ] }
mkdirSync('BENCHMARK_RESULTS', { recursive: true })
writeFileSync('TEST_RESULTS/s3-s5-final-source-sha256.json', JSON.stringify(sourceSha256, null, 2) + '\n')
writeFileSync('TEST_RESULTS/S3-S5_VALIDATION.json', JSON.stringify(report, null, 2) + '\n')
writeFileSync('BENCHMARK_RESULTS/S3-S5_PERFORMANCE.json', JSON.stringify(report.performance, null, 2) + '\n')
console.log(JSON.stringify({ finalTests: report.finalTests.total, migrationChecks: 13, maxSteadyGapMs,
  improvementPercent: report.performance.improvementAgainst1199 * 100, stress: report.performance.stress, delta: report.performance.delta }))
