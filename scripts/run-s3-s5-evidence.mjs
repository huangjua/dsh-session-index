/** Synthetic migration / tail I/O evidence with explicit isolation and retained raw output. */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const phase = process.argv[2]
if (!['migration', 'delta'].includes(phase)) throw new Error('Choose migration or delta')
const root = resolve('validation', `s3-s5-${phase}-environment`)
for (const name of ['dsh-home', 'temp', 'data', 'sessions']) mkdirSync(join(root, name), { recursive: true })
const env = { ...process.env, DSH_HOME: join(root, 'dsh-home'), TEMP: join(root, 'temp'), TMP: join(root, 'temp'),
  DSH_SESSION_INDEX_DATA_DIR: join(root, 'data'), DSH_SESSION_INDEX_SESSIONS_ROOT: join(root, 'sessions') }
mkdirSync('TEST_RESULTS', { recursive: true })
const label = `s3-s5-final-${phase}`
const log = `TEST_RESULTS/${label}.txt`
writeFileSync(log, '')
const args = [`scripts/${phase === 'migration' ? 'migration-dry-run' : 'benchmark-delta-io'}.mjs`]
const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => appendFileSync(log, data))
const exitCode = await new Promise((accept, reject) => { child.on('error', reject); child.on('close', accept) })
writeFileSync(`TEST_RESULTS/${label}.json`, JSON.stringify({ args, node: process.version, environment: {
  DSH_HOME: env.DSH_HOME, TEMP: env.TEMP, TMP: env.TMP, dataDir: env.DSH_SESSION_INDEX_DATA_DIR,
  sessionsRoot: env.DSH_SESSION_INDEX_SESSIONS_ROOT }, exitCode }, null, 2) + '\n')
if (exitCode === 0) {
  if (phase === 'migration') copyFileSync('validation/MIGRATION_DRY_RUN.json', 'MIGRATION_DRY_RUN.json')
  else {
    mkdirSync('BENCHMARK_RESULTS/delta-io', { recursive: true })
    copyFileSync('validation/BENCHMARK_RESULTS/delta-io.json', 'BENCHMARK_RESULTS/delta-io/final.json')
  }
}
console.log(JSON.stringify({ phase, exitCode, log }))
process.exitCode = exitCode ?? 1
