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
import { open } from 'node:fs/promises';
import * as fzstd from 'fzstd';
import { isCancelError, throwIfAborted } from './cancel.js';
import { nativeDecodeZstd } from './native-zstd.js';
import { normalizeReservedMarkers } from './fts.js';
import { excerptAroundMatch } from './core.js';
import { messageIdentity } from './message-anchor.js';
import { createQueryPlan, matchesQuery, queryMatchToken } from './query-plan.js';
import { SessionLogCompatibility, SessionParseError, sessionFailureOf, textFromCompatibleMessage, } from './session-compat.js';
class StopStreaming extends Error {
}
/** Collection budgets are separate from snippet length and decompression limits. */
export const MAX_FTS_ROWS = 50_000;
export const MAX_INDEXED_TEXT_BYTES = 64 * 1024 * 1024;
/**
 * 流式解压 JSONL：逐行回调 onLine。返回 false 提前停止（head/search 早停）。
 * 解码器：默认 native（node:zlib 逐帧解压，~3-4x fzstd）；任何帧失败/不可用
 * 自动回退 fzstd 流式路径（保留拼接多帧支持）。每个 chunk 检查一次
 * signal.aborted（cooperative cancellation）。
 */
export async function streamJsonlLines(file, onLine, options = {}) {
    const { signal, maxDecompressedBytes = 256 * 1024 * 1024, maxLineBytes = 4 * 1024 * 1024, compressedChunkSize = 512 * 1024, decoder: forcedDecoder = 'native', startOffset = 0, } = options;
    throwIfAborted(signal);
    if (!Number.isSafeInteger(startOffset) || startOffset < 0)
        throw Object.assign(new RangeError('invalid compressed startOffset'), { reasonCode: 'invalid_offset', phase: 'compressed_read', retryable: false });
    if (!Number.isSafeInteger(compressedChunkSize) || compressedChunkSize <= 0)
        throw new RangeError('invalid compressedChunkSize');
    if (!Number.isSafeInteger(maxDecompressedBytes) || maxDecompressedBytes < 0)
        throw new RangeError('invalid maxDecompressedBytes');
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0)
        throw new RangeError('invalid maxLineBytes');
    const stats = { lines: 0, bytes: 0, oversized: 0, stopped: false };
    let failedNativeIo = {};
    let decoder = new TextDecoder('utf-8');
    let buffer = '';
    const emit = () => {
        for (;;) {
            const idx = buffer.indexOf('\n');
            if (idx === -1)
                break;
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.length === 0)
                continue;
            // C11：maxLineBytes 是**字节**口径，旧实现比较的是 UTF-16 code unit 数
            // （CJK 行实际字节可达名义值 3 倍）。两级判定：字符数超限必超字节；
            // 否则只在"可能超"时用 Buffer.byteLength 精算（避免每行都算字节）。
            if (line.length > maxLineBytes) {
                stats.oversized++;
                continue;
            }
            if (line.length * 3 > maxLineBytes && Buffer.byteLength(line) > maxLineBytes) {
                stats.oversized++;
                continue;
            }
            stats.lines++;
            if (onLine(line) === false) {
                stats.stopped = true;
                return false;
            }
        }
        return true;
    };
    const feed = (chunk) => {
        throwIfAborted(signal);
        stats.bytes += chunk.length;
        if (stats.bytes > maxDecompressedBytes) {
            throw new Error(`decompressed size exceeds ${maxDecompressedBytes} bytes`);
        }
        buffer += decoder.decode(chunk, { stream: true });
        return emit();
    };
    const flush = () => {
        if (stats.stopped)
            return;
        buffer += decoder.decode();
        if (buffer && !buffer.endsWith('\n'))
            buffer += '\n';
        emit();
    };
    // ── native 路径（node:zlib 逐帧）；仅当尚未向 caller 喂出任何行时才回退 fzstd ──
    if (forcedDecoder !== 'fzstd') {
        try {
            const ns = await nativeDecodeZstd(file, feed, {
                signal,
                maxDecompressedBytes,
                startOffset,
            });
            const io = ns;
            for (const key of ['discoveredBytes', 'readBytes', 'allocatedBytes', 'decodedBytes', 'deltaBytes', 'validationDecodedBytes']) {
                if (io[key] !== undefined)
                    stats[key] = io[key];
            }
            if (ns.stopped || stats.stopped)
                return stats;
            flush();
            return stats;
        }
        catch (e) {
            if (e instanceof Error && Object.isExtensible(e) && Object.getOwnPropertyDescriptor(e, 'stats')?.configurable !== false &&
                (stats.lines > 0 || stats.oversized > 0)) {
                const nativeStats = e.stats;
                Object.defineProperty(e, 'stats', { value: { ...stats, ...nativeStats, lines: stats.lines, oversized: stats.oversized },
                    enumerable: true, configurable: true });
            }
            if (isCancelError(e) || signal?.aborted)
                throw e;
            // An explicitly identified boundary/compatibility/partial-frame rejection will
            // have the same outcome in fzstd; replaying those bytes is unnecessary.
            if (sessionFailureOf(e).reasonCode !== 'unknown')
                throw e;
            if (e instanceof RangeError)
                throw e;
            if (e && typeof e === 'object' && 'raced' in e && e.raced === true)
                throw e;
            if (e instanceof StopStreaming)
                return stats;
            if (stats.stopped)
                return stats;
            // Fix ③（2026-09-10 回归修复）：回退只在"还没向 caller 喂过任何一行"时才安全。
            // parseHead / parseFull / parseSearch 各自 new 一个 SessionLogCompatibility 并
            // 在 onLine 里推进它；native 路径一旦喂出过行（包括 onLine 自己抛错的情况），
            // caller 的状态已被推进，从文件头重放必然撞上 expectedSeq，恒抛
            // "malformed event envelope at seq N"（N = 真实错误位置 +1），把真实原因
            // （未知事件类型 / 消息契约不符）整条掩盖——全量构建的 error 字段因此失去
            // 诊断价值。已喂过行时直接上抛原始错误。
            if (stats.lines > 0)
                throw e;
            if (e && typeof e === 'object' && 'stats' in e && e.stats && typeof e.stats === 'object') {
                failedNativeIo = e.stats;
            }
            // 回退：重置状态，走 fzstd 流式（仅首帧损坏等"零行喂出"场景）
            decoder = new TextDecoder('utf-8');
            buffer = '';
            stats.lines = 0;
            stats.bytes = 0;
            stats.oversized = 0;
            stats.stopped = false;
        }
    }
    // ── fzstd 流式路径（保留对拼接多帧的完整支持）──
    const handle = await open(file, 'r');
    try {
        const before = await handle.stat();
        if (!Number.isSafeInteger(startOffset) || startOffset < 0 || startOffset > before.size) {
            throw Object.assign(new RangeError('invalid compressed startOffset'), { reasonCode: 'invalid_offset', phase: 'compressed_read', retryable: false });
        }
        stats.discoveredBytes = Math.max(before.size, failedNativeIo.discoveredBytes ?? 0);
        stats.readBytes = failedNativeIo.readBytes ?? 0;
        stats.validationDecodedBytes = failedNativeIo.validationDecodedBytes ?? 0;
        stats.allocatedBytes = (failedNativeIo.allocatedBytes ?? 0) + compressedChunkSize;
        const stream = new fzstd.Decompress((chunk) => {
            if (!feed(chunk))
                throw new StopStreaming();
        });
        const readBuf = Buffer.alloc(compressedChunkSize);
        let position = startOffset;
        for (;;) {
            throwIfAborted(signal);
            const { bytesRead } = await handle.read(readBuf, 0, readBuf.length, position);
            if (bytesRead === 0)
                break;
            stats.readBytes += bytesRead;
            stats.allocatedBytes += bytesRead;
            // 关键：fzstd.Decompress 在帧头未凑齐时会内部持有 chunk 引用（this.c.push），
            // 复用 readBuf 会被下一轮 read 覆盖 → 帧头污染 → invalid zstd data。
            // 必须拷贝一份再 push。
            stream.push(new Uint8Array(readBuf.subarray(0, bytesRead)));
            position += bytesRead;
        }
        stream.push(new Uint8Array(0), true);
        flush();
        const after = await handle.stat();
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
            throw Object.assign(new SessionParseError('session log changed during compressed read', 'source_changed', 'compressed_read', true), { raced: true });
        }
        stats.decodedBytes = (failedNativeIo.decodedBytes ?? 0) + stats.bytes;
        stats.deltaBytes = startOffset > 0 ? stats.readBytes : 0;
        return stats;
    }
    catch (e) {
        stats.decodedBytes = (failedNativeIo.decodedBytes ?? 0) + stats.bytes;
        stats.deltaBytes = startOffset > 0 ? stats.readBytes : 0;
        if (e instanceof StopStreaming)
            return stats;
        if (e instanceof Error && Object.isExtensible(e) && !('stats' in e)) {
            Object.defineProperty(e, 'stats', { value: { ...stats }, enumerable: true, configurable: true });
        }
        if (e && typeof e === 'object' && 'code' in e && e.code === fzstd.ZstdErrorCode.UnexpectedEOF) {
            throw Object.assign(new SessionParseError('incomplete zstd stream', 'partial_frame', 'decode', true), { stats: { ...stats } });
        }
        throw e;
    }
    finally {
        await handle.close();
    }
}
// C11：删除无引用的 textOf——消息文本一律走 session-compat 的
// textFromCompatibleMessage（统一口径，避免两份文本提取规则漂移）。
function eventTime(obj) {
    const t = obj.time;
    if (typeof t === 'number')
        return t;
    const t0 = obj.time0;
    return typeof t0 === 'number' ? t0 : 0;
}
function applyHeader(out, compat) {
    const header = compat.header;
    out.id = header.id;
    out.createdAt = header.createdAt;
    out.cwd = header.cwd;
    out.agentPreset = header.agentPreset;
    if (header.parentSession !== undefined)
        out.parentSession = header.parentSession;
    out.sawSessionMeta = true;
}
/**
 * 只流式解压文件头部（对应 list.rs::read_head_summary）：
 * - 基础窗口 maxRecords（默认 10）条非空记录；
 * - 若已见 session meta 但 firstUserText/title 未齐，最多再扫
 *   maxRecords + userEventScanLimit(200) 条（Codex USER_EVENT_SCAN_LIMIT 同款
 *   扩展：title 事件常出现在首条 user 消息之后）。
 * id/createdAt/cwd/agentPreset/title/firstUserText 基本都在头部。
 */
