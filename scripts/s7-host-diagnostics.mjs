// Temporary E-only diagnostics preload for the approved installed Desktop Host.
// No host startup, model calls, schema/data migration, or installed-file mutation.
import { registerHooks } from 'node:module'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const installedHost = 'E:\\Program Files (x86)\\DSH-D\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js'
const installedSourceSha256 = '6c6182cbd9ff7df144145065885fbc5873e9a9db9651c5152e785c84a55689d6'
const captureLocation = 'const { ctx } = await application;'
const installedFtsClient = 'G:\\AI-Agent\\deepseek harness\\dsh-session-index\\lib\\fts-client.js'
const installedFtsClientSha256 = '0b3fffc6793b362b736259483455432834a1a2e7a7e2c4f3237be7283e23e7af'
const ftsCatchLocation = 'catch { /* Unsupported SQLite or a failed startup uses the existing source search fallback. */ }'
const ftsReadyLocation = 'if (await client.ready())\n            return client;'
const resultRoot = resolve(fileURLToPath(new URL('../DEPLOYMENT_RESULTS/', import.meta.url)))
const resultFile = resolve(resultRoot, 'host-diagnostics.jsonl')
const callbackKey = Symbol.for('dsh-session-index.s7-host-diagnostics.v1')
const ftsCallbackKey = Symbol.for('dsh-session-index.s7-fts-diagnostics.v1')
const names = ['session_index_status', 'session_index_list', 'session_index_search', 'session_summary', 'session_index_bookmark']
const initialDirectory = mkdir(resultRoot, { recursive: true }).catch(() => undefined)
let logChain = Promise.resolve()

