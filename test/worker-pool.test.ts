/**
 * worker-pool.test.ts — 有界 worker 池 + mapLimit
 * 覆盖：worker/inline 双路径、错误隔离、并发上限、取消、池终止
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { zstdCompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerPool, mapLimit } from '../src/worker-pool.js'
import { isCancelError } from '../src/cancel.js'
import type { HeadSummary, FullSummary, SearchHit } from '../src/streaming-parser.js'

const SAMPLE = fileURLToPath(new URL('../../test/fixtures/sample-session.jsonl.zstd', import.meta.url))
const SAMPLE_JSONL = fileURLToPath(new URL('../../test/fixtures/sample-session.jsonl', import.meta.url))
const CORRUPT = fileURLToPath(new URL('../../test/fixtures/corrupt-session.jsonl.zstd', import.meta.url))
const WORKER_URL = new URL('../src/session-worker.js', import.meta.url)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 临时生成合法 alpha.3 多帧日志；旧 big 夹具会在每帧重置 seq，不能用于兼容测试。 */
async function createLargeAlpha3Log(frameCount = 100): Promise<{ dir: string; file: string }> {
  const [header, ...eventLines] = (await readFile(SAMPLE_JSONL, 'utf8')).trim().split(/\r?\n/)
  const events = eventLines.map((line) => JSON.parse(line) as { seq: number; time: number })
  const frames = [zstdCompressSync(Buffer.from(`${header}\n`, 'utf8'))]
  for (let frame = 0; frame < frameCount; frame++) {
    const seqOffset = frame * events.length
    const timeOffset = frame * 100_000
    frames.push(zstdCompressSync(Buffer.from(events
      .map((event) => JSON.stringify({ ...event, seq: event.seq + seqOffset, time: event.time + timeOffset }))
      .join('\n') + '\n', 'utf8')))
  }
  const dir = await mkdtemp(join(tmpdir(), 'dsh-worker-alpha3-'))
  const file = join(dir, 'large.jsonl.zstd')
  await writeFile(file, Buffer.concat(frames))
  return { dir, file }
}

describe('WorkerPool（worker_threads 路径）', () => {
  it('head 任务：worker 解析返回元数据', async () => {
    const pool = new WorkerPool({ workerUrl: WORKER_URL, size: 2 })
    try {
      const r = await pool.run<HeadSummary>({ mode: 'head', file: SAMPLE })
      assert.equal(r.ok, true)
      if (r.ok) {
        assert.equal(r.data.id, 'session-2ed36ab1-3693-4ecd-9724-3f8af2ee8450')
        assert.equal(r.data.cwd, 'E:\\Do\\test')
      }
    } finally {
      pool.terminate()
    }
  })

  it('错误隔离：损坏文件 → ok:false，池继续可用', async () => {
    const pool = new WorkerPool({ workerUrl: WORKER_URL, size: 2 })
    try {
      const bad = await pool.run({ mode: 'full', file: CORRUPT })
      assert.equal(bad.ok, false)
      if (!bad.ok) assert.ok(bad.error.length > 0)
      const good = await pool.run({ mode: 'full', file: SAMPLE })
      assert.equal(good.ok, true)
    } finally {
      pool.terminate()
    }
  })

  it('并发上限：size=2，6 个任务全部完成', async () => {
    const pool = new WorkerPool({ workerUrl: WORKER_URL, size: 2 })
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          pool.run({ mode: 'search', file: SAMPLE, query: 'gemini', maxSnippets: 1 }),
        ),
      )
      assert.equal(results.filter((r) => r.ok).length, 6)
    } finally {
      pool.terminate()
    }
  })

  it('search 任务返回命中', async () => {
    const pool = new WorkerPool({ workerUrl: WORKER_URL, size: 2 })
    try {
      const r = await pool.run<SearchHit[]>({ mode: 'search', file: SAMPLE, query: 'gemini-code', maxSnippets: 3 })
      assert.equal(r.ok, true)
      if (r.ok) {
        assert.ok(Array.isArray(r.data))
        assert.ok(r.data.length >= 1)
        assert.equal(r.data[0].type, 'user/message')
      }
    } finally {
      pool.terminate()
    }
  })

  it('已中止的 signal → 立即 CancelError', async () => {
    const pool = new WorkerPool({ workerUrl: WORKER_URL, size: 1 })
    try {
      const ac = new AbortController()
      ac.abort()
      await assert.rejects(pool.run({ mode: 'full', file: SAMPLE }, ac.signal), (e) => isCancelError(e))
    } finally {
      pool.terminate()
    }
  })

  it('terminate 后 run 被拒绝', async () => {
    const pool = new WorkerPool({ workerUrl: WORKER_URL, size: 1 })
    pool.terminate()
    await assert.rejects(pool.run({ mode: 'full', file: SAMPLE }))
  })

  it('terminate 时在飞任务被 reject（P1-4：不留永久 pending）', async () => {
    const pool = new WorkerPool({ workerUrl: WORKER_URL, size: 1 })
    const large = await createLargeAlpha3Log()
    try {
      const running = pool.run({ mode: 'full', file: large.file })
      await sleep(120) // 等任务派发到 worker（big 解析 ~秒级，肯定在飞）
      pool.terminate()
      await assert.rejects(running, (e) => isCancelError(e))
    } finally {
      pool.terminate()
      await rm(large.dir, { recursive: true, force: true })
    }
  })

  it('inline 回退有界并发 ≤2（P1-3：不得全量同时派发卡死主线程）', async () => {
    const pool = new WorkerPool({ workerUrl: null, size: 4 })
    const large = await createLargeAlpha3Log()
    try {
      const runs = Array.from({ length: 6 }, () => pool.run({ mode: 'full', file: large.file }))
      let maxSeen = 0
      const t0 = Date.now()
      while (Date.now() - t0 < 8000) {
        maxSeen = Math.max(maxSeen, pool.inlineInFlight)
        if (maxSeen >= 2) break
        await sleep(10)
      }
      const results = await Promise.all(runs)
      assert.ok(maxSeen >= 1, `maxSeen=${maxSeen}`)
      assert.ok(maxSeen <= 2, `inline 并发超限: ${maxSeen}`)
      assert.equal(results.filter((r) => r.ok).length, 6)
    } finally {
      pool.terminate()
      await rm(large.dir, { recursive: true, force: true })
    }
  })
})

