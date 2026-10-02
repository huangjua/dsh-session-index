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
 * - 书签是用户数据：只读写 %DSH_HOME%\session-index\bookmarks.jsonl，不能
 *   随派生数据库删除重建；绝不写 index.json / fts.db / 官方库 / 会话文件。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile, open } from 'node:fs/promises';
// C10：与 llm-summary.ts 共享的旁车文件公共层（锁 / 追加 / 原子写 / 指纹缓存 / 校验守卫）
import { withFileLock, canonicalFilePath, atomicWriteText, isRecord, str, num, createFingerprintCache, } from './sidecar.js';
/** 书签 sidecar 文件名（codex SESSION_INDEX_FILE 惯例；与 fts.db 同级） */
export const BOOKMARK_FILE_NAME = 'bookmarks.jsonl';
/** 行结构版本（version 前置供未来迁移；读取只接受 v===1） */
export const BOOKMARK_VERSION = 2;
/** label 缺省截断长度（任务执行细节：meta.title 或 firstUserText 前 80 字符） */
export const DEFAULT_LABEL_MAX = 80;
/** list limit 上限（任务执行细节：默认 20，≤100） */
export const BOOKMARK_LIST_LIMIT_DEFAULT = 20;
export const BOOKMARK_LIST_LIMIT_MAX = 100;
/** 缺省 sidecar 路径：%DSH_HOME%\session-index\bookmarks.jsonl（与 fts.db 同级） */
export function defaultBookmarkFile(dshHome) {
    return join(dshHome, 'session-index', BOOKMARK_FILE_NAME);
}
/**
 * 锚点键：(sessionId, messageId) 归一化。messageId 缺省 = null（会话级书签）。
 * 同锚点重复 add = 替换更新（aider 幂等思想）。
 */
export function anchorKey(sessionId, messageId, anchorId) {
    return `${sessionId}\u0000${anchorId ? `anchor:${anchorId}` : messageId ?? ''}`;
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
export function bookmarkIdFor(sessionId, messageId, anchorId) {
    return createHash('sha1').update(anchorKey(sessionId, messageId, anchorId)).digest('hex');
}
/**
 * label 缺省 = meta.title 或 firstUserText 前 80 字符（确定性，无 LLM）。
 * title 非空用 title；否则用首条用户消息；两者皆空 → ''。
 */
export function defaultLabel(title, firstUserText) {
    return (title || firstUserText || '').slice(0, DEFAULT_LABEL_MAX);
}
/* ── 指纹缓存（C10：改用 sidecar 的通用指纹缓存，解析逻辑注入）───────────── */
const bookmarkCache = createFingerprintCache({ strictErrors: true });
/** 显式失效（add/remove 后调用），防同 ms 同 size 撞车。 */
export function invalidateBookmarkCache(path) {
    bookmarkCache.invalidate(path);
}
/* ── 读取：整读 + 逐行容错 + 同锚点最新行胜出 ─────────────────────────────── */
/** 校验并归一化一行书签；形状不符（含 v!==1，未来迁移前奏）→ null（计坏行）。 */
export function normalizeBookmark(obj) {
    if (!isRecord(obj))
        return null;
    if (obj.v !== 1 && obj.v !== BOOKMARK_VERSION)
        return null;
    if (obj.anchorId !== undefined && (typeof obj.anchorId !== 'string' || !obj.anchorId))
        return null;
    const id = str(obj.id);
    const sessionId = str(obj.sessionId);
    const sessionFile = str(obj.sessionFile);
    const label = str(obj.label);
    const title = str(obj.title);
    const workspace = str(obj.workspace);
    if (!id || !sessionId || !sessionFile || label === null || title === null || workspace === null) {
        return null;
    }
    let messageId;
    if (obj.messageId === null || obj.messageId === undefined)
        messageId = null;
    else {
        messageId = num(obj.messageId);
        if (messageId === null)
            return null;
    }
    let note;
    if (obj.note === null || obj.note === undefined)
        note = null;
    else {
        note = str(obj.note);
        if (note === null)
            return null;
    }
    const createdAt = num(obj.createdAt);
    const updatedAt = num(obj.updatedAt);
    if (createdAt === null || updatedAt === null)
        return null;
    return { ...obj, v: Number(obj.v), id, sessionId, sessionFile, messageId, label, note, title, workspace, createdAt, updatedAt,
        anchorId: typeof obj.anchorId === 'string' ? obj.anchorId : undefined,
        anchorStatus: typeof obj.anchorId === 'string' ? 'resolved' : messageId === null ? 'session' : 'unresolved',
        unresolvedReason: typeof obj.anchorId === 'string' || messageId === null ? undefined : String(obj.unresolvedReason ?? 'legacy-rowid-without-proof') };
}
/**
 * 解析 JSONL 文本：逐行 JSON.parse 容错（坏行跳过并计数，照 codex 容错读）；
 * 同锚点重复行取最新（尾扫描语义：后出现者覆盖先出现者）。
 */
export function parseBookmarkLines(text) {
    const byAnchor = new Map();
    let skippedBad = 0;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line)
            continue; // 空行跳过（codex find_thread_names_by_ids 同款），不计坏行
        let obj;
        try {
            obj = JSON.parse(line);
        }
        catch {
            skippedBad++;
            continue;
        }
        const b = normalizeBookmark(obj);
        if (!b) {
            skippedBad++;
            continue;
        }
        byAnchor.set(anchorKey(b.sessionId, b.messageId, b.anchorId), b); // 后写覆盖先写 → 最新胜出
    }
    return { bookmarks: Array.from(byAnchor.values()), skippedBad };
}
/**
 * 整读 + 容错 + 最新胜出；mtimeMs+size 指纹缓存（照 core.ts loadIndex 模式），
 * 每次工具调用只读一次。仅文件缺失 → 空列表；其它读取错误传播给调用方。
 */
