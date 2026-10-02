/** Independent subprocesses, explicit isolated roots, original audit data shape. */
import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { availableParallelism, cpus, loadavg } from 'node:os'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(repository, 'BENCHMARK_RESULTS', 'fts-worker', process.env.FTS_BENCHMARK_LABEL ?? 'first-run')
const scratch = process.env.FTS_BENCHMARK_RUN_ROOT ?? join(repository, 'validation', `fts-benchmark-${Date.now()}`)
let auditParent = repository
while (!existsSync(join(auditParent, 'audit-20261002', 'runtime', 'src', 'fts.js')) && dirname(auditParent) !== auditParent) auditParent = dirname(auditParent)
const baselinePath = join(auditParent, 'audit-20261002', 'runtime', 'src', 'fts.js')
const rows = Array.from({ length: 2500 }, (_, index) => ({ sessionFile: '/perf', role: 'assistant', toolName: '',
  text: (String(index) + ' 模型调用历史记录以及索引构建和全文搜索性能验证 windows deployment project alpha beta gamma delta ').repeat(16).slice(0, 1000) }))
const meta = { file: '/perf', id: 'perf', workspace: '/perf', title: '', agentPreset: '', createdAt: 1, lastTime: 2 }
const [mode, temperature, runString] = process.argv.slice(2)
function statistics(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const percentile = value => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0
  return { samples: samples.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: sorted.at(-1) ?? 0,
    percentileInterpretation: samples.length < 100 ? 'Descriptive only: too few samples for a stable p99 estimate' : 'Empirical event loop timer-gap quantiles' }
}
async function measure(action) {
  const samples = []
  let last = performance.now()
  let maxRss = process.memoryUsage().rss
  const timer = setInterval(() => { const now = performance.now(); samples.push(now - last); last = now; maxRss = Math.max(maxRss, process.memoryUsage().rss) }, 5)
  await new Promise(accept => setTimeout(accept, 25))
  const began = performance.now()
  try {
    const value = await action()
    const elapsedMs = performance.now() - began
    await new Promise(accept => setTimeout(accept, 25))
    return { value, elapsedMs, gapsMs: statistics(samples), rawTimerGapsMs: samples, maxRss }
  } finally { clearInterval(timer) }
}

if (mode) {
  const directory = join(scratch, `${mode}-${temperature}-${runString}`)
  await mkdir(directory, { recursive: true })
  const cpuBefore = cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 })
  const factory = mode === 'baseline'
    ? (await import((await import('node:url')).pathToFileURL(baselinePath).href)).createSessionFts
    : (await import(new URL('../.test-build/src/fts-client.js', import.meta.url))).createFtsClient
  let client
  let startupMs
  const initialize = async () => {
    const began = performance.now()
    client = await factory(join(directory, 'fts.db'))
    assert.ok(client?.ok)
    await client.upsertSession(meta)
    startupMs = performance.now() - began
  }
  if (temperature === 'steady') { await initialize(); await client.syncMessages('/perf', [rows[0]], false); await client.flush() }
  const measurement = await measure(async () => {
    if (temperature === 'cold') await initialize()
    const began = performance.now()
    await client.syncMessages('/perf', rows, false)
    await client.flush()
    return { writeMs: performance.now() - began }
  })
  const metrics = typeof client.diagnostics === 'function' ? client.diagnostics() : undefined
  const health = await client.health()
  await client.close()
  const cpuAfter = cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 })
  const sourceSha256 = Object.fromEntries(await Promise.all(['fts.ts', 'fts-client.ts', 'fts-worker.ts', 'fts-spool.ts', 'query-plan.ts']
    .filter(file => existsSync(join(repository, 'src', file))).map(async file => [file, createHash('sha256').update(await readFile(join(repository, 'src', file))).digest('hex')])))
  const result = { mode, temperature, run: Number(runString), node: process.version, rows: rows.length, charsPerRow: rows[0].text.length,
    sourceSha256, baselinePath, baselineSha256: createHash('sha256').update(await readFile(baselinePath)).digest('hex'),
    startupMs, ...measurement, metrics, health, load: { availableParallelism: availableParallelism(), cpus: cpus().length, loadavg: loadavg(),
      windowsLoadavgUnsupported: process.platform === 'win32', cpuBusyFraction: 1 - (cpuAfter.idle - cpuBefore.idle) / Math.max(1, cpuAfter.total - cpuBefore.total) },
    environment: { DSH_HOME: process.env.DSH_HOME, dataDir: directory, sessionsRoot: process.env.DSH_SESSION_INDEX_SESSIONS_ROOT },
    memoryNote: 'RSS includes all worker threads; workerMemory.heapUsed and external are thread-local, worker RSS is process-wide.' }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, `${mode}-${temperature}-${runString}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ mode, temperature, run: result.run, startupMs, elapsedMs: measurement.elapsedMs, maxGapMs: measurement.gapsMs.max,
    observations: measurement.gapsMs.samples, maxQueueBytes: metrics?.maxQueueBytes, maxBatchBytes: metrics?.maxBatchBytes, maxInFlightBatches: metrics?.maxInFlightBatches }))
} else {
  await mkdir(output, { recursive: true })
  await mkdir(scratch, { recursive: true })
  for (const name of ['dsh-home', 'temp', 'sessions']) await mkdir(join(scratch, name), { recursive: true })
  const env = { ...process.env, FTS_BENCHMARK_RUN_ROOT: scratch, DSH_HOME: join(scratch, 'dsh-home'), TEMP: join(scratch, 'temp'), TMP: join(scratch, 'temp'),
    DSH_SESSION_INDEX_DATA_DIR: scratch, DSH_SESSION_INDEX_SESSIONS_ROOT: join(scratch, 'sessions') }
  const runs = []
  for (let run = 1; run <= 5; run++) {
    for (const temperature of ['cold', 'steady']) {
      for (const implementation of ['baseline', 'candidate']) {
        const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), implementation, temperature, String(run)], {
          cwd: repository, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 120000 })
        await writeFile(join(output, `${implementation}-${temperature}-${run}.log`), `${child.stdout}${child.stderr}`)
        assert.equal(child.status, 0, `${implementation}/${temperature}/${run}: ${child.stderr}`)
        const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1))
        runs.push(result)
        console.log(JSON.stringify(result))
      }
    }
  }
  const steady = runs.filter(result => result.mode === 'candidate' && result.temperature === 'steady')
  const passed = steady.every(result => result.maxGapMs <= 100 && result.maxGapMs <= 1199 * .2)
  const report = { generatedAt: new Date().toISOString(), historicalBaselineMaxGapMs: 1199, targetMaxGapMs: 100, requiredImprovement: .8,
    runs, steadyAllMeetTarget: passed, note: 'Each sample ran in its own process without simultaneous tests. Original audit runtime is the baseline.' }
  await writeFile(join(output, 'summary.json'), JSON.stringify(report, null, 2))
  assert.ok(passed, 'Every candidate steady run must meet <=100 ms and >=80% improvement versus 1199 ms')
}
