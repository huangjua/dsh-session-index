/**
 * session-worker.ts — worker_threads 入口（编译为 lib/session-worker.js）
 *
 * 单 worker 同时只处理 1 个文件；cooperative cancel：收到 { type: 'cancel' }
 * 消息后中止当前任务（解析循环逐 chunk 检查 signal.aborted），
 * 已启动的任务自然跑完、不再接收新任务。
 *
 * 错误隔离：任何任务异常都被捕获并作为 { ok: false, error } 回报，
 * 绝不把异常抛到 worker 顶层导致崩溃。
 */
import { parentPort } from 'node:worker_threads';
import { parseHead, parseFull, parseSearch } from './streaming-parser.js';
import { sessionFailureOf } from './session-compat.js';
import { CancelError } from './cancel.js';
if (parentPort) {
    let current = null;
    let transfer = null;
    /** At most one bounded part is in flight; acknowledgements supply backpressure. */
    const sendMessages = async (rows, taskId, signal) => {
        let partId = 0;
        for (const row of rows) {
            const { text, toolName, sourceMessageId, callId, ...metadata } = row;
            const fields = Object.entries({ text, toolName, ...sourceMessageId ? { sourceMessageId } : {}, ...callId ? { callId } : {} });
            let rowStart = true;
            for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
                const [field, value] = fields[fieldIndex];
                let offset = 0;
                do {
                    if (signal.aborted)
                        throw new CancelError();
                    let end = Math.min(offset + 128 * 1024, value.length);
                    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff)
                        end--;
                    const id = partId++;
                    await new Promise((resolve, reject) => {
                        const onAbort = () => { transfer = null; reject(new CancelError()); };
                        signal.addEventListener('abort', onAbort, { once: true });
                        transfer = { taskId, partId: id, resolve: () => { signal.removeEventListener('abort', onAbort); resolve(); } };
                        parentPort.postMessage({
                            type: 'message-part', taskId, partId: id, field, text: value.slice(offset, end),
                            ...rowStart ? { metadata } : {},
                            rowFinal: fieldIndex === fields.length - 1 && end === value.length,
                        });
                    });
                    rowStart = false;
                    offset = end;
                } while (offset < value.length);
            }
        }
    };
    parentPort.on('message', (msg) => {
        if (!msg || typeof msg !== 'object')
            return;
        const m = msg;
        if (m.type === 'message-ack') {
            const ack = msg;
            if (transfer && transfer.taskId === ack.taskId && transfer.partId === ack.partId) {
                const accepted = transfer;
                transfer = null;
                accepted.resolve();
            }
            return;
        }
        if (m.type === 'cancel') {
            current?.abort();
            return;
        }
        if (m.type !== 'task')
            return;
        const task = msg;
        const controller = new AbortController();
        current = controller;
        void (async () => {
            let data;
            try {
                const signal = controller.signal;
                const maxDecompressedBytes = task.maxDecompressedBytes;
                if (task.mode === 'head') {
                    data = await parseHead(task.file, { signal, maxDecompressedBytes, maxLineBytes: task.maxLineBytes });
                }
                else if (task.mode === 'full') {
                    data = await parseFull(task.file, {
                        signal,
                        maxDecompressedBytes,
                        maxLineBytes: task.maxLineBytes,
                        startOffset: task.startOffset,
                        collectMessages: task.collectMessages,
                        maxMessages: task.maxMessages,
                        maxIndexedTextBytes: task.maxIndexedTextBytes,
                        // C9b：增量窗口不含 header，需按上一轮结果播种 compat 状态
                        resume: task.resume,
                    });
                }
                else if (task.mode === 'search') {
                    data = await parseSearch(task.file, task.query || '', {
                        signal,
                        maxSnippets: task.maxSnippets,
                        role: task.role,
                        queryMode: task.queryMode,
                        maxDecompressedBytes,
                        maxLineBytes: task.maxLineBytes,
                    });
                }
                else {
                    throw new Error(`unknown worker task mode: ${String(task.mode)}`);
                }
                if (task.mode === 'full' && task.collectMessages) {
                    const summary = data;
                    await sendMessages(summary.messages ?? [], task.taskId, controller.signal);
                    data = { ...summary, messages: [] };
                }
                parentPort.postMessage({
                    type: 'done',
                    taskId: task.taskId,
                    ok: true,
                    aborted: controller.signal.aborted,
                    data,
                });
            }
            catch (e) {
                parentPort.postMessage({
                    type: 'done',
                    taskId: task.taskId,
                    ok: false,
                    aborted: controller.signal.aborted,
                    error: e instanceof Error ? e.message : String(e),
                    stats: e && typeof e === 'object' && 'stats' in e ? e.stats : undefined,
                    raced: e && typeof e === 'object' && 'raced' in e ? e.raced === true : false,
                    diagnostic: sessionFailureOf(e),
                });
            }
            finally {
                if (current === controller)
                    current = null;
            }
        })();
    });
}
//# sourceMappingURL=session-worker.js.map