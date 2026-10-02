import { describe, it, before, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdtemp, open, truncate, writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  nativeDecodeZstd, NativeZstdRaceError, splitFrames, ZSTD_MAGIC,
} from '../src/native-zstd.js'

let root = ''
let handlePrototype: { read: (...args: any[]) => Promise<any>; stat: (...args: any[]) => Promise<any> }
const first = zstdCompressSync(Buffer.from('first line\n'))
const last = zstdCompressSync(Buffer.from('tail line\n'))

before(async () => {
  for (const variable of ['DSH_HOME', 'TEMP', 'TMP']) {
    assert.ok(process.env[variable], `${variable} must explicitly point to an isolated test directory`)
  }
  root = await mkdtemp(join(tmpdir(), 'native-zstd-test-'))
  const file = join(root, 'prototype.zstd')
  await writeFile(file, last)
  const handle = await open(file, 'r')
  handlePrototype = Object.getPrototypeOf(handle)
  await handle.close()
})

async function fixture(name: string, data = Buffer.concat([first, last])): Promise<string> {
  const file = join(root, `${name}.zstd`)
  await writeFile(file, data)
  return file
}

function observeClose(t: TestContext): () => number {
  let count = 0
  const seen = new Set<unknown>()
  const originalStat = handlePrototype.stat
  // FileHandle.close is an own method; capture each opened handle at its first stat.
  t.mock.method(handlePrototype, 'stat', function(this: any, ...args: any[]) {
    if (!seen.has(this)) {
      seen.add(this)
      const originalClose = this.close
      t.mock.method(this, 'close', function(this: unknown, ...closeArgs: any[]) {
        count++
        return originalClose.apply(this, closeArgs)
      })
    }
    return originalStat.apply(this, args)
  })
  return () => count
}

