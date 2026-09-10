/**
 * streaming-parser.ts — fzstd 流式逐行解析（head / full / search 三模式）
 *
 * 对齐 openai/codex@9ded177 reference/codex/codex-rs/rollout/src/list.rs
 * （read_head_for_summary / HEAD_RECORD_LIMIT=10）与 search.rs
 * （first_rollout_content_match_snippet：48/96 字符上下文 snippet）。
 *
 * DSH 的 session.jsonl.zstd 是拼接多帧 zstd（实测小文件 11 帧），fzstd.Decompress
 * 在帧结束后继续处理剩余 chunk（等价 decompress 的循环），流式 push 可行（已实测
 * 与整文件解压逐字节一致）。Node 22 node:zlib 的 zstd 只解第一帧，不可换。
 *
 * 防内存：单 worker 同时只解一个文件；流式逐行解析不保留全文；
 * 解压输出上限 maxDecompressedBytes（256MB），超限记为错误。
 */
import { open } from 'node:fs/promises'
import * as fzstd from 'fzstd'
import { throwIfAborted } from './cancel.js'
import { nativeDecodeZstd, type NativeDecodeStats } from './native-zstd.js'
import type { FtsMessageRow } from './fts.js'
import { MATCH_OPEN, MATCH_CLOSE, normalizeReservedMarkers } from './fts.js'
import {
  SessionLogCompatibility,
  textFromCompatibleMessage,
  type SessionCompatibilityVersion,
} from './session-compat.js'

export interface StreamParseOptions {
  signal?: AbortSignal
  /** 解压输出总字节上限，超限抛错（默认 256MB） */
  maxDecompressedBytes?: number
  /** 单行字节上限，超长行丢弃（默认 4MB） */
  maxLineBytes?: number
  /** 压缩输入分块大小（默认 512KB；仅 fzstd 路径使用） */
  compressedChunkSize?: number
  /** 解码器：'native'（node:zlib 逐帧，失败自动回退 fzstd）| 'fzstd'（强制） */
  decoder?: 'native' | 'fzstd'
  /** P1 delta：压缩输入从该字节偏移开始读（须为帧边界；之前视为已索引） */
  startOffset?: number
}

export interface StreamStats {
  lines: number
  bytes: number
  oversized: number
  stopped: boolean
}

class StopStreaming extends Error {}

/** P2 FTS 收集上限：单会话消息行数 / 单条文本长度（防超大会话内存与 postMessage 开销） */
const MAX_FTS_ROWS = 50_000
const MAX_FTS_TEXT = 1000

/**
 * 流式解压 JSONL：逐行回调 onLine。返回 false 提前停止（head/search 早停）。
 * 解码器：默认 native（node:zlib 逐帧解压，~3-4x fzstd）；任何帧失败/不可用
 * 自动回退 fzstd 流式路径（保留拼接多帧支持）。每个 chunk 检查一次
 * signal.aborted（cooperative cancellation）。
 */
