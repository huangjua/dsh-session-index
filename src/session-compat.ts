/**
 * Read-only alpha.3 boundary for durable DSH JSONL session logs.
 *
 * This mirrors the public storage and surface contracts at DeepSeek Harness
 * dsh-v0.1.2-alpha.3 (dd6322d): header rows, provenance range decoding,
 * packed chunk rows, and surface replacement validation.  It deliberately
 * does not maintain a copied catalog of every log-only event.  DSH event maps
 * are extension points. Known log-only events remain opaque; a future unknown
 * event is accepted only when its writer marks it `ignorable: true`, which is
 * the alpha.3 forward-compatibility guard. Unknown required events and any
 * unknown event that attempts to join the surface are rejected.
 */

export type SessionCompatibilityVersion = 'alpha3'

export interface SessionHeaderView {
  id: string
  createdAt: number
  cwd: string
  agentPreset: string
  parentSession?: string
}

export interface CompatibleMessage {
  seq: number
  type: 'user/message' | 'assistant/message' | 'tool/result'
  data: Record<string, unknown>
}

export class SessionCompatibilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionCompatibilityError'
  }
}

const SURFACE_TYPES = new Set<CompatibleMessage['type']>([
  'user/message',
  'assistant/message',
  'tool/result',
])
const EVENT_KEYS = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'])
// Official alpha.3 log-only vocabulary, including the built-in external
// plugin events. Surface types are handled separately below.
const KNOWN_LOG_ONLY_TYPES = new Set([
  'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided', 'approval/policy',
  'assistant/chunk', 'command/done', 'command/run', 'compaction/end', 'compaction/prune',
  'compaction/start', 'compaction/summary', 'feedback/record', 'goal/change', 'hook/invoked', 'hook/result',
  'llm/retry', 'llm/retry-started', 'model/selection', 'permission/preset', 'plan/mode', 'request/context',
  'request/header', 'sandbox/mode', 'schedule/change', 'session/end-seed', 'session/title',
  'session/title-llm-request', 'session-log-deepseek/delivery-accepted', 'step/end', 'step/start',
  'subagent/descriptor', 'subagent/model-selection-policy', 'team/member', 'team/message/delivered',
  'team/message/queued', 'team/task', 'todo/write', 'tool/call', 'tool-workflow/agent-end',
  'tool-workflow/agent-start', 'tool-workflow/run-end', 'tool-workflow/run-start', 'turn/end', 'turn/start',
  'web/deepseek-search-llm-request',
])

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionCompatibilityError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function isEventSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSafeEpoch(value: unknown): value is number {
  return isEventSeq(value) && !Object.is(value, -0)
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

/** Exact alpha.3 decoder for JSONL's sourceEventSeqs storage encoding. */
export function decodeSourceEventSeqRanges(value: unknown, maxEntries = Number.MAX_SAFE_INTEGER): number[] {
  if (!Array.isArray(value)) throw new SessionCompatibilityError('sourceEventSeqs must be an array')
  const decoded: number[] = []
  let hasRange = false
  for (const entry of value) {
    if (typeof entry === 'number') {
      if (!isEventSeq(entry)) throw new SessionCompatibilityError('sourceEventSeqs must contain non-negative safe integers')
      if (decoded.length >= maxEntries) throw new SessionCompatibilityError('sourceEventSeqs exceeds its event sequence')
      decoded.push(entry)
      continue
    }
    if (!Array.isArray(entry) || entry.length !== 2 || !isEventSeq(entry[0]) || !isEventSeq(entry[1])) {
      throw new SessionCompatibilityError('sourceEventSeqs range entries must be [start, end] pairs')
    }
    const [start, end] = entry
    if (end < start) throw new SessionCompatibilityError('sourceEventSeqs ranges require start <= end')
    const length = end - start + 1
    if (length > maxEntries - decoded.length) {
      throw new SessionCompatibilityError('sourceEventSeqs range exceeds its event sequence')
    }
    for (let seq = start; seq <= end; seq += 1) decoded.push(seq)
    hasRange = true
  }
  if (hasRange && !decoded.every((seq, index) => index === 0 || seq > (decoded[index - 1] as number))) {
    throw new SessionCompatibilityError('sourceEventSeqs ranges must be strictly increasing')
  }
  return decoded
}

/** Decode the three official alpha.3 packed chunk storage rows. */
function decodeStorageRecord(value: unknown): Record<string, unknown>[] {
  const row = record(value, 'stored session record')
  const tag = row.type
  if (tag !== 'text-chunks' && tag !== 'reasoning-chunks' && tag !== 'tool-call-chunks') return [row]
  if (!hasExactKeys(row, ['type', 'seq0', 'time0', 'data']) || !isEventSeq(row.seq0)
    || !Number.isSafeInteger(row.time0)) {
    throw new SessionCompatibilityError(`malformed ${tag} storage row`)
  }
  const data = record(row.data, `${tag} data`)
  const payloadKey = tag === 'tool-call-chunks' ? 'args' : 'texts'
  const payload = data[payloadKey]
  const validRun = typeof data.turn === 'number' && typeof data.step === 'number' && typeof data.index === 'number'
    && Array.isArray(payload) && payload.length > 0 && payload.every(part => typeof part === 'string')
    && Array.isArray(data.dt) && data.dt.length === payload.length - 1
    && data.dt.every(gap => Number.isSafeInteger(gap))
  if (!validRun || payload.length - 1 > Number.MAX_SAFE_INTEGER - row.seq0) {
    throw new SessionCompatibilityError(`malformed ${tag} storage row`)
  }
  if (tag === 'tool-call-chunks') {
    const validShape = hasExactKeys(data, ['turn', 'step', 'index', 'id', 'dt', 'args'])
      || hasExactKeys(data, ['turn', 'step', 'index', 'id', 'name', 'dt', 'args'])
    if (!validShape || typeof data.id !== 'string' || (Object.hasOwn(data, 'name') && typeof data.name !== 'string')) {
      throw new SessionCompatibilityError('malformed tool-call-chunks storage row')
    }
  } else if (!hasExactKeys(data, ['turn', 'step', 'index', 'dt', 'texts'])) {
    throw new SessionCompatibilityError(`malformed ${tag} storage row`)
  }

  let time = row.time0 as number
  const gaps = data.dt as number[]
  const events: Record<string, unknown>[] = []
  for (let index = 0; index < payload.length; index += 1) {
    if (index > 0) {
      time += gaps[index - 1] as number
      if (!Number.isSafeInteger(time)) throw new SessionCompatibilityError(`malformed ${tag} storage row`)
    }
    const chunk = tag === 'text-chunks'
      ? { type: 'text-delta', index: data.index, text: payload[index] }
      : tag === 'reasoning-chunks'
        ? { type: 'reasoning-delta', index: data.index, text: payload[index] }
        : {
            type: 'tool-call-delta', index: data.index, id: data.id,
            ...Object.hasOwn(data, 'name') ? { name: data.name } : {},
            argumentsDelta: payload[index],
          }
    events.push({
      type: 'assistant/chunk', seq: row.seq0 + index, time,
      data: { turn: data.turn, step: data.step, chunk },
    })
  }
  return events
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => jsonEqual(item, right[index]))
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  return leftKeys.length === Object.keys(rightRecord).length
    && leftKeys.every(key => Object.hasOwn(rightRecord, key) && jsonEqual(leftRecord[key], rightRecord[key]))
}

