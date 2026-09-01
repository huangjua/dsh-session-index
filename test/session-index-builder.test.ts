/**
 * session-index-builder.test.ts — 集成验收
 * 覆盖：空目录 / 首建 / 增量 / force / 新增 / prune / 损坏 / raced /
 *      单飞 / 取消 / quick 检查点 / run-marker 冲突 / detailMissing 补齐 / 多帧大文件
 * 注意：每个测试自包含（自己的临时目录），避免顺序耦合。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, rm, readFile, stat, appendFile, utimes } from 'node:fs/promises'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionIndexBuilder } from '../src/session-index-builder.js'
import { RunMarker } from '../src/atomic-write.js'
import { loadIndex, saveIndex } from '../src/core.js'
import type { WorkerTaskSpec } from '../src/worker-pool.js'
import { alpha3Assistant, alpha3EventJson, alpha3Jsonl, alpha3ToolCall, alpha3User, type Alpha3Event } from './support/alpha3-log.js'

const FIXTURES = fileURLToPath(new URL('../../test/fixtures', import.meta.url))
const WORKER_URL = new URL('../src/session-worker.js', import.meta.url)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 自包含沙箱：独立临时 sessions 目录 + 索引文件 */
async function makeSandbox(): Promise<{ root: string; sessions: string; indexFile: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-build-'))
  const sessions = join(root, 'sessions')
  const indexFile = join(root, 'index.json')
  await mkdir(sessions, { recursive: true })
  return { root, sessions, indexFile }
}

async function addSession(
  sessions: string,
  name: string,
  fixture = 'sample-session.jsonl.zstd',
): Promise<string> {
  const file = join(sessions, name, `session-${name}`, 'session.jsonl.zstd')
  await mkdir(dirname(file), { recursive: true })
  await copyFile(join(FIXTURES, fixture), file)
  return file
}

function makeBuilder(sessions: string, indexFile: string): SessionIndexBuilder {
  return new SessionIndexBuilder({ root: sessions, indexFile, workerUrl: WORKER_URL, poolSize: 2 })
}

/**
 * 生成一个合法的多 zstd 帧 alpha.3 日志。旧夹具重复拼接完整日志，因 seq 从 0
 * 重启而不是合法的同一会话；这里保留一个 header，并让每个追加帧的 seq 连续。
 */
function repeatedAlpha3FixtureFrames(frameCount = 100): Buffer {
  const [header, ...eventLines] = readFileSync(join(FIXTURES, 'sample-session.jsonl'), 'utf8')
    .trim()
    .split(/\r?\n/)
  const events = eventLines.map((line) => JSON.parse(line) as { seq: number; time: number })
  const eventsPerFrame = events.length
  const frames = [zstdCompressSync(Buffer.from(`${header}\n`, 'utf8'))]

  for (let frame = 0; frame < frameCount; frame++) {
    const seqOffset = frame * eventsPerFrame
    const timeOffset = frame * 100_000
    const body = events
      .map((event) => JSON.stringify({ ...event, seq: event.seq + seqOffset, time: event.time + timeOffset }))
      .join('\n') + '\n'
    frames.push(zstdCompressSync(Buffer.from(body, 'utf8')))
  }
  return Buffer.concat(frames)
}

async function addRepeatedAlpha3Session(sessions: string, name: string, frameCount = 100): Promise<string> {
  const file = await addSession(sessions, name)
  writeFileSync(file, repeatedAlpha3FixtureFrames(frameCount))
  return file
}

/** P3 构造"指定活动时间"的会话文件：内容时间戳与文件 mtime 都设为 ts
 * （判定 = max(lastTime, mtimeMs)，只改内容会被 mtime=now 抵消）。 */
async function addCraftedSession(sessions: string, name: string, ts: number): Promise<string> {
  const file = join(sessions, name, `session-${name}`, 'session.jsonl.zstd')
  await mkdir(dirname(file), { recursive: true })
  const jsonl = alpha3Jsonl({
    id: `session-${name}`,
    createdAt: ts,
    events: [alpha3User(`${name} 的首条消息（保留策略样例）`, `user-${name}`, ts)],
  }).join('\n') + '\n'
  writeFileSync(file, zstdCompressSync(Buffer.from(jsonl)))
  await utimes(file, new Date(ts), new Date(ts))
  return file
}

