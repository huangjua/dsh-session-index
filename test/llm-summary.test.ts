/**
 * llm-summary.test.ts — STAGE-4：可选 LLM 一句话摘要（单元层）
 *
 * 覆盖（DI 注入 fake provider，不触碰宿主服务）：
 * - buildLlmPrompt：字段完整性 + 禁全文（各段码点上限）+ counts/tools 截断；
 * - 输入 token 预算：构造超长会话仍 ≤ PROMPT_MAX_CHARS 且 estimateTokens ≤ 1200；
 * - truncateUnicode：80 码点截断（含 emoji / 中文）；
 * - 缓存：指纹命中零调用 / 指纹失效再生成 / 容错读 + 同 session 最新行胜出；
 * - 失败：fail-open（无 summary、lastError、不缓存、health.ok=false、不重试）；
 * - 并发单飞：同 session 在飞复用（调用计数 = 1）；
 * - 开关：llmSummaryEnabled=false 完全零执行（不碰缓存与 provider）；
 * - provider=null：fail-open 确定性回退。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildLlmPrompt,
  truncateUnicode,
  estimateTokens,
  readSummaryCache,
  appendSummaryEntry,
  createLlmSummaryService,
  createHostLlmProvider,
  normalizeSummaryEntry,
  parseSummaryLines,
  SUMMARY_CHAR_CAP,
  PROMPT_MAX_CHARS,
  PROMPT_TOKEN_BUDGET,
  PROMPT_TITLE_CAP,
  PROMPT_FIRST_USER_CAP,
  PROMPT_LAST_ASSISTANT_CAP,
  PROMPT_COUNTS_TOP,
  PROMPT_TOOL_TOP,
  SUMMARY_CACHE_VERSION,
} from '../src/llm-summary.js'
import type { SessionMeta } from '../src/core.js'
import type { LlmSummaryProvider } from '../src/llm-summary.js'

const bases: string[] = []
after(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true })
})

async function tmpCache(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-llsum-'))
  bases.push(base)
  return join(base, 'llm-summary.jsonl')
}

/** 最小 SessionMeta（只填充摘要相关字段；其余取缺省） */
function makeMeta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'session-test',
    file: 'E:/sessions/session-test/session.jsonl.zstd',
    workspace: 'E:/work',
    size: 1234,
    mtimeMs: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    lastTime: 1_700_000_360_000,
    title: '示例会话',
    firstUserText: '用户第一条消息',
    lastAssistantText: '助手最后一条消息',
    agentPreset: 'router-flash',
    counts: { 'user/message': 5, 'assistant/message': 4, 'tool/call': 3 },
    toolNames: ['web_search'],
    toolCallCounts: { web_search: 3 },
    ...over,
  }
}

/** 计数型 fake provider：记录调用次数与收到的 prompt，行为可注入。 */
function makeFake(
  impl?: (prompt: string, signal: AbortSignal | undefined) => Promise<string>,
): { provider: LlmSummaryProvider; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    provider: {
      providerId: 'fake-provider',
      summarize: async (prompt, signal) => {
        calls.push(prompt)
        return impl ? impl(prompt, signal) : '一句话：该会话围绕示例任务展开。'
      },
    },
  }
}

function serviceAt(cacheFile: string, provider: LlmSummaryProvider | null, enabled = true, now = () => 1_800_000_000_000) {
  return createLlmSummaryService({ enabled, provider, cacheFile, now })
}

