// E-only final evidence/documentation update. No host control or production writes.
import { createHash, randomUUID } from 'node:crypto'
import { readFile, writeFile, copyFile, mkdir, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join, relative, isAbsolute, sep } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const evidence = join(root, 'DEPLOYMENT_RESULTS')
const approved = 'a7ebe5aa640c1b37c2be8f122bd5f4968af802838d46231099e835c60a800ffb'
const candidate = join(root, 'release', 'S6-20261002')
const runtime = 'G:\\AI-Agent\\deepseek harness\\dsh-session-index'
const refs = {
  naturalBaseline: 'NATURAL_DELTA_baseline_20261002103637147_0ed09737-f6c1-43a1-8dc4-f5b669947888.json',
  naturalCompare: 'NATURAL_DELTA_compare_20261002103921020_0404482b-169a-4ce0-b57b-97c3723a2aad.json',
  naturalNumericClosure: 'NATURAL_DELTA_NUMERIC_CLOSURE_1790938013112_e42973c9-a4ca-40f7-abb2-1179b5a6186e.json',
  afterNaturalAudit: 'LIVE_DB_AUDIT_20261002104155023_820f23ca-4b2e-4053-a456-4108caba4c4a.json',
  afterOrdinaryStartupAudit: 'LIVE_DB_AUDIT_20261002104631934_e6fb0df3-8094-4cbe-91ec-8bdc74c041e0.json',
  fullIntegrity: 'LIVE_TEST_FULL_QUICK_CHECK_MMAP_1790936152430_9a389ab3-e31c-47d8-abed-cd7b070248e3.json',
  ordinaryStop: 'LIVE_TEST_ORDINARY_STOP_e421b6da7b0848f09e260018d3f049d3.json',
  ordinaryStart: 'LIVE_TEST_ORDINARY_START_7c9244b9db8e4ca3a3e1d36006be3ed9.json',
  ordinaryProcess: 'LIVE_TEST_ORDINARY_PROCESS_VERIFICATION_57df6ccbd175439ea853f8bc9ef067e3.json',
  ordinaryApiBoundary: 'LIVE_TEST_ORDINARY_API_AUTH_BOUNDARY_02a1b2e2211a4c2ab080fd604091f6f4.json',
}
const hashBytes = value => createHash('sha256').update(value).digest('hex')
const hashFile = async path => hashBytes(await readFile(path))
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const check = (condition, name) => { if (!condition) throw new Error('Final evidence guard failed: ' + name) }
const safeJoin = (base, file) => {
  const path = resolve(base, file), part = relative(base, path)
  check(part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part), 'relative manifest path')
  return path
}
const manifest = await json(join(candidate, 'SHA256.json'))
check(await hashFile(join(candidate, 'SHA256.json')) === approved, 'approved manifest unchanged')
check(Object.keys(manifest).length === 96, 'candidate file count')
for (const [file, expected] of Object.entries(manifest)) check(await hashFile(safeJoin(candidate, file)) === expected, 'immutable candidate ' + file)
const deployed = Object.entries(manifest).filter(([file]) => file.startsWith('lib/') || ['package.json','README.md','README_zh.md'].includes(file))
check(deployed.length === 69, 'deployed file count')
for (const [file, expected] of deployed) check(await hashFile(safeJoin(runtime, file)) === expected, 'approved deployed ' + file)
const sourceHashes = await json(join(candidate, 'SOURCE_SHA256.json'))
for (const [file, expected] of Object.entries(sourceHashes)) check(await hashFile(safeJoin(root, file)) === expected, 'implementation source preserved ' + file)

