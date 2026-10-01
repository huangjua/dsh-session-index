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
 *
 * 2026-09-10 regression fix (alpha.3 boundary corrections).  A full pass over
 * all 403 real session logs showed the gate itself was wrong in two places,
 * which made 354 files unparseable ("unindexable") and starved the FTS index:
 *
 * - tool/result role: the writer is dsh-llm `createToolResultMessage()`, which
 *   goes through `createUserMessage({ source: { kind: 'tool', callId } })`, so
 *   the message role is always 'user' and provenance lives in
 *   `source.kind === 'tool'` + `callId`.  The vocabulary previously demanded
 *   role 'tool', so every session that ever ran a tool failed.  Both historical
 *   values are accepted now ('user' from the writer; 'tool' kept for the
 *   earlier alpha.3 form); the source check is unchanged.
 * - vocabulary: `tool/code-dispatch-start` / `tool/code-dispatch` (run_code
 *   sub-call tracing, written without `ignorable: true`) were missing from the
 *   log-only list, so every session that used run_code failed.  Both are
 *   official alpha.3 events and are now part of the list below.
 *
 * Two further deviations exist in real logs and are tolerated here (verified
 * against the corpus rather than assumed): `tool/result` may carry an empty
 * `callId` (the model emitted an empty tool name and DSH persisted the
 * ToolNotFoundError result verbatim), and a plugin-authored `user/message`
 * notice may omit `message.id` (the index anchors messages by event `seq`, so
 * no consumer depends on the id).  The forward-compatibility guard is
 * otherwise unchanged: an unknown required event still rejects the file.
 *
 * 2026-09-10 format-v2/v3 support (DSH 0.1.5-rc.1).  The same reader now also
 * accepts the modern physical generations.  DSH names each generation on disk
 * — v0 keeps `session.jsonl.zstd`, later generations carry `session.vN.jsonl.zstd`
 * — and the reader dispatches on the header `version` field:
 *
 * - v0 (and v1, which shares its event shapes): the legacy format above, with
 *   `assistant/chunk` events and the packed `text-chunks` / `reasoning-chunks` /
 *   `tool-call-chunks` storage rows.
 * - v2/v3: no packed rows and no `assistant/chunk` — the v1→v2 migration folds a
 *   chunk run into `assistant/attempt` plus an `assistant/message` that embeds
 *   its own `stream`.  The header key set is closed and `isSeeded` +
 *   `delegationDepth` are required.  v3 promotes the system prompt out of
 *   `request/header` into `system/message`, the fourth surface type, and renames
 *   the PTC tracing events (`tool/code-dispatch*` → `tool/ptc-dispatch*`).
 *   Surface replacement ops are encoded as `{op:'replace',start,end}` in v2 and
 *   `{op:'replace',startSeq,endSeq}` in v3; both are normalized to `start`/`end`
 *   internally.
 *
 * Across every generation the index treats `system/message` as surface-only:
 * it joins the fold (replacements may target it) but contributes no searchable
 * text, matching the pre-v3 behaviour where the system prompt lived in the
 * opaque `request/header` event.
 */

/** Physical generation accepted by this reader. `alpha3` covers legacy v0/v1. */
export type SessionCompatibilityVersion = 'alpha3' | 'v2' | 'v3' | 'v4'

export interface SessionHeaderView {
  id: string
  createdAt: number
  cwd: string
  agentPreset: string
  parentSession?: string
}

