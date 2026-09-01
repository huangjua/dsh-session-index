/**
 * bookmark.ts — 书签 sidecar 存储层（session_index_bookmark 的读写语义）
 *
 * ── 借鉴来源（共同前提 0.3：pinned 副本与 SHA 见 reference/borrow/）──
 *
 * 1. 存储约定 — openai/codex@9ded177
 *    reference/codex/codex-rs/rollout/src/session_index.rs（Apache-2.0，本地镜像）：
 *    - 写入加锁：codex 用进程内 SESSION_INDEX_LOCK（Mutex）→ 本模块 per-path
 *      promise 链互斥（同一文件串行化追加/重写）；
 *    - 追加 + flush：codex OpenOptions::append + write_all + flush →
 *      本模块 open('a') + writeFile + sync（fsync）；
 *    - 读取容错：codex 逐行 serde_json::from_str，坏行 `continue`（跳过）→
 *      本模块逐行 JSON.parse，坏行跳过并计数（任务要求显式计数）；
 *    - 尾扫描取最新：codex scan_index_from_end「最新行胜出」→ 本模块同锚点
 *      （sessionId+messageId）重复行取最新一条，有效视图不产生重复；
 *    - remove = 重写文件：codex remove_thread_name_entries（读全量→过滤→
 *      tmp+rename 原子重写）→ 本模块 removeBookmarks 同款语义。
 *
 * 2. 概念借鉴 — cuhaitiang0405-collab/dsh-indexbookmark（调研镜像
 *    reference/borrow/dsh-indexbookmark/README.md）：「锚点 + 一键跳回」——
 *    add 记录 (sessionId, messageId) 锚点，list 找回后拿锚点走既有
 *    session_summary / session_index_search SCROLL 完成跳回。仅借概念，
 *    不引入官方 sessionQuery 依赖（全局红线 7 fail-open）。
 *
 * 3. 幂等思想 — Aider-AI/aider 的 .aider.input.history 去重/限量（C4，纯文本零依赖）：
 *    同锚点重复 add = 替换更新（updatedAt/label/note），不产生重复有效行。
 *    存储实现：append-only + 同锚点最新行胜出（codex 语义）→ 有效视图幂等；
 *    替换更新时继承原行的 createdAt（"创建时间"不变，"更新时间"刷新）。
 *
 * ── 红线 ──
 * - 零新依赖（仅 node: 内建）；零 LLM；纯存储层无 DSH/cordis 依赖；
 * - 书签是派生数据：只读写 %DSH_HOME%\session-index\bookmarks.jsonl，可随时
 *   删除重建；绝不写 index.json / fts.db / 官方库 / 会话文件。
 */
import { createHash } from 'node:crypto'
import { open, readFile, rename, unlink, stat, mkdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'

/** 书签 sidecar 文件名（codex SESSION_INDEX_FILE 惯例；与 fts.db 同级） */
export const BOOKMARK_FILE_NAME = 'bookmarks.jsonl'
/** 行结构版本（version 前置供未来迁移；读取只接受 v===1） */
export const BOOKMARK_VERSION = 1
/** label 缺省截断长度（任务执行细节：meta.title 或 firstUserText 前 80 字符） */
export const DEFAULT_LABEL_MAX = 80
/** list limit 上限（任务执行细节：默认 20，≤100） */
export const BOOKMARK_LIST_LIMIT_DEFAULT = 20
export const BOOKMARK_LIST_LIMIT_MAX = 100

/** 单条书签（v:1 行结构） */
export interface Bookmark {
  v: number
  /** 确定性 id（锚点哈希；跨进程/重启稳定，remove-by-id / upsert 可复现） */
  id: string
  sessionId: string
  sessionFile: string
  /** 消息锚点（SCROLL 用）；缺省 = null（会话级书签） */
  messageId: number | null
  label: string
  note: string | null
  title: string
  workspace: string
  createdAt: number
  updatedAt: number
}

/** add 输入（createdAt/updatedAt 由存储层填充） */
export interface BookmarkInput {
  sessionId: string
  sessionFile: string
  messageId?: number | null
  label: string
  note?: string | null
  title: string
  workspace: string
}

/** 缺省 sidecar 路径：%DSH_HOME%\session-index\bookmarks.jsonl（与 fts.db 同级） */
export function defaultBookmarkFile(dshHome: string): string {
  return join(dshHome, 'session-index', BOOKMARK_FILE_NAME)
}

/**
 * 锚点键：(sessionId, messageId) 归一化。messageId 缺省 = null（会话级书签）。
 * 同锚点重复 add = 替换更新（aider 幂等思想）。
 */
export function anchorKey(sessionId: string, messageId: number | null | undefined): string {
  return `${sessionId}\u0000${messageId ?? ''}`
}

/**
 * id = sha1(锚点键) 十六进制。
 *
 * 为什么选确定性锚点哈希而非短随机（任务执行细节二选一）：
 * - 跨进程/跨重启稳定：同一锚点永远同一 id → remove-by-id 可复现、upsert
 *   去重天然成立（同锚点的所有行共享同一 id）；
 * - 短随机在并发 append 下会产生同锚点多条不同 id 的行，破坏"不产生重复
 *   有效行"的幂等约束。
 * node:crypto 内建，零新依赖。
 */
export function bookmarkIdFor(sessionId: string, messageId: number | null | undefined): string {
  return createHash('sha1').update(anchorKey(sessionId, messageId)).digest('hex')
}

/**
 * label 缺省 = meta.title 或 firstUserText 前 80 字符（确定性，无 LLM）。
 * title 非空用 title；否则用首条用户消息；两者皆空 → ''。
 */
export function defaultLabel(title: string, firstUserText: string): string {
  return (title || firstUserText || '').slice(0, DEFAULT_LABEL_MAX)
}

/* ── 进程内 per-path 互斥（对齐 codex SESSION_INDEX_LOCK 的进程内语义）────── */

const pathLocks = new Map<string, Promise<unknown>>()

function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = pathLocks.get(path) ?? Promise.resolve()
  const next = prev.then(fn)
  // 链上保留（即使本次失败也不阻塞后续）；调用方仍收到本次的 rejection
  pathLocks.set(path, next.catch(() => undefined))
  return next
}

