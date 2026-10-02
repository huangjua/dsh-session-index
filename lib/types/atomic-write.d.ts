export interface AtomicWriteOptions {
    /** 发布前对读回内容做额外校验（如 version===1），失败则丢弃 tmp、保留旧文件 */
    validate?: (text: string) => boolean;
    /** 发布前硬链备份 index.json.bak（失败不阻断，给人工回滚留后手） */
    backup?: boolean;
}
/**
 * 原子写 JSON：
 * 1. 写唯一临时文件 index.json.tmp.<pid>.<seq>（'wx' no-clobber）；
 * 2. fh.sync()（fsync）；
 * 3. 读回 + JSON.parse 校验（失败 → 删 tmp、旧文件原封不动、抛错）；
 * 4. 可选 hardlink 备份；
 * 5. rename 覆盖（Windows 上 Node 走 MoveFileEx(REPLACE_EXISTING)）。
 */
export declare function atomicWriteJson(indexFile: string, data: unknown, options?: AtomicWriteOptions): Promise<void>;
export interface StaleCleanupOptions {
    /** 超过该年龄（毫秒）的才删（默认 24h） */
    maxAgeMs?: number;
    /** 文件名匹配（如 /\.tmp\.\d+\.\d+$/） */
    match?: RegExp;
}
/** 清理目录下的陈旧临时文件（Codex cleanup_stale_temps 语义）。返回删除数。 */
export declare function cleanupStaleTemps(dir: string, options?: StaleCleanupOptions): Promise<number>;
/**
 * durable run-marker：跨进程/崩溃后重启的构建防重。
 * - open 'wx' 原子抢占，写入 pid + started_at；
 * - EEXIST → 读 mtime，超过 staleAfterMs（默认 15 分钟，DSH 构建分钟级）视为
 *   陈旧并删除重抢（Codex 6 小时阈值不适用）；
 * - 返回 null = 已有活跃/新鲜构建，调用方跳过本次构建。
 */
export declare class RunMarker {
    private readonly file;
    private released;
    private readonly pid;
    private constructor();
    static acquire(markerFile: string, staleAfterMs?: number): Promise<RunMarker | null>;
    /**
     * 对应 Rust remove_on_drop：结束/catch/finally 时删除 marker。
     * 释放前校验所有权（P2-10）：若本构建超时被其他进程抢占（陈旧 marker 重抢），
     * 文件里已是别人的 pid，不得误删——否则 C 进程可能再闯进来。
     */
    release(): Promise<void>;
}