export async function readBookmarks(path) {
    // C10：指纹缓存 + 整读容错全部下沉到 sidecar（与 llm-summary 同一实现）
    return bookmarkCache.read(path, parseBookmarkLines, () => ({ bookmarks: [], skippedBad: 0 }));
}
/** 写入必须在锁内重新读磁盘，不能依赖另一个进程更新前的缓存。 */
async function readForWrite(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        text = '';
    }
    const { bookmarks, skippedBad } = parseBookmarkLines(text);
    if (skippedBad) {
        throw Object.assign(new Error(`Cannot modify bookmarks: ${skippedBad} invalid JSONL line(s) in ${path}`), { code: 'EBOOKMARKCORRUPT', path, skippedBad });
    }
    return { text, bookmarks };
}
/* ── 写入：保留 JSONL 历史，跨进程锁内 fsync + 原子替换 ─────────────────── */
/**
 * 追加一条书签（幂等 upsert）：
 * - 同锚点已存在 → replaced=true；新行继承原 createdAt、刷新 updatedAt/label/note
 *  （aider 替换更新思想）；
 * - 保留已有 JSONL 行，新行与原文件一起 fsync + rename；跨进程互斥覆盖整个写入；
 * - 返回本次写入的最新行。
 */
export async function addBookmark(path, input, now = Date.now()) {
    return withFileLock(path, async (actualPath) => {
        const { text, bookmarks } = await readForWrite(actualPath);
        const key = anchorKey(input.sessionId, input.messageId, input.anchorId);
        const existing = bookmarks.find((b) => anchorKey(b.sessionId, b.messageId, b.anchorId) === key);
        const bookmark = {
            ...existing,
            v: BOOKMARK_VERSION,
            id: existing?.id ?? bookmarkIdFor(input.sessionId, input.messageId, input.anchorId),
            sessionId: input.sessionId,
            sessionFile: input.sessionFile,
            messageId: input.messageId ?? null,
            anchorId: input.anchorId,
            anchorStatus: input.anchorId ? 'resolved' : input.messageId == null ? 'session' : 'unresolved',
            unresolvedReason: input.anchorId || input.messageId == null ? undefined : 'legacy-rowid-without-proof',
            label: input.label,
            note: input.note ?? null,
            title: input.title,
            workspace: input.workspace,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };
        // 同一个锁覆盖读→决策→fsync/rename→失效；有效 EOF 无换行也不会粘连新行。
        await atomicWriteText(actualPath, text + (text && !text.endsWith('\n') ? '\n' : '') + JSON.stringify(bookmark) + '\n');
        invalidateBookmarkCache(actualPath);
        invalidateBookmarkCache(path);
        return { bookmark, replaced: !!existing };
    });
}
/**
 * 删除书签（codex remove_thread_name_entries 语义）。**绝不删除会话文件**。
 * 返回删除行数；无匹配则不动文件返回 0；文件缺失返回 0（codex NotFound → Ok）。
 */
