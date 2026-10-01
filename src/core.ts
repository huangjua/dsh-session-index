/**
 * core.ts — DSH session index engine
 *
 * 读取 `~/.dsh/sessions` 下的 `session.jsonl.zstd`：
 *  - fzstd 纯 JS 解压 Zstandard
 *  - 解析首行 session 元信息 + 后续事件流
 *  - 维护轻量索引（不存正文，只存元数据/摘要字段）
 *  - 提供元数据搜索与按需全文搜索
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, statSync, openSync, fsyncSync, closeSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, basename, dirname, isAbsolute, resolve } from 'node:path'
import * as fzstd from 'fzstd'
import { throwIfAborted } from './cancel.js'
import { SessionLogCompatibility, textFromCompatibleMessage } from './session-compat.js'
import type { SessionCompatibilityVersion } from './session-compat.js'

export interface SessionMeta {
  id: string
  file: string
  workspace: string
  size: number
  mtimeMs: number
  /** 指纹第三元：ctimeMs（旧索引无此字段，视为需重扫） */
  ctimeMs?: number
  createdAt: number
  lastTime: number
  title: string
  firstUserText: string
  lastAssistantText: string
  agentPreset: string
  counts: Record<string, number>
  toolNames: string[]
  toolCallCounts: Record<string, number>
  /** 仅 head pass 的 quick 条目：counts/lastAssistantText 等字段缺失 */
  detailMissing?: boolean
  /** P3 lineage：父会话 id（DSH header 的 parentSession）；子代理/续会话用它归并 */
  parentSession?: string
  /**
   * P1 delta：已索引到的最后一个完整帧末字节偏移（append-only 会话文件）。
   * 下次增量只解 [indexedBytes, EOF) 的新帧，累加 counts/lastTime/lastAssistantText。
   * 缺省/0 → 全量重解析（旧索引迁移 / detailMissing 条目 / 文件被替换）。
   */
  indexedBytes?: number
  /** 构建期间文件被改写：条目保留旧值 */
  raced?: boolean
  /** 本次构建解析失败：保留旧条目，只追加 error */
  error?: string
  /** Audited JSONL compatibility gate that accepted this log. */
  compatibility?: SessionCompatibilityVersion
  /**
   * The raw file remains untouched, but this entry must not be surfaced or
   * searched because a required/unknown event made semantic reconstruction
   * unsafe.  Kept in index.json solely as a diagnostic marker.
   */
  unindexable?: true
}

export interface SessionIndex {
  version: number
  root: string
  updatedAt: number
  sessions: SessionMeta[]
}

export interface BuildReport {
  status: 'completed' | 'cancelled' | 'failed' | 'skipped'
  totalFiles: number
  processed: number
  headParsed: number
  fullParsed: number
  added: number
  updated: number
  skipped: number
  removed: number
  raced: number
  failed: number
  /** P3 保留策略：文件仍在磁盘、仅因超龄（max(lastTime, mtimeMs) < cutoff）
   * 从索引/派生层移除的条目数。可选字段，既有断言不受影响。 */
  pruned: number
  errors: string[]
  scannedBytes: number
  indexFile: string
  durationMs: number
  maxEventLoopDelayMs: number
  /** 取消时若 Phase A 已提交 quick index 则为 true */
  partialCommitted?: boolean
}

/** 扫描得到的文件指纹（size, mtimeMs, ctimeMs） */
export interface ScanFile {
  file: string
  size: number
  mtimeMs: number
  ctimeMs: number
}

export interface SearchHit {
  sessionId: string
  workspace: string
  file: string
  kind: 'meta' | 'content'
  type: string
  snippet: string
  /** P3 SCROLL 锚点：FTS messages 行 id（meta/worker 路径为 0） */
  messageId?: number
}

export interface SessionSummary {
  id: string
  file: string
  workspace: string
  createdAt: number
  lastTime: number
  durationMs: number
  title: string
  firstUserText: string
  lastAssistantText: string
  agentPreset: string
  counts: Record<string, number>
  toolCalls: { name: string; count: number }[]
}