describe('buildLlmPrompt（确定性输入构造）', () => {
  it('字段完整性：title/firstUser/lastAssistant/counts top8/toolCallCounts top5/时间跨度齐全', () => {
    const meta = makeMeta({
      counts: {
        'user/message': 9, 'assistant/message': 8, 'tool/call': 7, 'tool/result': 6,
        'agent/step': 5, 'session/title-updated': 4, 'compaction/start': 3, 'compaction/end': 2, 'rare': 1,
      },
      toolCallCounts: { web_search: 9, read: 8, write: 7, edit: 6, grep: 5, glob: 4 },
    })
    const p = buildLlmPrompt(meta)
    for (const f of ['会话标题：示例会话', '用户首条消息', '助手末条消息', '事件统计', '工具调用', '时间跨度', '2023-11-14T22:13:20.000Z', '360s']) {
      assert.ok(p.includes(f), `prompt 应包含 ${f}:\n${p}`)
    }
    // counts top8：9 类只取前 8，被挤出的是 count=1 的 rare
    assert.ok(!p.includes('rare'), 'counts 应截断到前 8 类（rare 剔除）')
    // toolCallCounts top5：6 个只取前 5，被挤出的是 count=4 的 glob
    assert.ok(!p.includes('glob'), 'toolCallCounts 应截断到 top5（glob 剔除）')
    assert.ok(p.includes('web_search×9'), '工具条目应含次数')
  })

  it('禁全文：firstUser 只取前 200 码点、lastAssistant 只取前 500 码点、title 只取前 120', () => {
    const longUser = '用'.repeat(PROMPT_FIRST_USER_CAP) + '用户中段泄漏标记' + '用'.repeat(80)
    const longAssistant = '助'.repeat(PROMPT_LAST_ASSISTANT_CAP) + '助手中段泄漏标记' + '助'.repeat(300)
    const longTitle = '题'.repeat(PROMPT_TITLE_CAP) + '标题中段泄漏标记' + '题'.repeat(50)
    const p = buildLlmPrompt(makeMeta({ title: longTitle, firstUserText: longUser, lastAssistantText: longAssistant }))
    assert.ok(p.includes(longUser.slice(0, PROMPT_FIRST_USER_CAP)), '应含 firstUser 前 200')
    assert.ok(p.includes(longAssistant.slice(0, PROMPT_LAST_ASSISTANT_CAP)), '应含 lastAssistant 前 500')
    assert.ok(p.includes(longTitle.slice(0, PROMPT_TITLE_CAP)), '应含 title 前 120')
    // 禁全文：截断点之后的内容不得进入 prompt
    assert.ok(!p.includes('用户中段泄漏标记'), '禁全文：firstUser 第 200 码点之后不得出现')
    assert.ok(!p.includes('助手中段泄漏标记'), '禁全文：lastAssistant 第 500 码点之后不得出现')
    assert.ok(!p.includes('标题中段泄漏标记'), '禁全文：title 第 120 码点之后不得出现')
  })

  it('输入 token 预算：构造超长会话仍 ≤ PROMPT_MAX_CHARS 且 estimateTokens ≤ 1200', () => {
    const counts: Record<string, number> = {}
    const tools: Record<string, number> = {}
    for (let i = 0; i < 30; i++) {
      counts[`type/${'k'.repeat(30)}${i}`] = 100 - i
      tools[`tool/${'t'.repeat(36)}${i}`] = 100 - i
    }
    const meta = makeMeta({
      title: '题'.repeat(PROMPT_TITLE_CAP + 999),
      firstUserText: '用'.repeat(PROMPT_FIRST_USER_CAP + 999),
      lastAssistantText: '助'.repeat(PROMPT_LAST_ASSISTANT_CAP + 999),
      counts,
      toolCallCounts: tools,
    })
    const p = buildLlmPrompt(meta)
    assert.ok(p.length <= PROMPT_MAX_CHARS, `prompt 长度 ${p.length} 应 ≤ ${PROMPT_MAX_CHARS}`)
    assert.ok(estimateTokens(p) <= PROMPT_TOKEN_BUDGET, `estimateTokens=${estimateTokens(p)} 应 ≤ ${PROMPT_TOKEN_BUDGET}`)
  })

  it('estimateTokens 粗估口径：长 ASCII 段按 4 字符/token 上界', () => {
    const ascii = 'a'.repeat(400)
    assert.equal(estimateTokens(ascii), 100)
    assert.equal(estimateTokens('中文中文'), 3) // 4 个 CJK 字符 / 1.5 = ceil(2.67) = 3
  })
})

