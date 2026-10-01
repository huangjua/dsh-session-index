/**
 * streaming-parser.test.ts — fzstd 流式三模式解析（head/full/search）
 *
 * 夹具：真实 alpha.3 DSH 会话样本，以及测试运行时生成的连续 seq 多帧变体。
 * 等值校验：parseFull 流式结果 vs 旧版 parseSession(整文件解压) —— 逐字段相等。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { zstdCompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseHead, parseFull, parseSearch, streamJsonlLines } from '../src/streaming-parser.js'
import { parseSession, decompressZstd } from '../src/core.js'
import { alpha3Assistant, alpha3EventJson, alpha3Jsonl, alpha3User, type Alpha3Event } from './support/alpha3-log.js'

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url))

const SAMPLE = fixture('sample-session.jsonl.zstd')
const CORRUPT = fixture('corrupt-session.jsonl.zstd')
let generatedRoot = ''
let BIG = ''
let STRADDLE = ''
let SINGLE_FRAME = ''
let HEADER_FRAME = ''

async function repeatedSampleFrames(frameCount: number): Promise<Buffer> {
  const [header, ...eventLines] = (await readFile(fixture('sample-session.jsonl'), 'utf8'))
    .trim()
    .split(/\r?\n/)
  const events = eventLines.map((line) => JSON.parse(line) as { seq: number; time: number })
  const frames = [zstdCompressSync(Buffer.from(`${header}\n`, 'utf8'))]
  for (let frame = 0; frame < frameCount; frame++) {
    const seqOffset = frame * events.length
    const timeOffset = frame * 100_000
    const body = events
      .map((event) => JSON.stringify({ ...event, seq: event.seq + seqOffset, time: event.time + timeOffset }))
      .join('\n') + '\n'
    frames.push(zstdCompressSync(Buffer.from(body, 'utf8')))
  }
  return Buffer.concat(frames)
}

before(async () => {
  generatedRoot = await mkdtemp(join(tmpdir(), 'dsh-alpha3-stream-'))
  BIG = join(generatedRoot, 'big.jsonl.zstd')
  STRADDLE = join(generatedRoot, 'straddle.jsonl.zstd')
  SINGLE_FRAME = join(generatedRoot, 'single-frame.jsonl.zstd')
  HEADER_FRAME = join(generatedRoot, 'header-frame.jsonl.zstd')
  await writeFile(BIG, await repeatedSampleFrames(100))
  await writeFile(STRADDLE, await repeatedSampleFrames(8))

  const splitLines = alpha3Jsonl({
    id: 'frame-layout', createdAt: 100, cwd: '/x', agentPreset: 'a',
    events: [alpha3User('needle user', 'u1', 101), alpha3Assistant('needle assistant', 'a1', 102)],
  })
  await writeFile(SINGLE_FRAME, zstdCompressSync(Buffer.from(splitLines.join('\n') + '\n')))
  await writeFile(HEADER_FRAME, Buffer.concat([
    zstdCompressSync(Buffer.from(`${splitLines[0]}\n`)),
    zstdCompressSync(Buffer.from(splitLines.slice(1).join('\n') + '\n')),
  ]))
})

after(async () => {
  if (generatedRoot) await rm(generatedRoot, { recursive: true, force: true })
})

describe('parseHead', () => {
  it('从头部提取元数据（title 缺失时按 Codex USER_EVENT_SCAN_LIMIT 扩展窗口）', async () => {
    const h = await parseHead(SAMPLE)
    assert.equal(h.id, 'session-2ed36ab1-3693-4ecd-9724-3f8af2ee8450')
    assert.equal(h.createdAt, 1786831711203)
    assert.equal(h.cwd, 'E:\\Do\\test')
    assert.equal(h.agentPreset, 'router-flash')
    assert.equal(h.sawSessionMeta, true)
    assert.ok(h.firstUserText.includes('gemini-code-merged.html'))
    assert.ok(h.title.length > 0)
    // 基础窗口 10 条；title 常出现在 user 消息之后，最多扩到 10+200
    assert.ok(h.records <= 210, `records=${h.records}`)
    assert.ok(h.records >= 10)
    assert.ok(h.lastTime > 0)
  })

  it('损坏文件 → 抛错', async () => {
    await assert.rejects(parseHead(CORRUPT))
  })
})

describe('parseFull vs parseSession（旧实现等值校验）', () => {
  it('小样本：counts/lastTime/文本/元数据全等', async () => {
    const full = await parseFull(SAMPLE)
    const ref = parseSession(decompressZstd(SAMPLE))
    assert.equal(full.id, ref.id)
    assert.equal(full.createdAt, ref.createdAt)
    assert.equal(full.cwd, ref.cwd)
    assert.equal(full.agentPreset, ref.agentPreset)
    assert.equal(full.title, ref.title)
    assert.equal(full.firstUserText, ref.firstUserText)
    assert.equal(full.lastAssistantText, ref.lastAssistantText)
    assert.equal(full.lastTime, ref.lastTime)
    assert.deepEqual(full.counts, ref.counts)
    const toolCallCounts: Record<string, number> = {}
    for (const c of ref.toolCalls) {
      if (c.name) toolCallCounts[c.name] = (toolCallCounts[c.name] || 0) + 1
    }
    assert.deepEqual(full.toolCallCounts, toolCallCounts)
    assert.ok(full.events > 0)
  })

  it('多帧大样本（100 个连续 seq 帧）：流式 = 整解，计数成倍', async () => {
    const full = await parseFull(BIG)
    const small = await parseFull(SAMPLE)
    assert.equal(full.counts['user/message'], small.counts['user/message'] * 100)
    assert.equal(full.events, small.events * 100)
    assert.equal(full.id, small.id)
    assert.equal(full.lastTime, small.lastTime + 99 * 100_000)
  })

  it('帧头跨 chunk 边界：chunk 必须拷贝不得复用缓冲（回归，fzstd 路径）', async () => {
    // straddle 夹具 = 8 个连续 seq 事件帧；chunkSize=9587 使帧头会跨读取边界。
    // fzstd 会内部持有该 chunk 引用（<18 字节缓冲），复用 readBuf 会被下一轮
    // read 覆盖 → invalid zstd data。修复：push 前拷贝。
    const full = await parseFull(STRADDLE, { compressedChunkSize: 9587, decoder: 'fzstd' })
    const small = await parseFull(SAMPLE)
    assert.equal(full.events, small.events * 8)
    assert.equal(full.counts['user/message'], small.counts['user/message'] * 8)
  })

  it('native 解码器（node:zlib 逐帧）与 fzstd 输出逐字段等价', async () => {
    for (const fixture of [SAMPLE, BIG, STRADDLE]) {
      const native = await parseFull(fixture, { decoder: 'native' })
      const fz = await parseFull(fixture, { decoder: 'fzstd' })
      assert.equal(native.id, fz.id, fixture)
      assert.equal(native.lastTime, fz.lastTime, fixture)
      assert.deepEqual(native.counts, fz.counts, fixture)
      assert.equal(native.events, fz.events, fixture)
      assert.equal(native.firstUserText, fz.firstUserText, fixture)
      assert.equal(native.lastAssistantText, fz.lastAssistantText, fixture)
    }
  })

  it('native 损坏文件：自动回退 fzstd 后同样报错', async () => {
    await assert.rejects(parseFull(CORRUPT, { decoder: 'native' }))
  })

  it('native 搜索等价', async () => {
    const native = await parseSearch(SAMPLE, 'gemini-code', { maxSnippets: 5, decoder: 'native' })
    const fz = await parseSearch(SAMPLE, 'gemini-code', { maxSnippets: 5, decoder: 'fzstd' })
    assert.deepEqual(native, fz)
  })

  it('损坏文件 → 抛错', async () => {
    await assert.rejects(parseFull(CORRUPT))
  })
})

describe('alpha.3 残缺帧', () => {
  const frame = (line: string) => zstdCompressSync(Buffer.from(line + '\n', 'utf8'))

  it('中部残缺帧即使后接完整帧也拒绝（不能跳过连续 seq 的未知语义）', async () => {
    const f1 = frame(
      alpha3Jsonl({ id: 's1', createdAt: 1, cwd: '/x', agentPreset: 'a', events: [] })[0]!,
    )
    const f2full = frame(alpha3EventJson({ type: 'session/title', time: 2, data: { title: 'T' } }, 0, 1))
    const f3 = frame(alpha3EventJson(alpha3Assistant('hello after', 'a1', 3), 1, 1))
    const partial = f2full.subarray(0, Math.floor(f2full.length / 2)) // 截断帧
    const dir = await mkdtemp(join(tmpdir(), 'dsh-midpartial-'))
    const file = join(dir, 's.zstd')
    try {
      await writeFile(file, Buffer.concat([f1, partial, f3]))
      await assert.rejects(parseFull(file, { decoder: 'native' }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('尾部残缺帧仍走“截断 → 报错”（保留 mid-write 重试语义）', async () => {
    const f1 = frame(
      alpha3Jsonl({ id: 's2', createdAt: 1, cwd: '/x', agentPreset: 'a', events: [] })[0]!,
    )
    const f2 = frame(alpha3EventJson(alpha3User('hi', 'u1', 2), 0, 1))
    const partial = f2.subarray(0, Math.floor(f2.length / 2))
    const dir = await mkdtemp(join(tmpdir(), 'dsh-tailpartial-'))
    const file = join(dir, 's.zstd')
    try {
      await writeFile(file, Buffer.concat([f1, partial]))
      await assert.rejects(parseFull(file, { decoder: 'native' }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('parseSearch', () => {
  it('命中 user/message 文本并生成上下文 snippet', async () => {
    const hits = await parseSearch(SAMPLE, 'gemini-code', { maxSnippets: 5 })
    assert.ok(hits.length >= 1)
    const h = hits[0]
    assert.equal(h.type, 'user/message')
    assert.ok(h.snippet.toLowerCase().includes('gemini-code'))
    assert.ok(h.snippet.startsWith('... ') || !h.snippet.startsWith('...'))
  })

  it('大小写不敏感', async () => {
    const hits = await parseSearch(SAMPLE, 'GEMINI-CODE', { maxSnippets: 3 })
    assert.ok(hits.length >= 1)
  })

  it('maxSnippets 截断', async () => {
    // 'test' 出现多次（cwd 转义出现于 session 行，正文大量出现）
    const hits = await parseSearch(SAMPLE, 'test', { maxSnippets: 2 })
    assert.ok(hits.length <= 2)
  })

  it('无命中 → 空数组', async () => {
    const hits = await parseSearch(SAMPLE, 'zzz-no-such-term-zzz', { maxSnippets: 3 })
    assert.deepEqual(hits, [])
  })

  it('多帧大文件搜索正常', async () => {
    const hits = await parseSearch(BIG, 'gemini-code', { maxSnippets: 3 })
    assert.ok(hits.length >= 1)
  })

  it('损坏文件 → 抛错', async () => {
    await assert.rejects(parseSearch(CORRUPT, 'gemini-code'))
  })
})

/* ══ STAGE-1 Part C：codex search.rs / ccfullsearch ripgrep.rs 边界翻译 + alpha.3 帧切分 ══
 * 语义逐条对照 reference/borrow/codex-tests/TEST_MATRIX.md 与
 * reference/borrow/ccfullsearch/src/search/ripgrep.rs（不发明上游没有的语义）。 */
