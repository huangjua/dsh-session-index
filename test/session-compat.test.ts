import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeSourceEventSeqRanges,
  SessionCompatibilityError,
  SessionLogCompatibility,
  textFromCompatibleMessage,
} from '../src/session-compat.js'

const header = {
  type: 'session', version: 0, id: 'alpha3-session', createdAt: 1,
}

function userEvent(seq: number, text: string, surfaceOp: unknown = 'append', sourceEventSeqs?: unknown) {
  return {
    type: 'user/message', seq, time: seq + 1,
    data: {
      id: `user-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' },
    },
    surfaceOp,
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
  }
}

function assistantEvent(seq: number, text: string, sourceEventSeqs?: unknown) {
  return {
    type: 'assistant/message', seq, time: seq + 1,
    data: {
      turn: 1, step: 1,
      message: {
        id: `assistant-${seq}`, role: 'assistant', content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      },
    },
    surfaceOp: 'append',
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
  }
}

function consume(log: SessionLogCompatibility, ...events: unknown[]): void {
  log.consumeLine(header)
  for (const event of events) log.consumeLine(event)
}

describe('SessionLogCompatibility alpha.3', () => {
  it('accepts a header without optional delegationDepth', () => {
    const log = new SessionLogCompatibility()
    consume(log, userEvent(0, 'hello'))
    assert.equal(log.header.id, 'alpha3-session')
    assert.deepEqual(log.finish().map(textFromCompatibleMessage), ['hello'])
  })

  it('expands official packed chunk rows and decodes source sequence ranges', () => {
    const log = new SessionLogCompatibility()
    consume(log,
      {
        type: 'text-chunks', seq0: 0, time0: 10,
        data: { turn: 1, step: 1, index: 0, dt: [2], texts: ['a', 'b'] },
      },
      assistantEvent(2, 'assembled', [[0, 1]]),
    )
    const messages = log.finish()
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.seq, 2)
    assert.equal(textFromCompatibleMessage(messages[0]!), 'assembled')
    assert.deepEqual(decodeSourceEventSeqRanges([0, [2, 4]], 5), [0, 2, 3, 4])
  })

  it('folds a surface replacement only when it cites every shadowed node', () => {
    const log = new SessionLogCompatibility()
    consume(log,
      userEvent(0, 'old 1'),
      userEvent(1, 'old 2'),
      userEvent(2, 'summary', { op: 'replace', start: 0, end: 1 }, [[0, 1]]),
    )
    const messages = log.finish()
    assert.deepEqual(messages.map((message) => message.seq), [2])
    assert.deepEqual(messages.map(textFromCompatibleMessage), ['summary'])

    const invalid = new SessionLogCompatibility()
    assert.throws(
      () => consume(invalid,
        userEvent(0, 'old 1'),
        userEvent(1, 'old 2'),
        userEvent(2, 'bad', { op: 'replace', start: 0, end: 1 }, [0]),
      ),
      SessionCompatibilityError,
    )
  })

  it('keeps known log-only events opaque and accepts only explicitly ignorable unknown events', () => {
    const log = new SessionLogCompatibility()
    consume(log,
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'plugin/telemetry', seq: 1, time: 2, data: { sample: true }, ignorable: true },
      userEvent(2, 'visible'),
    )
    assert.deepEqual(log.finish().map(textFromCompatibleMessage), ['visible'])

    const required = new SessionLogCompatibility()
    assert.throws(
      () => consume(required, { type: 'plugin/required', seq: 0, time: 1, data: {} }),
      /unknown required event type/,
    )
    const unsafe = new SessionLogCompatibility()
    assert.throws(
      () => consume(unsafe, {
        type: 'plugin/telemetry', seq: 0, time: 1, data: {}, ignorable: true, surfaceOp: 'append',
      }),
      /carries surface metadata/,
    )
  })

  it('requires alpha.3 surface message roles and rejects retired header baselines', () => {
    const log = new SessionLogCompatibility()
    consume(log, {
      type: 'tool/result', seq: 0, time: 1,
      data: {
        turn: 1, step: 1,
        message: {
          id: 'tool-0', role: 'tool', content: [{ type: 'text', text: 'ok' }],
          source: { kind: 'tool', callId: 'call-0' },
        },
      },
      surfaceOp: 'append',
    })
    assert.equal(log.finish()[0]?.type, 'tool/result')

    const retired = new SessionLogCompatibility()
    assert.throws(
      () => retired.consumeLine({ ...header, approvalPolicy: 'never' }),
      /retired policy baseline fields/,
    )
  })
})
