/**
 * bookmark.test.ts — 书签 sidecar 存储语义（STAGE-2 Part A）
 *
 * 逐条对照 reference/codex/codex-rs/rollout/src/session_index_tests.rs 翻译，
 * 不发明新语义：
 * - append + 读回                    ↔ write_index + scan（字段完整回显）
 * - 同锚点最新行胜出                  ↔ find_thread_name_by_id_prefers_latest_entry /
 *                                    find_thread_names_by_ids_prefers_latest_entry
 * - 坏行跳过 + 计数（非 JSON / 未支持版本） ↔ reverse_lookup_accepts_valid_eof_json_and_skips_invalid
 * - 文件缺失 → 空 / remove → 0       ↔ scan_index_returns_none_when_entry_missing（NotFound→空）
 * - remove 重写文件                  ↔ remove_thread_name_entries
 * - 同锚点 upsert 幂等                ↔ aider .aider.input.history 去重/替换更新思想（C4）
 * - 指纹缓存失效                     ↔ core.ts loadIndex 缓存模式（mtimeMs+size）
 * - 并发追加不损坏                    ↔ 写入加锁（SESSION_INDEX_LOCK 进程内语义）
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addBookmark,
  readBookmarks,
  removeBookmarks,
  parseBookmarkLines,
  bookmarkMatches,
  sortBookmarks,
  defaultLabel,
  bookmarkIdFor,
  anchorKey,
  invalidateBookmarkCache,
} from '../src/bookmark.js'
import type { Bookmark, BookmarkInput } from '../src/bookmark.js'

const dirs: string[] = []
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'bmk-'))
  dirs.push(d)
  return d
}

function input(over: Partial<BookmarkInput> = {}): BookmarkInput {
  return {
    sessionId: 'sess-1',
    sessionFile: 'C:\\x\\sess-1\\session.jsonl.zstd',
    messageId: null,
    label: 'L1',
    note: null,
    title: 'T1',
    workspace: 'W1',
    ...over,
  }
}

function makeBookmark(over: Partial<Bookmark> = {}): Bookmark {
  return {
    v: 1,
    id: 'id-x',
    sessionId: 's',
    sessionFile: 'f',
    messageId: null,
    label: 'label',
    note: null,
    title: 'title',
    workspace: 'ws',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe('bookmark 存储（对照 codex session_index_tests.rs）', () => {
  it('append + 读回：字段完整（write_index + scan）', async () => {
    const d = await tmp()
    const p = join(d, 'bookmarks.jsonl')
    const r = await addBookmark(p, input(), 1000)
    assert.equal(r.replaced, false)
    const read = await readBookmarks(p)
    assert.equal(read.bookmarks.length, 1)
    assert.equal(read.skippedBad, 0)
    const b = read.bookmarks[0]
    assert.equal(b.v, 2, '新写入使用 v2；v1 仍通过兼容读取保留')
    assert.equal(b.id, bookmarkIdFor('sess-1', null))
    assert.equal(b.sessionId, 'sess-1')
    assert.equal(b.sessionFile, 'C:\\x\\sess-1\\session.jsonl.zstd')
    assert.equal(b.messageId, null)
    assert.equal(b.label, 'L1')
    assert.equal(b.note, null)
    assert.equal(b.title, 'T1')
    assert.equal(b.workspace, 'W1')
    assert.equal(b.createdAt, 1000)
    assert.equal(b.updatedAt, 1000)
  })

  it('同锚点最新行胜出（prefers_latest_entry：有效视图不重复）', async () => {
    const d = await tmp()
    const p = join(d, 'bookmarks.jsonl')
    await addBookmark(p, input({ label: 'first' }), 1000)
    await addBookmark(p, input({ label: 'second', note: 'n2' }), 2000)
    const read = await readBookmarks(p)
    assert.equal(read.bookmarks.length, 1)
    assert.equal(read.bookmarks[0].label, 'second')
    assert.equal(read.bookmarks[0].note, 'n2')
    assert.equal(read.bookmarks[0].updatedAt, 2000)
    assert.equal(read.bookmarks[0].createdAt, 1000, '替换更新保留原创建时间')
  })

  it('同锚点 upsert 幂等：replaced=true、同 id、有效视图一条（aider 幂等）', async () => {
    const d = await tmp()
    const p = join(d, 'bookmarks.jsonl')
    const r1 = await addBookmark(p, input({ label: 'L1' }), 1000)
    const r2 = await addBookmark(p, input({ label: 'L2', note: 'N2' }), 2000)
    assert.equal(r1.replaced, false)
    assert.equal(r2.replaced, true)
    assert.equal(r1.bookmark.id, r2.bookmark.id, '同锚点同 id')
    const read = await readBookmarks(p)
    assert.equal(read.bookmarks.length, 1)
    assert.equal(read.bookmarks[0].label, 'L2')
    assert.equal(read.bookmarks[0].note, 'N2')
    assert.equal(read.bookmarks[0].createdAt, 1000)
    assert.equal(read.bookmarks[0].updatedAt, 2000)
  })

  it('坏行（非 JSON）跳过并计数、后续行仍读（skips_invalid）', async () => {
    const d = await tmp()
    const p = join(d, 'bookmarks.jsonl')
    const good1 = makeBookmark({ id: bookmarkIdFor('s1', null), sessionId: 's1', sessionFile: 'f1', label: 'a' })
    const good2 = makeBookmark({ id: bookmarkIdFor('s2', 7), sessionId: 's2', sessionFile: 'f2', messageId: 7, label: 'b' })
    // 末行无换行（codex reverse_lookup_accepts_valid_eof_json_and_skips_invalid 同款）
    await writeFile(p, `${JSON.stringify(good1)}\nnot-json\n${JSON.stringify(good2)}`)
    const read = await readBookmarks(p)
    assert.equal(read.skippedBad, 1)
    assert.equal(read.bookmarks.length, 2)
    const ids = read.bookmarks.map((b) => b.id).sort()
    assert.deepEqual(ids, [good1.id, good2.id].sort())
    assert.equal(read.bookmarks.find((b) => b.sessionId === 's2')?.messageId, 7)
  })

  it('v!==1 行跳过并计数（版本前置，迁移前奏）', async () => {
    const d = await tmp()
    const p = join(d, 'bookmarks.jsonl')
    const good = makeBookmark()
    const old = { ...makeBookmark(), v: 0, id: 'old-id' }
    await writeFile(p, `${JSON.stringify(old)}\n${JSON.stringify(good)}\n`)
    const read = await readBookmarks(p)
    assert.equal(read.skippedBad, 1)
    assert.equal(read.bookmarks.length, 1)
    assert.equal(read.bookmarks[0].id, good.id)
  })

  it('尾部坏行有诊断，add/remove 拒绝修改并保留全部原始字节', async () => {
    const d = await tmp()
    const p = join(d, 'bookmarks.jsonl')
    const good = makeBookmark()
    const bytes = `${JSON.stringify(good)}\n{"incomplete":`
    await writeFile(p, bytes)
    const read = await readBookmarks(p)
    assert.equal(read.skippedBad, 1)
    assert.equal(read.bookmarks.length, 1)
    const corrupt = (error: any): boolean => error.code === 'EBOOKMARKCORRUPT' && error.skippedBad === 1
    await assert.rejects(addBookmark(p, input()), corrupt)
    await assert.rejects(removeBookmarks(p, { id: good.id }), corrupt)
    assert.equal(await readFile(p, 'utf8'), bytes)
  })

  it('不可读资源的错误不会被当成空书签覆盖', async () => {
    const d = await tmp()
    const p = join(d, 'bookmarks.jsonl')
    await mkdir(p)
    await assert.rejects(readBookmarks(p), (error: any) => error.code === 'EISDIR')
    await assert.rejects(addBookmark(p, input()), (error: any) => error.code === 'EISDIR')
    await assert.rejects(removeBookmarks(p, { id: 'any' }), (error: any) => error.code === 'EISDIR')
  })

  it('有效 EOF 行没有换行时追加仍保留旧书签', async () => {
    const d = await tmp()
    const p = join(d, 'bookmarks.jsonl')
    await writeFile(p, JSON.stringify(makeBookmark()))
    await addBookmark(p, input())
    const read = await readBookmarks(p)
    assert.equal(read.skippedBad, 0)
    assert.equal(read.bookmarks.length, 2)
  })

  it('空行跳过不计坏行', () => {
    const good = makeBookmark()
    const r = parseBookmarkLines(`${JSON.stringify(good)}\n\n   \n${JSON.stringify(good)}`)
    assert.equal(r.bookmarks.length, 1, '同锚点重复行最新胜出')
    assert.equal(r.skippedBad, 0)
  })

  it('指纹缓存：同指纹命中同实例；变更后失效重读', async () => {
    const d = await tmp()
    const p = join(d, 'bookmarks.jsonl')
    await addBookmark(p, input(), 1000)
    const r1 = await readBookmarks(p)
    const r2 = await readBookmarks(p)
    assert.ok(r1.bookmarks === r2.bookmarks, '同指纹应命中缓存（同一数组实例）')
    await addBookmark(p, input({ sessionId: 'sess-2', label: 'other' }), 2000)
    const r3 = await readBookmarks(p)
    assert.ok(r1.bookmarks !== r3.bookmarks, '变更后缓存失效（新实例）')
    assert.equal(r3.bookmarks.length, 2)
    invalidateBookmarkCache(p)
    const r4 = await readBookmarks(p)
    assert.equal(r4.bookmarks.length, 2, '显式失效后重读一致')
  })

  it('remove by id：精确删除一条，其余保留', async () => {
    const d = await tmp()
    const p = join(d, 'bookmarks.jsonl')
    await addBookmark(p, input({ sessionId: 's1', label: 'a' }), 1)
    await addBookmark(p, input({ sessionId: 's2', label: 'b' }), 2)
    const list = (await readBookmarks(p)).bookmarks
    const id1 = list.find((b) => b.sessionId === 's1')!.id
    const n = await removeBookmarks(p, { id: id1 })
    assert.equal(n, 1)
    const after = (await readBookmarks(p)).bookmarks
    assert.equal(after.length, 1)
    assert.equal(after[0].sessionId, 's2')
  })

  it('remove by sessionId：删除该会话全部书签（大小写不敏感）', async () => {
    const d = await tmp()
    const p = join(d, 'bookmarks.jsonl')
    await addBookmark(p, input({ sessionId: 's1', label: 'a1' }), 1)
    await addBookmark(p, input({ sessionId: 's1', messageId: 5, label: 'a2' }), 2)
    await addBookmark(p, input({ sessionId: 's2', label: 'b' }), 3)
    const n = await removeBookmarks(p, { sessionId: 'S1' })
    assert.equal(n, 2)
    const after = (await readBookmarks(p)).bookmarks
    assert.equal(after.length, 1)
    assert.equal(after[0].sessionId, 's2')
  })

  it('remove 无匹配：返回 0 且文件字节不变（remove_thread_name_entries 语义）', async () => {
    const d = await tmp()
    const p = join(d, 'bookmarks.jsonl')
    await addBookmark(p, input(), 1)
    const before = await readFile(p, 'utf8')
    assert.equal(await removeBookmarks(p, { id: 'nonexistent' }), 0)
    assert.equal(await removeBookmarks(p, { sessionId: 'nope' }), 0)
    assert.equal(await readFile(p, 'utf8'), before)
  })

  it('remove/read 文件缺失：返回 0 / 空（NotFound→Ok）', async () => {
    const d = await tmp()
    const p = join(d, 'bookmarks.jsonl')
    assert.equal(await removeBookmarks(p, { id: 'x' }), 0)
    const read = await readBookmarks(p)
    assert.equal(read.bookmarks.length, 0)
    assert.equal(read.skippedBad, 0)
  })

  it('并发追加不损坏（写入加锁串行化）', async () => {
    const d = await tmp()
    const p = join(d, 'bookmarks.jsonl')
    const N = 20
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        addBookmark(p, input({ sessionId: `sess-${i}`, label: `L${i}` }), 1000 + i),
      ),
    )
    const read = await readBookmarks(p)
    assert.equal(read.bookmarks.length, N)
    assert.equal(read.skippedBad, 0)
    assert.equal(new Set(read.bookmarks.map((b) => b.id)).size, N, '锚点各异 → id 各异')
  })

  it('id 确定性：同锚点同 id、异锚点异 id、跨调用稳定（锚点哈希）', () => {
    assert.equal(bookmarkIdFor('s', null), bookmarkIdFor('s', null))
    assert.equal(bookmarkIdFor('s', 5), bookmarkIdFor('s', 5))
    assert.notEqual(bookmarkIdFor('s', null), bookmarkIdFor('s', 5))
    assert.notEqual(bookmarkIdFor('a', null), bookmarkIdFor('b', null))
    // 分隔符保证边界不撞：("s",5) ≠ ("s5",null)
    assert.notEqual(anchorKey('s', 5), anchorKey('s5', null))
  })

  it('defaultLabel 确定性：title 优先、无 title 取首条消息、80 字符截断、无 LLM', () => {
    assert.equal(defaultLabel('My Title', 'long first'), 'My Title')
    assert.equal(defaultLabel('', 'long first'), 'long first')
    assert.equal(defaultLabel('', ''), '')
    const long = 'x'.repeat(200)
    assert.equal(defaultLabel('', long), 'x'.repeat(80))
    assert.equal(defaultLabel(long, 'ignored'), long.slice(0, 80))
  })

  it('list 过滤：label/note/title 大小写不敏感子串（metaMatch 归一化语义）', () => {
    const b = makeBookmark({ label: 'Alpha', note: 'Note Beta', title: 'Gamma' })
    assert.ok(bookmarkMatches(b, 'alpha'))
    assert.ok(bookmarkMatches(b, 'BETA'))
    assert.ok(bookmarkMatches(b, 'gamma'))
    assert.ok(bookmarkMatches(b, 'AL'))
    assert.ok(!bookmarkMatches(b, 'delta'))
    assert.ok(bookmarkMatches(b, ''), '空 query 恒真')
    assert.ok(bookmarkMatches(b, '   '), '空白 query 恒真')
  })

  it('list 排序确定性：updatedAt 倒序 → id 升序 → 原顺序收口（rank.ts tiebreak 同构）', () => {
    const a = makeBookmark({ id: 'b', updatedAt: 3, label: 'A' })
    const b = makeBookmark({ id: 'a', updatedAt: 3, label: 'B' })
    const c = makeBookmark({ id: 'c', updatedAt: 5, label: 'C' })
    const out = sortBookmarks([a, b, c])
    assert.deepEqual(out.map((x) => x.label), ['C', 'B', 'A'])
    // 完全同键：原顺序收口（稳定，对应 fzf tiebreak 的 index 收口）
    const x = makeBookmark({ id: 'same', updatedAt: 7, label: 'X' })
    const y = makeBookmark({ id: 'same', updatedAt: 7, label: 'Y' })
    const out2 = sortBookmarks([x, y])
    assert.deepEqual(out2.map((o) => o.label), ['X', 'Y'])
    // 确定性：同输入两遍同输出
    const again = sortBookmarks([a, b, c])
    assert.deepEqual(again.map((o) => o.label), ['C', 'B', 'A'])
  })
})
