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

export interface FtsMessageRow {
  sessionFile: string
  role: 'user' | 'assistant' | 'tool'
  /** user/assistant 文本；role=tool 时为 '' */
  text: string
  toolName: string
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

/** 异步链批量写入的每批行数：~2000 行一次事务 chunk，批间 setImmediate 让出主线程
 * （C11：删掉无引用的 MAX_TEXT / MAX_ROWS_PER_SESSION——真实上限在
 * streaming-parser.ts 的 MAX_FTS_ROWS / MAX_FTS_TEXT，两处常量早已语义漂移） */
const SYNC_CHUNK = 2000

type DatabaseSyncCtor = new (path: string) => FtsDbLike

interface FtsDbLike {
  exec(sql: string): void
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown }
  close(): void
}

/**
 * 异步工厂：动态 import node:sqlite（Node <22.5 时模块不存在 → 静默降级）。
 * 任何一步失败返回 null（绝不抛出，绝不影响主索引构建）。
 */
export async function createSessionFts(dbPath: string): Promise<SessionFts | null> {
  let mod: { DatabaseSync?: DatabaseSyncCtor } | null = null
  try {
    mod = (await import('node:sqlite')) as { DatabaseSync?: DatabaseSyncCtor }
  } catch {
    return null
  }
  if (!mod || typeof mod.DatabaseSync !== 'function') return null
  try {
    const fts = new SessionFts(dbPath, mod.DatabaseSync)
    if (!fts.ok) return null
    return fts
  } catch {
    return null
  }
}

export class SessionFts {
  readonly ok: boolean
  private readonly dbPath: string
  private db: FtsDbLike | null = null
  /** 写串行链：保证全量/追加/删除按序执行，避免并发竞态；fire-and-forget 不阻塞主线程 */
  private syncChain: Promise<void> = Promise.resolve()

