/**
 * 同一路径上的操作串行执行（跨路径并行）。
 * 链上保留（即使本次失败也不阻塞后续）；调用方仍收到本次的 rejection。
 */
export declare function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T>;
export interface FileLockOptions {
    /** 包括同进程排队的总等待预算；超时显式抛出 ELOCKTIMEOUT。 */
    timeoutMs?: number;
    retryMs?: number;
}
/** realpath 消除 junction/symlink 别名；缺失文件按真实父目录定位。 */
export declare function canonicalFilePath(path: string): Promise<string>;
/**
 * 完整的跨进程临界区。fn 使用规范化实际路径，确保锁与 rename 指向同一资源。
 * owner 在私有目录写入并 fsync 后才 rename 发布，因此崩溃不会留下无 owner 的锁。
 */
export declare function withFileLock<T>(path: string, fn: (actualPath: string) => Promise<T>, options?: FileLockOptions): Promise<T>;
export declare function isRecord(x: unknown): x is Record<string, unknown>;
export declare function str(v: unknown): string | null;
export declare function num(v: unknown): number | null;
export declare function appendLine(path: string, line: string): Promise<void>;
export declare function atomicWriteText(path: string, text: string): Promise<void>;
export interface Fingerprint {
    mtimeMs: number;
    ctimeMs: number;
    size: number;
}
export interface FingerprintCache<T> {
    /** 显式失效（写入后调用），防同 ms 同 size 撞车。 */
    invalidate(path: string): void;
    /** 命中指纹直接返回缓存值；否则整读 → parse → 回填。strictErrors 时仅 ENOENT fallback。 */
    read(path: string, parse: (text: string) => T, fallback: () => T): Promise<T>;
}
export declare function createFingerprintCache<T>(options?: {
    strictErrors?: boolean;
}): FingerprintCache<T>;