function assertMessageShape(event: Record<string, unknown>): void {
  const type = event.type as CompatibleMessage['type']
  const data = record(event.data, `${type} data`)
  const message = type === 'user/message' ? data : record(data.message, `${type} message`)
  const expectedRole = type === 'assistant/message' ? 'assistant' : type === 'tool/result' ? 'tool' : 'user'
  if (typeof message.id !== 'string' || message.id.length === 0 || message.role !== expectedRole
    || !Array.isArray(message.content)) {
    throw new SessionCompatibilityError(`${type} has an invalid message`)
  }
  const source = record(message.source, `${type} source`)
  if (typeof source.kind !== 'string' || source.kind.length === 0) {
    throw new SessionCompatibilityError(`${type} has an invalid source`)
  }
  if (type === 'assistant/message'
    && (source.kind !== 'model' || typeof source.provider !== 'string' || source.provider.length === 0
      || typeof source.model !== 'string' || source.model.length === 0)) {
    throw new SessionCompatibilityError('assistant/message must have a model source')
  }
  if (type === 'tool/result'
    && (source.kind !== 'tool' || typeof source.callId !== 'string' || source.callId.length === 0)) {
    throw new SessionCompatibilityError('tool/result must have a tool source')
  }
}

/**
 * Validates an alpha.3 JSONL log and folds its current model-visible surface.
 * The raw log is never modified and non-surface extension events remain opaque.
 */
