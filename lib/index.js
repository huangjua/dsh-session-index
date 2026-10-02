import z from '@deepseek-ai/schemastery';
import { join, basename, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { statSync, mkdirSync } from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { loadIndex, metaMatch, findSession, summarizeSession, resolveRoot, parseCursor, formatCursor, cursorStartIndex, scanSessionFiles, isRetainedSession, } from './core.js';
import { getBuilder, MAX_SCAN_FILES, sourceScanFingerprint } from './session-index-builder.js';
import { createSessionWatcher } from './watcher.js';
import { checkpointOf, FTS_PARSER_VERSION } from './fts.js';
import { createFtsClient } from './fts-client.js';
import { MATCH_OPEN, MATCH_CLOSE, normalizeReservedMarkers, queryUsesLikePath } from './fts.js';
// STAGE-1 Part A：会话级相关性排序（fzy 打分 + atuin 档位 + mcfly 特征 + tiebreak）
import { sortSessions } from './rank.js';
// STAGE-2 Part A：书签 sidecar 存储（codex session_index.rs 语义 + aider 幂等）
import { addBookmark, readBookmarks, removeBookmarks, bookmarkMatches, sortBookmarks, defaultLabel, BOOKMARK_FILE_NAME, BOOKMARK_LIST_LIMIT_DEFAULT, BOOKMARK_LIST_LIMIT_MAX, } from './bookmark.js';
// STAGE-4：可选 LLM 一句话摘要（红线 3 修订的唯一例外路径；provider 抽象 + 缓存单飞）
import { createHostLlmProvider, createLlmSummaryService, SUMMARY_CACHE_FILE_NAME, } from './llm-summary.js';
export const name = '@dsh-external/dsh-session-index';
export const inject = ['tools'];
export const DEFAULT_SEARCH_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_SEARCH_LINE_BYTES = 32 * 1024 * 1024;
export const MAX_SEARCH_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_SEARCH_DIAGNOSTICS = 20;
export const Config = z.object({
    sessionsRoot: z.string().default(''),
    indexFile: z.string().default(''),
    dataDir: z.string().default(''),
    maxHits: z.number().min(1).max(500).default(50),
    maxSnippetsPerSession: z.number().min(1).max(20).default(3),
    ftsEnabled: z.boolean().default(true),
    retentionDays: z.number().min(0).default(90),
    llmSummaryEnabled: z.boolean().default(true),
    deltaEnabled: z.boolean().default(true),
});
const text = (s) => [{ type: 'text', text: s }];
/**
 * P1.4：meta snippet 的命中区间标记（静态，无 LLM）。
 * 先归一化正文里已有的 >>> <<<（保留标记让位 snippet 专用），再包住首个命中。
 */
const markMatches = (raw, q) => {
    const t = normalizeReservedMarkers(raw);
    const idx = t.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1)
        return t;
    return t.slice(0, idx) + MATCH_OPEN + t.slice(idx, idx + q.length) + MATCH_CLOSE + t.slice(idx + q.length);
};
/** 从 session 文件路径取会话 id（与 builder 的 id 回退一致） */
const sessionIdFromFile = (file) => basename(dirname(file));
/**
 * C11：删除无引用的 synthMeta——FTS 命中若缺少索引条目，搜索路径直接
 * `if (!meta) continue` 丢弃，从不合成兜底 meta（函数建成后从未被接线）。
 */
/** session_list 扫描上限（Codex MAX_SCAN_FILES=10000；DSH 暂定 2000） */
const MAX_LIST_SCAN = 2000;
const ROLES = ['user', 'assistant', 'tool', 'any'];
/**
 * 归一化 filter 参数：非法 role 回退 'any'；非有限数字忽略；全默认（any + 无时间）
 * 返回 undefined（= 不带 filter，行为与改动前完全一致，逻辑零分支开销）。
 */
const normFilter = (f) => {
    if (!f || typeof f !== 'object')
        return undefined;
    const rawRole = f.role ?? 'any';
    const role = ROLES.includes(rawRole) ? rawRole : 'any';
    const out = { role };
    const since = Number(f.sinceMs);
    const until = Number(f.untilMs);
    if (Number.isFinite(since))
        out.sinceMs = since;
    if (Number.isFinite(until))
        out.untilMs = until;
    if (out.role === 'any' && out.sinceMs === undefined && out.untilMs === undefined)
        return undefined;
    return out;
};
/**
 * 会话级时间范围（降级口径：messages 无时间列 → meta.lastTime / sessions.last_time，
 * 三路径统一；schema 描述已注明）。
 */
const timePass = (s, f) => {
    if (!f)
        return true;
    if (typeof f.sinceMs === 'number' && s.lastTime < f.sinceMs)
        return false;
    if (typeof f.untilMs === 'number' && s.lastTime > f.untilMs)
        return false;
    return true;
};
/**
 * meta 路径的 role 判定：无消息粒度 → role='tool' 用 toolCallCounts 总和>0 近似
 * （schema 注明"会话级近似"）；user/assistant 无近似手段 → 恒 true 不过滤；
 * 'any' 恒 true。
 */
