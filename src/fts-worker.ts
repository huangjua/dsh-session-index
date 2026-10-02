/** SQLite has exactly one owner thread. Staged JSONL is streamed from disk at atomic commit. */
import { parentPort, workerData, Worker } from 'node:worker_threads'
import { appendFile, mkdir, rm } from 'node:fs/promises'
import { closeSync, openSync, readSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { createSessionFts } from './fts.js'
import type { SessionFts, FtsMessageRow, SyncSessionRequest, SyncReceipt } from './fts.js'
import { spoolError, writeSpoolOwner } from './fts-spool.js'
import type { FtsSpoolCleanupFailure } from './fts-spool.js'

interface Request { id: number; op: string; args: unknown[]; data?: Uint8Array; deadline?: number; sentAt?: number; enqueuedAt?: number }
interface Staged { file: string; kind: string; header: unknown; ordinal: number; bytes: number; cleanupPending?: boolean; writeCommitted?: boolean }
interface IterableEngine {
  syncSessionIterable(header: Omit<SyncSessionRequest, 'messages'>, rows: () => Iterable<FtsMessageRow>): Promise<SyncReceipt>
  syncMessagesIterable(file: string, rows: () => Iterable<FtsMessageRow>, append: boolean): Promise<void>
}
const port = parentPort ?? {
  postMessage: (message: unknown) => process.send?.(message as Parameters<NonNullable<typeof process.send>>[0]),
  on: (_event: string, listener: (message: Request | { cancel: number } | { startAck: number }) => void) => { process.on('message', listener) },
  close: () => { process.disconnect?.() },
}
const config = (parentPort ? workerData : JSON.parse(process.argv[2] ?? '{}')) as { dbPath: string; spoolDirectory: string; batchBytes: number; queueBytes: number; readOnly?: boolean; role?: 'writer' | 'reader'; generation?: number; migrationLockTimeoutMs?: number }
if (!parentPort && (config.role !== 'reader' && config.role !== 'writer' || config.readOnly !== (config.role === 'reader'))) {
  throw new Error('FTS process role must match its database access mode')
}
if (!parentPort) process.channel?.ref()
// An IPC disconnect callback cannot run during native DatabaseSync SQL. A small
// independent thread observes parent death and kills only this derived process,
// so even a forcibly exited parent cannot leave an active SQLite transaction.
const parentGuardian = !parentPort ? new Worker(`
  const { workerData } = require('node:worker_threads');
  setInterval(() => {
    try { process.kill(workerData.parentPid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') process.kill(workerData.ownPid, 'SIGTERM');
    }
  }, 250);
`, { eval: true, workerData: { parentPid: process.ppid, ownPid: process.pid }, execArgv: [] }) : null
const queue: Request[] = []
const stages = new Map<string, Staged>()
const cancelled = new Set<number>()
const startPermits = new Map<number, (accepted: boolean) => void>()
let engine: (SessionFts & IterableEngine) | null = null
let running = false
let closing = false
let highPriorityStreak = 0
let queuedBytes = 0
let maxWorkerQueueBytes = 0
let maxWorkerQueueLength = 0
let maxStagedBytes = 0
let runningId = 0
let maxWorkerHeapUsed = 0
let maxWorkerExternalBytes = 0
let cleanupFailureCount = 0
let querySqlMs: number | undefined
const cleanupFailures: FtsSpoolCleanupFailure[] = []
const MAX_STAGED_BYTES = 1024 * 1024 * 1024
const MAX_RECORD_CHARACTERS = 512 * 1024 * 1024
const allowed = new Set(['upsertSession', 'removeSession', 'markPruned', 'optimize', 'vacuum', 'maybeMaintenance',
  'getCheckpoint', 'needsSync', 'listSessionFiles', 'sessionCount', 'lastPruneAt', 'lastPruneCount',
  'search', 'searchPage', 'around', 'resolveLegacyAnchor', 'health', 'flush', 'close'])
const isQuery = (operation: string) => /^(search|around|health|sessionCount|getCheckpoint|needsSync|listSessionFiles|lastPrune|resolveLegacy)/.test(operation)
const writerMutation = (operation: string) => /^(stageCommit|upsertSession|removeSession|markPruned|optimize|vacuum|maybeMaintenance)$/.test(operation)
function healthSnapshot() { return engine ? { ...engine.health(), observedAt: Date.now() } : undefined }

function structuredError(error: unknown) {
  const value = error as { name?: string; message?: string; code?: string; stack?: string; errcode?: unknown }
  const sqliteErrorCode = typeof value?.errcode === 'number' && Number.isSafeInteger(value.errcode) && value.errcode >= 0 ? value.errcode : undefined
  return { name: value?.name ?? 'Error', message: value?.message ?? String(error), code: value?.code ?? 'EFTSENGINE', stack: value?.stack, sqliteErrorCode }
}
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
async function acceptStart(request: Request): Promise<boolean> {
  return new Promise<boolean>(accept => {
    const timer = setTimeout(() => finish(false), Math.max(0, (request.deadline ?? Date.now() + 120000) - Date.now()))
    const finish = (accepted: boolean) => { clearTimeout(timer); startPermits.delete(request.id); accept(accepted) }
    startPermits.set(request.id, finish)
    port.postMessage({ id: request.id, started: true })
  })
}
function telemetry() {
  const memory = process.memoryUsage()
  maxWorkerHeapUsed = Math.max(maxWorkerHeapUsed, memory.heapUsed)
  maxWorkerExternalBytes = Math.max(maxWorkerExternalBytes, memory.external)
  return { readOnly: !!config.readOnly, memory, maxWorkerHeapUsed, maxWorkerExternalBytes, maxStagedBytes,
    stagedBytes: [...stages.values()].reduce((sum, stage) => sum + stage.bytes, 0), maxWorkerQueueBytes, maxWorkerQueueLength,
    cleanupFailures, cleanupFailureCount, cleanupPendingStages: [...stages.values()].filter(stage => stage.cleanupPending).length }
}

/** At most one JSONL record plus a 64 KiB disk buffer is retained. */
function* rowsFromSpool(file: string): Generator<FtsMessageRow> {
  const descriptor = openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const decoder = new StringDecoder('utf8')
  let parts: string[] = []
  let recordCharacters = 0
  let bodyBytes = 0
  let records = 0
  try {
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null)
      if (!count) break
      const text = decoder.write(buffer.subarray(0, count))
      let offset = 0
      while (true) {
        const newline = text.indexOf('\n', offset)
        if (newline === -1) {
          parts.push(text.slice(offset))
          recordCharacters += text.length - offset
          if (recordCharacters > MAX_RECORD_CHARACTERS) fail('EFTSSTAGE', 'FTS record exceeds the explicit staging limit')
          break
        }
        parts.push(text.slice(offset, newline))
        const line = parts.join('')
        parts = []
        recordCharacters = 0
        offset = newline + 1
        if (line) {
          const row = JSON.parse(line) as FtsMessageRow
          bodyBytes += Buffer.byteLength(row.text) + Buffer.byteLength(row.toolName)
          if (bodyBytes > 64 * 1024 * 1024) fail('EFTSSOURCE', 'FTS session body exceeds its 64 MiB UTF-8 budget')
          if (records++ % 1024 === 0) telemetry()
          yield row
        }
      }
    }
    parts.push(decoder.end())
    if (parts.some(part => part.length)) fail('EFTSSTAGE', 'Incomplete FTS staging record')
  } finally { closeSync(descriptor) }
}
async function removeStage(token: string, phase: FtsSpoolCleanupFailure['phase'], writeCommitted?: boolean): Promise<boolean> {
  const stage = stages.get(token)
  if (!stage) return true
  try {
    await rm(stage.file, { force: true })
    stages.delete(token)
    return true
  } catch (error) {
    stage.cleanupPending = true
    stage.writeCommitted = writeCommitted
    cleanupFailureCount++
    cleanupFailures.push({ ...spoolError(error), id: `${config.spoolDirectory}:${cleanupFailureCount}`, path: stage.file, phase, at: Date.now(), writeCommitted })
    if (cleanupFailures.length > 64) cleanupFailures.shift()
    return false
  }
}
async function dispatch(request: Request): Promise<unknown> {
  if (!engine) fail('EFTSUNAVAILABLE', 'FTS worker unavailable')
  if (config.readOnly && !isQuery(request.op)) fail('EFTSREADONLY', 'FTS reader rejects writes')
  if (closing && request.op !== 'close') fail('EFTSCLOSED', 'FTS worker closed')
  const [first, second] = request.args
  if (request.op === 'stageBegin') {
    for (const [token, stage] of stages) if (stage.cleanupPending) await removeStage(token, 'retry', stage.writeCommitted)
    if (stages.size >= 2) fail('EFTSQUEUE', 'FTS staging producer limit exceeded')
    const token = String(request.args[2])
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(token) || stages.has(token)) fail('EFTSPROTOCOL', 'Invalid FTS staging token')
    const file = join(config.spoolDirectory, `${token}.jsonl`)
    await appendFile(file, '')
    stages.set(token, { file, kind: String(first), header: second, ordinal: 0, bytes: 0 })
    return token
  }
  if (request.op === 'stageAbort') {
    const stage = stages.get(String(first))
    if (!(await removeStage(String(first), 'abort', stage?.writeCommitted))) fail('EFTSSPOOLCLEANUP', `FTS abort could not remove staging file: ${stage?.file}`)
    return
  }
  if (request.op === 'stageBatch') {
    const stage = stages.get(String(first))
    if (!stage || stage.cleanupPending || !request.data || request.data.byteLength > config.batchBytes || Number(second) !== stage.ordinal) fail('EFTSSTAGE', 'Invalid FTS staging batch')
    if (stage.bytes + request.data.byteLength > MAX_STAGED_BYTES) fail('EFTSSTAGE', 'FTS session staging exceeds the 1 GiB disk limit')
    await appendFile(stage.file, request.data)
    stage.ordinal++
    stage.bytes += request.data.byteLength
    maxStagedBytes = Math.max(maxStagedBytes, [...stages.values()].reduce((sum, item) => sum + item.bytes, 0))
    return
  }
  if (request.op === 'stageCommit') {
    const token = String(first)
    const stage = stages.get(token)
    if (!stage || stage.cleanupPending) fail('EFTSSTAGE', 'Missing or completed FTS staged session')
    let committed = false
    try {
      if (stage.kind === 'session') {
        const receipt = await engine.syncSessionIterable(stage.header as Omit<SyncSessionRequest, 'messages'>, () => rowsFromSpool(stage.file))
        committed = true
        return receipt
      }
      if (stage.kind === 'messages') {
        const header = stage.header as { file: string; append: boolean }
        await engine.syncMessagesIterable(header.file, () => rowsFromSpool(stage.file), header.append)
        committed = true
        return
      }
      fail('EFTSSTAGE', 'Unknown FTS staging kind')
    } finally {
      // Cleanup is a separate outcome. Never replace a committed receipt or the
      // primary SQL failure with an unlink error from the disposable spool.
      await removeStage(token, committed ? 'commit' : 'rollback', committed)
    }
  }
  if (!allowed.has(request.op)) fail('EFTSPROTOCOL', `Unknown FTS request ${request.op}`)
  if (/^search(?:Page)?$/.test(request.op) && (!Number.isInteger(request.args[2]) || Number(request.args[2]) < 1 || Number(request.args[2]) > 500)) fail('EFTSRANGE', 'FTS query limit must be 1..500')
  const method = (engine as unknown as Record<string, (...args: unknown[]) => unknown>)[request.op]
  if (typeof method !== 'function') fail('EFTSPROTOCOL', `Unavailable FTS method ${request.op}`)
  const result = await method.apply(engine, request.args)
  if (request.op === 'health') return { ...result as object, observedAt: Date.now(), workerQueueLength: queue.length, maxWorkerQueueLength,
    workerQueueBytes: queuedBytes, maxWorkerQueueBytes, stagedSessions: stages.size,
    stagedBytes: [...stages.values()].reduce((sum, stage) => sum + stage.bytes, 0), maxStagedBytes,
    workerMemory: process.memoryUsage() }
  if (request.op === 'close') {
    closing = true
    let complete = true
    for (const [token, stage] of stages) if (!(await removeStage(token, 'close', stage.writeCommitted))) complete = false
    if (!complete) fail('EFTSSPOOLCLEANUP', 'FTS closed its database but could not remove all staging files')
    try { await rm(config.spoolDirectory, { recursive: true, force: true }) }
    catch (error) {
      cleanupFailureCount++
      cleanupFailures.push({ ...spoolError(error), id: `${config.spoolDirectory}:${cleanupFailureCount}`, path: config.spoolDirectory, phase: 'close', at: Date.now() })
      if (cleanupFailures.length > 64) cleanupFailures.shift()
      fail('EFTSSPOOLCLEANUP', `FTS closed its database but could not remove its staging directory: ${config.spoolDirectory}`)
    }
  }
  return result
}
function boundedResponse(operation: string, result: unknown): unknown {
  const hit = (value: unknown) => {
    const row = value as Record<string, unknown>
    const text = String(row.text ?? '')
    return { ...row, text: text.slice(0, 4096), textTruncated: !!row.textTruncated || text.length > 4096 }
  }
  if (operation === 'search' && Array.isArray(result)) result = result.map(hit)
  if (operation === 'searchPage' && result && typeof result === 'object') {
    const page = result as { hits: unknown[] }
    result = { ...page, hits: page.hits.map(hit) }
  }
  if (result !== undefined && Buffer.byteLength(JSON.stringify(result)) > config.queueBytes - 4096) fail('EFTSRESPONSE', 'FTS response exceeds the 8 MiB byte budget')
  return result
}
async function drain(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length) {
      let index = -1
      if (highPriorityStreak < 4) index = queue.findIndex(request => isQuery(request.op))
      if (index === -1) { index = 0; highPriorityStreak = 0 } else highPriorityStreak++
      const request = queue.splice(index, 1)[0]!
      runningId = request.id
      queuedBytes -= request.data?.byteLength ?? 0
      if (cancelled.delete(request.id)) continue
      let startedAt = performance.now()
      const timing = { queueMs: 0, dispatchMs: 0, sqlMs: undefined as number | undefined, serializationMs: 0,
        healthSnapshotMs: undefined as number | undefined, responseAt: 0 }
      querySqlMs = undefined
      let dispatchCompleted = false
      try {
        if (request.deadline !== undefined && Date.now() >= request.deadline) fail('EFTSQUEUETIMEOUT', 'FTS request deadline expired in queue')
        if (!(await acceptStart(request))) fail('EFTSQUEUETIMEOUT', 'FTS start permit expired or was cancelled before SQL execution')
        if (cancelled.delete(request.id)) { runningId = 0; continue }
        if (request.deadline !== undefined && Date.now() >= request.deadline) fail('EFTSQUEUETIMEOUT', 'FTS request deadline expired before SQL execution')
        startedAt = performance.now()
        timing.queueMs = Math.max(0, Date.now() - (request.enqueuedAt ?? Date.now()))
        const raw = await dispatch(request)
        timing.dispatchMs = performance.now() - startedAt
        timing.sqlMs = querySqlMs
        dispatchCompleted = true
        const snapshotAt = performance.now()
        const snapshot = !config.readOnly && writerMutation(request.op) ? healthSnapshot() : undefined
        if (snapshot) timing.healthSnapshotMs = performance.now() - snapshotAt
        const serializationAt = performance.now()
        const result = boundedResponse(request.op, raw)
        if (!cancelled.delete(request.id)) {
          const response = { id: request.id, result, telemetry: telemetry(), timing, healthSnapshot: snapshot }
          if (Buffer.byteLength(JSON.stringify(response)) > config.queueBytes) fail('EFTSRESPONSE', 'FTS response including diagnostics exceeds the 8 MiB byte budget')
          timing.serializationMs = performance.now() - serializationAt
          timing.responseAt = Date.now()
          port.postMessage(response)
        }
        else if (request.op === 'stageBegin') await removeStage(String(result), 'abort')
      } catch (error) {
        if (!dispatchCompleted) {
          timing.dispatchMs = performance.now() - startedAt
          timing.sqlMs = querySqlMs
        }
        timing.responseAt = Date.now()
        if (!cancelled.delete(request.id)) port.postMessage({ id: request.id, error: structuredError(error), telemetry: telemetry(), timing })
      }
      runningId = 0
      // Let transport ingest queries between batches and completed transactions.
      await new Promise<void>(accept => setImmediate(accept))
    }
  } finally { running = false }
}

