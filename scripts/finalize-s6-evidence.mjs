/** Consolidate actual S6 evidence, preserving earlier handoffs and failure logs. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const batches = ['s6-integration', 's6-user-flow', 's6-final-candidate-workflow', 's6-production-migration-cli']
const results = batches.map(label => {
  const log = readFileSync(`TEST_RESULTS/${label}.txt`, 'utf8')
  const number = field => Number(new RegExp(`(?:ℹ|#) ${field} (\\d+)`).exec(log)?.[1])
  const result = { label, tests: number('tests'), pass: number('pass'), fail: number('fail'),
    skipped: number('skipped'), cancelled: number('cancelled'), execution: json(`TEST_RESULTS/${label}.json`),
    logSha256: hash(`TEST_RESULTS/${label}.txt`) }
  assert.equal(result.execution.exitCode, 0); assert.ok(result.tests > 0)
  assert.equal(result.tests, result.pass); assert.equal(result.fail + result.skipped + result.cancelled, 0)
  return result
})
const checks = ['s6-final-typecheck', 's6-final-contract', 's6-corrected-test-compile', 's6-final-build', 's6-final-candidate-flow', 's6-final-migration', 's6-cli-test-compile']
for (const label of checks) assert.equal(json(`TEST_RESULTS/${label}.json`).exitCode, 0)
const migration = json('MIGRATION_DRY_RUN.json')
assert.equal(migration.status, 'passed'); assert.equal(migration.checkCount, 13)
const protection = json('TEST_RESULTS/s6-final-protection.json')
assert.equal(protection.runtimeDifferences.length + protection.sourceDifferences.length, 0)
const issues = [
  ['01', 'LIKE OR 范围过滤', 'src/fts.ts', 'fts-filter-safety', 'OR各词整体受workspace/role/时间约束'],
  ['02', 'FTS原子替换与恢复', 'src/fts.ts; src/session-index-builder.ts; src/index.ts', 'fts-recovery; builder-fts-sync; index-fts-recovery', '故障保留旧正文/checkpoint，dirty重试，独立进程SQL锁竞争'],
  ['03', '稳定消息锚点', 'src/message-anchor.ts; src/bookmark.ts', 'session-message-contract; stage-search-integration; s6-release-flow', 'generation0..4；delta/force/restart/删派生副本重建后书签仍可用'],
  ['04', '跨进程书签互斥', 'src/sidecar.ts; src/bookmark.ts', 'bookmark-multiprocess', 'rename barrier交错add/remove、owner崩溃/活锁/旧token'],
  ['05', '完整正文覆盖', 'src/streaming-parser.ts; src/fts.ts', 'fts-message-contract; session-message-contract; s6-release-flow', '头中尾、跨块AND、Unicode、长词、50k与正文预算明确诊断'],
  ['06', 'lineage代表元组', 'src/index.ts', 'stage-search-integration; rank-integration', '实际sessionId/file/workspace/anchor/snippet/rank同源'],
  ['07', '不完整扫描保护', 'src/core.ts; src/session-index-builder.ts', 'scan-safety', '根/子树/stat失败/cap保留旧索引；完整空目录确认删除'],
  ['08', '启动/监听指纹对账', 'src/index.ts; src/watcher.ts', 'index; reconcile-same-size; watcher', '停机追加、等量替换、同大小改写、watch失败/迟到初始化'],
  ['09', '会话级召回', 'src/fts.ts; src/index.ts', 'fts-message-contract; rank-integration', '40/500重复消息不挤掉其他会话；totalExact/hasMore'],
  ['10', 'role和多词口径', 'src/query-plan.ts; src/session-worker.ts; src/worker-pool.ts', 'session-message-contract; stage-search-integration', 'role截断前过滤；原消息AND；全局零AND才OR；FTS开关一致'],
  ['11', 'SCROLL会话内窗口', 'src/fts.ts', 'fts-message-contract; s6-release-flow', 'A/B/A穿插按会话前后N原消息；错误session/过期锚点拒绝'],
  ['12', '来源顺序', 'src/streaming-parser.ts; src/session-compat.ts', 'session-message-contract; s6-release-flow', 'fold后按来源seq排序；full/delta user→tool→assistant一致'],
  ['13', '实际增量尾段I/O', 'src/native-zstd.ts', 'native-zstd; s6-release-flow', '实际读取/分配尾帧；1/16/64MiB前缀15次均32B（继承S5基准）'],
  ['14', 'SQLite后台worker', 'src/fts-client.ts; src/fts-worker.ts; src/fts-spool.ts', 'fts-client', '有界RPC/背压/错误/重启/关闭；S5五轮max gap≤100ms与50k压力继承'],
].map(([id, problem, implementation, tests, behavior]) => ({ id: `#${id}`, status: 'closed', problem, implementation, tests, behavior,
  currentEvidence: 'TEST_RESULTS/s6-integration.txt and s6-user-flow.txt as applicable',
  patch: 'PATCHES/S6/FULL-S0-S6.patch; preserved PATCHES/S3-S5/manifest.json and PATCHES/FULL-S0-S2.patch' }))
const summary = { generatedAt: new Date().toISOString(), scope: 'S6 isolated validation and S7 reviewable preparation',
  candidate: 'release/S6-20261002', version: '0.0.3-rc.1', sourceHead: '70800ed7be77b31527a955ea2f6cc6a750dafef8',
  tests: results.reduce((total, row) => total + row.tests, 0), results, checks, issues,
  inheritedEvidence: { sourceFilesMatched: protection.sourceFiles, historicalTests: 'TEST_RESULTS/S3-S5_VALIDATION.json (151; not counted as current executions)',
    performance: 'BENCHMARK_RESULTS/S3-S5_PERFORMANCE.json', reason: 'All 22 src hashes match; no runtime implementation changed in S6',
    worstSteadyMaxGapMs: 31.949, improvementAgainstAuditPercent: 97.335, actualTailBytesAcross15Runs: 32,
    limitation: 'Host heartbeat benchmark, not desktop UI latency; full text writes slower; transport budget is not RSS ceiling' },
  migration: { scope: migration.scope, checkCount: migration.checkCount, schema: '2→5', counts: migration.bookmarkMigration.dryRun.counts,
    unresolvedPhysicalMessageRecords: 6, productionCounts: 'unknown; not read' },
  correctedFailure: { log: 'TEST_RESULTS/s6-final-test-compile.txt', reason: 'New S6 fixture omitted required maxSnippetsPerSession config; supplied field and recompiled without changing runtime/test assertions' },
  runtimeProtection: 'TEST_RESULTS/s6-final-protection.json', productionDataRead: false, productionDataWritten: false,
  s7: { status: 'awaiting-specific-candidate-approval', deployed: false, restarted: false, pushed: false } }
writeFileSync('TEST_RESULTS/S6_VALIDATION.json', JSON.stringify(summary, null, 2) + '\n')
const matrix = issues.map(row => `${row.id} 已关闭：${row.problem}\n实现：${row.implementation}\n回归：test/${row.tests.split('; ').join('.test.ts; test/')}.test.ts\n行为：${row.behavior}\n下一步：候选获批后S7生产验收，不重复实施。`).join('\n\n')
const status = `DSH session-index 当前实施状态（2026-10-02，S6最终候选；S7待具体授权）\n\n本轮仅推进S6–S7范围，未重做S0–S5。\nS0–S6已完成：14项关闭证据逐项核对，当前${summary.tests}次测试执行全部通过，13项候选迁移演练通过。\nS7：候选/运行范围/runbook已具体化，生产部署、生产迁移、宿主停止/重启尚未获此候选授权，因此未执行。\n工作树 E:\\Do Something\\DSH备份\\dsh-session-index work\\implementation-session-index\n分支 review/session-index-hardening；HEAD/基线70800ed7be77b31527a955ea2f6cc6a750dafef8；未提交diff、未push。\n候选0.0.3-rc.1：release/S6-20261002（CANDIDATE.json、SHA256.json、SOURCE_SHA256.json）。\n代码：FTS schema5，bookmarks v2兼读v1，parser checkpoint session-index/2，anchorId与rowid分离。\n书签是用户数据；旧numeric不是seq，缺证据的6条合成消息定位保留未解；生产数量未知。\n\n关闭矩阵（当前状态覆盖旧交接中的“待S3/S4/S5”历史文字）\n${matrix}\n\n验证与证据\nTEST_RESULTS/S6_VALIDATION.json：当前测试/环境/13项迁移/原始失败与精准修复。\nBENCHMARK_RESULTS/S3-S5_PERFORMANCE.json：继承22文件相同SHA的S5性能，未重复跑基准。\nPATCHES/S6：独立FULL-S0-S6与按原S0–S5后应用的S6增量，均fresh clone重放核验。\nRELEASE_READINESS.txt：候选边界；DEPLOYMENT_RUNBOOK.txt：具体部署/迁移/备份/回滚；HANDOFF_S6_S7.txt：接续。\nG区68个src/lib SHA、HEAD/status与desktop junction不变；生产数据未读取/修改，未重启宿主。\n旧S0–S2、S3–S5交接文件/补丁/失败日志原样保留，不将历史通过算成本轮执行。\n`
writeFileSync('IMPLEMENTATION_STATUS.txt', status.replace('parser checkpoint session-index/2', 'parser checkpoint session-index/3-chunks'))
const readiness = `DSH session-index 发布准备（2026-10-02 Asia/Hong_Kong）\n\n结论：S6候选完成；S7生产发布未执行，等待指定候选与具体高风险范围的确认。\n候选ID session-index-0.0.3-rc.1-S6-20261002\n候选目录 E:\\Do Something\\DSH备份\\dsh-session-index work\\implementation-session-index\\release\\S6-20261002\n清单 CANDIDATE.json + SHA256.json（manifest自身SHA在CANDIDATE中）+ SOURCE_SHA256.json。\n基线70800ed7be77b31527a955ea2f6cc6a750dafef8；S0–S6未提交diff，全量/分阶段审查补丁；未push。\n\n关闭与实际验证\n14项全部关闭，逐项实现/正确行为回归见 IMPLEMENTATION_STATUS.txt 和 TEST_RESULTS/S6_VALIDATION.json。\n本轮${summary.tests}次测试执行全部通过、没有skip/cancel：19文件集成159项、新用户流程1项、候选lib/worker同流程1项、生产迁移CLI ${results.at(-1).tests}项。\n同一流程对源码编译与最终候选各跑一次，计入执行次数；不宣称都是不同断言。\n类型检查、锁定DSH契约、测试编译、隔离候选编译通过。首次新测试配置缺字段编译错误已保留，补字段后精准重编通过。\n真实流程：generation0..4合成日志→build→跨块及跨消息语义→书签→自然delta→force→restart→删本次派生FTS副本→重建→书签SCROLL。\n另覆盖独立进程书签/SQL锁竞争、事务故障、扫描失败/cap、同数量/同大小改写、卸载重载、v0/v1/v2/v3/v4门禁。\n测试显式DSH_HOME/TEMP/TMP/dataDir/sessionsRoot隔离；LLM关闭/fake；未读取生产会话。\n\n迁移\n最终候选lib运行13项schema2→5/字段和行序保留/回滚重试/书签干预恢复演练，全通过。\n10合成物理书签：resolved2/unresolved3/ambiguous1/session-missing1/anchor-replaced1/session1/alreadyMigrated1。\n6条未恢复消息定位原记录全部保留；numeric缺稳定身份证据、歧义、缺会话或anchor已替换，不猜映射。\n这些是合成统计；生产总数/可恢复数未知。生产显式CLI默认dryRun、readOnly证据库，不先升级/重建毁掉旧证据。\n\n性能与边界\n22个src SHA与S3–S5最终源码相同，沿用已有低负载独立5轮冷/稳态基准，不与本轮测试并跑。\nsteady最大heartbeat gap 19.9693..31.9490ms，全≤100ms，最差相对审查1199ms降低97.335%。\n1/16/64MiB前缀各5轮，32B尾帧实际read/压缩输入allocation均32B。\n50k压力失败回滚/成功原子切换、875读查询、最慢133.7911ms证据见S5汇总。\n正文/chunk写入总时长增加；心跳是宿主进程观测，不保证desktop UI延迟。RSS不是8MiB队列上限，active正文单独有64MiB/source预算。\n正文采集50k消息/64MiB，默认单行4MiB/总解压256MiB，显式原文补查单行4..32MiB；coverage/sourceLimits回显限制。\n原始ID可稳定；无ID的fallback受generation+seq+证据约束，不能宣称跨格式无损定位。\n实测Node v24.16.0、DSH0.2.0-rc.2、Cordis4.0.4、Schemastery3.18.4；peer范围不是跨版本测试证据。\n未接桌面原生搜索provider，仍是五个模型工具。\n\n交付与保护\n候选含lib/types/两worker/package/README/LICENSE/锁文件/portable cordis patch/用户配置审查副本/迁移CLI/审查补丁。\n用户绝对E盘dataDir只放deployment/cordis.patch.user.yml，portable默认patch无该路径，不部署覆盖现有profile配置。\nnode_modules不打包；使用已核验兼容运行依赖。原S0–S2/S3–S5补丁未覆盖。\nTEST_RESULTS/s6-final-protection.json核对G 68个原src/lib hash、HEAD、干净status和desktop junction仍一致。\n\nS7具体动作与回滚\n按 DEPLOYMENT_RUNBOOK.txt 核实desktop为主要端，web保留；共享取决profile配置。停全部共享写方→完整离线数据/运行码快照→旧证据dryRun/apply→候选切换→授权宿主重启→生产只读工具/书签/进度验收→一次自然增量观察。\n不先force/delete生产FTS、不删现有资源、不安装或改用户依赖、不自动push/远端发布。\n回滚先保全上线后的全部书签；有新用户数据不能盲目用旧备份覆盖，旧版本无法表达的新anchor记录另行保全并审查兼容方案。\n宿主可靠停写/恢复入口仍须现场确认；当前未声称已部署或已生产验收。\n授权要求来自用户提供的AGENTS.md高风险动作边界及EXECUTION_PLAN S7候选确认步骤。\n`
writeFileSync('RELEASE_READINESS.txt', readiness)
writeFileSync('HANDOFF_S6_S7.txt', `DSH session-index S6–S7接续（2026-10-02）\n\nS6完成，S7具体候选待批准；不要重新实施S0–S5，不从旧0.0.1/origin/main开始。\n工作树 E:\\Do Something\\DSH备份\\dsh-session-index work\\implementation-session-index；分支review/session-index-hardening；HEAD70800ed7be77b31527a955ea2f6cc6a750dafef8。\n候选release/S6-20261002，0.0.3-rc.1；SHA256.json/CANDIDATE.json锁定授权对象。\n${summary.tests}次测试执行、13迁移检查通过；最初配置编译错误及修正证据均保留。\n所有22源SHA相同，S5基准继承，当前FTSschema5/书签v2/anchor协议未再改。\n所有14项矩阵见 IMPLEMENTATION_STATUS；验证TEST_RESULTS/S6_VALIDATION；README两版已更新；候选全量/增量补丁replay通过。\nS7尚未读写生产数据、未部署、未改junction/宿主、未push。本轮用户说明desktop主要使用，web以后可能卸载，pluginlab不确定；这不授权本轮卸载web。\n下一步：获批具体候选+DEPLOYMENT_RUNBOOK中的运行切换/完整一致备份/生产迁移/停写重启/只读验收后，执行S7并保存新DEPLOYMENT_RESULTS记录；上线后书签不能被旧快照回滚覆盖。\nS7自然增量若尚无真实追加，标待观察，不能凭force假称生产完成。\n`)
console.log(JSON.stringify({ tests: summary.tests, issues: issues.length, migrationChecks: migration.checkCount, status: summary.s7.status }))