const metaRolePass = (s, role) => {
    if (!role || role === 'any' || role === 'user' || role === 'assistant')
        return true;
    if (role === 'tool') {
        let n = 0;
        for (const v of Object.values(s.toolCallCounts ?? {}))
            n += Number(v) || 0;
        return n > 0;
    }
    return true;
};
/** 用 scanner 已取得的指纹对账，不重复 stat；不完整扫描不判缺席删除。 */
export function indexNeedsReconcile(idx, root, scan, retentionDays, now = Date.now()) {
    if (resolve(idx.root) !== resolve(root))
        return true;
    const cutoff = retentionDays > 0 ? now - retentionDays * 86400e3 : 0;
    const previous = new Map(idx.sessions.map((s) => [s.file, s]));
    const retainedFiles = scan.files.filter((f) => isRetainedSession(f, previous.get(f.file), cutoff));
    const seen = new Set(retainedFiles.map((f) => f.file));
    for (const f of retainedFiles) {
        const old = previous.get(f.file);
        if (!old || old.detailMissing || old.size !== f.size || old.mtimeMs !== f.mtimeMs || old.ctimeMs !== f.ctimeMs)
            return true;
    }
    return scan.complete && idx.sessions.some((s) => !seen.has(s.file));
}
export function apply(ctx, config, dependencies = {}) {
    const scanFiles = dependencies.scanSessionFiles ?? scanSessionFiles;
    const makeWatcher = dependencies.createSessionWatcher ?? createSessionWatcher;
    const runtimeDiagnostics = [];
    let ftsStartup = null;
    const recordRuntime = (event) => {
        runtimeDiagnostics.push(event);
        if (runtimeDiagnostics.length > 100)
            runtimeDiagnostics.shift();
        try {
            void Promise.resolve(dependencies.onRuntimeDiagnostic?.(event)).catch(() => { });
        }
        catch { /* diagnostics cannot change a committed result */ }
    };
    const makeFts = dependencies.createSessionFts ?? ((path) => createFtsClient(path, {
        onRecovered: () => { if (!abortController.signal.aborted)
            triggerAutoRefresh('fts-worker-recovered'); },
        onRequestDiagnostic: event => recordRuntime({ kind: 'fts-request', ...event }),
        onStartupProgress: event => { ftsStartup = event; recordRuntime({ kind: 'fts-startup', ...event }); },
        onStartupFailure: event => { ftsStartup = event; recordRuntime({ kind: 'fts-startup-failure', ...event }); },
    }));
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
    // 派生数据目录：默认 $DSH_HOME/session-index；dataDir 可把整份索引移出系统盘。
    const dataDir = config.dataDir
        ? (isAbsolute(config.dataDir) ? resolve(config.dataDir) : resolve(process.cwd(), config.dataDir))
        : join(dshHome, 'session-index');
    try {
        mkdirSync(dataDir, { recursive: true });
    }
    catch (error) {
        // 目录建不出来不阻断装载：后续写入会各自报错，这里只留一条诊断。
        console.warn(`[session-index] cannot create dataDir ${dataDir}: ${String(error)}`);
    }
    const sessionsRoot = resolveRoot(config.sessionsRoot);
    const indexFile = config.indexFile || join(dataDir, 'index.json');
    /* ── STAGE-4：可选 LLM 一句话摘要（红线 3 修订的唯一例外路径）────────────
     * 服务只挂 session_summary 工具路径与 status 健康快照；构建/扫描路径零调用。
     * llmSummaryEnabled=false → 完全不构造 provider、不触碰 ctx.llm（零执行）。
     * 生产 provider 走宿主 ctx.llm 流式聚合（E1：宿主只有流式对话 API）。
     * **懒解析**：宿主 llm 服务可能晚于插件 apply 就绪（线上实证 apply 期决议为
     * 空），故每次 getSummary/health 时才 createHostLlmProvider(ctx)；决议失败 →
     * session_summary 回退确定性摘要 + status 记 lastError + 本日志记录原因。 */
    const llmSummaryEnabled = config.llmSummaryEnabled !== false;
    /** 懒解析（宿主 llm 服务可能晚于 apply 就绪/适配器后注册）：
     * - 成功结果记忆复用；失败不记忆（每次 health/getSummary 重试，晚起的服务
     *   可被拾起），失败原因日志按 30s 节流避免 status 轮询刷屏；
     * - createHostLlmProvider 内部经 ctx.get 免注入读取（cordis 守卫 + fail-open）；
     * - llmSummaryEnabled=false → 完全不触碰 ctx.llm（零执行）。 */
    let hostProvider = null;
    let lastUnavailableLogAt = 0;
    const onProviderUnavailable = (reason) => {
        const now = Date.now();
        if (now - lastUnavailableLogAt > 30_000) {
            lastUnavailableLogAt = now;
            log(`[session-index] llmSummary provider 不可用: ${reason}（确定性回退）`);
        }
    };
    const resolveLlmProvider = () => {
        if (!llmSummaryEnabled)
            return null;
        if (hostProvider)
            return hostProvider;
        const p = createHostLlmProvider(ctx, onProviderUnavailable);
        if (p)
            hostProvider = p;
        return p;
    };
    const llmSummary = createLlmSummaryService({
        enabled: llmSummaryEnabled,
        provider: resolveLlmProvider,
        cacheFile: join(dataDir, SUMMARY_CACHE_FILE_NAME),
    });
    let log;
    try {
        const logger = ctx.logger('session-index');
        log = (msg) => logger.info(msg);
    }
    catch {
        log = (msg) => console.info(msg);
    }
    const builder = getBuilder(sessionsRoot, indexFile);
    const abortController = new AbortController();
    const startupWaits = new Set();
    function waitForStartupRetry(ms) {
        if (abortController.signal.aborted)
            return Promise.resolve();
        return new Promise((resolveWait) => {
            const finish = () => {
                clearTimeout(timer);
                abortController.signal.removeEventListener('abort', finish);
                startupWaits.delete(finish);
                resolveWait();
            };
            const timer = setTimeout(finish, ms);
            startupWaits.add(finish);
            abortController.signal.addEventListener('abort', finish, { once: true });
        });
    }
    /* ── P2：SQLite + FTS5 全文索引（异步启用，失败静默降级）────────────── */
    let fts = null;
    const ftsDbPath = join(dataDir, 'fts.db');
    let dirtyObserved = null;
    let dirtyCheck = null;
    const dirtyKey = (metas, store) => JSON.stringify([
        store && 'diagnostics' in store ? store.diagnostics().writerGeneration : 0,
        metas.map(meta => [meta.file, meta.size, meta.mtimeMs, meta.ctimeMs, meta.indexedBytes, meta.indexedSeq, meta.ftsDirty, meta.coverage?.complete]),
    ]);
    async function countDirty(metas, store = fts) {
        if (!store?.ok)
            return 0;
        const key = dirtyKey(metas, store);
        if (dirtyObserved?.key === key && dirtyObserved.count === 0 && Date.now() - dirtyObserved.at < 1000)
            return 0;
        if (dirtyCheck?.key === key)
            return dirtyCheck.promise;
        const promise = (async () => {
            let count = 0;
            for (let start = 0; start < metas.length; start += 32) {
                count += (await Promise.all(metas.slice(start, start + 32).map(meta => store.needsSync(meta)))).filter(Boolean).length;
            }
            if (store === fts)
                dirtyObserved = { key, count, at: Date.now() };
            return count;
        })().finally(() => { if (dirtyCheck?.promise === promise)
            dirtyCheck = null; });
        dirtyCheck = { key, promise };
        return promise;
    }
    /** 统一 build 选项：任何构建都带上 FTS 钩子（collectMessages + 解析/删除回调）
   * 与 P3 保留过滤（retentionDays 进底座：任何顺序的构建（watcher 事件/对账/
   * 回填/保留专用）都按策略过滤超龄条目——实测竞态：若只有保留专用构建带
   * retentionDays，先起的无过滤构建会把保留构建单飞吸收（选项丢失 → pruned=0），
   * 或 prune 后的对账/事件构建把超龄条目重拾回索引。底座统一后任何构建先跑
   * 结果一致，watermark 只门控启动日的 VACUUM 专用通道。 */
    const ftsBuildOptions = (extra = {}) => ({
        ...extra,
        signal: extra.signal ?? abortController.signal,
        onProgress,
        retentionDays: extra.retentionDays ?? config.retentionDays ?? 90,
        deltaEnabled: config.deltaEnabled !== false,
        onDeltaDiagnostic: event => recordRuntime({ kind: 'delta', ...event }),
        collectMessages: fts?.ok ?? false,
        needsFtsSync: async (meta) => await fts?.needsSync(meta) ?? false,
        canAppendFts: async (meta) => !!fts && !(await fts.needsSync(meta)),
        flushFts: () => fts?.flush() ?? Promise.resolve(),
        onSessionParsed: async (file, meta, messages, append, previous) => {
            if (!fts?.ok)
                throw new Error('FTS unavailable during parsed-session commit; retry from checkpoint');
            if (append && (!previous || await fts.needsSync(previous))) {
                throw new Error('FTS delta base changed during parsing; full retry required');
            }
            return fts.syncSession({
                meta,
                sourceFingerprint: checkpointOf(meta),
                parserVersion: FTS_PARSER_VERSION,
                mode: append ? 'append' : 'replace',
                expectedBase: append && previous ? await fts.getCheckpoint(previous.file) ?? undefined : undefined,
                messages,
            });
        },
        onSessionRemoved: (file) => fts?.removeSession(file),
    });
    /* ── P3：索引保留策略（Hermes maybe_auto_prune_and_vacuum 的 DSH 适配）──────
     *
     * 启动期执行一次（FTS 就绪后、回填之后——保留清理必须是启动序列最后一次构建，
     * 否则在飞/后续构建会按事实源重拾磁盘上的超龄条目）：
     * - retentionDays<=0 → 策略关闭（log 注明）；
     * - fts 未启用 → 整个策略跳过（watermark 放在 fts.db state_meta，log 注明）；
     * - last_prune 距今 <24h → 跳过（照 Hermes 每日一次语义）；
     * - 经 builder.build({ retentionDays }) 在 merge 阶段把 max(lastTime, mtimeMs)
     *   超龄条目从 index.json 移除，并经 onSessionRemoved 通道同步删 fts.db 行
     *   （fts.removeSession）——**绝不触碰 ~/.dsh/sessions 下的会话文件**；
     * - 写 last_prune watermark（无论数量；跨进程共享于 fts.db）；
     * - 仅当本次 pruned>0 时 fts.vacuum()（其内部先 optimize；照 Hermes
     *   "VACUUM only when pruned>0"）；
     * - 任何失败只 log 不抛出（照 Hermes "never raises"）；VACUUM 是同步重型操作，
     *   只出现在本启动路径，绝不出现在工具调用路径。
     *
     * 已知行为（文档化）：本策略的执行点是"启动期每日一次对账"。运行中的工具构建
     * 按磁盘事实源重建索引（会话文件仍在则重新收录），下次启动再行清理；由于
     * DSH 部署重启频繁，索引实际大部分时间保持策略约束内。
     */
    async function maybeRetentionPrune() {
        if (abortController.signal.aborted)
            return;
        const days = config.retentionDays ?? 90;
        if (!(days > 0)) {
            log('[session-index] retention disabled (retentionDays=0)');
            return;
        }
        if (!fts?.ok) {
            log('[session-index] retention skipped: FTS unavailable (watermark 需要 fts.db)');
            return;
        }
        try {
            const last = await fts.lastPruneAt();
            if (last > 0 && Date.now() - last < 24 * 3600 * 1000) {
                log(`[session-index] retention skipped: last prune <24h ago (${new Date(last).toISOString()})`);
                return;
            }
            const report = await builder.build(ftsBuildOptions({ retentionDays: days }));
            if (abortController.signal.aborted)
                return;
            // 注意：即便本调用被在飞构建单飞吸收，底座也已统一携带 retentionDays——任一
            // 构建都会过滤超龄条目，pruned 计数来自实际执行的构建，语义一致。
            // ⚠️ 只有 completed 才算一次成功的保留尝试：skipped/failed（如 reload 期间
            // 旧 fiber 的 run-marker 未及释放）不写 watermark——否则按"已尝试"记账，
            // 24h 内不再重试，而实际 prune 可能根本没跑。
            if (report.status !== 'completed') {
                log(`[session-index] retention attempt ${report.status}; watermark 未写入（下次启动重试）`);
                return;
            }
            await fts.markPruned(report.pruned);
            if (report.pruned > 0) {
                // 等 onSessionRemoved（removeSession）写链落盘，再 VACUUM（内部先 optimize）
                await fts.flush();
                if (abortController.signal.aborted)
                    return;
                await fts.vacuum();
            }
            log(`[session-index] retention day=${days}d pruned=${report.pruned} status=${report.status} vacuum=${report.pruned > 0} (会话文件未动)`);
        }
        catch (e) {
            log(`[session-index] retention prune failed (never raises): ${String(e)}`);
        }
    }
    const ftsInitialization = (config.ftsEnabled !== false
        ? makeFts(ftsDbPath).then(async (f) => {
            if (abortController.signal.aborted) {
                await f?.close();
                return;
            }
            fts = f;
            if (f?.ok) {
                // Full FTS optimization belongs to explicit maintenance/retention,
                // outside the startup and normal query path.
                if (abortController.signal.aborted)
                    return;
                log(`[session-index] FTS enabled: ${ftsDbPath}`);
                try {
                    // Per-session committed checkpoints recover JSON-ahead and legacy
                    // metadata-only databases; counts are never synchronization evidence.
                    const pending = () => countDirty(loadIndex(indexFile)?.sessions ?? [], f);
                    for (let attempt = 0; attempt < 4 && !abortController.signal.aborted; attempt++) {
                        const behind = await pending();
                        if (attempt > 0 && behind === 0)
                            break;
                        log(`[session-index] FTS reconcile pending=${behind} attempt=${attempt + 1}`);
                        const report = await builder.build(ftsBuildOptions({ force: behind > 0 && builder.active }));
                        if (abortController.signal.aborted)
                            return;
                        if (await pending() === 0 && report.status !== 'skipped')
                            break;
                        if (attempt < 3)
                            await waitForStartupRetry(1000);
                    }
                    if (abortController.signal.aborted)
                        return;
                    // An absent JSON entry may be a previously failed FTS deletion. Only
                    // a complete scan proves absence/expiry. New on-disk files are kept
                    // for the builder to reconcile, rather than deleted as orphans.
                    const currentIndex = loadIndex(indexFile);
                    if (currentIndex && currentIndex.root === sessionsRoot) {
                        const scan = await scanFiles(sessionsRoot, { signal: abortController.signal, cap: MAX_SCAN_FILES });
                        if (abortController.signal.aborted)
                            return;
                        const byFile = new Map(currentIndex.sessions.map(meta => [meta.file, meta]));
                        const cutoff = (config.retentionDays ?? 90) > 0 ? Date.now() - (config.retentionDays ?? 90) * 86400e3 : 0;
                        const retainedDisk = new Set(scan.files.filter(file => isRetainedSession(file, byFile.get(file.file), cutoff)).map(file => file.file));
                        for (const file of await f.listSessionFiles()) {
                            const meta = byFile.get(file);
                            if (meta?.unindexable || (scan.complete && !meta && !retainedDisk.has(file))) {
                                try {
                                    await f.removeSession(file);
                                }
                                catch (error) {
                                    log(`[session-index] FTS orphan removal failed ${file}: ${String(error)}`);
                                }
                            }
                        }
                        try {
                            await f.flush();
                        }
                        catch (error) {
                            log(`[session-index] FTS reconcile writes failed: ${String(error)}`);
                        }
                    }
                    await maybeRetentionPrune();
                }
                catch (e) {
                    log(`[session-index] startup sequence error: ${String(e)}`);
                }
            }
            else {
                log('[session-index] FTS unavailable; mode=full falls back to streaming search');
            }
        }).catch((e) => {
            if (!abortController.signal.aborted)
                log(`[session-index] FTS initialization failed: ${String(e)}`);
        })
        : (() => {
            // P2.1：配置关闭 → 不 import node:sqlite、不建库；回退路径与 SCROLL 错误对象已存在。
            // P3：fts 未启用时整个保留策略跳过（watermark 需要 fts.db）
            log('[session-index] FTS disabled by config (ftsEnabled=false); mode=full falls back to streaming search; retention skipped (watermark 需要 fts.db)');
        })());
    // 进度日志：节流 500ms（对应 BuildReport 的可观测性设计）
    let lastLogAt = 0;
    const onProgress = (p) => {
        const now = Date.now();
        if (now - lastLogAt < 500)
            return;
        lastLogAt = now;
        log(`[session-index] ${p.processed}/${p.total} (${p.phase}) scanned=${(p.scannedBytes / 1e6).toFixed(1)}MB delay=${p.delayMs}ms`);
    };
    async function ensureIndex(refresh, signal) {
        if (abortController.signal.aborted)
            throw new Error('会话索引已卸载');
        if (!refresh) {
            const existing = loadIndex(indexFile);
            if (existing) {
                // 自愈（P0-2 改造）：detailMissing 条目 → 后台增量补齐；磁盘对账交给
                // watcher（变更驱动），不再每次调用全目录 stat。watcher 不可用时走
                // 10s 节流 stat 回退。single-flight 保证不并发重复构建。
                void maybeAutoRefresh(existing).catch(error => log(`[session-index] auto reconcile check failed: ${String(error)}`));
                return existing;
            }
        }
        const report = await builder.build(ftsBuildOptions({ force: refresh, signal: signal ?? abortController.signal }));
        if (report.status === 'skipped') {
            const existing = loadIndex(indexFile);
            if (existing)
                return existing;
            throw new Error('索引构建被其他进程占用且无可用索引');
        }
        const loaded = loadIndex(indexFile);
        if (!loaded)
            throw new Error('会话索引构建后仍无法加载');
        return loaded;
    }
    /* ── P0-2：自动增量补扫（watcher 变更驱动 + dirty/单飞循环 + 频率上限）── */
    const MIN_AUTO_BUILD_INTERVAL_MS = 5000;
    let autoRefreshRunning = false;
    let autoRefreshDirty = false;
    let unstableRefreshAttempts = 0;
    let sourceLagging = false;
    let lastAutoBuildAt = 0;
    let deferTimer = null;
    let fallbackTimer = null;
    let laggingTimer = null;
    let laggingFingerprint;
    let laggingPollRunning = false;
    let watcherOk = false;
    function clearDeferTimer() {
        if (deferTimer) {
            clearTimeout(deferTimer);
            deferTimer = null;
        }
    }
    async function rememberLaggingSource() {
        // Remember the snapshot actually parsed. A fresh scan after rejection can
        // already contain a completed frame and would swallow its final write.
        laggingFingerprint = builder.lastSourceScanFingerprint ?? laggingFingerprint;
    }
    function clearLaggingPolling() {
        if (laggingTimer)
            clearInterval(laggingTimer);
        laggingTimer = null;
        laggingFingerprint = undefined;
    }
    function startLaggingPolling() {
        if (laggingTimer || abortController.signal.aborted)
            return;
        // After three failed parses, only stat fingerprints. An unchanged partial
        // frame must not cause infinite full parses; a later write still heals if
        // its final watcher event was lost.
        laggingTimer = setInterval(() => {
            if (!sourceLagging || autoRefreshRunning || laggingPollRunning || abortController.signal.aborted)
                return;
            laggingPollRunning = true;
            void scanFiles(sessionsRoot, { cap: MAX_SCAN_FILES, signal: abortController.signal }).then(scan => {
                const fingerprint = sourceScanFingerprint(scan);
                if (fingerprint !== laggingFingerprint) {
                    laggingFingerprint = fingerprint;
                    triggerAutoRefresh('lagging-fingerprint-changed');
                }
            }).catch(() => { }).finally(() => { laggingPollRunning = false; });
        }, 10_000);
        laggingTimer.unref();
    }
    function triggerAutoRefresh(reason) {
        if (abortController.signal.aborted)
            return;
        if (sourceLagging && unstableRefreshAttempts >= 3 && reason !== 'lagging-fingerprint-changed'
            && reason !== 'fts-worker-recovered') {
            void reconcileDisk(reason, true);
            return;
        }
        if (reason !== 'dirty-while-running' && reason !== 'deferred')
            unstableRefreshAttempts = 0;
        if (autoRefreshRunning) {
            autoRefreshDirty = true;
            return;
        }
        const now = Date.now();
        const wait = lastAutoBuildAt + MIN_AUTO_BUILD_INTERVAL_MS - now;
        if (wait > 0) {
            // 频率上限内：标记 dirty + 定时器兜底（避免事件停止后 dirty 悬空）
            autoRefreshDirty = true;
            if (!deferTimer) {
                deferTimer = setTimeout(() => {
                    deferTimer = null;
                    if (autoRefreshDirty && !autoRefreshRunning && !abortController.signal.aborted) {
                        autoRefreshDirty = false;
                        triggerAutoRefresh('deferred');
                    }
                }, wait + 50);
            }
            return;
        }
        lastAutoBuildAt = now;
        autoRefreshRunning = true;
        log(`[session-index] auto refresh (${reason})`);
        builder
            .build(ftsBuildOptions({ force: false, signal: abortController.signal }))
            .then(async (r) => {
            sourceLagging = r.status === 'failed' || r.scanComplete === false || (r.raced ?? 0) > 0 || (r.failed ?? 0) > 0 || (r.ftsFailed ?? 0) > 0 ||
                builder.lastDeltaDiagnostics.some(event => (event.phase === 'commit' || event.phase === 'complete') && event.finalConsistency === 'source_changed');
            if (sourceLagging) {
                await rememberLaggingSource();
                startLaggingPolling();
                if (++unstableRefreshAttempts < 3)
                    autoRefreshDirty = true;
            }
            else {
                unstableRefreshAttempts = 0;
                clearLaggingPolling();
            }
            if (r.status === 'completed') {
                log(`[session-index] auto refresh done: added=${r.added} updated=${r.updated} removed=${r.removed}`);
            }
        })
            .catch(async (e) => {
            sourceLagging = true;
            await rememberLaggingSource();
            startLaggingPolling();
            if (++unstableRefreshAttempts < 3)
                autoRefreshDirty = true;
            log(`[session-index] auto refresh failed: ${String(e)}`);
        })
            .finally(() => {
            autoRefreshRunning = false;
            if (autoRefreshDirty && !abortController.signal.aborted) {
                autoRefreshDirty = false;
                triggerAutoRefresh('dirty-while-running');
            }
        });
    }
    /**
     * 工具调用时的自愈检查（轻量，绝不 stat 目录）：
     * - detailMissing 条目 → 后台增量补齐；
     * - watcher 不可用 → 回退 10s 节流指纹对账。
     */
    let lastFallbackScanAt = 0;
    let fallbackScanRunning = false;
    async function reconcileDisk(reason, force = false) {
        if (abortController.signal.aborted || fallbackScanRunning)
            return;
        const now = Date.now();
        if (!force && now - lastFallbackScanAt < 10_000)
            return;
        lastFallbackScanAt = now;
        fallbackScanRunning = true;
        try {
            const scan = await scanFiles(sessionsRoot, { cap: MAX_SCAN_FILES, signal: abortController.signal });
            if (abortController.signal.aborted)
                return;
            if (sourceLagging && sourceScanFingerprint(scan) === laggingFingerprint)
                return;
            const current = loadIndex(indexFile);
            if (current && indexNeedsReconcile(current, sessionsRoot, scan, config.retentionDays ?? 90)) {
                triggerAutoRefresh(sourceLagging ? 'lagging-fingerprint-changed' : reason);
            }
            if (!scan.complete)
                log(`[session-index] reconcile incomplete: ${scan.errors.join('; ') || 'scan cap reached'}`);
        }
        catch (e) {
            if (!abortController.signal.aborted)
                log(`[session-index] reconcile failed: ${String(e)}`);
        }
        finally {
            fallbackScanRunning = false;
        }
    }
    function startFallbackPolling() {
        if (fallbackTimer || abortController.signal.aborted)
            return;
        fallbackTimer = setInterval(() => { void reconcileDisk('watcher-fallback'); }, 10_000);
        fallbackTimer.unref();
    }
    async function maybeAutoRefresh(idx) {
        if (abortController.signal.aborted)
            return;
        if (idx.sessions.some(s => s.detailMissing) || await countDirty(idx.sessions) > 0) {
            triggerAutoRefresh('detailMissing-or-fts-dirty');
            return;
        }
        if (watcherOk)
            return; // watcher 已覆盖磁盘对账
        void reconcileDisk('tool-fallback');
    }
    // watcher：变更驱动自动增量（P0-2）。失败回退到上面的 10s 节流 stat。
    const watcher = makeWatcher(sessionsRoot, 500, () => { if (sourceLagging)
        void reconcileDisk('watch', true);
    else
        triggerAutoRefresh('watch'); }, () => {
        if (watcherOk) {
            watcherOk = false;
            log('[session-index] watcher lost; fall back to throttled scan');
        }
        startFallbackPolling();
        void reconcileDisk('watcher-lost', true);
    });
    watcherOk = watcher.ok;
    if (watcherOk) {
        log(`[session-index] watcher active on ${sessionsRoot}`);
    }
    else {
        log(`[session-index] watcher unavailable; fall back to throttled scan`);
        startFallbackPolling();
    }
    // 启动一次性对账：插件加载前可能已新增/删除会话（watcher 只覆盖加载后）。
    void reconcileDisk('startup-reconcile', true);
    async function statusSnapshot() {
        const idx = loadIndex(indexFile);
        const progress = builder.progress;
        const last = builder.lastBuildReport;
        // P2.2：FTS 健康数据只取一次（3 个 SQL + 1 stat）
        const ftsHealthData = fts?.ok ? await fts.health() : null;
        const ftsSessions = Number(ftsHealthData?.sessions ?? (fts?.ok ? await fts.sessionCount() : 0));
        const sameObserved = dirtyObserved?.key === dirtyKey(idx?.sessions ?? [], fts);
        const dirtySessions = sameObserved ? dirtyObserved.count : idx?.sessions.filter(meta => meta.ftsDirty).length ?? 0;
        const out = {
            root: sessionsRoot,
            indexFile,
            sessions: idx?.sessions.length ?? 0,
            files: idx?.sessions.length ?? 0,
            updatedAt: idx?.updatedAt ?? 0,
            active: builder.active,
            sourceLagging,
            unstableRefreshAttempts,
            laggingFingerprintPolling: laggingTimer !== null,
            // P2：FTS 全文索引状态（平铺字段，v1 兼容，保持原键名与原类型）
            fts: fts?.ok ?? false,
            ftsSessions: ftsSessions,
            // P2.2：FTS 健康快照。注意 fts 平铺是 boolean（v1 兼容），嵌套健康组另用
            // ftsHealth 键避免冲突：enabled=配置开关 / ok=运行状态 / sessions=会话行 /
            // messages=消息行 / dbSizeBytes=库字节（stat 失败 0）/ lastOptimizeAt=水印 /
            // schemaVersion=库 schema 版本（state_meta，缺省 ''）/ lastPruneAt+lastPruneCount=
            // 最近一次保留清理时间与数量（P3，state_meta，缺省 0）。
            ftsHealth: {
                enabled: config.ftsEnabled !== false,
                ok: fts?.ok ?? false,
                sessions: ftsSessions,
                messages: ftsHealthData?.messages ?? 0,
                dbSizeBytes: ftsHealthData?.dbSizeBytes ?? 0,
                lastOptimizeAt: ftsHealthData?.lastOptimizeAt ?? 0,
                schemaVersion: ftsHealthData?.schemaVersion ?? '',
                lastPruneAt: ftsHealthData?.lastPruneAt ?? 0,
                lastPruneCount: ftsHealthData?.lastPruneCount ?? 0,
                lastWriteError: ftsHealthData?.lastWriteError ?? '',
                lastWriteErrorAt: ftsHealthData?.lastWriteErrorAt ?? 0,
                pendingWrites: ftsHealthData?.pendingWrites ?? 0,
                failedSessions: ftsHealthData?.failedSessions ?? 0,
                dirtySessions: dirtySessions,
                dirtySessionsExact: false,
                dirtySessionsObservedAt: sameObserved ? dirtyObserved?.at ?? 0 : 0,
                acceptingWrites: ftsHealthData?.acceptingWrites ?? false,
                worker: fts && 'diagnostics' in fts ? fts.diagnostics() : null,
                startup: ftsStartup,
                recentRuntimeDiagnostics: runtimeDiagnostics.slice(-30),
                recentDeltaDiagnostics: builder.lastDeltaDiagnostics,
                incompleteSessions: idx?.sessions.filter(meta => meta.coverage?.complete === false).length ?? 0,
            },
            // P3：保留策略配置（可观测；0=关闭）
            retentionDays: config.retentionDays ?? 90,
            // STAGE-4：LLM 摘要健康快照（enabled=开关 / ok=最近调用成功且 provider 可用 /
            // cached=sidecar 有效条目数 / lastError=最近失败原因（无则 null）/
            // provider=决议出的 provider 路由 id（不可用为 ''））。只读缓存计数，
            // 绝不在此路径触发任何 LLM 调用（成本护栏）。
            llmSummaryHealth: await llmSummary.health(),
            // P2-7：v1 兼容字段平铺到顶层（旧调用方无感）
            detailMissing: idx ? idx.sessions.filter((s) => s.detailMissing).length : 0,
            added: last?.added ?? 0,
            updated: last?.updated ?? 0,
            skipped: last?.skipped ?? 0,
            removed: last?.removed ?? 0,
            raced: last?.raced ?? 0,
            failed: last?.failed ?? 0,
            scannedBytes: last?.scannedBytes ?? 0,
            errors: last?.errors ?? [],
        };
        if (progress) {
            out.progress = { phase: progress.phase, processed: progress.processed, total: progress.total, scannedBytes: progress.scannedBytes, delayMs: progress.delayMs };
        }
        if (last) {
            out.lastReport = {
                status: last.status,
                totalFiles: last.totalFiles,
                processed: last.processed,
                headParsed: last.headParsed,
                fullParsed: last.fullParsed,
                added: last.added,
                updated: last.updated,
                skipped: last.skipped,
                removed: last.removed,
                raced: last.raced,
                failed: last.failed,
                scanComplete: last.scanComplete,
                scanTruncated: last.scanTruncated,
                failedSubtrees: last.failedSubtrees,
                ftsSynced: last.ftsSynced,
                ftsFailed: last.ftsFailed,
                scannedBytes: last.scannedBytes,
                // C9b 后续：观测管道修复——漏拷这两个字段导致 status 渲染行恒显
                // deltaParsed=0/deltaFallbacks=0（builder 计数正确，只是没送达渲染层）。
                discoveredBytes: last.discoveredBytes,
                readBytes: last.readBytes,
                decodedBytes: last.decodedBytes,
                deltaBytes: last.deltaBytes,
                incompleteSessions: last.incompleteSessions,
                deltaParsed: last.deltaParsed,
                deltaFallbacks: last.deltaFallbacks,
                durationMs: last.durationMs,
                maxEventLoopDelayMs: last.maxEventLoopDelayMs,
                partialCommitted: last.partialCommitted ?? false,
                errors: last.errors,
            };
        }
        return out;
    }
    /* ── 工具 1：索引状态 ── */
    const toolStatus = defineTool({
        name: 'session_index_status',
        description: '查看/刷新 DSH 会话索引状态与构建进度。refresh=后台重建（可轮询 progress）；cancel=取消构建。',
        parameters: {
            refresh: { type: 'boolean', description: '后台强制重建（不阻塞，随后可查 progress）' },
            cancel: { type: 'boolean', description: '取消进行中的构建' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    root: { type: 'string' },
                    indexFile: { type: 'string' },
                    sessions: { type: 'integer' },
                    files: { type: 'integer' },
                    updatedAt: { type: 'integer' },
                    active: { type: 'boolean' },
                    fts: { type: 'boolean' },
                    ftsSessions: { type: 'integer' },
                    detailMissing: { type: 'integer' },
                    // STAGE-4：LLM 摘要健康快照（lastError 用 oneOf 允许 null，防 defineTool
                    // 严格校验拒绝——书签 messageId 同款坑，见 STAGE-2 记录）
                    llmSummaryHealth: {
                        type: 'object',
                        additionalProperties: true,
                        properties: {
                            enabled: { type: 'boolean' },
                            ok: { type: 'boolean' },
                            cached: { type: 'integer' },
                            lastError: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                            provider: { type: 'string' },
                        },
                    },
                    progress: {
                        type: 'object',
                        additionalProperties: true,
                        properties: {
                            phase: { type: 'string' },
                            processed: { type: 'integer' },
                            total: { type: 'integer' },
                            delayMs: { type: 'integer' },
                        },
                    },
                    lastReport: {
                        type: 'object',
                        additionalProperties: true,
                        properties: {
                            status: { type: 'string' },
                            totalFiles: { type: 'integer' },
                            added: { type: 'integer' },
                            updated: { type: 'integer' },
                            removed: { type: 'integer' },
                            failed: { type: 'integer' },
                            durationMs: { type: 'integer' },
                            errors: { type: 'array', items: { type: 'string' } },
                        },
                    },
                },
            },
            render: (_args, v) => {
                const lines = [
                    `[session-index] root=${v.root}`,
                    `sessions=${v.sessions} files=${v.files} updatedAt=${v.updatedAt}`,
                ];
                // P2.2：FTS 健康摘要行（与返回对象 ftsHealth 一致）
                const fh = v.ftsHealth;
                if (fh) {
                    const opt = fh.lastOptimizeAt && fh.lastOptimizeAt > 0 ? new Date(fh.lastOptimizeAt).toISOString() : '-';
                    lines.push(`fts: ${fh.enabled ? 'on' : 'off'} ${fh.ok ? 'ok' : 'unavailable'} sessions=${fh.sessions ?? 0} messages=${fh.messages ?? 0} db=${((fh.dbSizeBytes ?? 0) / 1048576).toFixed(2)}MB lastOptimize=${opt} schema=${fh.schemaVersion ?? ''}`);
                    lines.push(`ftsSync: dirty=${fh.dirtySessions ?? 0} pending=${fh.pendingWrites ?? 0} failed=${fh.failedSessions ?? 0}${fh.lastWriteError ? ` lastError=${fh.lastWriteError}` : ''}`);
                    if (fh.startup) {
                        const startup = fh.startup, progress = startup.progress;
                        const token = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : '-';
                        const count = (value) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : '-';
                        lines.push(`ftsStartup: role=${token(startup.role)} state=${token(startup.state)} phase=${token(progress?.phase)} completed=${progress ? count(progress.completed) : '-'} total=${progress ? count(progress.total) : '-'} elapsedMs=${count(startup.elapsedMs)} code=${token(startup.error?.code)}`);
                    }
                }
                // P3：保留策略摘要（retentionDays + 最近一次 prune 时间/数量）
                const lp = fh?.lastPruneAt && fh.lastPruneAt > 0 ? new Date(fh.lastPruneAt).toISOString() : '-';
                lines.push(`retention: days=${v.retentionDays ?? 90} lastPrune=${lp} count=${fh?.lastPruneCount ?? 0}`);
                // STAGE-4：LLM 摘要健康摘要行（与返回对象 llmSummaryHealth 一致）
                const lh = v.llmSummaryHealth;
                if (lh) {
                    lines.push(`llmSummary: ${lh.enabled ? 'on' : 'off'} ${lh.ok ? 'ok' : 'unavailable'} cached=${lh.cached ?? 0} provider=${lh.provider ?? ''}${lh.lastError ? ` lastError=${String(lh.lastError).slice(0, 120)}` : ''}`);
                }
                if (v.active) {
                    const p = v.progress;
                    lines.push(p ? `building: ${p.phase} ${p.processed}/${p.total} scanned=${(p.scannedBytes / 1e6).toFixed(1)}MB delay=${p.delayMs}ms` : 'building…');
                }
                const last = v.lastReport;
                if (last) {
                    lines.push(`scan: complete=${last.scanComplete ?? 'unknown'} truncated=${last.scanTruncated ?? false} ftsSynced=${last.ftsSynced ?? 0} ftsFailed=${last.ftsFailed ?? 0}`);
                    lines.push(`lastBuild: status=${last.status} added=${last.added ?? 0} updated=${last.updated ?? 0} skipped=${last.skipped ?? 0} removed=${last.removed ?? 0} raced=${last.raced ?? 0} failed=${last.failed ?? 0} scannedBytes=${last.scannedBytes ?? 0} deltaParsed=${last.deltaParsed ?? 0} deltaFallbacks=${last.deltaFallbacks ?? 0} durationMs=${last.durationMs ?? 0}${last.partialCommitted ? ' partialCommitted' : ''}`);
                    if (last.errors?.length)
                        lines.push(`errors=${last.errors.length}`);
                }
                if (v.detailMissing)
                    lines.push(`detailMissing=${v.detailMissing}（自动补扫中）`);
                return text(lines.filter(Boolean).join('\n'));
            },
        },
        execute: async (args) => {
            if (args.cancel) {
                builder.cancel();
                return { ...(await statusSnapshot()), cancelled: true };
            }
            if (args.refresh) {
                // 后台触发，不阻塞：单飞保证不会重复构建
                void builder
                    .build(ftsBuildOptions({ force: true, signal: abortController.signal }))
                    .then((report) => {
                    if (report.status === 'completed') {
                        log(`[session-index] build completed: added=${report.added} updated=${report.updated} skipped=${report.skipped} removed=${report.removed} raced=${report.raced} failed=${report.failed} ${report.durationMs}ms`);
                    }
                    else if (report.status !== 'cancelled') {
                        log(`[session-index] build ${report.status}: ${report.errors.join('; ').slice(0, 300)}`);
                    }
                })
                    .catch((e) => log(`[session-index] build failed: ${String(e)}`));
            }
            return (await statusSnapshot());
        },
    });
    /* ── 工具 2：会话列表（cursor 稳定分页） ── */
    const toolList = defineTool({
        name: 'session_index_list',
        description: '列出 DSH 历史会话（workspace/标题/消息子串过滤），nextCursor 稳定分页。',
        parameters: {
            workspace: { type: 'string', description: '工作目录子串，如 StudyDesk' },
            query: { type: 'string', description: '标题/首条用户消息/工具名子串' },
            limit: { type: 'integer', description: '返回上限，缺省 maxHits' },
            refresh: { type: 'boolean', description: '先刷新索引' },
            cursor: { type: 'string', description: '上页 nextCursor，原样传回续页' },
            // STAGE-1 Part A：可选排序。relevance 为单页 top-k 语义，**不支持翻页**。
            sort: { type: 'string', enum: ['time', 'relevance'], description: '排序：time=时间倒序（默认，支持 cursor 翻页）；relevance=按相关性 top-k（单页，不支持翻页）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    root: { type: 'string' },
                    total: { type: 'integer' },
                    returned: { type: 'integer' },
                    nextCursor: { type: 'string' },
                    truncated: { type: 'boolean' },
                    sessions: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: true,
                            properties: {
                                id: { type: 'string' },
                                workspace: { type: 'string' },
                                title: { type: 'string' },
                                toolCalls: { type: 'integer' },
                                lastTime: { type: 'integer' },
                            },
                        },
                    },
                },
            },
            render: (_args, v) => {
                const lines = [`[session-list] total=${v.total}, 输出 ${v.returned} 条${v.nextCursor ? ', nextCursor=' + v.nextCursor : ''}${v.truncated ? ' (truncated)' : ''}`];
                for (const s of v.sessions ?? []) {
                    lines.push(` ${s.id} | ${s.workspace} | ${s.title || '(untitled)'} | calls=${s.toolCalls ?? 0} | ${new Date(s.lastTime ?? 0).toISOString()}`);
                }
                // P1.2 续页提示（静态，无 LLM）：nextCursor 原样传回
                if (v.nextCursor)
                    lines.push('（续页：把 nextCursor 原样传回 cursor 参数）');
                // STAGE-1 Part A：relevance 模式单页语义提示（静态，无 LLM）
                if (v.sort === 'relevance' && v.truncated) {
                    lines.push('（relevance 模式为单页 top-k：本页已是相关性最优，不支持翻页）');
                }
                return text(lines.join('\n'));
            },
        },
        execute: async (args) => {
            const idx = await ensureIndex(!!args.refresh);
            const limit = Math.max(1, Math.floor(args.limit ?? config.maxHits));
            const q = (args.query || '').toLowerCase();
            const ws = (args.workspace || '').toLowerCase();
            const sort = args.sort ?? 'time';
            const all = idx.sessions.filter((s) => {
                if (s.unindexable)
                    return false;
                if (ws && !s.workspace.toLowerCase().includes(ws))
                    return false;
                if (q && !metaMatch(s, q))
                    return false;
                return true;
            });
            // 扫描/过滤硬上限（Codex MAX_SCAN_FILES 语义；DSH 2000）
            let truncated = false;
            let scanWindow = all;
            if (all.length > MAX_LIST_SCAN) {
                scanWindow = all.slice(0, MAX_LIST_SCAN);
                truncated = true;
            }
            // STAGE-1 Part A：sort='relevance' —— 单页 top-k 语义。过滤后排序截断，
            // **不返回可续游标、不参与 cursor 逻辑**（schema 注明不支持翻页）。
            // 排序为 rank.ts 纯函数（红线 4：只对已过滤条目排序，严禁扩全集）；
            // 未传 query 时 fzy/tier 恒 0 → 天然退化为 frecency（衰减+频率）排序。
            if (sort === 'relevance') {
                const ranked = sortSessions(scanWindow.map((s) => ({ meta: s })), q, { queryWorkspace: args.workspace || '' });
                const kept = ranked.slice(0, limit);
                const more = ranked.length > limit;
                const out = {
                    root: sessionsRoot,
                    total: all.length,
                    returned: kept.length,
                    truncated: truncated || more, // relevance 无 nextCursor，剩余量用 truncated 表达
                    sort: 'relevance',
                    sessions: kept.map((s) => ({
                        id: s.meta.id,
                        workspace: s.meta.workspace,
                        file: s.meta.file,
                        title: s.meta.title,
                        firstUserText: s.meta.firstUserText.slice(0, 300),
                        createdAt: s.meta.createdAt,
                        lastTime: s.meta.lastTime,
                        size: s.meta.size,
                        toolCalls: s.meta.counts['tool/call'] || 0,
                    })),
                };
                return out;
            }
            // sort='time'（默认）：行为与改动前完全一致（含 cursor 稳定分页）。
            // AnchorState：按 {ts, id} 跳过已返回区间（排序键 = lastTime desc, id asc，
            // 与 builder commit 一致），分页期间新增文件不错位
            const anchor = typeof args.cursor === 'string' ? parseCursor(args.cursor) : null;
            const start = cursorStartIndex(scanWindow, anchor);
            const kept = scanWindow.slice(start, start + limit);
            const more = start + limit < scanWindow.length;
            const nextCursor = more && kept.length > 0 ? formatCursor(kept[kept.length - 1]) : undefined;
            // 线上实测修复：末页时 nextCursor=undefined 会破坏框架 lossless-JSON 校验
            //（undefined 字段被 JSON.stringify 丢弃 → round-trip 不等）。改为"有下一页才带
            // 字段"：schema 未 required、render 判 truthy，调用方语义完全等价。
            const out = {
                root: sessionsRoot,
                total: all.length,
                returned: kept.length,
                truncated, // 仅扫描上限触发；分页由 nextCursor 表达
                sessions: kept.map((s) => ({
                    id: s.id,
                    workspace: s.workspace,
                    file: s.file,
                    title: s.title,
                    firstUserText: s.firstUserText.slice(0, 300),
                    createdAt: s.createdAt,
                    lastTime: s.lastTime,
                    size: s.size,
                    toolCalls: s.counts['tool/call'] || 0,
                })),
            };
            if (nextCursor !== undefined)
                out.nextCursor = nextCursor;
            return out;
        },
    });
    /* ── 工具 3：会话搜索（mode=full 走 FTS/worker；SCROLL 模式看上下文窗口） ── */
    const toolSearch = defineTool({
        name: 'session_index_search',
        description: '搜索 DSH 历史会话：meta=元数据，full=正文（FTS 与有界原文补查）。SCROLL 优先用 session_id+anchor_id；message_id 仅兼容旧版锚点。',
        parameters: {
            // P1 修复：query 不再是 required——SCROLL 模式（session_id+message_id）不需要
            // 查询词，此前必须传占位词才能过校验。meta/full 模式缺 query 时 execute 仍会
            // 返回明确错误。STAGE-5：短词（<3 字）走 LIKE 兜底较慢，建议 ≥3 字走 trigram
            // 快速路径（静态提示，零 LLM）。
            query: { type: 'string', description: '搜索关键词（meta/full 必填；SCROLL 忽略）。短词（<3 字）走 LIKE 较慢，建议 ≥3 字' },
            workspace: { type: 'string', description: '限定工作目录子串' },
            mode: { type: 'string', enum: ['meta', 'full'], description: 'meta=元数据；full=正文（默认 meta）' },
            limit: { type: 'integer', description: '返回上限' },
            refresh: { type: 'boolean', description: '先刷新索引' },
            maxLineBytes: {
                type: 'integer',
                description: 'full 原文补查的单条 JSONL 字节上限；默认 4194304（4MiB），可显式提高至 33554432（32MiB）。总解压仍限 256MiB；失败/略过见 coverage.diagnostics',
            },
            session_id: { type: 'string', description: 'SCROLL 会话 id' },
            message_id: { type: 'integer', description: '旧版 SCROLL rowid，过期时明确失败' },
            anchor_id: { type: 'string', description: 'SCROLL 稳定消息 anchorId（优先）' },
            window: { type: 'integer', description: 'SCROLL 窗口半径 1..20（默认 5）' },
            // STAGE-1 Part B：消息级筛选。meta 模式仅 role='tool' 可近似（toolCallCounts>0
            // 会话级），user/assistant 无消息粒度不过滤；时间范围因消息行无时间列降级为
            // 会话 lastTime（三路径统一）。
            filter: {
                type: 'object',
                additionalProperties: false,
                description: '消息级筛选：role=消息角色；sinceMs/untilMs=会话 lastTime 范围（消息行无时间列→会话级）',
                properties: {
                    role: { type: 'string', enum: ['user', 'assistant', 'tool', 'any'], description: '消息角色；any=不过滤；meta 模式 tool=toolCallCounts>0 近似、user/assistant 不过滤' },
                    sinceMs: { type: 'integer', description: '起始（>= 会话 lastTime，epoch 毫秒）' },
                    untilMs: { type: 'integer', description: '截止（<= 会话 lastTime，epoch 毫秒）' },
                },
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    query: { type: 'string' },
                    mode: { type: 'string' },
                    total: { type: 'integer' },
                    returned: { type: 'integer' },
                    truncated: { type: 'boolean' },
                    hits: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: true,
                            properties: {
                                sessionId: { type: 'string' },
                                workspace: { type: 'string' },
                                file: { type: 'string' },
                                kind: { type: 'string' },
                                type: { type: 'string' },
                                snippet: { type: 'string' },
                                messageId: { type: 'integer' },
                                anchorId: { type: 'string' },
                            },
                        },
                    },
                    messages: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: true,
                            properties: {
                                id: { type: 'integer' },
                                anchorId: { type: 'string' },
                                role: { type: 'string' },
                                text: { type: 'string' },
                                toolName: { type: 'string' },
                            },
                        },
                    },
                    bookends: { type: 'object', additionalProperties: true },
                    coverage: { type: 'object', additionalProperties: true },
                },
            },
            render: (args, v) => {
                if (v.mode === 'scroll') {
                    const anchorLabel = v.anchor_id ? `anchor_id=${v.anchor_id}` : `message_id=${v.message_id}`;
                    const lines = [`[session-scroll] ${v.session_id} ${anchorLabel} (window=${v.window})`];
                    // P1 修复：SCROLL 失败（FTS 不可用/会话不存在/锚点无消息）必须显式展示
                    // 错误行，而不是渲染成"空窗口"误导模型以为只是没有消息。
                    if (v.ok === false) {
                        lines.push(`（SCROLL 失败：${v.error ?? '未知原因'}）`);
                        return text(lines.join('\n'));
                    }
                    for (const m of (v.messages ?? [])) {
                        const center = v.anchor_id ? m.anchorId === v.anchor_id : m.id === v.message_id;
                        const destination = m.anchorId ? `anchor_id=${m.anchorId}` : `message_id=${m.id}`;
                        lines.push(` ${center ? '▶' : ' '} ${m.role}${m.toolName ? `[${m.toolName}]` : ''} ${destination}: ${(m.text || '').slice(0, 160)}`);
                    }
                    const b = v.bookends;
                    if (b?.start?.length)
                        lines.push(`— 开头: ${b.start.map((m) => `${m.role}:${(m.text || '').slice(0, 40)}`).join(' | ')}`);
                    if (b?.end?.length)
                        lines.push(`— 结尾: ${b.end.map((m) => `${m.role}:${(m.text || '').slice(0, 40)}`).join(' | ')}`);
                    // P1.2 翻页提示（静态，无 LLM）：以窗口内消息 id 为新锚点继续滚
                    lines.push('（翻页：把目标消息的 anchorId 作为 anchor_id，配合同一 session_id 再滚；旧消息无 anchorId 时才用 message_id。window 可调 1..20）');
                    return text(lines.join('\n'));
                }
                const lines = [`[session-search] "${v.query}" mode=${v.mode} → ${v.total} hits, 输出 ${v.returned}${v.truncated ? ' (truncated)' : ''}`];
                // STAGE-1 Part B：回显 filter 生效情况（仅非默认字段；静态，无 LLM）
                const farg = args.filter;
                const fbits = [];
                const frole = farg?.role && farg.role !== 'any' ? farg.role : undefined;
                const fsince = farg && Number.isFinite(Number(farg.sinceMs)) ? Number(farg.sinceMs) : undefined;
                const funtil = farg && Number.isFinite(Number(farg.untilMs)) ? Number(farg.untilMs) : undefined;
                if (frole)
                    fbits.push(`role=${frole}`);
                if (fsince !== undefined)
                    fbits.push(`sinceMs=${fsince}`);
                if (funtil !== undefined)
                    fbits.push(`untilMs=${funtil}`);
                if (fbits.length)
                    lines.push(`filter: ${fbits.join(' ')}`);
                for (const h of v.hits ?? []) {
                    lines.push(` ${h.kind === 'meta' ? 'META' : h.type} | ${h.sessionId} | ${h.workspace}`);
                    lines.push(`   ${h.snippet}`);
                    if (h.anchorId)
                        lines.push(`   跳回：session_id=${h.sessionId} anchor_id=${h.anchorId}`);
                    else if (h.messageId !== undefined)
                        lines.push(`   旧版跳回：session_id=${h.sessionId} message_id=${h.messageId}`);
                }
                const coverage = v.coverage;
                if (coverage?.complete === false) {
                    lines.push(`原文覆盖不完整：maxLineBytes=${coverage.sourceLimits?.maxLineBytes ?? DEFAULT_SEARCH_LINE_BYTES}，totalExact=false；大行可提高 maxLineBytes 至 ${MAX_SEARCH_LINE_BYTES} 补查。`);
                    for (const diagnostic of coverage.diagnostics ?? []) {
                        lines.push(` 略过/失败 ${diagnostic.sessionId}: ${diagnostic.reason}, maxLineBytes=${diagnostic.maxLineBytes}; ${diagnostic.error}`);
                    }
                    if (coverage.diagnosticsTruncated)
                        lines.push(`（诊断仅显示前 ${MAX_SEARCH_DIAGNOSTICS} 项）`);
                }
                // 全文使用固定的全局 AND→OR 策略；不暗示引号或布尔符号能改变查询模式。
                if (v.total === 0)
                    lines.push('（零命中提示：换更短关键词，或按 coverage 诊断补查受限来源。）');
                // STAGE-5：短词慢路径提示（静态，无 LLM）——full 模式 + 含 <3 字词 → 已走/将走
                // LIKE 兜底（全表扫描较慢），提醒模型下次用 ≥3 字查询走 trigram 快速路径。
                if (args.mode === 'full' && typeof args.query === 'string' && queryUsesLikePath(args.query)) {
                    lines.push('（提示：短词（<3 字）走 LIKE 兜底较慢，建议加长到 ≥3 字用 trigram 快速路径）');
                }
                return text(lines.join('\n'));
            },
        },
        execute: async (args) => {
            // SCROLL 模式：session_id + message_id → 锚点上下文窗口（照 hermes scroll 形状）
            const started = performance.now();
            const requestId = randomUUID();
            const deadlineAt = Date.now() + 10000;
            const querySignal = AbortSignal.any([abortController.signal, AbortSignal.timeout(10000)]);
            const isScroll = typeof args.session_id === 'string' && !!args.session_id && !!(args.anchor_id || args.message_id != null);
            const timings = { sourceMs: 0, ftsMs: 0, fallbackMs: 0 };
            let backend = 'meta';
            const finish = (result) => {
                const runtime = { requestId, op: result.mode === 'scroll' ? 'around' : 'search', backend, ...timings, totalMs: performance.now() - started };
                recordRuntime({ kind: 'tool-query', ...runtime, outcome: result.ok === false ? 'rejected' : 'success', returned: result.returned ?? 0, coverageComplete: result.coverage?.complete });
                return { ...result, runtime };
            };
            try {
                if (isScroll) {
                    backend = 'fts';
                    if (!fts?.ok) {
                        backend = 'unavailable';
                        return finish({
                            mode: 'scroll',
                            session_id: args.session_id,
                            ...(args.message_id !== undefined ? { message_id: args.message_id } : {}),
                            ...(args.anchor_id ? { anchor_id: args.anchor_id } : {}),
                            window: args.window ?? 5,
                            ok: false,
                            error: 'FTS 不可用，无法 SCROLL（检查 node:sqlite，或用 mode=full 搜索后再滚）',
                        });
                    }
                    const scrollStarted = performance.now();
                    let sc;
                    try {
                        sc = 'diagnostics' in fts
                            ? await fts.around(args.session_id, args.anchor_id || args.message_id, args.window ?? 5, { deadlineAt, parentRequestId: requestId, signal: querySignal })
                            : await fts.around(args.session_id, args.anchor_id || args.message_id, args.window ?? 5);
                    }
                    finally {
                        timings.ftsMs = performance.now() - scrollStarted;
                    }
                    if (sc.ok) {
                        return finish({
                            mode: 'scroll',
                            session_id: args.session_id,
                            ...(args.message_id !== undefined ? { message_id: args.message_id } : {}),
                            ...(args.anchor_id ? { anchor_id: args.anchor_id } : {}),
                            window: args.window ?? 5,
                            returned: sc.messages.length,
                            messages: sc.messages,
                            bookends: sc.bookends,
                        });
                    }
                    return finish({
                        mode: 'scroll',
                        session_id: args.session_id,
                        ...(args.message_id !== undefined ? { message_id: args.message_id } : {}),
                        ...(args.anchor_id ? { anchor_id: args.anchor_id } : {}),
                        window: args.window ?? 5,
                        ok: false,
                        error: `锚点不可用: ${sc.reason ?? 'anchor-expired'}`,
                        reason: sc.reason,
                    });
                }
                const maxLineBytes = args.maxLineBytes ?? DEFAULT_SEARCH_LINE_BYTES;
                if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < DEFAULT_SEARCH_LINE_BYTES || maxLineBytes > MAX_SEARCH_LINE_BYTES) {
                    throw new RangeError(`maxLineBytes 必须是 ${DEFAULT_SEARCH_LINE_BYTES}..${MAX_SEARCH_LINE_BYTES} 的整数字节数`);
                }
                const idx = await ensureIndex(!!args.refresh, querySignal);
                const q = (args.query || '').trim();
                if (!q)
                    throw new Error('query 不能为空');
                const mode = args.mode || 'meta';
                const ws = (args.workspace || '').toLowerCase();
                const limit = Math.max(1, Math.floor(args.limit ?? config.maxHits));
                const maxPer = Math.max(1, Math.floor(config.maxSnippetsPerSession));
                // STAGE-1 Part B：归一化 filter（非法/全默认 → undefined = 与不带 filter 一致）
                const filter = normFilter(args.filter);
                // STAGE-1 Part A：会话级相关性排序的统一收集窗口。红线 4 要求 rank 只对
                // "已过滤后的 ≤maxHits(≤500) 条目"排序——本窗口在过滤（metaMatch / workspace /
                // FTS MATCH）之后才装候选，上限 3×limit 且 ≤500；排序永远发生在过滤之后、
                // 截断之前（"先过滤 → 聚合 → sortSessions → 截断"，严禁为排序扩全集）。
                const collectCap = Math.min(Math.max(limit, config.maxHits) * 3, 500);
                const sourceCandidates = new Map(idx.sessions.map(meta => [meta.file, meta]));
                const needsRawSources = new Set();
                const probeFailures = [];
                let sourceScan;
                let sourceProbedSessions = 0;
                const sourceStarted = performance.now();
                if (mode === 'full') {
                    // Default parsing can reject a middle oversized row before even producing
                    // an index entry. Discover and validate these sources under the same budget.
                    try {
                        sourceScan = await scanFiles(sessionsRoot, { cap: MAX_SCAN_FILES, signal: querySignal });
                    }
                    catch (error) {
                        sourceScan = { files: [], complete: false, truncated: false, errors: [String(error)], failedSubtrees: [sessionsRoot] };
                    }
                    const cutoff = config.retentionDays > 0 ? Date.now() - config.retentionDays * 86400e3 : 0;
                    const toProbe = sourceScan.files.filter(file => {
                        const previous = sourceCandidates.get(file.file);
                        return (!previous || previous.unindexable) && isRetainedSession(file, previous, cutoff);
                    });
                    const wave = Math.max(1, builder.pool.sizeLimit * 2);
                    for (let start = 0; start < toProbe.length; start += wave) {
                        const probed = await Promise.all(toProbe.slice(start, start + wave).map(async (file) => {
                            const previous = sourceCandidates.get(file.file);
                            const fallback = previous ?? {
                                id: basename(dirname(file.file)), file: file.file, workspace: dirname(file.file),
                                size: file.size, mtimeMs: file.mtimeMs, ctimeMs: file.ctimeMs,
                                createdAt: 0, lastTime: file.mtimeMs, title: '', firstUserText: '', lastAssistantText: '',
                                agentPreset: '', counts: {}, toolNames: [], toolCallCounts: {}, unindexable: true,
                            };
                            sourceProbedSessions++;
                            try {
                                const parsed = await builder.pool.run({ mode: 'full', file: file.file, collectMessages: false, maxLineBytes, maxDecompressedBytes: MAX_SEARCH_DECOMPRESSED_BYTES }, querySignal);
                                if (!parsed.ok)
                                    return { meta: fallback, error: (parsed.stats?.oversized ?? 0) > 0 ? `oversized JSONL lines at maxLineBytes=${maxLineBytes}; ${parsed.error}` : parsed.error };
                                const data = parsed.data;
                                const meta = {
                                    ...fallback, id: data.id, workspace: data.cwd || dirname(file.file),
                                    size: file.size, mtimeMs: file.mtimeMs, ctimeMs: file.ctimeMs,
                                    createdAt: data.createdAt, lastTime: data.lastTime, title: data.title || data.firstUserText.slice(0, 80),
                                    firstUserText: data.firstUserText, lastAssistantText: data.lastAssistantText,
                                    agentPreset: data.agentPreset, counts: data.counts, toolNames: Object.keys(data.toolCallCounts).sort(),
                                    toolCallCounts: data.toolCallCounts, parentSession: data.parentSession,
                                    generation: data.generation, compatibility: data.compatibility, unindexable: undefined, error: undefined,
                                };
                                return { meta };
                            }
                            catch (error) {
                                return { meta: fallback, error: String(error) };
                            }
                        }));
                        for (const result of probed) {
                            if ('error' in result && result.error !== undefined)
                                probeFailures.push({ meta: result.meta, error: result.error });
                            else {
                                sourceCandidates.set(result.meta.file, result.meta);
                                needsRawSources.add(result.meta.file);
                            }
                        }
                    }
                }
                const candidates = [...sourceCandidates.values()].filter(s => (mode === 'full' || !s.unindexable) && (!ws || s.workspace.toLowerCase().includes(ws)) && timePass(s, filter));
                const scanned = candidates.slice(0, MAX_LIST_SCAN);
                let truncated = candidates.length > MAX_LIST_SCAN, totalExact = !truncated;
                const agg = new Map();
                const frequencies = new Map();
                const byFile = new Map(idx.sessions.filter(s => !s.unindexable).map(s => [s.file, s]));
                const byId = new Map([...sourceCandidates.values()].map(s => [s.id, s]));
                const lineageOf = (s) => {
                    const seen = new Set(), chain = [];
                    let current = s;
                    while (current.parentSession) {
                        if (seen.has(current.id))
                            return [...chain].sort()[0] || s.id;
                        seen.add(current.id);
                        chain.push(current.id);
                        const parent = byId.get(current.parentSession);
                        if (!parent)
                            return current.parentSession;
                        current = parent;
                    }
                    return current.id;
                };
                const addContent = (meta, content, bm25, matchCount) => {
                    const key = lineageOf(meta), prev = agg.get(key);
                    const identity = `${meta.id}\u0000${content.anchorId ?? content.messageId ?? content.snippet}`;
                    const frequency = frequencies.get(meta.file) ?? { anchors: new Set(), count: 0 };
                    const before = frequency.count;
                    frequency.anchors.add(identity);
                    frequency.count = Math.max(before, Math.min(maxPer, matchCount ?? frequency.anchors.size));
                    frequencies.set(meta.file, frequency);
                    if (!prev) {
                        agg.set(key, { meta, content, bestBm25: bm25, hitRows: frequency.count, lineageRoot: key });
                        return;
                    }
                    prev.hitRows += frequency.count - before;
                    if (!prev.content || (bm25 !== undefined && (prev.bestBm25 === undefined || bm25 < prev.bestBm25))) {
                        // Representative identity, file, workspace, snippet and rank change together.
                        prev.meta = meta;
                        prev.content = content;
                        prev.bestBm25 = bm25;
                    }
                };
                const skipMeta = mode === 'full' && !!filter?.role && filter.role !== 'any';
                for (const meta of scanned) {
                    if (meta.unindexable || skipMeta || !metaMatch(meta, q) || !metaRolePass(meta, filter?.role))
                        continue;
                    const key = lineageOf(meta);
                    if (!agg.has(key))
                        agg.set(key, { meta, hitRows: 0, lineageRoot: key });
                }
                let coverageIncomplete = false;
                const coverageReasons = new Set();
                const searchedSources = new Set();
                const sourceFailures = new Map();
                const sourceFailure = (meta, error) => {
                    coverageIncomplete = true;
                    totalExact = false;
                    const reason = /oversized JSONL|oversized-jsonl-lines/.test(error) ? 'oversized-jsonl-lines' : meta.unindexable ? 'source-parse-failed' : 'raw-search-failed';
                    coverageReasons.add(reason);
                    if (sourceFailures.size < MAX_SEARCH_DIAGNOSTICS || sourceFailures.has(meta.file)) {
                        sourceFailures.set(meta.file, { sessionId: meta.id, file: meta.file, reason, error: error.replace(/\s+/g, ' ').slice(0, 240), skipped: true, maxLineBytes });
                    }
                };
                const failedSourceFiles = new Set();
                for (const failure of probeFailures) {
                    failedSourceFiles.add(failure.meta.file);
                    sourceFailure(failure.meta, failure.error);
                }
                if (sourceScan && !sourceScan.complete) {
                    coverageIncomplete = true;
                    totalExact = false;
                    coverageReasons.add('source-scan-incomplete');
                    truncated ||= sourceScan.truncated;
                    if (sourceFailures.size < MAX_SEARCH_DIAGNOSTICS)
                        sourceFailures.set(sessionsRoot, {
                            sessionId: '(source-scan)', file: sessionsRoot, reason: 'source-scan-incomplete',
                            error: sourceScan.errors.join('; ').replace(/\s+/g, ' ').slice(0, 240) || 'source scan did not confirm every file', skipped: true, maxLineBytes,
                        });
                }
                if (mode === 'full') {
                    const wave = Math.max(1, builder.pool.sizeLimit * 2);
                    const rawSearch = async (pool, queryMode) => {
                        const results = [];
                        for (let start = 0; start < pool.length; start += wave) {
                            if (querySignal.aborted) {
                                coverageIncomplete = true;
                                coverageReasons.add('request-deadline');
                                break;
                            }
                            const batch = await Promise.all(pool.slice(start, start + wave).map(async (meta) => {
                                searchedSources.add(meta.file);
                                try {
                                    return { meta, result: await builder.pool.run({ mode: 'search', file: meta.file, query: q, maxSnippets: maxPer, role: filter?.role, queryMode, maxLineBytes, maxDecompressedBytes: MAX_SEARCH_DECOMPRESSED_BYTES }, querySignal) };
                                }
                                catch (error) {
                                    return { meta, result: null, error: String(error) };
                                }
                            }));
                            for (const item of batch) {
                                const { meta, result } = item;
                                if (!result?.ok || !Array.isArray(result.data)) {
                                    failedSourceFiles.add(meta.file);
                                    const error = result && !result.ok ? (result.stats?.oversized ?? 0) > 0 ? `oversized JSONL lines at maxLineBytes=${maxLineBytes}; ${result.error}` : result.error : 'error' in item ? item.error ?? 'raw-search failed' : 'invalid raw-search response';
                                    sourceFailure(meta, error);
                                    continue;
                                }
                                for (const hit of result.data)
                                    results.push({ meta, hit });
                            }
                        }
                        return results;
                    };
                    timings.sourceMs = performance.now() - sourceStarted;
                    let rawPool = (fts?.ok ? scanned.filter(meta => meta.coverage?.complete !== true || meta.ftsDirty || meta.detailMissing || meta.unindexable || needsRawSources.has(meta.file)) : scanned).filter(meta => !failedSourceFiles.has(meta.file));
                    backend = fts?.ok ? (rawPool.length ? 'fts+source' : 'fts') : 'source';
                    let page = { hits: [], total: 0, totalExact: true, hasMore: false };
                    const readPage = (queryMode) => fts && 'diagnostics' in fts
                        ? fts.searchPage(q, args.workspace ?? '', collectCap, { ...filter, queryMode }, { deadlineAt, parentRequestId: requestId, signal: querySignal })
                        : fts.searchPage(q, args.workspace ?? '', collectCap, { ...filter, queryMode });
                    if (fts?.ok) {
                        const ftsStarted = performance.now();
                        try {
                            page = await readPage('and');
                        }
                        catch (error) {
                            rawPool = scanned;
                            backend = 'source';
                            coverageReasons.add('fts-search-failed');
                            recordRuntime({ kind: 'fts-fallback', requestId, reason: 'fts-search-failed', errorCode: error?.code ?? 'unknown' });
                        }
                        finally {
                            timings.ftsMs += performance.now() - ftsStarted;
                        }
                    }
                    let fallbackStarted = performance.now();
                    let raw = await rawSearch(rawPool, 'and');
                    timings.fallbackMs += performance.now() - fallbackStarted;
                    if (!page.hits.length && !raw.length) {
                        if (fts?.ok && rawPool !== scanned) {
                            const ftsStarted = performance.now();
                            try {
                                page = await readPage('or');
                            }
                            catch (error) {
                                rawPool = scanned;
                                backend = 'source';
                                coverageReasons.add('fts-search-failed');
                                recordRuntime({ kind: 'fts-fallback', requestId, reason: 'fts-search-failed', errorCode: error?.code ?? 'unknown' });
                            }
                            finally {
                                timings.ftsMs += performance.now() - ftsStarted;
                            }
                        }
                        fallbackStarted = performance.now();
                        raw = await rawSearch(rawPool, 'or');
                        timings.fallbackMs += performance.now() - fallbackStarted;
                    }
                    if (page.hasMore) {
                        truncated = true;
                        totalExact = false;
                    }
                    if (!page.totalExact)
                        totalExact = false;
                    for (const hit of page.hits) {
                        const meta = byFile.get(hit.sessionFile);
                        if (!meta || meta.id !== hit.sessionId)
                            continue;
                        addContent(meta, { type: hit.role, snippet: hit.snippet, anchorId: hit.anchorId, messageId: hit.anchorId ? undefined : hit.messageId }, hit.bm25, hit.matchCount);
                    }
                    for (const { meta, hit } of raw)
                        addContent(meta, { type: hit.type, snippet: hit.snippet, anchorId: hit.anchorId });
                }
                const total = agg.size;
                // 3) 统一会话级相关性排序（rank.ts 纯函数、确定性；三路径口径一致）
                const ranked = sortSessions([...agg.values()], q, { queryWorkspace: args.workspace || '' });
                // 4) 截断并物化输出行（snippet 生成与 >>> <<< 标记逻辑一行未改）
                const kept = ranked.slice(0, limit);
                const hits = kept.map((e) => e.content
                    ? {
                        sessionId: e.meta.id,
                        workspace: e.meta.workspace,
                        file: e.meta.file,
                        kind: 'content',
                        type: e.content.type,
                        snippet: e.content.snippet,
                        ...(e.content.messageId !== undefined ? { messageId: e.content.messageId } : {}),
                        ...(e.content.anchorId ? { anchorId: e.content.anchorId } : {}),
                        lineageRoot: e.lineageRoot,
                    }
                    : {
                        sessionId: e.meta.id,
                        workspace: e.meta.workspace,
                        file: e.meta.file,
                        kind: 'meta',
                        type: 'meta',
                        // P1.4：meta snippet 同样带 >>> <<< 命中标记（静态）
                        snippet: markMatches((e.meta.title ? `标题: ${e.meta.title} | ` : '') + (e.meta.firstUserText || '').slice(0, 200), q),
                        lineageRoot: e.lineageRoot,
                    });
                return finish({
                    query: q,
                    mode,
                    total,
                    returned: kept.length,
                    truncated: truncated || total > limit || coverageIncomplete,
                    totalExact,
                    hasMore: truncated || total > limit || coverageIncomplete,
                    coverage: { complete: !coverageIncomplete, reasons: [...coverageReasons],
                        sourceLimits: { maxLineBytes, hardMaxLineBytes: MAX_SEARCH_LINE_BYTES, maxDecompressedBytes: MAX_SEARCH_DECOMPRESSED_BYTES, discoveredSessions: sourceScan?.files.length ?? 0, scannedSessions: scanned.length, sourceProbedSessions, rawSearchedSessions: searchedSources.size, failedSessions: failedSourceFiles.size },
                        diagnostics: [...sourceFailures.values()], diagnosticsTruncated: failedSourceFiles.size + (sourceScan && !sourceScan.complete ? 1 : 0) > MAX_SEARCH_DIAGNOSTICS },
                    hits,
                });
            }
            catch (error) {
                recordRuntime({ kind: 'tool-query', requestId, op: isScroll ? 'around' : 'search', backend, ...timings, totalMs: performance.now() - started, outcome: 'error', errorCode: error?.code ?? 'unknown' });
                throw error;
            }
        },
    });
    /* ── 工具 4：单会话摘要 ── */
    const toolSummary = defineTool({
        name: 'session_summary',
        description: '生成单个 DSH 会话的摘要（确定性字段；llmSummaryEnabled 开启且可用时附加 LLM 一句话 llmSummary，≤80 字，失败自动省略）。',
        parameters: {
            id: { type: 'string', description: '会话 id 或文件路径（子串匹配）', required: true },
            refresh: { type: 'boolean', description: '先刷新索引' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    id: { type: 'string' },
                    file: { type: 'string' },
                    workspace: { type: 'string' },
                    createdAt: { type: 'integer' },
                    lastTime: { type: 'integer' },
                    durationMs: { type: 'integer' },
                    title: { type: 'string' },
                    firstUserText: { type: 'string' },
                    lastAssistantText: { type: 'string' },
                    agentPreset: { type: 'string' },
                    counts: { type: 'object', additionalProperties: true },
                    toolCalls: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: true,
                            properties: { name: { type: 'string' }, count: { type: 'integer' } },
                        },
                    },
                    // STAGE-4：可选 LLM 一句话摘要（仅 llmSummaryEnabled 且调用成功时出现；
                    // 禁用/失败 → 字段缺席 → 输出与确定性摘要原样一致，fail-open）
                    llmSummary: { type: 'string' },
                },
            },
            render: (_args, v) => {
                const lines = [
                    `[session-summary] ${v.id}`,
                    `workspace=${v.workspace}`,
                    `title=${v.title || '(untitled)'}`,
                    `time=${new Date(v.createdAt ?? 0).toISOString()} → ${new Date(v.lastTime ?? 0).toISOString()} (${Math.round((v.durationMs ?? 0) / 1000)}s)`,
                    `agentPreset=${v.agentPreset || ''}`,
                    `firstUser=${(v.firstUserText || '').slice(0, 300)}`,
                    `lastAssistant=${(v.lastAssistantText || '').slice(0, 300)}`,
                ];
                // STAGE-4：可选 LLM 一句话摘要（成功才出现；禁用/失败无此行 → 确定性回退）
                if (typeof v.llmSummary === 'string' && v.llmSummary.length > 0)
                    lines.push(`llmSummary=${v.llmSummary}`);
                const calls = (v.toolCalls ?? []);
                if (calls.length)
                    lines.push(`tools=${calls.map((c) => `${c.name}×${c.count}`).join(', ')}`);
                const counts = v.counts;
                if (counts) {
                    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k}=${n}`).join(' ');
                    lines.push(`events: ${top}`);
                }
                return text(lines.join('\n'));
            },
        },
        execute: async (args) => {
            const idx = await ensureIndex(!!args.refresh);
            let meta = findSession(idx, args.id);
            if (!meta) {
                const candidates = idx.sessions.filter((s) => !s.unindexable && (s.id.toLowerCase().includes(args.id.toLowerCase()) || s.file.toLowerCase().includes(args.id.toLowerCase())));
                if (candidates.length === 0)
                    throw new Error(`未找到会话: ${args.id}`);
                meta = candidates[0];
            }
            // P1.5 Codex 式存在性复检（state DB first）：只走单会话路径、只 1 次 stat
            //（list/search 全量路径不引入 stat 风暴）。索引条目指向的文件已不存在 →
            // 返回明确错误而非僵尸数据，并后台触发一次增量构建自动清理该条目。
            // STAGE-4：stat 结果同时作为 llmSummary 缓存的会话文件指纹（(size, mtimeMs) 变化
            // = 会话有更新 → 缓存失效重生成），不额外 stat。
            let st;
            try {
                st = statSync(meta.file);
            }
            catch {
                triggerAutoRefresh('stale-entry-summary');
                throw new Error(`会话文件已删除，索引将自动清理: ${args.id}`);
            }
            const out = summarizeSession(meta);
            // STAGE-4：仅在本工具路径、开关内触发一次（成本护栏）；失败/禁用 →
            // 不加 llmSummary 字段，确定性摘要原样返回（fail-open，绝不半死）。
            if (llmSummaryEnabled) {
                const r = await llmSummary.getSummary(meta, { size: st.size, mtimeMs: st.mtimeMs });
                if (r.summary !== undefined)
                    out.llmSummary = r.summary;
            }
            return out;
        },
    });
    /* ── 工具 5：书签（STAGE-2 Part A：B3 书签导航 + C4 aider 幂等去重）──────── */
    const bookmarkFile = join(dataDir, BOOKMARK_FILE_NAME);
    const toolBookmark = defineTool({
        name: 'session_index_bookmark',
        description: '给重要会话点落书签（稳定锚点=sessionId+anchorId）并找回。add 同锚点重复写=替换更新；list 对会话已不在索引的书签标 stale。跳回用 session_summary id=<sessionId>，或 session_index_search SCROLL 的 session_id+anchor_id；messageId 仅兼容旧版书签。',
        parameters: {
            action: {
                type: 'string',
                enum: ['add', 'list', 'remove'],
                required: true,
                description: 'add=落书签（sessionId 必填）；list=找回（支持过滤，stale 标注）；remove=删除书签（id 或 sessionId 之一）',
            },
            // add / remove 共用：会话 id 或文件路径子串（add 经索引解析，解析失败返回明确错误）
            sessionId: { type: 'string', description: '会话 id 或文件路径子串（add 必填；remove 与 id 二选一）' },
            // add
            messageId: { type: 'integer', description: '旧版 rowid（无法证明定位时标 unresolved）' },
            anchorId: { type: 'string', description: '稳定消息 anchorId（来自正文搜索）' },
            label: { type: 'string', description: '书签标签；缺省=标题或首条用户消息前 80 字符（确定性，无 LLM）' },
            note: { type: 'string', description: '备注（可选）' },
            // list
            query: { type: 'string', description: '对 label/note/title 做大小写不敏感子串过滤' },
            limit: { type: 'integer', description: 'list 返回上限，默认 20，≤100' },
            // remove
            id: { type: 'string', description: 'remove 用：书签 id（精确）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    action: { type: 'string' },
                    replaced: { type: 'boolean' },
                    removed: { type: 'integer' },
                    file: { type: 'string' },
                    indexReady: { type: 'boolean' },
                    total: { type: 'integer' },
                    matched: { type: 'integer' },
                    returned: { type: 'integer' },
                    skippedBad: { type: 'integer' },
                    bookmark: {
                        type: 'object',
                        additionalProperties: true,
                        properties: {
                            id: { type: 'string' },
                            sessionId: { type: 'string' },
                            messageId: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                            label: { type: 'string' },
                            note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                            stale: { type: 'boolean' },
                        },
                    },
                    bookmarks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: true,
                            properties: {
                                id: { type: 'string' },
                                sessionId: { type: 'string' },
                                messageId: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
                                label: { type: 'string' },
                                note: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                                title: { type: 'string' },
                                workspace: { type: 'string' },
                                stale: { type: 'boolean' },
                                createdAt: { type: 'integer' },
                                updatedAt: { type: 'integer' },
                            },
                        },
                    },
                },
            },
            render: (_args, v) => {
                const lines = [];
                if (v.action === 'add') {
                    const b = v.bookmark;
                    lines.push(`[bookmark-add] ${v.replaced ? '更新(幂等)' : '新增'} id=${b.id} session=${b.sessionId}${b.anchorId ? ` anchor_id=${b.anchorId}` : b.messageId != null ? ` message_id=${b.messageId}` : ''}`);
                    lines.push(` label=${b.label || '(untitled)'}`);
                    if (b.note)
                        lines.push(` note=${b.note}`);
                    lines.push('（跳回：session_summary id=<sessionId>；消息用 session_index_search 的 session_id+anchor_id，旧版数字锚点才用 message_id）');
                }
                else if (v.action === 'list') {
                    lines.push(`[bookmark-list] total=${v.total ?? 0} matched=${v.matched ?? 0} returned=${v.returned ?? 0}${v.indexReady ? '' : ' (index 未就绪，未做 stale 判定)'}${v.skippedBad ? ` skippedBad=${v.skippedBad}` : ''}`);
                    for (const b of (v.bookmarks ?? [])) {
                        lines.push(` ${b.stale ? 'STALE ' : ''}${b.id} | ${b.sessionId}${b.anchorId ? ` anchor_id=${b.anchorId}` : b.messageId != null ? ` message_id=${b.messageId}` : ''} | ${b.label || '(untitled)'}${b.note ? ` | ${b.note}` : ''} | ${new Date(b.updatedAt ?? 0).toISOString()}`);
                    }
                    if ((v.returned ?? 0) === 0)
                        lines.push('（无书签：action=add 落一个，或用 session_index_search 找锚点）');
                }
                else if (v.action === 'remove') {
                    lines.push(`[bookmark-remove] removed=${v.removed ?? 0}`);
                }
                return text(lines.join('\n'));
            },
        },
        execute: async (args) => {
            const action = args.action;
            if (action === 'add') {
                const sid = (args.sessionId || '').trim();
                if (!sid)
                    throw new Error('add 需要 sessionId（会话 id 或文件路径子串）');
                const idx = await ensureIndex(false);
                const meta = findSession(idx, sid);
                if (!meta) {
                    throw new Error(`未找到会话: ${sid}（可用 session_index_list 确认 id 或文件路径）`);
                }
                let messageId = null;
                if (args.messageId !== undefined && args.messageId !== null) {
                    const m = Number(args.messageId);
                    if (!Number.isFinite(m) || !Number.isInteger(m) || m < 0) {
                        throw new Error('messageId 必须是非负整数');
                    }
                    messageId = m;
                }
                const { bookmark, replaced } = await addBookmark(bookmarkFile, {
                    sessionId: meta.id,
                    sessionFile: meta.file,
                    messageId,
                    anchorId: args.anchorId || undefined,
                    label: typeof args.label === 'string' && args.label ? args.label : defaultLabel(meta.title, meta.firstUserText),
                    note: typeof args.note === 'string' && args.note ? args.note : null,
                    title: meta.title,
                    workspace: meta.workspace,
                });
                return { action: 'add', replaced, file: bookmarkFile, bookmark };
            }
            if (action === 'list') {
                const { bookmarks, skippedBad } = await readBookmarks(bookmarkFile);
                const q = typeof args.query === 'string' ? args.query : '';
                const limit = Math.max(1, Math.min(BOOKMARK_LIST_LIMIT_MAX, Math.floor(Number(args.limit) || BOOKMARK_LIST_LIMIT_DEFAULT)));
                const idx = loadIndex(indexFile);
                const indexReady = !!idx;
                const matched = bookmarks.filter((b) => bookmarkMatches(b, q));
                const sorted = sortBookmarks(matched).slice(0, limit);
                const items = await Promise.all(sorted.map(async (b) => {
                    const stale = indexReady ? !findSession(idx, b.sessionId) : false;
                    const location = b.anchorId && fts?.ok && !stale ? await fts.around(b.sessionId, b.anchorId, 1) : null;
                    return { ...b, stale, anchorAvailable: location?.ok ?? (!b.anchorId && b.messageId == null && !stale),
                        anchorStatus: location && !location.ok ? 'unresolved' : b.anchorStatus,
                        unresolvedReason: location && !location.ok ? location.reason : b.unresolvedReason };
                }));
                return {
                    action: 'list',
                    file: bookmarkFile,
                    indexReady,
                    total: bookmarks.length,
                    matched: matched.length,
                    returned: items.length,
                    skippedBad,
                    bookmarks: items,
                };
            }
            if (action === 'remove') {
                const id = typeof args.id === 'string' ? args.id.trim() : '';
                const sid = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
                if (!id && !sid)
                    throw new Error('remove 需要 id 或 sessionId 之一');
                const removed = await removeBookmarks(bookmarkFile, { id: id || undefined, sessionId: sid || undefined });
                return { action: 'remove', file: bookmarkFile, removed };
            }
            throw new Error(`未知 action: ${String(action)}（add|list|remove）`);
        },
    });
    const tools = [toolStatus, toolList, toolSearch, toolSummary, toolBookmark];
    // ctx.effect：热重载/卸载时自动注销工具（scaffold 规范）
    for (const t of tools) {
        ctx.effect(() => ctx.tools.register(t), `@dsh-external/dsh-session-index: ${t.name}`);
    }
    // 卸载时中止未完成构建 + 终止 worker 池 + 关 watcher + 关 FTS（热重载不留泄漏）
    ctx.effect(() => () => {
        abortController.abort();
        for (const cancelWait of startupWaits)
            cancelWait();
        clearDeferTimer();
        clearLaggingPolling();
        if (fallbackTimer)
            clearInterval(fallbackTimer);
        fallbackTimer = null;
        watcher.close();
        builder.dispose();
        const closingFts = fts?.close().catch(error => log(`[session-index] FTS close failed: ${String(error)}`));
        // 工厂尚未返回时，初始化链会关闭迟到连接；卸载完成必须等待该链结束。
        return Promise.all([closingFts, ftsInitialization]).then(() => { });
    }, '@dsh-external/dsh-session-index: build cleanup');
}
//# sourceMappingURL=index.js.map