export async function removeBookmarks(path, opts) {
    return withFileLock(path, async (actualPath) => {
        const { bookmarks } = await readForWrite(actualPath);
        const id = opts.id?.trim();
        const sessionId = opts.sessionId?.trim();
        const match = (b) => (id !== undefined && id !== '' && b.id === id) ||
            (sessionId !== undefined && sessionId !== '' && b.sessionId.toLowerCase() === sessionId.toLowerCase());
        const remaining = bookmarks.filter((b) => !match(b));
        const removed = bookmarks.length - remaining.length;
        if (removed === 0)
            return 0;
        const text = remaining.map((b) => JSON.stringify(b)).join('\n') + (remaining.length ? '\n' : '');
        await atomicWriteText(actualPath, text);
        invalidateBookmarkCache(actualPath);
        invalidateBookmarkCache(path);
        return removed;
    });
}
/* ── list 过滤与排序（纯函数；调用方只喂已读回的书签，不调 LLM/bm25）─────── */
/** list 过滤：对 label/note/title 大小写不敏感子串匹配（复用 metaMatch 归一化语义） */
export function bookmarkMatches(b, query) {
    const q = (query ?? '').toLowerCase().trim();
    if (!q)
        return true;
    return (b.label.toLowerCase().includes(q) ||
        (b.note ?? '').toLowerCase().includes(q) ||
        b.title.toLowerCase().includes(q));
}
/**
 * list 排序：updatedAt 倒序 → id 升序 → 原顺序（文件序）收口。
 * 等分决序沿用 rank.ts 的确定性 tiebreak 语义（fzf：score→…→index；本域无
 * fzy 分，取最后一道确定性收口 = 原始下标，与 sortSessions 的 index 收口同构）。
 * 同输入必同输出。
 */
export function sortBookmarks(bookmarks) {
    return bookmarks
        .map((b, idx) => ({ b, idx }))
        .sort((A, B) => {
        if (A.b.updatedAt !== B.b.updatedAt)
            return B.b.updatedAt - A.b.updatedAt;
        if (A.b.id !== B.b.id)
            return A.b.id < B.b.id ? -1 : 1;
        return A.idx - B.idx;
    })
        .map((x) => x.b);
}
/** Explicit dry run / migration. Search and list never write migrated data. */
export async function migrateBookmarks(path, resolver, options = {}) {
    const run = async (actualPath) => {
        let original = '';
        try {
            original = await readFile(actualPath, 'utf8');
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        const lines = original.split('\n');
        const counts = { resolved: 0, unresolved: 0, ambiguous: 0, 'session-missing': 0, 'anchor-replaced': 0, session: 0, alreadyMigrated: 0 };
        const entries = [];
        let changed = false;
        for (let index = 0; index < lines.length; index++) {
            if (!lines[index].trim())
                continue;
            let obj;
            try {
                obj = JSON.parse(lines[index]);
            }
            catch {
                throw new Error(`EBOOKMARKCORRUPT: line ${index + 1}`);
            }
            const bookmark = normalizeBookmark(obj);
            if (!bookmark)
                throw new Error(`EBOOKMARKCORRUPT: line ${index + 1}`);
            if (bookmark.v === 2) {
                counts.alreadyMigrated++;
                continue;
            }
            let status, reason, anchorId;
            if (bookmark.messageId === null)
                status = 'session';
            else {
                const result = await resolver(bookmark);
                status = result.status;
                if (status === 'resolved') {
                    // Historical rowid/array position alone is never migration evidence.
                    if (!result.anchorId || !result.evidence || bookmark.legacyEvidence?.identityEvidence !== result.evidence ||
                        bookmark.legacyEvidence.anchorId !== result.anchorId) {
                        status = 'unresolved';
                        reason = 'legacy-rowid-without-proof';
                    }
                    else
                        anchorId = result.anchorId;
                }
                else
                    reason = status;
            }
            counts[status]++;
            entries.push({ line: index + 1, id: bookmark.id, sessionId: bookmark.sessionId, status, reason });
            // Preserve every physical record, including duplicates, original numeric identity and custom fields.
            lines[index] = JSON.stringify({ ...obj, v: 2, anchorId, anchorStatus: status === 'session' ? 'session' : anchorId ? 'resolved' : 'unresolved', unresolvedReason: reason });
            changed = true;
        }
        const report = { version: 2, dryRun: options.dryRun !== false, records: Object.values(counts).reduce((a, b) => a + b, 0), counts, entries,
            sourceHash: createHash('sha256').update(original).digest('hex') };
        if (!report.dryRun && changed) {
            if (!options.backupPath)
                throw new Error('Explicit backupPath required before migration');
            if (await canonicalFilePath(options.backupPath) === await canonicalFilePath(actualPath))
                throw new Error('Backup must be a separate file');
            try {
                const backup = await open(options.backupPath, 'wx');
                try {
                    await backup.writeFile(original, 'utf8');
                    await backup.sync();
                }
                finally {
                    await backup.close();
                }
            }
            catch (error) {
                if (error.code !== 'EEXIST' || await readFile(options.backupPath, 'utf8') !== original)
                    throw error;
            }
            await atomicWriteText(actualPath, lines.join('\n'));
            invalidateBookmarkCache(actualPath);
            invalidateBookmarkCache(path);
        }
        return report;
    };
    return options.dryRun === false ? withFileLock(path, run) : run(path);
}
//# sourceMappingURL=bookmark.js.map