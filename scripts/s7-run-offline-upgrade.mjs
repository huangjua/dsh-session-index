// Invoke the installed Electron binary in Node mode with a verifiable exit code.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
const root = fileURLToPath(new URL('../', import.meta.url))
const result = spawnSync('E:\\Program Files (x86)\\DSH-D\\DeepSeek Harness.exe', [
  fileURLToPath(new URL('./s7-offline-fts-upgrade.mjs', import.meta.url)), '--apply', '--ack-stopped-writers', 'all',
], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, windowsHide: true, encoding: 'utf8', timeout: 600_000 })
const record = { time: new Date().toISOString(), exitCode: result.status, signal: result.signal,
  spawnErrorCode: result.error?.code ?? null, stdout: result.stdout, stderr: result.stderr }
writeFileSync(fileURLToPath(new URL('../DEPLOYMENT_RESULTS/LIVE_TEST_OFFLINE_INVOCATION.json', import.meta.url)), JSON.stringify(record, null, 2) + '\n')
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
process.exitCode = result.status === 0 ? 0 : 1
