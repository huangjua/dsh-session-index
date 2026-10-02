/**
 * worker-pool.ts — 有界 worker 池 + mapLimit
 *
 * 对应 Codex compression.rs 的 JoinSet 有界调度：
 *   while jobs.len() >= MAX_CONCURRENT { join_next() }
 * 池大小 Math.min(4, Math.max(1, availableParallelism - 1))；
 * 单 worker 同时只处理 1 个文件 → 内存有界；
 * 单文件失败 → 结果 { ok:false, error }，池内换新 worker 继续，构建不中断；
 * worker 不可用（构造失败/环境限制）→ inline 回退（同一解析函数，cooperative）。
 */
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { CancelError, isCancelError } from './cancel.js';
import { parseHead, parseFull, parseSearch } from './streaming-parser.js';
import { SessionParseError, sessionFailureOf } from './session-compat.js';
export class WorkerPool {
    size;
    workerUrl;
    timeoutMs;
    slots = [];
    queue = [];
    seq = 0;
    inlineMode = false;
    terminated = false;
    /** inline 回退模式下的并发上限（主线程同步 CPU 活，必须限流） */
    inlineMax;
    inlineActive = 0;
    constructor(options = {}) {
        const avail = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
        this.size = options.size ?? Math.min(4, Math.max(1, avail - 1));
        this.workerUrl = options.workerUrl ?? null;
        this.timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
        this.inlineMax = Math.min(2, Math.max(1, this.size));
        if (!this.workerUrl)
            this.inlineMode = true;
    }
    /**
     * 提交一个任务。返回 TaskResult：
     * - 取消（caller signal / 池终止）→ reject CancelError；
     * - 单文件失败 → resolve { ok:false, error }（错误隔离，不 reject）。
     */
    run(spec, signal) {
        return new Promise((resolve, reject) => {
            if (this.terminated) {
                reject(new CancelError('pool terminated'));
                return;
            }
            if (signal?.aborted) {
                reject(new CancelError());
                return;
            }
            const controller = new AbortController();
            // C5：调用方 signal 的 abort 监听必须在任务 settle 时自摘——once:true 只在
            // 触发时移除，正常完成的构建（signal 从不 abort）会按文件数累积监听器
            // （>10 触发 MaxListeners 告警）。挂到 wrapped resolve/reject 出口全覆盖。
            const onCallerAbort = () => controller.abort();
            const removeCallerAbort = () => {
                signal?.removeEventListener('abort', onCallerAbort);
            };
            const pending = {
                id: this.seq++,
                spec,
                resolve: (r) => {
                    removeCallerAbort();
                    resolve(r);
                },
                reject: (e) => {
                    removeCallerAbort();
                    reject(e);
                },
                controller,
                dispatched: false,
            };
            if (signal) {
                signal.addEventListener('abort', onCallerAbort);
            }
            controller.signal.addEventListener('abort', () => {
                if (!pending.dispatched) {
                    const i = this.queue.indexOf(pending);
                    if (i !== -1)
                        this.queue.splice(i, 1);
                    pending.reject(new CancelError());
                }
            }, { once: true });
            this.queue.push(pending);
            this.pump();
        });
    }
    /** 终止池：取消排队任务、reject 在飞任务、杀死 worker。插件卸载时调用。 */
    terminate() {
        this.terminated = true;
        for (const slot of this.slots) {
            slot.dead = true;
            const pending = slot.pending;
            slot.pending = null;
            if (pending) {
                if (pending.timeout)
                    clearTimeout(pending.timeout);
                pending.reject(new CancelError('pool terminated'));
            }
            slot.worker.terminate().catch(() => { });
        }
        this.slots.length = 0;
        for (const pending of this.queue) {
            pending.reject(new CancelError('pool terminated'));
        }
        this.queue.length = 0;
        if (this.inlineActive > 0) {
            // inline 任务各自收尾时会 reject 自己的 pending（信号已随 terminate 不触发，
            // 靠任务自身 catch 收场）；这里只重置计数
            this.inlineActive = 0;
        }
    }
    get sizeLimit() {
        return this.size;
    }
    /** inline 回退模式下当前在飞任务数（测试/观测用） */
    get inlineInFlight() {
        return this.inlineActive;
    }
    /* ── 调度 ─────────────────────────────────────────────── */
    pump() {
        void this.pumpAsync();
    }
    async pumpAsync() {
        if (this.terminated)
            return;
        while (this.queue.length > 0) {
            if (this.inlineMode) {
                // inline 回退：fzstd 解压是主线程同步 CPU 活，必须限并发 + 每任务让出事件循环，
                // 否则队列里所有任务被同时派发会直接卡死主线程（违反“主线程绝不长时间阻塞”）
                if (this.inlineActive >= this.inlineMax)
                    return;
                const pending = this.queue.shift();
                this.inlineActive++;
                this.dispatchInline(pending);
                continue;
            }
            const slot = this.nextSlot();
            if (!slot) {
                // worker 全忙（或首次 spawn 失败已切 inline）→ 等完成事件再 pump
                if (this.inlineMode)
                    continue;
                return;
            }
            const pending = this.queue.shift();
            this.dispatch(slot, pending);
            // worker spawn 是主线程重活：每次 spawn 后让出事件循环，避免突发阻塞
            if (slot.spawned)
                await new Promise((r) => setImmediate(r));
        }
    }
    nextSlot() {
        for (const s of this.slots) {
            if (!s.dead && s.pending === null) {
                s.spawned = false;
                return s;
            }
        }
        if (this.slots.length < this.size) {
            const slot = this.spawnSlot();
            if (slot)
                return slot;
        }
        return null;
    }
    spawnSlot() {
        const url = this.workerUrl;
        if (!url || this.inlineMode) {
            this.inlineMode = true;
            return null;
        }
        let worker;
        try {
            worker = new Worker(url);
        }
        catch {
            // 环境限制（无 worker 支持等）→ inline 回退
            this.inlineMode = true;
            return null;
        }
        const slot = { worker, pending: null, dead: false, spawned: true };
        worker.on('message', (msg) => this.onMessage(slot, msg));
        worker.on('error', (err) => this.onWorkerError(slot, err));
        worker.on('exit', (code) => {
            if (!slot.dead)
                this.onWorkerError(slot, new Error(`worker exited with code ${code}`));
        });
        this.slots.push(slot);
        return slot;
    }
    dispatch(slot, pending) {
        slot.pending = pending;
        pending.dispatched = true;
        try {
            slot.worker.postMessage({
                type: 'task',
                taskId: pending.id,
                mode: pending.spec.mode,
                file: pending.spec.file,
                query: pending.spec.query,
                maxSnippets: pending.spec.maxSnippets,
                role: pending.spec.role,
                queryMode: pending.spec.queryMode,
                maxDecompressedBytes: pending.spec.maxDecompressedBytes,
                maxLineBytes: pending.spec.maxLineBytes,
                startOffset: pending.spec.startOffset,
                resume: pending.spec.resume,
                collectMessages: pending.spec.collectMessages,
                maxMessages: pending.spec.maxMessages,
                maxIndexedTextBytes: pending.spec.maxIndexedTextBytes,
            });
        }
        catch (e) {
            slot.pending = null;
            this.onWorkerError(slot, e instanceof Error ? e : new Error(String(e)));
            pending.reject(new SessionParseError(`postMessage failed: ${String(e)}`, 'worker_failure', 'worker'));
            return;
        }
        if (this.timeoutMs > 0) {
            pending.timeout = setTimeout(() => this.onTimeout(slot, pending), this.timeoutMs);
        }
        pending.controller.signal.addEventListener('abort', () => {
            if (slot.pending === pending && !slot.dead) {
                try {
                    slot.worker.postMessage({ type: 'cancel', taskId: pending.id });
                }
                catch {
                    /* worker 已死，等 error 事件 */
                }
            }
        }, { once: true });
    }
    dispatchInline(pending) {
        pending.dispatched = true;
        void (async () => {
            const signal = pending.controller.signal;
            try {
                let data;
                if (pending.spec.mode === 'head')
                    data = await parseHead(pending.spec.file, { signal, maxDecompressedBytes: pending.spec.maxDecompressedBytes, maxLineBytes: pending.spec.maxLineBytes });
                else if (pending.spec.mode === 'full')
                    data = await parseFull(pending.spec.file, {
                        signal,
                        startOffset: pending.spec.startOffset,
                        resume: pending.spec.resume,
                        collectMessages: pending.spec.collectMessages,
                        maxMessages: pending.spec.maxMessages,
                        maxIndexedTextBytes: pending.spec.maxIndexedTextBytes,
                        maxDecompressedBytes: pending.spec.maxDecompressedBytes,
                        maxLineBytes: pending.spec.maxLineBytes,
                    });
                else if (pending.spec.mode === 'search')
                    data = await parseSearch(pending.spec.file, pending.spec.query || '', {
                        signal,
                        maxSnippets: pending.spec.maxSnippets,
                        role: pending.spec.role,
                        queryMode: pending.spec.queryMode,
                        maxDecompressedBytes: pending.spec.maxDecompressedBytes,
                        maxLineBytes: pending.spec.maxLineBytes,
                    });
                else
                    throw new Error(`unknown task mode: ${pending.spec.mode}`);
                pending.resolve({ ok: true, data, aborted: signal.aborted });
            }
            catch (e) {
                if (isCancelError(e) || signal.aborted)
                    pending.reject(new CancelError());
                else
                    pending.resolve({
                        ok: false, aborted: false, error: e instanceof Error ? e.message : String(e),
                        stats: e && typeof e === 'object' && 'stats' in e ? e.stats : undefined,
                        raced: e && typeof e === 'object' && 'raced' in e ? e.raced === true : false,
                        diagnostic: sessionFailureOf(e),
                    });
            }
            finally {
                this.inlineActive = Math.max(0, this.inlineActive - 1);
                this.pump();
            }
        })();
    }
    onMessage(slot, msg) {
        if (!msg || typeof msg !== 'object')
            return;
        const m = msg;
        const pending = slot.pending;
        if (!pending || pending.id !== m.taskId)
            return;
        if (m.type === 'message-part') {
            try {
                if (typeof m.text !== 'string' || Buffer.byteLength(m.text) > 512 * 1024)
                    throw new Error('oversized parser transfer part');
                pending.transferBytes = (pending.transferBytes ?? 0) + Buffer.byteLength(m.text);
                if (pending.transferBytes > 128 * 1024 * 1024)
                    throw new Error('parser transfer exceeds 128 MiB budget');
                if (!m.field || !['text', 'toolName', 'sourceMessageId', 'callId'].includes(m.field))
                    throw new Error('invalid parser transfer field');
                if (m.metadata) {
                    if (pending.transferRow || Buffer.byteLength(JSON.stringify(m.metadata)) > 128 * 1024)
                        throw new Error('invalid parser transfer metadata');
                    pending.transferRow = { ...m.metadata, text: '', toolName: '' };
                }
                const row = pending.transferRow;
                if (!row)
                    throw new Error('parser transfer has no row metadata');
                row[m.field] = String(row[m.field] ?? '') + m.text;
                if (m.rowFinal) {
                    const rows = pending.transferredMessages ??= [];
                    if (rows.length >= (pending.spec.maxMessages ?? 50_000))
                        throw new Error('parser transfer exceeds message budget');
                    rows.push(row);
                    pending.transferRow = undefined;
                }
                slot.worker.postMessage({ type: 'message-ack', taskId: pending.id, partId: m.partId });
            }
            catch (error) {
                this.onWorkerError(slot, error);
            }
            return;
        }
        if (m.type !== 'done')
            return;
        if (pending.timeout)
            clearTimeout(pending.timeout);
        slot.pending = null;
        if (m.aborted && !m.ok) {
            pending.reject(new CancelError());
        }
        else if (m.ok) {
            if (pending.spec.mode === 'full' && pending.spec.collectMessages) {
                m.data.messages = pending.transferredMessages ?? [];
            }
            pending.resolve({ ok: true, data: m.data, aborted: !!m.aborted });
        }
        else {
            pending.resolve({ ok: false, aborted: false, error: String(m.error || 'unknown worker error'), stats: m.stats, raced: m.raced, diagnostic: m.diagnostic });
        }
        this.pump();
    }
    onWorkerError(slot, err) {
        if (slot.dead)
            return;
        slot.dead = true;
        const pending = slot.pending;
        slot.pending = null;
        const i = this.slots.indexOf(slot);
        if (i !== -1)
            this.slots.splice(i, 1);
        slot.worker.terminate().catch(() => { });
        if (pending) {
            if (pending.timeout)
                clearTimeout(pending.timeout);
            pending.reject(new SessionParseError(`worker error: ${err instanceof Error ? err.message : String(err)}`, 'worker_failure', 'worker'));
        }
        if (!this.terminated)
            this.pump();
    }
    onTimeout(slot, pending) {
        slot.dead = true;
        slot.pending = null;
        const i = this.slots.indexOf(slot);
        if (i !== -1)
            this.slots.splice(i, 1);
        slot.worker.terminate().catch(() => { });
        pending.reject(new SessionParseError('task timeout', 'worker_failure', 'worker'));
        if (!this.terminated)
            this.pump();
    }
}
/**
 * 通用有界并发映射（对应 PORT_TO_TS.md 的 mapLimit）。
 * 取消后不再调度新任务；已启动任务自然跑完。
 *
 * @internal C11：生产的构建并发由 SessionIndexBuilder.runPoolTasks 自行调度
 * （分波派发 + 池上限），本函数仅 worker-pool.test.ts 使用。保留勿删。
 */
export async function mapLimit(items, limit, worker, signal) {
    const out = new Array(items.length);
    let next = 0;
    let aborted = signal?.aborted ?? false;
    const onAbort = () => {
        aborted = true;
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        const n = Math.max(1, Math.min(limit, items.length));
        const runners = Array.from({ length: n }, async () => {
            while (!aborted) {
                const i = next++;
                if (i >= items.length)
                    return;
                out[i] = await worker(items[i], i);
            }
        });
        await Promise.all(runners);
    }
    finally {
        signal?.removeEventListener('abort', onAbort);
    }
    return out;
}
//# sourceMappingURL=worker-pool.js.map