export async function parseHead(file, options = {}) {
    const maxRecords = options.maxRecords ?? 10;
    const userEventScanLimit = 200;
    const out = {
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
    };
    const keepScanning = () => {
        if (out.records < maxRecords)
            return true;
        if (out.sawSessionMeta &&
            (out.firstUserText === '' || out.title === '') &&
            out.records < maxRecords + userEventScanLimit) {
            return true;
        }
        return false;
    };
    const compat = new SessionLogCompatibility();
    await streamJsonlLines(file, (line) => {
        out.records++;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            throw new Error('corrupt session log: JSONL line is not valid JSON');
        }
        const events = compat.consumeLine(parsed);
        applyHeader(out, compat);
        for (const obj of events) {
            const type = obj.type;
            const t = eventTime(obj);
            if (t > out.lastTime)
                out.lastTime = t;
            if (type === 'session/title') {
                const data = obj.data;
                if (typeof data?.title === 'string' && data.title)
                    out.title = data.title;
            }
        }
        return keepScanning();
    }, {
        signal: options.signal,
        compressedChunkSize: options.compressedChunkSize,
        decoder: options.decoder,
        maxDecompressedBytes: options.maxDecompressedBytes,
        maxLineBytes: options.maxLineBytes,
        startOffset: options.startOffset,
    });
    for (const message of compat.finishBySource()) {
        if (message.type !== 'user/message' || out.firstUserText)
            continue;
        const text = textFromCompatibleMessage(message);
        if (text)
            out.firstUserText = text.slice(0, 500);
    }
    out.compatibility = compat.version;
    return out;
}
export async function parseFull(file, options = {}) {
    const lastTextLimit = options.lastTextLimit ?? 2000;
    const collectMessages = options.collectMessages ?? false;
    const out = {
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
    };
    const messages = collectMessages ? [] : undefined;
    const maxMessages = options.maxMessages ?? MAX_FTS_ROWS;
    const maxTextBytes = options.maxIndexedTextBytes ?? MAX_INDEXED_TEXT_BYTES;
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 0 || !Number.isSafeInteger(maxTextBytes) || maxTextBytes < 0) {
        throw new RangeError('message collection budgets must be non-negative safe integers');
    }
    const coverage = {
        complete: true, reasons: [], indexedMessages: 0, indexedTextBytes: 0, maxMessages, maxTextBytes,
    };
    const incomplete = (reason) => {
        coverage.complete = false;
        if (!coverage.reasons.includes(reason))
            coverage.reasons.push(reason);
    };
    const tools = [];
    const pushMessage = (event, role, text, toolName = '') => {
        if (!messages)
            return;
        if (!text && !toolName)
            return;
        if (messages.length >= maxMessages) {
            incomplete('message-limit');
            return;
        }
        const bytes = Buffer.byteLength(text) + Buffer.byteLength(toolName);
        if (bytes > maxTextBytes - coverage.indexedTextBytes) {
            incomplete('text-byte-limit');
            return;
        }
        const row = {
            sessionFile: file,
            role,
            text,
            toolName,
            ...messageIdentity(compat.header.id, compat.generation, event, text, toolName),
        };
        messages.push(row);
        coverage.indexedTextBytes += bytes;
        coverage.indexedMessages++;
    };
    const compat = new SessionLogCompatibility();
    // C9b：增量窗口没有 header 行，先按上一轮结果播种（version/generation/header/
    // expectedSeq）。全量解析不播种，仍走完整 header 校验。
    if (options.resume) {
        compat.resume(options.resume);
        applyHeader(out, compat);
    }
    const stats = await streamJsonlLines(file, (line) => {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            throw new Error('corrupt session log: JSONL line is not valid JSON');
        }
        const events = compat.consumeLine(parsed);
        applyHeader(out, compat);
        for (const obj of events) {
            const type = obj.type;
            out.counts[type] = (out.counts[type] || 0) + 1;
            out.events++;
            const t = eventTime(obj);
            if (t > out.lastTime)
                out.lastTime = t;
            const data = obj.data;
            if (type === 'session/title' && typeof data?.title === 'string' && data.title) {
                out.title = data.title;
            }
            if (type === 'tool/call' && typeof data?.name === 'string' && data.name) {
                out.toolCallCounts[data.name] = (out.toolCallCounts[data.name] || 0) + 1;
                if (messages) {
                    if (tools.length < maxMessages) {
                        tools.push({ seq: obj.seq, type, data: { name: data.name, callId: data.callId ?? data.id } });
                    }
                    else
                        incomplete('message-limit');
                }
            }
        }
        return true;
    }, {
        signal: options.signal,
        compressedChunkSize: options.compressedChunkSize,
        decoder: options.decoder,
        maxDecompressedBytes: options.maxDecompressedBytes,
        maxLineBytes: options.maxLineBytes,
        startOffset: options.startOffset,
    });
    let nextTool = 0;
    for (const message of compat.finishBySource()) {
        while (nextTool < tools.length && tools[nextTool].seq < message.seq) {
            const tool = tools[nextTool++];
            pushMessage(tool, 'tool', '', tool.data.name);
        }
        const text = textFromCompatibleMessage(message);
        if (message.type === 'user/message') {
            if (text && !out.firstUserText)
                out.firstUserText = text.slice(0, 500);
            if (text)
                pushMessage(message, 'user', text);
        }
        else if (message.type === 'assistant/message') {
            if (text)
                out.lastAssistantText = text.slice(0, lastTextLimit);
            if (text)
                pushMessage(message, 'assistant', text);
        }
    }
    while (nextTool < tools.length) {
        const tool = tools[nextTool++];
        pushMessage(tool, 'tool', '', tool.data.name);
    }
    if (stats.oversized > 0)
        incomplete('oversized-jsonl-lines');
    for (const key of ['discoveredBytes', 'readBytes', 'allocatedBytes', 'decodedBytes', 'deltaBytes', 'validationDecodedBytes']) {
        if (stats[key] !== undefined)
            out[key] = stats[key];
    }
    out.compatibility = compat.version;
    out.generation = compat.generation;
    // C9：窗口内出现 surface 替换 → 保守回退全量（判据宽松但代价实测可忽略）。
    if (compat.replaceOps > 0)
        out.hadSurfaceReplace = true;
    out.lastSeq = compat.lastSeq;
    if (messages) {
        out.messages = messages;
        out.coverage = coverage;
    }
    return out;
}
/** Search complete original-message text under one caller-selected global query mode. */
export async function parseSearch(file, query, options = {}) {
    const maxSnippets = options.maxSnippets ?? 3;
    const contextBefore = options.contextBefore ?? 48;
    const contextAfter = options.contextAfter ?? 96;
    if (!Number.isSafeInteger(maxSnippets) || maxSnippets < 0)
        throw new RangeError('invalid maxSnippets');
    const plan = createQueryPlan(query);
    const mode = options.queryMode ?? 'and';
    const role = options.role ?? 'any';
    const hits = [];
    const toolHits = [];
    const compat = new SessionLogCompatibility();
    const searchStats = await streamJsonlLines(file, (line) => {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            throw new Error('corrupt session log: JSONL line is not valid JSON');
        }
        const events = compat.consumeLine(parsed);
        for (const event of events) {
            if (event.type !== 'tool/call' || (role !== 'any' && role !== 'tool'))
                continue;
            const data = event.data;
            if (typeof data?.name !== 'string' || toolHits.length >= maxSnippets || !matchesQuery(data.name, plan, mode))
                continue;
            toolHits.push({
                type: 'tool/call', snippet: '', role: 'tool', toolName: data.name,
                ...messageIdentity(compat.header.id, compat.generation, { seq: event.seq, type: 'tool/call', data }, '', data.name),
            });
        }
        return true;
    }, {
        signal: options.signal,
        compressedChunkSize: options.compressedChunkSize,
        decoder: options.decoder,
        maxDecompressedBytes: options.maxDecompressedBytes,
        maxLineBytes: options.maxLineBytes,
        startOffset: options.startOffset,
    });
    if (searchStats.oversized > 0)
        throw new Error('incomplete original-log search: oversized JSONL lines; increase maxLineBytes to inspect these messages');
    let nextTool = 0;
    for (const message of compat.finishBySource()) {
        while (nextTool < toolHits.length && toolHits[nextTool].eventSeq < message.seq && hits.length < maxSnippets) {
            hits.push(toolHits[nextTool++]);
        }
        if (message.type !== 'user/message' && message.type !== 'assistant/message')
            continue;
        const messageRole = message.type === 'user/message' ? 'user' : 'assistant';
        if (role !== 'any' && role !== messageRole)
            continue;
        if (hits.length >= maxSnippets)
            break;
        const text = textFromCompatibleMessage(message);
        if (!text || !matchesQuery(text, plan, mode))
            continue;
        const normalized = normalizeReservedMarkers(text.split(/\s+/).filter(Boolean).join(' '));
        const token = queryMatchToken(normalized, plan);
        const snippet = excerptAroundMatch(normalized, token, contextBefore, contextAfter);
        hits.push({
            type: message.type, snippet, role: messageRole,
            ...messageIdentity(compat.header.id, compat.generation, message, text),
        });
    }
    while (nextTool < toolHits.length && hits.length < maxSnippets)
        hits.push(toolHits[nextTool++]);
    return hits;
}
// C11：snippet 生成统一到 core.ts excerptAroundMatch（与 FTS 路径同款：
// 空白归一化 + "…" 省略号 + >>> <<< 命中标记），消除两份实现各自漂移。
//# sourceMappingURL=streaming-parser.js.map