describe('truncateUnicode（≤80 字输出双保险）', () => {
  it('80 码点截断：中英混排 + emoji 不拆代理对', () => {
    const s = '🔍'.repeat(30) + '对话'.repeat(30) + 'tail'
    const t = truncateUnicode(s, SUMMARY_CHAR_CAP)
    assert.equal([...t].length, SUMMARY_CHAR_CAP, '截断后应为 80 个码点')
    assert.ok(!t.includes('tail'), '超长部分应被截掉')
    assert.equal(truncateUnicode('短句', SUMMARY_CHAR_CAP), '短句')
  })
})

describe('缓存 sidecar（append-only + 指纹 + 容错读）', () => {
  it('指纹命中零调用：同 fingerprint 第二次走缓存', async () => {
    const cache = await tmpCache()
    const { provider, calls } = makeFake()
    const svc = serviceAt(cache, provider)
    const meta = makeMeta()
    const fp = { size: meta.size, mtimeMs: meta.mtimeMs }
    const r1 = await svc.getSummary(meta, fp)
    assert.equal(r1.summary, '一句话：该会话围绕示例任务展开。')
    assert.equal(r1.cached, false)
    assert.equal(calls.length, 1)
    const r2 = await svc.getSummary(meta, fp)
    assert.equal(r2.summary, r1.summary)
    assert.equal(r2.cached, true, '第二次应命中缓存')
    assert.equal(calls.length, 1, '命中缓存 = 零调用')
    const h = await svc.health()
    assert.equal(h.cached, 1)
    assert.equal(h.ok, true)
    assert.equal(h.lastError, null)
    assert.equal(h.provider, 'fake-provider')
  })

  it('指纹失效再生成：size/mtimeMs 变化 → 重新调用', async () => {
    const cache = await tmpCache()
    const { provider, calls } = makeFake()
    const svc = serviceAt(cache, provider)
    const meta = makeMeta()
    await svc.getSummary(meta, { size: meta.size, mtimeMs: meta.mtimeMs })
    assert.equal(calls.length, 1)
    const r2 = await svc.getSummary(meta, { size: meta.size + 1, mtimeMs: meta.mtimeMs + 1 })
    assert.equal(r2.cached, false, '指纹变化应重新生成')
    assert.equal(calls.length, 2)
    const { entries } = await readSummaryCache(cache)
    assert.equal(entries.length, 1, '同 sessionId 只保留最新行')
    assert.equal(entries[0].mtimeMs, meta.mtimeMs + 1)
  })

  it('容错读 + 最新胜出：坏行跳过，同 sessionId 后写覆盖先写', async () => {
    const cache = await tmpCache()
    const old = { v: SUMMARY_CACHE_VERSION, sessionId: 'session-test', file: 'f1', size: 1, mtimeMs: 1, summary: '旧', createdAt: 1 }
    const fresh = { ...old, size: 2, mtimeMs: 2, summary: '新', createdAt: 2 }
    await writeFile(cache, `{bad json}\n${JSON.stringify(old)}\n${JSON.stringify(fresh)}\n`, 'utf8')
    const parsed = parseSummaryLines(`{bad json}\n${JSON.stringify(old)}\n${JSON.stringify(fresh)}\n`)
    assert.equal(parsed.skippedBad, 1)
    assert.equal(parsed.entries.length, 1)
    assert.equal(parsed.entries[0].summary, '新', '最新行胜出')
    assert.ok(normalizeSummaryEntry({ v: 2, sessionId: 'x' }) === null, 'v!==1 拒收')
    // 服务层：命中最新行 → 零调用
    const { provider, calls } = makeFake()
    const svc = serviceAt(cache, provider)
    const r = await svc.getSummary(makeMeta({ file: 'f1', size: 2, mtimeMs: 2 }), { size: 2, mtimeMs: 2 })
    assert.equal(r.summary, '新')
    assert.equal(r.cached, true)
    assert.equal(calls.length, 0)
  })

  it('append 追加成型：行结构完整可回读', async () => {
    const cache = await tmpCache()
    const entry = { v: SUMMARY_CACHE_VERSION, sessionId: 's1', file: 'f', size: 10, mtimeMs: 20, summary: '一句话', createdAt: 30 }
    await appendSummaryEntry(cache, entry)
    const { entries } = await readSummaryCache(cache)
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0], entry)
  })
})

