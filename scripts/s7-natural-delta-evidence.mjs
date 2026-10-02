/**
 * Prepare a baseline, or compare after a USER's natural append. Never creates
 * a session, sends a message, refreshes a host or writes a production file.
 * Only one new E evidence JSON is written. Source logs are stat'ed, not read.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const implementation = 'E:\\Do Something\\DSH备份\\dsh-session-index work\\implementation-session-index'
const evidenceRoot = join(implementation, 'DEPLOYMENT_RESULTS')
const productionData = 'E:\\Do Something\\DSH备份\\session-index-data'
const sessionsRoot = 'C:\\Users\\admin\\.dsh\\sessions'
const hostPid = 15916
const expectedBaselineEntries = 331
const parserVersion = 'session-index/3-chunks'
const maxSampleAgeMs = 10_000
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const error = code => Object.assign(new Error(), { code })
const samePath = (a, b) => typeof a === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase()
const inside = (root, file) => { const part = relative(root, file); return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep) }
const number = value => typeof value === 'number' && Number.isFinite(value)
const same = (a, b, fields) => fields.every(field => a[field] === b[field])
const report = { generatedAt: new Date().toISOString(), scriptSucceeded: false, naturalDeltaEvidenceSatisfied: false }

const ready = record => {
  const status = record?.status, health = status?.ftsHealth, worker = health?.worker
  return record?.pid === hostPid && record.type === 'status' && status.active === false &&
    health?.ok === true && health.schemaVersion === '5' && worker?.workerReady === true && worker.readerReady === true &&
    health.dirtySessions === 0 && health.pendingWrites === 0 && health.failedSessions === 0 &&
    worker.pendingWrites === 0 && worker.pendingRequests === 0 && worker.failedSessions === 0
}
function fresh(record) {
  const age = Date.now() - Date.parse(record?.time)
  return number(age) && age >= 0 && age <= maxSampleAgeMs
}
async function hostLog() {
  const bytes = await readFile(join(evidenceRoot, 'host-diagnostics.jsonl'))
  const completeEnd = bytes.lastIndexOf(10) + 1
  const rows = []
  let start = 0
  while (start < completeEnd) {
    const end = bytes.indexOf(10, start) + 1
    let value
    try { value = JSON.parse(bytes.subarray(start, end).toString('utf8')) } catch { throw error('ENATURALLOGJSON') }
    if (value?.type === 'status' && value.pid === hostPid) rows.push({ value, start, end })
    start = end
  }
  const latest = rows.at(-1)
  if (!latest || !ready(latest.value) || !fresh(latest.value)) throw error('ENATURALHOSTNOTREADY')
  return { bytes, completeEnd, rows, latest }
}
async function indexSnapshot() {
  const bytes = await readFile(join(productionData, 'index.json'))
  const index = JSON.parse(bytes.toString('utf8'))
  if (!Array.isArray(index.sessions) || !samePath(index.root, sessionsRoot) || !number(index.updatedAt)) throw error('ENATURALINDEXSHAPE')
  const entries = index.sessions.map(meta => {
    if (!meta || typeof meta.file !== 'string' || typeof meta.id !== 'string' ||
        !['size', 'mtimeMs'].every(key => number(meta[key]))) throw error('ENATURALMETASHAPE')
    return { fileHash: hash(meta.file), sessionHash: hash(meta.id), size: meta.size, mtimeMs: meta.mtimeMs,
      ctimeMs: meta.ctimeMs ?? -1, indexedBytes: meta.indexedBytes ?? meta.size,
      indexedSeq: meta.indexedSeq ?? null, generation: meta.generation ?? null,
      complete: !meta.detailMissing && !meta.unindexable && meta.coverage?.complete !== false,
      dirty: meta.ftsDirty === true, detailMissing: meta.detailMissing === true, unindexable: meta.unindexable === true }
  })
  if (new Set(entries.map(entry => entry.fileHash)).size !== entries.length) throw error('ENATURALDUPLICATES')
  return { index, entries, bytesHash: hash(bytes) }
}
function aligned(log, snapshot) {
  return log.latest.value.status.updatedAt === snapshot.index.updatedAt &&
    log.latest.value.status.sessions === snapshot.entries.length
}
function checkpoints(snapshot) {
  const db = new DatabaseSync(join(productionData, 'fts.db'), { readOnly: true })
  let begun = false
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=2500; BEGIN')
    begun = true
    const schema = db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get()?.value
    const rows = db.prepare('SELECT file, checkpoint_json FROM fts_checkpoints').all()
    const byFile = new Map()
    let invalid = 0
    for (const row of rows) {
      let checkpoint
      try { checkpoint = JSON.parse(row.checkpoint_json) } catch {}
      if (!checkpoint || checkpoint.file !== row.file) { invalid++; continue }
      byFile.set(row.file, checkpoint)
    }
    let matched = 0, missing = 0, mismatched = 0
    for (const meta of snapshot.index.sessions) {
      const checkpoint = byFile.get(meta.file)
      if (!checkpoint) { missing++; continue }
      const expected = { file: meta.file, sessionId: meta.id, size: meta.size, mtimeMs: meta.mtimeMs,
        ctimeMs: meta.ctimeMs ?? -1, indexedBytes: meta.indexedBytes ?? meta.size, indexedSeq: meta.indexedSeq,
        complete: !meta.detailMissing && !meta.unindexable && meta.coverage?.complete !== false,
        parserVersion }
      if (same(checkpoint, expected, Object.keys(expected)) && !meta.ftsDirty) matched++; else mismatched++
    }
    const files = new Set(snapshot.index.sessions.map(meta => meta.file))
    const orphan = [...byFile.keys()].filter(file => !files.has(file)).length
    db.exec('ROLLBACK')
    begun = false
    return { schema5: schema === '5', checkpointCount: rows.length, invalid, matched, missing, mismatched, orphan,
      allMetadataConverged: schema === '5' && invalid === 0 && missing === 0 && mismatched === 0 && orphan === 0 && matched === snapshot.entries.length,
      messageCountIntegrityRequiresIndependentDbAudit: true }
  } finally { if (begun) { try { db.exec('ROLLBACK') } catch {} } db.close() }
}

try {
  if (!samePath(resolve(dirname(fileURLToPath(import.meta.url)), '..'), implementation)) throw error('ENATURALROOT')
  const args = process.argv.slice(2)
  const baselineMode = args.length === 1 && args[0] === '--baseline'
  const compareMode = args.length === 2 && args[0] === '--compare'
  if (!baselineMode && !compareMode) throw error('ENATURALARGS')
  report.mode = baselineMode ? 'baseline' : 'compare'
  const snapshot = await indexSnapshot()
  const cp = checkpoints(snapshot)
  const log = await hostLog()
  const stableIndex = hash(await readFile(join(productionData, 'index.json'))) === snapshot.bytesHash
  if (!aligned(log, snapshot) || !stableIndex || !cp.allMetadataConverged) throw error('ENATURALNOTCONVERGED')
  report.hostPid = hostPid
  report.latestHostSampleTime = log.latest.value.time
  report.latestHostSampleKey = hash(JSON.stringify(log.latest.value))
  report.finalHostReady = true
  report.jsonEntries = snapshot.entries.length
  report.jsonStableDuringCapture = stableIndex
  report.checkpoints = cp
  report.requiresIndependentReadOnlyDbAudit = true

  if (baselineMode) {
    if (snapshot.entries.length !== expectedBaselineEntries || snapshot.entries.some(entry => !entry.complete || entry.dirty || !number(entry.indexedSeq))) {
      throw error('ENATURALBASELINEINCOMPLETE')
    }
    // A source already changed before this baseline is not a later natural
    // append. Require every saved source fingerprint to match a stat now.
    const actualRoot = await realpath(sessionsRoot)
    report.baselineSources = { checked: 0, matched: 0, mismatched: 0, unavailable: 0 }
    for (const meta of snapshot.index.sessions) {
      report.baselineSources.checked++
      try {
        if (!isAbsolute(meta.file) || !inside(sessionsRoot, meta.file)) throw error('ENATURALSOURCEPATH')
        const actual = await realpath(meta.file)
        if (!inside(actualRoot, actual)) throw error('ENATURALSOURCEPATH')
        const info = await stat(actual)
        if (info.isFile() && info.size === meta.size && info.mtimeMs === meta.mtimeMs && info.ctimeMs === (meta.ctimeMs ?? -1)) report.baselineSources.matched++
        else report.baselineSources.mismatched++
      } catch { report.baselineSources.unavailable++ }
    }
    const finalBaselineLog = await hostLog()
    if (report.baselineSources.matched !== snapshot.entries.length || !aligned(finalBaselineLog, snapshot) ||
        hash(await readFile(join(productionData, 'index.json'))) !== snapshot.bytesHash) throw error('ENATURALBASELINESOURCERACED')
    report.latestHostSampleTime = finalBaselineLog.latest.value.time
    report.latestHostSampleKey = hash(JSON.stringify(finalBaselineLog.latest.value))
    report.logOffset = finalBaselineLog.completeEnd
    report.logPrefixSha256 = hash(finalBaselineLog.bytes.subarray(0, finalBaselineLog.completeEnd))
    report.indexSha256 = snapshot.bytesHash
    report.hostIndexUpdatedAt = snapshot.index.updatedAt
    report.entries = snapshot.entries
    report.baselineReady = true
    report.userAppendMustStartAfterBaselineReportExists = true
    report.baselineCaptureAtomicAcrossSources = false
  } else {
    const baselineFile = resolve(args[1])
    if (!inside(evidenceRoot, baselineFile) || !inside(await realpath(evidenceRoot), await realpath(baselineFile))) throw error('ENATURALBASELINEPATH')
    const baselineBytes = await readFile(baselineFile)
    const baseline = JSON.parse(baselineBytes.toString('utf8'))
    if (baseline.mode !== 'baseline' || baseline.baselineReady !== true || baseline.scriptSucceeded !== true ||
        baseline.hostPid !== hostPid || !Array.isArray(baseline.entries) || baseline.entries.length !== expectedBaselineEntries ||
        !Number.isSafeInteger(baseline.logOffset) || baseline.logOffset < 0 || baseline.logOffset > log.completeEnd ||
        hash(log.bytes.subarray(0, baseline.logOffset)) !== baseline.logPrefixSha256) throw error('ENATURALBASELINEMISMATCH')
    report.baselineSha256 = hash(baselineBytes)
    const before = new Map(baseline.entries.map(entry => [entry.fileHash, entry]))
    if (before.size !== baseline.entries.length) throw error('ENATURALBASELINEDUPLICATES')
    const current = new Map(snapshot.entries.map(entry => [entry.fileHash, entry]))
    report.changes = { existingFiles: 0, newFiles: 0, missingFiles: 0, sessionIdentityChanged: 0, generationChanged: 0,
      bytesRegressed: 0, seqRegressed: 0, existingBytesAndSeqAdvanced: 0, advancedCompressedBytes: 0,
      advancingOldSourceSizeBytes: 0, advancingNewSourceSizeBytes: 0,
      advancedSeqCount: 0, advancedSourceStatMatched: 0, advancedSourceStatMismatched: 0, advancedSourceUnavailable: 0 }
    const advancing = []
    for (let index = 0; index < snapshot.entries.length; index++) {
      const after = snapshot.entries[index], old = before.get(after.fileHash)
      if (!old) { report.changes.newFiles++; continue }
      report.changes.existingFiles++
      if (old.sessionHash !== after.sessionHash) { report.changes.sessionIdentityChanged++; continue }
      if (old.generation !== after.generation) { report.changes.generationChanged++; continue }
      if (after.indexedBytes < old.indexedBytes || after.size < old.size) report.changes.bytesRegressed++
      if (number(after.indexedSeq) && number(old.indexedSeq) && after.indexedSeq < old.indexedSeq) report.changes.seqRegressed++
      if (after.complete && !after.dirty && after.size > old.size && after.indexedBytes > old.indexedBytes &&
          after.indexedBytes === after.size && number(after.indexedSeq) && number(old.indexedSeq) && after.indexedSeq > old.indexedSeq) {
        report.changes.existingBytesAndSeqAdvanced++
        report.changes.advancedCompressedBytes += after.indexedBytes - old.indexedBytes
        report.changes.advancingOldSourceSizeBytes += old.size
        report.changes.advancingNewSourceSizeBytes += after.size
        report.changes.advancedSeqCount += after.indexedSeq - old.indexedSeq
        advancing.push({ meta: snapshot.index.sessions[index], after })
      }
    }
    report.changes.missingFiles = [...before.keys()].filter(key => !current.has(key)).length
    const actualRoot = await realpath(sessionsRoot)
    for (const { meta, after } of advancing) {
      try {
        if (!isAbsolute(meta.file) || !inside(sessionsRoot, meta.file)) throw error('ENATURALSOURCEPATH')
        const actual = await realpath(meta.file)
        if (!inside(actualRoot, actual)) throw error('ENATURALSOURCEPATH')
        const info = await stat(actual)
        if (info.isFile() && info.size === after.size && info.mtimeMs === after.mtimeMs && info.ctimeMs === after.ctimeMs) report.changes.advancedSourceStatMatched++
        else report.changes.advancedSourceStatMismatched++
      } catch { report.changes.advancedSourceUnavailable++ }
    }

    report.samples = { postBaselineStatusSamples: 0, matchingDeltaStatusSamples: 0, distinctQualifyingDeltaReports: 0,
      excludedNewOrFullOrFallbackSamples: 0, qualifyingDeltaParsed: 0, qualifyingDeltaBytes: 0 }
    report.distinctQualifyingReports = []
    const numericReportFields = ['totalFiles', 'processed', 'fullParsed', 'deltaParsed', 'deltaFallbacks', 'ftsSynced',
      'ftsFailed', 'readBytes', 'decodedBytes', 'deltaBytes', 'discoveredBytes', 'durationMs', 'maxEventLoopDelayMs']
    const unique = new Set()
    for (const row of log.rows.filter(row => row.start >= baseline.logOffset && Date.parse(row.value.time) > Date.parse(baseline.latestHostSampleTime))) {
      report.samples.postBaselineStatusSamples++
      const status = row.value.status, last = status?.lastReport
      // A force build disables delta; headParsed>0/added>0 also excludes first
      // parse and mixed full builds. Require an idle, committed successful report.
      const qualifies = ready(row.value) && status.updatedAt > baseline.hostIndexUpdatedAt &&
        last?.status === 'completed' && last.deltaParsed > 0 && last.deltaFallbacks === 0 && last.deltaBytes > 0 &&
        last.ftsFailed === 0 && last.failed === 0 && last.raced === 0 && last.added === 0 && last.headParsed === 0 &&
        last.fullParsed === last.deltaParsed && last.updated >= last.deltaParsed && last.ftsSynced >= last.deltaParsed
      if (!qualifies) { report.samples.excludedNewOrFullOrFallbackSamples++; continue }
      report.samples.matchingDeltaStatusSamples++
      const key = hash(JSON.stringify({ updatedAt: status.updatedAt, lastReport: last }))
      if (!unique.has(key)) {
        unique.add(key); report.samples.distinctQualifyingDeltaReports++
        report.samples.qualifyingDeltaParsed += last.deltaParsed
        report.samples.qualifyingDeltaBytes += last.deltaBytes
        report.distinctQualifyingReports.push(Object.fromEntries(numericReportFields
          .filter(field => number(last[field])).map(field => [field, last[field]])))
      }
    }
    const finalLog = await hostLog()
    report.finalHostReady = aligned(finalLog, snapshot)
    report.latestHostSampleTime = finalLog.latest.value.time
    report.latestHostSampleKey = hash(JSON.stringify(finalLog.latest.value))
    report.jsonStableDuringCapture = hash(await readFile(join(productionData, 'index.json'))) === snapshot.bytesHash
    report.naturalDeltaEvidenceSatisfied = report.finalHostReady && report.jsonStableDuringCapture && cp.allMetadataConverged &&
      report.samples.distinctQualifyingDeltaReports > 0 && report.changes.existingBytesAndSeqAdvanced > 0 &&
      report.changes.advancedSourceStatMatched === report.changes.existingBytesAndSeqAdvanced &&
      ['newFiles', 'missingFiles', 'sessionIdentityChanged', 'generationChanged', 'bytesRegressed', 'seqRegressed',
        'advancedSourceStatMismatched', 'advancedSourceUnavailable'].every(key => report.changes[key] === 0)
  }
  report.scriptSucceeded = true
} catch (caught) {
  report.error = { name: typeof caught?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(caught.name) ? caught.name : 'Error',
    code: typeof caught?.code === 'string' && /^[A-Z][A-Z0-9_]{0,60}$/.test(caught.code) ? caught.code : 'UNSPECIFIED' }
}

const filename = `NATURAL_DELTA_${report.mode ?? 'error'}_${report.generatedAt.replace(/[^0-9]/g, '')}_${randomUUID()}.json`
try {
  await writeFile(join(evidenceRoot, filename), JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  // Baseline entries remain only in the E report; do not print even hashed identities.
  const { entries, ...summary } = report
  console.log(JSON.stringify(summary))
  if (!report.scriptSucceeded) process.exitCode = 1
  else if (report.mode === 'compare' && !report.naturalDeltaEvidenceSatisfied) process.exitCode = 2
} catch {
  console.error(JSON.stringify({ generatedAt: report.generatedAt, scriptSucceeded: false, reportWriteFailed: true }))
  process.exitCode = 1
}
