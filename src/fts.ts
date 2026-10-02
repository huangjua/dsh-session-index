/**
 * fts.ts — SQLite + FTS5 全文索引（P2，借鉴 NousResearch/hermes-agent hermes_state.py）
 *
 * 设计对照（hermes SessionDB）：
 * - 单 FTS5 表：`trigram`（tokenize='trigram'）。
 *   历史（schema v1→v2）：v1 照抄 hermes 的双表设计（unicode61 拉丁词 + trigram CJK），
 *   实测（node:sqlite + SQLite FTS5）：unicode61 把整个 CJK 连续串当单个 token，
 *   中文子串查询必失配；trigram 对 ≥3 字任意脚本子串命中。后续 trigram 路径补齐
 *   「词整体引号化 + AND 零命中自动 OR + 1-2 字 LIKE 兜底」后接管全部查询，
 *   unicode61 表沦为"只写不读"（写放大 ~2×、库体积 ~2×，全仓无任何 SELECT）。
 *   v2 迁移：删 unicode61 表与其触发器 + VACUUM（幂等，失败保持 v1 降级可用，
 *   下次启动重试；会话文件仍是唯一事实源，fts.db 可随时删库重建）。
 *   查询路由：全部词 ≥3 字 → trigram MATCH（BM25 排序，AND→OR 放宽）；
 *   含 <3 字词（1-2 字中文等）→ LIKE 兜底（保证子串语义不丢）。
 * - 外部内容表 + 触发器（照 FTS_CJK_TRIGGER_SQL 模式）自动维护 FTS 影子表；
 * - 优雅降级：node:sqlite 缺失 / FTS5 不可用 / 任何初始化失败 → createSessionFts
 *   返回 null，调用方回退现有 worker 池流式搜索；
 * - 维护：optimize（FTS 段合并）+ VACUUM，带 watermark 节流（照 maybe_auto_prune_and_vacuum）。
 *
 * DSH 会话文件仍是唯一事实源；SQLite 只是派生全文索引，可随时删库重建（一次 force 回填）。
 *
 * P1.3 移植：sanitizeFts5Query 照抄 Hermes `_sanitize_fts5_query`（MIT，
 * Copyright (c) 2025 Nous Research；TS 移植出处 dsh-local-memory/
 * src/session-index/query.ts），净化语义不做任何改动，只做"先净化再进
 * trigram/LIKE 路由"的接入；trigram AND 零命中自动 OR 放宽重试一次。
 * P1.4 命中标记：>>> <<<（dsh-local-memory 的 MATCH_OPEN/CLOSE 同款）。
 * 正文入库前归一化保留标记（与 DSH 官方 session-query-sqlite README
 * reserved highlight markers 约束一致），snippet 生成时才包住命中区间。
 */
import { mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
// C11：命中标记常量与 snippet 生成的单一事实源（本文件 re-export 给旧引用方）
import { MATCH_OPEN, MATCH_CLOSE, excerptAroundMatch } from './core.js'
import type { SessionMeta } from './core.js'
import { createQueryPlan } from './query-plan.js'
export { sanitizeFts5Query } from './query-plan.js'

export interface FtsMessageRow {
  sessionFile: string
  role: 'user' | 'assistant' | 'tool'
  /** user/assistant 文本；role=tool 时为 '' */
  text: string
  toolName: string
  anchorId?: string
  eventSeq?: number
  eventType?: string
  sourceMessageId?: string
  callId?: string
  generation?: number
  identityEvidence?: string
}

export interface FtsHit {
  sessionId: string
  sessionFile: string
  workspace: string
  title: string
  role: string
  text: string
  toolName: string
  snippet: string
  /** P3 SCROLL 锚点：messages 表行 id（按序 = 时间序） */
  messageId: number
  textTruncated?: boolean
  matchCount?: number
  anchorId?: string
  eventSeq?: number
  /** P3 lineage：lineage root id（parent_session 或自身 id） */
  lineageRoot: string
  /**
   * STAGE-1 Part A（可选、加性字段）：bm25(messages_fts_trigram) 原值（≤0，越小越
   * 相关）。仅 trigram 路径填充；LIKE 兜底路径无此列 → 缺省 undefined。
   * 供会话级 best-rank 聚合（src/rank.ts）使用；既有消费方无感。
   */
  bm25?: number
}

/**
 * STAGE-1 Part B：session_index_search 的 filter 参数底座（消息级 role + 会话级
 * 时间范围）。
 * - role='tool' 判定 = tool_name 非空（消息行由 builder 写入 role='tool' +
 *   toolName，见 streaming-parser.ts pushMessage），与 fts.ts 的 role/toolName
 *   列语义对齐；
 * - messages 表无时间列（id 仅自增 = 插入序）→ sinceMs/untilMs 降级为
 *   sessions.last_time 会话级过滤，与 meta / worker 回退路径口径一致
 *   （schema 描述已注明）。
 */
export interface SearchFilter {
  queryMode?: 'and' | 'or'
  role?: 'user' | 'assistant' | 'tool' | 'any'
  sinceMs?: number
  untilMs?: number
}

export interface FtsSessionMeta {
  file: string
  id: string
  workspace: string
  title: string
  agentPreset: string
  createdAt: number
  lastTime: number
  parentSession?: string
}

function searchConstraints(workspace: string, filter?: SearchFilter): { sql: string; params: unknown[] } {
  let sql = ''
  const params: unknown[] = []
  if (workspace) {
    sql += ` AND s.search_workspace LIKE ? ESCAPE '\\'`
    params.push('%' + escapeLike(workspace.toLowerCase()) + '%')
  }
  if (filter?.role && filter.role !== 'any') {
    if (filter.role === 'tool') sql += ` AND m.tool_name != ''`
    else {
      sql += ' AND m.role = ?'
      params.push(filter.role)
    }
  }
  if (typeof filter?.sinceMs === 'number' && Number.isFinite(filter.sinceMs)) {
    sql += ' AND s.last_time >= ?'
    params.push(filter.sinceMs)
  }
  if (typeof filter?.untilMs === 'number' && Number.isFinite(filter.untilMs)) {
    sql += ' AND s.last_time <= ?'
    params.push(filter.untilMs)
  }
  return { sql, params }
}

/** 正常应用路径由 fts-worker 持有引擎；原消息和 chunk 在同一事务内提交。 */
export const FTS_PARSER_VERSION = 'session-index/3-chunks'
export interface FtsSearchPage { hits: FtsHit[]; total: number; totalExact: boolean; hasMore: boolean }
export interface FtsSourceFingerprint {
  file: string
  sessionId: string
  size: number
  mtimeMs: number
  ctimeMs: number
  indexedBytes: number
  indexedSeq?: number
  complete: boolean
}
export interface FtsCheckpoint extends FtsSourceFingerprint {
  parserVersion: string
  messageCount: number
}
export interface SyncSessionRequest {
  meta: FtsSessionMeta
  sourceFingerprint: FtsSourceFingerprint
  parserVersion: string
  mode: 'replace' | 'append'
  expectedBase?: FtsCheckpoint
  messages: FtsMessageRow[]
}
export interface SyncReceipt {
  checkpoint: FtsCheckpoint
  duplicate: boolean
}

export function checkpointOf(meta: SessionMeta): FtsSourceFingerprint {
  return { file: meta.file, sessionId: meta.id, size: meta.size, mtimeMs: meta.mtimeMs,
    ctimeMs: meta.ctimeMs ?? -1, indexedBytes: meta.indexedBytes ?? meta.size,
    indexedSeq: meta.indexedSeq, complete: !meta.detailMissing && !meta.unindexable && meta.coverage?.complete !== false }
}

function sameSource(a: FtsSourceFingerprint, b: FtsSourceFingerprint): boolean {
  return a.file === b.file && a.sessionId === b.sessionId && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.indexedBytes === b.indexedBytes &&
    a.indexedSeq === b.indexedSeq && a.complete === b.complete
}

type DatabaseSyncCtor = new (path: string, options?: {readOnly?:boolean}) => FtsDbLike

export interface FtsOptions {
  readOnly?: boolean
  busyTimeoutMs?: number
  /** Called between synchronous migration batches, not from a blocked interval. */
  onMigrationProgress?: (progress: FtsMigrationProgress) => void
  migrationLockTimeoutMs?: number
  /** Worker startup must distinguish a database failure from unsupported SQLite. */
  throwOnError?: boolean
  onQueryTiming?: (timing: { op: string; sqlMs: number; processingMs: number }) => void
}

export interface FtsMigrationProgress {
  phase: string
  completed: number
  total?: number
  elapsedMs: number
  at?: number
}

interface FtsDbLike {
  exec(sql: string): void
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown }
  close(): void
}