function record(type, fields = {}) {
  logChain = logChain.then(async () => {
    await initialDirectory
    await appendFile(resultFile, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, type, ...fields }) + '\n', 'utf8')
  }).catch(() => undefined)
}
function errorFields(error) {
  return { errorName: typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name) ? error.name : 'Error',
    errorCode: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,60}$/.test(error.code) ? error.code : 'UNSPECIFIED' }
}
function startupErrorFields(error, moduleUrl) {
  // Inspect technical text only in memory. No message, stack or URL is persisted.
  let category = 'unclassified', protocol = 'unknown'
  try { protocol = publicState(new URL(moduleUrl).protocol, ['file:', 'data:', 'node:', 'dsh:', 'blob:', 'https:', 'http:']) ?? 'other' } catch {}
  const technicalText = typeof error?.message === 'string' ? error.message : ''
  const patterns = [
    ['unsupported-sqlite', /(?:node:sqlite|No such built-in module|sqlite.*(?:unavailable|unsupported))/i],
    ['sqlite-fts-tokenizer', /(?:no such (?:module|tokenizer).*fts|no such tokenizer|fts5|trigram)/i],
    ['sqlite-locked', /(?:SQLITE_BUSY|SQLITE_LOCKED|database (?:is )?locked)/i],
    ['sqlite-readonly', /(?:read.?only database|SQLITE_READONLY)/i],
    ['sqlite-schema', /(?:no such (?:table|column)|duplicate column|malformed database|database disk image is malformed)/i],
    ['worker-url', /(?:worker.*(?:path|URL|protocol)|Invalid URL|(?:file|data).*protocol|ERR_WORKER_PATH|ERR_UNSUPPORTED_ESM_URL_SCHEME)/i],
    ['worker-timeout', /(?:worker startup timed out|EFTSSTARTUP)/i],
    ['worker-exit', /(?:worker.*(?:exit|closed)|EFTSWORKEREXIT)/i],
    ['filesystem-access', /(?:EACCES|EPERM|ENOENT|permission denied|operation not permitted)/i],
  ]
  for (const [name, pattern] of patterns) if (pattern.test(technicalText)) { category = name; break }
  return { ...errorFields(error), category, moduleProtocol: protocol }
}
function scalars(input, keys) {
  const output = {}
  for (const key of keys) {
    const value = input?.[key]
    if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) output[key] = value
  }
  return output
}
function publicState(input, allowed) { return typeof input === 'string' && allowed.includes(input) ? input : undefined }
function sanitizeStatus(status) {
  const result = scalars(status, ['sessions', 'files', 'updatedAt', 'active', 'fts', 'ftsSessions', 'retentionDays', 'detailMissing',
    'added', 'updated', 'skipped', 'removed', 'raced', 'failed', 'scannedBytes'])
  // These are the already-approved index and source roots, never individual source names or content.
  for (const key of ['root', 'indexFile']) if (typeof status?.[key] === 'string') result[key] = status[key]
  result.errorCount = Array.isArray(status?.errors) ? status.errors.length : 0
  const health = status?.ftsHealth
  result.ftsHealth = scalars(health, ['enabled', 'ok', 'sessions', 'messages', 'dbSizeBytes', 'lastOptimizeAt', 'lastPruneAt',
    'lastPruneCount', 'lastWriteErrorAt', 'pendingWrites', 'failedSessions', 'dirtySessions', 'acceptingWrites', 'incompleteSessions'])
  if (typeof health?.schemaVersion === 'string' && /^\d*$/.test(health.schemaVersion)) result.ftsHealth.schemaVersion = health.schemaVersion
  result.ftsHealth.lastWriteErrorPresent = Boolean(health?.lastWriteError)
  const worker = health?.worker
  result.ftsHealth.worker = scalars(worker, ['degraded', 'workerReady', 'readerReady', 'restarts', 'restartSuspended',
    'pendingRequests', 'pendingWrites', 'activeStreams', 'activeSourceBytes', 'maxActiveSourceBytes', 'activeBodyBytes',
    'maxActiveBodyBytes', 'maxWriterHeapUsed', 'maxReaderHeapUsed', 'writerStagedBytes', 'maxWriterStagedBytes', 'queueBytes',
    'transportQueueBytes', 'queuedSourceBytes', 'queuedProducers', 'maxQueueBytes', 'inFlightBatches', 'maxInFlightBatches',
    'maxBatchBytes', 'lastTransportErrorAt', 'lastWriteErrorAt', 'failedSessions', 'spoolCleanupFailureCount',
    'spoolCleanupPendingStages', 'orphanSpoolCount', 'unknownSpoolOwnerCount', 'acceptingWrites'])
  result.ftsHealth.worker.lastTransportErrorPresent = Boolean(worker?.lastTransportError)
  result.ftsHealth.worker.lastRecoveryCallbackErrorPresent = Boolean(worker?.lastRecoveryCallbackError)
  result.ftsHealth.worker.lastWriteErrorPresent = Boolean(worker?.lastWriteError)
  for (const key of ['writerMemory', 'readerMemory', 'hostMemory']) result.ftsHealth.worker[key] = scalars(worker?.[key], ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'])
  result.progress = scalars(status?.progress, ['processed', 'total', 'scannedBytes', 'delayMs'])
  result.progress.phase = publicState(status?.progress?.phase, ['scan', 'head', 'full', 'commit'])
  result.lastReport = scalars(status?.lastReport, ['totalFiles', 'processed', 'headParsed', 'fullParsed', 'added', 'updated',
    'skipped', 'removed', 'raced', 'failed', 'scanComplete', 'scanTruncated', 'ftsSynced', 'ftsFailed', 'scannedBytes',
    'discoveredBytes', 'readBytes', 'decodedBytes', 'deltaBytes', 'incompleteSessions', 'deltaParsed', 'deltaFallbacks',
    'durationMs', 'maxEventLoopDelayMs', 'partialCommitted'])
  result.lastReport.status = publicState(status?.lastReport?.status, ['completed', 'degraded', 'cancelled', 'failed', 'skipped'])
  result.lastReport.errorCount = Array.isArray(status?.lastReport?.errors) ? status.lastReport.errors.length : 0
  result.lastReport.failedSubtreeCount = Array.isArray(status?.lastReport?.failedSubtrees) ? status.lastReport.failedSubtrees.length : 0
  return result
}

function capture(ctx) {
  let stopped = false, busy = false, probed = false, previousRegistration
  const started = Date.now()
  const lifetimeMs = 30 * 60 * 1000
  const get = name => ctx?.tools?.get(name)
  const schemaSnapshot = () => names.map(name => {
    const definition = get(name)
    const schema = definition?.parameters
    const properties = schema?.properties ?? schema
    return { name, registered: typeof definition?.execute === 'function', hasOutputSchema: Boolean(definition?.output?.schema),
      hasOutputRender: typeof definition?.output?.render === 'function',
      parameterNames: properties && typeof properties === 'object' ? Object.keys(properties).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,50}$/.test(key)).sort() : [] }
  })
  async function readOnlyProbes() {
    // Tool execute() values remain inside this process; renderer output functions are never called.
    // Persist only counts and identity-check booleans, never query results or bookmark values.
    try {
      const inventoryService = ctx?.get?.('pluginInventory') ?? ctx?.pluginInventory
      if (typeof inventoryService?.list === 'function') {
        const inventory = await inventoryService.list()
        const entries = Array.isArray(inventory?.entries) ? inventory.entries : []
        const selected = entries.filter(entry => entry.moduleName === '@dsh-external/dsh-session-index').map(entry => ({
          moduleName: '@dsh-external/dsh-session-index', enabled: entry.enabled === true,
          fiberPhase: publicState(entry.fiberPhase, ['failed', 'pending', 'active', 'loading', 'unloading']) ?? null }))
        record('plugin-inventory', { entries: selected })
      } else record('plugin-inventory-unavailable')
      const packageInfo = JSON.parse(await readFile('G:\\AI-Agent\\deepseek harness\\dsh-session-index\\package.json', 'utf8'))
      record('runtime-package', { name: packageInfo.name === '@dsh-external/dsh-session-index' ? packageInfo.name : undefined,
        version: typeof packageInfo.version === 'string' && /^[0-9A-Za-z.-]{1,40}$/.test(packageInfo.version) ? packageInfo.version : undefined })
    } catch (error) { record('plugin-inventory-error', errorFields(error)) }
    try {
      const list = await get('session_index_list').execute({ limit: 1 })
      record('list', { ...scalars(list, ['total', 'returned', 'updatedAt']), itemCount: Array.isArray(list?.sessions) ? list.sessions.length : undefined })
    } catch (error) { record('list-error', errorFields(error)) }
    try {
      const bookmarks = await get('session_index_bookmark').execute({ action: 'list', limit: 1 })
      record('bookmark-list', { ...scalars(bookmarks, ['total', 'matched', 'returned', 'skippedBad', 'indexReady']),
        staleCount: Array.isArray(bookmarks?.bookmarks) ? bookmarks.bookmarks.filter(row => row.stale === true).length : 0 })
    } catch (error) { record('bookmark-list-error', errorFields(error)) }
    try {
      const search = get('session_index_search')
      const result = await search.execute({ mode: 'full', query: 'session', filter: { role: 'assistant' }, limit: 5 })
      const hits = Array.isArray(result?.hits) ? result.hits : []
      let checked = 0, passed = 0, contentWithAnchor = 0
      for (const hit of hits) {
        if (hit.kind !== 'content' || typeof hit.anchorId !== 'string' || typeof hit.sessionId !== 'string') continue
        contentWithAnchor++
        if (checked >= 2) continue
        checked++
        try {
          const scroll = await search.execute({ session_id: hit.sessionId, anchor_id: hit.anchorId, window: 1 })
          if (scroll?.ok !== false && scroll?.session_id === hit.sessionId && scroll?.anchor_id === hit.anchorId &&
              Array.isArray(scroll.messages) && scroll.messages.some(row => row.anchorId === hit.anchorId)) passed++
        } catch {}
      }
      record('full-search', { query: 'session', ...scalars(result, ['total', 'returned', 'totalExact', 'hasMore', 'truncated']),
        hitCount: hits.length, contentWithAnchor, anchorIdentityChecked: checked, anchorIdentityPassed: passed,
        coverageComplete: result?.coverage?.complete === true,
        failedSourceCount: Number.isFinite(result?.coverage?.sourceLimits?.failedSessions) ? result.coverage.sourceLimits.failedSessions : undefined })
    } catch (error) { record('full-search-error', errorFields(error)) }
  }
  async function sample() {
    if (stopped || busy) return
    if (Date.now() - started > lifetimeMs) { stopped = true; clearInterval(timer); record('diagnostics-expired'); return }
    busy = true
    try {
      const registrations = schemaSnapshot(), registrationKey = JSON.stringify(registrations)
      if (registrationKey !== previousRegistration) { previousRegistration = registrationKey; record('registrations', { tools: registrations }) }
      const statusTool = get('session_index_status')
      if (typeof statusTool?.execute !== 'function') return
      const status = await statusTool.execute({})
      record('status', { status: sanitizeStatus(status) })
      if (!probed && registrations.every(tool => tool.registered) && !status?.active && status?.ftsHealth?.ok &&
        status?.ftsHealth?.pendingWrites === 0 && status?.ftsHealth?.dirtySessions === 0) {
        probed = true
        await readOnlyProbes()
      }
    } catch (error) { record('status-error', errorFields(error)) }
    finally { busy = false }
  }
  const timer = setInterval(() => { void sample() }, 500)
  timer.unref()
  try { ctx.effect(() => () => { stopped = true; clearInterval(timer); record('host-disposed') }, 's7-read-only-diagnostics') }
  catch (error) { record('cleanup-registration-error', errorFields(error)) }
  record('host-context-captured', { sampleEveryMs: 500, lifetimeMs, toolCount: names.length })
  void sample()
}