export async function streamJsonlLines(
  file: string,
  onLine: (line: string) => boolean | void,
  options: StreamParseOptions = {},
): Promise<StreamStats> {
  const {
    signal,
    maxDecompressedBytes = 256 * 1024 * 1024,
    maxLineBytes = 4 * 1024 * 1024,
    compressedChunkSize = 512 * 1024,
    decoder: forcedDecoder = 'native',
    startOffset = 0,
  } = options
  const stats: StreamStats = { lines: 0, bytes: 0, oversized: 0, stopped: false }
  let decoder = new TextDecoder('utf-8')
  let buffer = ''

  const emit = (): boolean => {
    for (;;) {
      const idx = buffer.indexOf('\n')
      if (idx === -1) break
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (line.length === 0) continue
      if (line.length > maxLineBytes) {
        stats.oversized++
        continue
      }
      stats.lines++
      if (onLine(line) === false) {
        stats.stopped = true
        return false
      }
    }
    return true
  }

  const feed = (chunk: Uint8Array): boolean => {
    throwIfAborted(signal)
    stats.bytes += chunk.length
    if (stats.bytes > maxDecompressedBytes) {
      throw new Error(`decompressed size exceeds ${maxDecompressedBytes} bytes`)
    }
    buffer += decoder.decode(chunk, { stream: true })
    return emit()
  }

  const flush = (): void => {
    if (stats.stopped) return
    buffer += decoder.decode()
    emit()
  }

  // ── native 路径（node:zlib 逐帧）；仅当尚未向 caller 喂出任何行时才回退 fzstd ──
  if (forcedDecoder !== 'fzstd') {
    try {
      const ns: NativeDecodeStats = await nativeDecodeZstd(file, feed, {
        signal,
        maxDecompressedBytes,
        startOffset,
      })
      if (ns.stopped || stats.stopped) return stats
      flush()
      return stats
    } catch (e) {
      if (e instanceof StopStreaming) return stats
      if (stats.stopped) return stats
      // Fix ③（2026-09-10 回归修复）：回退只在"还没向 caller 喂过任何一行"时才安全。
      // parseHead / parseFull / parseSearch 各自 new 一个 SessionLogCompatibility 并
      // 在 onLine 里推进它；native 路径一旦喂出过行（包括 onLine 自己抛错的情况），
      // caller 的状态已被推进，从文件头重放必然撞上 expectedSeq，恒抛
      // "malformed event envelope at seq N"（N = 真实错误位置 +1），把真实原因
      // （未知事件类型 / 消息契约不符）整条掩盖——全量构建的 error 字段因此失去
      // 诊断价值。已喂过行时直接上抛原始错误。
      if (stats.lines > 0) throw e
      // 回退：重置状态，走 fzstd 流式（仅首帧损坏等"零行喂出"场景）
      decoder = new TextDecoder('utf-8')
      buffer = ''
      stats.lines = 0
      stats.bytes = 0
      stats.oversized = 0
      stats.stopped = false
    }
  }

  // ── fzstd 流式路径（保留对拼接多帧的完整支持）──
  const handle = await open(file, 'r')
  try {
    const stream = new fzstd.Decompress((chunk: Uint8Array) => {
      if (!feed(chunk)) throw new StopStreaming()
    })
    const readBuf = Buffer.alloc(compressedChunkSize)
    let position = startOffset
    for (;;) {
      throwIfAborted(signal)
      const { bytesRead } = await handle.read(readBuf, 0, readBuf.length, position)
      if (bytesRead === 0) break
      // 关键：fzstd.Decompress 在帧头未凑齐时会内部持有 chunk 引用（this.c.push），
      // 复用 readBuf 会被下一轮 read 覆盖 → 帧头污染 → invalid zstd data。
      // 必须拷贝一份再 push。
      stream.push(new Uint8Array(readBuf.subarray(0, bytesRead)))
      position += bytesRead
    }
    stream.push(new Uint8Array(0), true)
    flush()
    return stats
  } catch (e) {
    if (e instanceof StopStreaming) return stats
    throw e
  } finally {
    await handle.close()
  }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (c): c is { type: string; text?: unknown } =>
        !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text',
    )
    .map((c) => (typeof c.text === 'string' ? c.text : ''))
    .join(' ')
    .trim()
}

function eventTime(obj: Record<string, unknown>): number {
  const t = obj.time
  if (typeof t === 'number') return t
  const t0 = obj.time0
  return typeof t0 === 'number' ? t0 : 0
}

function applyHeader(out: {
  id: string
  createdAt: number
  cwd: string
  agentPreset: string
  parentSession?: string
  sawSessionMeta?: boolean
}, compat: SessionLogCompatibility): void {
  const header = compat.header
  out.id = header.id
  out.createdAt = header.createdAt
  out.cwd = header.cwd
  out.agentPreset = header.agentPreset
  if (header.parentSession !== undefined) out.parentSession = header.parentSession
  out.sawSessionMeta = true
}

/* ── head 模式（对应 list.rs::read_head_for_summary）────────────── */

export interface HeadSummary {
  id: string
  createdAt: number
  cwd: string
  agentPreset: string
  title: string
  firstUserText: string
  lastTime: number
  sawSessionMeta: boolean
  records: number
  compatibility: SessionCompatibilityVersion
  /** P3 lineage：父会话 id（header 帧字段） */
  parentSession?: string
}

/**
 * 只流式解压文件头部（对应 list.rs::read_head_summary）：
 * - 基础窗口 maxRecords（默认 10）条非空记录；
 * - 若已见 session meta 但 firstUserText/title 未齐，最多再扫
 *   maxRecords + userEventScanLimit(200) 条（Codex USER_EVENT_SCAN_LIMIT 同款
 *   扩展：title 事件常出现在首条 user 消息之后）。
 * id/createdAt/cwd/agentPreset/title/firstUserText 基本都在头部。
 */
