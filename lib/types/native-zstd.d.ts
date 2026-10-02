export declare const ZSTD_MAGIC: Buffer<ArrayBuffer>;
/** skippable frame：magic 50 2A 4D 18（高 28 位 == 0x184D2A5） */
export declare const SKIPPABLE_MAGIC: Buffer<ArrayBuffer>;
export interface NativeDecodeStats {
    frames: number;
    /** 向 sink 发出的解压字节（兼容原字段）。 */
    bytes: number;
    stopped: boolean;
    /** 打开文件时发现的完整来源大小；不代表实际读取量。 */
    discoveredBytes: number;
    /** FileHandle.read 实际返回的压缩字节。 */
    readBytes: number;
    /** 压缩输入 buffer 的分配字节；subarray 和校验共享此 buffer。 */
    allocatedBytes: number;
    /** 原生解压产生的字节，包含被丢弃的中部残缺帧输出。 */
    decodedBytes: number;
    /** Successful fzstd validation output; separate to preserve legacy decodedBytes semantics. */
    validationDecodedBytes?: number;
    /** 增量读取的压缩字节；全读为 0。 */
    deltaBytes: number;
    raced: boolean;
}
export interface NativeDecodeOptions {
    signal?: AbortSignal;
    /** 解压输出总字节上限（默认 256MB） */
    maxDecompressedBytes?: number;
    /** 实际读取及压缩输入 buffer 分配上限（默认 64MB，超过走 fzstd 流式）。 */
    maxCompressedBytes?: number;
    /** P1 delta：只从该字节偏移开始读（须为帧边界），之前的内容视为已索引 */
    startOffset?: number;
}
export declare class NativeZstdUnavailableError extends Error {
    constructor();
}
/** 来源在读取/解压期间发生变化；调用方须重试，不能从当前解析状态重放。 */
export declare class NativeZstdRaceError extends Error {
    readonly stats: NativeDecodeStats;
    readonly raced = true;
    readonly code = "NATIVE_ZSTD_RACED";
    readonly reasonCode: 'source_changed' | 'invalid_offset';
    readonly phase = "compressed_read";
    readonly retryable: boolean;
    constructor(message: string, stats: NativeDecodeStats, reasonCode?: 'source_changed' | 'invalid_offset');
}
export declare function nativeZstdAvailable(): boolean;
/** 一个切分帧：真实帧或 skippable 段 */
export interface FrameSlice {
    start: number;
    end: number;
    skippable: boolean;
}
/**
 * 原生逐帧解压。sink 返回 false 提前停止（head/search 早停）。
 * 任何帧失败 / 结构异常 → 抛错（调用方回退 fzstd）。
 */
export declare function nativeDecodeZstd(file: string, sink: (decoded: Buffer) => boolean | void, options?: NativeDecodeOptions): Promise<NativeDecodeStats>;
/**
 * 按 magic 扫描切帧：真实帧与 skippable 帧都是切分点，返回按文件顺序的 FrameSlice。
 *
 * 性能关键：**绝不能**对 SKIPPABLE_MAGIC 做无界 `indexOf` 搜索——DSH 会话文件
 * 没有 skippable 帧，`indexOf` 每次都会扫到文件尾 → 16724 帧 = O(n²) ≈ 19s。
 * 正确做法：只在"当前位置本来就是 skippable 帧"时才按帧头长度 O(1) 求其结束点；
 * 真实帧的结束点 = 下一个真实帧 magic（帧密集，`indexOf` 总代价 O(n)）。
 * 罕见情形（skippable 帧夹在两个真实帧之间）：并入前一帧切片，node:zlib 解码
 * 报错 → 整体回退 fzstd（fzstd 原生跳过 skippable 帧），正确性由回退兜底。
 */
export declare function splitFrames(data: Buffer): FrameSlice[];
export declare function isSkippableFrame(frame: Buffer): boolean;
