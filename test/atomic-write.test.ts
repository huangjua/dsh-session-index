/**
 * atomic-write.test.ts — 原子提交 + stale tmp 清理 + run-marker
 * 对应 compression_tests.rs 的 marker 抢占 / 陈旧 marker / no-clobber 语义
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, readdir, rm, utimes, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteJson, cleanupStaleTemps, RunMarker } from '../src/atomic-write.js'

describe('atomicWriteJson', () => {
  let dir = ''

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-atomic-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('写入合法 JSON，无 .tmp 残留', async () => {
    const file = join(dir, 'index.json')
    await atomicWriteJson(file, { version: 1, sessions: [{ id: 'a' }] })
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(parsed.version, 1)
    assert.equal(parsed.sessions[0].id, 'a')
    const names = await readdir(dir)
    assert.ok(!names.some((n) => n.includes('.tmp.')))
  })

  it('覆盖已有文件（rename 原子替换）', async () => {
    const file = join(dir, 'over.json')
    await atomicWriteJson(file, { v: 1 })
    await atomicWriteJson(file, { v: 2 })
    assert.equal(JSON.parse(await readFile(file, 'utf8')).v, 2)
  })

  it('validate 失败 → 抛错且旧文件不变、无 tmp 残留', async () => {
    const file = join(dir, 'keep.json')
    await atomicWriteJson(file, { version: 1, sessions: [] })
    await assert.rejects(
      atomicWriteJson(file, { version: 2, sessions: [] }, { validate: (t) => JSON.parse(t).version === 1 }),
    )
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1)
    const names = await readdir(dir)
    assert.ok(!names.some((n) => n.includes('.tmp.')))
  })

  it('backup 选项：.bak 随每次提交滚动（保存上一次版本，C4）', async () => {
    const file = join(dir, 'bak.json')
    // 第 1 次写：无旧文件可备份 → 不产生 .bak（ENOENT 被忽略）
    await atomicWriteJson(file, { v: 1 }, { backup: true })
    await assert.rejects(stat(`${file}.bak`))
    // 第 2 次写：备份发生在 rename 前 → .bak = 旧版本 v1，file = 新版本 v2
    await atomicWriteJson(file, { v: 2 }, { backup: true })
    assert.equal(JSON.parse(await readFile(`${file}.bak`, 'utf8')).v, 1)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).v, 2)
    // 第 3 次写：.bak 滚动到 v2（旧实现此处仍是 v1——EEXIST 被吞，永不更新）
    await atomicWriteJson(file, { v: 3 }, { backup: true })
    assert.equal(JSON.parse(await readFile(`${file}.bak`, 'utf8')).v, 2)
    assert.equal(JSON.parse(await readFile(file, 'utf8')).v, 3)
  })
})

describe('cleanupStaleTemps', () => {
  let dir = ''

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tmp-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('只删匹配且陈旧的临时文件', async () => {
    const old = join(dir, 'index.json.tmp.1.0')
    const fresh = join(dir, 'index.json.tmp.2.0')
    const other = join(dir, 'unrelated.txt')
    await writeFile(old, 'x')
    await writeFile(fresh, 'x')
    await writeFile(other, 'x')
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await utimes(old, past, past)
    const removed = await cleanupStaleTemps(dir, {
      match: /\.tmp\.\d+\.\d+$/,
      maxAgeMs: 24 * 60 * 60 * 1000,
    })
    assert.equal(removed, 1)
    const names = await readdir(dir)
    assert.ok(!names.includes('index.json.tmp.1.0'))
    assert.ok(names.includes('index.json.tmp.2.0'))
    assert.ok(names.includes('unrelated.txt'))
  })

  it('目录不存在 → 返回 0', async () => {
    assert.equal(await cleanupStaleTemps(join(dir, 'nope')), 0)
  })
})

describe('RunMarker', () => {
  let dir = ''

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-marker-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('首个抢占成功，第二个拿不到（并发防重）', async () => {
    const file = join(dir, 'build.lock')
    const m1 = await RunMarker.acquire(file)
    assert.ok(m1)
    const m2 = await RunMarker.acquire(file)
    assert.equal(m2, null)
    await m1!.release()
    const m3 = await RunMarker.acquire(file)
    assert.ok(m3)
    await m3!.release()
  })

  it('陈旧 marker 被抢占（>15min）', async () => {
    const file = join(dir, 'stale.lock')
    const m1 = await RunMarker.acquire(file)
    assert.ok(m1)
    // 模拟崩溃进程留下的陈旧 marker：不 release，直接改旧 mtime
    const past = new Date(Date.now() - 20 * 60 * 1000)
    await utimes(file, past, past)
    const m2 = await RunMarker.acquire(file, 15 * 60 * 1000)
    assert.ok(m2, '陈旧 marker 应被抢占')
    await m2!.release()
  })

  it('release 幂等且删除文件', async () => {
    const file = join(dir, 'rel.lock')
    const m = await RunMarker.acquire(file)
    await m!.release()
    await m!.release()
    await assert.rejects(stat(file))
  })

  it('release 校验所有权：marker 已被他人（不同 pid）抢占时不误删（P2-10）', async () => {
    const file = join(dir, 'own.lock')
    const m = await RunMarker.acquire(file)
    assert.ok(m)
    // 模拟超时后被另一进程（不同 pid）抢占：改写内容
    await writeFile(file, 'pid=999999 started_at=2026-08-16T00:00:00.000Z\n')
    await m!.release()
    // 不是自己的 marker → 不得删除
    const content = await readFile(file, 'utf8')
    assert.match(content, /pid=999999/)
    await rm(file, { force: true })
  })

  it('marker 内容含 pid + started_at', async () => {
    const file = join(dir, 'content.lock')
    const m = await RunMarker.acquire(file)
    const content = await readFile(file, 'utf8')
    assert.match(content, /pid=\d+/)
    assert.match(content, /started_at=/)
    await m!.release()
  })
})