describe('STAGE-1 Part C（codex/ccfullsearch 边界 + alpha.3 帧切分）', () => {
  const partcDirs: string[] = []
  const mkFile = async (events: Array<Alpha3Event | string>, id = 's'): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-partc-'))
    partcDirs.push(dir)
    const file = join(dir, 's.jsonl.zstd')
    let seq = 0
    const lines = [
      alpha3Jsonl({ id, createdAt: 1, cwd: '/x', agentPreset: 'a', events: [] })[0]!,
      ...events.map((event) => typeof event === 'string' ? event : alpha3EventJson(event, seq++, 1)),
    ]
    await writeFile(file, zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
    return file
  }
  const user = (text: string, time: number) => alpha3User(text, `user-${time}`, time)
  const assistant = (text: string, time: number) => alpha3Assistant(text, `assistant-${time}`, time)

  after(async () => {
    for (const d of partcDirs) await rm(d, { recursive: true, force: true }).catch(() => {})
  })

  it('json 转义查询：引号/反斜杠/中文按字面命中正文（codex json_escaped_search_term 语义）', async () => {
    const file = await mkFile([
      user('他说"你好" world', 2),
      assistant('路径 C:\\temp 中文混合', 3),
    ])
    const q1 = await parseSearch(file, '"你好"', { maxSnippets: 3 })
    assert.ok(q1.some((h) => h.snippet.includes('"你好"')), `引号查询应命中正文：${JSON.stringify(q1)}`)
    const q2 = await parseSearch(file, 'C:\\temp', { maxSnippets: 3 })
    assert.ok(q2.some((h) => h.snippet.toLowerCase().includes('c:\\temp')), `反斜杠查询应命中正文：${JSON.stringify(q2)}`)
    const q3 = await parseSearch(file, '中文混合', { maxSnippets: 3 })
    assert.ok(q3.some((h) => h.snippet.includes('中文混合')), `中文查询应命中正文：${JSON.stringify(q3)}`)
  })

  it('metadata-only 命中不返回（只认 user/assistant 消息文本；sessionId 中的词不算）', async () => {
    const file = await mkFile([
      user('Running warmup', 2),
    ], 'abc123xyz')
    const meta = await parseSearch(file, 'abc123xyz', { maxSnippets: 3 })
    assert.deepEqual(meta, [], 'sessionId 里的词不得作为命中（元数据不算消息文本）')
    const content = await parseSearch(file, 'warmup', { maxSnippets: 3 })
    assert.equal(content.length, 1, '消息文本里的词正常命中')
  })

  it('空文本消息跳过（user/assistant 空文本、非消息事件行均不产命中）', async () => {
    const file = await mkFile([
      { type: 'session/title', time: 2, data: { title: 'needle 标题' } },
      user('', 3),
      assistant('', 4),
      user('实际正文 needle', 5),
    ])
    const hits = await parseSearch(file, 'needle', { maxSnippets: 5 })
    assert.equal(hits.length, 1, `空文本/非消息行不得产命中：${JSON.stringify(hits)}`)
    assert.equal(hits[0].type, 'user/message')
    assert.ok(hits[0].snippet.includes('needle'))
  })

  it('snippet 首尾截断：命中靠后带 "… " 前缀、命中靠前带 " …" 后缀，命中区间带 >>> <<<（C11 与 FTS 路径同款）', async () => {
    const tail = await mkFile([
      user('A'.repeat(200) + ' needle', 2), // 命中在尾部 → 只有前缀
    ])
    const hTail = await parseSearch(tail, 'needle', { maxSnippets: 1 })
    assert.ok(hTail[0].snippet.startsWith('… '), `尾部命中应带前缀：${JSON.stringify(hTail[0].snippet)}`)
    assert.ok(!hTail[0].snippet.endsWith(' …'), '尾部命中不应带后缀')
    assert.ok(hTail[0].snippet.includes('>>>needle<<<'), '命中区间应带 >>> <<< 标记')

    const head = await mkFile([
      user('needle ' + 'B'.repeat(200), 2), // 命中在头部 → 只有后缀
    ])
    const hHead = await parseSearch(head, 'needle', { maxSnippets: 1 })
    assert.ok(!hHead[0].snippet.startsWith('… '), '头部命中不应带前缀')
    assert.ok(hHead[0].snippet.endsWith(' …'), `头部命中应带后缀：${JSON.stringify(hHead[0].snippet)}`)
  })

  it('JSON.parse 失败行拒绝整个 alpha.3 日志（不能跳过未知 seq 语义）', async () => {
    const file = await mkFile([
      '{"type":"user/message","data":{"content":[{"type":"text","text":"needle 坏行"}]', // 未闭合 → 解析失败
      user('合法行 needle', 3),
    ])
    await assert.rejects(parseSearch(file, 'needle', { maxSnippets: 3 }))
  })

  it('大小上限：maxDecompressedBytes 超限抛错', async () => {
    const file = await mkFile([
      user('这是一段超过 8 字节解压输出的正文内容', 2),
    ])
    await assert.rejects(parseFull(file, { maxDecompressedBytes: 8 }), /exceeds/)
  })

  it('大小上限：maxLineBytes 超长行丢弃（oversized），其余行正常', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-line-limit-'))
    partcDirs.push(dir)
    const file = join(dir, 'raw.zstd')
    await writeFile(file, zstdCompressSync(Buffer.from(`${'x'.repeat(100)}\nshort\n`)))
    const got: string[] = []
    const st = await streamJsonlLines(
      file,
      (l) => {
        got.push(l)
        return true
      },
      { maxLineBytes: 20 },
    )
    assert.equal(st.oversized, 1, '超长行应计入 oversized 并被丢弃')
    assert.deepEqual(got, ['short'], '其余行不受影响')
  })

  it('alpha.3 单帧与 header 独占首帧变体解析完全等价', async () => {
    // 同一行序列、仅帧切分不同：
    // 帧切分对行解析透明（已论证免疫，用测试固化）
    const hA = await parseHead(SINGLE_FRAME)
    const hB = await parseHead(HEADER_FRAME)
    assert.deepEqual(
      { id: hA.id, createdAt: hA.createdAt, cwd: hA.cwd, agentPreset: hA.agentPreset, title: hA.title, firstUserText: hA.firstUserText, lastTime: hA.lastTime, sawSessionMeta: hA.sawSessionMeta, records: hA.records },
      { id: hB.id, createdAt: hB.createdAt, cwd: hB.cwd, agentPreset: hB.agentPreset, title: hB.title, firstUserText: hB.firstUserText, lastTime: hB.lastTime, sawSessionMeta: hB.sawSessionMeta, records: hB.records },
      'parseHead 两变体逐字段等价',
    )
    const fA = await parseFull(SINGLE_FRAME)
    const fB = await parseFull(HEADER_FRAME)
    assert.deepEqual(fA, fB, 'parseFull 两变体全字段等价')
    const sA = await parseSearch(SINGLE_FRAME, 'needle', { maxSnippets: 5 })
    const sB = await parseSearch(HEADER_FRAME, 'needle', { maxSnippets: 5 })
    assert.deepEqual(sA, sB, 'parseSearch 两变体等价')
    assert.equal(sA.length, 2, `needle 应命中 user/assistant 两行：${JSON.stringify(sA.map((h) => h.type))}`)
  })
})