export class SessionLogCompatibility {
  private _header: SessionHeaderView | undefined
  private expectedSeq = 0
  private readonly surface: Record<string, unknown>[] = []

  get header(): SessionHeaderView {
    if (!this._header) throw new SessionCompatibilityError('session log has no header')
    return this._header
  }

  get version(): SessionCompatibilityVersion {
    return 'alpha3'
  }

  consumeLine(value: unknown): Record<string, unknown>[] {
    if (!this._header) {
      this.consumeHeader(value)
      return []
    }
    const decoded = decodeStorageRecord(value)
    for (const event of decoded) this.consumeEvent(event)
    return decoded
  }

  finish(): CompatibleMessage[] {
    if (!this._header) throw new SessionCompatibilityError('empty or header-less session log')
    return this.surface.map(event => ({
      seq: event.seq as number,
      type: event.type as CompatibleMessage['type'],
      data: event.data as Record<string, unknown>,
    }))
  }

  private consumeHeader(value: unknown): void {
    const header = record(value, 'session header')
    if (header.type !== 'session' || header.version !== 0 || typeof header.id !== 'string' || header.id.length === 0
      || !isSafeEpoch(header.createdAt)
      || (header.delegationDepth !== undefined && !isEventSeq(header.delegationDepth))
      || (header.cwd !== undefined && typeof header.cwd !== 'string')
      || (header.parentSession !== undefined && typeof header.parentSession !== 'string')
      || (header.seedLength !== undefined && !isEventSeq(header.seedLength))
      || (header.origin !== undefined && header.origin !== 'subagent')
      || (header.agentPreset !== undefined && typeof header.agentPreset !== 'string')) {
      throw new SessionCompatibilityError('unsupported or malformed alpha.3 session header')
    }
    if (Object.hasOwn(header, 'sandboxMode') || Object.hasOwn(header, 'approvalPolicy')) {
      throw new SessionCompatibilityError('session header uses retired policy baseline fields')
    }
    this._header = {
      id: header.id,
      createdAt: header.createdAt,
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
      ...typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {},
    }
  }