const values = Object.fromEntries(await Promise.all(Object.entries(refs).map(async ([key, file]) => [key, await json(join(evidence, file))])))
const assertAudit = (audit, name) => {
  check(audit.auditSucceeded && audit.json.unchangedDuringAudit && audit.database.queryOnly && audit.database.schemaVersion === 5, name + ' snapshot')
  check(audit.database.sessions === 331 && audit.database.messages === 47092 && audit.database.checkpoints === 331 && audit.database.chunks === 47870, name + ' final counts')
  check(audit.checkpoints.fullyConvergedEntries === 331 && audit.checkpoints.candidateNeedsSyncEntries === 0 && audit.sources.unchanged === 331, name + ' convergence')
  check(audit.database.orphanSessionsToJson === 0 && audit.database.orphanMessageSourcesToSessions === 0 && audit.database.orphanChunks === 0, name + ' orphan counts')
  check(audit.bookmarks.zeroBytes && audit.bookmarks.hashMatchesDeploymentSnapshot && audit.bookmarks.hashUnchangedDuringAudit && audit.legacyCIndexAbsent && audit.deployed.all69Match, name + ' preservation')
}
assertAudit(values.afterNaturalAudit, 'after natural append')
assertAudit(values.afterOrdinaryStartupAudit, 'after ordinary startup')
check(values.naturalCompare.naturalDeltaEvidenceSatisfied && values.naturalCompare.finalHostReady && values.naturalCompare.checkpoints.matched === 331, 'natural evidence')
check(values.fullIntegrity.fullQuickCheck.passed && values.fullIntegrity.fullQuickCheck.fullCheck && values.fullIntegrity.fullQuickCheck.errorCount === 0, 'full integrity')
check(values.ordinaryStop.stopped && !values.ordinaryStop.forceTerminationUsed && !values.ordinaryStart.argumentListProvided && !values.ordinaryStart.diagnosticEnvironmentPresent, 'ordinary startup')
const ordinary = values.ordinaryProcess
check(ordinary.mainExecutableMatched && ordinary.actualHostCount === 1 && ordinary.hostMatchesDesktopProfile && ordinary.onlyActualHostListener && ordinary.desktopJunctionTargetMatched, 'ordinary host identity')
check(!ordinary.mainDiagnosticFlagsPresent && !ordinary.anyChildDiagnosticFlagsPresent && ordinary.noDiagnosticEnvironment && ordinary.oldDiagnosticsLogStopped && !ordinary.oldMainPresent && !ordinary.oldHostPresent, 'temporary diagnostics stopped')

