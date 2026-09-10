/**
 * session-compat-regression.test.ts — 2026-09-10 全量解析回归的三根因锁定。
 *
 * 背景：alpha.3 兼容门与真实日志的两处契约错配，加上 native→fzstd 回退不重置
 * caller 校验器，使 403 个真实会话中 354 个被判 unindexable（9 月全文解析全灭）。
 * 本文件的三个 describe 分别锁死一个根因，形态全部取自真实 session.jsonl.zstd：
 *
 *   ① tool/result role 契约 —— 写入端 dsh-llm createToolResultMessage() 走
 *      createUserMessage({ source: { kind: 'tool', callId } }) → role 恒为 'user'，
 *      旧校验却要求 'tool'：凡用过工具的会话必炸。
 *   ② 事件词表缺 run_code 子调用追踪事件（tool/code-dispatch-start /
 *      tool/code-dispatch，写入端未标 ignorable）→ 整个文件被前向兼容守卫拒绝。
 *   ③ native 解码路径一旦向 caller 喂过行，回退 fzstd 从文件头重放会撞上已推进的
 *      校验器 expectedSeq，真实错误被掩盖成 "malformed event envelope at seq N"。
 *
 * 修复前这些用例必须红（③ 的用例断言错误文案，①② 的用例断言解析成功）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { zstdCompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFull, parseHead, parseSearch } from '../src/streaming-parser.js'
import {
  SessionCompatibilityError,
  SessionLogCompatibility,
  textFromCompatibleMessage,
} from '../src/session-compat.js'

const CREATED_AT = 1_788_688_981_000
let root = ''

/** 真实形态 header 行（字段与真实日志首行一致）。 */
function headerLine(id: string): string {
  return JSON.stringify({
    type: 'session', version: 0, id, createdAt: CREATED_AT,
    cwd: 'E:\\Do Something\\real-shape', delegationDepth: 0, agentPreset: 'standard',
  })
}

/** user/message 行：data 即 message（role/source/content 平铺）。 */
function userMessageLine(seq: number, text: string, id = `user-${seq}`): string {
  return JSON.stringify({
    type: 'user/message', seq, time: CREATED_AT + seq,
    data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    surfaceOp: 'append',
  })
}

/** tool/call 行：log-only 事件，无 surfaceOp / sourceEventSeqs。 */
function toolCallLine(seq: number, callId: string, name: string): string {
  return JSON.stringify({
    type: 'tool/call', seq, time: CREATED_AT + seq,
    data: { turn: 1, step: 1, callId, name, arguments: '{"pattern":"**/*.md"}' },
  })
}

/** tool/result 行：真实写入端 role='user' + source.kind='tool' + callId。 */
function toolResultLine(seq: number, callId: string, text: string, sourceSeq: number): string {
  return JSON.stringify({
    type: 'tool/result', seq, time: CREATED_AT + seq,
    data: {
      turn: 1, step: 1,
      message: {
        id: `tool-${seq}`, role: 'user', source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
      },
    },
    surfaceOp: 'append',
    sourceEventSeqs: [sourceSeq],
  })
}

/** run_code 子调用追踪事件（② 的缺失词表项），无 surfaceOp / ignorable。 */
function codeDispatchLine(type: 'tool/code-dispatch-start' | 'tool/code-dispatch', seq: number, name: string, text: string): string {
  const data: Record<string, unknown> = {
    rootCallId: 'call_root', parentCallId: 'call_root', subCallId: `call_root:code:${seq}`, name, arguments: { pattern: '**' },
  }
  if (type === 'tool/code-dispatch') {
    data.isError = false
    data.content = [{ type: 'text', text }]
  }
  return JSON.stringify({ type, seq, time: CREATED_AT + seq, data })
}

/** 官方 packed chunk 存储行：text-chunks 展开为 assistant/chunk 事件。 */
function packedTextChunksLine(seq0: number, texts: string[], dt: number[]): string {
  return JSON.stringify({
    type: 'text-chunks', seq0, time0: CREATED_AT + seq0,
    data: { turn: 1, step: 1, index: 0, dt, texts },
  })
}