/* ── 指纹缓存（照 core.ts loadIndex 的 mtimeMs+size 缓存模式）─────────────── */

interface BookmarkCacheEntry {
  mtimeMs: number
  size: number
  bookmarks: Bookmark[]
  skippedBad: number
}
const bookmarkCache = new Map<string, BookmarkCacheEntry>()

/** 显式失效（add/remove 后调用），防同 ms 同 size 撞车。 */
export function invalidateBookmarkCache(path: string): void {
  bookmarkCache.delete(path)
}

/* ── 读取：整读 + 逐行容错 + 同锚点最新行胜出 ─────────────────────────────── */

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object'
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 校验并归一化一行书签；形状不符（含 v!==1，未来迁移前奏）→ null（计坏行）。 */
export function normalizeBookmark(obj: unknown): Bookmark | null {
  if (!isRecord(obj)) return null
  if (obj.v !== BOOKMARK_VERSION) return null
  const id = str(obj.id)
  const sessionId = str(obj.sessionId)
  const sessionFile = str(obj.sessionFile)
  const label = str(obj.label)
  const title = str(obj.title)
  const workspace = str(obj.workspace)
  if (!id || !sessionId || !sessionFile || label === null || title === null || workspace === null) {
    return null
  }
  let messageId: number | null
  if (obj.messageId === null || obj.messageId === undefined) messageId = null
  else {
    messageId = num(obj.messageId)
    if (messageId === null) return null
  }
  let note: string | null
  if (obj.note === null || obj.note === undefined) note = null
  else {
    note = str(obj.note)
    if (note === null) return null
  }
  const createdAt = num(obj.createdAt)
  const updatedAt = num(obj.updatedAt)
  if (createdAt === null || updatedAt === null) return null
  return { v: BOOKMARK_VERSION, id, sessionId, sessionFile, messageId, label, note, title, workspace, createdAt, updatedAt }
}

/**
 * 解析 JSONL 文本：逐行 JSON.parse 容错（坏行跳过并计数，照 codex 容错读）；
 * 同锚点重复行取最新（尾扫描语义：后出现者覆盖先出现者）。
 */
export function parseBookmarkLines(text: string): { bookmarks: Bookmark[]; skippedBad: number } {
  const byAnchor = new Map<string, Bookmark>()
  let skippedBad = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue // 空行跳过（codex find_thread_names_by_ids 同款），不计坏行
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      skippedBad++
      continue
    }
    const b = normalizeBookmark(obj)
    if (!b) {
      skippedBad++
      continue
    }
    byAnchor.set(anchorKey(b.sessionId, b.messageId), b) // 后写覆盖先写 → 最新胜出
  }
  return { bookmarks: Array.from(byAnchor.values()), skippedBad }
}

/**
 * 整读 + 容错 + 最新胜出；mtimeMs+size 指纹缓存（照 core.ts loadIndex 模式），
 * 每次工具调用只读一次。文件缺失/读失败 → 空列表（codex NotFound → 空）。
 */
export async function readBookmarks(path: string): Promise<{ bookmarks: Bookmark[]; skippedBad: number }> {
  let st
  try {
    st = await stat(path)
  } catch {
    invalidateBookmarkCache(path)
    return { bookmarks: [], skippedBad: 0 }
  }
  const cached = bookmarkCache.get(path)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return { bookmarks: cached.bookmarks, skippedBad: cached.skippedBad }
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    invalidateBookmarkCache(path)
    return { bookmarks: [], skippedBad: 0 }
  }
  const parsed = parseBookmarkLines(text)
  bookmarkCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, bookmarks: parsed.bookmarks, skippedBad: parsed.skippedBad })
  return parsed
}

/* ── 写入：追加 + flush（codex append + flush 语义，per-path 互斥）─────────── */

