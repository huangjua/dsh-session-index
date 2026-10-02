/** One-time approved schema migration. Prepared only; root runs after stopping every shared writer. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const implementation = 'E:\\Do Something\\DSH备份\\dsh-session-index work\\implementation-session-index'
const candidate = join(implementation, 'release', 'S6-20261002')
const runtime = 'G:\\AI-Agent\\deepseek harness\\dsh-session-index'
const productionData = 'E:\\Do Something\\DSH备份\\session-index-data'
const originalBackup = join(implementation, 'deployment-backups', 'S7-20261002-090316-e1190a1f')
const expectedManifest = 'a7ebe5aa640c1b37c2be8f122bd5f4968af802838d46231099e835c60a800ffb'
const expectedVersion = '0.0.3-rc.1'
const dbPath = join(productionData, 'fts.db')
const argumentsList = process.argv.slice(2)
if (!argumentsList.length || argumentsList.length === 1 && argumentsList[0] === '--help') {
  console.log(JSON.stringify({ mode: 'prepare-only', productionOpened: false,
    requiredArguments: ['--apply', '--ack-stopped-writers', 'all'], candidateManifestSha256: expectedManifest,
    data: productionData, procedure: 'Stop all shared writers; take a new complete verified E snapshot; migrate with the approved SessionFts directly.' }))
  process.exit(0)
}

let reportPath, report, engine, DatabaseSync, upgradeStarted
function check(condition, code) { if (!condition) throw Object.assign(new Error(code), { code }) }
function equalPath(actual, expected) { return resolve(actual).toLowerCase() === resolve(expected).toLowerCase() }
function technicalError(error) {
  const safe = { name: typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name) ? error.name : 'Error',
    code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,60}$/.test(error.code) ? error.code : 'UNSPECIFIED' }
  const text = typeof error?.message === 'string' ? error.message : ''
  safe.category = /SQLITE_BUSY|SQLITE_LOCKED|database (?:is )?locked/i.test(text) ? 'sqlite-locked' :
    /SQLITE_READONLY|read.?only database/i.test(text) ? 'sqlite-readonly' :
    /fts5|trigram|no such tokenizer/i.test(text) ? 'sqlite-fts-tokenizer' :
    /malformed|corrupt|no such (?:table|column)/i.test(text) ? 'sqlite-schema' :
    /EPERM|EACCES|ENOENT|permission denied/i.test(text) ? 'filesystem-access' : 'unclassified'
  if (Number.isInteger(error?.errcode)) safe.sqliteCode = error.errcode
  return safe
}
async function hash(file) {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(file)) digest.update(bytes)
  return digest.digest('hex')
}
async function fixedDirectory(path, expected = path) {
  check(equalPath(path, expected), 'EUPGRADEPATH')
  const info = await lstat(path)
  check(info.isDirectory() && !info.isSymbolicLink(), 'EUPGRADEREPARSE')
  check(equalPath(await realpath(path), expected), 'EUPGRADEPATH')
}
async function fixedFile(path) {
  const info = await lstat(path)
  check(info.isFile() && !info.isSymbolicLink(), 'EUPGRADEREPARSE')
  check(equalPath(await realpath(path), path), 'EUPGRADEPATH')
}
async function fileManifest(root) {
  const result = {}
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(path, entry.name), info = await lstat(file)
      check(!info.isSymbolicLink(), 'EUPGRADEREPARSE')
      check(equalPath(await realpath(file), file), 'EUPGRADEPATH')
      if (info.isDirectory()) await visit(file)
      else if (info.isFile()) result[relative(root, file).split(sep).join('/')] = { bytes: info.size, sha256: await hash(file) }
      else check(false, 'EUPGRADEFILETYPE')
    }
  }
  await fixedDirectory(root)
  await visit(root)
  return result
}
async function verifyCandidateAndRuntime() {
  await fixedDirectory(candidate)
  await fixedDirectory(runtime)
  await fixedFile(join(candidate, 'SHA256.json'))
  check(await hash(join(candidate, 'SHA256.json')) === expectedManifest, 'EUPGRADEMANIFEST')
  const list = JSON.parse(await readFile(join(candidate, 'SHA256.json'), 'utf8'))
  const deployed = []
  for (const [name, expectedHash] of Object.entries(list)) {
    check(!isAbsolute(name) && !name.includes('\\') && !name.split('/').some(part => !part || part === '.' || part === '..'), 'EUPGRADEMANIFESTPATH')
    check(/^[a-f0-9]{64}$/.test(expectedHash), 'EUPGRADEMANIFESTHASH')
    const file = join(candidate, name)
    check(resolve(file).toLowerCase().startsWith(resolve(candidate).toLowerCase() + sep), 'EUPGRADEMANIFESTPATH')
    await fixedFile(file)
    check(await hash(file) === expectedHash, 'EUPGRADECANDIDATE')
    if (name.startsWith('lib/') || ['package.json', 'README.md', 'README_zh.md'].includes(name)) {
      const deployedFile = join(runtime, name)
      await fixedFile(deployedFile)
      check(await hash(deployedFile) === expectedHash, 'EUPGRADERUNTIME')
      deployed.push(name)
    }
  }
  check(Object.keys(list).length === 96 && deployed.length === 69, 'EUPGRADERUNTIMECOUNT')
  const packageInfo = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'))
  check(packageInfo.name === '@dsh-external/dsh-session-index' && packageInfo.version === expectedVersion, 'EUPGRADERUNTIMEVERSION')
  return { candidateFilesVerified: Object.keys(list).length, runtimeFilesVerified: deployed.length, version: expectedVersion }
}
function stoppedHostEvidence() {
  // Command lines are inspected inside PowerShell only. Output is exclusively PID/name.
  const script = "$ErrorActionPreference='Stop'; @((Get-CimInstance Win32_Process) | Where-Object { $_.ProcessId -ne " + process.pid +
    " -and ($_.Name -eq 'DeepSeek Harness.exe' -or ($_.Name -in @('node.exe','dsh.exe','pnpm.exe') -and ($_.CommandLine -match '(?i)(@deepseek-ai[\\\\/](dsh-desktop-host|dsh-web)|dsh[\\\\/]lib[\\\\/](cli|bin[.]js)|[.]dsh[\\\\/]profiles[\\\\/](desktop|web|pluginlab)|dsh-session-index[\\\\/]lib|session-index-data)'))) } | Select-Object @{Name='pid';Expression={$_.ProcessId}},@{Name='name';Expression={$_.Name}}) | ConvertTo-Json -Compress"
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  check(!result.error && result.status === 0, 'EUPGRADEPROCESSAUDIT')
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : []
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const hosts = rows.map(row => ({ pid: Number.isInteger(row.pid) ? row.pid : null,
    name: ['DeepSeek Harness.exe', 'node.exe', 'dsh.exe', 'pnpm.exe'].includes(row.name) ? row.name : 'unknown' }))
  check(hosts.length === 0, 'EUPGRADEWRITERSRUNNING')
  return { acknowledgedAllSharedWritersStopped: true, detectedHosts: hosts, checkedAt: new Date().toISOString() }
}
function databaseStatistics(file) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0; BEGIN')
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name))
    const result = { schemaVersion: tables.has('state_meta') ? String(db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get()?.value ?? '') : '' }
    for (const [table, name] of [['sessions', 'sessions'], ['messages', 'messages'], ['message_chunks', 'chunks'], ['fts_checkpoints', 'checkpoints']]) {
      result[name] = tables.has(table) ? Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n) : 0
    }
    const checks = db.prepare('PRAGMA quick_check').all()
    result.quickCheck = { passed: checks.length === 1 && Object.values(checks[0])[0] === 'ok', rows: checks.length,
      errorRows: checks.filter(row => Object.values(row)[0] !== 'ok').length }
    return result
  } finally { try { db.exec('ROLLBACK') } catch {} db.close() }
}
function preservedFiles(manifest) {
  return Object.fromEntries(Object.entries(manifest).filter(([name]) => !['fts.db', 'fts.db-wal', 'fts.db-shm', 'fts.db-journal'].includes(name)))
}
async function writeJson(file, value) { await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }) }

try {
  check(argumentsList.length === 3 && argumentsList[0] === '--apply' && argumentsList[1] === '--ack-stopped-writers' && argumentsList[2] === 'all', 'EUPGRADEARGUMENTS')
  check(process.platform === 'win32' && Number(process.versions.node.split('.')[0]) === 24, 'EUPGRADERUNTIMEPLATFORM')
  check(!process.env.NODE_OPTIONS, 'EUPGRADENODEOPTIONS')
  await fixedDirectory(implementation)
  check(equalPath(fileURLToPath(new URL('../', import.meta.url)), implementation), 'EUPGRADESCRIPTLOCATION')
  check(equalPath(await realpath(process.cwd()), implementation), 'EUPGRADECWD')
  await fixedDirectory(productionData)
  await fixedFile(dbPath)
  const stateFile = join(implementation, 'DEPLOYMENT_RESULTS', 'S7_STATE.json')
  await fixedFile(stateFile)
  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  check(state.candidateManifestSha256 === expectedManifest && state.runtimeVersion === expectedVersion && state.deployedFilesVerified === 69, 'EUPGRADEAPPROVEDSTATE')
  for (const [key, expected] of [['candidate', candidate], ['runtime', runtime], ['productionData', productionData], ['backup', originalBackup]]) check(typeof state[key] === 'string' && equalPath(state[key], expected), 'EUPGRADEAPPROVEDPATH')
  await fixedDirectory(originalBackup)
  const runtimeEvidence = await verifyCandidateAndRuntime()
  const stopped = stoppedHostEvidence()
  const tag = `S7-OFFLINE-FTS-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  const backupParent = join(implementation, 'deployment-backups'), resultParent = join(implementation, 'DEPLOYMENT_RESULTS')
  await fixedDirectory(backupParent)
  await fixedDirectory(resultParent)
  const backup = join(backupParent, tag), snapshot = join(backup, 'data-before-offline-upgrade')
  check(backup.toLowerCase().startsWith(backupParent.toLowerCase() + sep) && !equalPath(backup, originalBackup), 'EUPGRADEBACKUPPATH')
  reportPath = join(resultParent, `${tag}.json`)
  report = { generatedAt: new Date().toISOString(), operation: 'approved-offline-derived-fts-schema-upgrade',
    data: productionData, backup, snapshot, originalRecoverySnapshot: originalBackup, candidateManifestSha256: expectedManifest,
    runtime: runtimeEvidence, node: process.version, stopped, backupVerified: false, productionWriterOpened: false,
    llmCalled: false, sourceLogsTouched: false, bookmarksModified: false }
  const before = await fileManifest(productionData)
  await mkdir(backup) // Unique non-recursive creation; any existing target aborts.
  await fixedDirectory(backup)
  await cp(productionData, snapshot, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
  const copied = await fileManifest(snapshot), afterCopy = await fileManifest(productionData)
  assert.deepEqual(copied, before)
  assert.deepEqual(afterCopy, before)
  await writeJson(join(backup, 'RESTORE_MANIFEST.json'), { tag, createdAt: new Date().toISOString(), source: productionData,
    snapshot, fullDataSnapshot: true, stoppedWriterAcknowledgement: 'all', files: copied })
  report.backupVerified = true
  report.backupFileCount = Object.keys(copied).length
  report.bookmarksBefore = before['bookmarks.jsonl'] ?? null
  const sqlite = await import('node:sqlite')
  DatabaseSync = sqlite.DatabaseSync
  check(typeof DatabaseSync === 'function', 'EUPGRADESQLITE')
  report.before = databaseStatistics(dbPath)
  check(['2', '5'].includes(report.before.schemaVersion) && report.before.quickCheck.passed, 'EUPGRADEDBBASELINE')
  // Recheck runtime and known host writers after the complete backup, just before opening a writer.
  report.runtime = await verifyCandidateAndRuntime()
  report.stoppedImmediatelyBeforeUpgrade = stoppedHostEvidence()
  upgradeStarted = performance.now()
  if (report.before.schemaVersion === '5') report.status = 'already-upgraded-verified'
  else {
    const { SessionFts } = await import(pathToFileURL(join(runtime, 'lib', 'fts.js')).href)
    check(typeof SessionFts === 'function', 'EUPGRADEENGINE')
    const originalWarn = console.warn
    console.warn = (...values) => {
      report.initializationWarnings ??= []
      if (report.initializationWarnings.length < 10) report.initializationWarnings.push(technicalError({ message: values.filter(value => typeof value === 'string').join(' ') }))
    }
    try {
      report.productionWriterOpened = true
      engine = new SessionFts(dbPath, DatabaseSync)
      check(engine.ok, 'EUPGRADEINITIALIZATION')
    } finally { console.warn = originalWarn }
    await engine.close()
    engine = undefined
    report.status = 'upgraded-verified'
  }
  report.upgradeDurationMs = Math.round(performance.now() - upgradeStarted)
  report.after = databaseStatistics(dbPath)
  check(report.after.schemaVersion === '5' && report.after.quickCheck.passed, 'EUPGRADEPOSTCHECK')
  check(report.after.sessions === report.before.sessions && report.after.messages === report.before.messages, 'EUPGRADECOUNTCHANGED')
  const after = await fileManifest(productionData)
  assert.deepEqual(preservedFiles(after), preservedFiles(before))
  report.preservedNonDatabaseFilesVerified = true
  report.bookmarksAfter = after['bookmarks.jsonl'] ?? null
  assert.deepEqual(report.bookmarksAfter, report.bookmarksBefore)
  report.finishedAt = new Date().toISOString()
  await writeJson(reportPath, report)
  console.log(JSON.stringify({ status: report.status, backup, report: reportPath, durationMs: report.upgradeDurationMs,
    before: report.before, after: report.after, bookmarksHashUnchanged: true, preservedNonDatabaseFilesVerified: true }))
} catch (error) {
  if (engine) { try { await engine.close() } catch {} }
  const failure = technicalError(error)
  if (report) {
    report.status = 'failed'
    report.failure = failure
    if (upgradeStarted !== undefined) report.upgradeDurationMs = Math.round(performance.now() - upgradeStarted)
    report.finishedAt = new Date().toISOString()
    if (DatabaseSync && report.productionWriterOpened) {
      try { report.afterFailure = databaseStatistics(dbPath) } catch (readError) { report.afterFailureError = technicalError(readError) }
    }
    try { await writeJson(reportPath, report) } catch { /* Keep the existing snapshot and any earlier evidence untouched. */ }
  }
  console.error(JSON.stringify({ status: 'failed', error: failure, report: reportPath ?? null, backup: report?.backup ?? null }))
  process.exitCode = 1
}
