/**
 * index.test.ts — P2.1/P2.2 ftsEnabled 开关与 FTS 健康快照（apply 层，fake ctx）
 *
 * 覆盖：
 * - ftsEnabled=false：不创建 fts.db；mode=full 自动走 worker 流式回退（正文命中、
 *   snippet 带 >>> <<< 标记）；SCROLL 返回既有"FTS 不可用"错误对象；
 * - 默认（ftsEnabled=true）：创建 fts.db；session_index_status 返回健康快照
 *   （平铺 fts/ftsSessions 兼容 + 嵌套 ftsHealth 全字段）。
 *
 * 注意：本文件按既有测试惯例用 fileURLToPath 引用源 fixtures（.test-build 无副本）。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, copyFile, utimes, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { apply } from '../src/index.js'
import { createSessionFts } from '../src/fts.js'
import { alpha3Assistant, alpha3Jsonl, alpha3User } from './support/alpha3-log.js'

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/sample-session.jsonl.zstd', import.meta.url))

/** 构造"指定活动时间"的会话文件（内容时间戳 + 文件 mtime 都设为 ts）。 */
async function craftOldSession(sessionsRoot: string, name: string, ts: number): Promise<string> {
  const file = join(sessionsRoot, `ret-${name}`, `session-${name}`, 'session.jsonl.zstd')
  await mkdir(dirname(file), { recursive: true })
  const jsonl = alpha3Jsonl({
    id: `session-${name}`,
    createdAt: ts,
    events: [alpha3User(`${name} 的首条消息（保留策略样例）`, `user-${name}`, ts)],
  }).join('\n')
  // ⚠️ 末行必须带 '\n'：streaming-parser 的 emit 按 '\n' 分条、flush 不补，缺换行会把
  // 最后一行（user/message）整体丢弃（rank-integration 同款坑；STAGE-1 Part C 错误隔离
  // 测试依赖该行参与搜索——旧行为让 firstUserText 为空、meta/worker 均 0 命中）。
  const buf = Buffer.from(jsonl + '\n')
  await writeFile(file, zstdCompressSync(buf))
  await utimes(file, new Date(ts), new Date(ts))
  return file
}

interface SetupOpts {
  ftsEnabled?: boolean
  retentionDays?: number
  /** 缺省 = 一份新 fixture 会话 */
  sessions?: Array<{ name: string; ts?: number }>
  /** 预置 fts.db 并写入 last_prune=now（watermark 24h 门控测试） */
  preseedWatermark?: boolean
  /** STAGE-4：注入 fake 宿主 llm（listProviders/listModels/stream） */
  llm?: unknown
  /** STAGE-4：llmSummaryEnabled 开关（缺省 true，与 Config 默认一致） */
  llmSummaryEnabled?: boolean
}

interface Tool {
  execute: (args: Record<string, unknown>) => Promise<Record<string, any>>
}

interface FakeTools {
  [name: string]: Tool
}

interface Env {
  home: string
  ftsDb: string
  tools: FakeTools
  cleanups: (() => void)[]
  files: string[]
  restore: () => void
}

const envs: Env[] = []
const bases: string[] = []

/** fake ctx：logger 空实现，tools.register 捕获工具，effect 记录 cleanup。
 * STAGE-4：可注入 fake 宿主 llm（listProviders/listModels/stream），供
 * session_summary 的 llmSummary 路径走真实 HostLlmProvider 组装逻辑。 */