async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  let fh: FileHandle | null = null
  try {
    fh = await open(path, 'a')
    await fh.writeFile(line + '\n', 'utf8')
    await fh.sync() // flush（对齐 codex file.flush()）
    await fh.close()
    fh = null
  } finally {
    if (fh) {
      try {
        await fh.close()
      } catch {
        /* 忽略 */
      }
    }
  }
}

/**
 * 追加一条书签（幂等 upsert）：
 * - 同锚点已存在 → replaced=true；新行继承原 createdAt、刷新 updatedAt/label/note
 *  （aider 替换更新思想）；
 * - 追加用 open('a') + write + sync（flush）；per-path 互斥（codex 写入加锁）；
 * - 返回本次写入的最新行。
 */
export async function addBookmark(
  path: string,
  input: BookmarkInput,
  now = Date.now(),
): Promise<{ bookmark: Bookmark; replaced: boolean }> {
  return withPathLock(path, async () => {
    const { bookmarks } = await readBookmarks(path)
    const key = anchorKey(input.sessionId, input.messageId)
    const existing = bookmarks.find((b) => anchorKey(b.sessionId, b.messageId) === key)
    const bookmark: Bookmark = {
      v: BOOKMARK_VERSION,
      id: existing?.id ?? bookmarkIdFor(input.sessionId, input.messageId),
      sessionId: input.sessionId,
      sessionFile: input.sessionFile,
      messageId: input.messageId ?? null,
      label: input.label,
      note: input.note ?? null,
      title: input.title,
      workspace: input.workspace,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await appendLine(path, JSON.stringify(bookmark))
    invalidateBookmarkCache(path)
    return { bookmark, replaced: !!existing }
  })
}

/* ── 删除：读全量→过滤→tmp+rename 原子重写（codex remove_thread_name_entries）─ */

export interface RemoveBookmarksOptions {
  /** 按书签 id（精确）删除一条 */
  id?: string
  /** 按 sessionId（精确，大小写不敏感）删除该会话全部书签 */
  sessionId?: string
}

let tmpSeq = 0

async function atomicWriteText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `${basename(path)}.tmp.${process.pid}.${tmpSeq++}`)
  let fh: FileHandle | null = null
  try {
    fh = await open(tmp, 'wx')
    await fh.writeFile(text, 'utf8')
    await fh.sync()
    await fh.close()
    fh = null
    await rename(tmp, path) // Windows: MoveFileEx(REPLACE_EXISTING)
  } catch (e) {
    if (fh) {
      try {
        await fh.close()
      } catch {
        /* 忽略 */
      }
    }
    try {
      await unlink(tmp)
    } catch {
      /* 忽略 */
    }
    throw e
  }
}

/**
 * 删除书签（codex remove_thread_name_entries 语义）。**绝不删除会话文件**。
 * 返回删除行数；无匹配则不动文件返回 0；文件缺失返回 0（codex NotFound → Ok）。
 */
export async function removeBookmarks(path: string, opts: RemoveBookmarksOptions): Promise<number> {
  return withPathLock(path, async () => {
    const { bookmarks } = await readBookmarks(path)
    const id = opts.id?.trim()
    const sessionId = opts.sessionId?.trim()
    const match = (b: Bookmark): boolean =>
      (id !== undefined && id !== '' && b.id === id) ||
      (sessionId !== undefined && sessionId !== '' && b.sessionId.toLowerCase() === sessionId.toLowerCase())
    const remaining = bookmarks.filter((b) => !match(b))
    const removed = bookmarks.length - remaining.length
    if (removed === 0) return 0
    const text = remaining.map((b) => JSON.stringify(b)).join('\n') + (remaining.length ? '\n' : '')
    await atomicWriteText(path, text)
    invalidateBookmarkCache(path)
    return removed
  })
}

/* ── list 过滤与排序（纯函数；调用方只喂已读回的书签，不调 LLM/bm25）─────── */

/** list 过滤：对 label/note/title 大小写不敏感子串匹配（复用 metaMatch 归一化语义） */
export function bookmarkMatches(b: Bookmark, query: string): boolean {
  const q = (query ?? '').toLowerCase().trim()
  if (!q) return true
  return (
    b.label.toLowerCase().includes(q) ||
    (b.note ?? '').toLowerCase().includes(q) ||
    b.title.toLowerCase().includes(q)
  )
}

/**
 * list 排序：updatedAt 倒序 → id 升序 → 原顺序（文件序）收口。
 * 等分决序沿用 rank.ts 的确定性 tiebreak 语义（fzf：score→…→index；本域无
 * fzy 分，取最后一道确定性收口 = 原始下标，与 sortSessions 的 index 收口同构）。
 * 同输入必同输出。
 */
export function sortBookmarks(bookmarks: Bookmark[]): Bookmark[] {
  return bookmarks
    .map((b, idx) => ({ b, idx }))
    .sort((A, B) => {
      if (A.b.updatedAt !== B.b.updatedAt) return B.b.updatedAt - A.b.updatedAt
      if (A.b.id !== B.b.id) return A.b.id < B.b.id ? -1 : 1
      return A.idx - B.idx
    })
    .map((x) => x.b)
}
