/**
 * core.ts — DSH session index engine
 *
 * 读取 `~/.dsh/sessions` 下的 `session.jsonl.zstd`：
 *  - fzstd 纯 JS 解压 Zstandard
 *  - 解析首行 session 元信息 + 后续事件流
 *  - 维护轻量索引（不存正文，只存元数据/摘要字段）
 *  - 提供元数据搜索与按需全文搜索
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, statSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, basename, dirname, isAbsolute, resolve } from 'node:path';
import * as fzstd from 'fzstd';
import { throwIfAborted } from './cancel.js';
import { SessionLogCompatibility, textFromCompatibleMessage } from './session-compat.js';
/* ── 命中片段标记与生成（C11：fts 与 streaming-parser 两份实现统一到此处）────
 * 常量与实现下沉到 core，避免 fts ↔ core 的循环依赖（fts 负责 SQLite，
 * 不负责纯文本片段规则）。fts.ts 仍 re-export，外部引用不变。
 */
/** 命中区间标记（Hermes MATCH_OPEN/CLOSE，dsh-local-memory 同款 >>> <<<） */
export const MATCH_OPEN = '>>>';
export const MATCH_CLOSE = '<<<';
/**
 * 对应 search.rs::excerpt_around_match：归一化空白后取 charsBefore/charsAfter
 * 字符上下文，并用 >>> <<< 包住命中区间（P1.4）。
 */
export function excerptAroundMatch(text, query, charsBefore, charsAfter) {
    const normalized = text.split(/\s+/).filter(Boolean).join(' ');
    const idx = normalized.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1)
        return normalized.slice(0, charsBefore + charsAfter + 40);
    const start = Math.max(0, idx - charsBefore);
    const end = Math.min(normalized.length, idx + query.length + charsAfter);
    let snippet = '';
    if (start > 0)
        snippet += '… ';
    snippet += normalized.slice(start, idx);
    snippet += MATCH_OPEN + normalized.slice(idx, idx + query.length) + MATCH_CLOSE;
    snippet += normalized.slice(idx + query.length, end);
    if (end < normalized.length)
        snippet += ' …';
    return snippet.slice(0, 400);
}
export function isRetainedSession(file, previous, cutoff) {
    const activity = Math.max(previous?.lastTime ?? 0, file.mtimeMs);
    return !(cutoff > 0 && activity > 0 && activity < cutoff);
}
/* ── 旧同步实现（@legacy：整读整解压，仅测试/等值对比使用）─────────────────
 * C11：生产路径一律走 streaming-parser（流式）+ SessionIndexBuilder（worker 池）。
 * 以下 5 个导出（decompressZstd / parseSession / findSessionFiles /
 * buildIndexSync / searchSessionFile）被 core.test.ts 与 streaming-parser.test.ts
 * 用作"旧实现等值校验"的参照实现，**生产代码不调用**。保留勿误删；
 * 后续可整体迁入 test/support/legacy-core.ts（PLAN_v5 记录）。
 */