async function initialize(): Promise<void> {
  if (parentGuardian) await new Promise<void>((accept, reject) => { parentGuardian.once('online', accept); parentGuardian.once('error', reject) })
  port.postMessage({ startup: { state: 'booted' } })
  if (dirname(resolve(config.spoolDirectory)) !== dirname(resolve(config.dbPath))) fail('EFTSPROTOCOL', 'FTS staging must be adjacent to its derived database')
  await mkdir(config.spoolDirectory, { recursive: true })
  await writeSpoolOwner(config.spoolDirectory, config.dbPath)
  port.postMessage({ startup: { state: 'opening' } })
  engine = await createSessionFts(config.dbPath, { readOnly: !!config.readOnly, throwOnError: true,
    migrationLockTimeoutMs: config.migrationLockTimeoutMs,
    onMigrationProgress: progress => port.postMessage({ startup: { state: 'migrating', progress } }),
    onQueryTiming: timing => { querySqlMs = (querySqlMs ?? 0) + timing.sqlMs },
  }) as (SessionFts & IterableEngine) | null
  port.postMessage({ ready: true, available: !!engine, telemetry: telemetry(), healthSnapshot: !config.readOnly ? healthSnapshot() : undefined })
  if (!engine) { parentGuardian?.unref(); return }
  port.on('message', (message: Request | { cancel: number } | { startAck: number }) => {
    if ('startAck' in message) { startPermits.get(message.startAck)?.(true); return }
    if ('cancel' in message) {
      // Only retain cancellation IDs that are queued or currently in flight.
      const index = queue.findIndex(request => request.id === message.cancel)
      if (index !== -1) { const request = queue.splice(index, 1)[0]!; queuedBytes -= request.data?.byteLength ?? 0 }
      else if (runningId === message.cancel) { cancelled.add(message.cancel); startPermits.get(message.cancel)?.(false) }
      return
    }
    const bytes = message.data?.byteLength ?? 0
    if (queue.length >= 128 || queuedBytes + bytes > config.queueBytes || bytes > config.batchBytes) {
      port.postMessage({ id: message.id, error: structuredError(Object.assign(new Error('FTS worker queue budget exceeded'), { code: 'EFTSQUEUE' })) })
      return
    }
    queuedBytes += bytes
    message.enqueuedAt = Date.now()
    queue.push(message)
    maxWorkerQueueBytes = Math.max(maxWorkerQueueBytes, queuedBytes)
    maxWorkerQueueLength = Math.max(maxWorkerQueueLength, queue.length)
    void drain()
  })
  if (!parentPort) process.once('disconnect', () => {
    closing = true
    queue.length = 0
    queuedBytes = 0
    for (const finish of startPermits.values()) finish(false)
    void engine?.close().finally(() => process.exit(0))
  })
  // Keep startup alive until the IPC request listener owns the event loop.
  parentGuardian?.unref()
}
void initialize().catch(error => { port.postMessage({ ready: true, available: false, error: structuredError(error) }); port.close(); void parentGuardian?.terminate() })
