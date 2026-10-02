/**
 * rank-integration.test.ts — STAGE-1 Part A 集成层（apply + fake ctx）
 *
 * 与 rank.test.ts（纯函数层）互补，验证接入 session_index_list / session_index_search
 * 后的行为：
 *  - list sort='time'（默认）输出与改动前完全一致（lastTime desc, id asc + cursor 分页）
 *  - list sort='relevance'：单页 top-k、不返回可续游标、无 query 退化 frecency
 *  - search 已知命中（标题前缀）排序靠前（相关性 > 时间）
 *  - 三路径（meta / full-FTS / full-worker 回退）同查询同语料相对顺序一致
 *  - 内容-only 会话（标题不中、正文中）在 full 路径被聚合进结果，且代表行 kind=content
 *
 * 说明：按 0.1 基线纯净性约定，本文件独立成文件、不动既有测试文件；harness 与
 * index.test.ts 同款（fake ctx + craftSession 造语料），保持自包含。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { apply } from '../src/index.js'
import { alpha3Jsonl, alpha3User, type Alpha3Event } from './support/alpha3-log.js'

interface Tool {
  execute: (args: Record<string, unknown>) => Promise<Record<string, any>>
  parameters?: Record<string, unknown>
}
interface FakeTools {
  [name: string]: Tool
}

interface Env {
  home: string
  tools: FakeTools
  files: string[]
  cleanups: (() => void)[]
  restore: () => void
}
const envs: Env[] = []
const bases: string[] = []

function makeCtx() {
  const tools: FakeTools = {}
  const cleanups: (() => void)[] = []
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    tools: { register: (t: { name: string }) => { tools[t.name] = t as unknown as Tool } },
    effect: (fn: () => unknown) => {
      const r = fn()
      if (typeof r === 'function') cleanups.push(r as () => void)
    },
  }
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

interface CraftOpts {
  ts?: number
  title?: string
  userText?: string
  /** 追加 alpha.3 事件（影响 counts/事件总数）。 */
  extraEvents?: Alpha3Event[]
}
/** 构造"指定活动时间/标题/正文"的会话文件（内容时间戳 + mtime 都设为 ts）。 */
async function craftSession(root: string, name: string, opts: CraftOpts = {}): Promise<string> {
  const file = join(root, name, `session-${name}`, 'session.jsonl.zstd')
  await mkdir(dirname(file), { recursive: true })
  const t = opts.ts ?? Date.now()
  const lines = alpha3Jsonl({
    id: `session-${name}`,
    createdAt: t,
    events: [
      ...(opts.title ? [{ type: 'session/title', time: t, data: { title: opts.title } }] : []),
      alpha3User(opts.userText ?? `${name} 的首条消息`, `user-${name}`, t),
      ...(opts.extraEvents ?? []),
    ],
  })
  // ⚠️ 结尾必须带 '\n'：streaming-parser 的 emit 按 '\n' 分条、flush 不补，
  // 末行缺换行会被整体丢弃（实测：records 少一行、firstUserText 为空、worker 搜索 0 命中）。
  await writeFile(file, zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
  await utimes(file, new Date(t), new Date(t))
  return file
}

interface SetupOpts {
  ftsEnabled?: boolean
  sessions?: Array<CraftOpts & { name: string }>
}
async function setup(opts: SetupOpts = {}): Promise<Env> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-rankint-'))
  bases.push(base)
  const home = join(base, 'home')
  const sessionsRoot = join(home, 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  const files: string[] = []
  for (const s of opts.sessions ?? []) files.push(await craftSession(sessionsRoot, s.name, s))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const { ctx, tools, cleanups } = makeCtx()
  apply(ctx as never, {
    sessionsRoot,
    indexFile: join(home, 'session-index', 'index.json'),
    // dataDir 显式指向测试 home（不能留空依赖 DSH_HOME 兜底——避免污染真实 ~/.dsh）
    dataDir: join(home, 'session-index'),
    maxHits: 10,
    maxSnippetsPerSession: 3,
    ftsEnabled: opts.ftsEnabled ?? true,
    retentionDays: 0,
    // STAGE-4：本文件与 LLM 摘要无关，显式关闭（零执行，语义同旧版）
    llmSummaryEnabled: false,
  })
  const env: Env = {
    home,
    tools,
    files,
    cleanups,
    restore: () => {
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
    },
  }
  envs.push(env)
  return env
}

/** 等 FTS 后台回填完成（messages 行 >0 表示 collectMessages 已落库） */
async function waitFtsReady(env: Env): Promise<void> {
  await waitFor(async () => {
    const st = await env.tools['session_index_status'].execute({})
    return (st.ftsHealth?.messages ?? 0) > 0
  }, 20000)
}

const idsOf = (r: { hits?: Array<{ sessionId: string }> }): string[] => (r.hits ?? []).map((h) => h.sessionId)
const idsOfList = (r: { sessions?: Array<{ id: string }> }): string[] => (r.sessions ?? []).map((s) => s.id)

describe('STAGE-1 Part A 集成', () => {
  after(() => {
    // 释放 apply 挂载的资源（watcher / FTS db / worker 池 / abortController）——
    // 否则测试子进程持有句柄不退出（实测挂起；--test-force-exit 只是掩盖）。
    for (const e of envs) {
      for (const c of e.cleanups.reverse()) {
        try { c() } catch { /* 清理失败不影响结果 */ }
      }
      e.restore()
    }
    for (const b of bases) void rm(b, { recursive: true, force: true })
  })

  it('list 默认 sort=time：行为与改动前一致（lastTime desc + cursor 分页）', async () => {
    const now = Date.now()
    const env = await setup({
      sessions: [
        { name: 'new', ts: now },
        { name: 'mid', ts: now - 5 * 86400e3 },
        { name: 'old', ts: now - 30 * 86400e3 },
      ],
    })
    const p1 = await env.tools['session_index_list'].execute({ limit: 2 })
    assert.deepEqual(idsOfList(p1), ['session-new', 'session-mid'], 'time 排序 = 时间倒序')
    assert.equal(typeof p1.nextCursor, 'string', '有下一页时返回 nextCursor')
    assert.equal(p1.truncated, false)
    const p2 = await env.tools['session_index_list'].execute({ limit: 2, cursor: p1.nextCursor })
    assert.deepEqual(idsOfList(p2), ['session-old'])
    assert.equal('nextCursor' in p2, false, '末页不返回 nextCursor（既有语义）')
  })

  it('list sort=relevance：单页 top-k、无游标；无 query 时退化为 frecency', async () => {
    const now = Date.now()
    const env = await setup({
      sessions: [
        { name: 'new', ts: now },
        { name: 'mid', ts: now - 5 * 86400e3 },
        { name: 'old', ts: now - 30 * 86400e3 },
      ],
    })
    // schema 注明不支持翻页（defineTool 把 parameters 编译为 JSON Schema：
    // 参数在 properties 下）
    const params = (env.tools['session_index_list'] as { parameters?: { properties?: Record<string, any> } }).parameters
    const sortParam = params?.properties?.sort as { enum?: string[]; description?: string } | undefined
    assert.ok(sortParam, 'sort 参数应存在于 schema')
    assert.deepEqual(sortParam.enum, ['time', 'relevance'])
    assert.match(sortParam.description ?? '', /不支持翻页/)

    const r = await env.tools['session_index_list'].execute({ limit: 2, sort: 'relevance' })
    assert.deepEqual(idsOfList(r), ['session-new', 'session-mid'], '无 query → frecency（新者优先）')
    assert.equal('nextCursor' in r, false, 'relevance 不返回可续游标')
    assert.equal(r.sort, 'relevance')
    assert.equal(r.truncated, true, '有剩余会话但无翻页 → truncated 表达')
  })

  it('list sort=relevance：相关性优先于时间（标题前缀命中压过更新的子串命中）', async () => {
    const now = Date.now()
    const env = await setup({
      sessions: [
        { name: 'strong', ts: now - 20 * 86400e3, title: 'fzy trigram matcher 文档' },
        { name: 'weak', ts: now, title: 'trigram 相关 fzy 笔记' },
      ],
    })
    const rel = await env.tools['session_index_list'].execute({ limit: 10, sort: 'relevance', query: 'fzy' })
    assert.equal(idsOfList(rel)[0], 'session-strong', '相关性排序：prefix 命中排最前（即便更旧）')
    const time = await env.tools['session_index_list'].execute({ limit: 10, query: 'fzy' })
    assert.equal(idsOfList(time)[0], 'session-weak', 'time 排序不受相关性影响：新的在前')
  })

  it('search meta：已知命中（标题前缀）排序靠前 + snippet 带 >>> 标记', async () => {
    const now = Date.now()
    const env = await setup({
      ftsEnabled: false, // meta 路径与 FTS 无关
      sessions: [
        { name: 'pref', ts: now - 20 * 86400e3, title: 'FTS Trigram 搜索设计' },
        { name: 'other', ts: now, title: '部署 nginx 反向代理' },
        { name: 'sub', ts: now, title: '真的 fts 吗' }, // 子串命中（非前缀）→ 排 prefix 之后
      ],
    })
    const r = await env.tools['session_index_search'].execute({ query: 'fts', mode: 'meta', limit: 2 })
    assert.deepEqual(idsOf(r), ['session-pref', 'session-sub'], 'prefix 命中在前，substring 在后，无关会话不出现')
    assert.ok(r.hits[0].snippet.includes('>>>'), 'meta snippet 带命中标记')
    assert.equal(r.hits[0].kind, 'meta')
    assert.ok(r.total >= 2)
  })

  it('search full：三路径同查询同语料相对顺序一致（meta / FTS / worker 回退）', async () => {
    const now = Date.now()
    const specs = [
      { name: 'a', title: 'trigram search design', userText: 'trigram 索引实现' }, // prefix（最相关）
      { name: 'b', title: 'my trigram notes', userText: 'trigram 补丁' },
      { name: 'c', title: 'the trigram stuff', userText: 'trigram 试验' },
      // 内容-only 命中：query 只出现在第二条 user message（首条消息不含 →
      // metaMatch（含 firstUserText）不中，但 FTS/worker 全文路径能命中）
      { name: 'd', title: '无关标题', userText: '一些无关的正文内容', extraEvents: [alpha3User('这里提到一次 trigram', 'user-d-extra', now)] },
    ]
    const envFTS = await setup({ ftsEnabled: true, sessions: specs })
    const envWorker = await setup({ ftsEnabled: false, sessions: specs })

    // 先等 FTS 就绪（apply 的 createSessionFts 是异步链），再触发首个构建——
    // 保证该构建带 collectMessages=true，消息行才会落库（否则 waitFtsReady 会空等）。
    await waitFor(async () => (await envFTS.tools['session_index_status'].execute({})).ftsHealth?.ok === true, 20000)
    const metaR = await envFTS.tools['session_index_search'].execute({ query: 'trigram', mode: 'meta', limit: 10 })
    await waitFtsReady(envFTS)
    const ftsR = await envFTS.tools['session_index_search'].execute({ query: 'trigram', mode: 'full', limit: 10 })
    const workerR = await envWorker.tools['session_index_search'].execute({ query: 'trigram', mode: 'full', limit: 10 })

    const metaIds = idsOf(metaR)
    const ftsIds = idsOf(ftsR)
    const workerIds = idsOf(workerR)

    // meta 只含标题命中的 a/b/c（d 标题不中）；a 为 prefix 必居首
    assert.equal(metaIds[0], 'session-a', 'prefix 命中居首')
    assert.ok(metaIds.includes('session-b') && metaIds.includes('session-c'))
    assert.ok(!metaIds.includes('session-d'), '内容-only 会话不进 meta 结果')

    // 验收核心：full 两路径与 meta 的"共享命中集相对顺序"完全一致，且额外聚合 d 于尾部
    for (const ids of [ftsIds, workerIds]) {
      assert.deepEqual(ids.slice(0, 3), metaIds, 'full 路径与 meta 路径相对顺序一致')
      assert.equal(ids[3], 'session-d', '内容-only 会话被聚合且排最后')
    }
    // 代表行证据：d 来自正文 → kind=content
    const dHit = ftsR.hits.find((h: any) => h.sessionId === 'session-d')
    assert.equal(dHit.kind, 'content')
    assert.equal(typeof dHit.anchorId, 'string', 'FTS 路径代表行带稳定 SCROLL 锚点')
    assert.equal(dHit.messageId, undefined, '新记录不公开数据库 rowid')
    const workerDHit = workerR.hits.find((h: any) => h.sessionId === 'session-d')
    assert.equal(workerDHit.anchorId, dHit.anchorId, '同一来源在 FTS 与原文回退中使用相同锚点')
  })

  it('search full：worker 回退稳定锚点 + 同一会话聚合为一条', async () => {
    const now = Date.now()
    const env = await setup({
      ftsEnabled: false,
      sessions: [{ name: 'x', title: 't', userText: 'trigram trigram 双词命中' }],
    })
    const r = await env.tools['session_index_search'].execute({ query: 'trigram', mode: 'full', limit: 10 })
    const xs = r.hits.filter((h: any) => h.sessionId === 'session-x')
    assert.equal(xs.length, 1, '同一会话多条命中聚合为一条代表行')
    assert.equal(xs[0].messageId, undefined, '原文回退不伪造数字锚点')
    assert.equal(typeof xs[0].anchorId, 'string', '原文回退保留来源稳定锚点')
  })
})
