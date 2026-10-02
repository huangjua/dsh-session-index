/**
 * watcher.ts — sessions 目录递归监听（P0-2）
 *
 * 把"每次工具调用全目录 stat 对账"变成"变更驱动"：fs.watch(recursive)
 * 捕获新会话创建/会话文件追加（DSH 持久化是 append-only，rename/change 都会触发），
 * debounce 后回调。构造失败（无权限/平台限制）返回 ok:false，调用方回退节流轮询。
 */
import { watch } from 'node:fs';
export function createSessionWatcher(root, debounceMs, onChange, onError, options = {}) {
    let watcher = null;
    let timer = null;
    let maxWaitTimer = null;
    let closed = false;
    const result = { ok: true, close };
    const maxWaitMs = Math.max(debounceMs, options.maxWaitMs ?? 5000);
    const clearTimers = () => {
        if (timer)
            clearTimeout(timer);
        if (maxWaitTimer)
            clearTimeout(maxWaitTimer);
        timer = null;
        maxWaitTimer = null;
    };
    const deliver = () => {
        clearTimers();
        if (!closed)
            onChange();
    };
    function close() {
        if (closed)
            return;
        closed = true;
        result.ok = false;
        clearTimers();
        try {
            watcher?.close();
        }
        catch { /* ignore */ }
        watcher = null;
    }
    const schedule = () => {
        if (closed)
            return;
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(deliver, debounceMs);
        if (!maxWaitTimer)
            maxWaitTimer = setTimeout(deliver, maxWaitMs);
    };
    try {
        watcher = options.watch ? options.watch(root, schedule) : watch(root, { recursive: true }, schedule);
        watcher.on('error', () => {
            // 监听中途失效（目录被删/权限变化/平台限制）：通知调用方切回节流 stat 回退，
            // 否则索引会静默停止保鲜。
            if (closed)
                return;
            close();
            onError?.();
        });
    }
    catch {
        close();
    }
    return result;
}
//# sourceMappingURL=watcher.js.map