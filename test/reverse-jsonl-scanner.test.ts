/**
 * reverse-jsonl-scanner.test.ts — 从尾向头扫描 JSONL
 * 翻译自 codex reverse_jsonl_scanner_tests.rs 语义：
 * 分块边界、空行、坏 JSON、超长记录、EOF 无换行、冻结窗口
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReverseJsonlScanner } from '../src/reverse-jsonl-scanner.js'

const text = `{"id":1}\n{"id":2}\n\n{"id":3}\n{"id":4}`
const records = [{ id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }]

describe('ReverseJsonlScanner', () => {
  let dir = ''

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-scanner-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function scan(content: string, maxRecordBytes?: number, endByteOffset?: number): Promise<unknown[]> {
    const file = join(dir, `f-${Math.random().toString(36).slice(2)}.jsonl`)
    await writeFile(file, content)
    const fh = await open(file, 'r')
    const end = endByteOffset ?? (await fh.stat()).size
    const scanner = await ReverseJsonlScanner.newAt(fh, end, { maxRecordBytes })
    const out: unknown[] = []
    for (;;) {
      const r = await scanner.scanNext((s) => JSON.parse(s))
      if (r === null) break
      if (r.outcome === 'parsed') out.push(r.value)
      else out.push({ rejected: r.error.message })
    }
    await scanner.close()
    return out
  }

  it('从尾部逆序返回全部记录（含 EOF 无换行）', async () => {
    assert.deepEqual(await scan(text), records)
  })

  it('空行跳过', async () => {
    const out = await scan('{"id":1}\n\n\n{"id":2}\n\n')
    assert.deepEqual(out, [{ id: 2 }, { id: 1 }])
  })

  it('坏 JSON 记为 rejected 且扫描继续', async () => {
    const out = await scan('{"id":1}\nnot-json\n{"id":2}\n')
    assert.equal(out.length, 3)
    assert.deepEqual(out[0], { id: 2 })
    assert.match((out[1] as { rejected: string }).rejected, /Unexpected token/)
    assert.deepEqual(out[2], { id: 1 })
  })

  it('超长记录直接丢弃不解析', async () => {
    const long = `{"id":1,"pad":"${'x'.repeat(5000)}"}`
    const out = await scan(`{"id":2}\n${long}\n{"id":3}\n`, 1024)
    assert.deepEqual(out, [{ id: 3 }, { id: 2 }])
  })

  it('分块边界（64KB 边界跨越）', async () => {
    const pad = 'y'.repeat(64 * 1024 - 10)
    const content = `{"id":1}\n{"pad":"${pad}","id":2}\n{"id":3}\n`
    const out = await scan(content)
    assert.equal(out.length, 3)
    assert.equal((out[0] as { id: number }).id, 3)
    assert.equal((out[1] as { id: number }).id, 2)
    assert.equal((out[2] as { id: number }).id, 1)
  })

  it('new_at 冻结窗口：只扫描 endByteOffset 之前的内容', async () => {
    const file = join(dir, 'frozen.jsonl')
    const head = '{"id":1}\n{"id":2}\n'
    const tail = '{"id":3}\n{"id":4}\n'
    await writeFile(file, head + tail)
    const fh = await open(file, 'r')
    const scanner = await ReverseJsonlScanner.newAt(fh, Buffer.byteLength(head))
    const out: unknown[] = []
    for (;;) {
      const r = await scanner.scanNext((s) => JSON.parse(s))
      if (r === null) break
      if (r.outcome === 'parsed') out.push(r.value)
    }
    await scanner.close()
    assert.deepEqual(out, [{ id: 2 }, { id: 1 }])
  })

  it('new_at 终点超过文件长度 → 报错', async () => {
    const file = join(dir, 'past.jsonl')
    await writeFile(file, '{"id":1}\n')
    const fh = await open(file, 'r')
    await assert.rejects(ReverseJsonlScanner.newAt(fh, 9999), RangeError)
    await fh.close()
  })
})