describe('native tail range reads', () => {
  it('reads only the requested frame and applies the cap to actual input/allocation', async (t) => {
    const prefix = Buffer.alloc(1024 * 1024, 0)
    const file = await fixture('tail', Buffer.concat([prefix, last]))
    const calls: Array<{ position: number; length: number; bufferBytes: number; backingBytes: number; actual: number }> = []
    const original = (handlePrototype as { read: (...args: any[]) => Promise<any> }).read
    t.mock.method(handlePrototype, 'read', async function(this: unknown, ...args: any[]) {
      const result = await original.apply(this, args)
      calls.push({ position: args[3], length: args[2], bufferBytes: args[0].length,
        backingBytes: args[0].buffer.byteLength, actual: result.bytesRead })
      return result
    })
    const chunks: Buffer[] = []
    const stats = await nativeDecodeZstd(file, (out) => { chunks.push(out) }, {
      startOffset: prefix.length, maxCompressedBytes: last.length,
    })
    assert.equal(Buffer.concat(chunks).toString(), 'tail line\n')
    assert.equal(stats.discoveredBytes, prefix.length + last.length)
    assert.equal(stats.readBytes, last.length)
    assert.equal(stats.allocatedBytes, last.length)
    assert.equal(stats.deltaBytes, last.length)
    assert.equal(stats.decodedBytes, stats.bytes)
    assert.equal(stats.raced, false)
    assert.equal(calls.reduce((total, call) => total + call.actual, 0), last.length)
    assert.ok(calls.every((call) => call.position >= prefix.length
      && call.bufferBytes <= last.length && call.backingBytes <= last.length))
  })

  it('handles partial FileHandle reads without rereading a prefix', async (t) => {
    const file = await fixture('partial')
    const original = (handlePrototype as { read: (...args: any[]) => Promise<any> }).read
    const positions: number[] = []
    t.mock.method(handlePrototype, 'read', function(this: unknown, ...args: any[]) {
      positions.push(args[3])
      args[2] = Math.min(3, args[2])
      return original.apply(this, args)
    })
    const stats = await nativeDecodeZstd(file, () => {}, { startOffset: first.length })
    assert.equal(stats.readBytes, last.length)
    assert.deepEqual(positions, Array.from({ length: Math.ceil(last.length / 3) }, (_, i) => first.length + i * 3))
  })

  it('rejects an oversized tail before reading or allocating it', async (t) => {
    const file = await fixture('limited')
    const read = t.mock.method(handlePrototype, 'read')
    await assert.rejects(nativeDecodeZstd(file, () => {}, {
      startOffset: first.length, maxCompressedBytes: last.length - 1,
    }), /compressed range .* exceeds/)
    assert.equal(read.mock.callCount(), 0)
  })

  it('rejects invalid offsets before opening/reading', async (t) => {
    const read = t.mock.method(handlePrototype, 'read')
    for (const startOffset of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(nativeDecodeZstd(join(root, 'does-not-exist'), () => {}, { startOffset }), /startOffset/)
    }
    assert.equal(read.mock.callCount(), 0)
  })

  it('rejects a source already shorter than the delta offset with an observable race', async () => {
    const file = await fixture('short-source', last)
    await assert.rejects(nativeDecodeZstd(file, () => {}, { startOffset: last.length + 1 }), (error: unknown) => {
      assert.ok(error instanceof NativeZstdRaceError)
      assert.equal(error.raced, true)
      assert.equal(error.stats.readBytes, 0)
      assert.equal(error.stats.allocatedBytes, 0)
      assert.equal(error.stats.raced, true)
      return true
    })
  })

  it('rejects an offset inside a frame, empty range and malformed tail', async () => {
    const file = await fixture('boundary')
    for (const startOffset of [first.length + 1, first.length + last.length]) {
      await assert.rejects(nativeDecodeZstd(file, () => {}, { startOffset }), /frame header at expected offset/)
    }
  })

  it('detects shrink during reading and closes its handle', async (t) => {
    const file = await fixture('shrink')
    const original = (handlePrototype as { read: (...args: any[]) => Promise<any> }).read
    let changed = false
    t.mock.method(handlePrototype, 'read', async function(this: unknown, ...args: any[]) {
      if (!changed) {
        changed = true
        await truncate(file, first.length)
      }
      return original.apply(this, args)
    })
    const closeCount = observeClose(t)
    await assert.rejects(nativeDecodeZstd(file, () => {}, { startOffset: first.length }), NativeZstdRaceError)
    assert.equal(closeCount(), 1)
  })

  it('detects append during reading before emitting any decoded output', async (t) => {
    const file = await fixture('append')
    const original = (handlePrototype as { read: (...args: any[]) => Promise<any> }).read
    t.mock.method(handlePrototype, 'read', async function(this: unknown, ...args: any[]) {
      const result = await original.apply(this, args)
      await appendFile(file, last)
      return result
    })
    let emitted = false
    await assert.rejects(nativeDecodeZstd(file, () => { emitted = true }), (error: unknown) => {
      assert.ok(error instanceof NativeZstdRaceError)
      assert.equal(error.stats.readBytes, first.length + last.length)
      assert.equal(error.stats.decodedBytes, 0)
      return true
    })
    assert.equal(emitted, false)
  })

  it('detects source changes during sink processing', async () => {
    const file = await fixture('sink-race')
    let changed = false
    await assert.rejects(nativeDecodeZstd(file, () => {
      if (!changed) { changed = true; appendFileSync(file, last) }
    }), NativeZstdRaceError)
  })

  it('checks abort before reading, between reads and after sink, always closing an opened handle', async (t) => {
    const file = await fixture('abort')
    const pre = new AbortController()
    pre.abort()
    await assert.rejects(nativeDecodeZstd(file, () => {}, { signal: pre.signal }), { name: 'CancelError' })
    const controller = new AbortController()
    const original = (handlePrototype as { read: (...args: any[]) => Promise<any> }).read
    const read = t.mock.method(handlePrototype, 'read', async function(this: unknown, ...args: any[]) {
      args[2] = 3
      const result = await original.apply(this, args)
      controller.abort()
      return result
    })
    const closeCount = observeClose(t)
    await assert.rejects(nativeDecodeZstd(file, () => {}, { signal: controller.signal }), { name: 'CancelError' })
    assert.equal(closeCount(), 1)
    read.mock.restore()
    const atSink = new AbortController()
    await assert.rejects(nativeDecodeZstd(file, () => { atSink.abort() }, { signal: atSink.signal }), { name: 'CancelError' })
    assert.equal(closeCount(), 2)
  })

  it('closes on decode and sink errors', async (t) => {
    const file = await fixture('sink-error')
    const closeCount = observeClose(t)
    await assert.rejects(nativeDecodeZstd(file, () => { throw new Error('sink failed') }), /sink failed/)
    assert.equal(closeCount(), 1)
    const corrupt = await fixture('decode-error', ZSTD_MAGIC)
    await assert.rejects(nativeDecodeZstd(corrupt, () => {}), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error as Error & { stats: { readBytes: number } }).stats.readBytes, ZSTD_MAGIC.length)
      return true
    })
    assert.equal(closeCount(), 2)
  })

  it('retains multi-frame decode, early stop and full-read counter semantics', async () => {
    const file = await fixture('multiframe')
    const output: Buffer[] = []
    const stats = await nativeDecodeZstd(file, (out) => { output.push(out) })
    assert.equal(Buffer.concat(output).toString(), 'first line\ntail line\n')
    assert.equal(stats.frames, 2)
    assert.equal(stats.deltaBytes, 0)
    assert.equal(stats.readBytes, first.length + last.length)
    let calls = 0
    const stopped = await nativeDecodeZstd(file, () => { calls++; return false })
    assert.equal(calls, 1)
    assert.equal(stopped.stopped, true)
  })

  it('retains tail-frame integrity and total decompression limits', async () => {
    const truncated = await fixture('truncated', Buffer.concat([first, last.subarray(0, last.length - 1)]))
    await assert.rejects(nativeDecodeZstd(truncated, () => {}), /truncated|decode failed/)
    const file = await fixture('decompression-limit')
    await assert.rejects(nativeDecodeZstd(file, () => {}, { maxDecompressedBytes: 12 }), /decode failed|decompressed size/)
  })

  it('validates skippable lengths and skips embedded frame magic in their payload', () => {
    const skip = Buffer.alloc(12)
    skip.writeUInt32LE(0x184d2a50, 0)
    skip.writeUInt32LE(4, 4)
    ZSTD_MAGIC.copy(skip, 8)
    assert.deepEqual(splitFrames(Buffer.concat([skip, last])), [
      { start: 0, end: 12, skippable: true },
      { start: 12, end: 12 + last.length, skippable: false },
    ])
    assert.throws(() => splitFrames(skip.subarray(0, 4)), /header truncated/)
    assert.throws(() => splitFrames(skip.subarray(0, 9)), /frame truncated/)
  })
})
