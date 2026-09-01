/**
 * core.test.ts — 保留的旧纯函数回归（parseSession / metaMatch / summarize / 扫描）
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseSession,
  decompressZstd,
  metaMatch,
  findSession,
  summarizeSession,
  findSessionFiles,
  scanSessionFiles,
  loadIndex,
  buildIndexSync,
  parseCursor,
  formatCursor,
  cursorStartIndex,
  type SessionMeta,
} from '../src/core.js'

const SAMPLE_JSONL = fileURLToPath(new URL('../../test/fixtures/sample-session.jsonl', import.meta.url))
const SAMPLE_ZSTD = fileURLToPath(new URL('../../test/fixtures/sample-session.jsonl.zstd', import.meta.url))

describe('parseSession（旧实现回归）', () => {
  it('解析真实会话：元数据/计数/工具/文本', () => {
    const parsed = parseSession(decompressZstd(SAMPLE_ZSTD))
    assert.equal(parsed.id, 'session-2ed36ab1-3693-4ecd-9724-3f8af2ee8450')
    assert.equal(parsed.createdAt, 1786831711203)
    assert.equal(parsed.cwd, 'E:\\Do\\test')
    assert.equal(parsed.agentPreset, 'router-flash')
    assert.equal(parsed.title, '参考这个"E:\\Do\\test\\gemini-code-merg')
    assert.ok(parsed.firstUserText.includes('gemini-code-merged.html'))
    assert.equal(parsed.counts['user/message'], 2)
    assert.equal(parsed.counts['session/title'], 1)
  })
})

describe('metaMatch / findSession / summarizeSession', () => {
  const meta: SessionMeta = {
    id: 'session-abc',
    file: 'C:/x/session-abc/session.jsonl.zstd',
    workspace: 'C:\\work\\StudyDesk',
    size: 10,
    mtimeMs: 1,
    ctimeMs: 1,
    createdAt: 100,
    lastTime: 200,
    title: '分析Codex并评估DSH插件开发潜力',
    firstUserText: '分析下 codex',
    lastAssistantText: '好，结论如下',
    agentPreset: 'router-flash',
    counts: { 'tool/call': 5, 'user/message': 3 },
    toolNames: ['bash', 'read'],
    toolCallCounts: { bash: 2, read: 3 },
  }

  it('metaMatch 命中 id/workspace/title/文本/工具名', () => {
    assert.equal(metaMatch(meta, 'studydesk'), true)
    assert.equal(metaMatch(meta, 'codex'), true)
    assert.equal(metaMatch(meta, 'bash'), true)
    assert.equal(metaMatch(meta, 'nonexistent'), false)
  })

  it('findSession 按 id/文件子串', () => {
    const idx = { version: 1, root: 'C:/x', updatedAt: 1, sessions: [meta] }
    assert.equal(findSession(idx, 'session-abc')?.id, 'session-abc')
    assert.equal(findSession(idx, 'C:/x/session-abc/session.jsonl.zstd')?.id, 'session-abc')
    assert.equal(findSession(idx, 'nope'), undefined)
  })

  it('summarizeSession 确定性摘要', () => {
    const s = summarizeSession(meta)
    assert.equal(s.durationMs, 100)
    assert.deepEqual(s.toolCalls, [{ name: 'bash', count: 2 }, { name: 'read', count: 3 }])
    assert.equal(s.counts['tool/call'], 5)
  })
})

describe('findSessionFiles / scanSessionFiles / buildIndexSync', () => {
  let dir = ''

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-core-'))
    await mkdir(join(dir, 'ws1', 'session-a'), { recursive: true })
    await mkdir(join(dir, 'ws2', 'session-b'), { recursive: true })
    await copyFile(SAMPLE_ZSTD, join(dir, 'ws1', 'session-a', 'session.jsonl.zstd'))
    await copyFile(SAMPLE_ZSTD, join(dir, 'ws2', 'session-b', 'session.jsonl.zstd'))
    await writeFile(join(dir, 'ws1', 'ignore.txt'), 'x')
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('findSessionFiles 只收集 .zstd 且排序', () => {
    const files = findSessionFiles(dir)
    assert.equal(files.length, 2)
    assert.ok(files.every((f) => f.endsWith('.zstd')))
  })

  it('scanSessionFiles 带指纹与 cap', async () => {
    const { files, truncated } = await scanSessionFiles(dir, { cap: 1 })
    assert.equal(files.length, 1)
    assert.equal(truncated, true)
    assert.ok(files[0].ctimeMs > 0)
    const { files: all } = await scanSessionFiles(dir)
    assert.equal(all.length, 2)
  })

  it('buildIndexSync 同步全量构建仍可用（旧逻辑回归）', () => {
    const indexFile = join(dir, 'index.json')
    const rep = buildIndexSync(dir, indexFile)
    assert.equal(rep.added, 2)
    const idx = loadIndex(indexFile)!
    assert.equal(idx.sessions.length, 2)
    const rep2 = buildIndexSync(dir, indexFile)
    assert.equal(rep2.skipped, 2)
  })
})

describe('cursor 稳定分页（P1-6 回归：tie-break 必须与排序一致）', () => {
  // 排序键：lastTime desc, id asc（builder commit 同款）
  const sort = (a: SessionMeta, b: SessionMeta) =>
    b.lastTime - a.lastTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

  function meta(id: string, file: string, lastTime: number): SessionMeta {
    return {
      id, file, workspace: 'W', size: 1, mtimeMs: 1, ctimeMs: 1,
      createdAt: 1, lastTime, title: '', firstUserText: '', lastAssistantText: '',
      agentPreset: '', counts: {}, toolNames: [], toolCallCounts: {},
    }
  }

  it('parseCursor / formatCursor 往返', () => {
    const c = parseCursor('1786876862383|session-abc')!
    assert.equal(c.ts, 1786876862383)
    assert.equal(c.id, 'session-abc')
    assert.equal(parseCursor('1786876862383')!.id, '')
    assert.equal(parseCursor('nonsense'), null)
    assert.equal(formatCursor(meta('session-x', 'f', 123)), '123|session-x')
  })

  it('相同 lastTime、id 顺序与 file 顺序相反时翻页无重复无遗漏', () => {
    // 故意让 id 排序与 file 排序相反：
    // file 顺序: z < a < m（若按 file tie-break 会错位）
    const s1 = meta('session-z', 'C:/a/file', 100)
    const s2 = meta('session-a', 'C:/z/file', 100)
    const s3 = meta('session-m', 'C:/m/file', 100)
    const s4 = meta('session-b', 'C:/b/file', 90)
    const list = [s1, s2, s3, s4].sort(sort)
    assert.deepEqual(list.map((s) => s.id), ['session-a', 'session-m', 'session-z', 'session-b'])

    // 按 limit=2 翻页，全程用 cursor 推进
    const pages: string[][] = []
    let cursor: ReturnType<typeof parseCursor> = null
    for (;;) {
      const start = cursorStartIndex(list, cursor)
      const kept = list.slice(start, start + 2)
      pages.push(kept.map((s) => s.id))
      if (start + 2 >= list.length) break
      cursor = parseCursor(formatCursor(kept[kept.length - 1]))
    }
    const all = pages.flat()
    assert.deepEqual(all, ['session-a', 'session-m', 'session-z', 'session-b']) // 无遗漏
    assert.equal(new Set(all).size, all.length) // 无重复
  })

  it('分页期间新增更高 lastTime 的会话不会错位', () => {
    const s1 = meta('session-a', 'f1', 100)
    const s2 = meta('session-b', 'f2', 90)
    const list = [s1, s2].sort(sort)
    const page1 = list.slice(0, 1)
    const cursor = parseCursor(formatCursor(page1[0]))
    // 新会话 lastTime=110 插入头部
    const sNew = meta('session-new', 'f3', 110)
    const list2 = [sNew, ...list].sort(sort)
    const start = cursorStartIndex(list2, cursor)
    assert.equal(list2[start].id, 'session-b') // 跳过新增的 session-new 与已返回的 session-a
  })
})
