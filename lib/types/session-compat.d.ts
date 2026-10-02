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
export type SessionCompatibilityVersion = 'alpha3' | 'v2' | 'v3' | 'v4';
export interface SessionHeaderView {
    id: string;
    createdAt: number;
    cwd: string;
    agentPreset: string;
    parentSession?: string;
}
export interface CompatibleMessage {
    seq: number;
    type: 'user/message' | 'assistant/message' | 'tool/result' | 'system/message' | 'developer/message';
    data: Record<string, unknown>;
}
export type SessionFailureReason = 'surface_replace' | 'cross_window_reference' | 'partial_frame' | 'invalid_offset' | 'sequence_mismatch' | 'compatibility_reject' | 'source_changed' | 'coverage_incomplete' | 'worker_failure' | 'unknown';
export type SessionFailurePhase = 'compressed_read' | 'decode' | 'compatibility' | 'delta_validate' | 'worker' | 'publish';
export interface SessionFailureDiagnostic {
    reasonCode: SessionFailureReason;
    phase: SessionFailurePhase;
    retryable: boolean;
}
/** Classification is set where a condition is observed, never parsed from error text. */
export declare class SessionParseError extends Error implements SessionFailureDiagnostic {
    readonly reasonCode: SessionFailureReason;
    readonly phase: SessionFailurePhase;
    readonly retryable: boolean;
    constructor(message: string, reasonCode: SessionFailureReason, phase: SessionFailurePhase, retryable?: boolean);
}
export declare function sessionFailureOf(value: unknown): SessionFailureDiagnostic;
export declare class SessionCompatibilityError extends SessionParseError {
    constructor(message: string, reason?: SessionFailureReason);
}
/** Exact alpha.3 decoder for JSONL's sourceEventSeqs storage encoding. */
export declare function decodeSourceEventSeqRanges(value: unknown, maxEntries?: number): number[];
/**
 * C9b（resume delta）：续读状态。
 *
 * DSH 会话文件是 append-only，且**只有第一帧带 header**（实测 349 个真实文件：
 * 0 个在后续帧重复写 header）。因此"只解新增帧"的窗口里没有 header 行——若不
 * 播种状态，`consumeLine` 会把窗口首个事件当 header 解析并抛
 * "unsupported or malformed session header"（这正是此前 delta 恒失败的原因）。
 */
export interface CompatResumeState {
    version: SessionCompatibilityVersion;
    /** 物理代际（0/1 legacy，2/3/4 modern）：决定行解码方式与 surface 事件表。 */
    generation: number;
    header: SessionHeaderView;
    /** 窗口首事件的期望 seq（上一轮解析到的 lastSeq + 1）。 */
    baseSeq: number;
}
/** 版本名 → 物理代际（`SessionMeta` 只持久化 `compatibility` 字符串）。 */
export declare function generationOfVersion(version: SessionCompatibilityVersion | undefined): number;
/**
 * Validates one JSONL session log (legacy v0/v1 or modern v2/v3) and folds its
 * current model-visible surface.  The raw log is never modified and
 * non-surface extension events remain opaque.
 */
export declare class SessionLogCompatibility {
    private _header;
    private _version;
    private _generation;
    /** C9：本次解析窗口内发生的 surface 替换次数（delta 安全性判据） */
    private _replaceOps;
    private expectedSeq;
    private resumeBaseSeq;
    private readonly surface;
    get header(): SessionHeaderView;
    get version(): SessionCompatibilityVersion;
    /** Physical format generation read from the header (0/1 legacy, 2/3 modern). */
    get generation(): number;
    /** C9：窗口内是否发生过 surface 替换。 */
    get replaceOps(): number;
    /** C9b：已消费的最大事件 seq（下次 delta 的窗口起点 = 本值 + 1）。
     * 未消费任何事件时为 -1（调用方按 0 起点处理）。 */
    get lastSeq(): number;
    /**
     * C9b（resume delta）：以"上一轮解析结果"播种状态，使**不含 header 的续读
     * 窗口**可被解析。仅由 parseFull 的 delta 路径调用；全量解析绝不调用
     * （它必须自己读到 header 并完成完整校验）。
     */
    resume(state: CompatResumeState): void;
    consumeLine(value: unknown): Record<string, unknown>[];
    finish(): CompatibleMessage[];
    /** Index traversal uses writer order after folding; model-visible positions stay intact. */
    finishBySource(): CompatibleMessage[];
    private consumeHeader;
    /** v0 (and its v1 successor): open key set, `version: 0/1`. */
    private consumeLegacyHeader;
    /**
     * v2/v3/v4: closed header shape.  `isSeeded` and `delegationDepth` are
     * required (a seeded log carries an inherited prefix up to its
     * `session/end-seed` marker), and `seedLength` is gone.  v4 keeps the same
     * logical header fields — the released v3→v4 edge only advances `version`
     * (`sessionFormatV3ToV4.migrateHeader`), so the key set is shared.
     */
    private consumeModernHeader;
    private consumeEvent;
    private consumeLegacyEvent;
    /**
     * One v2/v3 row.  The envelope is already one event (no packing), the key set
     * is closed, and `assistant/chunk` never appears.  Replacement ops are
     * normalized to `{op:'replace',start,end}` before folding so both released
     * encodings share one fold.
     */
    private consumeModernEvent;
    private foldSurface;
}
/** Extract indexable text from the message forms that the plugin exposes. */
export declare function textFromCompatibleMessage(message: CompatibleMessage): string;
