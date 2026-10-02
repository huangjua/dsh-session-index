/**
 * reverse-jsonl-scanner.ts — 从尾部向头部扫描 JSONL 的只读扫描器
 *
 * ported from openai/codex@9ded177 reference/codex/codex-rs/rollout/src/reverse_jsonl_scanner.rs
 * （64KB 分块从尾向头扫描、坏行跳过、超长记录丢弃、冻结窗口）
 *
 * 用于：从尾部取“最新 title/lastAssistantText”等增量字段；若未来索引改
 * append-only JSONL 事件日志，这是核心读路径。
 */
import type { FileHandle } from 'node:fs/promises';
export type ScanOutcome<T> = {
    outcome: 'parsed';
    value: T;
} | {
    outcome: 'rejected';
    error: Error;
};
export interface ReverseScannerOptions {
    /** 逻辑扫描终点字节偏移（冻结窗口，忽略其后追加的内容）；缺省 = 文件末尾 */
    endByteOffset?: number;
    /** 超过该字节数的记录直接丢弃，不缓冲不解析 */
    maxRecordBytes?: number;
}
export declare class ReverseJsonlScanner {
    private readonly file;
    private nextChunkEnd;
    private chunkPosition;
    private readonly chunk;
    private recordReversed;
    private recordReversedLen;
    private readonly maxRecordBytes;
    private discardingOversizedRecord;
    private constructor();
    /** 从文件末尾开始扫描。 */
    static new(file: FileHandle): Promise<ReverseJsonlScanner>;
    /** 逻辑终点为 endByteOffset：只扫描该前缀，忽略之后追加的内容。 */
    static newAt(file: FileHandle, endByteOffset: number, options?: ReverseScannerOptions): Promise<ReverseJsonlScanner>;
    /**
     * 扫描下一条非空记录。
     * - 到达文件头：返回 null；
     * - 记录是合法 JSON：返回 { outcome: 'parsed', value }；
     * - 记录不是合法 JSON：返回 { outcome: 'rejected', error }，扫描器保持可用。
     */
    scanNext<T>(parse: (text: string) => T): Promise<ScanOutcome<T> | null>;
    /** 关闭底层文件句柄。 */
    close(): Promise<void>;
    private clearRecord;
    private appendReversed;
    private finishRecord;
}