describe('STAGE-2 Part B compaction 事件（alpha.3 surface replacement）', () => {
  const dirs: string[] = []
  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {})
  })
  it('parseFull 统计 compaction/* 事件到 counts/events（含 checkpoint user/message）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-comp-'))
    dirs.push(dir)
    const file = join(dir, 's.jsonl.zstd')
    // DSH compaction：log-only 事件 + 以 sourceEventSeqs 佐证的 surface replacement。
    const lines = alpha3Jsonl({
      id: 's-comp', createdAt: 100, cwd: 'C:\\x', agentPreset: 'a',
      events: [
        alpha3User('旧问题', 'old-user', 200),
        alpha3Assistant('旧回答', 'old-assistant', 300),
        { type: 'compaction/start', time: 400, data: { compactionId: 'c1', turn: null } },
        { type: 'compaction/summary', time: 500, data: { compactionId: 'c1', summary: [{ type: 'text', text: '压缩摘要' }], shadowedSeqs: [0, 1], shadowedTokenCount: 10, provider: 'p', model: 'm' } },
        { type: 'compaction/prune', time: 550, data: { shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1], shadowedTokenCount: 5 } },
        { type: 'compaction/end', time: 600, data: { compactionId: 'c1', turn: null } },
        {
          type: 'user/message', time: 700, surfaceOp: { op: 'replace', start: 0, end: 1 }, sourceEventSeqs: [[0, 1]],
          data: { id: 'compact-user', role: 'user', source: { kind: 'plugin', plugin: 'compact' }, content: [{ type: 'text', text: '压缩后的替身消息' }] },
        },
        alpha3Assistant('新回答', 'new-assistant', 800),
      ],
    })
    await writeFile(file, zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
    const full = await parseFull(file)
    // 全部 compaction/* 类型计入 counts（解析器对事件类型无过滤，streaming-parser.ts:361）
    assert.equal(full.counts['compaction/start'], 1)
    assert.equal(full.counts['compaction/summary'], 1)
    assert.equal(full.counts['compaction/prune'], 1)
    assert.equal(full.counts['compaction/end'], 1)
    // checkpoint user/message 也是普通 user/message（替身消息计入计数）
    assert.equal(full.counts['user/message'], 2)
    assert.equal(full.counts['assistant/message'], 2)
    assert.equal(full.events, 8)
    // 当前可见 surface 只保留 replacement 与其后的 assistant。
    assert.equal(full.firstUserText, '压缩后的替身消息')
    assert.equal(full.lastAssistantText, '新回答')
    assert.equal(full.lastTime, 800)
  })
})