function assistantMessageLine(seq: number, text: string, sourceSeqs: number[]): string {
  return JSON.stringify({
    type: 'assistant/message', seq, time: CREATED_AT + seq,
    data: {
      turn: 1, step: 1,
      message: {
        id: `assistant-${seq}`, role: 'assistant',
        source: { kind: 'model', provider: 'test', providerApi: 'openai', model: 'test-model' },
        content: [{ type: 'text', text }],
      },
    },
    surfaceOp: 'append',
    sourceEventSeqs: sourceSeqs,
  })
}

/** 与 DSH 持久化一致的多帧拼接：header 单独一帧，其余按行切帧。 */
function multiFrame(lines: string[]): Buffer {
  const frames = [zstdCompressSync(Buffer.from(`${lines[0]}\n`, 'utf8'))]
  for (const line of lines.slice(1)) frames.push(zstdCompressSync(Buffer.from(`${line}\n`, 'utf8')))
  return Buffer.concat(frames)
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-alpha3-regression-'))
})

after(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe('alpha.3 回归 ①+②：真实形态会话日志全量解析成功', () => {
  it('parseFull / parseHead / parseSearch 接受 role=user 的 tool/result 与 run_code 追踪事件', async () => {
    const file = join(root, 'real-shape.jsonl.zstd')
    await writeFile(file, multiFrame([
      headerLine('session-real-shape'),
      userMessageLine(0, 'list the markdown files'),
      toolCallLine(1, 'call_1', 'run_code'),
      toolResultLine(2, 'call_1', 'dispatch ok', 1),
      codeDispatchLine('tool/code-dispatch-start', 3, 'glob', ''),
      codeDispatchLine('tool/code-dispatch', 4, 'glob', 'docs/a.md'),
      packedTextChunksLine(5, ['answer ', 'part two'], [10]),
      assistantMessageLine(7, 'final answer', [5, 6]),
    ]))

    const full = await parseFull(file, { collectMessages: true })
    assert.equal(full.id, 'session-real-shape')
    assert.equal(full.createdAt, CREATED_AT)
    assert.equal(full.compatibility, 'alpha3')
    assert.equal(full.firstUserText, 'list the markdown files')
    assert.equal(full.lastAssistantText, 'final answer')
    assert.equal(full.events, 8)
    assert.deepEqual(full.counts, {
      'user/message': 1,
      'tool/call': 1,
      'tool/result': 1,
      'tool/code-dispatch-start': 1,
      'tool/code-dispatch': 1,
      'assistant/chunk': 2,
      'assistant/message': 1,
    })
    assert.deepEqual(full.toolCallCounts, { run_code: 1 })
    assert.ok(full.messages && full.messages.length >= 3, 'collected user/tool/assistant rows')

    const head = await parseHead(file)
    assert.equal(head.id, 'session-real-shape')
    assert.equal(head.firstUserText, 'list the markdown files')
    assert.equal(head.records, 8)

    const hits = await parseSearch(file, 'final answer')
    assert.ok(hits.some((hit) => hit.role === 'assistant'), 'assistant text searchable')
  })

  it('容忍真实日志中的空 callId 与缺失 message.id', async () => {
    const file = join(root, 'tolerated-shapes.jsonl.zstd')
    const emptyCallToolResult = JSON.stringify({
      type: 'tool/result', seq: 1, time: CREATED_AT + 1,
      data: {
        turn: 1, step: 1,
        message: {
          id: 'tool-empty', role: 'user', source: { kind: 'tool', callId: '' },
          content: [{ type: 'tool-result', toolCallId: '', content: [{ type: 'text', text: 'Error: unknown tool ""' }], isError: true }],
        },
        error: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' },
      },
      surfaceOp: 'append',
      sourceEventSeqs: [0],
    })
    const noticeWithoutId = JSON.stringify({
      type: 'user/message', seq: 2, time: CREATED_AT + 2,
      data: { role: 'user', source: { kind: 'plugin', plugin: 'tool-goal', form: 'notice' }, content: [{ type: 'text', text: '<goal_complete>' }] },
      surfaceOp: 'append',
    })
    await writeFile(file, multiFrame([
      headerLine('session-tolerated'),
      toolCallLine(0, '', ''),
      emptyCallToolResult,
      noticeWithoutId,
    ]))

    const full = await parseFull(file)
    assert.equal(full.counts['tool/result'], 1)
    assert.equal(full.counts['user/message'], 1)
  })
})

describe('alpha.3 回归 ③：native 回退不得掩盖真实错误', () => {
  it('未知必填事件上抛原始错误文案，而不是 envelope 重放假象', async () => {
    const file = join(root, 'unknown-required.jsonl.zstd')
    await writeFile(file, multiFrame([
      headerLine('session-unknown-required'),
      userMessageLine(0, 'hello'),
      JSON.stringify({
        type: 'plugin/not-in-vocabulary', seq: 1, time: CREATED_AT + 1, data: { sample: true },
      }),
    ]))

    await assert.rejects(
      () => parseFull(file),
      (error: unknown) => {
        assert.ok(error instanceof SessionCompatibilityError)
        assert.match(error.message, /unknown required event type "plugin\/not-in-vocabulary" at seq 1/)
        assert.doesNotMatch(error.message, /malformed event envelope/)
        return true
      },
    )
  })

  it('词表内事件仍然整文件通过（守卫只在真正未知时拒绝）', async () => {
    const file = join(root, 'known-log-only.jsonl.zstd')
    await writeFile(file, multiFrame([
      headerLine('session-known-log-only'),
      userMessageLine(0, 'hello'),
      JSON.stringify({ type: 'turn/start', seq: 1, time: CREATED_AT + 1, data: { turn: 1 } }),
      JSON.stringify({ type: 'turn/end', seq: 2, time: CREATED_AT + 2, data: { turn: 1 } }),
    ]))
    const full = await parseFull(file)
    assert.equal(full.counts['turn/start'], 1)
    assert.equal(full.counts['turn/end'], 1)
  })
})

describe('alpha.3 回归 ①+②：SessionLogCompatibility 词表与消息契约', () => {
  const header = { type: 'session', version: 0, id: 'compat-unit', createdAt: CREATED_AT }

  function consume(...records: unknown[]): ReturnType<SessionLogCompatibility['finish']> {
    const log = new SessionLogCompatibility()
    log.consumeLine(header)
    for (const record of records) log.consumeLine(record)
    return log.finish()
  }

  it('tool/result 接受写入端的 role=user 与历史 role=tool，仍拒绝其它 role', () => {
    // seq 0 先放一个 log-only 事件，让 tool/result 能落在 seq 1 并引用 [0] 来源
    const lead = { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }
    const make = (role: string, callId = 'call-1') => ({
      type: 'tool/result', seq: 1, time: 2,
      data: {
        turn: 1, step: 1,
        message: {
          id: 'tool-1', role, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }],
          source: { kind: 'tool', callId },
        },
      },
      surfaceOp: 'append',
      sourceEventSeqs: [0],
    })

    assert.equal(consume(lead, make('user'))[0]?.type, 'tool/result')
    assert.equal(consume(lead, make('tool'))[0]?.type, 'tool/result')
    assert.throws(() => consume(lead, make('assistant')), /tool\/result has an invalid message/)
    assert.throws(() => consume(lead, {
      type: 'tool/result', seq: 1, time: 2,
      data: { message: { id: 'tool-1', role: 'user', content: [], source: { kind: 'model', provider: 'p', model: 'm' } } },
      surfaceOp: 'append', sourceEventSeqs: [0],
    }), /tool\/result must have a tool source/)
  })

  it('run_code 追踪事件进词表但保持不透明，且仍拒绝携带 surface 元数据', () => {
    const dispatch = (seq: number, type: string) => ({ type, seq, time: seq + 1, data: { rootCallId: 'r', subCallId: 'r:code:1', name: 'glob' } })
    assert.deepEqual(consume(dispatch(0, 'tool/code-dispatch-start'), dispatch(1, 'tool/code-dispatch')), [])
    assert.throws(
      () => consume({ ...dispatch(0, 'tool/code-dispatch'), surfaceOp: 'append' }),
      /carries surface metadata/,
    )
  })

  it('未知必填事件仍被前向兼容守卫拒绝', () => {
    assert.throws(
      () => consume({ type: 'plugin/required-unknown', seq: 0, time: 1, data: {} }),
      /unknown required event type/,
    )
  })
})
