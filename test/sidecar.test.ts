/**
 * sidecar.test.ts — JSONL 旁车公共层（C10 收敛）
 * 覆盖：per-path 互斥串行 / 追加落盘 / 原子写文本 / 指纹缓存命中与失效 /
 * 文件缺失与坏行 fallback。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withPathLock, withFileLock, appendLine, atomicWriteText, createFingerprintCache, isRecord, str, num } from '../src/sidecar.js'

describe('sidecar', () => {
  let dir = ''
  const mk = async (name: string): Promise<string> => {
    if (!dir) dir = await mkdtemp(join(tmpdir(), 'dsh-sidecar-'))
    return join(dir, name)
  }

  it('withPathLock：同路径串行、不同路径并行不互斥', async () => {
    const order: string[] = []
    const slow = withPathLock('/x', async () => {
      await new Promise((r) => setTimeout(r, 30))
      order.push('a')
      return 'a'
    })
    const fast = withPathLock('/x', async () => {
      order.push('b')
      return 'b'
    })
    const other = withPathLock('/y', async () => {
      order.push('y')
      return 'y'
    })
    assert.equal(await slow, 'a')
    assert.equal(await fast, 'b')
    assert.equal(await other, 'y')
    // 同路径按调用序串行（a 先于 b，尽管 a 内部 sleep 30ms）
    assert.ok(order.indexOf('a') < order.indexOf('b'), `同路径应串行，实际 ${JSON.stringify(order)}`)
    // 不同路径不被 /x 阻塞：/y 的回调同步段立即执行，必然排在 a 之前
    assert.equal(order[0], 'y', `/y 不应被 /x 阻塞，实际 ${JSON.stringify(order)}`)
  })

  it('appendLine：追加并落盘（fsync 后可读）', async () => {
    const p = await mk('append.jsonl')
    await appendLine(p, JSON.stringify({ v: 1, a: 1 }))
    await appendLine(p, JSON.stringify({ v: 1, a: 2 }))
    const text = await readFile(p, 'utf8')
    assert.equal(text.trim().split('\n').length, 2)
    assert.ok(text.includes('"a":2'))
  })

  it('atomicWriteText：覆盖写 + 无 tmp 残留', async () => {
    const p = await mk('atomic.jsonl')
    await writeFile(p, 'old\n')
    await atomicWriteText(p, 'new')
    assert.equal(await readFile(p, 'utf8'), 'new')
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(dir)
    assert.ok(!names.some((n) => n.includes('.tmp.')), `不应残留 tmp：${names.join(',')}`)
  })

  it('createFingerprintCache：命中同值、变更后重解析、缺失走 fallback', async () => {
    const p = await mk('cache.jsonl')
    await writeFile(p, 'a\nb\n')
    let parses = 0
    const cache = createFingerprintCache<string[]>()
    const parse = (text: string): string[] => {
      parses++
      return text.trim().split('\n')
    }
    const v1 = await cache.read(p, parse, () => [])
    assert.deepEqual(v1, ['a', 'b'])
    assert.equal(parses, 1)
    const v2 = await cache.read(p, parse, () => []) // 同指纹 → 不重解析
    assert.equal(v2, v1)
    assert.equal(parses, 1)
    // 变更内容 + mtime/size → 重解析（先写更长内容，确保指纹变化）
    await writeFile(p, 'a\nb\nc\nd\n')
    const st = await stat(p)
    assert.ok(st.size > 0)
    const v3 = await cache.read(p, parse, () => [])
    assert.equal(parses, 2)
    assert.equal(v3.length, 4)
    // 文件缺失 → fallback + 清缓存
    await rm(p, { force: true })
    const v4 = await cache.read(p, parse, () => ['fallback'])
    assert.deepEqual(v4, ['fallback'])
  })

  it('校验守卫：isRecord/str/num', () => {
    assert.equal(isRecord({}), true)
    assert.equal(isRecord(null), false)
    assert.equal(isRecord('x'), false)
    assert.equal(str('a'), 'a')
    assert.equal(str(1), null)
    assert.equal(num(1.5), 1.5)
    assert.equal(num(Number.NaN), null)
    assert.equal(num('1'), null)
  })

  it('withFileLock：同进程等待也有界；失败回调释放 owner', async () => {
    const p = await mk('file-lock.jsonl')
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((done) => { entered = done })
    const owner = withFileLock(p, async () => {
      entered()
      await new Promise<void>((done) => { release = done })
    })
    await held
    await assert.rejects(withFileLock(p, async () => assert.fail('must wait'), { timeoutMs: 40, retryMs: 5 }),
      (error: any) => error.code === 'ELOCKTIMEOUT')
    release()
    await owner
    await assert.rejects(withFileLock(p, async () => { throw new Error('callback-failed') }), /callback-failed/)
    assert.equal(await withFileLock(p, async () => 'next'), 'next')
  })

  it('strict 指纹缓存仅 ENOENT fallback，读取错误向上传播', async () => {
    const p = await mk('strict-cache-dir')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(p)
    const cache = createFingerprintCache<string>({ strictErrors: true })
    await assert.rejects(cache.read(p, (text) => text, () => 'empty'), (error: any) => error.code === 'EISDIR')
    assert.equal(await cache.read(join(p, 'missing'), (text) => text, () => 'missing'), 'missing')
  })

  it('空锁目录可恢复；不可识别的 owner 保留且给出明确诊断', async () => {
    const p = await mk('recover-lock.jsonl')
    const { mkdir, readdir } = await import('node:fs/promises')
    const lock = `${process.platform === 'win32' ? p.toLowerCase() : p}.lock`
    await mkdir(lock)
    assert.equal(await withFileLock(p, async () => 'recovered'), 'recovered')
    await mkdir(lock)
    await writeFile(join(lock, 'broken-owner'), 'bad')
    await assert.rejects(withFileLock(p, async () => assert.fail('invalid owner'), { timeoutMs: 100 }),
      (error: any) => error.code === 'ELOCKCORRUPT')
    assert.deepEqual(await readdir(lock), ['broken-owner'])
  })
})
