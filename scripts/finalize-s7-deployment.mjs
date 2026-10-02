/** Record deployed artifacts and the user's explicit deferral of live acceptance. No host/SQL actions. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile, mkdir, access, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = resolve('.'), results = join(root, 'DEPLOYMENT_RESULTS')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const state = await readJson(join(results, 'S7_STATE.json'))
assert.equal(state.runtimeVersion, '0.0.3-rc.1')
assert.equal(state.phase, 'code-deployed-awaiting-host-acceptance')
const hashes = await readJson(join(state.candidate, 'SHA256.json'))
const deployed = Object.fromEntries(Object.entries(hashes).filter(([file]) => file.startsWith('lib/') || ['package.json', 'README.md', 'README_zh.md'].includes(file)))
for (const [file, expected] of Object.entries(deployed)) assert.equal(await sha(join(state.runtime, file)), expected, file)
assert.equal(await sha(join(state.candidate, 'SHA256.json')), state.candidateManifestSha256)
const oldSourceManifest = await readJson('TEST_RESULTS/runtime-baseline-hashes.json')
const sourceDifferences = []
for (const row of oldSourceManifest.filter(row => /[\\/]src[\\/]/.test(row.Path))) if ((await sha(row.Path)).toUpperCase() !== row.Hash.toUpperCase()) sourceDifferences.push(row.Path)
assert.equal(sourceDifferences.length, 0)
const relocation = await readJson(join(results, 'legacy-c-relocation.json'))
assert.equal(relocation.hashesVerified, true); assert.equal(relocation.sourceStillPresent, false)
assert.equal(await sha(join(state.productionData, 'bookmarks.jsonl')), state.dataBefore['bookmarks.jsonl'].sha256)
const junction = 'C:\\Users\\admin\\.dsh\\profiles\\desktop\\node_modules\\@dsh-external\\dsh-session-index'
assert.equal((await realpath(junction)).toLowerCase(), state.runtime.toLowerCase())
const git = args => { const r = spawnSync('git', args, { cwd: state.runtime, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0); return r.stdout.trim() }
state.phase = 'deployed-live-acceptance-deferred-by-user'
state.userSteering = '实测再等等，先部署'
state.finalizedAt = new Date().toISOString()
state.deployedFilesVerified = Object.keys(deployed).length
state.sourceDifferences = sourceDifferences
state.runtimeHead = git(['rev-parse', 'HEAD'])
state.runtimeStatus = git(['status', '--short']).split('\n').filter(Boolean)
state.legacyCRelocation = relocation
state.dataLocation = { activePluginDataDir: state.productionData, backups: state.backup,
  legacyCIndexArchivedAt: relocation.destination, originalOfficialSessions: 'C:\\Users\\admin\\.dsh\\sessions',
  scope: 'Plugin derived/user sidecars moved to E; official DSH session logs preserved at their existing source root.' }
state.liveAcceptance = { status: 'deferred-by-user', actualHostLoaded: 'unverified', schema5Upgrade: 'pending-first-confirmed-load',
  productionSearch: 'deferred', productionScroll: 'deferred (zero production bookmarks)', naturalDelta: 'deferred',
  diagnosticAttempt: 'Desktop startup attempt produced no confirmed host-context/ready evidence; not counted as a pass.',
  transientNodeOptions: 'Task shell restored original NODE_OPTIONS; no persistent environment or installed ASAR changes.' }
await writeFile(join(results, 'S7_STATE.json'), JSON.stringify(state, null, 2) + '\n')
await writeFile(join(results, 'DEPLOYMENT_RESULTS.json'), JSON.stringify(state, null, 2) + '\n')
const report = `DSH session-index S7部署记录（2026-10-02 Asia/Hong_Kong）\n\n结论：候选0.0.3-rc.1已部署；用户最新要求“实测再等等，先部署”，真实宿主/生产实测延后。\nS6已完成；S7的部署阶段已完成，整个S7生产验收未标完成。\n\n批准与版本\n用户批准具体候选session-index-0.0.3-rc.1-S6-20261002，清单SHA256 ${state.candidateManifestSha256}。\n另明确批准C旧索引保全搬到E。部署后没有改候选内容；最后${state.deployedFilesVerified}个运行文件SHA与候选一致。\n运行目录 ${state.runtime}\n候选目录 ${state.candidate}\n改动为lib完整目录（含worker/types）、package.json、README.md、README_zh.md。\n没有改junction、profile配置、运行依赖或G/src；G/src保持原基线。后续不要用G旧src直接build覆盖候选lib；实际候选src与FULL-S0-S6审查补丁在E实施树。\nHEAD ${state.runtimeHead}；本轮没有commit/push或远端发布，没有卸载web。\n\n数据与备份\n活动插件dataDir ${state.productionData}\n完整部署备份 ${state.backup}\n旧运行lib就地保全 ${state.preservedRuntimeLib}\nbefore数据/代码/额外迁移证据副本均在E，复制前后源与副本文件集/size/SHA一致。\n旧生产库schema2，331sessions/47089messages，额外副本quick_check=ok；原恢复快照不打开writer。\n生产书签实际0条，dryRun/apply各状态都是0，changed=false，空文件SHA保持不变；没有用合成6条未解统计冒充生产结果。\nC:\\Users\\admin\\.dsh\\session-index已保全搬到 ${relocation.destination}；${relocation.files}文件SHA一致，C旧目录不再存在。\n自动命令审查拒绝了包含递归删除的搬移方案，改用校验绝对源/目标后的原生Move-Item成功；没有通过另一shell删除。\nG保留运行代码/旧lib恢复副本，没有向G创建插件索引库。\n官方原始会话日志仍在C:\\Users\\admin\\.dsh\\sessions；本轮移动的是插件索引/书签侧数据，未搬动/改写原始日志。\n\n待后续实测（遵从用户明确延后）\n实际desktop加载路径/版本、五工具注册、worker健康；首次实际加载schema5升级/FTS checkpoint与JSON进度收敛；生产只读搜索/SCROLL（书签0条不虚构已有跳回）；一次自然增量readBytes/deltaBytes/deltaParsed。\n曾尝试临时E诊断preload启动desktop，未得到actualHost就绪证据，不计为验收通过。诊断启动PID已退出，未留永久NODE_OPTIONS/ASAR修改；诊断方案和脱敏记录仅在E。\n后续从已部署候选继续实测，不重复迁移书签/部署，不把现有库直接force/delete。\n\n恢复入口\n按DEPLOYMENT_RUNBOOK已批准运行切换步骤，保全上线后最新用户数据再使用E before快照和G lib.before恢复。\n上线后新增书签不能被before旧快照盲目覆盖；本次0条仅描述切换时点，不推断将来的书签数量。\n备份/旧lib清理仍是单独动作，本轮没有清理这些恢复资源。\n`
await writeFile('DEPLOYMENT_RESULTS.txt', report)
for (const file of ['IMPLEMENTATION_STATUS.txt', 'RELEASE_READINESS.txt', 'HANDOFF_S6_S7.txt']) {
  const original = await readFile(file, 'utf8')
  const archive = file.replace('.txt', '_S6_APPROVAL_SNAPSHOT.txt')
  try { await access(archive) } catch { await writeFile(archive, original) }
  await writeFile(file, `当前接续状态（2026-10-02，覆盖下方批准前历史文字）\n\nS6完成，S7候选0.0.3-rc.1已部署到G；用户“实测再等等，先部署”，真实生产实测明确延后。\n插件索引/书签/完整备份位于E；C旧索引已保全搬E；官方原始session日志保留C原位。\n生产书签0条，迁移changed=false；候选运行文件${state.deployedFilesVerified}项SHA复核通过。\n详见DEPLOYMENT_RESULTS.txt、DEPLOYMENT_RESULTS/DEPLOYMENT_RESULTS.json和DEPLOYMENT_RUNBOOK.txt。\n下一步仅在用户恢复实测后验证真实desktop加载/schema5回填/只读搜索/自然delta，不重新部署或实施S0–S5。\n\n以下为S6批准前的历史记录，候选release目录中的相同文件仍是批准时不可变快照：\n\n${original}`)
}
await mkdir('PATCHES/S7', { recursive: true })
const operatingFiles = ['scripts/s7-operation.mjs', 'scripts/s7-host-diagnostics.mjs', 'scripts/finalize-s7-deployment.mjs',
  'DEPLOYMENT_RESULTS.txt', 'DEPLOYMENT_RESULTS/DEPLOYMENT_RESULTS.json', 'DEPLOYMENT_RESULTS/legacy-c-relocation.json']
const operationManifest = Object.fromEntries(await Promise.all(operatingFiles.map(async file => [file, await sha(file)])))
await writeFile('PATCHES/S7/manifest.json', JSON.stringify({ scope: 'S7 approved deployment records, no additional candidate implementation changes',
  candidateManifestSha256: state.candidateManifestSha256, operationManifest, deferredByUser: state.userSteering }, null, 2) + '\n')
console.log(JSON.stringify({ phase: state.phase, runtimeVersion: state.runtimeVersion, deployedFilesVerified: state.deployedFilesVerified,
  bookmarks: state.bookmarkMigration.records, cIndexArchived: true, candidateUnchanged: true, liveAcceptance: 'deferred-by-user' }))