const rows = (await readFile(join(evidence, 'host-diagnostics.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
const hostRows = rows.filter(row => row.pid === 15916)
const latestStatus = hostRows.findLast(row => row.type === 'status')
const registrations = hostRows.findLast(row => row.type === 'registrations')
const search = hostRows.findLast(row => row.type === 'full-search')
check(registrations.tools.length === 5 && registrations.tools.every(tool => tool.registered && tool.hasOutputSchema && tool.hasOutputRender), 'actual tool registrations')
check(search.hitCount === 5 && search.contentWithAnchor === 5 && search.anchorIdentityChecked === 2 && search.anchorIdentityPassed === 2 && search.coverageComplete && search.failedSourceCount === 0, 'actual search and anchors')
const health = latestStatus.status.ftsHealth
check(latestStatus.status.fts && health.ok && health.schemaVersion === '5' && health.worker.workerReady && health.worker.readerReady && !health.worker.degraded, 'actual worker health before ordinary restore')
check(health.dirtySessions === 0 && health.pendingWrites === 0 && health.failedSessions === 0, 'actual FTS convergence before ordinary restore')

const completedAt = new Date().toISOString()
const archive = join(evidence, 'history-before-live-final-' + randomUUID())
await mkdir(archive)
const archiveFiles = ['DEPLOYMENT_RESULTS.txt','IMPLEMENTATION_STATUS.txt','RELEASE_READINESS.txt','HANDOFF_S6_S7.txt','DEPLOYMENT_RUNBOOK.txt','DEPLOYMENT_RESULTS/S7_STATE.json','DEPLOYMENT_RESULTS/DEPLOYMENT_RESULTS.json','PATCHES/S7/manifest.json']
for (const file of archiveFiles) await copyFile(join(root, file), join(archive, file.replaceAll('/', '__')))
const state = await json(join(evidence, 'S7_STATE.json'))
check(state.candidateManifestSha256 === approved, 'existing state candidate')
state.phase = 'complete-with-recorded-runtime-limitations'
state.completedAt = completedAt
state.userSteering = '开始实测吧；用户在基线之后正常续写并收到回复'
state.liveAcceptance = {
  status: 'approved S7 deployment and actual-host acceptance completed; runtime limitations retained',
  completedAt,
  actualHostLoaded: { hostPid: 15916, inventoryEnabled: true, inventoryFiberPhase: 'active', runtimeVersion: '0.0.3-rc.1', fiveToolsRegistered: true },
  workerHealthBeforeOrdinaryRestore: { observedAt: latestStatus.time, hostPid: 15916, fts: true, schemaVersion: 5,
    workerReady: true, readerReady: true, degraded: false, dirtySessions: 0, pendingWrites: 0, failedSessions: 0,
    restarts: health.worker.restarts, lastTransportErrorPresent: health.worker.lastTransportErrorPresent },
  schema5Upgrade: { oldSchema: 2, upgradedWithSameApprovedSessionFtsOffline: true, beforeMessages: 47089,
    finalMessages: 47092, sessions: 331, checkpoints: 331, finalCheckpointConvergence: 331, finalChunks: 47870 },
  fullIntegrity: { passed: true, fullQuickCheck: true, durationMs: 322103, errorCount: 0,
    observedBeforeHostBackfillAndNaturalAppend: true, nonDatabaseSidecarsPreservedAtThatPoint: true },
  productionSearch: { query: 'session', role: 'assistant', hitCount: 5, contentWithAnchor: 5,
    completeCoverage: true, failedSourceCount: 0, firstSearchAndTwoScrollApproximateSeconds: 76,
    transportRecoveriesDuringThatSequence: 2, queryBackendNotIndependentlyRecorded: true },
  productionScroll: { checked: 2, stableAnchorIdentityPassed: 2, existingBookmarkJump: 'not applicable: actual production bookmarks were zero' },
  naturalDelta: { userNormalAppend: true, existingFiles: 331, filesAdvanced: 1, compressedBytesAdvanced: 19669,
    eventSeqAdvanced: 14, messageCountAdvanced: 3, qualifiedDeltaReports: 2, qualifiedDeltaReadBytes: [239,1167],
    fullFallbackReports: 1, fullFallbackReadBytes: 116384, totalObservedReadBytes: 117790,
    specificFallbackReason: 'unknown from numeric evidence', checkpointsConverged: 331 },
  ordinaryStartupRestore: { completed: true, mainPid: ordinary.mainPid, hostPid: ordinary.hostPid,
    noDebugOrImportFlags: true, noDiagnosticEnvironment: true, diagnosticLogStopped: true,
    profile: 'desktop', listener: '127.0.0.1:19387', freshReadOnlyDatabaseAuditPassed: true,
    freshInventoryAndCtxNotExtracted: true, directUnauthenticatedInventoryHttpStatus: 401,
    boundary: '401 matches the Desktop cookie bridge; previous actual ctx acceptance is retained, ordinary process startup is not represented as a fresh direct ctx health sample' },
  summaryTool: 'registration/schema validated; no LLM invocation performed',
  productionBookmarks: { records: 0, bytes: 0, migrationChanged: false, nonEmptyMigrationNotClaimed: true },
  extraOfflineBackup: 'E:\\Do Something\\DSH备份\\dsh-session-index work\\implementation-session-index\\deployment-backups\\S7-OFFLINE-FTS-2026-10-02T10-04-40-379Z-be4b9b4e-b631-4ce6-b14c-00e22fb4bf79',
  originalHelperTimeout: 'ETIMEDOUT/SIGTERM at 600s during post-upgrade verification; not counted as integrity pass; independent full read-only quick_check passed afterward',
  evidenceReferences: Object.fromEntries(Object.entries(refs).map(([key, file]) => [key, join(evidence, file)])),
  rawDiagnosticLog: join(evidence, 'host-diagnostics.jsonl'),
  historyBeforeFinalization: archive,
}
state.remainingImplementationWorkInAssignedS6S7 = []
state.runtimeLimitations = [
  'Old schema2 startup migration exceeded default 15s FtsClient startup timeout; this installation was upgraded offline with the same approved implementation. The general automatic migration timeout is unchanged.',
  'First actual full query plus two SCROLL calls took approximately76s with two reader transport recoveries; that is a combined cold sequence, not a separately measured query time or a steady-state benchmark.',
  'Natural append included two successful tail deltas and one fallback to full parsing; the precise fallback reason was not observed.',
]
const outputJson = value => JSON.stringify(value, null, 2) + '\n'
await writeFile(join(evidence, 'S7_STATE.json'), outputJson(state))
await writeFile(join(evidence, 'DEPLOYMENT_RESULTS.json'), outputJson(state))

const currentHeader = `当前最终状态（2026-10-02；更新于 ${completedAt} UTC）\n\n本轮分配的 S6–S7 已完成：候选 0.0.3-rc.1 已按明确授权部署，并完成真实宿主工具注册、查询/anchor、自然续写及检查点验收。\n最终 schema5：331 会话、47092 消息、47870 chunks、331 checkpoint 全部收敛；普通启动后只读复核稳定通过。\n插件活动数据/书签/备份在 E；C 旧插件索引已保全搬 E；官方原始会话日志仍在 C 原位。\ndesktop 已优雅退出临时诊断并无参数恢复；main27608/host16488、仅 localhost19387，未留下 inspect/import 或诊断环境。\n实际 ctx/worker 健康证据来自恢复前真实 host15916；普通恢复后的 fresh ctx 未再次提取，普通进程/配置及数据库已另验。\n运行限制：旧库自动迁移的15秒超时未改（本机同版本离线升级恢复）；首次检索加两次SCROLL约76秒并有2次reader恢复；自然续写中间一次回退全量，另外两次尾段读取239/1167B。\n生产书签实际0条；不声称已验证非空生产书签迁移；session_summary仅验证注册，未调用LLM。\n候选清单SHA256仍为 ${approved}；96候选/69运行/22实现源hash保持一致。\n详见 LIVE_TEST_RESULTS.txt、DEPLOYMENT_RESULTS.txt、DEPLOYMENT_RESULTS/S7_STATE.json、PATCHES/S7/manifest.json。\n未push/远端发布，未卸载web；不重复部署/书签迁移/离线升级，不用G旧src build覆盖已验证lib。\n\n以下保留原批准前及曾延后实测的历史文字，只作追溯，不代表当前待办；批准时release目录文件保持不变：\n\n`
for (const file of ['IMPLEMENTATION_STATUS.txt','RELEASE_READINESS.txt','HANDOFF_S6_S7.txt']) {
  const previous = await readFile(join(root, file), 'utf8')
  await writeFile(join(root, file), currentHeader + previous)
}
const previousDeployment = await readFile(join(root, 'DEPLOYMENT_RESULTS.txt'), 'utf8')
await writeFile(join(root, 'DEPLOYMENT_RESULTS.txt'), currentHeader + previousDeployment)
const previousRunbook = await readFile(join(root, 'DEPLOYMENT_RUNBOOK.txt'), 'utf8')
const runbookCurrent = currentHeader + `实际首次升级补充（已执行记录，不是再次执行命令）\n\n首次真实 FtsClient 启动因15秒超时而回滚schema升级。全部共享写方停净后，在E新增完整hash核对快照，\n由 s7-offline-fts-upgrade.mjs 调用已批准G/lib/fts.js直接升级，未修改候选、源日志或唯一旧恢复快照。\ns7-run-offline-upgrade.mjs 的600秒wrapper在升级后quick_check阶段超时，报告ETIMEDOUT/SIGTERM，不能记为成功。\n之后独立完整只读quick_check（连接局部mmap512MiB）322103ms通过，并核对4个非DB sidecar未变；\n真实宿主再启动完成回填、只读查询与自然续写；最后两次独立只读审计分别在续写后与普通恢复后证实331CP一致。\n这些补充属于用户已批准的备份/派生schema升级/宿主恢复范围，完整故障与恢复证据保留在DEPLOYMENT_RESULTS。\n备份及lib.before均继续保全。以后若再次部署或回滚，重新核对当前授权对象与最新用户数据，不照抄本次已执行步骤。\n\n` + previousRunbook
await writeFile(join(root, 'DEPLOYMENT_RUNBOOK.txt'), runbookCurrent)
const compact = { completedAt, phase: state.phase, candidateManifestSha256: approved,
  verifiedCandidateFiles: 96, verifiedRuntimeFiles: 69, verifiedImplementationSourceFiles: Object.keys(sourceHashes).length,
  liveAcceptance: state.liveAcceptance, runtimeLimitations: state.runtimeLimitations,
  report: join(root, 'LIVE_TEST_RESULTS.txt'), noPush: true, noWebUninstall: true }
await writeFile(join(evidence, 'LIVE_TEST_FINAL_SUMMARY.json'), outputJson(compact), { flag: 'wx' })

// The manifest records E-only operations/evidence; this does not issue a new candidate.
const operationFiles = (await readdir(join(root, 'scripts'))).filter(file => /^(?:s7-.*\.(?:mjs|ps1)|finalize-s7-.*\.mjs)$/.test(file)).map(file => 'scripts/' + file)
const reportFiles = ['LIVE_TEST_RESULTS.txt','DEPLOYMENT_RESULTS.txt','IMPLEMENTATION_STATUS.txt','RELEASE_READINESS.txt','HANDOFF_S6_S7.txt','DEPLOYMENT_RUNBOOK.txt',
  'DEPLOYMENT_RESULTS/S7_STATE.json','DEPLOYMENT_RESULTS/DEPLOYMENT_RESULTS.json','DEPLOYMENT_RESULTS/LIVE_TEST_FINAL_SUMMARY.json',
  'DEPLOYMENT_RESULTS/legacy-c-relocation.json','DEPLOYMENT_RESULTS/LIVE_TEST_OFFLINE_STOP.json','DEPLOYMENT_RESULTS/LIVE_TEST_OFFLINE_INVOCATION.json','DEPLOYMENT_RESULTS/host-diagnostics.jsonl',
  ...Object.values(refs).map(file => 'DEPLOYMENT_RESULTS/' + file)]
const operationManifest = Object.fromEntries(await Promise.all([...new Set([...operationFiles,...reportFiles])].sort().map(async file => [file, await hashFile(join(root, file))])))
await writeFile(join(root, 'PATCHES', 'S7', 'manifest.json'), outputJson({ scope: 'S7 approved deployment and completed actual-host acceptance evidence; no additional candidate implementation changes',
  generatedAt: completedAt, candidateManifestSha256: approved, immutableCandidateFilesVerified: 96, deployedRuntimeFilesVerified: 69,
  phase: state.phase, historyBeforeFinalization: archive, operationManifest, runtimeLimitations: state.runtimeLimitations }))
console.log(JSON.stringify({ completedAt, phase: state.phase, immutableCandidateFilesVerified: 96, runtimeFilesVerified: 69,
  sourceFilesVerified: Object.keys(sourceHashes).length, finalSessions: 331, finalMessages: 47092, finalCheckpoints: 331,
  naturalDeltaReports: 2, fullFallbackReports: 1, ordinaryMainPid: ordinary.mainPid, ordinaryHostPid: ordinary.hostPid,
  evidenceManifestFiles: Object.keys(operationManifest).length, historyArchived: archive, noProductionWrites: true }))
