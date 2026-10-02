/**
 * cancel.ts — 取消竞争原语
 *
 * ported from openai/codex@9ded177 reference/codex/codex-rs/async-utils/src/lib.rs
 * （OrCancelExt：tokio::select! { _ = token.cancelled() => Cancelled, res = self => Ok(res) }）
 *
 * 只做“取消信号竞争”，不打断 worker 内部 CPU 任务；worker 侧每处理完一个 chunk
 * 检查一次 signal.aborted，对应 Codex 的 cooperative cancellation。
 */
export declare class CancelError extends Error {
    name: string;
    constructor(message?: string);
}
/** 若信号已中止则抛 CancelError（worker 内逐行/逐 chunk 调用）。 */
export declare function throwIfAborted(signal?: AbortSignal): void;
/** 判断错误是否为取消（含 DOMException AbortError）。 */
export declare function isCancelError(e: unknown): boolean;
/**
 * 让 promise 与取消信号竞争：signal 先触发则拒绝（CancelError），
 * promise 先完成则正常 settle 并移除监听。
 *
 * @internal C11：生产路径未使用（builder 的取消走 WorkerPool + throwIfAborted），
 * 仅 cancel.test.ts 覆盖其语义。保留是为了让"promise 与信号竞争"这一语义有
 * 单一实现可用，勿误判为死代码删除；若未来接入，请优先在 builder 的 await 点使用。
 */
export declare function orCancel<T>(p: Promise<T>, signal?: AbortSignal): Promise<T>;
