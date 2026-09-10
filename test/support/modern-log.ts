/**
 * v2/v3 physical JSONL factory for tests that need writable modern fixtures.
 *
 * Shapes follow the released v2/v3 codecs of @deepseek-ai/dsh-session-format
 * (0.1.5-rc.1): closed header key set with `isSeeded` + `delegationDepth`,
 * closed event envelope, `surfaceOp` replacements as `startSeq`/`endSeq` (v3)
 * or `start`/`end` (v2).  The real migrated fixture (v3-session.jsonl.zstd)
 * covers writer-produced shapes; these builders cover the contract edges.
 */

export interface ModernEvent {
  type: string
  data: Record<string, unknown>
  time?: number
  surfaceOp?: 'append' | { op: 'replace'; startSeq: number; endSeq: number } | { op: 'replace'; start: number; end: number }
  sourceEventSeqs?: number[] | Array<number | [number, number]>
  ignorable?: true
}

export interface ModernLogOptions {
  id: string
  createdAt: number
  version?: 2 | 3
  cwd?: string
  agentPreset?: string
  isSeeded?: boolean
  delegationDepth?: number
  events: ModernEvent[]
}

export function modernEventJson(event: ModernEvent, seq: number, createdAt: number): string {
  return JSON.stringify({
    type: event.type,
    seq,
    time: event.time ?? createdAt + seq,
    data: event.data,
    ...event.surfaceOp !== undefined ? { surfaceOp: event.surfaceOp } : {},
    ...event.sourceEventSeqs !== undefined ? { sourceEventSeqs: event.sourceEventSeqs } : {},
    ...event.ignorable !== undefined ? { ignorable: event.ignorable } : {},
  })
}

export function modernJsonl(options: ModernLogOptions): string[] {
  const {
    id, createdAt, version = 3, cwd = 'E:\\Do\\test',
    agentPreset = 'ptc', isSeeded = false, delegationDepth = 0, events,
  } = options
  return [
    JSON.stringify({
      type: 'session', version, id, createdAt, cwd, isSeeded, delegationDepth, agentPreset,
    }),
    ...events.map((event, seq) => modernEventJson(event, seq, createdAt)),
  ]
}

/** `user/message` appends the message itself as `data`. */
export function modernUser(text: string, id: string, time?: number, surfaceOp: ModernEvent['surfaceOp'] = 'append'): ModernEvent {
  return {
    type: 'user/message',
    time,
    data: { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
    surfaceOp,
  }
}

/** `assistant/message` nests the message and carries an empty embedded stream. */
export function modernAssistant(text: string, id: string, time?: number): ModernEvent {
  return {
    type: 'assistant/message',
    time,
    data: {
      turn: 1,
      step: 1,
      stream: [],
      message: {
        id,
        role: 'assistant',
        source: { kind: 'model', provider: 'deepseek-vision', model: 'deepseek-v4-flash' },
        content: [{ type: 'text', text }],
      },
    },
    surfaceOp: 'append',
  }
}

/** v3 system prompt: surfaced message with a plugin source (invariant in the codec). */
export function modernSystem(text: string, id: string, time?: number, surfaceOp: ModernEvent['surfaceOp'] = 'append'): ModernEvent {
  return {
    type: 'system/message',
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        id,
        role: 'system',
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
        content: [{ type: 'text', text }],
      },
    },
    surfaceOp,
  }
}

export function modernToolCall(callId: string, name: string, time?: number): ModernEvent {
  return {
    type: 'tool/call',
    time,
    data: { turn: 1, step: 1, callId, name, arguments: '{}' },
  }
}

export function modernToolResult(callId: string, text: string, sourceSeq: number, time?: number): ModernEvent {
  return {
    type: 'tool/result',
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `tool-${callId}`,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
      },
    },
    surfaceOp: 'append',
    sourceEventSeqs: [sourceSeq],
  }
}

/** run_code sub-call tracing as released in v2 (renamed to tool/ptc-dispatch* in v3). */
export function modernDispatch(start: boolean, time?: number): ModernEvent {
  return {
    type: start ? 'tool/ptc-dispatch-start' : 'tool/ptc-dispatch',
    time,
    data: {
      rootCallId: 'call_root', parentCallId: 'call_root', subCallId: 'call_root:code:1',
      name: 'grep', arguments: { pattern: 'x' }, ...start ? {} : { ok: true },
    },
  }
}
