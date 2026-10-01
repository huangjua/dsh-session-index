/**
 * filter.test.ts — STAGE-1 Part B 集成层（session_index_search 的 filter 参数）
 *
 * 与 rank-integration.test.ts 同款 harness（fake ctx + craftSession 造语料），
 * 保持自包含、不动既有测试文件（0.1 基线清洁性约定）。
 *
 * 覆盖（验收 ≥5，实际 12）：
 *  - schema：filter 对象参数（role 四枚举 + sinceMs/untilMs + 降级注记）
 *  - role 四值（user/assistant/tool/any）在 FTS 与 worker 回退两路径结果一致
 *  - sinceMs/untilMs 边界（含等于边界值；FTS SQL / worker 派发 / meta 三路）
 *  - meta 模式 role='tool' 会话级近似（toolCallCounts>0）；user/assistant 不过滤
 *  - full 模式 + role∈{user,assistant} 时 meta 补充贡献跳过（消息级严格，
 *    元数据-only 命中不得冒充消息命中）
 *  - 默认 any 回归：不带 filter / filter={} / filter={role:'any'} 输出完全一致
 *  - render 回显 filter 生效情况 + 零命中静态提示保留（不新增教学文字）
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { apply } from '../src/index.js'
import { alpha3Assistant, alpha3Jsonl, alpha3ToolCall, alpha3User, type Alpha3Event } from './support/alpha3-log.js'

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
  /** 追加 alpha.3 事件（影响 counts/事件总数；assistant/tool 行供索引提取）。 */
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
  // 末行缺换行会被整体丢弃（rank-integration.test.ts 同款注释）。
  await writeFile(file, zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
  await utimes(file, new Date(t), new Date(t))
  return file
}

const DAY = 86400e3
const assistantEvent = (text: string, t: number): Alpha3Event => alpha3Assistant(text, `assistant-${t}-${text}`, t)
const toolEvent = (name: string, t: number): Alpha3Event => alpha3ToolCall(name, `tool-${t}-${name}`, t)

interface SetupOpts {
  ftsEnabled?: boolean
  sessions?: Array<CraftOpts & { name: string }>
}
async function setup(opts: SetupOpts = {}): Promise<Env> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-filter-'))
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

/** 等 FTS 可用 + 后台回填完成（messages 行 >0 且 sessions 数=语料数——否则搜索
 * 可能撞上回填未完成导致某会话消息行缺失，全量并行跑时偶发（STAGE-1 B 期 role
 * 过滤曾出现一次空结果，隔离复跑全绿；本加固按"回填完整"等待消除该类瞬态）。 */
async function waitFtsReady(env: Env, expectedSessions?: number): Promise<void> {
  await waitFor(async () => {
    const st = await env.tools['session_index_status'].execute({})
    return (st.ftsHealth?.ok ?? false) === true
  }, 20000)
  await waitFor(async () => {
    const st = await env.tools['session_index_status'].execute({})
    const msgs = st.ftsHealth?.messages ?? 0
    if (expectedSessions !== undefined) {
      return msgs > 0 && (st.ftsHealth?.sessions ?? 0) >= expectedSessions
    }
    return msgs > 0
  }, 20000)
}

const idsOf = (r: { hits?: Array<{ sessionId: string }> }): string[] => (r.hits ?? []).map((h) => h.sessionId)
const setOf = (r: { hits?: Array<{ sessionId: string }> }): string[] => [...new Set(idsOf(r))].sort()

/** role 一致性语料：query='alpha' 时 user/assistant/tool 三类命中分属不同会话。 */
function roleCorpus(now: number): Array<CraftOpts & { name: string }> {
  return [
    { name: 'u', ts: now, title: '用户正文会话', userText: 'alpha 用户消息唯一' },
    { name: 'a', ts: now, title: '助手回复会话', userText: '普通无信号正文', extraEvents: [assistantEvent('alpha 助手回复唯一', now)] },
    { name: 't', ts: now, title: '工具调用会话', userText: '普通无信号正文', extraEvents: [toolEvent('alpha_tool', now)] },
    { name: 'n', ts: now, title: '完全无关会话', userText: '无信号普通文本' },
  ]
}

