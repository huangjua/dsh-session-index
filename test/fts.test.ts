/**
 * fts.test.ts — P2 SQLite + FTS5 全文索引
 * 覆盖：全量同步 / delta 追加 / CJK trigram 搜索 / LIKE 兜底（1-2 字）/
 *       latin 搜索 / 会话删除清理 / 会话元数据 join。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionFts, sanitizeFts5Query, normalizeReservedMarkers, excerptAroundMatch, queryUsesLikePath } from '../src/fts.js'
import type { FtsMessageRow, FtsSessionMeta } from '../src/fts.js'

const meta = (file: string, id: string, workspace: string): FtsSessionMeta => ({
  file,
  id,
  workspace,
  title: '标题-' + id,
  agentPreset: 'router-flash',
  createdAt: 1786800000000,
  lastTime: 1786900000000,
})

const rows = (file: string): FtsMessageRow[] => [
  { sessionFile: file, role: 'user', text: 'nginx 反向代理服务器配置详解', toolName: '' },
  { sessionFile: file, role: 'assistant', text: '我们使用反向代理解决跨域问题', toolName: '' },
  { sessionFile: file, role: 'tool', text: '', toolName: 'read' },
]

describe('SessionFts（P2 SQLite + FTS5）', () => {
  let dir = ''
  const ftses: Awaited<ReturnType<typeof createSessionFts>>[] = []

  after(async () => {
    for (const f of ftses) f?.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  async function makeFts(): Promise<NonNullable<Awaited<ReturnType<typeof createSessionFts>>>> {
    if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-fts-'))
    const f = await createSessionFts(join(dir, `fts-${ftses.length}.db`))
    assert.ok(f, 'FTS 应可用（node:sqlite + FTS5）')
    ftses.push(f)
    return f!
  }

  it('全量同步 + CJK trigram 搜索（≥3 字）+ latin', async () => {
    const f = await makeFts()
    f.upsertSession(meta('/s/a/session.jsonl.zstd', 'session-a', 'E:\\Do\\test'))
    f.upsertSession(meta('/s/b/session.jsonl.zstd', 'session-b', 'E:\\Do\\StudyDesk'))
    f.syncMessages('/s/a/session.jsonl.zstd', rows('/s/a/session.jsonl.zstd'), false)
    f.syncMessages('/s/b/session.jsonl.zstd', [{ sessionFile: '/s/b/session.jsonl.zstd', role: 'user', text: 'docker compose 部署 nginx', toolName: '' }], false)
    await f.flush()

    // CJK 子串 ≥3 字 → trigram
    const h1 = await f.search('反向代理', '', 10)
    assert.equal(h1.length, 2, JSON.stringify(h1))
    assert.ok(h1.every((h) => h.snippet.includes('反向代理') || h.text.includes('反向代理')))
    // 会话元数据 join
    assert.ok(h1.some((h) => h.sessionFile.includes('a') && h.workspace.includes('Do\\test')))
    // latin
    const h2 = await f.search('nginx', '', 10)
    assert.equal(h2.length, 2)
    // workspace 过滤（session b 的 nginx 行）
    const h3 = await f.search('nginx', 'studydesk', 10)
    assert.equal(h3.length, 1)
    assert.ok(h3[0].sessionFile.includes('b'))
    assert.equal(h3[0].workspace, 'E:\\Do\\StudyDesk')
  })

  it('LIKE 兜底：1-2 字中文查询不丢语义', async () => {
    const f = await makeFts()
    f.upsertSession(meta('/s/a/session.jsonl.zstd', 'session-a', 'W'))
    f.syncMessages('/s/a/session.jsonl.zstd', rows('/s/a/session.jsonl.zstd'), false)
    await f.flush()
    // "代理" 2 字：trigram 需 ≥3 字 → 走 LIKE 兜底
    const h = await f.search('代理', '', 10)
    assert.equal(h.length, 2, JSON.stringify(h))
    const h2 = await f.search('反代', '', 10) // 2 字子串（"反代"在文本里不连续 → 应无命中）
    assert.equal(h2.length, 0)
  })

  it('C7 LIKE 多词：逐词 AND 命中（旧实现整串匹配必空）+ 零命中 OR 放宽', async () => {
    const f = await makeFts()
    const file = '/s/a/session.jsonl.zstd'
    f.upsertSession(meta(file, 'session-a', 'W'))
    f.syncMessages(file, rows(file), false)
    await f.flush()
    // "nginx 代理"：两词（nginx ≥3 / 代理 2 字）→ LIKE 路径。
    // 旧实现把整串 "nginx 代理" 当单一子串 → 消息里两词不相邻 → 必空；
    // 新实现逐词 AND → "nginx 反向代理服务器配置详解" 同时含两词 → 1 命中。
    const h = await f.search('nginx 代理', '', 10)
    assert.equal(h.length, 1, JSON.stringify(h))
    assert.ok(h[0].text.includes('nginx') && h[0].text.includes('代理'))
    // AND 无交集时（两词分属不同消息）→ 自动 OR 放宽：两条消息各命中一词
    const h2 = await f.search('跨域 配置', '', 10)
    assert.equal(h2.length, 2, JSON.stringify(h2))
  })

  it('delta 追加：旧消息保留 + 新帧追加', async () => {
    const f = await makeFts()
    const file = '/s/a/session.jsonl.zstd'
    f.upsertSession(meta(file, 'session-a', 'W'))
    f.syncMessages(file, rows(file), false) // 全量 3 行
    await f.flush()
    const before = (await f.search('反向代理', '', 10)).length
    assert.equal(before, 2)
    // delta 追加 1 行（模拟新帧）
    f.syncMessages(file, [{ sessionFile: file, role: 'assistant', text: '增量补充的部署说明', toolName: '' }], true)
    await f.flush()
    const after = await f.search('部署说明', '', 10)
    assert.equal(after.length, 1)
    const still = (await f.search('反向代理', '', 10)).length
    assert.equal(still, 2) // 旧消息未丢
    // 全量重建：旧行清空后重插
    f.syncMessages(file, [{ sessionFile: file, role: 'user', text: '全新内容', toolName: '' }], false)
    await f.flush()
    assert.equal((await f.search('反向代理', '', 10)).length, 0)
    assert.equal((await f.search('全新内容', '', 10)).length, 1)
  })

  it('会话删除：消息与 FTS 一并清理', async () => {
    const f = await makeFts()
    const file = '/s/a/session.jsonl.zstd'
    f.upsertSession(meta(file, 'session-a', 'W'))
    f.syncMessages(file, rows(file), false)
    await f.flush()
    assert.equal((await f.search('nginx', '', 10)).length, 1)
    f.removeSession(file)
    await f.flush()
    assert.equal((await f.search('nginx', '', 10)).length, 0)
    assert.equal(f.sessionCount(), 0)
  })

  it('会话 upsert 幂等 + sessionCount', async () => {
    const f = await makeFts()
    const file = '/s/a/session.jsonl.zstd'
    f.upsertSession(meta(file, 'session-a', 'W'))
    f.upsertSession(meta(file, 'session-a', 'W2')) // 覆盖
    assert.equal(f.sessionCount(), 1)
    f.upsertSession(meta('/s/b/session.jsonl.zstd', 'session-b', 'W'))
    assert.equal(f.sessionCount(), 2)
  })

  it('P3 SCROLL：around 返回锚点窗口 + bookends', async () => {
    const f = await makeFts()
    const file = '/s/a/session.jsonl.zstd'
    f.upsertSession(meta(file, 'session-a', 'W'))
    const msgs: FtsMessageRow[] = Array.from({ length: 9 }, (_, i) => ({
      sessionFile: file,
      role: i % 2 === 0 ? 'user' : 'assistant',
      text: `第${i + 1}条消息内容`,
      toolName: '',
    }))
    f.syncMessages(file, msgs, false)
    await f.flush()

    // 锚点 = 第 5 条（id=5），window=2 → 覆盖 id 3..7
    const sc = await f.around('session-a', 5, 2)
    assert.equal(sc.ok, true)
    assert.equal(sc.messages.length, 5)
    assert.equal(sc.messages[0].id, 3)
    assert.equal(sc.messages[4].id, 7)
    assert.ok(sc.messages.some((m) => m.id === 5))
    // bookends：首 3 + 尾 3
    assert.equal(sc.bookends.start.length, 3)
    assert.equal(sc.bookends.end.length, 3)
    assert.equal(sc.bookends.start[0].id, 1)
    assert.equal(sc.bookends.end[2].id, 9)
    // 锚点越界 → 仍返回窗口内存在的数据
    const sc2 = await f.around('session-a', 1, 2)
    assert.equal(sc2.ok, true)
    assert.equal(sc2.messages.length, 3) // id 1..3
    // 不存在会话 → ok=false
    const sc3 = await f.around('session-nope', 5, 2)
    assert.equal(sc3.ok, false)
  })

  it('P3 lineage：命中携带 lineageRoot（parent_session || 自身 id）', async () => {
    const f = await makeFts()
    // 子代理会话（有 parent_session）
    f.upsertSession({ ...meta('/s/c/session.jsonl.zstd', 'session-c', 'W'), parentSession: 'session-root' })
    f.syncMessages('/s/c/session.jsonl.zstd', [{ sessionFile: '/s/c/session.jsonl.zstd', role: 'assistant', text: '子代理也提到反向代理部署', toolName: '' }], false)
    // 根会话
    f.upsertSession(meta('/s/r/session.jsonl.zstd', 'session-root', 'W'))
    f.syncMessages('/s/r/session.jsonl.zstd', [{ sessionFile: '/s/r/session.jsonl.zstd', role: 'assistant', text: '根会话提到反向代理方案', toolName: '' }], false)
    await f.flush()
    const hits = await f.search('反向代理', '', 10)
    assert.equal(hits.length, 2)
    const child = hits.find((h) => h.sessionId === 'session-c')!
    const root = hits.find((h) => h.sessionId === 'session-root')!
    assert.equal(child.lineageRoot, 'session-root') // 子代理归并到父
    assert.equal(root.lineageRoot, 'session-root')
    // 顶层会话（无 parent_session）→ lineageRoot = 自身
    f.upsertSession(meta('/s/t/session.jsonl.zstd', 'session-top', 'W'))
    f.syncMessages('/s/t/session.jsonl.zstd', [{ sessionFile: '/s/t/session.jsonl.zstd', role: 'user', text: '独立会话提到反向代理', toolName: '' }], false)
    await f.flush()
    const t = (await f.search('反向代理', '', 10)).find((h) => h.sessionId === 'session-top')!
    assert.equal(t.lineageRoot, 'session-top')
  })

  it('P1.3 净化：未配对引号查询不报错、悬空 AND/OR 被清', async () => {
    const f = await makeFts()
    const file = '/s/q/session.jsonl.zstd'
    f.upsertSession(meta(file, 'session-q', 'W'))
    f.syncMessages(file, rows(file), false)
    await f.flush()
    // 未配对引号：sanitize 移除后仍命中（此前整体失配）
    const h1 = await f.search('"反向代理', '', 10)
    assert.equal(h1.length, 2, JSON.stringify(h1))
    // 悬空 AND / OR：去首尾布尔算子
    const h2 = await f.search('反向代理 AND', '', 10)
    assert.equal(h2.length, 2, JSON.stringify(h2))
    const h3 = await f.search('OR 反向代理', '', 10)
    assert.equal(h3.length, 2, JSON.stringify(h3))
  })

  it('P1.3 净化：连字符词 a-b 可命中；AND 零命中 → OR 重试', async () => {
    const f = await makeFts()
    const file = '/s/q/session.jsonl.zstd'
    f.upsertSession(meta(file, 'session-q', 'W'))
    f.syncMessages(file, [
      { sessionFile: file, role: 'user', text: '错误码 a-b 需要查询文档', toolName: '' },
      { sessionFile: file, role: 'assistant', text: '单独提到 nginx 配置', toolName: '' },
    ], false)
    await f.flush()
    // 连字符词被 sanitize 加引号 → 词级引号剥离后 trigram 精确短语 a-b
    const h1 = await f.search('a-b', '', 10)
    assert.equal(h1.length, 1, JSON.stringify(h1))
    assert.ok(h1[0].snippet.includes('a-b'))
    // AND 零命中（a-b 与 nginx 不在同一行）→ OR 各词并列重试命中 2 行
    const h2 = await f.search('a-b nginx', '', 10)
    assert.equal(h2.length, 2, JSON.stringify(h2))
  })

  it('P1.4 命中标记：snippet 含 >>> <<<；正文已有 >>> 入库归一化不串位', async () => {
    const f = await makeFts()
    const file = '/s/m/session.jsonl.zstd'
    f.upsertSession(meta(file, 'session-m', 'W'))
    f.syncMessages(file, [
      { sessionFile: file, role: 'user', text: '结果 >>> 完成 <<< 部署反向代理', toolName: '' },
      { sessionFile: file, role: 'assistant', text: '反向代理在运行', toolName: '' },
    ], false)
    await f.flush()
    const hits = await f.search('反向代理', '', 10)
    assert.equal(hits.length, 2)
    // 含原文标记的行：入库后 >>> → »，snippet 再包唯一一对 >>> <<<
    const marked = hits.find((h) => h.text.includes('»'))
    assert.ok(marked, '原始 >>> 已被归一化为 »')
    assert.ok(marked!.snippet.includes('>>>反向代理<<<'), marked!.snippet)
    assert.ok(!marked!.snippet.includes('>>> 完成'), marked!.snippet)
    // LIKE 兜底路径同样带标记
    const like = await f.search('代理', '', 10)
    assert.equal(like.length, 2)
    assert.ok(like[0].snippet.includes('>>>') && like[0].snippet.includes('<<<'), like[0].snippet)
  })

  it('P1.3 净化：结构字符查询不报错；纯布尔查询路由为空', async () => {
    const f = await makeFts()
    const file = '/s/q/session.jsonl.zstd'
    f.upsertSession(meta(file, 'session-q', 'W'))
    f.syncMessages(file, [{ sessionFile: file, role: 'user', text: 'nginx: 部署(1) 完成', toolName: '' }], false)
    await f.flush()
    const h1 = await f.search('nginx:', '', 10) // : 被清 → nginx
    assert.equal(h1.length, 1, JSON.stringify(h1))
    // () 被清 → 词 [部署, 1]。旧实现按整串 "部署 1" 匹配 → 0（漏召）；
    // C7 起 LIKE 逐词 AND → 正文 "nginx: 部署(1) 完成" 同时含两词 → 1 命中（更贴合意图）。
    const h2 = await f.search('部署(1)', '', 10)
    assert.equal(h2.length, 1, JSON.stringify(h2))
    const h3 = await f.search('AND OR NOT', '', 10) // 全悬空布尔 → 空查询 → 0
    assert.equal(h3.length, 0)
  })

  it('P1.3/P1.4 单元：sanitizeFts5Query 净化语义 + normalizeReservedMarkers 幂等', () => {
    assert.equal(sanitizeFts5Query('"反'), '反') // 未配对引号去除
    assert.equal(sanitizeFts5Query('nginx AND'), 'nginx') // 尾悬空布尔清除
    assert.equal(sanitizeFts5Query('OR nginx'), 'nginx') // 首悬空布尔清除
    assert.equal(sanitizeFts5Query('a-b c'), '"a-b" c') // 连字符词加引号
    assert.equal(sanitizeFts5Query('foo:bar'), 'foo bar') // 结构字符 → 空格
    assert.equal(normalizeReservedMarkers('a >>> b <<< c'), 'a » b « c')
    assert.equal(normalizeReservedMarkers(normalizeReservedMarkers('a >>> b')), 'a » b') // 幂等
  })

  it('STAGE-5 单元：queryUsesLikePath 判定短词 LIKE 慢路径（与 search() 路由同源）', () => {
    assert.equal(queryUsesLikePath('优化'), true)      // 1-2 字中文 → LIKE
    assert.equal(queryUsesLikePath('优化 方案'), true) // 含 2 字词 → LIKE
    assert.equal(queryUsesLikePath('调研方案'), false) // ≥3 字 → trigram
    assert.equal(queryUsesLikePath('会话索引'), false)
    assert.equal(queryUsesLikePath('rank'), false)     // 4 字母 → trigram
    assert.equal(queryUsesLikePath('ran'), false)      // 3 字母（trigram 下限）→ trigram
    assert.equal(queryUsesLikePath('ab'), true)        // 2 字母 → LIKE
    assert.equal(queryUsesLikePath(''), false)         // 空查询 → 非慢路径
    assert.equal(queryUsesLikePath('"优化"'), true)    // 引号短词剥引号后仍 2 字 → LIKE
    assert.equal(queryUsesLikePath('nginx AND'), false) // 净化后仅 nginx（5 字）→ trigram
  })

  it('P1.4 excerptAroundMatch 直接标记命中区间；无命中不加标记', () => {
    const s = excerptAroundMatch('我们使用反向代理解决跨域问题', '反向代理', 48, 96)
    assert.ok(s.includes('>>>反向代理<<<'), s)
    assert.ok(s.startsWith('我们使用'), s)
    const s2 = excerptAroundMatch('abc def', 'xyz', 8, 8)
    assert.ok(!s2.includes('>>>') && !s2.includes('<<<'), s2)
  })

  it('P3 watermark：markPruned/lastPruneAt/lastPruneCount 往返 + health 暴露', async () => {
    const f = await makeFts()
    assert.equal(f.lastPruneAt(), 0) // 未执行过 → 0
    assert.equal(f.lastPruneCount(), 0)
    f.markPruned(7) // 同步记账，无需 flush
    assert.ok(Math.abs(f.lastPruneAt() - Date.now()) < 5000, String(f.lastPruneAt()))
    assert.equal(f.lastPruneCount(), 7)
    const h = f.health()
    assert.equal(h.lastPruneCount, 7)
    assert.ok(h.lastPruneAt > 0)
    // 覆盖写：再次 markPruned 更新计数
    f.markPruned(0)
    assert.equal(f.lastPruneCount(), 0)
    assert.ok(f.lastPruneAt() > 0)
  })
})