  constructor(dbPath: string, DatabaseSync: DatabaseSyncCtor) {
    this.dbPath = dbPath
    try {
      mkdirSync(dirname(dbPath), { recursive: true })
      this.db = new DatabaseSync(dbPath)
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA synchronous = NORMAL')
      this.initSchema()
      this.ok = true
    } catch (e) {
      this.close()
      this.ok = false
      console.warn(`[session-index] FTS disabled: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /* ── schema（照 hermes FTS_CJK 模式：外部内容表 + 触发器）────────────── */

  private initSchema(): void {
    const db = this.db!
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
INSERT OR IGNORE INTO state_meta(key, value) VALUES ('schema_version', '2');
`)
    this.migrateSessionsSchema()
    this.migrateSchemaV2()
  }

  /**
   * C2 schema v1→v2 迁移：v1 含 unicode61 死表 messages_fts（只写不读，全仓无
   * 任何 SELECT；写放大 ~2×、库体积 ~2×）。步骤：DROP 旧触发器/表 → 记 '2' →
   * VACUUM 回收磁盘。幂等：'2' 直接跳过；表已不存在（迁移中断）只补记 '2'。
   * 任何失败保持 v1 不动作降级（FTS 照常可用，下次启动重试），绝不抛错。
   */
  private migrateSchemaV2(): void {
    const db = this.db!
    try {
      const row = db.prepare("SELECT value FROM state_meta WHERE key = 'schema_version'").get() as
        | { value: string | null }
        | undefined
      if (String(row?.value ?? '1') !== '1') return // v2 及以上：无需迁移
      const ftsTables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'messages_fts'",
      ).all() as { name: string }[]
      if (ftsTables.length > 0) {
        // 逐条 DROP：旧库上 DELETE 触发器是双表合并型，先删触发器再删表
        db.exec('DROP TRIGGER IF EXISTS messages_fts_insert')
        db.exec('DROP TRIGGER IF EXISTS messages_fts_delete')
        db.exec('DROP TABLE IF EXISTS messages_fts')
      }
      // 表已删才记 v2：中断在 DROP 中途 → 版本仍 '1'，下次启动重试（幂等）
      db.prepare("INSERT OR REPLACE INTO state_meta(key, value) VALUES ('schema_version', '2')").run()
      db.exec('VACUUM') // 回收 unicode61 影子表占用的磁盘（一次性，数秒级）
    } catch (e) {
      console.warn(`[session-index] FTS schema v1→v2 migration failed (kept v1, will retry): ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 派生库轻量迁移：旧库缺 parent_session 列 → ALTER ADD（不丢数据）。 */
  private migrateSessionsSchema(): void {
    const db = this.db!
    try {
      const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
      if (cols.length && !cols.some((c) => c.name === 'parent_session')) {
        db.exec("ALTER TABLE sessions ADD COLUMN parent_session TEXT NOT NULL DEFAULT ''")
      }
    } catch { /* ignore */ }
  }

  /* ── 会话级 upsert / 消息同步 ─────────────────────────────────────── */

  upsertSession(meta: FtsSessionMeta): void {
    if (!this.ok || !this.db) return
    try {
      this.db!.prepare(
        `INSERT INTO sessions(file, id, workspace, title, agent_preset, created_at, last_time, updated_at, parent_session)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(file) DO UPDATE SET
           id=excluded.id, workspace=excluded.workspace, title=excluded.title,
           agent_preset=excluded.agent_preset, created_at=excluded.created_at,
           last_time=excluded.last_time, updated_at=excluded.updated_at,
           parent_session=excluded.parent_session`,
      ).run(meta.file, meta.id, meta.workspace, meta.title, meta.agentPreset, meta.createdAt, meta.lastTime, Date.now(), meta.parentSession ?? '')
    } catch {
      /* FTS 故障不影响主流程 */
    }
  }

  /**
   * 同步某会话的消息行到 FTS（fire-and-forget：入串行链异步执行，不阻塞主线程）。
   * - append=false（全量解析）：先清空该会话旧行再插入（触发器自动维护 FTS）；
   * - append=true（P1 delta）：新帧消息是该会话消息的后缀，直接追加。
   * 事务批量 + 分块让出事件循环；任何失败静默（FTS 是派生索引，下轮/force 可重建）。
   */
  syncMessages(file: string, rows: FtsMessageRow[], append: boolean): void {
    if (!this.ok || !this.db) return
    const db = this.db
    // P1.4：入库前归一化正文/工具名里的保留标记（>>> <<< 留给 snippet 专用）
    const clean = rows.map((r) => ({
      sessionFile: r.sessionFile,
      role: r.role,
      text: normalizeReservedMarkers(r.text),
      toolName: normalizeReservedMarkers(r.toolName),
    }))
    this.syncChain = this.syncChain.then(async () => {
      try {
        if (!append) {
          db.prepare('DELETE FROM messages WHERE session_file = ?').run(file)
        }
        if (clean.length === 0) return
        const ins = db.prepare(
          'INSERT INTO messages(session_file, role, text, tool_name) VALUES (?,?,?,?)',
        )
        db.exec('BEGIN')
        try {
          for (let i = 0; i < clean.length; i += SYNC_CHUNK) {
            const end = Math.min(i + SYNC_CHUNK, clean.length)
            for (let j = i; j < end; j++) {
              const r = clean[j]
              ins.run(r.sessionFile, r.role, r.text, r.toolName)
            }
            if (end < clean.length) {
              // 批间让出事件循环：主线程不被 FTS 写入长时间阻塞
              await new Promise<void>((r) => setImmediate(r))
            }
          }
          db.exec('COMMIT')
        } catch (e) {
          try {
            db.exec('ROLLBACK')
          } catch { /* ignore */ }
          throw e
        }
      } catch { /* FTS 故障不影响主流程 */ }
    })
  }

  /** 等待所有已入队的 FTS 写入完成（搜索/测试前调用，保证读到最新）。 */
  async flush(): Promise<void> {
    await this.syncChain
  }

  removeSession(file: string): void {
    if (!this.ok || !this.db) return
    const db = this.db
    this.syncChain = this.syncChain.then(() => {
      try {
        db.prepare('DELETE FROM messages WHERE session_file = ?').run(file)
        db.prepare('DELETE FROM sessions WHERE file = ?').run(file)
      } catch { /* ignore */ }
    })
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
    messages: number
    dbSizeBytes: number
    lastOptimizeAt: number
    schemaVersion: string
    lastPruneAt: number
    lastPruneCount: number
  } {
    if (!this.ok || !this.db) {
      return { messages: 0, dbSizeBytes: 0, lastOptimizeAt: 0, schemaVersion: '', lastPruneAt: 0, lastPruneCount: 0 }
    }
    try {
      const msg = this.db!.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
      const opt = this.db!
        .prepare("SELECT value FROM state_meta WHERE key = 'last_optimize'")
        .get() as { value: string | null } | undefined
      const ver = this.db!
        .prepare("SELECT value FROM state_meta WHERE key = 'schema_version'")
        .get() as { value: string | null } | undefined
      const prn = this.db!
        .prepare("SELECT value FROM state_meta WHERE key = 'last_prune'")
        .get() as { value: string | null } | undefined
      const prc = this.db!
        .prepare("SELECT value FROM state_meta WHERE key = 'last_prune_count'")
        .get() as { value: string | null } | undefined
      let size = 0
      try {
        size = statSync(this.dbPath).size
      } catch { /* stat 失败给 0，不抛错 */ }
      const lopt = Number(opt?.value ?? 0)
      const lprn = Number(prn?.value ?? 0)
      const lprc = Number(prc?.value ?? 0)
      return {
        messages: Number(msg?.n ?? 0),
        dbSizeBytes: size,
        lastOptimizeAt: Number.isFinite(lopt) ? lopt : 0,
        schemaVersion: ver?.value ?? '',
        lastPruneAt: Number.isFinite(lprn) ? lprn : 0,
        lastPruneCount: Number.isFinite(lprc) ? lprc : 0,
      }
    } catch {
      return { messages: 0, dbSizeBytes: 0, lastOptimizeAt: 0, schemaVersion: '', lastPruneAt: 0, lastPruneCount: 0 }
    }
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

  /** 写保留清理 watermark（无论本次 prune 数；照 Hermes "尝试即记账" 语义）。
   * 同步执行：水印是记账语义，调用方（status 观测/测试）期望写入即时可见；
   * SQLite 单连接逐语句原子，与在飞写链交错安全。 */
  markPruned(count: number): void {
    if (!this.ok || !this.db) return
    try {
      const now = Date.now()
      this.db!.prepare("INSERT OR REPLACE INTO state_meta(key, value) VALUES ('last_prune', ?)").run(String(now))
      this.db!.prepare("INSERT OR REPLACE INTO state_meta(key, value) VALUES ('last_prune_count', ?)").run(String(count))
    } catch { /* FTS 故障不影响主流程 */ }
  }

  /* ── 搜索 ────────────────────────────────────────────────────────── */

  /** 先等已入队写入完成（保证刚构建的会话可搜），再查 FTS。
   * STAGE-1 Part B：filter 可选——role 走消息级 SQL 条件，sinceMs/untilMs 走
   * 会话级 s.last_time 条件（messages 无时间列，降级口径见 SearchFilter）。 */
  async search(query: string, workspace: string, limit: number, filter?: SearchFilter): Promise<FtsHit[]> {
    if (!this.ok || !this.db || !query) return []
    await this.flush()
    // P1.3：先净化（Hermes _sanitize_fts5_query：去未配对引号/悬空布尔/结构字符，
    // 连字符词加引号）再进路由。本管线的 trigram/LIKE 会把每个词整体引号化，
    // 故把净化结果里词级的首尾引号剥掉（恢复"引号是无意义包裹"的直觉），
    // 只保留净化后的词本身；禁改净化语义本身。词派生为单一事实源
    // （deriveSearchTerms：与 queryUsesLikePath 共用同一净化/分词）。
    const { terms } = deriveSearchTerms(query)
    if (terms.length === 0) return []
    // 全部词 ≥3 字 → trigram（BM25）；否则 LIKE 兜底（1-2 字中文等）
    if (terms.every((t) => t.length >= 3)) {
      const ftsHits = this.searchFts(terms, workspace, limit, filter)
      if (ftsHits.length > 0) return ftsHits
    }
    // C7：LIKE 兜底改逐词（旧实现传整串 termSource，多词必空）
    return this.searchLike(terms, workspace, limit, filter)
  }

  /** trigram FTS5：词间 AND + BM25 排序；AND 零命中自动 OR（各词并列）放宽重试一次。 */
  private searchFts(terms: string[], workspace: string, limit: number, filter?: SearchFilter): FtsHit[] {
    const quote = (t: string) => '"' + t.replace(/"/g, '""') + '"'
    const hits = this.searchFtsMatch(terms.map(quote).join(' AND '), workspace, limit, terms, filter)
    if (hits.length > 0) return hits
    // P1.3：AND 零命中 → OR 重试（各词并列，任何一词命中即算）
    return this.searchFtsMatch(terms.map(quote).join(' OR '), workspace, limit, terms, filter)
  }

  /** trigram FTS5 MATCH 查询体（AND/OR 由调用方拼好）。snippet 在 JS 侧截取。 */
  private searchFtsMatch(matchQ: string, workspace: string, limit: number, terms: string[], filter?: SearchFilter): FtsHit[] {
    let sql = `
      SELECT m.id, m.session_file, m.role, m.text, m.tool_name,
             s.id AS session_id, s.workspace, s.title, s.last_time, s.parent_session,
             bm25(messages_fts_trigram) AS rank
      FROM messages_fts_trigram
      JOIN messages m ON m.id = messages_fts_trigram.rowid
      JOIN sessions s ON s.file = m.session_file
      WHERE messages_fts_trigram MATCH ?`
    const params: unknown[] = [matchQ]
    if (workspace) {
      sql += ` AND s.workspace LIKE ? ESCAPE '\\'`
      params.push('%' + escapeLike(workspace) + '%')
    }
    // STAGE-1 Part B：role 消息级（tool 判定 = tool_name 非空）+ 会话级时间范围
    if (filter?.role && filter.role !== 'any') {
      if (filter.role === 'tool') {
        sql += ` AND m.tool_name != ''`
      } else {
        sql += ` AND m.role = ?`
        params.push(filter.role)
      }
    }
    if (typeof filter?.sinceMs === 'number' && Number.isFinite(filter.sinceMs)) {
      sql += ` AND s.last_time >= ?`
      params.push(filter.sinceMs)
    }
    if (typeof filter?.untilMs === 'number' && Number.isFinite(filter.untilMs)) {
      sql += ` AND s.last_time <= ?`
      params.push(filter.untilMs)
    }
    sql += ` ORDER BY rank LIMIT ?`
    params.push(limit)
    let rows: unknown[]
    try {
      rows = this.db!.prepare(sql).all(...params) as unknown[]
    } catch {
      return []
    }
    return rows.map((r) => {
      const row = r as Record<string, unknown>
      const text = String(row.text ?? '')
      const sessionId = String(row.session_id ?? '')
      const parent = String(row.parent_session ?? '')
      // P1 修复：OR 放宽后，行命中的词未必是最长的那个；逐行挑第一个真正出现在
      // 文本里的词做 snippet 定位（此前用最长词，命中其它词的行 snippet 会退化为
      // 消息开头且无 >>> <<< 标记）。
      const term = terms.find((t) => text.toLowerCase().includes(t.toLowerCase())) ?? terms[0] ?? ''
      return {
        sessionId,
        sessionFile: String(row.session_file),
        workspace: String(row.workspace ?? ''),
        title: String(row.title ?? ''),
        role: String(row.role ?? ''),
        text,
        toolName: String(row.tool_name ?? ''),
        snippet: excerptAroundMatch(text, term, 48, 96),
        messageId: Number(row.id ?? 0),
        lineageRoot: parent || sessionId,
        // STAGE-1 Part A：把 bm25 原值透出（best-rank 会话聚合用；SQL 已选 rank 列）
        bm25: Number(row.rank ?? 0),
      }
    })
  }

  /**
   * LIKE 兜底：逐词子串匹配（大小写不敏感），保证含 1-2 字词的查询不丢语义。
   * C7：旧实现把整条查询（含空格）当单一子串，多词查询几乎必空——例如
   * "FTS 索引" 找不到任何含两词的消息。改为逐词 AND→OR（与 trigram 路径同款
   * 放宽策略：AND 保证精度，零命中再 OR 放宽），语义包含原整串匹配的子集。
   */
  private searchLike(terms: string[], workspace: string, limit: number, filter?: SearchFilter): FtsHit[] {
    const run = (joiner: 'AND' | 'OR'): FtsHit[] => {
      if (terms.length === 0) return []
      const clause = terms
        .map(() => `(m.text LIKE ? ESCAPE '\\' OR m.tool_name LIKE ? ESCAPE '\\')`)
        .join(` ${joiner} `)
      let sql = `
      SELECT m.id, m.session_file, m.role, m.text, m.tool_name,
             s.id AS session_id, s.workspace, s.title, s.last_time, s.parent_session
      FROM messages m JOIN sessions s ON s.file = m.session_file
      WHERE ${clause}`
      const params: unknown[] = terms.flatMap((t) => {
        const p = '%' + escapeLike(t) + '%'
        return [p, p]
      })
    if (workspace) {
      sql += ` AND s.workspace LIKE ? ESCAPE '\\'`
      params.push('%' + escapeLike(workspace) + '%')
    }
    // STAGE-1 Part B：与 searchFtsMatch 同款 filter 条件（role 消息级 + 会话级时间）
    if (filter?.role && filter.role !== 'any') {
      if (filter.role === 'tool') {
        sql += ` AND m.tool_name != ''`
      } else {
        sql += ` AND m.role = ?`
        params.push(filter.role)
      }
    }
    if (typeof filter?.sinceMs === 'number' && Number.isFinite(filter.sinceMs)) {
      sql += ` AND s.last_time >= ?`
      params.push(filter.sinceMs)
    }
    if (typeof filter?.untilMs === 'number' && Number.isFinite(filter.untilMs)) {
      sql += ` AND s.last_time <= ?`
      params.push(filter.untilMs)
    }
    sql += ` ORDER BY m.id DESC LIMIT ?`
    params.push(limit)
    let rows: unknown[]
    try {
      rows = this.db!.prepare(sql).all(...params) as unknown[]
    } catch {
      return []
    }
    return rows.map((r) => {
      const row = r as Record<string, unknown>
      const text = String(row.text ?? '')
      const sessionId = String(row.session_id ?? '')
      const parent = String(row.parent_session ?? '')
      // 与 trigram 路径同款：逐行挑第一个真正出现在文本里的词做 snippet 定位
      const term = terms.find((t) => text.toLowerCase().includes(t.toLowerCase())) ?? terms[0] ?? ''
      return {
        sessionId,
        sessionFile: String(row.session_file),
        workspace: String(row.workspace ?? ''),
        title: String(row.title ?? ''),
        role: String(row.role ?? ''),
        text,
        toolName: String(row.tool_name ?? ''),
        snippet: excerptAroundMatch(text, term, 48, 96),
        messageId: Number(row.id ?? 0),
        lineageRoot: parent || sessionId,
      }
    })
    }
    // AND 保精度；零命中再 OR 放宽（与 searchFts 的 AND→OR 策略一致）
    const andHits = run('AND')
    return andHits.length > 0 ? andHits : run('OR')
  }

  /**
   * P3 SCROLL（照 hermes session_search 的 scroll 形状）：
   * 给定会话 id + 锚点消息 id，返回 ±window 条消息（含锚点）与首/尾 bookends。
   * messages 表 id 单调递增 = 时间序；window 取 1..20。
   */
  async around(
    sessionId: string,
    messageId: number,
    window = 5,
  ): Promise<{
    ok: boolean
    messages: { id: number; role: string; text: string; toolName: string }[]
    bookends: { start: { id: number; role: string; text: string }[]; end: { id: number; role: string; text: string }[] }
  }> {
    const empty = { ok: false, messages: [], bookends: { start: [], end: [] } }
    if (!this.ok || !this.db) return empty
    await this.flush()
    try {
      const srow = this.db!.prepare('SELECT file FROM sessions WHERE id = ?').get(sessionId) as
        | { file: string }
        | undefined
      if (!srow) return empty
      const w = Math.max(1, Math.min(20, Math.floor(window)))
      const rows = this.db!
        .prepare('SELECT id, role, text, tool_name AS toolName FROM messages WHERE session_file = ? AND id BETWEEN ? AND ? ORDER BY id')
        .all(srow.file, messageId - w, messageId + w) as { id: number; role: string; text: string; toolName: string }[]
      if (rows.length === 0) return empty
      const shape = (r: { id: number; role: string; text: string; toolName?: string }) => ({
        id: Number(r.id),
        role: String(r.role),
        text: String(r.text ?? ''),
        toolName: String(r.toolName ?? ''),
      })
      const bookRows = this.db!
        .prepare('SELECT id, role, text FROM messages WHERE session_file = ? ORDER BY id LIMIT ?')
        .all(srow.file, 3) as { id: number; role: string; text: string }[]
      const endRows = this.db!
        .prepare('SELECT id, role, text FROM messages WHERE session_file = ? ORDER BY id DESC LIMIT ?')
        .all(srow.file, 3) as { id: number; role: string; text: string }[]
      return {
        ok: true,
        messages: rows.map(shape),
        bookends: {
          start: bookRows.map((r) => ({ id: Number(r.id), role: String(r.role), text: String(r.text ?? '') })),
          end: endRows.reverse().map((r) => ({ id: Number(r.id), role: String(r.role), text: String(r.text ?? '') })),
        },
      }
    } catch {
      return empty
    }
  }

  /* ── 维护（照 hermes optimize_fts + vacuum + maybe_auto_prune_and_vacuum）── */

  /** FTS 段合并（hermes: INSERT INTO ...(fts) VALUES('merge', N) 的简化：optimize）。 */
  optimize(): void {
    if (!this.ok || !this.db) return
    try {
      // C2：仅 trigram 表（v1 的 unicode61 表由 migrateSchemaV2 移除）
      this.db!.exec(`INSERT INTO messages_fts_trigram(messages_fts_trigram) VALUES('optimize')`)
    } catch { /* ignore */ }
  }

  /** VACUUM（FTS 先 optimize；VACUUM 不能在事务内，WAL 下安全）。 */
  vacuum(): void {
    if (!this.ok || !this.db) return
    this.optimize()
    try {
      this.db!.exec('VACUUM')
    } catch { /* ignore */ }
  }

  /** 每日节流维护：读 state_meta watermark，超过 24h 才 optimize（绝不抛错）。 */
  maybeMaintenance(): void {
    if (!this.ok || !this.db) return
    try {
      const row = this.db!.prepare("SELECT value FROM state_meta WHERE key = 'last_optimize'").get() as
        | { value: string | null }
        | undefined
      const now = Date.now()
      const last = row?.value ? Number(row.value) : 0
      if (Number.isFinite(last) && now - last < 24 * 3600 * 1000) return
      this.optimize()
      this.db!.prepare("INSERT OR REPLACE INTO state_meta(key, value) VALUES ('last_optimize', ?)").run(String(now))
    } catch { /* ignore */ }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close()
      } catch { /* ignore */ }
      this.db = null
    }
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
export function sanitizeFts5Query(raw: string): string {
  let q = (raw || '').trim()
  if ((q.match(/"/g) ?? []).length % 2 !== 0) q = q.replace(/"/g, '')
  q = q.replace(/^(AND|OR|NOT)\s+/i, '').replace(/\s+(AND|OR|NOT)$/i, '')
  q = q.replace(/(^|\s)(\w+-\w+)(?=\s|$)/g, (_, pre: string, term: string) => `${pre}"${term}"`)
  return q.replace(/[()*^:[\]]/g, ' ').trim()
}

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
function deriveSearchTerms(query: string): { terms: string[]; termSource: string } {
  const cleaned = sanitizeFts5Query(query)
  const termSource = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/^"+|"+$/g, ''))
    .join(' ')
  return { terms: termSource.split(/\s+/).filter(Boolean), termSource }
}

/**
 * 判定该原始查询是否必然走 LIKE 兜底慢路径（含 <3 字词，如 1-2 字中文）。
 * 与 search() 同一套净化/分词（单一事实源）；trigram 0 命中再回退 LIKE 的情形
 * 不在判定内（罕见次优，非本提示针对的"短词慢路径"）。空查询返回 false。
 */
export function queryUsesLikePath(query: string): boolean {
  const { terms } = deriveSearchTerms(query)
  return terms.length > 0 && !terms.every((t) => t.length >= 3)
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c)
}

/* C11：命中标记常量与 snippet 生成统一到 core.ts（两份实现曾各自漂移：
 * 本文件做空白归一化 + "…"，streaming-parser 不归一化 + "..."）。
 * fts.ts re-export 保持对外 API 不变。 */
export { MATCH_OPEN, MATCH_CLOSE, excerptAroundMatch } from './core.js'
