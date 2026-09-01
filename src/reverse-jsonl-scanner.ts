/**
 * reverse-jsonl-scanner.ts — 从尾部向头部扫描 JSONL 的只读扫描器
 *
 * ported from openai/codex@9ded177 reference/codex/codex-rs/rollout/src/reverse_jsonl_scanner.rs
 * （64KB 分块从尾向头扫描、坏行跳过、超长记录丢弃、冻结窗口）
 *
 * 用于：从尾部取“最新 title/lastAssistantText”等增量字段；若未来索引改
 * append-only JSONL 事件日志，这是核心读路径。
 */
import type { FileHandle } from 'node:fs/promises'

const READ_CHUNK_SIZE = 64 * 1024

export type ScanOutcome<T> =
  | { outcome: 'parsed'; value: T }
  | { outcome: 'rejected'; error: Error }

export interface ReverseScannerOptions {
  /** 逻辑扫描终点字节偏移（冻结窗口，忽略其后追加的内容）；缺省 = 文件末尾 */
  endByteOffset?: number
  /** 超过该字节数的记录直接丢弃，不缓冲不解析 */
  maxRecordBytes?: number
}

export class ReverseJsonlScanner {
  private readonly file: FileHandle
  private nextChunkEnd: number
  private chunkPosition = 0
  private readonly chunk: Buffer
  private recordReversed: Buffer[] = []
  private recordReversedLen = 0
  private readonly maxRecordBytes: number | null
  private discardingOversizedRecord = false

  private constructor(file: FileHandle, endByteOffset: number, maxRecordBytes: number | null) {
    this.file = file
    this.nextChunkEnd = endByteOffset
    this.chunk = Buffer.alloc(READ_CHUNK_SIZE)
    this.maxRecordBytes = maxRecordBytes
  }

  /** 从文件末尾开始扫描。 */
  static async new(file: FileHandle): Promise<ReverseJsonlScanner> {
    const { size } = await file.stat()
    return ReverseJsonlScanner.newAt(file, size)
  }

  /** 逻辑终点为 endByteOffset：只扫描该前缀，忽略之后追加的内容。 */
  static async newAt(
    file: FileHandle,
    endByteOffset: number,
    options?: ReverseScannerOptions,
  ): Promise<ReverseJsonlScanner> {
    const { size } = await file.stat()
    if (endByteOffset > size) {
      throw new RangeError(`reverse JSONL scan end (${endByteOffset}) is past the file (${size})`)
    }
    return new ReverseJsonlScanner(file, endByteOffset, options?.maxRecordBytes ?? null)
  }

  /**
   * 扫描下一条非空记录。
   * - 到达文件头：返回 null；
   * - 记录是合法 JSON：返回 { outcome: 'parsed', value }；
   * - 记录不是合法 JSON：返回 { outcome: 'rejected', error }，扫描器保持可用。
   */
  async scanNext<T>(parse: (text: string) => T): Promise<ScanOutcome<T> | null> {
    for (;;) {
      if (this.chunkPosition === 0) {
        if (this.nextChunkEnd === 0) {
          if (this.discardingOversizedRecord) {
            this.discardingOversizedRecord = false
            return null
          }
          return this.finishRecord(parse)
        }
        const readSize = Math.min(this.nextChunkEnd, READ_CHUNK_SIZE)
        this.nextChunkEnd -= readSize
        const { bytesRead } = await this.file.read(this.chunk, 0, readSize, this.nextChunkEnd)
        if (bytesRead !== readSize) {
          throw new Error(`short read: expected ${readSize}, got ${bytesRead}`)
        }
        this.chunkPosition = readSize
      }

      const chunk = this.chunk.subarray(0, this.chunkPosition)
      const newlinePosition = chunk.lastIndexOf(0x0a)
      if (newlinePosition !== -1) {
        const fragment = chunk.subarray(newlinePosition + 1)
        if (!this.discardingOversizedRecord) {
          if (
            this.maxRecordBytes !== null &&
            this.recordReversedLen + fragment.length > this.maxRecordBytes
          ) {
            this.clearRecord()
            this.discardingOversizedRecord = true
          } else {
            this.appendReversed(fragment)
          }
        }
        this.chunkPosition = newlinePosition
        if (this.discardingOversizedRecord) {
          this.discardingOversizedRecord = false
          continue
        }
        const outcome = this.finishRecord(parse)
        if (outcome !== null) return outcome
      } else {
        if (!this.discardingOversizedRecord) {
          if (
            this.maxRecordBytes !== null &&
            this.recordReversedLen + chunk.length > this.maxRecordBytes
          ) {
            this.clearRecord()
            this.discardingOversizedRecord = true
          } else {
            this.appendReversed(chunk)
          }
        }
        this.chunkPosition = 0
      }
    }
  }

  /** 关闭底层文件句柄。 */
  async close(): Promise<void> {
    await this.file.close()
  }

  private clearRecord(): void {
    this.recordReversed = []
    this.recordReversedLen = 0
  }

  private appendReversed(bytes: Uint8Array): void {
    const rev = Buffer.allocUnsafe(bytes.length)
    for (let i = 0; i < bytes.length; i++) rev[i] = bytes[bytes.length - 1 - i]
    this.recordReversed.push(rev)
    this.recordReversedLen += bytes.length
  }

  private finishRecord<T>(parse: (text: string) => T): ScanOutcome<T> | null {
    if (this.recordReversedLen === 0) return null
    const buf = Buffer.allocUnsafe(this.recordReversedLen)
    let offset = 0
    for (const part of this.recordReversed) {
      part.copy(buf, offset)
      offset += part.length
    }
    // Rust 版在 finish 时对整个累积缓冲做一次 reverse
    buf.reverse()
    this.clearRecord()
    const text = buf.toString('utf8')
    if (text.trim() === '') return null
    try {
      return { outcome: 'parsed', value: parse(text) }
    } catch (e) {
      return { outcome: 'rejected', error: e instanceof Error ? e : new Error(String(e)) }
    }
  }
}