  private consumeEvent(source: Record<string, unknown>): void {
    if (Object.keys(source).some(key => !EVENT_KEYS.has(key)) || typeof source.type !== 'string'
      || !isEventSeq(source.seq) || source.seq !== this.expectedSeq
      || !Number.isSafeInteger(source.time) || !Object.hasOwn(source, 'data')
      || (Object.hasOwn(source, 'ignorable') && source.ignorable !== true)) {
      throw new SessionCompatibilityError(`malformed event envelope at seq ${this.expectedSeq}`)
    }
    this.expectedSeq += 1
    if (source.type === 'request/header-delta') {
      throw new SessionCompatibilityError('unsupported legacy request/header-delta event')
    }
    const event = Object.hasOwn(source, 'sourceEventSeqs')
      ? { ...source, sourceEventSeqs: decodeSourceEventSeqRanges(source.sourceEventSeqs, source.seq) }
      : source
    if (!SURFACE_TYPES.has(event.type as CompatibleMessage['type'])) {
      if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
        throw new SessionCompatibilityError(`non-surface event "${event.type}" carries surface metadata`)
      }
      if (!KNOWN_LOG_ONLY_TYPES.has(event.type as string) && event.ignorable !== true) {
        throw new SessionCompatibilityError(`unknown required event type "${event.type}" at seq ${event.seq}`)
      }
      return
    }
    assertMessageShape(event)
    this.foldSurface(event)
  }

  private foldSurface(event: Record<string, unknown>): void {
    const op = event.surfaceOp
    if (op === undefined) throw new SessionCompatibilityError(`surface event "${event.type}" lacks surfaceOp`)
    const sources = event.sourceEventSeqs
    if (sources !== undefined && (!Array.isArray(sources)
      || (sources.length === 0 && event.type !== 'assistant/message')
      || sources.some(value => !isEventSeq(value) || value >= (event.seq as number))
      || new Set(sources as number[]).size !== sources.length)) {
      throw new SessionCompatibilityError(`invalid sourceEventSeqs at seq ${event.seq}`)
    }
    if (op === 'append') {
      this.surface.push(event)
      return
    }
    const replace = record(op, 'surface replace')
    if (!hasExactKeys(replace, ['op', 'start', 'end']) || replace.op !== 'replace'
      || !isEventSeq(replace.start) || !isEventSeq(replace.end)) {
      throw new SessionCompatibilityError(`invalid surfaceOp at seq ${event.seq}`)
    }
    const start = this.surface.findIndex(candidate => candidate.seq === replace.start)
    const end = this.surface.findIndex(candidate => candidate.seq === replace.end)
    if (start < 0 || end < start) throw new SessionCompatibilityError(`invalid surface replacement range at seq ${event.seq}`)
    const shadowed = this.surface.slice(start, end + 1)
    const sourceSet = new Set((sources ?? []) as number[])
    if (shadowed.some(candidate => !sourceSet.has(candidate.seq as number))) {
      throw new SessionCompatibilityError(`surface replacement at seq ${event.seq} omits shadowed provenance`)
    }
    if (event.type === 'tool/result') {
      if (shadowed.length !== 1 || shadowed[0]?.type !== 'tool/result') {
        throw new SessionCompatibilityError('tool/result surface replacement must target one tool/result')
      }
      const original = record(shadowed[0].data, 'original tool/result data')
      const replacement = record(event.data, 'replacement tool/result data')
      const originalMessage = record(original.message, 'original tool/result message')
      const replacementMessage = record(replacement.message, 'replacement tool/result message')
      const originalContent = originalMessage.content
      const replacementContent = replacementMessage.content
      if (!Array.isArray(originalContent) || originalContent.length !== 1 || !Array.isArray(replacementContent)
        || replacementContent.length !== 1 || typeof originalContent[0] !== 'object' || originalContent[0] === null
        || typeof replacementContent[0] !== 'object' || replacementContent[0] === null) {
        throw new SessionCompatibilityError('tool/result surface replacement has invalid result content')
      }
      const originalRest = { ...original, message: { ...originalMessage, content: [{ ...(originalContent[0] as Record<string, unknown>), content: null }] } }
      const replacementRest = { ...replacement, message: { ...replacementMessage, content: [{ ...(replacementContent[0] as Record<string, unknown>), content: null }] } }
      if (!jsonEqual(originalRest, replacementRest)) {
        throw new SessionCompatibilityError('tool/result surface replacement may change only content')
      }
    }
    this.surface.splice(start, end - start + 1, event)
  }
}

/** Extract indexable text from the message forms that the plugin exposes. */
export function textFromCompatibleMessage(message: CompatibleMessage): string {
  const content = message.type === 'user/message'
    ? message.data.content
    : message.type === 'assistant/message'
      ? record(message.data.message, 'assistant/message message').content
      : undefined
  if (!Array.isArray(content)) return ''
  return content
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item))
    .filter(item => item.type === 'text' && typeof item.text === 'string')
    .map(item => item.text as string)
    .join(' ')
    .trim()
}