describe('STAGE-1 Part B filter 参数', () => {
  after(() => {
    // 释放 apply 挂载的资源（watcher / FTS db / worker 池 / abortController）——
    // 否则测试子进程持有句柄不退出（rank-integration 同款）。
    for (const e of envs) {
      for (const c of e.cleanups.reverse()) {
        try { c() } catch { /* 清理失败不影响结果 */ }
      }
      e.restore()
    }
    for (const b of bases) {
      try {
        rm(b, { recursive: true, force: true })
      } catch {
        // FTS WAL/派生文件异步残留可让首轮 rm 报 ENOTEMPTY（瞬态竞态）→ 延迟重试一次
        setTimeout(() => {
          try {
            rm(b, { recursive: true, force: true })
          } catch { /* 清理失败不影响测试结果 */ }
        }, 250)
      }
    }
  })

  it('schema：filter 对象参数（role 四枚举 + sinceMs/untilMs + 降级注记）', async () => {
    const env = await setup({ ftsEnabled: false, sessions: [] })
    const params = (env.tools['session_index_search'] as { parameters?: { properties?: Record<string, any> } }).parameters
    const f = params?.properties?.filter as { type?: string; description?: string; properties?: Record<string, any> } | undefined
    assert.ok(f, 'filter 参数应存在于 schema')
    assert.equal(f.type, 'object')
    const role = f.properties?.role as { enum?: string[]; description?: string } | undefined
    assert.deepEqual(role?.enum, ['user', 'assistant', 'tool', 'any'])
    assert.match(role?.description ?? '', /近似/)
    assert.match(f.description ?? '', /lastTime/, '时间降级口径应在描述注明')
    assert.equal((f.properties?.sinceMs as { type?: string } | undefined)?.type, 'integer')
    assert.equal((f.properties?.untilMs as { type?: string } | undefined)?.type, 'integer')
  })

  it('role=user：FTS 与 worker 回退结果一致（消息级，只留用户消息命中）', async () => {
    const now = Date.now()
    const envFTS = await setup({ ftsEnabled: true, sessions: roleCorpus(now) })
    const envWorker = await setup({ ftsEnabled: false, sessions: roleCorpus(now) })
    await waitFtsReady(envFTS, 4)
    const r1 = await envFTS.tools['session_index_search'].execute({ query: 'alpha', mode: 'full', limit: 10, filter: { role: 'user' } })
    const r2 = await envWorker.tools['session_index_search'].execute({ query: 'alpha', mode: 'full', limit: 10, filter: { role: 'user' } })
    assert.deepEqual(setOf(r1), ['session-u'], 'FTS：只留 user 消息命中')
    assert.deepEqual(setOf(r2), setOf(r1), 'worker 回退与 FTS 结果一致')
  })

  it('role=assistant：FTS 与 worker 回退结果一致（只留助手消息命中）', async () => {
    const now = Date.now()
    const envFTS = await setup({ ftsEnabled: true, sessions: roleCorpus(now) })
    const envWorker = await setup({ ftsEnabled: false, sessions: roleCorpus(now) })
    await waitFtsReady(envFTS, 4)
    const r1 = await envFTS.tools['session_index_search'].execute({ query: 'alpha', mode: 'full', limit: 10, filter: { role: 'assistant' } })
    const r2 = await envWorker.tools['session_index_search'].execute({ query: 'alpha', mode: 'full', limit: 10, filter: { role: 'assistant' } })
    assert.deepEqual(setOf(r1), ['session-a'])
    assert.deepEqual(setOf(r2), setOf(r1), 'worker 回退与 FTS 结果一致')
  })

  it('role=tool：FTS 与 worker 回退结果一致（tool_name 非空判定；worker 侧首次支持工具行命中）', async () => {
    const now = Date.now()
    const envFTS = await setup({ ftsEnabled: true, sessions: roleCorpus(now) })
    const envWorker = await setup({ ftsEnabled: false, sessions: roleCorpus(now) })
    await waitFtsReady(envFTS, 4)
    const r1 = await envFTS.tools['session_index_search'].execute({ query: 'alpha', mode: 'full', limit: 10, filter: { role: 'tool' } })
    const r2 = await envWorker.tools['session_index_search'].execute({ query: 'alpha', mode: 'full', limit: 10, filter: { role: 'tool' } })
    assert.deepEqual(setOf(r1), ['session-t'], 'FTS：tool 判定 = tool_name 非空（tool 名命中）')
    assert.deepEqual(setOf(r2), setOf(r1), 'worker 回退工具行命中与 FTS 一致（Part B 新增能力）')
  })

  it('role=any：FTS 与 worker 回退结果一致（默认不过滤，user/assistant/tool 全收）', async () => {
    const now = Date.now()
    const envFTS = await setup({ ftsEnabled: true, sessions: roleCorpus(now) })
    const envWorker = await setup({ ftsEnabled: false, sessions: roleCorpus(now) })
    await waitFtsReady(envFTS, 4)
    const r1 = await envFTS.tools['session_index_search'].execute({ query: 'alpha', mode: 'full', limit: 10, filter: { role: 'any' } })
    const r2 = await envWorker.tools['session_index_search'].execute({ query: 'alpha', mode: 'full', limit: 10, filter: { role: 'any' } })
    assert.deepEqual(setOf(r1), ['session-a', 'session-t', 'session-u'])
    assert.deepEqual(setOf(r2), setOf(r1), 'worker 回退与 FTS 结果一致')
    // 强相关性（前缀命中）在两条路径都居首；a/t 无 fzy 主干分，相对序不强求
    assert.equal(idsOf(r1)[0], 'session-u', 'FTS：prefix 命中居首')
    assert.equal(idsOf(r2)[0], 'session-u', 'worker：同口径居首')
  })

  it('sinceMs 边界（含等于）：full FTS/worker + meta 三路一致', async () => {
    const now = Date.now()
    const corpus = [
      { name: 'e0', ts: now, title: 'timeev 今天' },
      { name: 'e2', ts: now - 2 * DAY, title: 'timeev 两天前' },
      { name: 'e5', ts: now - 5 * DAY, title: 'timeev 五天前' },
    ]
    const envFTS = await setup({ ftsEnabled: true, sessions: corpus })
    const envWorker = await setup({ ftsEnabled: false, sessions: corpus })
    await waitFtsReady(envFTS, 3)
    const since = now - 2 * DAY // 恰好等于 e2.lastTime → 边界必须包含
    for (const mode of ['full', 'meta'] as const) {
      const r1 = await envFTS.tools['session_index_search'].execute({ query: 'timeev', mode, limit: 10, filter: { sinceMs: since } })
      assert.deepEqual(setOf(r1), ['session-e0', 'session-e2'], `${mode}/FTS：>= sinceMs 含等于边界`)
      const r2 = await envWorker.tools['session_index_search'].execute({ query: 'timeev', mode: 'full', limit: 10, filter: { sinceMs: since } })
      assert.deepEqual(setOf(r2), setOf(r1), 'worker 派发前时间过滤同口径')
    }
  })

  it('untilMs 边界（含等于）：full FTS/worker + meta 三路一致', async () => {
    const now = Date.now()
    const corpus = [
      { name: 'e0', ts: now, title: 'timeev 今天' },
      { name: 'e2', ts: now - 2 * DAY, title: 'timeev 两天前' },
      { name: 'e5', ts: now - 5 * DAY, title: 'timeev 五天前' },
    ]
    const envFTS = await setup({ ftsEnabled: true, sessions: corpus })
    const envWorker = await setup({ ftsEnabled: false, sessions: corpus })
    await waitFtsReady(envFTS, 3)
    const until = now - 2 * DAY // 恰好等于 e2.lastTime → 边界必须包含
    for (const mode of ['full', 'meta'] as const) {
      const r1 = await envFTS.tools['session_index_search'].execute({ query: 'timeev', mode, limit: 10, filter: { untilMs: until } })
      assert.deepEqual(setOf(r1), ['session-e2', 'session-e5'], `${mode}/FTS：<= untilMs 含等于边界`)
      const r2 = await envWorker.tools['session_index_search'].execute({ query: 'timeev', mode: 'full', limit: 10, filter: { untilMs: until } })
      assert.deepEqual(setOf(r2), setOf(r1), 'worker 派发前时间过滤同口径')
    }
  })

  it('sinceMs+untilMs 组合区间：full FTS/worker + meta 一致', async () => {
    const now = Date.now()
    const corpus = [
      { name: 'e0', ts: now, title: 'timeev 今天' },
      { name: 'e2', ts: now - 2 * DAY, title: 'timeev 两天前' },
      { name: 'e5', ts: now - 5 * DAY, title: 'timeev 五天前' },
    ]
    const envFTS = await setup({ ftsEnabled: true, sessions: corpus })
    const envWorker = await setup({ ftsEnabled: false, sessions: corpus })
    await waitFtsReady(envFTS, 3)
    const filter = { sinceMs: now - 3 * DAY, untilMs: now - 1 * DAY }
    for (const mode of ['full', 'meta'] as const) {
      const r1 = await envFTS.tools['session_index_search'].execute({ query: 'timeev', mode, limit: 10, filter })
      assert.deepEqual(setOf(r1), ['session-e2'], `${mode}/FTS：闭区间内只有 e2`)
      const r2 = await envWorker.tools['session_index_search'].execute({ query: 'timeev', mode: 'full', limit: 10, filter })
      assert.deepEqual(setOf(r2), setOf(r1), 'worker 同口径')
    }
  })

  it('meta 模式 role=tool：toolCallCounts>0 会话级近似；user/assistant 不过滤', async () => {
    const now = Date.now()
    const env = await setup({
      ftsEnabled: false,
      sessions: [
        { name: 'x', ts: now, title: 'beta 元数据命中工具会话', userText: '无正文信号', extraEvents: [toolEvent('zzz_tool', now)] },
        { name: 'y', ts: now, title: 'beta 纯元数据命中', userText: '无正文信号' },
      ],
    })
    const rTool = await env.tools['session_index_search'].execute({ query: 'beta', mode: 'meta', limit: 10, filter: { role: 'tool' } })
    assert.deepEqual(setOf(rTool), ['session-x'], 'meta 模式 tool 过滤为会话级近似：仅 toolCallCounts>0 的 x 入选')
    const rUser = await env.tools['session_index_search'].execute({ query: 'beta', mode: 'meta', limit: 10, filter: { role: 'user' } })
    const rAsst = await env.tools['session_index_search'].execute({ query: 'beta', mode: 'meta', limit: 10, filter: { role: 'assistant' } })
    const rAny = await env.tools['session_index_search'].execute({ query: 'beta', mode: 'meta', limit: 10, filter: { role: 'any' } })
    assert.deepEqual(setOf(rUser), ['session-x', 'session-y'], 'meta 模式 user 无消息粒度 → 不过滤（等价 any）')
    assert.deepEqual(setOf(rAsst), ['session-x', 'session-y'], 'meta 模式 assistant 同不过滤')
    assert.deepEqual(setOf(rAny), ['session-x', 'session-y'])
  })

  it('full 模式 + role∈{user,assistant}：meta 补充贡献跳过（元数据-only 命中不冒充）', async () => {
    const now = Date.now()
    const corpus = [
      { name: 'm1', ts: now, title: 'titlehit 只有标题命中', userText: '正文无信号' },
      { name: 'm2', ts: now, title: 'titlehit 标题与正文都有', userText: 'titlehit 也出现在用户正文' },
    ]
    const envFTS = await setup({ ftsEnabled: true, sessions: corpus })
    const envWorker = await setup({ ftsEnabled: false, sessions: corpus })
    await waitFtsReady(envFTS, 2)
    const rUserF = await envFTS.tools['session_index_search'].execute({ query: 'titlehit', mode: 'full', limit: 10, filter: { role: 'user' } })
    assert.deepEqual(setOf(rUserF), ['session-m2'], 'FTS：m1 仅标题命中 → 不冒充用户消息命中')
    const rUserW = await envWorker.tools['session_index_search'].execute({ query: 'titlehit', mode: 'full', limit: 10, filter: { role: 'user' } })
    assert.deepEqual(setOf(rUserW), ['session-m2'], 'worker 同口径')
    const rAny = await envFTS.tools['session_index_search'].execute({ query: 'titlehit', mode: 'full', limit: 10 })
    assert.deepEqual(setOf(rAny), ['session-m1', 'session-m2'], 'any（不带 filter）时 m1 仍经 meta 补充入选（回归）')
  })

  it('默认 any 回归：不带 filter / filter={} / filter={role:any} 输出完全一致', async () => {
    const now = Date.now()
    const env = await setup({ ftsEnabled: true, sessions: roleCorpus(now) })
    await waitFtsReady(env, 4)
    const no = await env.tools['session_index_search'].execute({ query: 'alpha', mode: 'full', limit: 10 })
    const empty = await env.tools['session_index_search'].execute({ query: 'alpha', mode: 'full', limit: 10, filter: {} })
    const any = await env.tools['session_index_search'].execute({ query: 'alpha', mode: 'full', limit: 10, filter: { role: 'any' } })
    assert.deepEqual(empty, no, 'filter={} 与不带 filter 完全一致')
    assert.deepEqual(any, no, 'filter={role:any} 与不带 filter 完全一致')
  })

  it('render 回显 filter 生效情况；零命中静态提示保留（不新增教学文字）', async () => {
    const now = Date.now()
    const env = await setup({ ftsEnabled: true, sessions: roleCorpus(now) })
    await waitFtsReady(env, 4)
    const tool = env.tools['session_index_search'] as Tool & { output?: { render(args: unknown, v: unknown): unknown[] } }
    assert.ok(tool.output?.render, 'ToolDefinition 应暴露 output.render')
    // 零命中 + filter：一行回显 + 既有零命中提示
    const zero = await env.tools['session_index_search'].execute({ query: 'zzznohit', mode: 'full', limit: 10, filter: { role: 'tool' } })
    const blocks = tool.output!.render({ query: 'zzznohit', mode: 'full', filter: { role: 'tool' } }, zero)
    const out = (blocks ?? []).map((b: any) => (b?.type === 'text' ? b.text : '')).join('\n')
    assert.match(out, /filter: role=tool/, 'render 回显 filter 生效情况')
    assert.match(out, /零命中/, '零命中静态提示保留')
    // without filter：不出现 filter 行、提示仍在
    const zero2 = await env.tools['session_index_search'].execute({ query: 'zzznohit', mode: 'full', limit: 10 })
    const out2 = (tool.output!.render({ query: 'zzznohit', mode: 'full' }, zero2) ?? [])
      .map((b: any) => (b?.type === 'text' ? b.text : ''))
      .join('\n')
    assert.ok(!/filter:/.test(out2), '不带 filter 不回显 filter 行')
    assert.match(out2, /零命中/)
  })
})