describe('WorkerPool（inline 回退路径）', () => {
  it('workerUrl=null → 纯 inline，结果一致', async () => {
    const pool = new WorkerPool({ workerUrl: null, size: 2 })
    try {
      const r = await pool.run<FullSummary>({ mode: 'full', file: SAMPLE })
      assert.equal(r.ok, true)
      if (r.ok) {
        assert.equal(r.data.id, 'session-2ed36ab1-3693-4ecd-9724-3f8af2ee8450')
        assert.ok(r.data.counts['user/message'] > 0)
      }
    } finally {
      pool.terminate()
    }
  })

  it('inline 错误隔离 + 取消', async () => {
    const pool = new WorkerPool({ workerUrl: null, size: 2 })
    try {
      const bad = await pool.run({ mode: 'full', file: CORRUPT })
      assert.equal(bad.ok, false)
      const ac = new AbortController()
      ac.abort()
      await assert.rejects(pool.run({ mode: 'full', file: SAMPLE }, ac.signal), (e) => isCancelError(e))
    } finally {
      pool.terminate()
    }
  })
})

describe('mapLimit', () => {
  it('并发上限正确且结果保序', async () => {
    let active = 0
    let maxActive = 0
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (x) => {
      active++
      maxActive = Math.max(maxActive, active)
      await sleep(10)
      active--
      return x * 2
    })
    assert.deepEqual(out, [2, 4, 6, 8, 10])
    assert.equal(maxActive, 2)
  })

  it('取消后不再调度新任务', async () => {
    const ac = new AbortController()
    // 8ms 后从外部中止；worker 每个 20ms——保证中止时最多 2 个在跑
    const timer = setTimeout(() => ac.abort(), 8)
    let started = 0
    const out = await mapLimit(
      [1, 2, 3, 4, 5, 6, 7, 8],
      2,
      async (x) => {
        started++
        await sleep(20)
        return x
      },
      ac.signal,
    )
    clearTimeout(timer)
    assert.ok(started <= 2, `started=${started}`)
    assert.equal(out[0], 1)
    assert.equal(out[1], 2)
    assert.equal(out[2], undefined) // 未启动的槽位保持空洞/undefined
  })
})