export async function parseHead(
  file: string,
  options: {
    signal?: AbortSignal
    maxRecords?: number
    compressedChunkSize?: number
    decoder?: 'native' | 'fzstd'
    maxDecompressedBytes?: number
    startOffset?: number
  } = {},
): Promise<HeadSummary> {
  const maxRecords = options.maxRecords ?? 10
  const userEventScanLimit = 200
  const out: HeadSummary = {
    id: '',
    createdAt: 0,
    cwd: '',
    agentPreset: '',
    title: '',
    firstUserText: '',
    lastTime: 0,
    sawSessionMeta: false,
    records: 0,
    compatibility: 'alpha3',
  }
  const keepScanning = (): boolean => {
    if (out.records < maxRecords) return true
    if (
      out.sawSessionMeta &&
      (out.firstUserText === '' || out.title === '') &&
      out.records < maxRecords + userEventScanLimit
    ) {
      return true
    }
    return false
  }
  const compat = new SessionLogCompatibility()
  await streamJsonlLines(
    file,
    (line) => {
      out.records++
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new Error('corrupt session log: JSONL line is not valid JSON')
      }
      const events = compat.consumeLine(parsed)
      applyHeader(out, compat)
      for (const obj of events) {
        const type = obj.type as string
        const t = eventTime(obj)
        if (t > out.lastTime) out.lastTime = t
        if (type === 'session/title') {
          const data = obj.data as Record<string, unknown> | undefined
          if (typeof data?.title === 'string' && data.title) out.title = data.title
        }
      }
      return keepScanning()
    },
    {
      signal: options.signal,
      compressedChunkSize: options.compressedChunkSize,
      decoder: options.decoder,
      maxDecompressedBytes: options.maxDecompressedBytes,
      startOffset: options.startOffset,
    },
  )
  for (const message of compat.finish()) {
    if (message.type !== 'user/message' || out.firstUserText) continue
    const text = textFromCompatibleMessage(message)
    if (text) out.firstUserText = text.slice(0, 500)
  }
  out.compatibility = compat.version
  return out
}

/* ── full 模式（全量累计 counts/toolCallCounts/lastTime/lastAssistantText）──── */

export interface FullSummary {
  id: string
  createdAt: number
  cwd: string
  agentPreset: string
  title: string
  firstUserText: string
  lastAssistantText: string
  lastTime: number
  counts: Record<string, number>
  toolCallCounts: Record<string, number>
  events: number
  /** P3 lineage：父会话 id */
  parentSession?: string
  /** P2 FTS：collectMessages=true 时收集的消息行（user/assistant 文本 + tool 名） */
  messages?: FtsMessageRow[]
  compatibility: SessionCompatibilityVersion
}

export async function parseFull(
  file: string,
  options: {
    signal?: AbortSignal
    lastTextLimit?: number
    compressedChunkSize?: number
    decoder?: 'native' | 'fzstd'
    maxDecompressedBytes?: number
    startOffset?: number
    /** P2 FTS：为 true 时逐条收集 user/assistant 文本与 tool 名（供 SQLite FTS） */
    collectMessages?: boolean
  } = {},
): Promise<FullSummary> {
  const lastTextLimit = options.lastTextLimit ?? 2000
  const collectMessages = options.collectMessages ?? false
  const out: FullSummary = {
    id: '',
    createdAt: 0,
    cwd: '',
    agentPreset: '',
    title: '',
    firstUserText: '',
    lastAssistantText: '',
    lastTime: 0,
    counts: {},
    toolCallCounts: {},
    events: 0,
    compatibility: 'alpha3',
  }
  const messages: FtsMessageRow[] | undefined = collectMessages ? [] : undefined
  const pushMessage = (role: FtsMessageRow['role'], text: string, toolName = ''): void => {
    if (!messages || messages.length >= MAX_FTS_ROWS) return
    if (!text && !toolName) return
    messages.push({
      sessionFile: file,
      role,
      text: text.slice(0, MAX_FTS_TEXT),
      toolName: toolName.slice(0, 200),
    })
  }
  const compat = new SessionLogCompatibility()
  await streamJsonlLines(
    file,
    (line) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new Error('corrupt session log: JSONL line is not valid JSON')
      }
      const events = compat.consumeLine(parsed)
      applyHeader(out, compat)
      for (const obj of events) {
        const type = obj.type as string
        out.counts[type] = (out.counts[type] || 0) + 1
        out.events++
        const t = eventTime(obj)
        if (t > out.lastTime) out.lastTime = t
        const data = obj.data as Record<string, unknown> | undefined
        if (type === 'session/title' && typeof data?.title === 'string' && data.title) {
          out.title = data.title
        }
        if (type === 'tool/call' && typeof data?.name === 'string' && data.name) {
          out.toolCallCounts[data.name] = (out.toolCallCounts[data.name] || 0) + 1
          pushMessage('tool', '', data.name)
        }
      }
      return true
    },
    {
      signal: options.signal,
      compressedChunkSize: options.compressedChunkSize,
      decoder: options.decoder,
      maxDecompressedBytes: options.maxDecompressedBytes,
      startOffset: options.startOffset,
    },
  )
  for (const message of compat.finish()) {
    const text = textFromCompatibleMessage(message)
    if (message.type === 'user/message') {
      if (text && !out.firstUserText) out.firstUserText = text.slice(0, 500)
      if (text) pushMessage('user', text)
    } else if (message.type === 'assistant/message') {
      if (text) out.lastAssistantText = text.slice(0, lastTextLimit)
      if (text) pushMessage('assistant', text)
    }
  }
  out.compatibility = compat.version
  if (messages) out.messages = messages
  return out
}