globalThis[callbackKey] = ctx => {
  try { capture(ctx) } catch (error) { record('capture-error', errorFields(error)) }
}
globalThis[ftsCallbackKey] = (type, error, moduleUrl) => {
  try {
    if (type === 'fts-client-startup-error' || type === 'fts-client-ready-false') record(type, startupErrorFields(error, moduleUrl))
  } catch { /* Diagnostic reporting never changes factory behavior. */ }
}

registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context)
  let filename
  try { if (url.startsWith('file:')) filename = fileURLToPath(url) } catch {}
  const isInstalledHost = filename?.toLowerCase() === installedHost.toLowerCase()
  const isInstalledFtsClient = filename?.toLowerCase() === installedFtsClient.toLowerCase()
  // Transformed host loaders may provide a non-file URL. Its exact pinned source
  // hash still allows the same module, without logging the possibly private URL.
  if (!isInstalledHost && !isInstalledFtsClient && !/^(?:data|dsh|blob):/.test(url)) return loaded
  try {
    if (loaded.format !== 'module' || loaded.source == null) {
      if (isInstalledHost || isInstalledFtsClient) record('hook-refused', { reason: 'format-or-source', module: isInstalledHost ? 'host' : 'fts-client' })
      return loaded
    }
    const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8')
    const sourceHash = createHash('sha256').update(source).digest('hex')
    if (isInstalledFtsClient || sourceHash === installedFtsClientSha256) {
      const catchCount = source.split(ftsCatchLocation).length - 1
      const readyCount = source.split(ftsReadyLocation).length - 1
      if (sourceHash !== installedFtsClientSha256 || catchCount !== 1 || readyCount !== 1) {
        record('fts-hook-refused', { reason: 'source-hash-or-location', sourceHash, catchCount, readyCount }); return loaded
      }
      const emit = type => `try { globalThis[Symbol.for('dsh-session-index.s7-fts-diagnostics.v1')]?.('${type}', ${type === 'fts-client-startup-error' ? 'error' : 'undefined'}, import.meta.url); } catch { /* Diagnostics never fail the factory. */ }`
      const augmented = source.replace(ftsCatchLocation, `catch (error) { ${emit('fts-client-startup-error')} /* Existing source search fallback is preserved. */ }`)
        .replace(ftsReadyLocation, `${ftsReadyLocation}\n        ${emit('fts-client-ready-false')}`)
      record('fts-hook-instrumented', { sourceHash, catchCount, readyCount, moduleProtocol: startupErrorFields(undefined, url).moduleProtocol })
      return { ...loaded, source: augmented }
    }
    if (!isInstalledHost) return loaded
    const locationCount = source.split(captureLocation).length - 1
    if (sourceHash !== installedSourceSha256 || locationCount !== 1) {
      record('hook-refused', { reason: 'source-hash-or-location', sourceHash, locationCount }); return loaded
    }
    const extra = `${captureLocation}\n\ttry { globalThis[Symbol.for('dsh-session-index.s7-host-diagnostics.v1')]?.(ctx); } catch { /* Diagnostics never fail the Host. */ }`
    record('hook-instrumented', { sourceHash, locationCount })
    return { ...loaded, source: source.replace(captureLocation, extra) }
  } catch (error) { record('hook-error', errorFields(error)); return loaded }
} })

record('preload-ready', { nodeVersion: process.version, cwd: process.cwd(),
  profile: process.argv[3] === 'C:\\Users\\admin\\.dsh\\profiles\\desktop' ? process.argv[3] : undefined,
  installedHostSourceSha256: installedSourceSha256 })
