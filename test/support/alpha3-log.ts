/** Small alpha.3 JSONL factory for tests that need writable session fixtures. */

export interface Alpha3Event {
  type: string
  data: Record<string, unknown>
  time?: number
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
  sourceEventSeqs?: number[] | Array<number | [number, number]>
}

export interface Alpha3LogOptions {
  id: string
  createdAt: number
  cwd?: string
  agentPreset?: string
  events: Alpha3Event[]
}

export function alpha3EventJson(event: Alpha3Event, seq: number, createdAt: number): string {
  return JSON.stringify({
    type: event.type,
    seq,
    time: event.time ?? createdAt + seq,
    data: event.data,
    ...event.surfaceOp !== undefined ? { surfaceOp: event.surfaceOp } : {},
    ...event.sourceEventSeqs !== undefined ? { sourceEventSeqs: event.sourceEventSeqs } : {},
  })
}

export function alpha3Jsonl(options: Alpha3LogOptions): string[] {
  const { id, createdAt, cwd = 'E:\\Do\\test', agentPreset = 'router-flash', events } = options
  return [
    JSON.stringify({
      type: 'session', version: 0, id, createdAt, cwd, delegationDepth: 0, agentPreset,
    }),
    ...events.map((event, seq) => alpha3EventJson(event, seq, createdAt)),
  ]
}

export function alpha3User(text: string, id: string, time?: number): Alpha3Event {
  return {
    type: 'user/message', time, surfaceOp: 'append',
    data: {
      id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
    },
  }
}

export function alpha3Assistant(text: string, id: string, time?: number): Alpha3Event {
  return {
    type: 'assistant/message', time, surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: {
        id, role: 'assistant', source: { kind: 'model', provider: 'test', model: 'test' },
        content: [{ type: 'text', text }],
      },
    },
  }
}

export function alpha3ToolCall(name: string, id: string, time?: number): Alpha3Event {
  return {
    type: 'tool/call', time,
    data: { turn: 1, step: 1, callId: id, name, arguments: '{}' },
  }
}
