const READ_CHUNK_SIZE = 64 * 1024;
export class ReverseJsonlScanner {
    file;
    nextChunkEnd;
    chunkPosition = 0;
    chunk;
    recordReversed = [];
    recordReversedLen = 0;
    maxRecordBytes;
    discardingOversizedRecord = false;
    constructor(file, endByteOffset, maxRecordBytes) {
        this.file = file;
        this.nextChunkEnd = endByteOffset;
        this.chunk = Buffer.alloc(READ_CHUNK_SIZE);
        this.maxRecordBytes = maxRecordBytes;
    }
    /** 从文件末尾开始扫描。 */
    static async new(file) {
        const { size } = await file.stat();
        return ReverseJsonlScanner.newAt(file, size);
    }
    /** 逻辑终点为 endByteOffset：只扫描该前缀，忽略之后追加的内容。 */
    static async newAt(file, endByteOffset, options) {
        const { size } = await file.stat();
        if (endByteOffset > size) {
            throw new RangeError(`reverse JSONL scan end (${endByteOffset}) is past the file (${size})`);
        }
        return new ReverseJsonlScanner(file, endByteOffset, options?.maxRecordBytes ?? null);
    }
    /**
     * 扫描下一条非空记录。
     * - 到达文件头：返回 null；
     * - 记录是合法 JSON：返回 { outcome: 'parsed', value }；
     * - 记录不是合法 JSON：返回 { outcome: 'rejected', error }，扫描器保持可用。
     */
    async scanNext(parse) {
        for (;;) {
            if (this.chunkPosition === 0) {
                if (this.nextChunkEnd === 0) {
                    if (this.discardingOversizedRecord) {
                        this.discardingOversizedRecord = false;
                        return null;
                    }
                    return this.finishRecord(parse);
                }
                const readSize = Math.min(this.nextChunkEnd, READ_CHUNK_SIZE);
                this.nextChunkEnd -= readSize;
                const { bytesRead } = await this.file.read(this.chunk, 0, readSize, this.nextChunkEnd);
                if (bytesRead !== readSize) {
                    throw new Error(`short read: expected ${readSize}, got ${bytesRead}`);
                }
                this.chunkPosition = readSize;
            }
            const chunk = this.chunk.subarray(0, this.chunkPosition);
            const newlinePosition = chunk.lastIndexOf(0x0a);
            if (newlinePosition !== -1) {
                const fragment = chunk.subarray(newlinePosition + 1);
                if (!this.discardingOversizedRecord) {
                    if (this.maxRecordBytes !== null &&
                        this.recordReversedLen + fragment.length > this.maxRecordBytes) {
                        this.clearRecord();
                        this.discardingOversizedRecord = true;
                    }
                    else {
                        this.appendReversed(fragment);
                    }
                }
                this.chunkPosition = newlinePosition;
                if (this.discardingOversizedRecord) {
                    this.discardingOversizedRecord = false;
                    continue;
                }
                const outcome = this.finishRecord(parse);
                if (outcome !== null)
                    return outcome;
            }
            else {
                if (!this.discardingOversizedRecord) {
                    if (this.maxRecordBytes !== null &&
                        this.recordReversedLen + chunk.length > this.maxRecordBytes) {
                        this.clearRecord();
                        this.discardingOversizedRecord = true;
                    }
                    else {
                        this.appendReversed(chunk);
                    }
                }
                this.chunkPosition = 0;
            }
        }
    }
    /** 关闭底层文件句柄。 */
    async close() {
        await this.file.close();
    }
    clearRecord() {
        this.recordReversed = [];
        this.recordReversedLen = 0;
    }
    appendReversed(bytes) {
        const rev = Buffer.allocUnsafe(bytes.length);
        for (let i = 0; i < bytes.length; i++)
            rev[i] = bytes[bytes.length - 1 - i];
        this.recordReversed.push(rev);
        this.recordReversedLen += bytes.length;
    }
    finishRecord(parse) {
        if (this.recordReversedLen === 0)
            return null;
        const buf = Buffer.allocUnsafe(this.recordReversedLen);
        let offset = 0;
        for (const part of this.recordReversed) {
            part.copy(buf, offset);
            offset += part.length;
        }
        // Rust 版在 finish 时对整个累积缓冲做一次 reverse
        buf.reverse();
        this.clearRecord();
        const text = buf.toString('utf8');
        if (text.trim() === '')
            return null;
        try {
            return { outcome: 'parsed', value: parse(text) };
        }
        catch (e) {
            return { outcome: 'rejected', error: e instanceof Error ? e : new Error(String(e)) };
        }
    }
}
//# sourceMappingURL=reverse-jsonl-scanner.js.map