/** @legacy 整读整解压（仅测试对比用） */
export function decompressZstd(file) {
    const compressed = readFileSync(file);
    const buf = fzstd.decompress(new Uint8Array(compressed));
    return Buffer.from(buf).toString('utf8');
}
export function parseSession(text) {
    const compat = new SessionLogCompatibility();
    let title = '';
    let lastTime = 0;
    const counts = {};
    const toolCalls = [];
    for (const line of text.split('\n')) {
        if (!line)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            throw new Error('corrupt session log: JSONL line is not valid JSON');
        }
        for (const event of compat.consumeLine(parsed)) {
            const type = event.type;
            counts[type] = (counts[type] || 0) + 1;
            if (typeof event.time === 'number' && event.time > lastTime)
                lastTime = event.time;
            const data = event.data;
            if (type === 'session/title' && typeof data?.title === 'string' && data.title)
                title = data.title;
            if (type === 'tool/call' && typeof data?.name === 'string' && data.name) {
                toolCalls.push({ name: data.name, arguments: typeof data.arguments === 'string' ? data.arguments : '' });
            }
        }
    }
    let firstUserText = '';
    let lastAssistantText = '';
    for (const message of compat.finish()) {
        const messageText = textFromCompatibleMessage(message);
        if (message.type === 'user/message' && messageText && !firstUserText)
            firstUserText = messageText.slice(0, 500);
        if (message.type === 'assistant/message' && messageText)
            lastAssistantText = messageText.slice(0, 2000);
    }
    const header = compat.header;
    return {
        id: header.id, createdAt: header.createdAt, cwd: header.cwd, agentPreset: header.agentPreset,
        title, firstUserText, lastAssistantText, lastTime, counts, toolCalls,
    };
}
export function findSessionFiles(root) {
    const out = [];
    const walk = (dir) => {
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of names) {
            const full = join(dir, name);
            let st;
            try {
                st = statSync(full);
            }
            catch {
                continue;
            }
            if (st.isDirectory()) {
                walk(full);
            }
            else if (st.isFile() && name.endsWith('.jsonl.zstd')) {
                out.push(full);
            }
        }
    };
    walk(root);
    return out.sort();
}
/**
 * 规范代际日志名：v0 = `session.jsonl.zstd`，vN = `session.vN.jsonl.zstd`（N ≥ 1，
 * 无前导零）。与 @deepseek-ai/dsh-session-format 的 `sessionFormatLogFilename`
 * 一致：小写 `v`、无前导零、`.v0` 与临时/大写名都不算规范代际。
 */
