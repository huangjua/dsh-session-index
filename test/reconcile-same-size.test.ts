import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { SessionIndexBuilder } from '../src/session-index-builder.js'
import { loadIndex } from '../src/core.js'
import { alpha3Assistant, alpha3Jsonl } from './support/alpha3-log.js'

it('S1.4 同大小正文改写由指纹自动重解析，不能使用 EOF 空 delta 固化旧正文', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-same-size-'))
  const root = join(base, 'sessions')
  const file = join(root, 'session-same-size', 'session.jsonl.zstd')
  const indexFile = join(base, 'data', 'index.json')
  const ts = Date.now()
  const encode = (value: string) => {
    const rows = alpha3Jsonl({ id: 'same-size', createdAt: ts, events: [alpha3Assistant(value, 'a1', ts)] })
    // Fastest level emits these short logs as raw blocks, keeping fixture size
    // independent of Huffman symbol choices while retaining a valid Zstd file.
    return zstdCompressSync(Buffer.from(rows.join('\n') + '\n'), {
      params: { [constants.ZSTD_c_compressionLevel]: -131072 },
    })
  }
  const oldText = 'AAAAAAAAAAAA'
  const newText = 'BBBBBBBBBBBB'
  const oldBytes = encode(oldText)
  const newBytes = encode(newText)
  assert.equal(newBytes.length, oldBytes.length, '精确等大小重写 fixture')
  const builder = new SessionIndexBuilder({ root, indexFile, poolSize: 1 })
  try {
    await mkdir(join(root, 'session-same-size'), { recursive: true })
    await writeFile(file, oldBytes)
    assert.equal((await builder.build({ retentionDays: 0 })).status, 'completed')
    assert.equal(loadIndex(indexFile)!.sessions[0].lastAssistantText, oldText)
    await writeFile(file, newBytes)
    await utimes(file, new Date(ts + 5000), new Date(ts + 5000))
    const report = await builder.build({ retentionDays: 0 })
    assert.equal(report.status, 'completed')
    assert.equal(report.deltaParsed, 0, '指纹变化且零新增字节必须从头解析')
    assert.equal(report.fullParsed, 1)
    assert.equal(loadIndex(indexFile)!.sessions[0].lastAssistantText, newText)
    const stable = await builder.build({ retentionDays: 0 })
    assert.equal(stable.fullParsed, 0, '成功改写后收敛，不重复解析')
  } finally {
    builder.dispose()
    await rm(base, { recursive: true, force: true })
  }
})
