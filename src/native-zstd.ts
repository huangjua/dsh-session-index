/**
 * native-zstd.ts — node:zlib 原生 zstd 逐帧解压（fzstd 的加速路径）
 *
 * DSH 的 session.jsonl.zstd 是拼接多帧 zstd；Node 22 的 node:zlib 对
 * 拼接流只解第一帧。方案：按帧 magic 切分（真实帧 28 B5 2F FD 与
 * skippable 帧 50 2A 4D 18 都是切分点）→ 每帧用原生 ZstdDecompress
 * 解压 → 按序喂给行处理器。原生速度 ~3-4x fzstd。
 *
 * 安全网：
 * - 帧切分基于 magic 扫描（压缩数据内部理论上可能撞 magic，概率极低）；
 *   任一帧解压失败 → 抛错，由调用方整体回退 fzstd 流式路径；
 * - skippable frame（可跳过数据段，无输出）单独切出并跳过；
 * - 首帧不是 zstd magic / 无帧 → 抛错回退；
 * - 输出总量超 maxDecompressedBytes → 抛错；
 * - 单帧解压传 maxOutputLength（Node 22 支持），防止损坏帧在总量检查前
 *   一次性分配超大内存。
 */
import { open, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import * as fzstd from 'fzstd'
import { throwIfAborted } from './cancel.js'
import { SessionParseError } from './session-compat.js'

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** skippable frame：magic 50 2A 4D 18（高 28 位 == 0x184D2A5） */
export const SKIPPABLE_MAGIC = Buffer.from([0x50, 0x2a, 0x4d, 0x18])

export interface NativeDecodeStats {
  frames: number
  /** 向 sink 发出的解压字节（兼容原字段）。 */
  bytes: number
  stopped: boolean
  /** 打开文件时发现的完整来源大小；不代表实际读取量。 */
  discoveredBytes: number
  /** FileHandle.read 实际返回的压缩字节。 */
  readBytes: number
  /** 压缩输入 buffer 的分配字节；subarray 和校验共享此 buffer。 */
  allocatedBytes: number
  /** 原生解压产生的字节，包含被丢弃的中部残缺帧输出。 */
  decodedBytes: number
  /** Successful fzstd validation output; separate to preserve legacy decodedBytes semantics. */
  validationDecodedBytes?: number
  /** 增量读取的压缩字节；全读为 0。 */
  deltaBytes: number
  raced: boolean
}

export interface NativeDecodeOptions {
  signal?: AbortSignal
  /** 解压输出总字节上限（默认 256MB） */
  maxDecompressedBytes?: number
  /** 实际读取及压缩输入 buffer 分配上限（默认 64MB，超过走 fzstd 流式）。 */
  maxCompressedBytes?: number
  /** P1 delta：只从该字节偏移开始读（须为帧边界），之前的内容视为已索引 */
  startOffset?: number
}

export class NativeZstdUnavailableError extends Error {
  constructor() {
    super('node:zlib ZstdDecompress unavailable')
    this.name = 'NativeZstdUnavailableError'
  }
}

/** 来源在读取/解压期间发生变化；调用方须重试，不能从当前解析状态重放。 */
export class NativeZstdRaceError extends Error {
  readonly raced = true
  readonly code = 'NATIVE_ZSTD_RACED'
  readonly reasonCode: 'source_changed' | 'invalid_offset'
  readonly phase = 'compressed_read'
  readonly retryable: boolean

  constructor(message: string, readonly stats: NativeDecodeStats, reasonCode: 'source_changed' | 'invalid_offset' = 'source_changed') {
    super(`native decode: source raced (${message})`)
    this.name = 'NativeZstdRaceError'
    this.reasonCode = reasonCode
    this.retryable = reasonCode === 'source_changed'
  }
}

const READ_CHUNK_BYTES = 512 * 1024

function sameSource(before: Stats, after: Stats): boolean {
  return before.size === after.size && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs && before.dev === after.dev && before.ino === after.ino
}

function checkByteLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`native decode: ${name} must be a positive safe integer`)
  }
}

/** Magic scanning is heuristic. Confirm EOF against the whole input before
 * suppressing the independent decoder fallback; an embedded magic collision
 * must remain recoverable with fzstd. Validation output is counted, not stored. */
function confirmedTailEof(tail: Buffer, stats: NativeDecodeStats): boolean {
  try {
    const validator = new fzstd.Decompress(chunk => {
      stats.validationDecodedBytes = (stats.validationDecodedBytes ?? 0) + chunk.length
    })
    validator.push(new Uint8Array(tail.buffer, tail.byteOffset, tail.byteLength), true)
    return false
  } catch (error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code === fzstd.ZstdErrorCode.UnexpectedEOF
  }
}

export function nativeZstdAvailable(): boolean {
  return typeof zstdDecompressSync === 'function'
}