export interface CompatibleMessage {
  seq: number
  type: 'user/message' | 'assistant/message' | 'tool/result' | 'system/message' | 'developer/message'
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
/** v3 promoted the system prompt onto the surface as a fourth message type. */
const SURFACE_TYPES_V3 = new Set<CompatibleMessage['type']>([
  ...SURFACE_TYPES,
  'system/message',
])
/**
 * v4 adds `developer/message` to the surface (official released V4 codec:
 * SURFACE_TYPES = system/message, user/message, developer/message,
 * assistant/message, tool/result).
 */
const SURFACE_TYPES_V4 = new Set<CompatibleMessage['type']>([
  ...SURFACE_TYPES_V3,
  'developer/message',
])
const LEGACY_EVENT_KEYS = new Set(['type', 'seq', 'time', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'])
/** Physical envelope for v2/v3 rows: same keys, closed set, `ignorable` must be true. */
const MODERN_EVENT_KEYS = LEGACY_EVENT_KEYS
// Official alpha.3 log-only vocabulary, including the built-in external
// plugin events. Surface types are handled separately below.
// `tool/code-dispatch-start` / `tool/code-dispatch` (run_code sub-call tracing)
// were missing here and are added by the 2026-09-10 regression fix — see the
// file header.  They are written without `ignorable: true`, so under the
// forward-compatibility guard every run_code session was rejected outright.
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
  'tool/code-dispatch-start', 'tool/code-dispatch',
  'web/deepseek-search-llm-request',
])

// Event vocabulary for the modern generations, taken from the released v3
// catalog (`KNOWN_SESSION_EVENT_TYPES` in @deepseek-ai/dsh-session
// 0.1.5-rc.1) minus the four surface types.  `tool/code-dispatch*` are the v2
// physical names that v3 renamed to `tool/ptc-dispatch*`; `assistant/chunk`
// never survives into v2+ logs (the v1→v2 migration consumes it) but is kept
// here so a stray legacy row cannot cost a whole file.
const MODERN_LOG_ONLY_TYPES = new Set([
  'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided', 'approval/policy',
  'assistant/attempt', 'assistant/chunk', 'command/done', 'command/run', 'compaction/end', 'compaction/prune',
  'compaction/start', 'compaction/summary', 'deliverables/presented', 'feedback/message-delete',
  'feedback/message-put', 'feedback/record', 'goal/change', 'hook/invoked', 'hook/result', 'llm/retry',
  'llm/retry-started', 'model/selection', 'permission/preset', 'plan/mode', 'request/context', 'request/header',
  'sandbox/mode', 'schedule/change', 'session/end-seed', 'session/title', 'session/title-llm-request',
  'session-log-deepseek/delivery-accepted', 'step/end', 'step/start', 'subagent/catalog', 'subagent/descriptor',
  'subagent/model-selection-policy', 'team/member', 'team/message/delivered', 'team/message/queued', 'team/task',
  'todo/write', 'tool/call', 'tool/ptc-dispatch', 'tool/ptc-dispatch-start', 'tool/code-dispatch',
  'tool/code-dispatch-start', 'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/run-end',
  'tool-workflow/run-start', 'turn/end', 'turn/start', 'workspace/changes', 'web/deepseek-search-llm-request',
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

function assertMessageShape(event: Record<string, unknown>, generation = 3): void {
  const type = event.type as CompatibleMessage['type']
  const data = record(event.data, `${type} data`)
  const message = type === 'user/message' ? data : record(data.message, `${type} message`)
  // tool/result is written by dsh-llm `createToolResultMessage()` →
  // `createUserMessage({ source: { kind: 'tool', callId } })`, so its role is
  // 'user'; 'tool' is kept for the earlier alpha.3 form.  v4 promotes it to a
  // real tool role (`liftToolResult`: role 'tool' + message-level toolCallId,
  // the wrapper's `content` lifted into `message.content`).  Provenance stays in
  // the source check below (`kind === 'tool'` + callId), unchanged.
  const roleOk = type === 'tool/result'
    ? message.role === 'user' || message.role === 'tool'
    : type === 'system/message'
      ? message.role === 'system'
      : type === 'developer/message'
        ? message.role === 'developer'
        : message.role === (type === 'assistant/message' ? 'assistant' : 'user')
  // `id` may be absent on plugin-authored user/message notices (real logs);
  // present values must still be non-empty strings.
  const idOk = message.id === undefined || (typeof message.id === 'string' && message.id.length > 0)
  if (!idOk || !roleOk || !Array.isArray(message.content)) {
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
  // The system prompt is written by the owning plugin (`system/message` with a
  // plugin source in v3).  v4 renames that provenance to a direct kind
  // (`@deepseek-ai/dsh-system-prompt` in a system-role message →
  // `system-prompt`; other roles → `runtime-context`), so the plugin-property
  // requirement only holds up to v3.
  if (type === 'system/message') {
    if (generation >= 4) {
      if (source.kind !== 'system-prompt' && source.kind !== 'runtime-context'
        && source.kind !== 'plugin') {
        throw new SessionCompatibilityError('system/message must have a system-prompt source')
      }
    } else if (source.kind !== 'plugin' || typeof source.plugin !== 'string' || source.plugin.length === 0) {
      throw new SessionCompatibilityError('system/message must have a plugin source')
    }
  }
  // callId may legitimately be empty: when the model emits a tool call with an
  // empty name, DSH persists the ToolNotFoundError tool/result verbatim with
  // callId ''.  The kind check keeps the tool provenance requirement.
  if (type === 'tool/result'
    && (source.kind !== 'tool' || typeof source.callId !== 'string')) {
    throw new SessionCompatibilityError('tool/result must have a tool source')
  }
}

/** Keys of a modern surface replacement op, in either released encoding. */
function normalizeReplaceOp(op: unknown, label: string): unknown {
  if (op === 'append') return op
  const replace = record(op, `${label} surfaceOp`)
  if (replace.op !== 'replace') throw new SessionCompatibilityError(`${label} has an invalid surfaceOp`)
  // v2 encodes start/end, v3 startSeq/endSeq.  Both name earlier surface nodes.
  const start = Object.hasOwn(replace, 'start') ? replace.start : replace.startSeq
  const end = Object.hasOwn(replace, 'end') ? replace.end : replace.endSeq
  if (!isEventSeq(start) || !isEventSeq(end)) {
    throw new SessionCompatibilityError(`${label} has an invalid surface replacement range`)
  }
  return { op: 'replace', start, end }
}

/**
 * Validates one JSONL session log (legacy v0/v1 or modern v2/v3) and folds its
 * current model-visible surface.  The raw log is never modified and
 * non-surface extension events remain opaque.
 */
export class SessionLogCompatibility {
  private _header: SessionHeaderView | undefined
  private _version: SessionCompatibilityVersion = 'alpha3'
  private _generation = 0
  private expectedSeq = 0
  private readonly surface: Record<string, unknown>[] = []

  get header(): SessionHeaderView {
    if (!this._header) throw new SessionCompatibilityError('session log has no header')
    return this._header
  }

  get version(): SessionCompatibilityVersion {
    return this._version
  }

  /** Physical format generation read from the header (0/1 legacy, 2/3 modern). */
  get generation(): number {
    return this._generation
  }

  consumeLine(value: unknown): Record<string, unknown>[] {
    if (!this._header) {
      this.consumeHeader(value)
      return []
    }
    // Packed chunk rows only exist in the legacy generations; a modern row is
    // already one logical event.
    const decoded = this._generation >= 2 ? [record(value, 'session event')] : decodeStorageRecord(value)
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
    const version = header.version
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0 || Object.is(version, -0)) {
      throw new SessionCompatibilityError('unsupported or malformed session header')
    }
    if (version >= 2) this.consumeModernHeader(header)
    else this.consumeLegacyHeader(header, version)
  }

  /** v0 (and its v1 successor): open key set, `version: 0/1`. */
  private consumeLegacyHeader(header: Record<string, unknown>, version: number): void {
    if (header.type !== 'session' || version > 1 || typeof header.id !== 'string' || header.id.length === 0
      || !isSafeEpoch(header.createdAt)
      || (header.delegationDepth !== undefined && !isEventSeq(header.delegationDepth))
      || (header.cwd !== undefined && typeof header.cwd !== 'string')
      || (header.parentSession !== undefined && typeof header.parentSession !== 'string')
      || (header.seedLength !== undefined && !isEventSeq(header.seedLength))
      || (header.origin !== undefined && header.origin !== 'subagent')
      || (header.agentPreset !== undefined && typeof header.agentPreset !== 'string')) {
      throw new SessionCompatibilityError('unsupported or malformed legacy session header')
    }
    if (Object.hasOwn(header, 'sandboxMode') || Object.hasOwn(header, 'approvalPolicy')) {
      throw new SessionCompatibilityError('session header uses retired policy baseline fields')
    }
    this._version = 'alpha3'
    this._generation = version
    this._header = {
      id: header.id,
      createdAt: header.createdAt,
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
      ...typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {},
    }
  }

  /**
   * v2/v3/v4: closed header shape.  `isSeeded` and `delegationDepth` are
   * required (a seeded log carries an inherited prefix up to its
   * `session/end-seed` marker), and `seedLength` is gone.  v4 keeps the same
   * logical header fields — the released v3→v4 edge only advances `version`
   * (`sessionFormatV3ToV4.migrateHeader`), so the key set is shared.
   */
  private consumeModernHeader(header: Record<string, unknown>): void {
    const version = header.version as number
    const allowed = new Set(['type', 'version', 'id', 'createdAt', 'isSeeded', 'delegationDepth',
      'cwd', 'parentSession', 'origin', 'agentPreset'])
    if (version > 4 || header.type !== 'session' || typeof header.id !== 'string' || header.id.length === 0
      || !isSafeEpoch(header.createdAt)
      || typeof header.isSeeded !== 'boolean'
      || !isEventSeq(header.delegationDepth)
      || Object.keys(header).some(key => !allowed.has(key))
      || (header.cwd !== undefined && typeof header.cwd !== 'string')
      || (header.parentSession !== undefined && typeof header.parentSession !== 'string')
      || (header.origin !== undefined && header.origin !== 'subagent')
      || (header.agentPreset !== undefined && typeof header.agentPreset !== 'string')) {
      throw new SessionCompatibilityError(`unsupported or malformed v${version} session header`)
    }
    if (Object.hasOwn(header, 'sandboxMode') || Object.hasOwn(header, 'approvalPolicy')) {
      throw new SessionCompatibilityError('session header uses retired policy baseline fields')
    }
    this._version = version === 2 ? 'v2' : version === 3 ? 'v3' : 'v4'
    this._generation = version
    this._header = {
      id: header.id,
      createdAt: header.createdAt,
      cwd: typeof header.cwd === 'string' ? header.cwd : '',
      agentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : '',
      ...typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {},
    }
  }

  private consumeEvent(source: Record<string, unknown>): void {
    if (this._generation >= 2) {
      this.consumeModernEvent(source)
      return
    }
    this.consumeLegacyEvent(source)
  }

  private consumeLegacyEvent(source: Record<string, unknown>): void {
    if (Object.keys(source).some(key => !LEGACY_EVENT_KEYS.has(key)) || typeof source.type !== 'string'
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

  /**
   * One v2/v3 row.  The envelope is already one event (no packing), the key set
   * is closed, and `assistant/chunk` never appears.  Replacement ops are
   * normalized to `{op:'replace',start,end}` before folding so both released
   * encodings share one fold.
   */
  private consumeModernEvent(source: Record<string, unknown>): void {
    if (Object.keys(source).some(key => !MODERN_EVENT_KEYS.has(key)) || typeof source.type !== 'string'
      || !isEventSeq(source.seq) || source.seq !== this.expectedSeq
      || !Number.isSafeInteger(source.time) || !Object.hasOwn(source, 'data')
      || (Object.hasOwn(source, 'ignorable') && source.ignorable !== true)) {
      throw new SessionCompatibilityError(`malformed v${this._generation} event envelope at seq ${this.expectedSeq}`)
    }
    this.expectedSeq += 1
    const surfaceTypes = this._generation === 4 ? SURFACE_TYPES_V4
      : this._generation === 3 ? SURFACE_TYPES_V3 : SURFACE_TYPES
    let event = Object.hasOwn(source, 'sourceEventSeqs')
      ? { ...source, sourceEventSeqs: decodeSourceEventSeqRanges(source.sourceEventSeqs, source.seq) }
      : source
    if (event.surfaceOp !== undefined) {
      event = { ...event, surfaceOp: normalizeReplaceOp(event.surfaceOp, `event "${event.type}" at seq ${event.seq}`) }
    }
    if (!surfaceTypes.has(event.type as CompatibleMessage['type'])) {
      if (event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined) {
        throw new SessionCompatibilityError(`non-surface event "${event.type}" carries surface metadata`)
      }
      if (!MODERN_LOG_ONLY_TYPES.has(event.type as string) && event.ignorable !== true) {
        throw new SessionCompatibilityError(`unknown required event type "${event.type}" at seq ${event.seq}`)
      }
      return
    }
    assertMessageShape(event, this._generation)
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
      if (!Array.isArray(originalContent) || !Array.isArray(replacementContent)) {
        throw new SessionCompatibilityError('tool/result surface replacement has invalid result content')
      }
      // v2/v3 wrap the result in exactly one `tool-result` block and the replace
      // op may only swap that block's inner `content`.  v4 lifts the block
      // (`liftToolResult`): `message.content` IS the payload, so only the whole
      // array may differ.
      const wrapped = originalContent.length === 1 && typeof originalContent[0] === 'object'
        && originalContent[0] !== null && (originalContent[0] as Record<string, unknown>).type === 'tool-result'
        && replacementContent.length === 1 && typeof replacementContent[0] === 'object'
        && replacementContent[0] !== null && (replacementContent[0] as Record<string, unknown>).type === 'tool-result'
      if (!wrapped && (originalContent.length === 0 || replacementContent.length === 0 || this._generation >= 4)) {
        const originalRest = { ...original, message: { ...originalMessage, content: null } }
        const replacementRest = { ...replacement, message: { ...replacementMessage, content: null } }
        if (!jsonEqual(originalRest, replacementRest)) {
          throw new SessionCompatibilityError('tool/result surface replacement may change only content')
        }
      } else {
        if (!wrapped) {
          throw new SessionCompatibilityError('tool/result surface replacement has invalid result content')
        }
        const originalRest = { ...original, message: { ...originalMessage, content: [{ ...(originalContent[0] as Record<string, unknown>), content: null }] } }
        const replacementRest = { ...replacement, message: { ...replacementMessage, content: [{ ...(replacementContent[0] as Record<string, unknown>), content: null }] } }
        if (!jsonEqual(originalRest, replacementRest)) {
          throw new SessionCompatibilityError('tool/result surface replacement may change only content')
        }
      }
    }
    this.surface.splice(start, end - start + 1, event)
  }
}

/** Extract indexable text from the message forms that the plugin exposes. */
export function textFromCompatibleMessage(message: CompatibleMessage): string {
  // `system/message` is deliberately searchable-free: before v3 the system
  // prompt lived in the opaque `request/header` event and never reached the
  // index, and v3 logs would otherwise repeat the same prompt in every session.
  if (message.type === 'system/message') return ''
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