function makeCtx(llm?: unknown) {
  const tools: FakeTools = {}
  const cleanups: (() => void)[] = []
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    tools: {
      register: (t: { name: string }) => {
        tools[t.name] = t as unknown as Tool
      },
    },
    effect: (fn: () => unknown) => {
      const r = fn()
      if (typeof r === 'function') cleanups.push(r as () => void)
    },
  }
  if (llm !== undefined) (ctx as Record<string, unknown>).llm = llm
  return { ctx, tools, cleanups }
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）`)
}

async function setup(opts: SetupOpts = {}): Promise<Env> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-idx2-'))
  bases.push(base)
  const home = join(base, 'home')
  const sessionsRoot = join(home, 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  const specs = opts.sessions ?? [{ name: 'fresh' }]
  const files: string[] = []
  for (const s of specs) {
    if (s.ts !== undefined) files.push(await craftOldSession(sessionsRoot, s.name, s.ts))
    else {
      const file = join(sessionsRoot, s.name, `session-${s.name}`, 'session.jsonl.zstd')
      await mkdir(dirname(file), { recursive: true })
      await copyFile(FIXTURE, file)
      files.push(file)
    }
  }
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  // 预置 watermark：先建库并 markPruned(0)（count=0），再 apply（其 createSessionFts 复用该库）
  if (opts.preseedWatermark) {
    const f = await createSessionFts(join(home, 'session-index', 'fts.db'))
    assert.ok(f?.ok, '预置 fts.db 应可用')
    f!.markPruned(0)
    await f!.flush()
    f!.close()
  }
  const { ctx, tools, cleanups } = makeCtx(opts.llm)
  apply(ctx as never, {
    sessionsRoot,
    indexFile: join(home, 'session-index', 'index.json'),
    maxHits: 10,
    maxSnippetsPerSession: 3,
    ftsEnabled: opts.ftsEnabled ?? true,
    retentionDays: opts.retentionDays ?? 90,
    llmSummaryEnabled: opts.llmSummaryEnabled ?? true,
  })
  const env: Env = {
    home,
    ftsDb: join(home, 'session-index', 'fts.db'),
    tools,
    cleanups,
    files,
    restore: () => {
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
    },
  }
  envs.push(env)
  return env
}

/** 读 index.json（不存在返回 null）。 */
function readIndexHome(home: string): { sessions: { id: string; file: string; lastTime: number }[] } | null {
  try {
    return JSON.parse(readFileSync(join(home, 'session-index', 'index.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 只读快照 fts.db 行数。 */
function ftsDbSnapshot(home: string): { sessions: number; messages: number } {
  const db = new DatabaseSync(join(home, 'session-index', 'fts.db'), { readOnly: true })
  try {
    const s = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    const m = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    return { sessions: Number(s.n), messages: Number(m.n) }
  } finally {
    db.close()
  }
}

after(async () => {
  for (const e of envs) {
    for (const c of e.cleanups) {
      try { c() } catch { /* ignore */ }
    }
    try { e.restore() } catch { /* ignore */ }
  }
  for (const b of bases) await rm(b, { recursive: true, force: true })
})

describe('ftsEnabled（P2.1/2.2）', () => {
  it('ftsEnabled=false：不建库；mode=full 走 worker 回退；SCROLL 返回 FTS 不可用', async () => {
    const env = await setup({ ftsEnabled: false })
    // 若错误建库，会在异步窗口出现；窗口后仍不得存在
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(existsSync(env.ftsDb), false, 'ftsEnabled=false 时不得创建/打开 fts.db')

    const search = env.tools['session_index_search']
    assert.ok(search, 'session_index_search 已注册')
    // mode=full 自动走 worker 流式回退：正文命中（kind=content）+ snippet 标记
    const r = await search.execute({ query: 'skill', mode: 'full', limit: 5 })
    assert.ok(Array.isArray(r.hits) && r.hits.length > 0, JSON.stringify(r).slice(0, 300))
    assert.ok(r.hits.some((h: any) => h.kind === 'content'), 'worker 回退应产出正文命中')
    assert.ok(r.hits.some((h: any) => typeof h.snippet === 'string' && h.snippet.includes('>>>')), '回退 snippet 应带命中标记')

    // SCROLL：返回既有"FTS 不可用"错误对象（fail-open，不抛异常）。
    // P1 修复：query 不再 required——SCROLL 无需占位词即可进入分支。
    const sc = await search.execute({ session_id: 'session-abc', message_id: 1, window: 2 })
    assert.equal(sc.ok, false)
    assert.match(String(sc.error ?? ''), /FTS 不可用/)
    assert.equal(sc.mode, 'scroll')
    // P1 修复：render 必须显式展示错误行（而不是渲染成"空窗口"误导模型）
    // （defineTool 的 render 在 tool.output.render 下）
    const rendered = (search as unknown as { output: { render: (a: unknown, v: Record<string, unknown>) => { type: string; text: string }[] } }).output.render({}, sc)
    assert.match(
      rendered.map((b) => b.text).join('\n'),
      /SCROLL 失败/,
      'SCROLL 失败必须在 render 中显式可见',
    )
  })

  it('默认 ftsEnabled=true：创建 fts.db；status 健康快照字段齐全', async () => {
    const env = await setup({})
    await waitFor(() => existsSync(env.ftsDb), 5000)
    const status = env.tools['session_index_status']
    assert.ok(status, 'session_index_status 已注册')
    const r = await status.execute({})
    // 平铺兼容字段保持原键名原类型
    assert.equal(r.fts, true)
    assert.equal(typeof r.ftsSessions, 'number')
    // 嵌套健康快照
    const h = r.ftsHealth
    assert.ok(h, 'ftsHealth 存在')
    assert.equal(h.enabled, true)
    assert.equal(h.ok, true)
    assert.equal(typeof h.sessions, 'number')
    assert.equal(typeof h.messages, 'number')
    assert.ok(h.dbSizeBytes > 0, `dbSizeBytes=${h.dbSizeBytes}`)
    assert.equal(h.schemaVersion, '1')
    assert.equal(typeof h.lastOptimizeAt, 'number')
    assert.ok(h.lastOptimizeAt >= 0)
    // P3 可观测字段也在快照里
    assert.equal(r.retentionDays, 90)
    assert.equal(typeof h.lastPruneAt, 'number')
    assert.equal(typeof h.lastPruneCount, 'number')
  })

  it('P3 apply 级：启动保留清理 → 索引/fts.db 移除超龄条目、会话文件未动', async () => {
    const env = await setup({
      retentionDays: 90,
      sessions: [
        { name: 'old-s', ts: Date.now() - 100 * 86400e3 },
        { name: 'fresh' },
      ],
    })
    // 会话文件字节基准
    const oldIdx = env.files[0]
    const bytesBefore = readFileSync(oldIdx)
    // 等启动序列完成：FTS 就绪 → prune build 落下 → index 只剩 fresh
    await waitFor(() => {
      const ix = readIndexHome(env.home)
      return ix !== null && ix.sessions.length === 1
    }, 20000)
    const ix = readIndexHome(env.home)!
    assert.equal(ix.sessions.length, 1)
    assert.ok(!ix.sessions.some((s) => s.file.includes('ret-old-s')), '超龄条目应从 index.json 移除')
    // 红线：会话文件仍在磁盘且字节不变
    assert.equal(existsSync(oldIdx), true, '保留清理不得删除会话文件')
    assert.ok(readFileSync(oldIdx).equals(bytesBefore), '保留清理不得改动会话文件字节')
    // fts.db 同步清理：sessions 行只剩 fresh（等 removeSession 写链落盘）
    await waitFor(() => ftsDbSnapshot(env.home).sessions === 1, 10000)
    const snap = ftsDbSnapshot(env.home)
    assert.equal(snap.sessions, 1)
    // watermark 已写（build return 与 fts 链落盘有毫秒级窗口，轮询断言消除脆性）
    const status = env.tools['session_index_status']
    await waitFor(async () => {
      const r = await status.execute({})
      return (r.ftsHealth?.lastPruneAt ?? 0) > 0
    }, 10000)
    const r2 = await status.execute({})
    assert.ok(r2.ftsHealth.lastPruneAt > 0, 'last_prune watermark 应已写入')
    // P1 修复后语义：超龄文件在变更检测阶段即被跳过（从未入索引、从未解析），
    // merge 无条目可 prune → lastPruneCount=0。旧语义是"先全量解析再 prune=1"
    // （白付一轮解析成本）。真正的 merge 级 prune 计数由 builder 级 P3 测试覆盖
    //（先无过滤入库、再带 retentionDays 构建 → pruned=1）。
    assert.equal(r2.ftsHealth.lastPruneCount, 0)
  })

  it('P3 retentionDays=0：apply 不执行保留清理', async () => {
    const env = await setup({
      retentionDays: 0,
      sessions: [{ name: 'old-s', ts: Date.now() - 200 * 86400e3 }],
    })
    // 策略关闭 → 启动序列不构建；经工具调用触发一次常规构建（索引来自磁盘事实源）
    await env.tools['session_index_list'].execute({ limit: 5 })
    await waitFor(() => {
      const ix = readIndexHome(env.home)
      return ix !== null && ix.sessions.length === 1
    }, 20000)
    const ix = readIndexHome(env.home)!
    assert.ok(ix.sessions.some((s) => s.file.includes('ret-old-s')), 'retentionDays=0 时超龄条目应保留')
    const status = env.tools['session_index_status']
    const r = await status.execute({})
    assert.equal(r.retentionDays, 0)
  })

  it('P3 watermark：24h 内启动专用 prune 跳过（常规构建仍过滤条目，watermark 不被重写）', async () => {
    const seedTs = Date.now()
    const env = await setup({
      retentionDays: 90,
      preseedWatermark: true,
      sessions: [
        { name: 'old-s', ts: Date.now() - 100 * 86400e3 },
        { name: 'fresh' },
      ],
    })
    // 超龄条目由常规构建（ftsBuildOptions 底座统一携带 retentionDays）过滤，
    // 不依赖每日专用通道
    await env.tools['session_index_list'].execute({ limit: 5 })
    await waitFor(() => {
      const ix = readIndexHome(env.home)
      return ix !== null && ix.sessions.length === 1
    }, 20000)
    const ix = readIndexHome(env.home)!
    assert.ok(!ix.sessions.some((s) => s.file.includes('ret-old-s')), '常规构建也应过滤超龄条目')
    const status = env.tools['session_index_status']
    const r = await status.execute({})
    // 专用通道被 24h 门控跳过：不重写 watermark、不 markPruned（→ VACUUM 不重跑）
    assert.ok(Math.abs(r.ftsHealth.lastPruneAt - seedTs) < 5000, `lastPruneAt=${r.ftsHealth.lastPruneAt} seed=${seedTs}`)
    assert.equal(r.ftsHealth.lastPruneCount, 0)
  })
})

describe('STAGE-1 Part C 错误隔离（工具层 worker 回退，对照 ccfullsearch ripgrep.rs 多 path 单失败隔离）', () => {
  it('search full：单文件损坏不影响其它会话命中', async () => {
    const ts = Date.now()
    const env = await setup({
      ftsEnabled: false, // worker 流式回退路径
      sessions: [
        { name: 'ok', ts },
        { name: 'bad', ts },
      ],
    })
    const search = env.tools['session_index_search']
    // 首轮强制构建：两个会话都在索引里（refresh 触发 ensureIndex force）
    const r0 = await search.execute({ query: '首条消息', mode: 'full', limit: 10, refresh: true })
    const ids0 = (r0.hits ?? []).map((h: any) => h.sessionId)
    assert.ok(ids0.includes('session-ok') && ids0.includes('session-bad'), JSON.stringify(ids0))
    // 构建后损坏 bad 文件（保留 ok 文件完好）→ refresh 强制重建：bad 解析失败记为
    // failed（builder 语义：解析失败保留旧条目 + error），不拖垮整次构建与搜索；
    // ok 的正文命中不受影响；bad 的正文路径被隔离（不产 content 命中）。
    await writeFile(env.files[1], Buffer.from('this is not a valid zstd frame -- garbage'))
    const r1 = await search.execute({ query: '首条消息', mode: 'full', limit: 10, refresh: true })
    const okContent = (r1.hits ?? []).filter((h: any) => h.sessionId === 'session-ok' && h.kind === 'content')
    const badContent = (r1.hits ?? []).filter((h: any) => h.sessionId === 'session-bad' && h.kind === 'content')
    assert.ok(okContent.length >= 1, `单文件失败不应影响其它会话的正文命中：${JSON.stringify((r1.hits ?? []).map((h: any) => [h.sessionId, h.kind]))}`)
    assert.equal(badContent.length, 0, '损坏文件的正文路径被隔离失败（无 content 命中）')
    const st = await env.tools['session_index_status'].execute({})
    assert.equal(st.lastReport?.status, 'completed', '构建整体完成（未因单文件失败而中止）')
    assert.equal(st.lastReport?.failed, 1, '损坏文件记为 failed，其余正常')
  })
})

describe('STAGE-2 Part A 书签（session_index_bookmark）', () => {
  it('add → 落盘 bookmarks.jsonl + list 可见；label 缺省确定性（无 LLM）', async () => {
    const ts = Date.now()
    const env = await setup({ sessions: [{ name: 'bmk-a', ts }] })
    const bm = env.tools['session_index_bookmark']
    assert.ok(bm, 'session_index_bookmark 已注册')
    const r = await bm.execute({ action: 'add', sessionId: 'session-bmk-a' })
    assert.equal(r.action, 'add')
    assert.equal(r.replaced, false)
    assert.ok(r.bookmark.id, '确定性 id 存在')
    assert.equal(r.bookmark.sessionId, 'session-bmk-a')
    assert.equal(r.bookmark.messageId, null)
    assert.equal(r.bookmark.label, 'bmk-a 的首条消息（保留策略样例）', 'label 缺省 = 首条用户消息前 80 字符')
    assert.ok(r.bookmark.createdAt > 0 && r.bookmark.updatedAt > 0)
    // 落盘位置：与 fts.db 同级（%DSH_HOME%\session-index\bookmarks.jsonl）
    const file = join(env.home, 'session-index', 'bookmarks.jsonl')
    assert.equal(existsSync(file), true)
    // list 可见 + 非 stale（会话在索引）
    const l = await bm.execute({ action: 'list' })
    assert.equal(l.returned, 1)
    assert.equal(l.bookmarks[0].sessionId, 'session-bmk-a')
    assert.equal(l.bookmarks[0].stale, false)
    assert.equal(l.indexReady, true)
  })

  it('add 同锚点重复 = 替换更新（幂等）；异 messageId = 新锚点', async () => {
    const ts = Date.now()
    const env = await setup({ sessions: [{ name: 'bmk-b', ts }] })
    const bm = env.tools['session_index_bookmark']
    const r1 = await bm.execute({ action: 'add', sessionId: 'session-bmk-b', label: 'L1', note: 'N1' })
    assert.equal(r1.replaced, false)
    // messageId 不同 → 不同锚点 → 新增
    const r2 = await bm.execute({ action: 'add', sessionId: 'session-bmk-b', messageId: 5, label: 'L2' })
    assert.equal(r2.replaced, false)
    // 同锚点（sessionId+messageId=5）重复 → 替换更新
    const r3 = await bm.execute({ action: 'add', sessionId: 'session-bmk-b', messageId: 5, label: 'L3', note: 'N3' })
    assert.equal(r3.replaced, true)
    assert.equal(r3.bookmark.id, r2.bookmark.id, '同锚点同 id')
    const l = await bm.execute({ action: 'list' })
    assert.equal(l.returned, 2, '会话级 + messageId=5 两条，无重复')
    const m = l.bookmarks.find((b: any) => b.messageId === 5)
    assert.equal(m.label, 'L3')
    assert.equal(m.note, 'N3')
    assert.equal(l.bookmarks.filter((b: any) => b.messageId === 5).length, 1)
  })

  it('add 未找到会话 → 明确错误', async () => {
    const env = await setup({})
    const bm = env.tools['session_index_bookmark']
    await assert.rejects(() => bm.execute({ action: 'add', sessionId: 'no-such-session-xyz' }), /未找到会话/)
  })

  it('list 过滤（label/note 大小写不敏感）+ updatedAt 倒序', async () => {
    const ts = Date.now()
    const env = await setup({ sessions: [{ name: 'bmk-f', ts }] })
    const bm = env.tools['session_index_bookmark']
    await bm.execute({ action: 'add', sessionId: 'session-bmk-f', label: 'Alpha 中文', note: 'zzz' })
    await bm.execute({ action: 'add', sessionId: 'session-bmk-f', messageId: 1, label: 'Beta', note: 'aaa' })
    const l1 = await bm.execute({ action: 'list', query: 'ALPHA' })
    assert.equal(l1.returned, 1)
    assert.equal(l1.bookmarks[0].label, 'Alpha 中文')
    const l2 = await bm.execute({ action: 'list', query: 'alpha' })
    assert.equal(l2.returned, 1)
    const l3 = await bm.execute({ action: 'list', query: 'aaa' })
    assert.equal(l3.returned, 1)
    assert.equal(l3.bookmarks[0].label, 'Beta')
    // 两条都在；排序确定性（updatedAt 倒序，同 ms 时 id 升序收口——不断言跨 ms 顺序）
    const l4 = await bm.execute({ action: 'list' })
    assert.equal(l4.returned, 2)
    assert.deepEqual(l4.bookmarks.map((b: any) => b.messageId).sort((a: any, b: any) => (a ?? -1) - (b ?? -1)), [null, 1])
    const l5 = await bm.execute({ action: 'list' })
    assert.deepEqual(l5.bookmarks.map((b: any) => b.id), l4.bookmarks.map((b: any) => b.id), '两次 list 顺序一致（确定性）')
  })

  it('list stale 标注：会话从索引消失 → stale=true（不自动删除，红线 9）', async () => {
    const ts = Date.now()
    const env = await setup({ sessions: [{ name: 'bmk-stale', ts }] })
    const bm = env.tools['session_index_bookmark']
    await bm.execute({ action: 'add', sessionId: 'session-bmk-stale' })
    // 删除会话文件 → refresh 强制重建 → 索引不再有该会话
    await rm(env.files[0], { force: true })
    await env.tools['session_index_list'].execute({ refresh: true, limit: 5 })
    const l = await bm.execute({ action: 'list' })
    assert.equal(l.returned, 1)
    assert.equal(l.bookmarks[0].stale, true, '会话不在索引 → stale')
    // stale 不自动删除：书签文件仍保留该行
    const file = join(env.home, 'session-index', 'bookmarks.jsonl')
    assert.ok(readFileSync(file, 'utf8').includes('bmk-stale'), 'stale 书签不自动删除')
  })

  it('remove：id 或 sessionId 删除后 list 消失；缺参数报错；绝不删会话文件', async () => {
    const ts = Date.now()
    const env = await setup({ sessions: [{ name: 'bmk-r', ts }] })
    const bm = env.tools['session_index_bookmark']
    const sessionFile = env.files[0]
    const bytesBefore = readFileSync(sessionFile)
    await bm.execute({ action: 'add', sessionId: 'session-bmk-r', label: 'R1' })
    await bm.execute({ action: 'add', sessionId: 'session-bmk-r', messageId: 3, label: 'R2' })
    await assert.rejects(() => bm.execute({ action: 'remove' }), /remove 需要 id 或 sessionId 之一/)
    const r = await bm.execute({ action: 'remove', sessionId: 'session-bmk-r' })
    assert.equal(r.removed, 2)
    const l = await bm.execute({ action: 'list' })
    assert.equal(l.returned, 0)
    assert.equal(await bm.execute({ action: 'remove', sessionId: 'session-bmk-r' }).then((x: any) => x.removed), 0)
    // 红线：会话文件未被删除且字节不变
    assert.equal(existsSync(sessionFile), true)
    assert.ok(readFileSync(sessionFile).equals(bytesBefore))
  })

  it('schema：action enum + 跳回链描述；四旧工具无回归', async () => {
    const ts = Date.now()
    const env = await setup({ sessions: [{ name: 'reg', ts }] })
    const bm = env.tools['session_index_bookmark'] as unknown as {
      name: string
      description: string
      parameters: { type: string; properties: Record<string, { enum?: string[] }>; required?: string[] }
      output: {
        schema: {
          properties: {
            bookmark: { properties: Record<string, { oneOf?: unknown[] }> }
            bookmarks: { items: { properties: Record<string, { oneOf?: unknown[] }> } }
          }
        }
      }
    }
    assert.equal(bm.name, 'session_index_bookmark')
    assert.match(bm.description, /SCROLL/)
    assert.match(bm.description, /session_summary/)
    // defineTool 会把 parameters 编译成 JSON Schema：properties.action.enum + required
    assert.deepEqual(bm.parameters.properties.action.enum, ['add', 'list', 'remove'])
    assert.ok((bm.parameters.required ?? []).includes('action'), 'action 应 required')
    // 输出 schema：messageId/note 可空（oneOf + null）——线上严格校验会拒绝 null 打 integer
    const out = bm.output.schema as {
      properties: {
        bookmark: { properties: Record<string, { oneOf?: unknown[] }> }
        bookmarks: { items: { properties: Record<string, { oneOf?: unknown[] }> } }
      }
    }
    assert.deepEqual(out.properties.bookmark.properties.messageId.oneOf, [{ type: 'integer' }, { type: 'null' }])
    assert.deepEqual(out.properties.bookmark.properties.note.oneOf, [{ type: 'string' }, { type: 'null' }])
    assert.deepEqual(out.properties.bookmarks.items.properties.messageId.oneOf, [{ type: 'integer' }, { type: 'null' }])
    assert.deepEqual(out.properties.bookmarks.items.properties.note.oneOf, [{ type: 'string' }, { type: 'null' }])
    // 四旧工具仍注册可调用（无回归）
    const status = await env.tools['session_index_status'].execute({})
    assert.equal(typeof status.sessions, 'number')
    const list = await env.tools['session_index_list'].execute({ limit: 5 })
    assert.ok(Array.isArray(list.sessions))
    const search = await env.tools['session_index_search'].execute({ query: '首条消息', mode: 'meta', limit: 5 })
    assert.ok(Array.isArray(search.hits))
    const summary = await env.tools['session_summary'].execute({ id: 'session-reg' })
    assert.equal(summary.id, 'session-reg')
  })
})

describe('STAGE-2 Part B compaction 断言（分支 1：事件计入 counts，session_summary 输出计数）', () => {
  it('含 compaction 事件的会话：session_summary.counts 输出 compaction/* 计数', async () => {
    const ts = Date.now()
    const env = await setup({ sessions: [{ name: 'comp', ts }] })
    // 覆盖会话文件为"原消息 + compaction 事件 + checkpoint 替身"（append-only 语义，
    // 对照 @deepseek-ai/dsh-compaction/types.d.ts：replacement 由紧随的 user/message 携带）
    const lines = alpha3Jsonl({
      id: 'session-comp',
      createdAt: ts,
      cwd: 'C:\\x',
      agentPreset: 'a',
      events: [
        alpha3User('旧问题', 'comp-old-user', ts + 1),
        alpha3Assistant('旧回答', 'comp-old-assistant', ts + 2),
        { type: 'compaction/start', time: ts + 3, data: { compactionId: 'c1', turn: null } },
        { type: 'compaction/summary', time: ts + 4, data: { compactionId: 'c1', summary: [{ type: 'text', text: '压缩摘要' }], shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1], shadowedTokenCount: 10, provider: 'p', model: 'm' } },
        { type: 'compaction/prune', time: ts + 5, data: { shadowedRange: { start: 0, end: 1 }, shadowedSeqs: [0, 1], shadowedTokenCount: 5 } },
        { type: 'compaction/end', time: ts + 6, data: { compactionId: 'c1', turn: null } },
        alpha3User('压缩后的替身消息', 'comp-checkpoint-user', ts + 7),
      ],
    })
    await writeFile(env.files[0], zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
    const summary = await env.tools['session_summary'].execute({ id: 'session-comp', refresh: true })
    assert.equal(summary.counts['compaction/start'], 1)
    assert.equal(summary.counts['compaction/summary'], 1)
    assert.equal(summary.counts['compaction/prune'], 1)
    assert.equal(summary.counts['compaction/end'], 1)
    assert.equal(summary.counts['user/message'], 2, 'checkpoint 替身消息计入 user/message')
  })
})

describe('STAGE-4 可选 LLM 一句话摘要（llmSummary，红线 3 修订唯一例外）', () => {
  /** fake 宿主 llm：listProviders/listModels/stream（流式 chunk 走真实 BlockAssembler）。 */
  function makeFakeLlm(opts: { text?: string; fail?: boolean; delayMs?: number } = {}) {
    const calls: Array<{
      provider: string
      model: string
      maxTokens?: number
      hasSignal?: boolean
      messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>
    }> = []
    const llm = {
      listProviders: () => [{ id: 'fake-provider', name: 'fake' }],
      listModels: async (p: string) => [{ provider: p, id: 'fake-model', name: 'fake-model' }],
      stream: async function* (o: any) {
        calls.push({
          provider: o.provider,
          model: o.model,
          maxTokens: o.maxTokens,
          hasSignal: !!o.signal,
          messages: o.messages,
        })
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
        if (opts.fail) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'fake boom', code: 'TEST_ERR' } } }
          return
        }
        yield { type: 'text-delta', index: 0, text: opts.text ?? '一句话摘要：该会话围绕示例任务展开。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    return { llm, calls }
  }

  it('status 健康快照：默认开启、无宿主 llm → ok=false；调用后 lastError 记录（fail-open）', async () => {
    const env = await setup({})
    const st = await env.tools['session_index_status'].execute({})
    const h = st.llmSummaryHealth
    assert.ok(h, 'llmSummaryHealth 存在')
    assert.equal(h.enabled, true)
    assert.equal(h.ok, false, '无宿主 llm → ok=false')
    assert.equal(h.cached, 0)
    assert.equal(h.provider, '')
    assert.equal(h.lastError, null, '尚无调用 → 无失败记录（lastError=null，oneOf null schema 过严格校验）')
    // 一次 session_summary 触发 fail-open 路径 → status.lastError 记录原因
    const env2 = await setup({ sessions: [{ name: 'fresh', ts: Date.now() }] })
    await env2.tools['session_summary'].execute({ id: 'session-fresh' })
    const st2 = await env2.tools['session_index_status'].execute({})
    const h2 = st2.llmSummaryHealth
    assert.equal(h2.ok, false)
    assert.equal(typeof h2.lastError, 'string')
    assert.ok(h2.lastError, '有调用且有失败 → lastError 非空')
  })

  it('成功路径：llmSummary 附加 + maxTokens=64 成本护栏 + 第二次缓存命中零调用 + health 全绿', async () => {
    const { llm, calls } = makeFakeLlm({ text: '一句话摘要：示例任务完成。' })
    const env = await setup({ llm, sessions: [{ name: 'fresh', ts: Date.now() }] })
    const summary = env.tools['session_summary']
    const r1 = await summary.execute({ id: 'session-fresh' })
    assert.equal(r1.llmSummary, '一句话摘要：示例任务完成。')
    assert.equal(r1.id, 'session-fresh')
    assert.equal(typeof r1.title, 'string', '确定性字段仍在')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].provider, 'fake-provider')
    assert.equal(calls[0].model, 'fake-model')
    assert.equal(calls[0].maxTokens, 64, '成本护栏：max_tokens=64')
    assert.ok(calls[0].hasSignal, '应传 AbortSignal（10s 超时）')
    assert.equal(calls[0].messages.length, 1)
    assert.equal(calls[0].messages[0].role, 'user')
    assert.match(calls[0].messages[0].content[0].text, /会话标题/, 'prompt 构造送达模型')
    // 第二次：指纹（size+mtimeMs）相同 → 缓存命中，零新调用
    const r2 = await summary.execute({ id: 'session-fresh' })
    assert.equal(r2.llmSummary, r1.llmSummary)
    assert.equal(calls.length, 1, '缓存命中 = 无新调用')
    // health 全绿 + cached=1；成功路径 lastError=null（oneOf null schema 过严格校验）
    const st = await env.tools['session_index_status'].execute({})
    const h = st.llmSummaryHealth
    assert.equal(h.ok, true)
    assert.equal(h.cached, 1)
    assert.equal(h.provider, 'fake-provider')
    assert.equal(h.lastError, null)
    // 缓存 sidecar 落盘（%DSH_HOME%\session-index\llm-summary.jsonl）
    assert.equal(existsSync(join(env.home, 'session-index', 'llm-summary.jsonl')), true)
  })

  it('启用但调用失败：确定性摘要原样（无 llmSummary）+ health.ok=false + 不缓存', async () => {
    const { llm, calls } = makeFakeLlm({ fail: true })
    const env = await setup({ llm, sessions: [{ name: 'fresh', ts: Date.now() }] })
    const r = await env.tools['session_summary'].execute({ id: 'session-fresh' })
    assert.equal(r.llmSummary, undefined, '失败 → 不加字段（fail-open）')
    assert.equal(r.id, 'session-fresh')
    assert.equal(calls.length, 1)
    const st = await env.tools['session_index_status'].execute({})
    assert.equal(st.llmSummaryHealth.ok, false)
    assert.match(String(st.llmSummaryHealth.lastError ?? ''), /fake boom/)
    assert.equal(st.llmSummaryHealth.cached, 0, '失败不写缓存')
  })

  it('llmSummaryEnabled=false 完全零执行：无字段、零调用、health 关态', async () => {
    const { llm, calls } = makeFakeLlm()
    const env = await setup({ llm, llmSummaryEnabled: false, sessions: [{ name: 'fresh', ts: Date.now() }] })
    const r = await env.tools['session_summary'].execute({ id: 'session-fresh' })
    assert.deepEqual(
      Object.keys(r).sort(),
      ['agentPreset', 'counts', 'createdAt', 'durationMs', 'file', 'firstUserText', 'id', 'lastAssistantText', 'lastTime', 'title', 'toolCalls', 'workspace'],
      '关闭时输出与确定性摘要完全一致（无 llmSummary）',
    )
    assert.equal(calls.length, 0, '关闭 = 零调用')
    assert.equal(existsSync(join(env.home, 'session-index', 'llm-summary.jsonl')), false, '关闭不建缓存')
    const st = await env.tools['session_index_status'].execute({})
    assert.equal(st.llmSummaryHealth.enabled, false)
    assert.equal(st.llmSummaryHealth.ok, false)
    assert.equal(st.llmSummaryHealth.provider, '')
  })

  it('指纹失效：会话文件 mtime 变化 → 缓存失效重新生成（调用 2 次）', async () => {
    const { llm, calls } = makeFakeLlm()
    const env = await setup({ llm, sessions: [{ name: 'fresh', ts: Date.now() }] })
    const summary = env.tools['session_summary']
    await summary.execute({ id: 'session-fresh' })
    assert.equal(calls.length, 1)
    // 只改 mtime（内容/大小不动）→ 会话文件指纹 (size, mtimeMs) 变化 → 重生成
    const file = env.files[0]
    const now = new Date()
    await utimes(file, now, now)
    const r2 = await summary.execute({ id: 'session-fresh' })
    assert.equal(r2.llmSummary, '一句话摘要：该会话围绕示例任务展开。')
    assert.equal(calls.length, 2, '指纹变化 → 重新生成')
  })

  it('其余四工具零回退：list/search/bookmark 输出无 llmSummary 且行为不变（成本护栏：非 summary 路径零调用）', async () => {
    const { llm, calls } = makeFakeLlm()
    const env = await setup({ llm, sessions: [{ name: 'fresh', ts: Date.now() }] })
    const list = await env.tools['session_index_list'].execute({ limit: 5 })
    assert.ok(list.sessions.every((s: any) => !('llmSummary' in s)), 'list 不受 llm 影响')
    const search = await env.tools['session_index_search'].execute({ query: '首条消息', mode: 'meta', limit: 5 })
    assert.ok(search.hits.every((h: any) => !('llmSummary' in h)), 'search 不受 llm 影响')
    const bm = env.tools['session_index_bookmark']
    const a = await bm.execute({ action: 'add', sessionId: 'session-fresh' })
    assert.equal(a.bookmark.sessionId, 'session-fresh')
    const l = await bm.execute({ action: 'list' })
    assert.equal(l.returned, 1)
    assert.ok(!('llmSummary' in l), 'bookmark 不受 llm 影响')
    // 成本护栏：status（仅健康快照）/list/search/bookmark 路径零 LLM 调用
    await env.tools['session_index_status'].execute({})
    assert.equal(calls.length, 0, '非 session_summary 路径不得触发 LLM 调用')
  })
})

describe('STAGE-5：短词慢路径提示（schema + render，静态零 LLM）', () => {
  it('schema：session_index_search.query 的 description 含 ≥3 字 / LIKE 引导', async () => {
    const env = await setup({})
    const search = env.tools['session_index_search'] as unknown as {
      parameters: { type: string; properties: Record<string, { description?: string }> }
    }
    const desc = search.parameters.properties.query?.description ?? ''
    assert.match(desc, /≥3 字/, desc)
    assert.match(desc, /LIKE/, desc)
  })

  it('render：full + 短词（<3 字）追加慢路径提示；≥3 字 / meta 模式无提示', async () => {
    const env = await setup({})
    const search = env.tools['session_index_search']
    const render = (args: unknown, v: Record<string, unknown>) =>
      (search as unknown as { output: { render: (a: unknown, v: Record<string, unknown>) => { type: string; text: string }[] } })
        .output.render(args, v).map((b) => b.text).join('\n')
    await env.tools['session_index_list'].execute({ limit: 5 })
    await waitFor(async () => {
      const s = await env.tools['session_index_status'].execute({})
      return s.lastReport?.status === 'completed' || s.sessions > 0
    }, 60000)

    const short = await search.execute({ query: '首条', mode: 'full', limit: 5 })
    assert.match(render({ query: '首条', mode: 'full' }, short), /LIKE 兜底较慢/, '短词 full → 应提示')
    const long = await search.execute({ query: '首条消息', mode: 'full', limit: 5 })
    assert.doesNotMatch(render({ query: '首条消息', mode: 'full' }, long), /LIKE 兜底较慢/, '≥3 字 full → 不应提示')
    const meta = await search.execute({ query: '首条', mode: 'meta', limit: 5 })
    assert.doesNotMatch(render({ query: '首条', mode: 'meta' }, meta), /LIKE 兜底较慢/, 'meta 模式 → 不应提示')
  })

  it('render：SCROLL 模式不受影响（无 query 也不报错、无慢路径提示）', async () => {
    const env = await setup({})
    const search = env.tools['session_index_search']
    const sc = await search.execute({ session_id: 'session-abc', message_id: 1, window: 2 })
    assert.equal(sc.mode, 'scroll')
    const rendered = (search as unknown as { output: { render: (a: unknown, v: Record<string, unknown>) => { type: string; text: string }[] } })
      .output.render({}, sc).map((b) => b.text).join('\n')
    assert.doesNotMatch(rendered, /LIKE 兜底较慢/)
  })
})