export function decompressZstd(file: string): string {
  const compressed = readFileSync(file)
  const buf = fzstd.decompress(new Uint8Array(compressed))
  return Buffer.from(buf).toString('utf8')
}

export function parseSession(text: string): {
  id: string
  createdAt: number
  cwd: string
  agentPreset: string
  title: string
  firstUserText: string
  lastAssistantText: string
  lastTime: number
  counts: Record<string, number>
  toolCalls: { name: string; arguments: string }[]
} {
  const compat = new SessionLogCompatibility()
  let title = ''
  let lastTime = 0
  const counts: Record<string, number> = {}
  const toolCalls: { name: string; arguments: string }[] = []

  for (const line of text.split('\n')) {
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error('corrupt session log: JSONL line is not valid JSON')
    }
    for (const event of compat.consumeLine(parsed)) {
      const type = event.type as string
      counts[type] = (counts[type] || 0) + 1
      if (typeof event.time === 'number' && event.time > lastTime) lastTime = event.time
      const data = event.data as Record<string, unknown> | undefined
      if (type === 'session/title' && typeof data?.title === 'string' && data.title) title = data.title
      if (type === 'tool/call' && typeof data?.name === 'string' && data.name) {
        toolCalls.push({ name: data.name, arguments: typeof data.arguments === 'string' ? data.arguments : '' })
      }
    }
  }
  let firstUserText = ''
  let lastAssistantText = ''
  for (const message of compat.finish()) {
    const messageText = textFromCompatibleMessage(message)
    if (message.type === 'user/message' && messageText && !firstUserText) firstUserText = messageText.slice(0, 500)
    if (message.type === 'assistant/message' && messageText) lastAssistantText = messageText.slice(0, 2000)
  }
  const header = compat.header
  return {
    id: header.id, createdAt: header.createdAt, cwd: header.cwd, agentPreset: header.agentPreset,
    title, firstUserText, lastAssistantText, lastTime, counts, toolCalls,
  }
}

export function findSessionFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full)
      } else if (st.isFile() && name.endsWith('.jsonl.zstd')) {
        out.push(full)
      }
    }
  }
  walk(root)
  return out.sort()
}

/**
 * 规范代际日志名：v0 = `session.jsonl.zstd`，vN = `session.vN.jsonl.zstd`（N ≥ 1，
 * 无前导零）。与 @deepseek-ai/dsh-session-format 的 `sessionFormatLogFilename`
 * 一致：小写 `v`、无前导零、`.v0` 与临时/大写名都不算规范代际。
 */
const GENERATION_LOG_RE = /^session(?:\.v([1-9]\d*))?\.jsonl\.zstd$/

function generationOf(name: string): number | undefined {
  const match = GENERATION_LOG_RE.exec(name)
  if (!match) return undefined
  return match[1] === undefined ? 0 : Number(match[1])
}

/**
 * 异步扫描会话文件 + 指纹（size, mtimeMs, ctimeMs）。
 * 每 20 个文件让出一次主线程并检查取消；超 cap（默认 10000）停止并置 truncated。
 *
 * DSH 升级时会把旧代际日志原地迁移成新文件，旧文件不删除（例如同一会话目录
 * 同时存在 `session.jsonl.zstd` 与 `session.v3.jsonl.zstd`），DSH 自身按最高
 * 代际读取。索引同样只收每个目录的最高代际：低代际条目随后走 merge 的 prune
 * 路径（连同 FTS 行），否则同一会话会在搜索结果里出现两次。
 */