describe('createLlmSummaryService（fail-open + 护栏）', () => {
  it('createHostLlmProvider：属性访问被 cordis 守卫拦截（抛 cannot get without inject）→ 经 ctx.get 免注入兜底', async () => {
    const runtime = {
      listProviders: () => [{ id: 'deepseek-official', name: 'd' }],
      listModels: async () => [{ id: 'fake-model', name: 'fake-model' }],
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '一句话' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    // 模拟 cordis 守卫：ctx.llm 属性访问抛错；ctx.get('llm') 返回运行时
    const guardedCtx = { get: (name: string) => (name === 'llm' ? runtime : undefined) } as never
    Object.defineProperty(guardedCtx as object, 'llm', {
      get() {
        throw new Error('cannot get property "llm" without inject')
      },
    })
    const reasons: string[] = []
    const provider = createHostLlmProvider(guardedCtx as never, (r) => reasons.push(r))
    assert.ok(provider, 'ctx.get 兜底应解析出 provider')
    assert.equal(provider!.providerId, 'deepseek-official')
    assert.equal(reasons.length, 0)
    assert.equal(await provider!.summarize('p', undefined), '一句话')
  })

  it('createHostLlmProvider：无 llm 服务 → null + 回调携带原因（fail-open）', () => {
    const reasons: string[] = []
    const provider = createHostLlmProvider({} as never, (r) => reasons.push(r))
    assert.equal(provider, null)
    assert.ok(reasons.length >= 1)
    assert.match(reasons[0], /不可用/)
  })

  it('失败回退：无 summary + lastError + health.ok=false + 不缓存（下次仍调用，无重试）', async () => {
    const cache = await tmpCache()
    const { provider, calls } = makeFake(async () => {
      throw new Error('provider boom')
    })
    const svc = serviceAt(cache, provider)
    const meta = makeMeta()
    const fp = { size: meta.size, mtimeMs: meta.mtimeMs }
    const r1 = await svc.getSummary(meta, fp)
    assert.equal(r1.summary, undefined, '失败不得产出 llmSummary')
    assert.ok(r1.lastError?.includes('provider boom'))
    assert.equal(calls.length, 1)
    assert.equal(existsSync(cache), false, '失败不写缓存')
    const h = await svc.health()
    assert.equal(h.ok, false)
    assert.equal(h.cached, 0)
    assert.ok(h.lastError?.includes('provider boom'))
    // 下一次请求可再试（失败不缓存 ≠ 永久禁用）；单次调用内不重试（calls 每次 +1）
    const r2 = await svc.getSummary(meta, fp)
    assert.equal(r2.summary, undefined)
    assert.equal(calls.length, 2)
  })

  it('成功后再失败：健康快照 lastError 更新，已成功缓存不被失败污染', async () => {
    const cache = await tmpCache()
    let fail = false
    const { provider, calls } = makeFake(async () => {
      if (fail) throw new Error('later boom')
      return '先成功'
    })
    const svc = serviceAt(cache, provider)
    const meta = makeMeta()
    const fp = { size: meta.size, mtimeMs: meta.mtimeMs }
    assert.equal((await svc.getSummary(meta, fp)).summary, '先成功')
    fail = true
    const r2 = await svc.getSummary(meta, { size: fp.size + 9, mtimeMs: fp.mtimeMs })
    assert.equal(r2.summary, undefined)
    assert.ok(r2.lastError?.includes('later boom'))
    assert.equal(calls.length, 2)
    const h = await svc.health()
    assert.equal(h.ok, false)
    assert.ok(h.lastError?.includes('later boom'))
    const { entries } = await readSummaryCache(cache)
    assert.equal(entries.length, 1, '失败的调用不写缓存，成功的行保留')
  })

  it('并发单飞：同 session 并发两次 → 只发一次模型调用', async () => {
    const cache = await tmpCache()
    let inflight = 0
    let maxInflight = 0
    const { provider, calls } = makeFake(async () => {
      inflight++
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise((r) => setTimeout(r, 40))
      inflight--
      return '单飞'
    })
    const svc = serviceAt(cache, provider)
    const meta = makeMeta()
    const fp = { size: meta.size, mtimeMs: meta.mtimeMs }
    const [a, b] = await Promise.all([svc.getSummary(meta, fp), svc.getSummary(meta, fp)])
    assert.equal(calls.length, 1, '并发单飞：调用计数应为 1')
    assert.equal(maxInflight, 1)
    assert.equal(a.summary, '单飞')
    assert.equal(b.summary, '单飞')
    // 信号：service 传 undefined，host provider 自管 10s 超时（成本护栏在 host 内）
    assert.equal((await svc.health()).cached, 1)
  })

  it('enabled=false 完全零执行：不读不写缓存、provider 零调用、health 关态', async () => {
    const cache = await tmpCache()
    const { provider, calls } = makeFake()
    const svc = serviceAt(cache, provider, false)
    const r = await svc.getSummary(makeMeta(), { size: 1, mtimeMs: 1 })
    assert.equal(r.summary, undefined)
    assert.equal(r.cached, false)
    assert.equal(calls.length, 0, '关闭时零调用')
    assert.equal(existsSync(cache), false, '关闭时不创建缓存文件')
    const h = await svc.health()
    assert.equal(h.enabled, false)
    assert.equal(h.ok, false)
    assert.equal(h.cached, 0)
    assert.equal(h.provider, '')
  })

  it('provider=null（宿主决议失败）：确定性回退 + lastError，绝不假实现', async () => {
    const cache = await tmpCache()
    const svc = serviceAt(cache, null, true)
    const r = await svc.getSummary(makeMeta(), { size: 1, mtimeMs: 1 })
    assert.equal(r.summary, undefined, '无 provider 不得产出 llmSummary（fail-open）')
    assert.ok(r.lastError, '应有 lastError')
    const h = await svc.health()
    assert.equal(h.ok, false)
    assert.equal(h.provider, '')
    assert.ok(h.lastError)
    assert.equal(existsSync(cache), false, 'fail-open 不写缓存')
  })

  it('懒解析：provider 以函数注入，首次 getSummary/health 才决议；disabled 不调用 resolver（不触碰 ctx.llm）', async () => {
    const cache = await tmpCache()
    let resolves = 0
    const { provider } = makeFake()
    const svc = createLlmSummaryService({
      enabled: true,
      provider: () => {
        resolves++
        return provider
      },
      cacheFile: cache,
    })
    const h0 = await svc.health()
    assert.equal(h0.provider, 'fake-provider')
    assert.equal(resolves, 1, 'health 首次决议一次')
    const r = await svc.getSummary(makeMeta(), { size: 1, mtimeMs: 1 })
    assert.equal(r.summary, '一句话：该会话围绕示例任务展开。')
    assert.equal(resolves, 2, 'getSummary 再次决议')
    // disabled：完全零执行，resolver 不被调用
    const svc2 = createLlmSummaryService({
      enabled: false,
      provider: () => {
        resolves++
        return provider
      },
      cacheFile: cache,
    })
    await svc2.health()
    await svc2.getSummary(makeMeta(), { size: 1, mtimeMs: 1 })
    assert.equal(resolves, 2, 'disabled 不得调用 resolver（零执行）')
  })

  it('输出截断：provider 返回超长文本 → 结果 ≤80 码点', async () => {
    const cache = await tmpCache()
    const { provider } = makeFake(async () => '长'.repeat(200))
    const svc = serviceAt(cache, provider)
    const r = await svc.getSummary(makeMeta(), { size: 1, mtimeMs: 1 })
    assert.ok(r.summary, '成功应有 summary')
    assert.equal([...r.summary!].length, SUMMARY_CHAR_CAP, '截断到 80 码点')
    assert.equal((await readSummaryCache(cache)).entries[0].summary, r.summary)
  })
})