describe('SessionIndexBuilder 集成', () => {
  let root = ''
  let sessions = ''
  let indexFile = ''
  const builders: SessionIndexBuilder[] = []

  before(async () => {
    const sb = await makeSandbox()
    root = sb.root
    sessions = sb.sessions
    indexFile = sb.indexFile
  })
  after(async () => {
    for (const b of builders) b.pool.terminate()
    await rm(root, { recursive: true, force: true })
  })

  function builder(): SessionIndexBuilder {
    const b = makeBuilder(sessions, indexFile)
    builders.push(b)
    return b
  }

  it('空目录首建 → 空索引（version 1 合法）', async () => {
    const b = builder()
    const rep = await b.build()
    assert.equal(rep.status, 'completed')
    assert.equal(rep.totalFiles, 0)
    assert.equal(rep.added, 0)
    const idx = loadIndex(indexFile)!
    assert.equal(idx.version, 1)
    assert.equal(idx.sessions.length, 0)
  })

  it('首建：新增文件 full 字段齐全（无 detailMissing）', async () => {
    await addSession(sessions, 's1')
    await addSession(sessions, 's2')
    const b = builder()
    const rep = await b.build()
    assert.equal(rep.status, 'completed')
    assert.equal(rep.added, 2)
    assert.equal(rep.fullParsed, 2)
    assert.equal(rep.headParsed, 2)
    const idx = loadIndex(indexFile)!
    assert.equal(idx.sessions.length, 2)
    for (const s of idx.sessions) {
      assert.equal(s.detailMissing, undefined)
      assert.ok(s.counts['user/message'] >= 1)
      assert.ok(s.ctimeMs !== undefined)
      assert.equal(s.id.startsWith('session-'), true)
      assert.equal(s.workspace, 'E:\\Do\\test')
    }
  })

  it('增量：未变更文件全部 skipped', async () => {
    const b = builder()
    const rep = await b.build()
    assert.equal(rep.status, 'completed')
    assert.equal(rep.skipped, 2)
    assert.equal(rep.added, 0)
    assert.equal(rep.updated, 0)
  })

  it('force 重建：全部重扫，updated=2 skipped=0', async () => {
    const b = builder()
    const rep = await b.build({ force: true })
    assert.equal(rep.status, 'completed')
    assert.equal(rep.skipped, 0)
    assert.equal(rep.updated, 2)
    assert.equal(rep.fullParsed, 2)
  })

  it('新增文件 → added=1，既有 skipped=2', async () => {
    await addSession(sessions, 's3')
    const b = builder()
    const rep = await b.build()
    assert.equal(rep.status, 'completed')
    assert.equal(rep.added, 1)
    assert.equal(rep.skipped, 2)
    assert.equal(loadIndex(indexFile)!.sessions.length, 3)
  })

  it('删除文件 → prune（removed=1，索引减少）', async () => {
    await rm(join(sessions, 's2'), { recursive: true, force: true })
    const b = builder()
    const rep = await b.build()
    assert.equal(rep.status, 'completed')
    assert.equal(rep.removed, 1)
    const idx = loadIndex(indexFile)!
    assert.equal(idx.sessions.length, 2)
    assert.ok(!idx.sessions.some((s) => s.file.includes('s2')))
  })

  it('P3 保留策略：超龄条目 prune（pruned 计数、index 移除、onSessionRemoved 触发、会话文件未动）', async () => {
    const sb = await makeSandbox()
    try {
      const oldFile = await addCraftedSession(sb.sessions, 'old1', Date.now() - 100 * 86400e3)
      await addCraftedSession(sb.sessions, 'new1', Date.now() - 10 * 86400e3)
      const b = makeBuilder(sb.sessions, sb.indexFile)
      builders.push(b)
      const rep1 = await b.build()
      assert.equal(rep1.status, 'completed')
      assert.equal(rep1.added, 2)
      const bytesBefore = readFileSync(oldFile)
      const removedFiles: string[] = []
      const rep2 = await b.build({ retentionDays: 90, onSessionRemoved: (f) => removedFiles.push(f) })
      assert.equal(rep2.status, 'completed')
      assert.equal(rep2.pruned, 1, JSON.stringify(rep2))
      assert.equal(rep2.removed, 0)
      const idx = loadIndex(sb.indexFile)!
      assert.equal(idx.sessions.length, 1)
      assert.ok(!idx.sessions.some((s) => s.file.includes('old1')))
      assert.equal(removedFiles.length, 1)
      assert.ok(removedFiles[0].includes('old1'), 'onSessionRemoved 应收到超龄文件（FTS 同步通道）')
      // 红线：会话文件仍在磁盘且字节不变
      assert.equal(existsSync(oldFile), true, 'prune 不得删除会话文件')
      assert.ok(readFileSync(oldFile).equals(bytesBefore), 'prune 后会话文件字节不变')
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })

  it('P3 保留边界：retentionDays=90 时 89 天保留、91 天 prune', async () => {
    const sb = await makeSandbox()
    try {
      await addCraftedSession(sb.sessions, 'kept', Date.now() - 89 * 86400e3)
      await addCraftedSession(sb.sessions, 'dropped', Date.now() - 91 * 86400e3)
      const b = makeBuilder(sb.sessions, sb.indexFile)
      builders.push(b)
      await b.build()
      const rep = await b.build({ retentionDays: 90 })
      assert.equal(rep.pruned, 1, JSON.stringify(rep))
      const idx = loadIndex(sb.indexFile)!
      assert.equal(idx.sessions.length, 1)
      assert.ok(idx.sessions[0].file.includes('kept'))
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })

  it('P3 retentionDays=0：保留策略关闭（pruned=0，超龄条目保留）', async () => {
    const sb = await makeSandbox()
    try {
      await addCraftedSession(sb.sessions, 'old1', Date.now() - 200 * 86400e3)
      const b = makeBuilder(sb.sessions, sb.indexFile)
      builders.push(b)
      await b.build()
      const rep = await b.build({ retentionDays: 0 })
      assert.equal(rep.pruned, 0, JSON.stringify(rep))
      assert.equal(loadIndex(sb.indexFile)!.sessions.length, 1)
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })

  it('P3 修复：prune 后超龄文件不再被重扫重滤（后续构建 fullParsed=0）', async () => {
    const sb = await makeSandbox()
    try {
      const oldFile = await addCraftedSession(sb.sessions, 'old1', Date.now() - 100 * 86400e3)
      await addCraftedSession(sb.sessions, 'new1', Date.now() - 10 * 86400e3)
      const b = makeBuilder(sb.sessions, sb.indexFile)
      builders.push(b)
      await b.build() // 首建（无保留过滤）：两文件全量入库
      const rep1 = await b.build({ retentionDays: 90 })
      assert.equal(rep1.pruned, 1, JSON.stringify(rep1))
      // 回归：此前后续每次构建都会把超龄文件 head+full 全量重解析一遍再被 merge
      // 过滤（每个 watcher 触发的构建都白付一轮全量成本）。修复后超龄文件在
      // 变更检测阶段即被跳过。
      const rep2 = await b.build({ retentionDays: 90 })
      assert.equal(rep2.status, 'completed')
      assert.equal(rep2.pruned, 0, JSON.stringify(rep2)) // 条目已清，无需再 prune
      assert.equal(rep2.headParsed, 0, `超龄文件被重扫（head）: ${JSON.stringify(rep2)}`)
      assert.equal(rep2.fullParsed, 0, `超龄文件被重扫（full）: ${JSON.stringify(rep2)}`)
      assert.equal(rep2.skipped, 1, JSON.stringify(rep2)) // 仅 new1 指纹未变
      assert.equal(existsSync(oldFile), true, '会话文件不得被删除')
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })

  it('损坏文件：failed≥1 + error 记录，其余条目不受影响', async () => {
    await addSession(sessions, 'corrupt1', 'corrupt-session.jsonl.zstd')
    const b = builder()
    const rep = await b.build()
    assert.equal(rep.status, 'completed')
    assert.ok(rep.failed >= 1)
    assert.ok(rep.errors.length >= 1)
    assert.match(rep.errors[0], /corrupt1/)
    const idx = loadIndex(indexFile)!
    assert.equal(idx.sessions.length, 2) // 损坏文件不产生条目
  })

  it('多帧大文件（100 个事件帧）：计数成倍正确（自包含）', async () => {
    const sb = await makeSandbox()
    try {
      await addSession(sb.sessions, 'small1')
      await addRepeatedAlpha3Session(sb.sessions, 'big1')
      const b = makeBuilder(sb.sessions, sb.indexFile)
      builders.push(b)
      const rep = await b.build()
      assert.equal(rep.status, 'completed')
      assert.equal(rep.added, 2)
      const idx = loadIndex(sb.indexFile)!
      const big = idx.sessions.find((s) => s.file.includes('big1'))!
      const small = idx.sessions.find((s) => s.file.includes('small1'))!
      assert.equal(big.counts['user/message'], small.counts['user/message'] * 100)
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })

  it('raced：解析期间文件被改写 → raced≥1，条目保留旧值并带 raced 标记（自包含）', async () => {
    const sb = await makeSandbox()
    try {
      const target = await addSession(sb.sessions, 's1')
      // 钩子闭包持有可变状态：head 阶段第 1 次读不动；full 阶段第 2 次读时改写
      const state = { reads: 0, rewrote: false }
      const b = new SessionIndexBuilder({
        root: sb.sessions,
        indexFile: sb.indexFile,
        workerUrl: WORKER_URL,
        poolSize: 2,
        testHooks: {
          onFileRead: (file) => {
            if (file !== target) return
            state.reads++
            if (!state.rewrote && state.reads === 2) {
              state.rewrote = true
              // 内容合法但指纹变化（mtime/ctime 必变）
              writeFileSync(target, repeatedAlpha3FixtureFrames())
            }
          },
        },
      })
      builders.push(b)
      const rep1 = await b.build()
      assert.equal(rep1.status, 'completed')
      // 重置计数：让 build2 的 full 阶段（第 2 次读）触发改写
      state.reads = 0
      state.rewrote = false
      const rep = await b.build({ force: true })
      assert.equal(rep.status, 'completed')
      assert.equal(state.rewrote, true)
      assert.ok(rep.raced >= 1, `raced=${rep.raced}`)
      const idx = loadIndex(sb.indexFile)!
      const s1 = idx.sessions.find((s) => s.file.includes('s1'))!
      assert.equal(s1.raced, true)
      // raced 条目保留旧值（build1 的 full 计数 2 vs big×100=200）
      const cnt = s1.counts['user/message'] ?? 0
      assert.ok(cnt < 50, `unexpected ${cnt}`)
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })

  it('单飞：并发两次 build 返回同一 Promise', async () => {
    const b = builder()
    const p1 = b.build({ force: true })
    const p2 = b.build()
    assert.equal(p1, p2)
    const rep = await p1
    assert.equal(rep.status, 'completed')
  })

  it('取消：head 阶段中止 → cancelled，旧索引字节不变', async () => {
    const before = await readFile(indexFile)
    const b = builder()
    const ac = new AbortController()
    const rep = await b.build({
      force: true,
      signal: ac.signal,
      onProgress: (p) => {
        if (p.phase === 'head' && p.processed === 0) ac.abort()
      },
    })
    assert.equal(rep.status, 'cancelled')
    assert.equal(rep.partialCommitted, false)
    const after = await readFile(indexFile)
    assert.deepEqual(after, before)
  })

  it('取消：full 阶段中止 → partialCommitted=true，quick index 带 detailMissing（自包含）', async () => {
    const sb = await makeSandbox()
    try {
      await addSession(sb.sessions, 'q1')
      const b = makeBuilder(sb.sessions, sb.indexFile)
      builders.push(b)
      const ac = new AbortController()
      const rep = await b.build({
        onProgress: (p) => {
          if (p.phase === 'full' && p.processed === 0) ac.abort()
        },
        signal: ac.signal,
      })
      assert.equal(rep.status, 'cancelled')
      assert.equal(rep.partialCommitted, true)
      const idx = loadIndex(sb.indexFile)!
      assert.equal(idx.sessions.length, 1)
      assert.equal(idx.sessions[0].detailMissing, true)
      // 下一次构建补齐 detailMissing（quick 条目指纹相同也会 full pass）
      const rep2 = await b.build()
      assert.equal(rep2.status, 'completed')
      assert.equal(rep2.updated, 1)
      const idx2 = loadIndex(sb.indexFile)!
      assert.equal(idx2.sessions[0].detailMissing, undefined)
      assert.ok(idx2.sessions[0].counts['user/message'] >= 1)
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })

  it('run-marker 冲突：他人持有新鲜 marker → skipped；释放后可构建', async () => {
    const b = builder()
    const marker = await RunMarker.acquire(join(dirname(indexFile), '.tmp', 'build.lock'))
    assert.ok(marker)
    try {
      const rep = await b.build({ force: true })
      assert.equal(rep.status, 'skipped')
    } finally {
      await marker!.release()
    }
    const rep = await b.build({ force: true })
    assert.equal(rep.status, 'completed')
  })

  it('构建期间 maxEventLoopDelayMs/durationMs 已上报', async () => {
    const b = builder()
    const rep = await b.build({ force: true })
    assert.ok(rep.durationMs >= 0)
    assert.ok(rep.maxEventLoopDelayMs >= 0)
    assert.equal(rep.indexFile, indexFile)
  })

  it('取消后立即再构建 → 新构建正常完成', async () => {
    const b = builder()
    const ac = new AbortController()
    const rep1 = await b.build({
      force: true,
      signal: ac.signal,
      onProgress: (p) => {
        if (p.phase === 'head' && p.processed === 0) ac.abort()
      },
    })
    assert.equal(rep1.status, 'cancelled')
    await sleep(10)
    const rep2 = await b.build({ force: true })
    assert.equal(rep2.status, 'completed')
  })
})

describe('SessionIndexBuilder alpha.3 变更文件安全重解析', () => {
  const builders: SessionIndexBuilder[] = []
  after(async () => {
    for (const b of builders) b.pool.terminate()
  })

  /** 向会话文件追加一个独立 zstd 帧（模拟 DSH 持久化的 append batch） */
  async function appendFrame(file: string, startSeq: number, events: Alpha3Event[]): Promise<void> {
    const frame = zstdCompressSync(Buffer.from(
      events.map((event, index) => alpha3EventJson(event, startSeq + index, 0)).join('\n') + '\n',
      'utf8',
    ))
    await appendFile(file, frame)
  }

  /** 捕获 pool.run 的任务 spec（验证变更文件不会走不安全的后缀解析） */
  function captureSpecs(b: SessionIndexBuilder): { mode: string; startOffset?: number; delta?: boolean }[] {
    const specs: { mode: string; startOffset?: number; delta?: boolean }[] = []
    const origRun = b.pool.run.bind(b.pool)
    b.pool.run = ((spec: WorkerTaskSpec, signal?: AbortSignal) => {
      specs.push({ mode: spec.mode, startOffset: spec.startOffset, delta: spec.delta })
      return origRun(spec, signal)
    }) as typeof b.pool.run
    return specs
  }

  it('追加帧 → 全量重解析（counts/lastTime/lastText/indexedBytes/workspace 保留）', async () => {
    const sb = await makeSandbox()
    try {
      const target = await addSession(sb.sessions, 's1')
      const b = makeBuilder(sb.sessions, sb.indexFile)
      builders.push(b)
      const specs = captureSpecs(b)

      const rep1 = await b.build()
      assert.equal(rep1.status, 'completed')
      let idx = loadIndex(sb.indexFile)!
      const before = idx.sessions.find((s) => s.file.includes('s1'))!
      const size0 = before.indexedBytes!
      assert.ok(size0 > 0)
      assert.ok((before.counts['user/message'] ?? 0) >= 1)

      // 追加一帧：1 user + 1 assistant + 1 tool/call（时间戳须晚于夹具既有 lastTime）
      await appendFrame(target, 26, [
        alpha3User('delta追加问题', 'delta-user', 1786900000000),
        alpha3Assistant('delta追加回答', 'delta-assistant', 1786900001000),
        alpha3ToolCall('bash', 'delta-tool', 1786900002000),
      ])
      const st = await stat(target)

      specs.length = 0
      const rep2 = await b.build()
      assert.equal(rep2.status, 'completed')
      // alpha.3 的 replacement 可能跨越早期帧，必须全量重扫。
      const fullSpec = specs.find((s) => s.mode === 'full')
      assert.ok(fullSpec, 'full task dispatched')
      assert.equal(fullSpec!.delta, false)
      assert.equal(fullSpec!.startOffset, 0)

      idx = loadIndex(sb.indexFile)!
      const after = idx.sessions.find((s) => s.file.includes('s1'))!
      assert.equal(after.counts['user/message'], before.counts['user/message'] + 1)
      assert.equal(after.counts['assistant/message'], (before.counts['assistant/message'] ?? 0) + 1)
      assert.equal(after.toolCallCounts['bash'], (before.toolCallCounts['bash'] ?? 0) + 1)
      assert.equal(after.lastTime, 1786900002000)
      assert.ok(after.lastAssistantText.includes('delta追加回答'))
      assert.equal(after.indexedBytes, st.size)
      assert.equal(after.workspace, before.workspace) // workspace 不被 dirname 覆盖
      assert.equal(after.id, before.id) // first-wins：header 帧字段保留

      // force 与普通变更同样全量重建。
      specs.length = 0
      await b.build({ force: true })
      const forceSpec = specs.find((s) => s.mode === 'full')
      assert.equal(forceSpec!.delta, false)
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })

  it('追加 compaction 事件帧 → 全量重解析后收录（compaction/* 计入 counts，历史保留）', async () => {
    const sb = await makeSandbox()
    try {
      const target = await addSession(sb.sessions, 's1')
      const b = makeBuilder(sb.sessions, sb.indexFile)
      builders.push(b)
      const specs = captureSpecs(b)

      const rep1 = await b.build()
      assert.equal(rep1.status, 'completed')
      const before = loadIndex(sb.indexFile)!.sessions.find((s) => s.file.includes('s1'))!
      const size0 = before.indexedBytes!
      assert.ok(size0 > 0)
      const umBefore = before.counts['user/message'] ?? 0

      // 模拟一次 compaction：log-only 事件 + checkpoint user/message（append-only，
      // 来源见 @deepseek-ai/dsh-compaction/types.d.ts：replacement 追加在事件之后）
      await appendFrame(target, 26, [
        { type: 'compaction/start', time: 1786900001000, data: { compactionId: 'c1', turn: null } },
        { type: 'compaction/summary', time: 1786900002000, data: { compactionId: 'c1', summary: [{ type: 'text', text: '压缩摘要' }], shadowedRange: { start: 7, end: 8 }, shadowedSeqs: [7, 8], shadowedTokenCount: 10, provider: 'p', model: 'm' } },
        { type: 'compaction/prune', time: 1786900002500, data: { shadowedRange: { start: 7, end: 8 }, shadowedSeqs: [7, 8], shadowedTokenCount: 5 } },
        { type: 'compaction/end', time: 1786900003000, data: { compactionId: 'c1', turn: null } },
        alpha3User('压缩后的替身消息', 'compact-user', 1786900004000),
      ])
      const st = await stat(target)

      specs.length = 0
      const rep2 = await b.build()
      assert.equal(rep2.status, 'completed')
      // replacement 的跨帧影响要求从头解析。
      const fullSpec = specs.find((s) => s.mode === 'full')
      assert.ok(fullSpec, 'full task dispatched')
      assert.equal(fullSpec!.delta, false)
      assert.equal(fullSpec!.startOffset, 0)

      const after = loadIndex(sb.indexFile)!.sessions.find((s) => s.file.includes('s1'))!
      // log-only compaction 事件照常被索引并计入 counts。
      assert.equal(after.counts['compaction/start'], 1)
      assert.equal(after.counts['compaction/summary'], 1)
      assert.equal(after.counts['compaction/prune'], 1)
      assert.equal(after.counts['compaction/end'], 1)
      // 历史保留：原 user/message 计数仍在，checkpoint 替身消息 +1
      assert.equal(after.counts['user/message'], umBefore + 1)
      assert.equal(after.lastTime, 1786900004000)
      assert.equal(after.indexedBytes, st.size)
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })

  it('过期 indexedBytes 不会开启后缀解析，仍全量重解析', async () => {
    const sb = await makeSandbox()
    try {
      const target = await addSession(sb.sessions, 's1')
      const b = makeBuilder(sb.sessions, sb.indexFile)
      builders.push(b)
      await b.build()

      // 篡改旧偏移不应影响结果，因为实现不将后缀视作独立会话。
      const idx = loadIndex(sb.indexFile)!
      const s1 = idx.sessions.find((s) => s.file.includes('s1'))!
      s1.indexedBytes = Math.max(1, (s1.indexedBytes ?? 0) - 50)
      saveIndex(sb.indexFile, idx)

      await appendFrame(target, 26, [
        alpha3User('fallback问题', 'fallback-user', 1786833000000),
      ])
      const rep = await b.build()
      assert.equal(rep.status, 'completed')
      const after = loadIndex(sb.indexFile)!.sessions.find((s) => s.file.includes('s1'))!
      assert.equal(after.indexedBytes, (await stat(target)).size)
      assert.ok((after.counts['user/message'] ?? 0) >= 2) // 全量解析：原计数 + 追加
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })

  it('size < indexedBytes（文件被替换/回退）→ 全量重解析', async () => {
    const sb = await makeSandbox()
    try {
      const target = await addSession(sb.sessions, 's1')
      const b = makeBuilder(sb.sessions, sb.indexFile)
      builders.push(b)
      await b.build()

      // 篡改 indexedBytes 为超过实际大小也不会改变全量重解析的行为。
      const idx = loadIndex(sb.indexFile)!
      const s1 = idx.sessions.find((s) => s.file.includes('s1'))!
      s1.indexedBytes = (await stat(target)).size + 1000
      saveIndex(sb.indexFile, idx)

      await appendFrame(target, 26, [
        alpha3User('sizeShrink问题', 'shrink-user', 1786834000000),
      ])
      const rep = await b.build()
      assert.equal(rep.status, 'completed')
      const after = loadIndex(sb.indexFile)!.sessions.find((s) => s.file.includes('s1'))!
      assert.equal(after.indexedBytes, (await stat(target)).size)
      assert.ok((after.counts['user/message'] ?? 0) >= 2)
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })

  it('尾帧截断（mid-write）→ 全量解析失败，旧条目保留 + error 记录', async () => {
    const sb = await makeSandbox()
    try {
      const target = await addSession(sb.sessions, 's1')
      const b = makeBuilder(sb.sessions, sb.indexFile)
      builders.push(b)
      await b.build()
      const before = loadIndex(sb.indexFile)!.sessions.find((s) => s.file.includes('s1'))!
      const size0 = before.indexedBytes!

      // 追加"半个帧"：截断的 zstd（magic + 截断内容）→ 解码必失败
      const full = zstdCompressSync(Buffer.from('{"type":"user/message","time":1786835000000,"data":{"content":[{"type":"text","text":"截断"}]}}\n', 'utf8'))
      await appendFile(target, full.subarray(0, full.length - 5))
      const st = await stat(target)
      assert.ok(st.size > size0)

      const rep = await b.build()
      assert.equal(rep.status, 'completed')
      assert.ok(rep.failed >= 1, `failed=${rep.failed}`)
      const after = loadIndex(sb.indexFile)!.sessions.find((s) => s.file.includes('s1'))!
      // 旧条目保留（含旧 indexedBytes），不写入半帧数据
      assert.equal(after.counts['user/message'], before.counts['user/message'])
      assert.equal(after.indexedBytes, size0)
      assert.ok(after.error)
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })

  it('P2 FTS 钩子：变更后全量消息替换既有文档', async () => {
    const sb = await makeSandbox()
    try {
      const target = await addSession(sb.sessions, 's1')
      const b = makeBuilder(sb.sessions, sb.indexFile)
      builders.push(b)
      const calls: { file: string; n: number; append: boolean }[] = []
      const rep1 = await b.build({
        collectMessages: true,
        onSessionParsed: (file, _meta, messages, append) => {
          calls.push({ file, n: messages.length, append })
        },
        onSessionRemoved: () => {},
      })
      assert.equal(rep1.status, 'completed')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].append, false)
      assert.ok(calls[0].n > 0, '首建应收集到消息行')
      assert.equal(loadIndex(sb.indexFile)!.sessions.length, 1)

      // 变更后全量重解析：FTS 侧必须替换该会话的全部消息，而非追加局部帧。
      await appendFrame(target, 26, [
        alpha3User('FTS增量消息', 'fts-user', 1786900000000),
      ])
      calls.length = 0
      const rep2 = await b.build({
        collectMessages: true,
        onSessionParsed: (file, _meta, messages, append) => {
          calls.push({ file, n: messages.length, append })
        },
        onSessionRemoved: () => {},
      })
      assert.equal(rep2.status, 'completed')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].append, false)
      assert.ok(calls[0].n > 1, '全量重解析应包含历史和新帧消息')
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })

  it('追加帧中的新 title 事件生效（last-wins，不残留旧标题）', async () => {
    const sb = await makeSandbox()
    try {
      const target = await addSession(sb.sessions, 's1')
      const b = makeBuilder(sb.sessions, sb.indexFile)
      builders.push(b)
      await b.build()
      const before = loadIndex(sb.indexFile)!.sessions.find((s) => s.file.includes('s1'))!
      // 夹具自带标题 → 旧值非空，正好验证“新 title 事件覆盖旧值”
      assert.ok(before.title.length > 0, `fixture title empty? ${before.title}`)

      await appendFrame(target, 26, [
        { type: 'session/title', time: 1786909999000, data: { title: '改名后的标题' } },
      ])
      await b.build()
      const after = loadIndex(sb.indexFile)!.sessions.find((s) => s.file.includes('s1'))!
      assert.equal(after.title, '改名后的标题')
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })

  it('force 请求不被在飞非 force 构建吸收（排队补跑真全量）', async () => {
    const sb = await makeSandbox()
    try {
      const target = await addSession(sb.sessions, 's1')
      const b = makeBuilder(sb.sessions, sb.indexFile)
      builders.push(b)
      const specs = captureSpecs(b)
      await b.build() // 首建
      await appendFrame(target, 26, [
        alpha3User('x', 'force-user', 1786905000000),
      ])
      specs.length = 0
      const pIncr = b.build() // 在飞普通构建（同样是安全全量重解析）
      const pForce = b.build({ force: true }) // 撞上在飞 → 应排队补跑
      assert.notEqual(pIncr, pForce, 'force 请求不得被单飞吸收')
      const rForce = await pForce
      assert.equal(rForce.status, 'completed')
      // 两者都真实执行，且都不允许不安全的后缀解析。
      assert.ok(specs.filter((s) => s.mode === 'full').length >= 2, 'both full reparses ran')
      assert.ok(specs.filter((s) => s.mode === 'full').every((s) => s.delta === false), 'suffix parsing stayed disabled')
      const idx = loadIndex(sb.indexFile)!
      assert.equal(idx.sessions.length, 1)
      assert.ok(idx.sessions[0].counts['user/message'] >= 2)
    } finally {
      await rm(sb.root, { recursive: true, force: true })
    }
  })
})