export async function scanSessionFiles(
  root: string,
  options: { signal?: AbortSignal; cap?: number } = {},
): Promise<{ files: ScanFile[]; truncated: boolean }> {
  const cap = options.cap ?? 10000
  const signal = options.signal
  const files: ScanFile[] = []
  let truncated = false
  let visited = 0
  const walk = async (dir: string): Promise<void> => {
    if (truncated) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      visited++
      if (visited % 20 === 0) {
        throwIfAborted(signal)
        await new Promise<void>((r) => setImmediate(r))
      }
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl.zstd')) continue
      let st
      try {
        st = await stat(full)
      } catch {
        continue
      }
      if (!st.isFile()) continue
      if (files.length >= cap) {
        truncated = true
        return
      }
      files.push({ file: full, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs })
    }
  }
  await walk(root)
  // 每个会话目录只保留最高代际的规范日志；非规范名的 .jsonl.zstd 一律保留。
  const bestByDir = new Map<string, { file: string; version: number }>()
  for (const f of files) {
    const version = generationOf(basename(f.file))
    if (version === undefined) continue
    const dir = dirname(f.file)
    const best = bestByDir.get(dir)
    if (!best || version > best.version) bestByDir.set(dir, { file: f.file, version })
  }
  const kept = files.filter((f) => {
    const version = generationOf(basename(f.file))
    return version === undefined || bestByDir.get(dirname(f.file))?.file === f.file
  })
  files.length = 0
  files.push(...kept)
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  return { files, truncated }
}

/* ── P0-1：loadIndex 内存缓存（882KB index.json 每次调用解析 → 按指纹缓存） ────
 *
 * 缓存键 = (mtimeMs, size)：index.json 每次 commit 都是新 tmp 文件 rename，
 * mtime/size 必变 → 自然失效。并发进程写入也由 stat 指纹兜底。
 * 返回同一 SessionIndex 对象：配合 core.ts 的 metaMatch 小写 WeakMap 缓存，
 * 反复查询只做一次 toLowerCase。
 */
interface IndexCacheEntry {
  mtimeMs: number
  size: number
  index: SessionIndex
}
const indexCache = new Map<string, IndexCacheEntry>()

/** 显式失效（builder commit / saveIndex 后调用），防同 ms 同 size 撞车。 */
export function invalidateIndexCache(indexFile: string): void {
  indexCache.delete(indexFile)
}

export function loadIndex(indexFile: string): SessionIndex | null {
  try {
    if (!existsSync(indexFile)) {
      indexCache.delete(indexFile)
      return null
    }
    const st = statSync(indexFile)
    const cached = indexCache.get(indexFile)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.index
    }
    const raw = readFileSync(indexFile, 'utf8')
    const obj = JSON.parse(raw)
    if (obj && obj.version === 1 && Array.isArray(obj.sessions)) {
      const index = obj as SessionIndex
      indexCache.set(indexFile, { mtimeMs: st.mtimeMs, size: st.size, index })
      return index
    }
    indexCache.delete(indexFile)
    return null
  } catch {
    return null
  }
}

/** 同步写索引（legacy 同步路径/测试用；生产路径走 builder 的 atomicWriteJson）。
 *  C10：补齐 fsync + 唯一 tmp 名——旧实现无 fsync、固定 tmp 名，跨进程并发时
 *  可能互相踩踏，且崩溃时可能留下未落盘的 tmp。 */