/**
 * 异步工厂：动态 import node:sqlite（Node <22.5 时模块不存在 → 静默降级）。
 * 任何一步失败返回 null（绝不抛出，绝不影响主索引构建）。
 */
export async function createSessionFts(dbPath: string, options: FtsOptions = {}): Promise<SessionFts | null> {
  let mod: { DatabaseSync?: DatabaseSyncCtor } | null = null
  try {
    mod = (await import('node:sqlite')) as { DatabaseSync?: DatabaseSyncCtor }
  } catch (error) {
    if (options.throwOnError) throw error
    return null
  }
  if (!mod || typeof mod.DatabaseSync !== 'function') return null
  try {
    const fts = new SessionFts(dbPath, mod.DatabaseSync,options)
    if (!fts.ok) return null
    return fts
  } catch (error) {
    if (options.throwOnError) throw error
    return null
  }
}

export class SessionFts {
  readonly ok: boolean
  private readonly dbPath: string
  private db: FtsDbLike | null = null
  /** All accepted writes serialize; their promises and flush propagate errors. */
  private syncChain: Promise<void> = Promise.resolve()
  private closing = false
  private closePromise: Promise<void> | null = null
  private nextWrite = 0
  private failures: { id: number; error: Error }[] = []
  private failedFiles = new Set<string>()
  private pendingWrites = 0
  private lastWriteError = ''
  private lastWriteErrorAt = 0
  private readonly migrationStartedAt = Date.now()
  private migrationCompleted = 0
  private migrationTotal: number | undefined
  private querySqlMs: number | undefined

  private measureSql<T>(work: () => T): T {
    const started = performance.now()
    try { return work() }
    finally { if (this.querySqlMs !== undefined) this.querySqlMs += performance.now() - started }
  }

  private timedQuery<T>(op: string, work: () => T): T {
    const outer = this.querySqlMs, started = performance.now()
    this.querySqlMs = 0
    try { return work() }
    finally {
      const sqlMs = this.querySqlMs
      this.querySqlMs = outer
      this.options.onQueryTiming?.({ op, sqlMs, processingMs: Math.max(0, performance.now() - started - sqlMs) })
    }
  }

  private migrationProgress(phase: string, completed?: number, total?: number): void {
    const at = Date.now()
    if (phase === 'chunks' || phase === 'commit') {
      this.migrationCompleted = completed ?? 0
      this.migrationTotal = total
    }
    this.options.onMigrationProgress?.({ phase, completed: completed ?? (phase === 'complete' ? this.migrationCompleted : 0),
      total: total ?? (phase === 'complete' ? this.migrationTotal : undefined), elapsedMs: at - this.migrationStartedAt, at })
  }