/* ── search 模式（对应 search.rs::first_rollout_content_match_snippet）────── */

export interface SearchHit {
  type: string
  snippet: string
  /**
   * STAGE-1 Part B（可选、加性字段）：消息级 role（user/assistant/tool），供
   * worker 回退路径的 filter.role 按行过滤（与 src/fts.ts 的 SearchFilter 对齐：
   * tool 判定 = tool name 非空）。既有消费方（index.ts 仅用 type/snippet）无感。
   */
  role?: 'user' | 'assistant' | 'tool'
  /** STAGE-1 Part B：tool/call 行的工具名（工具行 snippet 与 FTS 侧一致留空）。 */
  toolName?: string
}

export interface SearchOptions {
  signal?: AbortSignal
  maxSnippets?: number
  /** 命中前上下文字符数（Codex MATCH_CONTEXT_BEFORE_CHARS=48） */
  contextBefore?: number
  /** 命中后上下文字符数（Codex MATCH_CONTEXT_AFTER_CHARS=96） */
  contextAfter?: number
  /** 压缩输入分块大小（测试跨块场景用） */
  compressedChunkSize?: number
  decoder?: 'native' | 'fzstd'
  maxDecompressedBytes?: number
  startOffset?: number
}

/**
 * 逐行匹配 JSON 转义字面量（大小写不敏感），命中后从解析出的
 * user/message、assistant/message 文本取上下文 snippet，凑满 maxSnippets 即停。
 */
export async function parseSearch(
  file: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const maxSnippets = options.maxSnippets ?? 3
  const contextBefore = options.contextBefore ?? 48
  const contextAfter = options.contextAfter ?? 96
  const jsonEscaped = JSON.stringify(query).slice(1, -1).toLowerCase()
  const qLower = query.toLowerCase()
  const hits: SearchHit[] = []
  const toolNames: string[] = []
  const compat = new SessionLogCompatibility()
  await streamJsonlLines(
    file,
    (line) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new Error('corrupt session log: JSONL line is not valid JSON')
      }
      const events = compat.consumeLine(parsed)
      for (const event of events) {
        if (event.type !== 'tool/call') continue
        const data = event.data as Record<string, unknown> | undefined
        if (typeof data?.name === 'string') toolNames.push(data.name)
      }
      return true
    },
    {
      signal: options.signal,
      compressedChunkSize: options.compressedChunkSize,
      decoder: options.decoder,
      maxDecompressedBytes: options.maxDecompressedBytes,
    },
  )
  for (const name of toolNames) {
    if (hits.length >= maxSnippets) break
    if (name.toLowerCase().includes(qLower)) hits.push({ type: 'tool/call', snippet: '', role: 'tool', toolName: name })
  }
  for (const message of compat.finish()) {
    if (hits.length >= maxSnippets || (message.type !== 'user/message' && message.type !== 'assistant/message')) continue
    const text = textFromCompatibleMessage(message)
    if (!text || !JSON.stringify(text).toLowerCase().includes(jsonEscaped)) continue
    const normalized = normalizeReservedMarkers(text.split(/\s+/).filter(Boolean).join(' '))
    const index = normalized.toLowerCase().indexOf(qLower)
    if (index === -1) continue
    const snippet = excerptAroundMatch(normalized, index, query.length, contextBefore, contextAfter)
    if (snippet) hits.push({ type: message.type, snippet, role: message.type === 'user/message' ? 'user' : 'assistant' })
  }
  return hits
}

/** 对应 search.rs::excerpt_around_match（normalize 后取 48/96 字符上下文）。 */
function excerptAroundMatch(
  text: string,
  matchStart: number,
  matchLength: number,
  charsBefore: number,
  charsAfter: number,
): string | null {
  const excerptStart = Math.max(0, matchStart - charsBefore)
  const excerptEnd = Math.min(text.length, matchStart + matchLength + charsAfter)
  const excerptRaw = text.slice(excerptStart, excerptEnd)
  const trimShift = excerptRaw.length - excerptRaw.trimStart().length
  const excerpt = excerptRaw.trim()
  if (!excerpt) return null
  // P1.4：命中区间用 >>> <<< 包住（Hermes MATCH_OPEN/CLOSE，与 FTS 路径同款）。
  // 先去掉 trimStart 造成的偏移，保证标记落在命中原文上
  const relStart = matchStart - excerptStart - trimShift
  const relEnd = relStart + matchLength
  let snippet = ''
  if (excerptStart > 0) snippet += '... '
  snippet += excerpt.slice(0, relStart)
  snippet += MATCH_OPEN + excerpt.slice(relStart, relEnd) + MATCH_CLOSE
  snippet += excerpt.slice(relEnd)
  if (excerptEnd < text.length) snippet += ' ...'
  return snippet
}