let saveIndexSeq = 0
export function saveIndex(indexFile: string, index: SessionIndex): void {
  mkdirSync(dirname(indexFile), { recursive: true })
  const tmp = `${indexFile}.tmp.${process.pid}.${saveIndexSeq++}`
  const fd = openSync(tmp, 'wx')
  try {
    writeFileSync(fd, JSON.stringify(index), 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, indexFile)
  invalidateIndexCache(indexFile)
}

/**
 * 旧版同步全量构建（保留纯函数导出，供测试/对比）。
 * 生产路径请用 async buildIndex（SessionIndexBuilder：两阶段 + worker 池 + 原子提交）。
 */
export function buildIndexSync(root: string, indexFile: string, force = false): BuildReport {
  const files = findSessionFiles(root)
  const old = loadIndex(indexFile)
  const byFile = new Map<string, SessionMeta>()
  if (old) for (const s of old.sessions) byFile.set(s.file, s)

  let added = 0
  let updated = 0
  let skipped = 0
  let scannedBytes = 0
  const errors: string[] = []

  for (const file of files) {
    try {
      const st = statSync(file)
      const prev = byFile.get(file)
      if (!force && prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
        skipped++
        continue
      }
      const text = decompressZstd(file)
      scannedBytes += st.size
      const parsed = parseSession(text)
      const workspace = parsed.cwd || dirname(file)
      const counts = parsed.counts
      const toolCallCounts: Record<string, number> = {}
      for (const c of parsed.toolCalls) {
        if (c.name) toolCallCounts[c.name] = (toolCallCounts[c.name] || 0) + 1
      }
      const meta: SessionMeta = {
        id: parsed.id || basename(dirname(file)),
        file,
        workspace,
        size: st.size,
        mtimeMs: st.mtimeMs,
        ctimeMs: st.ctimeMs,
        createdAt: parsed.createdAt,
        lastTime: parsed.lastTime,
        title: parsed.title || parsed.firstUserText.slice(0, 80),
        firstUserText: parsed.firstUserText,
        lastAssistantText: parsed.lastAssistantText,
        agentPreset: parsed.agentPreset,
        counts,
        toolNames: Array.from(new Set(parsed.toolCalls.map((c) => c.name))).sort(),
        toolCallCounts,
      }
      byFile.set(file, meta)
      if (prev) updated++
      else added++
    } catch (e) {
      errors.push(`${file}: ${String(e).slice(0, 160)}`)
    }
  }

  // 排序 tie-break 统一为 id（与 cursor 跳过逻辑一致：lastTime desc, id asc）
  const sessions = Array.from(byFile.values()).sort(
    (a, b) => b.lastTime - a.lastTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const index: SessionIndex = {
    version: 1,
    root,
    updatedAt: Date.now(),
    sessions,
  }
  saveIndex(indexFile, index)
  return {
    status: 'completed',
    totalFiles: files.length,
    processed: added + updated,
    headParsed: 0,
    fullParsed: added + updated,
    added,
    updated,
    skipped,
    removed: 0,
    raced: 0,
    failed: 0,
    pruned: 0,
    errors,
    scannedBytes,
    indexFile,
    durationMs: 0,
    maxEventLoopDelayMs: 0,
  }
}

/**
 * async 门面：非阻塞两阶段构建（head pass → quick index 检查点 → full pass → 原子提交）。
 * 进程内 single-flight：并发调用复用同一构建。
 */
export async function buildIndex(
  root: string,
  indexFile: string,
  force = false,
  signal?: AbortSignal,
): Promise<BuildReport> {
  // 动态 import 避免 core ↔ builder 静态循环依赖
  const { getBuilder } = await import('./session-index-builder.js')
  return getBuilder(root, indexFile).build({ force, signal })
}

/* ── P0-4：metaMatch 小写预计算（WeakMap 按对象缓存，配合 loadIndex 缓存生效）── */
interface LoweredMeta {
  id: string
  workspace: string
  title: string
  firstUserText: string
  lastAssistantText: string
  toolNames: string[]
}
const lowerCache = new WeakMap<SessionMeta, LoweredMeta>()

function loweredOf(meta: SessionMeta): LoweredMeta {
  let l = lowerCache.get(meta)
  if (!l) {
    l = {
      id: meta.id.toLowerCase(),
      workspace: meta.workspace.toLowerCase(),
      title: meta.title.toLowerCase(),
      firstUserText: meta.firstUserText.toLowerCase(),
      lastAssistantText: meta.lastAssistantText.toLowerCase(),
      toolNames: meta.toolNames.map((n) => n.toLowerCase()),
    }
    lowerCache.set(meta, l)
  }
  return l
}

export function metaMatch(meta: SessionMeta, query: string): boolean {
  const q = query.toLowerCase()
  const l = loweredOf(meta)
  return (
    l.id.includes(q) ||
    l.workspace.includes(q) ||
    l.title.includes(q) ||
    l.firstUserText.includes(q) ||
    l.lastAssistantText.includes(q) ||
    l.toolNames.some((n) => n.includes(q))
  )
}

export function searchSessionFile(file: string, query: string, maxSnippets: number): SearchHit[] {
  const hits: SearchHit[] = []
  try {
    const text = decompressZstd(file)
    const compat = new SessionLogCompatibility()
    const toolCalls: { seq: number; name: string }[] = []
    for (const line of text.split('\n')) {
      if (!line) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new Error('corrupt session log: JSONL line is not valid JSON')
      }
      for (const event of compat.consumeLine(parsed)) {
        const data = event.data as Record<string, unknown> | undefined
        if (event.type === 'tool/call' && typeof data?.name === 'string') toolCalls.push({ seq: event.seq as number, name: data.name })
      }
    }
    const q = query.toLowerCase()
    const candidates: { seq: number; type: string; text: string }[] = toolCalls.map(call => ({ seq: call.seq, type: 'tool/call', text: call.name }))
    for (const message of compat.finish()) {
      if (message.type === 'tool/result') continue
      candidates.push({ seq: message.seq, type: message.type, text: textFromCompatibleMessage(message) })
    }
    for (const candidate of candidates.sort((a, b) => a.seq - b.seq)) {
      if (hits.length >= maxSnippets) break
      const index = candidate.text.toLowerCase().indexOf(q)
      if (index < 0) continue
      const start = Math.max(0, index - 120)
      const end = Math.min(candidate.text.length, index + query.length + 180)
      const snippet = (start > 0 ? '…' : '') + candidate.text.slice(start, end) + (end < candidate.text.length ? '…' : '')
      hits.push({ sessionId: '', workspace: '', file, kind: 'content', type: candidate.type, snippet: snippet.slice(0, 500) })
    }
  } catch {
    /* 单个文件失败忽略 */
  }
  return hits
}

export function findSession(index: SessionIndex, idOrFile: string): SessionMeta | undefined {
  const q = idOrFile.toLowerCase()
  return index.sessions.find(
    (s) => !s.unindexable && (s.id.toLowerCase() === q || s.file.toLowerCase() === q || s.file.toLowerCase().includes(q)),
  )
}

export function summarizeSession(meta: SessionMeta): SessionSummary {
  const toolCalls = meta.toolNames.map((name) => ({ name, count: meta.toolCallCounts[name] || 0 }))
  return {
    id: meta.id,
    file: meta.file,
    workspace: meta.workspace,
    createdAt: meta.createdAt,
    lastTime: meta.lastTime,
    durationMs: Math.max(0, meta.lastTime - meta.createdAt),
    title: meta.title,
    firstUserText: meta.firstUserText,
    lastAssistantText: meta.lastAssistantText,
    agentPreset: meta.agentPreset,
    counts: meta.counts,
    toolCalls,
  }
}

export function resolveRoot(input: string): string {
  if (input) return isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input)
  return join(process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'), 'sessions')
}

/* ── cursor 稳定分页（对应 Codex list.rs::Cursor / AnchorState）────────────── */

export interface Cursor {
  /** 时间戳（ms） */
  ts: number
  /** tie-break：会话 id（排序键 (lastTime desc, id asc)） */
  id: string
}

/** cursor 格式：`ts|id` 或 `ts`。解析失败返回 null。 */
export function parseCursor(token: string): Cursor | null {
  const sep = token.lastIndexOf('|')
  const tsPart = sep === -1 ? token : token.slice(0, sep)
  const idPart = sep === -1 ? '' : token.slice(sep + 1)
  const ts = Number(tsPart)
  if (!Number.isFinite(ts)) return null
  return { ts, id: idPart }
}

export function formatCursor(meta: SessionMeta): string {
  return `${meta.lastTime}|${meta.id}`
}

/**
 * AnchorState（Codex list.rs）：sessions 必须已按 (lastTime desc, id asc) 排序。
 * 返回跳过 anchor 及其之前已返回区间后的起始下标（新增/变更会话不会错位）。
 * P0-3：排序键已知 → 二分查找，O(n) → O(log n)。
 */
export function cursorStartIndex(sessions: readonly SessionMeta[], cursor: Cursor | null): number {
  if (!cursor) return 0
  // 第一个满足 (lastTime < ts) || (lastTime === ts && id > cursor.id) 的下标
  let lo = 0
  let hi = sessions.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const s = sessions[mid]
    if (s.lastTime < cursor.ts || (s.lastTime === cursor.ts && s.id > cursor.id)) hi = mid
    else lo = mid + 1
  }
  return lo
}
