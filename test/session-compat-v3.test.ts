/**
 * session-compat-v3.test.ts — DSH 0.1.5-rc.1（会话格式 v3）读取回归。
 *
 * 主夹具 v3-session.jsonl.zstd 是**写入端产物**：取一个真实 v0 会话
 * （anchored-router 冒烟，5KB），用 DSH 0.1.5-rc.1 自带的 restore+migrate
 * 链（@deepseek-ai/dsh-session-format-catalog，recovery=strict、
 * validation=current）迁移到 v3 后原样落盘——不是手写的 v3 形状。生成命令：
 *
 *   node _probe/dsh-0.1.5-rc.1/tools/migrate-to-v3.mjs <v0 session> <out.jsonl.zstd>
 *
 * 它覆盖 v3 相对 v0 的全部结构差异：闭合 header（isSeeded/delegationDepth）、
 * 无 packed chunk 行、system/message 作为第四种 surface 类型（append +
 * startSeq/endSeq 替换）、tool/call + tool/result 流。
 *
 * 另外锁定：现代词表守卫（未知必拒 / ignorable 放行）、v2 的 start/end 替换
 * 编码、以及扫描端的代际优先级（同一会话目录只收最高代际）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { zstdCompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFull, parseHead, parseSearch } from '../src/streaming-parser.js'
import { scanSessionFiles } from '../src/core.js'
import {
  SessionCompatibilityError,
  SessionLogCompatibility,
  textFromCompatibleMessage,
} from '../src/session-compat.js'
import {
  modernDispatch,
  modernJsonl,
  modernSystem,
  modernToolCall,
  modernToolResult,
  modernUser,
  type ModernEvent,
} from './support/modern-log.js'

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url))

const V3_SESSION = fixture('v3-session.jsonl.zstd')
const CREATED_AT = 1_786_791_585_325

let root = ''

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-v3-compat-'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeZstd(path: string, lines: string[]): Promise<void> {
  await writeFile(path, zstdCompressSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')))
}

function consume(lines: string[]): SessionLogCompatibility {
  const compat = new SessionLogCompatibility()
  for (const line of lines) compat.consumeLine(JSON.parse(line))
  return compat
}

describe('v3 真实迁移夹具（写入端产物）', () => {
  it('parseHead / parseFull 读出 v3 头部与派生字段', async () => {
    const head = await parseHead(V3_SESSION)
    assert.equal(head.compatibility, 'v3')
    assert.equal(head.id, 'session-5cad04e5-b2fb-4c96-ad6a-def4d13bcb9f')
    assert.equal(head.createdAt, 1786791585325)
    assert.equal(head.title, 'Check dev router status output')
    assert.equal(head.agentPreset, 'router-standard')
    assert.match(head.firstUserText, /^First call the bash tool with command/)

    const full = await parseFull(V3_SESSION, { collectMessages: true })
    assert.equal(full.compatibility, 'v3')
    assert.equal(full.events, 21)
    assert.equal(full.lastTime, 1786792434181)
    assert.deepEqual(full.toolCallCounts, { bash: 1 })
    // system/message 计进 counts，但不出现在可检索文本里
    assert.equal(full.counts['system/message'], 2)
    assert.equal(full.counts['assistant/message'], 1)
    assert.equal(full.counts['tool/result'], 1)
    assert.ok(!('assistant/chunk' in full.counts), 'v3 不应再有 assistant/chunk')
    assert.ok(!('text-chunks' in full.counts), 'v3 不应再有 packed chunk 行')
    assert.equal(full.lastAssistantText, "I'll start by calling the bash tool as instructed.")
  })

  it('surface 折叠跟随 system/message 替换（startSeq/endSeq），消息流不含 system', async () => {
    const full = await parseFull(V3_SESSION, { collectMessages: true })
    const roles = (full.messages ?? []).map(message => message.role)
    assert.deepEqual(roles, ['user', 'assistant', 'tool'])
    const user = (full.messages ?? []).find(message => message.role === 'user')
    assert.match(String(user?.text), /anchored-ok/)
  })

  it('parseSearch 在 v3 正文上命中', async () => {
    const hits = await parseSearch(V3_SESSION, 'anchored-ok')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.role, 'user')
    assert.match(String(hits[0]?.snippet), />>>anchored-ok<<</)
  })
})

describe('现代词表与合并规则', () => {
  it('ptc-dispatch（v3 重命名后的 run_code 追踪）按 log-only 接受', () => {
    const lines = modernJsonl({
      id: 'v3-ptc', createdAt: CREATED_AT,
      events: [modernUser('hi', 'u1'), modernDispatch(true, CREATED_AT + 1), modernDispatch(false, CREATED_AT + 2)],
    })
    const compat = consume(lines)
    assert.equal(compat.version, 'v3')
    assert.equal(compat.generation, 3)
    assert.deepEqual(compat.finish().map(message => message.type), ['user/message'])
  })

  it('未知且未标 ignorable 的事件拒绝整个文件；标了 ignorable 则跳过', () => {
    const unknown: ModernEvent = { type: 'plugin/telemetry', data: { sample: true } }
    const rejected = modernJsonl({ id: 'v3-unknown', createdAt: CREATED_AT, events: [modernUser('hi', 'u1'), unknown] })
    assert.throws(() => consume(rejected), /unknown required event type "plugin\/telemetry" at seq 1/)

    const tolerated = modernJsonl({
      id: 'v3-ignorable', createdAt: CREATED_AT,
      events: [modernUser('hi', 'u1'), { ...unknown, ignorable: true }],
    })
    const compat = consume(tolerated)
    assert.deepEqual(compat.finish().map(message => message.type), ['user/message'])
  })

  it('非 surface 事件携带 surfaceOp 仍拒绝（不允许偷偷进入模型可见表面）', () => {
    const lines = modernJsonl({
      id: 'v3-smuggler', createdAt: CREATED_AT,
      events: [modernUser('hi', 'u1'), { type: 'tool/call', data: {}, surfaceOp: 'append' } as ModernEvent],
    })
    assert.throws(() => consume(lines), /non-surface event "tool\/call" carries surface metadata/)
  })

  it('v3 把 system/message 计入 surface：替换必须命中已折叠节点，正文不参与索引', () => {
    const lines = modernJsonl({
      id: 'v3-system', createdAt: CREATED_AT,
      events: [
        modernSystem('prompt v1', 'sys-1'),
        modernUser('hello', 'u1'),
        // 替换必须引用被遮蔽的节点（v3 的 surface 溯源规则，两侧一致）
        { ...modernSystem('prompt v2', 'sys-2', undefined, { op: 'replace', startSeq: 0, endSeq: 0 }), sourceEventSeqs: [0] },
      ],
    })
    const compat = consume(lines)
    const surface = compat.finish()
    assert.deepEqual(surface.map(message => message.type), ['system/message', 'user/message'])
    assert.equal(surface[0]?.seq, 2)
    assert.equal(textFromCompatibleMessage(surface[0]!), '')
  })

  it('v2 的 {op:replace,start,end} 编码同样接受，并报告 v2', () => {
    const lines = modernJsonl({
      id: 'v2-replace', createdAt: CREATED_AT, version: 2,
      events: [
        modernUser('first', 'u1'),
        { ...modernUser('second', 'u2', undefined, { op: 'replace', start: 0, end: 0 }), sourceEventSeqs: [0] },
      ],
    })
    const compat = consume(lines)
    assert.equal(compat.version, 'v2')
    assert.equal(compat.generation, 2)
    const surface = compat.finish()
    assert.equal(surface.length, 1)
    assert.equal(surface[0]?.seq, 1)
  })

  it('tool/result 仍以 role=user + source.kind=tool 的写入端形态接受', () => {
    const lines = modernJsonl({
      id: 'v3-tool', createdAt: CREATED_AT,
      events: [modernUser('run', 'u1'), modernToolCall('call_1', 'bash'), modernToolResult('call_1', 'ok', 1)],
    })
    const compat = consume(lines)
    assert.deepEqual(compat.finish().map(message => message.type), ['user/message', 'tool/result'])
  })

  it('v3 头部要求 isSeeded/delegationDepth 且键集闭合', () => {
    const missing = modernJsonl({ id: 'v3-header', createdAt: CREATED_AT, events: [modernUser('hi', 'u1')] })
    missing[0] = JSON.stringify({ type: 'session', version: 3, id: 'v3-header', createdAt: CREATED_AT, agentPreset: 'ptc' })
    assert.throws(() => consume(missing), /unsupported or malformed v3 session header/)

    const extra = modernJsonl({ id: 'v3-header2', createdAt: CREATED_AT, events: [modernUser('hi', 'u1')] })
    extra[0] = JSON.stringify({ ...JSON.parse(extra[0]!), seedLength: 3 })
    assert.throws(() => consume(extra), /unsupported or malformed v3 session header/)
  })

  it('v0 头部照旧走 legacy 路径（同一条读取器）', () => {
    const lines = [
      JSON.stringify({ type: 'session', version: 0, id: 'legacy', createdAt: CREATED_AT, cwd: 'E:\\x', delegationDepth: 0, agentPreset: 'standard' }),
      JSON.stringify({
        type: 'user/message', seq: 0, time: CREATED_AT, surfaceOp: 'append',
        data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'legacy' }] },
      }),
    ]
    const compat = consume(lines)
    assert.equal(compat.version, 'alpha3')
    assert.equal(compat.generation, 0)
    assert.equal(compat.finish().length, 1)
  })

  it('seeded（子会话/fork）v3 日志：isSeeded + inherited end-seed 被接受', () => {
    const lines = modernJsonl({
      id: 'v3-seeded', createdAt: CREATED_AT, isSeeded: true, delegationDepth: 1,
      events: [
        modernUser('inherited prefix', 'u1'),
        { type: 'session/end-seed', data: { inherited: true } },
        modernUser('own turn', 'u2'),
      ],
    })
    const compat = consume(lines)
    assert.equal(compat.version, 'v3')
    assert.equal(compat.header.id, 'v3-seeded')
    assert.equal(compat.finish().length, 2)
  })
})

describe('扫描端代际优先级', () => {
  it('同一会话目录只收最高代际，非规范名不受影响', async () => {
    const sessionsRoot = join(root, 'sessions')
    const dirA = join(sessionsRoot, 'proj-a', 'session-1')
    const dirB = join(sessionsRoot, 'proj-b', 'session-2')
    const dirC = join(sessionsRoot, 'proj-c', 'session-3')
    await mkdir(dirA, { recursive: true })
    await mkdir(dirB, { recursive: true })
    await mkdir(dirC, { recursive: true })

    // 升级前遗留的 v0 代际（session.jsonl.zstd）与迁移后的 v3 代际并存
    const stale = [
      JSON.stringify({ type: 'session', version: 0, id: 'a', createdAt: CREATED_AT, cwd: 'E:\\x', delegationDepth: 0, agentPreset: 'standard' }),
      JSON.stringify({
        type: 'user/message', seq: 0, time: CREATED_AT, surfaceOp: 'append',
        data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'stale' }] },
      }),
    ]
    await writeZstd(join(dirA, 'session.jsonl.zstd'), stale)
    await writeZstd(join(dirA, 'session.v3.jsonl.zstd'), modernJsonl({
      id: 'a', createdAt: CREATED_AT, events: [modernUser('new', 'u1')],
    }))
    await writeZstd(join(dirB, 'session.v2.jsonl.zstd'), modernJsonl({
      id: 'b', createdAt: CREATED_AT, version: 2, events: [modernUser('v2', 'u1')],
    }))
    await writeZstd(join(dirC, 'handmade.jsonl.zstd'), modernJsonl({
      id: 'c', createdAt: CREATED_AT, events: [modernUser('handmade', 'u1')],
    }))

    const { files } = await scanSessionFiles(sessionsRoot)
    const names = files.map(file => file.file.replace(/\\/g, '/').split('/').slice(-2).join('/'))
    assert.deepEqual(names.sort(), [
      'session-1/session.v3.jsonl.zstd',
      'session-2/session.v2.jsonl.zstd',
      'session-3/handmade.jsonl.zstd',
    ])
  })
})