const GENERATION_LOG_RE = /^session(?:\.v([1-9]\d*))?\.jsonl\.zstd$/;
function generationOf(name) {
    const match = GENERATION_LOG_RE.exec(name);
    if (!match)
        return undefined;
    return match[1] === undefined ? 0 : Number(match[1]);
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
export async function scanSessionFiles(root, options = {}) {
    const cap = Math.max(0, options.cap ?? 10000);
    const signal = options.signal;
    const io = options.io ?? { readdir, stat };
    const files = [];
    const errors = [];
    const failedSubtrees = [];
    let truncated = false;
    let visited = 0;
    const failed = (path, error) => {
        errors.push(`${path}: ${String(error).slice(0, 200)}`);
        failedSubtrees.push(path);
    };
    const walk = async (dir) => {
        if (truncated)
            return;
        throwIfAborted(signal);
        let entries;
        try {
            entries = await io.readdir(dir, { withFileTypes: true });
        }
        catch (error) {
            failed(dir, error);
            return;
        }
        // Resolve generations before applying the budget or stat: an unavailable
        // highest generation must never silently turn into its older sibling.
        let highest;
        let highestVersion = -1;
        for (const entry of entries) {
            const version = entry.isFile() ? generationOf(entry.name) : undefined;
            if (version !== undefined && version > highestVersion) {
                highest = entry.name;
                highestVersion = version;
            }
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (truncated)
                return;
            visited++;
            if (visited % 20 === 0) {
                throwIfAborted(signal);
                await new Promise((r) => setImmediate(r));
            }
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.jsonl.zstd'))
                continue;
            if (generationOf(entry.name) !== undefined && entry.name !== highest)
                continue;
            if (files.length >= cap) {
                truncated = true;
                return;
            }
            let st;
            try {
                st = await io.stat(full);
            }
            catch (error) {
                failed(full, error);
                continue;
            }
            if (!st.isFile()) {
                failed(full, new Error('session file changed type during scan'));
                continue;
            }
            files.push({ file: full, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
        }
    };
    await walk(root);
    files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return { files, complete: !truncated && errors.length === 0, truncated, errors, failedSubtrees };
}
const indexCache = new Map();
/** 显式失效（builder commit / saveIndex 后调用），防同 ms 同 size 撞车。 */
export function invalidateIndexCache(indexFile) {
    indexCache.delete(indexFile);
}
export function loadIndex(indexFile) {
    try {
        if (!existsSync(indexFile)) {
            indexCache.delete(indexFile);
            return null;
        }
        const st = statSync(indexFile);
        const cached = indexCache.get(indexFile);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
            return cached.index;
        }
        const raw = readFileSync(indexFile, 'utf8');
        const obj = JSON.parse(raw);
        if (obj && obj.version === 1 && Array.isArray(obj.sessions)) {
            const index = obj;
            indexCache.set(indexFile, { mtimeMs: st.mtimeMs, size: st.size, index });
            return index;
        }
        indexCache.delete(indexFile);
        return null;
    }
    catch {
        return null;
    }
}
/** 同步写索引（legacy 同步路径/测试用；生产路径走 builder 的 atomicWriteJson）。
 *  C10：补齐 fsync + 唯一 tmp 名——旧实现无 fsync、固定 tmp 名，跨进程并发时
 *  可能互相踩踏，且崩溃时可能留下未落盘的 tmp。 */
let saveIndexSeq = 0;
export function saveIndex(indexFile, index) {
    mkdirSync(dirname(indexFile), { recursive: true });
    const tmp = `${indexFile}.tmp.${process.pid}.${saveIndexSeq++}`;
    const fd = openSync(tmp, 'wx');
    try {
        writeFileSync(fd, JSON.stringify(index), 'utf8');
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    renameSync(tmp, indexFile);
    invalidateIndexCache(indexFile);
}
/**
 * 旧版同步全量构建（保留纯函数导出，供测试/对比）。
 * 生产路径请用 async buildIndex（SessionIndexBuilder：两阶段 + worker 池 + 原子提交）。
 */
export function buildIndexSync(root, indexFile, force = false) {
    const files = findSessionFiles(root);
    const old = loadIndex(indexFile);
    const byFile = new Map();
    if (old)
        for (const s of old.sessions)
            byFile.set(s.file, s);
    let added = 0;
    let updated = 0;
    let skipped = 0;
    let scannedBytes = 0;
    const errors = [];
    for (const file of files) {
        try {
            const st = statSync(file);
            const prev = byFile.get(file);
            if (!force && prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
                skipped++;
                continue;
            }
            const text = decompressZstd(file);
            scannedBytes += st.size;
            const parsed = parseSession(text);
            const workspace = parsed.cwd || dirname(file);
            const counts = parsed.counts;
            const toolCallCounts = {};
            for (const c of parsed.toolCalls) {
                if (c.name)
                    toolCallCounts[c.name] = (toolCallCounts[c.name] || 0) + 1;
            }
            const meta = {
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
            };
            byFile.set(file, meta);
            if (prev)
                updated++;
            else
                added++;
        }
        catch (e) {
            errors.push(`${file}: ${String(e).slice(0, 160)}`);
        }
    }
    // 排序 tie-break 统一为 id（与 cursor 跳过逻辑一致：lastTime desc, id asc）
    const sessions = Array.from(byFile.values()).sort((a, b) => b.lastTime - a.lastTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const index = {
        version: 1,
        root,
        updatedAt: Date.now(),
        sessions,
    };
    saveIndex(indexFile, index);
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
    };
}
/**
 * async 门面：非阻塞两阶段构建（head pass → quick index 检查点 → full pass → 原子提交）。
 * 进程内 single-flight：并发调用复用同一构建。
 */
export async function buildIndex(root, indexFile, force = false, signal) {
    // 动态 import 避免 core ↔ builder 静态循环依赖
    const { getBuilder } = await import('./session-index-builder.js');
    return getBuilder(root, indexFile).build({ force, signal });
}
const lowerCache = new WeakMap();
function loweredOf(meta) {
    let l = lowerCache.get(meta);
    if (!l) {
        l = {
            id: meta.id.toLowerCase(),
            workspace: meta.workspace.toLowerCase(),
            title: meta.title.toLowerCase(),
            firstUserText: meta.firstUserText.toLowerCase(),
            lastAssistantText: meta.lastAssistantText.toLowerCase(),
            toolNames: meta.toolNames.map((n) => n.toLowerCase()),
        };
        lowerCache.set(meta, l);
    }
    return l;
}
export function metaMatch(meta, query) {
    const q = query.toLowerCase();
    const l = loweredOf(meta);
    return (l.id.includes(q) ||
        l.workspace.includes(q) ||
        l.title.includes(q) ||
        l.firstUserText.includes(q) ||
        l.lastAssistantText.includes(q) ||
        l.toolNames.some((n) => n.includes(q)));
}
export function searchSessionFile(file, query, maxSnippets) {
    const hits = [];
    try {
        const text = decompressZstd(file);
        const compat = new SessionLogCompatibility();
        const toolCalls = [];
        for (const line of text.split('\n')) {
            if (!line)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                throw new Error('corrupt session log: JSONL line is not valid JSON');
            }
            for (const event of compat.consumeLine(parsed)) {
                const data = event.data;
                if (event.type === 'tool/call' && typeof data?.name === 'string')
                    toolCalls.push({ seq: event.seq, name: data.name });
            }
        }
        const q = query.toLowerCase();
        const candidates = toolCalls.map(call => ({ seq: call.seq, type: 'tool/call', text: call.name }));
        for (const message of compat.finish()) {
            if (message.type === 'tool/result')
                continue;
            candidates.push({ seq: message.seq, type: message.type, text: textFromCompatibleMessage(message) });
        }
        for (const candidate of candidates.sort((a, b) => a.seq - b.seq)) {
            if (hits.length >= maxSnippets)
                break;
            const index = candidate.text.toLowerCase().indexOf(q);
            if (index < 0)
                continue;
            const start = Math.max(0, index - 120);
            const end = Math.min(candidate.text.length, index + query.length + 180);
            const snippet = (start > 0 ? '…' : '') + candidate.text.slice(start, end) + (end < candidate.text.length ? '…' : '');
            hits.push({ sessionId: '', workspace: '', file, kind: 'content', type: candidate.type, snippet: snippet.slice(0, 500) });
        }
    }
    catch {
        /* 单个文件失败忽略 */
    }
    return hits;
}
export function findSession(index, idOrFile) {
    const q = idOrFile.toLowerCase();
    return index.sessions.find((s) => !s.unindexable && (s.id.toLowerCase() === q || s.file.toLowerCase() === q || s.file.toLowerCase().includes(q)));
}
export function summarizeSession(meta) {
    const toolCalls = meta.toolNames.map((name) => ({ name, count: meta.toolCallCounts[name] || 0 }));
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
    };
}
export function resolveRoot(input) {
    if (input)
        return isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input);
    return join(process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'), 'sessions');
}
/** cursor 格式：`ts|id` 或 `ts`。解析失败返回 null。 */
export function parseCursor(token) {
    const sep = token.lastIndexOf('|');
    const tsPart = sep === -1 ? token : token.slice(0, sep);
    const idPart = sep === -1 ? '' : token.slice(sep + 1);
    const ts = Number(tsPart);
    if (!Number.isFinite(ts))
        return null;
    return { ts, id: idPart };
}
export function formatCursor(meta) {
    return `${meta.lastTime}|${meta.id}`;
}
/**
 * AnchorState（Codex list.rs）：sessions 必须已按 (lastTime desc, id asc) 排序。
 * 返回跳过 anchor 及其之前已返回区间后的起始下标（新增/变更会话不会错位）。
 * P0-3：排序键已知 → 二分查找，O(n) → O(log n)。
 */
export function cursorStartIndex(sessions, cursor) {
    if (!cursor)
        return 0;
    // 第一个满足 (lastTime < ts) || (lastTime === ts && id > cursor.id) 的下标
    let lo = 0;
    let hi = sessions.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const s = sessions[mid];
        if (s.lastTime < cursor.ts || (s.lastTime === cursor.ts && s.id > cursor.id))
            hi = mid;
        else
            lo = mid + 1;
    }
    return lo;
}
//# sourceMappingURL=core.js.map