/** 一个切分帧：真实帧或 skippable 段 */
export interface FrameSlice {
  start: number
  end: number
  skippable: boolean
}

/**
 * 原生逐帧解压。sink 返回 false 提前停止（head/search 早停）。
 * 任何帧失败 / 结构异常 → 抛错（调用方回退 fzstd）。
 */
export async function nativeDecodeZstd(
  file: string,
  sink: (decoded: Buffer) => boolean | void,
  options: NativeDecodeOptions = {},
): Promise<NativeDecodeStats> {
  if (typeof zstdDecompressSync !== 'function') throw new NativeZstdUnavailableError()
  const {
    signal,
    maxDecompressedBytes = 256 * 1024 * 1024,
    maxCompressedBytes = 64 * 1024 * 1024,
    startOffset = 0,
  } = options
  throwIfAborted(signal)
  if (!Number.isSafeInteger(startOffset) || startOffset < 0) {
    throw new SessionParseError('native decode: startOffset must be a non-negative safe integer', 'invalid_offset', 'compressed_read')
  }
  checkByteLimit(maxCompressedBytes, 'maxCompressedBytes')
  checkByteLimit(maxDecompressedBytes, 'maxDecompressedBytes')
  const stats: NativeDecodeStats = {
    frames: 0, bytes: 0, stopped: false, discoveredBytes: 0, readBytes: 0,
    allocatedBytes: 0, decodedBytes: 0, deltaBytes: 0, raced: false,
  }
  const race = (message: string): never => {
    stats.raced = true
    throw new NativeZstdRaceError(message, { ...stats })
  }
  const handle = await open(file, 'r')
  try {
    throwIfAborted(signal)
    const initial = await handle.stat()
    stats.discoveredBytes = initial.size
    if (startOffset > initial.size) {
      stats.raced = true
      throw new NativeZstdRaceError('compressed startOffset exceeds source size', { ...stats }, 'invalid_offset')
    }
    const tailLength = initial.size - startOffset
    if (tailLength > maxCompressedBytes) {
      throw new Error(`native decode: compressed range ${tailLength} exceeds ${maxCompressedBytes}`)
    }
    // 只分配和读取 [startOffset, 初始 EOF)。追加内容留给下一轮；绝不分配历史前缀。
    // Slow 避免小尾段借用 8 KiB slab，使输入 backing allocation 也受相同限额约束。
    const tail = Buffer.allocUnsafeSlow(tailLength)
    stats.allocatedBytes = tailLength
    while (stats.readBytes < tailLength) {
      throwIfAborted(signal)
      const { bytesRead } = await handle.read(
        tail, stats.readBytes, Math.min(READ_CHUNK_BYTES, tailLength - stats.readBytes),
        startOffset + stats.readBytes,
      )
      if (bytesRead === 0) race(`short read at ${startOffset + stats.readBytes}; expected EOF ${initial.size}`)
      stats.readBytes += bytesRead
      stats.deltaBytes = startOffset > 0 ? stats.readBytes : 0
      throwIfAborted(signal)
    }
    const assertUnchanged = async (): Promise<void> => {
      throwIfAborted(signal)
      if (!sameSource(initial, await handle.stat())) race('opened file fingerprint changed')
      const current = await stat(file).catch(() => race('source path is no longer readable'))
      if (!sameSource(initial, current)) race('source path fingerprint changed')
      throwIfAborted(signal)
    }
    // 在任何 sink 副作用之前检查读取窗口内的变动。
    await assertUnchanged()
    const frames = splitFrames(tail)
    // startOffset 语义：偏移必须是帧边界（P1 delta 的 indexedBytes 保证）；
    // startOffset=0 时首帧必须正好在文件头。
    if (frames.length === 0 || frames[0].start !== 0 || (startOffset === 0 && frames[0].skippable)) {
      if (tail.length > 0 && tail.length < 4 && ZSTD_MAGIC.subarray(0, tail.length).equals(tail)) {
        throw new SessionParseError('incomplete zstd frame magic', 'partial_frame', 'decode', true)
      }
      if (startOffset > 0) throw new SessionParseError('native decode: no zstd frame header at expected offset', 'invalid_offset', 'decode')
      throw new Error('native decode: no zstd frame header at expected offset')
    }
    // 最后一个真实帧：保留现有 fzstd 完整性校验语义（尾部半帧 → 抛错 → 调用方 150ms 重试）。
    const lastReal = [...frames].reverse().find((f) => !f.skippable)
    stats.frames = frames.length
    for (const frame of frames) {
      throwIfAborted(signal)
      if (frame.skippable) continue
      // zstdDecompressSync：比 per-frame ZstdDecompress 流实例快 ~19x
      // （实测 16724 帧：1.2s vs 22.9s），且支持 maxOutputLength 防损坏帧大分配。
      let out: Buffer
      try {
        out = decompressFrame(tail.subarray(frame.start, frame.end), Math.max(1, maxDecompressedBytes - stats.decodedBytes))
      } catch (error) {
        if (frame === lastReal) {
          try { fzstd.decompress(tail.subarray(frame.start, frame.end)) }
          catch (validation) {
            if (validation && typeof validation === 'object' && 'code' in validation && validation.code === fzstd.ZstdErrorCode.UnexpectedEOF && confirmedTailEof(tail, stats)) {
              throw new SessionParseError('native decode: last frame truncated (file may be mid-write)', 'partial_frame', 'decode', true)
            }
          }
        }
        throw error
      }
      stats.decodedBytes += out.length
      if (stats.decodedBytes > maxDecompressedBytes) {
        throw new Error(`decompressed size exceeds ${maxDecompressedBytes} bytes`)
      }
      // 中部残缺帧跳过（崩溃恢复遗留：DSH append-only，断电后会在残缺帧后追加新的完整帧）：
      // node:zlib 对截断帧“静默成功”输出部分字节，若把它喂给行缓冲会与后续帧内容拼成一行
      // 垃圾行 → JSON.parse 失败 → 后续所有帧静默丢失。完整 JSONL 帧解压输出必以 '\n' 结尾，
      // 据此识别并丢弃残缺帧（与 DSH 读取器的逻辑视图一致：完整帧保留、残缺帧丢弃）。
      // 末帧不做此检查：尾部半帧由下方 fzstd 校验抛错，保留“文件正在写入 → 重试”语义。
      if (frame !== lastReal && (out.length === 0 || out[out.length - 1] !== 0x0a)) {
        continue
      }
      stats.bytes += out.length
      if (stats.bytes > maxDecompressedBytes) {
        throw new Error(`decompressed size exceeds ${maxDecompressedBytes} bytes`)
      }
      if (sink(out) === false) {
        stats.stopped = true
        break
      }
    }
    // 末帧完整性校验：node:zlib 对“magic + 截断帧”会静默成功（输出 0/部分），
    // 会话文件是 append-only，构建期间最常见的损坏就是尾部半帧。
    // 用 fzstd 解一遍末帧（KB 级，几乎零成本）：不完整 → 抛错 → 调用方整体回退。
    // 早停（head/search）时尾帧未解压，跳过该校验。
    if (lastReal && !stats.stopped) {
      const lastFrame = tail.subarray(lastReal.start, lastReal.end)
      try {
        stats.validationDecodedBytes = (stats.validationDecodedBytes ?? 0) + fzstd.decompress(lastFrame).length
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === fzstd.ZstdErrorCode.UnexpectedEOF && confirmedTailEof(tail, stats)) {
          throw new SessionParseError('native decode: last frame truncated (file may be mid-write)', 'partial_frame', 'decode', true)
        }
        throw error
      }
    }
    await assertUnchanged()
    return stats
  } catch (error) {
    // 回退路径需累计 native 已读取的输入；保留原始取消/解析错误类型和诊断。
    if (error instanceof Error && Object.isExtensible(error) && !('stats' in error)) {
      Object.defineProperty(error, 'stats', { value: { ...stats }, enumerable: true, configurable: true })
    }
    throw error
  } finally {
    await handle.close()
  }
}

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
export function splitFrames(data: Buffer): FrameSlice[] {
  const frames: FrameSlice[] = []
  let pos = 0
  while (pos + 4 <= data.length) {
    const magic = data.readUInt32LE(pos)
    let skippable = false
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      skippable = true
    } else if (magic !== 0xfd2fb528) {
      break // 非帧起始（尾部半帧/垃圾）→ 停止
    }
    if (skippable) {
      // skippable 帧：帧头 4 字节 magic + 4 字节 LE 帧长，O(1) 求结束点
      if (pos + 8 > data.length) throw new SessionParseError('native decode: skippable frame header truncated', 'partial_frame', 'decode', true)
      const frameLen = data.readUInt32LE(pos + 4)
      const end = pos + 8 + frameLen
      if (end > data.length) throw new SessionParseError('native decode: skippable frame truncated', 'partial_frame', 'decode', true)
      frames.push({ start: pos, end, skippable: true })
      pos = end
      continue
    }
    const nextReal = data.indexOf(ZSTD_MAGIC, pos + 4)
    const end = nextReal === -1 ? data.length : nextReal
    frames.push({ start: pos, end, skippable: false })
    pos = end
  }
  return frames
}

export function isSkippableFrame(frame: Buffer): boolean {
  if (frame.length < 4) return false
  const magic = frame.readUInt32LE(0)
  return (magic & 0xfffffff0) === 0x184d2a50
}

function decompressFrame(frame: Buffer, maxOutputLength: number): Buffer {
  try {
    return zstdDecompressSync(frame, { maxOutputLength })
  } catch (e) {
    // maxOutputLength 超限 / 损坏帧：同步抛出（与旧 stream 路径错误语义一致）
    throw new Error(`zstd frame decode failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