  constructor(dbPath: string, DatabaseSync: DatabaseSyncCtor, private readonly options: FtsOptions = {}) {
    this.dbPath = dbPath
    if (options.busyTimeoutMs !== undefined && (!Number.isFinite(options.busyTimeoutMs) || options.busyTimeoutMs < 0)) {
      throw new RangeError('FTS busyTimeoutMs must be finite and non-negative')
    }
    if (options.migrationLockTimeoutMs !== undefined && (!Number.isFinite(options.migrationLockTimeoutMs) || options.migrationLockTimeoutMs < 0)) {
      throw new RangeError('FTS migrationLockTimeoutMs must be finite and non-negative')
    }
    try {
      mkdirSync(dirname(dbPath), { recursive: true })
      this.db = new DatabaseSync(dbPath, options.readOnly ? {readOnly:true} : {})
      if(options.readOnly) {
        this.db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0')
        this.ok=true
        return
      }
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
      this.db.exec('PRAGMA busy_timeout = 0')
      this.initSchema()
      this.ok = true
    } catch (e) {
      try { this.db?.close() } catch { /* initialization failed */ }
      this.db = null
      this.ok = false
      if (options.throwOnError) throw e
      console.warn(`[session-index] FTS disabled: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /* ── schema（照 hermes FTS_CJK 模式：外部内容表 + 触发器）────────────── */

  private initSchema(): void {
    const db = this.db!
    // A current database does not need DDL, workspace updates, or maintenance.
    // The small expression index is installed once for mixed legacy/source ordering.
    const current = () => {
      let version: { value: string } | undefined
      try {
        version = db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get() as { value: string } | undefined
      } catch (error) {
        if (/no such table: state_meta/.test(String(error))) return false
        throw error
      }
      if (version?.value && !['1','2','3','4','5'].includes(version.value)) {
        throw Object.assign(new Error('Unsupported FTS schema version'), { code: 'EFTSSCHEMA' })
      }
      const order = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name='idx_messages_source_order'").get()
      return version?.value === '5' && !!order
    }
    if (current()) return
    this.migrationProgress('lock-acquire')
    const lockDeadline = Date.now() + (this.options.migrationLockTimeoutMs ?? 180_000)
    const pause = new Int32Array(new SharedArrayBuffer(4))
    while (true) {
      try { db.exec('BEGIN IMMEDIATE'); break }
      catch (error) {
        if (!/SQLITE_BUSY|SQLITE_LOCKED|database (?:is )?locked/i.test(String(error))) throw error
        if (Date.now() >= lockDeadline) throw Object.assign(new Error('FTS migration lock deadline exceeded'), { code: 'EFTSMIGRATIONLOCK' })
        // Waiting for another writer is real lock contention, never fake row progress.
        this.migrationProgress('lock-wait')
        Atomics.wait(pause, 0, 0, Math.min(50, Math.max(1, lockDeadline - Date.now())))
      }
    }
    try {
      // A second instance may have completed migration while this one waited.
      if (current()) { db.exec('COMMIT'); this.migrationProgress('complete'); return }
      this.migrationProgress('schema')
      db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  file TEXT PRIMARY KEY,
  id TEXT NOT NULL DEFAULT '',
  workspace TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  agent_preset TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  last_time INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  parent_session TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_file TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  tool_name TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_file);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram USING fts5(
  text, tool_name,
  content='messages', content_rowid='id',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts_trigram(rowid, text, tool_name) VALUES (new.id, new.text, new.tool_name);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_trigram_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts_trigram(messages_fts_trigram, rowid, text, tool_name)
    VALUES ('delete', old.id, old.text, old.tool_name);
END;
CREATE TABLE IF NOT EXISTS state_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS fts_checkpoints (
  file TEXT PRIMARY KEY,
  checkpoint_json TEXT NOT NULL
);
INSERT OR IGNORE INTO state_meta(key, value) VALUES ('schema_version', '2');
`)
      this.migrateSessionsSchema()
      this.migrateSchemaV2()
      this.migrateMessagesSchema()
      db.exec('COMMIT')
      this.migrationProgress('complete')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* preserve the migration failure */ }
      throw error
    }
  }

  /**
   * Remove the unused unicode61 index inside the shared migration transaction.
   * Startup does not VACUUM; failure rolls back schema and version together.
   */
  private migrateSchemaV2(): void {
    const db = this.db!
    const row = db.prepare("SELECT value FROM state_meta WHERE key = 'schema_version'").get() as
      | { value: string | null }
      | undefined
    if (String(row?.value ?? '1') !== '1') return
    const ftsTables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'messages_fts'",
    ).all() as { name: string }[]
    if (ftsTables.length > 0) {
      db.exec('DROP TRIGGER IF EXISTS messages_fts_insert')
      db.exec('DROP TRIGGER IF EXISTS messages_fts_delete')
      db.exec('DROP TABLE IF EXISTS messages_fts')
    }
    db.prepare("INSERT OR REPLACE INTO state_meta(key, value) VALUES ('schema_version', '2')").run()
  }

  /** 派生库轻量迁移：旧库缺 parent_session 列 → ALTER ADD（不丢数据）。 */
  private migrateSessionsSchema(): void {
    const db = this.db!
    const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    if (cols.length && !cols.some((c) => c.name === 'parent_session')) {
      db.exec("ALTER TABLE sessions ADD COLUMN parent_session TEXT NOT NULL DEFAULT ''")
    }
  }

  /** Add identity without inventing a source seq for historical rowids. */
  private migrateMessagesSchema(): void {
    const db = this.db!
    {
      const cols = new Set((db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map(c => c.name))
      for (const [name, type] of [['anchor_id', 'TEXT'], ['event_seq', 'INTEGER'], ['event_type', 'TEXT'],
        ['source_message_id', 'TEXT'], ['call_id', 'TEXT'], ['generation', 'INTEGER'], ['identity_evidence', 'TEXT'], ['search_text', 'TEXT'], ['search_tool', 'TEXT']]) {
        if (!cols.has(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`)
      }
      const sessionCols=new Set((db.prepare('PRAGMA table_info(sessions)').all() as {name:string}[]).map(c=>c.name))
      if(!sessionCols.has('search_workspace')) db.exec("ALTER TABLE sessions ADD COLUMN search_workspace TEXT NOT NULL DEFAULT ''")
      const version = db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get() as { value: string } | undefined
      if (version?.value !== '5' || !sessionCols.has('search_workspace')) {
        const sessions = db.prepare('SELECT file,workspace FROM sessions').all() as {file:string;workspace:string}[]
        const updateWorkspace = db.prepare('UPDATE sessions SET search_workspace=? WHERE file=?')
        this.migrationProgress('workspace', 0, sessions.length)
        for (let i = 0; i < sessions.length; i++) {
          updateWorkspace.run(sessions[i].workspace.toLowerCase(), sessions[i].file)
          if ((i + 1) % 100 === 0 || i + 1 === sessions.length) this.migrationProgress('workspace', i + 1, sessions.length)
        }
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(session_file,event_seq,id);
CREATE INDEX IF NOT EXISTS idx_messages_source_order ON messages(session_file,COALESCE(event_seq,id),id);
CREATE INDEX IF NOT EXISTS idx_messages_anchor ON messages(session_file,anchor_id);
CREATE TABLE IF NOT EXISTS message_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL, char_start INTEGER NOT NULL, char_end INTEGER NOT NULL,
  text TEXT NOT NULL, tool_name TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_chunks_message ON message_chunks(message_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text,tool_name,content='message_chunks',content_rowid='id',tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS chunks_insert AFTER INSERT ON message_chunks BEGIN
  INSERT INTO chunks_fts(rowid,text,tool_name) VALUES(new.id,new.text,new.tool_name);
END;
CREATE TRIGGER IF NOT EXISTS chunks_delete AFTER DELETE ON message_chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts,rowid,text,tool_name) VALUES('delete',old.id,old.text,old.tool_name);
END;
CREATE TRIGGER IF NOT EXISTS messages_chunks_delete AFTER DELETE ON messages BEGIN
  DELETE FROM message_chunks WHERE message_id=old.id;
END;`)
      // Legacy full-text table remains readable, but new writes use chunks only.
      db.exec('DROP TRIGGER IF EXISTS messages_fts_trigram_insert; DROP TRIGGER IF EXISTS messages_fts_trigram_delete;')
      if (version?.value !== '5') {
        this.migrationProgress('chunks-reset')
        db.exec('DELETE FROM message_chunks')
        const total = Number((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as {n:number}).n)
        const select = db.prepare('SELECT id,text,tool_name FROM messages WHERE id>? ORDER BY id LIMIT 100')
        const update = db.prepare('UPDATE messages SET search_text=?,search_tool=? WHERE id=?')
        const insert = db.prepare('INSERT INTO message_chunks(message_id,chunk_index,char_start,char_end,text,tool_name) VALUES(?,?,?,?,?,?)')
        let cursor=0, completed=0
        this.migrationProgress('chunks', completed, total)
        while(true) {
          const batch=select.all(cursor) as {id:number;text:string;tool_name:string}[]
          if(!batch.length) break
          for(const row of batch) {
            update.run(row.text.toLowerCase(),row.tool_name.toLowerCase(),row.id)
            this.insertChunks(row.id,row.text,row.tool_name,insert);cursor=row.id;completed++
          }
          this.migrationProgress('chunks', completed, total)
        }
        this.migrationProgress('commit', completed, total)
        db.prepare("INSERT OR REPLACE INTO state_meta(key,value) VALUES('schema_version','5')").run()
      }
    }
  }

  private insertChunks(id: number, text: string, toolName: string, prepared?: ReturnType<FtsDbLike['prepare']>): void {
    const insert = prepared ?? this.db!.prepare('INSERT INTO message_chunks(message_id,chunk_index,char_start,char_end,text,tool_name) VALUES(?,?,?,?,?,?)')
    // UTF-16 offsets refer to the original text, boundaries never split a surrogate pair.
    let start = 0, index = 0
    do {
      let end = Math.min(text.length, start + 4096)
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
      insert.run(id,index++,start,end,text.slice(start,end).toLowerCase(),toolName.toLowerCase())
      if (end >= text.length) break
      start = end - 128
      if (/[\uDC00-\uDFFF]/.test(text[start])) start--
    } while (start < text.length)
  }

  /* ── 会话级 upsert / 消息同步 ─────────────────────────────────────── */

  private upsertNow(meta: FtsSessionMeta): void {
    this.db!.prepare(
      `INSERT INTO sessions(file, id, workspace, title, agent_preset, created_at, last_time, updated_at, parent_session,search_workspace)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(file) DO UPDATE SET
         id=excluded.id, workspace=excluded.workspace, title=excluded.title,
         agent_preset=excluded.agent_preset, created_at=excluded.created_at,
         last_time=excluded.last_time, updated_at=excluded.updated_at, parent_session=excluded.parent_session,search_workspace=excluded.search_workspace`,
    ).run(meta.file, meta.id, meta.workspace, meta.title, meta.agentPreset, meta.createdAt, meta.lastTime, Date.now(), meta.parentSession ?? '',meta.workspace.toLowerCase())
  }

  /** All writes, including maintenance and metadata, use this single entrance. */
  private enqueue<T>(file: string | undefined, work: () => T | Promise<T>): Promise<T> {
    const id = ++this.nextWrite
    const unavailable = this.closing || !this.ok || !this.db
    this.pendingWrites++
    const request = this.syncChain.then(async () => {
      if (unavailable || !this.db) throw new Error('FTS is closed or unavailable')
      const deadline = Date.now() + (this.options.busyTimeoutMs ?? 1500)
      while (true) {
        try {
          const value = await work()
          if (file) this.failedFiles.delete(file)
          return value
        } catch (error) {
          const busy = /SQLITE_BUSY|SQLITE_LOCKED|database (?:is )?locked/i.test(String(error))
          if (!busy || Date.now() >= deadline) throw error
          await new Promise<void>(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))))
        }
      }
    })
    // Handle the internal rejection while preserving it for awaiters and flush.
    this.syncChain = request.then(() => {}, error => {
      const e = error instanceof Error ? error : new Error(String(error))
      this.failures.push({ id, error: e })
      this.lastWriteError = e.message
      this.lastWriteErrorAt = Date.now()
      if (file) this.failedFiles.add(file)
    }).finally(() => { this.pendingWrites-- })
    return request
  }

  private transaction<T>(work: () => T): T {
    const db = this.db!
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* retain the original error */ }
      throw error
    }
  }

  private readSnapshot<T>(work:()=>T):T {
    this.measureSql(() => this.db!.exec('BEGIN'))
    try {const value=work();this.measureSql(() => this.db!.exec('COMMIT'));return value}
    catch(error) {try {this.measureSql(() => this.db!.exec('ROLLBACK'))} catch {} throw error}
  }

  upsertSession(meta: FtsSessionMeta): Promise<void> {
    return this.enqueue(meta.file, () => this.transaction(() => {
      this.upsertNow(meta)
      this.db!.prepare('DELETE FROM fts_checkpoints WHERE file = ?').run(meta.file)
    }))
  }

  private insertNow(file: string, rows: Iterable<FtsMessageRow>, append: boolean): void {
    const db = this.db!
    if (!append) db.prepare('DELETE FROM messages WHERE session_file = ?').run(file)
    const insert = db.prepare('INSERT INTO messages(session_file,role,text,tool_name,anchor_id,event_seq,event_type,source_message_id,call_id,generation,identity_evidence,search_text,search_tool) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    for (const row of rows) {
      if (row.sessionFile !== file) throw new Error('FTS row belongs to another session')
      const text = normalizeReservedMarkers(row.text), tool = normalizeReservedMarkers(row.toolName)
      const result = insert.run(file,row.role,text,tool,row.anchorId ?? null,row.eventSeq ?? null,row.eventType ?? null,
        row.sourceMessageId ?? null,row.callId ?? null,row.generation ?? null,row.identityEvidence ?? null,text.toLowerCase(),tool.toLowerCase()) as { lastInsertRowid: number | bigint }
      this.insertChunks(Number(result.lastInsertRowid),text,tool)
    }
  }

  /** Compatibility entry point. It intentionally leaves no trusted checkpoint. */
  syncMessages(file: string, rows: FtsMessageRow[], append: boolean): Promise<void> {
    return this.syncMessagesIterable(file, () => rows, append)
  }

  syncMessagesIterable(file: string, rows: () => Iterable<FtsMessageRow>, append: boolean): Promise<void> {
    return this.enqueue(file, () => this.transaction(() => {
      this.insertNow(file, rows(), append)
      this.db!.prepare('DELETE FROM fts_checkpoints WHERE file = ?').run(file)
    }))
  }

  getCheckpoint(file: string): FtsCheckpoint | null {
    if (!this.db) return null
    const row = this.db.prepare('SELECT checkpoint_json FROM fts_checkpoints WHERE file = ?').get(file) as { checkpoint_json: string } | undefined
    if (!row) return null
    try { return JSON.parse(row.checkpoint_json) as FtsCheckpoint } catch { return null }
  }

  private checkpointIntact(checkpoint: FtsCheckpoint): boolean {
    const session = this.db!.prepare('SELECT id FROM sessions WHERE file = ?').get(checkpoint.file) as { id: string } | undefined
    const count = this.db!.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_file = ?').get(checkpoint.file) as { n: number }
    return session?.id === checkpoint.sessionId && Number(count.n) === checkpoint.messageCount
  }

  needsSync(meta: SessionMeta): boolean {
    if (!this.db || meta.detailMissing || meta.unindexable) return false
    const checkpoint = this.getCheckpoint(meta.file)
    return !!meta.ftsDirty || !checkpoint || checkpoint.parserVersion !== FTS_PARSER_VERSION ||
      !sameSource(checkpoint, checkpointOf(meta)) || !this.checkpointIntact(checkpoint)
  }

  listSessionFiles(): string[] {
    if (!this.db) return []
    return (this.db.prepare('SELECT file FROM sessions UNION SELECT session_file AS file FROM messages UNION SELECT file FROM fts_checkpoints').all() as { file: string }[]).map(row => row.file)
  }

  syncSession(request: SyncSessionRequest): Promise<SyncReceipt> {
    return this.syncSessionIterable(request, () => request.messages)
  }

  syncSessionIterable(request: Omit<SyncSessionRequest, 'messages'>, rows: () => Iterable<FtsMessageRow>): Promise<SyncReceipt> {
    const { meta, sourceFingerprint: source, parserVersion, mode, expectedBase } = request
    return this.enqueue(meta.file, () => this.transaction(() => {
      if (source.file !== meta.file || source.sessionId !== meta.id) throw new Error('FTS source identity mismatch')
      const current = this.getCheckpoint(meta.file)
      if (current && current.parserVersion === parserVersion && sameSource(current, source) && this.checkpointIntact(current)) {
        // JSON may have failed after FTS COMMIT. Re-delivery never appends twice.
        return { checkpoint: current, duplicate: true }
      }
      if (mode === 'append' && (!current || !expectedBase || current.parserVersion !== parserVersion ||
        expectedBase.parserVersion !== parserVersion || !sameSource(current, expectedBase) ||
        current.messageCount !== expectedBase.messageCount || !this.checkpointIntact(current) ||
        !current.complete || !source.complete || source.indexedBytes <= current.indexedBytes ||
        source.indexedBytes > source.size ||
        (current.indexedSeq !== undefined && (source.indexedSeq ?? -Infinity) < current.indexedSeq))) {
        throw new Error('FTS delta base mismatch; a full parse is required')
      }
      this.upsertNow(meta)
      this.insertNow(meta.file, rows(), mode === 'append')
      const count = this.db!.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_file = ?').get(meta.file) as { n: number }
      const checkpoint: FtsCheckpoint = { ...source, parserVersion, messageCount: Number(count.n) }
      this.db!.prepare('INSERT OR REPLACE INTO fts_checkpoints(file, checkpoint_json) VALUES (?,?)').run(meta.file, JSON.stringify(checkpoint))
      return { checkpoint, duplicate: false }
    }))
  }

  /** Report every earlier failed write up to this call's queue boundary. */
  async flush(): Promise<void> {
    const boundary = this.nextWrite
    const failed = await this.syncChain.then(() => this.failures.filter(failure => failure.id <= boundary))
    this.failures = this.failures.filter(failure => failure.id > boundary)
    if (failed.length) throw new AggregateError(failed.map(failure => failure.error), failed.map(failure => failure.error.message).join('; '))
  }

  removeSession(file: string): Promise<void> {
    return this.enqueue(file, () => this.transaction(() => {
      this.db!.prepare('DELETE FROM messages WHERE session_file = ?').run(file)
      this.db!.prepare('DELETE FROM sessions WHERE file = ?').run(file)
      this.db!.prepare('DELETE FROM fts_checkpoints WHERE file = ?').run(file)
    }))
  }

  sessionCount(): number {
    if (!this.ok || !this.db) return 0
    try {
      const row = this.db!.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
      return Number(row?.n ?? 0)
    } catch {
      return 0
    }
  }

  /**
   * P2.2 观测（只读；不改任何索引逻辑；任何失败返回 0/''，绝不抛错）：
   * messages 行数 / 库文件字节（stat）/ last_optimize 水印 / schema_version /
   * last_prune 水印与数量（P3 保留策略）。
   */
  health(): {
    sessions: number
    messages: number
    dbSizeBytes: number
    lastOptimizeAt: number
    schemaVersion: string
    lastPruneAt: number
    lastPruneCount: number
    lastWriteError: string
    lastWriteErrorAt: number
    pendingWrites: number
    failedSessions: number
    acceptingWrites: boolean
  } {
    return this.timedQuery('health', () => {
    const writes = { lastWriteError: this.lastWriteError, lastWriteErrorAt: this.lastWriteErrorAt,
      pendingWrites: this.pendingWrites, failedSessions: this.failedFiles.size,
      acceptingWrites: !this.closing && !!this.db }
    if (!this.ok || !this.db) {
      return { sessions: 0, messages: 0, dbSizeBytes: 0, lastOptimizeAt: 0, schemaVersion: '', lastPruneAt: 0, lastPruneCount: 0, ...writes }
    }
    try {
      const msg = this.measureSql(() => this.db!.prepare('SELECT COUNT(*) AS n FROM messages').get()) as { n: number }
      const sessions = this.measureSql(() => this.db!.prepare('SELECT COUNT(*) AS n FROM sessions').get()) as { n: number }
      const opt = this.measureSql(() => this.db!
        .prepare("SELECT value FROM state_meta WHERE key = 'last_optimize'")
        .get()) as { value: string | null } | undefined
      const ver = this.measureSql(() => this.db!
        .prepare("SELECT value FROM state_meta WHERE key = 'schema_version'")
        .get()) as { value: string | null } | undefined
      const prn = this.measureSql(() => this.db!
        .prepare("SELECT value FROM state_meta WHERE key = 'last_prune'")
        .get()) as { value: string | null } | undefined
      const prc = this.measureSql(() => this.db!
        .prepare("SELECT value FROM state_meta WHERE key = 'last_prune_count'")
        .get()) as { value: string | null } | undefined
      let size = 0
      try {
        size = statSync(this.dbPath).size
      } catch { /* stat 失败给 0，不抛错 */ }
      const lopt = Number(opt?.value ?? 0)
      const lprn = Number(prn?.value ?? 0)
      const lprc = Number(prc?.value ?? 0)
      return {
        ...writes,
        sessions: Number(sessions.n),
        messages: Number(msg?.n ?? 0),
        dbSizeBytes: size,
        lastOptimizeAt: Number.isFinite(lopt) ? lopt : 0,
        schemaVersion: ver?.value ?? '',
        lastPruneAt: Number.isFinite(lprn) ? lprn : 0,
        lastPruneCount: Number.isFinite(lprc) ? lprc : 0,
      }
    } catch {
      return { sessions: 0, messages: 0, dbSizeBytes: 0, lastOptimizeAt: 0, schemaVersion: '', lastPruneAt: 0, lastPruneCount: 0, ...writes }
    }
    })
  }

  /* ── P3 保留策略 watermark（照 Hermes state_meta 语义：跨进程共享、每日一次）── */

  /** 最近一次保留清理时间（state_meta `last_prune`，缺省 0）。 */
  lastPruneAt(): number {
    if (!this.ok || !this.db) return 0
    try {
      const r = this.db!
        .prepare("SELECT value FROM state_meta WHERE key = 'last_prune'")
        .get() as { value: string | null } | undefined
      const n = Number(r?.value ?? 0)
      return Number.isFinite(n) ? n : 0
    } catch {
      return 0
    }
  }

  /** 最近一次保留清理数量（state_meta `last_prune_count`，缺省 0）。 */
  lastPruneCount(): number {
    if (!this.ok || !this.db) return 0
    try {
      const r = this.db!
        .prepare("SELECT value FROM state_meta WHERE key = 'last_prune_count'")
        .get() as { value: string | null } | undefined
      const n = Number(r?.value ?? 0)
      return Number.isFinite(n) ? n : 0
    } catch {
      return 0
    }
  }

  /** Queue both watermark fields in one transaction; await before observing them. */
  markPruned(count: number): Promise<void> {
    return this.enqueue(undefined, () => this.transaction(() => {
      this.db!.prepare("INSERT OR REPLACE INTO state_meta(key, value) VALUES ('last_prune', ?)").run(String(Date.now()))
      this.db!.prepare("INSERT OR REPLACE INTO state_meta(key, value) VALUES ('last_prune_count', ?)").run(String(count))
    }))
  }

  /* Queries choose original messages, verify text, then apply session budgets. */
  private queryRows(terms: string[], workspace: string, limit: number, mode: 'AND' | 'OR', perSession: boolean, filter?: SearchFilter): Record<string, unknown>[] {
    if (!terms.length) return []
    const useChunks = terms.every(t => Array.from(t).length >= 3 && t.length <= 128)
    const params: unknown[] = []
    let prefix = ''
    let source = 'messages m'
    let rank = 'NULL'
    if (useChunks) {
      const quoted = terms.map(t => '"' + t.toLowerCase().replace(/"/g,'""') + '"').join(' OR ')
      prefix = `WITH chunk_scores AS MATERIALIZED (
        SELECT c.message_id,bm25(chunks_fts) AS score FROM chunks_fts
        JOIN message_chunks c ON c.id=chunks_fts.rowid WHERE chunks_fts MATCH ?
      ), message_scores AS (SELECT message_id,MIN(score) AS rank FROM chunk_scores GROUP BY message_id), `
      params.push(quoted)
      source += ' JOIN message_scores ms ON ms.message_id=m.id'
      rank = 'ms.rank'
    } else prefix = 'WITH '
    // Original-text verification handles terms in different chunks and phrases longer than overlap.
    const clause = terms.map(() => `(m.search_text LIKE ? ESCAPE '\\' OR m.search_tool LIKE ? ESCAPE '\\')`).join(` ${mode} `)
    params.push(...terms.flatMap(t => ['%' + escapeLike(t.toLowerCase()) + '%','%' + escapeLike(t.toLowerCase()) + '%']))
    const constraints = searchConstraints(workspace,filter)
    params.push(...constraints.params)
    // Sort/count only identities and scores. Long original/search bodies must not
    // be copied through GROUP/window/temp sorts for every matching message.
    let sql = prefix + `matched AS (
      SELECT m.id,m.session_file,m.event_seq,s.id AS session_id,${rank} AS rank
      FROM ${source} JOIN sessions s ON s.file=m.session_file WHERE (${clause})${constraints.sql}
    )`
    if (perSession) sql += `, representatives AS (
      SELECT *,COUNT(*) OVER(PARTITION BY session_file) AS match_count,ROW_NUMBER() OVER(PARTITION BY session_file ORDER BY rank,event_seq,id) AS choice FROM matched
    ), page AS (
      SELECT *,COUNT(*) OVER() AS total FROM representatives WHERE choice=1 ORDER BY rank,session_id,session_file,event_seq,id LIMIT ?
    ) SELECT m.*,s.id AS session_id,s.workspace,s.title,s.parent_session,p.rank,p.match_count,p.total
      FROM page p JOIN messages m ON m.id=p.id JOIN sessions s ON s.file=m.session_file
      ORDER BY p.rank,p.session_id,p.session_file,p.event_seq,p.id`
    else sql += `, page AS (
      SELECT * FROM matched ORDER BY rank,session_id,session_file,event_seq,id LIMIT ?
    ) SELECT m.*,s.id AS session_id,s.workspace,s.title,s.parent_session,p.rank
      FROM page p JOIN messages m ON m.id=p.id JOIN sessions s ON s.file=m.session_file
      ORDER BY p.rank,p.session_id,p.session_file,p.event_seq,p.id`
    params.push(Math.max(1,Math.floor(limit)))
    return this.measureSql(() => this.db!.prepare(sql).all(...params)) as Record<string, unknown>[]
  }

  private shapeHit(row: Record<string, unknown>, terms: string[]): FtsHit {
    const text = String(row.text ?? ''), toolName = String(row.tool_name ?? '')
    const term = terms.find(t => text.toLowerCase().includes(t.toLowerCase())) ?? terms.find(t => toolName.toLowerCase().includes(t.toLowerCase())) ?? terms[0]
    return { sessionId: String(row.session_id),sessionFile:String(row.session_file),workspace:String(row.workspace),title:String(row.title),
      role:String(row.role),text,toolName,snippet:excerptAroundMatch(text || toolName,term,48,96),
      matchCount:row.match_count==null ? undefined:Number(row.match_count),
      messageId:Number(row.id),anchorId:row.anchor_id ? String(row.anchor_id) : undefined,
      eventSeq:row.event_seq == null ? undefined : Number(row.event_seq),lineageRoot:String(row.parent_session || row.session_id),
      bm25:row.rank == null ? undefined : Number(row.rank) }
  }

  async search(query: string, workspace: string, limit: number, filter?: SearchFilter): Promise<FtsHit[]> {
    if (!this.ok || !this.db) return []
    await this.syncChain
    return this.timedQuery('search', () => this.readSnapshot(()=>{
    const terms = createQueryPlan(query).tokens
    const and = filter?.queryMode === 'or' ? [] : this.queryRows(terms,workspace,limit,'AND',false,filter)
    return (and.length || filter?.queryMode === 'and' ? and : this.queryRows(terms,workspace,limit,'OR',false,filter)).map(row => this.shapeHit(row,terms))
    }))
  }

  async searchPage(query: string, workspace: string, limit: number, filter?: SearchFilter): Promise<FtsSearchPage> {
    if (!this.ok || !this.db) return { hits:[],total:0,totalExact:false,hasMore:false }
    await this.syncChain
    return this.timedQuery('searchPage', () => this.readSnapshot(()=>{
    const terms = createQueryPlan(query).tokens
    const and = filter?.queryMode === 'or' ? [] : this.queryRows(terms,workspace,limit+1,'AND',true,filter)
    const rows = and.length || filter?.queryMode === 'and' ? and : this.queryRows(terms,workspace,limit+1,'OR',true,filter)
    const total = Number(rows[0]?.total ?? 0)
    return {hits:rows.slice(0,limit).map(row => ({...this.shapeHit(row,terms),text:String(row.text).slice(0,4096),textTruncated:String(row.text).length>4096})),total,totalExact:true,hasMore:total>limit}
    }))
  }

  /** Numeric IDs are read only as rowids. Source seq is never inferred from them. */
  async resolveLegacyAnchor(sessionId: string, rowid: number): Promise<{ anchorId?: string; evidence?: string; reason?: string }> {
    await this.syncChain
    const rows = this.db?.prepare('SELECT m.anchor_id,m.identity_evidence FROM messages m JOIN sessions s ON s.file=m.session_file WHERE s.id=? AND m.id=?').all(sessionId,rowid) as Record<string,unknown>[] | undefined
    if (rows?.length !== 1 || !rows[0].anchor_id) return {reason:'unresolved-no-source-identity'}
    // A current rowid alone cannot prove what a historical bookmark referred to.
    return {anchorId:String(rows[0].anchor_id),evidence:String(rows[0].identity_evidence ?? ''),reason:'requires-bookmark-evidence'}
  }

  async around(sessionId: string, anchor: number | string, window = 5): Promise<{
    ok: boolean; reason?: string; messages: {id:number;anchorId?:string;eventSeq?:number;role:string;text:string;toolName:string}[];
    bookends: {start:{id:number;anchorId?:string;role:string;text:string}[];end:{id:number;anchorId?:string;role:string;text:string}[]}
  }> {
    const empty = {ok:false,reason:'anchor-expired',messages:[],bookends:{start:[],end:[]}}
    if (!this.ok || !this.db) return empty
    await this.syncChain
    return this.timedQuery('around', () => this.readSnapshot(()=>{
    const all = (sql: string, ...args: unknown[]) => this.measureSql(() => this.db!.prepare(sql).all(...args))
    const get = (sql: string, ...args: unknown[]) => this.measureSql(() => this.db!.prepare(sql).get(...args))
    const files = all('SELECT file FROM sessions WHERE id=?',sessionId) as {file:string}[]
    if (files.length !== 1) return {...empty,reason:files.length ? 'ambiguous-session' : 'session-missing'}
    const file=files[0].file
    const column = typeof anchor === 'string' ? 'anchor_id' : 'id'
    const anchors = all(`SELECT id,event_seq FROM messages WHERE session_file=? AND ${column}=?${typeof anchor === 'number' ? ' AND anchor_id IS NULL' : ''}`,file,anchor) as {id:number;event_seq:number|null}[]
    if (anchors.length !== 1) return {...empty,reason:anchors.length ? 'ambiguous-anchor' : 'anchor-expired'}
    const pivot=anchors[0], seq=pivot.event_seq ?? pivot.id, w=Math.max(1,Math.min(20,Math.floor(window)))
    const select='SELECT id,anchor_id,event_seq,role,text,tool_name FROM messages WHERE session_file=?'
    const before=all(select+' AND COALESCE(event_seq,id)<=? AND (COALESCE(event_seq,id)<? OR id<?) ORDER BY COALESCE(event_seq,id) DESC,id DESC LIMIT ?',file,seq,seq,pivot.id,w)
    const center=get(select+' AND id=?',file,pivot.id)!
    const after=all(select+' AND COALESCE(event_seq,id)>=? AND (COALESCE(event_seq,id)>? OR id>?) ORDER BY COALESCE(event_seq,id),id LIMIT ?',file,seq,seq,pivot.id,w)
    const shape=(r:unknown)=>{const row=r as Record<string,unknown>;return {id:Number(row.id),anchorId:row.anchor_id ? String(row.anchor_id):undefined,eventSeq:row.event_seq == null ? undefined:Number(row.event_seq),role:String(row.role),text:String(row.text).slice(0,16384),textTruncated:String(row.text).length>16384,toolName:String(row.tool_name)}}
    const start=all(select+' ORDER BY COALESCE(event_seq,id),id LIMIT 3',file)
    const end=all(select+' ORDER BY COALESCE(event_seq,id) DESC,id DESC LIMIT 3',file)
    return {ok:true,messages:[...before.reverse(),center,...after].map(shape),bookends:{start:start.map(shape),end:end.reverse().map(shape)}}
    }))
  }

  /* ── 维护（照 hermes optimize_fts + vacuum + maybe_auto_prune_and_vacuum）── */

  /** FTS 段合并（hermes: INSERT INTO ...(fts) VALUES('merge', N) 的简化：optimize）。 */
  optimize(): Promise<void> {
    return this.enqueue(undefined, () => this.db!.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')"))
  }

  vacuum(): Promise<void> {
    return this.enqueue(undefined, () => {
      this.db!.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')")
      this.db!.exec('VACUUM')
    })
  }

  maybeMaintenance(): Promise<void> {
    return this.enqueue(undefined, () => {
      const row = this.db!.prepare("SELECT value FROM state_meta WHERE key = 'last_optimize'").get() as { value: string | null } | undefined
      if (Date.now() - Number(row?.value ?? 0) < 24 * 3600 * 1000) return
      this.db!.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')")
      this.db!.prepare("INSERT OR REPLACE INTO state_meta(key, value) VALUES ('last_optimize', ?)").run(String(Date.now()))
    })
  }

  /** Stop admission, drain every accepted write, then close, even on failure. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = (async () => {
      try { await this.flush() }
      finally {
        const db = this.db
        this.db = null
        db?.close()
      }
    })()
    // Existing fire-and-forget disposal is safe, while awaiters still see errors.
    void this.closePromise.catch(() => {})
    return this.closePromise
  }

}

/* ── 工具函数 ─────────────────────────────────────────────────────── */

/** 命中片段标记与 snippet 生成见 core.ts（C11 统一），本文件 re-export。 */

/**
 * P1.3：Hermes `_sanitize_fts5_query` 移植（原样照抄，不改净化语义）：
 * - 未配对引号移除；悬空布尔算子（AND/OR/NOT）去首尾
 * - 连字符词加引号；去掉 ()*^:[] 结构字符，保留布尔词/引号
 * 来源：Hermes session_search_tool.py `_sanitize_fts5_query`（MIT，Copyright
 * (c) 2025 Nous Research）；TS 移植出处 dsh-local-memory/src/session-index/query.ts。
 */
/**
 * P1.4：保留标记归一化。正文/工具名里已有的 >>> <<< 在入库前换成
 * » «（snippet 专用标记不得与正文碰撞，照 DSH 官方 session-query-sqlite
 * README「reserved highlight markers」约束）。幂等：» « 不含 > <。
 */
export function normalizeReservedMarkers(s: string): string {
  return s.replace(/>>>/g, '»').replace(/<<</g, '«')
}

/**
 * 派生搜索词（单一事实源：search() 的 trigram/LIKE 路由 与 queryUsesLikePath 共用）。
 * P1.3 净化后剥词级首尾引号（本管线 trigram/LIKE 会把每个词整体引号化，恢复
 * "引号是无意义包裹"的直觉），只保留净化后的词本身。
 */
/**
 * 判定该原始查询是否必然走 LIKE 兜底慢路径（含 <3 字词，如 1-2 字中文）。
 * 与 search() 同一套净化/分词（单一事实源）；trigram 0 命中再回退 LIKE 的情形
 * 不在判定内（罕见次优，非本提示针对的"短词慢路径"）。空查询返回 false。
 */
export function queryUsesLikePath(query: string): boolean {
  const terms = createQueryPlan(query).tokens
  return terms.length > 0 && !terms.every((t) => Array.from(t).length >= 3)
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c)
}

/* C11：命中标记常量与 snippet 生成统一到 core.ts（两份实现曾各自漂移：
 * 本文件做空白归一化 + "…"，streaming-parser 不归一化 + "..."）。
 * fts.ts re-export 保持对外 API 不变。 */
export { MATCH_OPEN, MATCH_CLOSE, excerptAroundMatch } from './core.js'
