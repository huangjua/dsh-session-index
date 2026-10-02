/** The host owns bounded RPC only; SQLite and every database operation live in fts-worker. */
import { fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { inspectFtsSpools, spoolError } from './fts-spool.js';
export const FTS_BATCH_BYTES = 512 * 1024;
export const FTS_QUEUE_BYTES = 8 * 1024 * 1024;
export const FTS_INFLIGHT_BATCHES = 2;
export const FTS_MAX_QUERY_HITS = 500;
export const FTS_SOURCE_BODY_BYTES = 64 * 1024 * 1024;
/** Native DatabaseSync SQL cannot be interrupted reliably by Worker.terminate().
 * Each connection has its own process, allowing bounded SQL and migration aborts
 * at the OS boundary. Killing the reader never touches a writer transaction. */
class FtsProcess extends EventEmitter {
    child;
    termination;
    hostExit = () => { this.child.kill('SIGKILL'); };
    constructor(url, data) {
        super();
        const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
        delete environment.NODE_OPTIONS;
        // fork forwards spawn options; this Node typings version omits windowsHide.
        const processOptions = { env: environment, windowsHide: true,
            execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' };
        this.child = fork(fileURLToPath(url), [JSON.stringify(data)], processOptions);
        this.child.on('message', message => this.emit('message', message));
        this.child.on('error', error => this.emit('error', error));
        process.once('exit', this.hostExit);
        this.child.on('exit', (code, signal) => { process.off('exit', this.hostExit); this.emit('exit', code ?? signal ?? -1); });
    }
    get pid() { return this.child.pid; }
    postMessage(message) {
        this.child.send(message, error => { if (error && !this.termination)
            this.emit('error', error); });
    }
    terminate() {
        if (this.termination)
            return this.termination;
        this.termination = new Promise((accept, reject) => {
            if (this.child.exitCode !== null || this.child.signalCode !== null) {
                accept(this.child.exitCode ?? -1);
                return;
            }
            let timer;
            const exited = (code) => { if (timer)
                clearTimeout(timer); accept(code ?? -1); };
            this.child.once('exit', exited);
            // This PID is our own isolated SQLite child, never the application host.
            if (!this.child.kill('SIGTERM')) {
                this.child.off('exit', exited);
                reject(rpcError('EFTSTERMINATE', 'FTS process could not be terminated'));
                return;
            }
            timer = setTimeout(() => {
                this.child.kill('SIGKILL');
                timer = setTimeout(() => { this.child.off('exit', exited); reject(rpcError('EFTSTERMINATE', 'FTS process did not exit within its 4 second termination bound')); }, 1000);
            }, 3000);
        });
        return this.termination;
    }
}
export class FtsRpcError extends Error {
    code;
    sqliteErrorCode;
    constructor(error) {
        super(error.message);
        this.name = error.name || 'FtsRpcError';
        this.code = error.code;
        this.sqliteErrorCode = error.sqliteErrorCode;
        if (error.stack)
            this.stack = error.stack;
    }
}
function rpcError(code, message) {
    return new FtsRpcError({ name: 'FtsRpcError', code, message });
}
function diagnosticCode(error) {
    const code = error?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'EFTSTRANSPORT';
}
const readerOperation = (op) => /^(search|around|sessionCount|getCheckpoint|needsSync|listSessionFiles|lastPrune|resolveLegacy)/.test(op);
const writerMutation = (op) => /^(stageCommit|upsertSession|removeSession|markPruned|optimize|vacuum|maybeMaintenance)$/.test(op);
export async function createFtsClient(dbPath, options = {}) {
    let client;
    try {
        client = new FtsClient(dbPath, options);
        if (await client.ready())
            return client;
    }
    catch { /* Unsupported SQLite or a failed startup uses the existing source search fallback. */ }
    await client?.close().catch(() => { });
    return null;
}
export class FtsClient {
    dbPath;
    options;
    worker = null;
    reader = null;
    readerSpoolDirectory = '';
    readyPromise = Promise.resolve(false);
    writerReadyPromise = Promise.resolve(false);
    readerReadyPromise = Promise.resolve(false);
    restartPromise = null;
    readerRestartPromise = null;
    startupState = {};
    generation = { writer: 0, reader: 0 };
    roleRestarts = { writer: 0, reader: 0 };
    transportFailures = { writer: 0, reader: 0 };
    roleLastError = { writer: '', reader: '' };
    readerRestartTimes = [];
    readerRestartSuspended = false;
    diagnosticCallbackError = '';
    requestTimeouts = 0;
    queueTimeouts = 0;
    cancelledRequests = 0;
    workerTiming = new WeakSet();
    lastReaderTerminationMs = 0;
    maxReaderTerminationMs = 0;
    retiredTerminations = new Set();
    liveChannels = new Set();
    spoolDirectory = '';
    sequence = 0;
    pending = new Map();
    closing = false;
    closePromise = null;
    writeSequence = 0;
    writes = new Map();
    failures = [];
    activeStreams = 0;
    queueBytes = 0;
    maxQueueBytes = 0;
    inFlightBatches = 0;
    maxInFlightBatches = 0;
    maxBatchBytes = 0;
    batchWaiters = new Set();
    producerWaiters = new Set();
    queuedSourceBytes = 0;
    activeSourceBytes = 0;
    maxActiveSourceBytes = 0;
    activeBodyBytes = 0;
    maxActiveBodyBytes = 0;
    restarts = 0;
    automaticRestartTimes = [];
    restartSuspended = false;
    degraded = false;
    lastTransportError = '';
    lastTransportErrorAt = 0;
    lastRecoveryCallbackError = '';
    lastWriteError = '';
    lastWriteErrorAt = 0;
    failedFiles = new Set();
    writerTelemetry;
    readerTelemetry;
    maxWriterHeapUsed = 0;
    maxReaderHeapUsed = 0;
    maxWriterStagedBytes = 0;
    ownedSpools = new Set();
    cleanupPendingDirectories = new Set();
    spoolWarnings = [];
    seenSpoolWarnings = new Set();
    spoolCleanupFailureCount = 0;
    lastSpoolDiagnosticCallbackError = '';
    spoolInventory;
    spoolInspection = null;
    lastHealth = { messages: 0, dbSizeBytes: 0, lastOptimizeAt: 0, schemaVersion: '',
        lastPruneAt: 0, lastPruneCount: 0, lastWriteError: '', lastWriteErrorAt: 0, failedSessions: 0, pendingWrites: 0, acceptingWrites: false, sessions: 0, observedAt: 0 };
    available = false;
    constructor(dbPath, options = {}) {
        this.dbPath = dbPath;
        this.options = options;
        for (const [name, value] of Object.entries(options)) {
            if (name.endsWith('Ms') && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0))
                throw new RangeError(`Invalid FTS ${name}`);
        }
        if (options.maxPendingRequests !== undefined && (!Number.isInteger(options.maxPendingRequests) || options.maxPendingRequests < 2))
            throw new RangeError('Invalid FTS maxPendingRequests');
        this.start();
    }
    get ok() { return this.available && !this.closing; }
    async ready() {
        if (this.closing)
            return false;
        // A role recovery first terminates the old actor and cleans its spool; until
        // it boots the replacement, readyPromise can still belong to the old actor.
        while (this.restartPromise || this.readerRestartPromise) {
            await (this.restartPromise ?? this.readerRestartPromise);
            if (this.closing)
                return false;
        }
        const ready = await this.readyPromise;
        return ready && this.available && !this.closing;
    }
    start() {
        this.available = false;
        const spoolDirectory = join(dirname(resolve(this.dbPath)), `.fts-staging-${process.pid}-${randomUUID()}`);
        this.spoolDirectory = spoolDirectory;
        this.ownedSpools.add(resolve(spoolDirectory));
        this.writerReadyPromise = this.bootWorker('writer', spoolDirectory);
        this.readyPromise = this.writerReadyPromise.then(async (available) => {
            if (!available || this.closing)
                return false;
            return this.startReader(spoolDirectory);
        });
        void this.readyPromise.catch(() => { });
    }
    startReader(spoolDirectory) {
        this.readerSpoolDirectory = `${spoolDirectory}-reader`;
        this.ownedSpools.add(resolve(this.readerSpoolDirectory));
        this.readerReadyPromise = this.bootWorker('reader', this.readerSpoolDirectory);
        return this.readerReadyPromise;
    }
    notifyDiagnostic(callback, event) {
        const failed = () => { this.diagnosticCallbackError = 'EFTSDIAGNOSTICCALLBACK'; };
        try {
            void Promise.resolve(callback?.(event)).catch(failed);
        }
        catch {
            failed();
        }
    }
    bootWorker(role, spoolDirectory) {
        const generation = ++this.generation[role];
        const beganAt = Date.now();
        this.startupState[role] = { role, generation, state: 'booting', startedAt: beganAt, updatedAt: beganAt, elapsedMs: 0 };
        const data = { dbPath: this.dbPath, spoolDirectory, readOnly: role === 'reader', role, generation,
            batchBytes: FTS_BATCH_BYTES, queueBytes: FTS_QUEUE_BYTES,
            migrationLockTimeoutMs: this.options.migrationLockTimeoutMs ?? 60000 };
        const url = this.options.workerUrl ?? new URL('./fts-worker.js', import.meta.url);
        const worker = new FtsProcess(url, data);
        this.liveChannels.add(worker);
        worker.once('exit', () => this.liveChannels.delete(worker));
        if (role === 'writer')
            this.worker = worker;
        else
            this.reader = worker;
        const current = () => (role === 'writer' ? this.worker : this.reader) === worker;
        return new Promise((accept, reject) => {
            let settled = false;
            let phaseTimer;
            let totalTimer;
            let migrationStarted = false;
            let lastProgressKey = '';
            const clear = () => { if (phaseTimer)
                clearTimeout(phaseTimer); if (totalTimer)
                clearTimeout(totalTimer); };
            const failStartup = (error) => {
                if (settled)
                    return;
                settled = true;
                clear();
                const snapshot = this.startupState[role];
                const code = diagnosticCode(error);
                const structured = { name: 'FtsRpcError', code, message: `FTS ${role} startup failed (${code})`,
                    sqliteErrorCode: error.sqliteErrorCode };
                this.startupState[role] = { ...snapshot, state: 'failed', updatedAt: Date.now(), elapsedMs: Date.now() - beganAt, error: structured };
                this.notifyDiagnostic(this.options.onStartupFailure, this.startupState[role]);
                reject(error);
                // An initialization failure is terminal for this attempt. Repeated automatic
                // migration restarts can hide a corrupt database or an exhausted lock budget.
                this.failWorker(worker, error, false);
                if (role === 'writer')
                    this.worker = null;
                else
                    this.reader = null;
                const terminated = worker.terminate();
                this.retiredTerminations.add(terminated);
                void terminated.finally(() => this.retiredTerminations.delete(terminated)).catch(() => { });
            };
            const armPhase = (ms, code, detail) => {
                if (phaseTimer)
                    clearTimeout(phaseTimer);
                phaseTimer = setTimeout(() => failStartup(rpcError(code, `FTS ${role} ${detail}`)), ms);
            };
            armPhase(this.options.startupTimeoutMs ?? 15000, 'EFTSSTARTUP', 'process handshake timed out');
            worker.on('message', (message) => {
                if (!current())
                    return;
                if (role === 'writer' && message.healthSnapshot)
                    this.lastHealth = message.healthSnapshot;
                if (message.telemetry) {
                    if (role === 'writer') {
                        this.writerTelemetry = message.telemetry;
                        this.maxWriterHeapUsed = Math.max(this.maxWriterHeapUsed, message.telemetry.maxWorkerHeapUsed);
                        this.maxWriterStagedBytes = Math.max(this.maxWriterStagedBytes, message.telemetry.maxStagedBytes);
                    }
                    else {
                        this.readerTelemetry = message.telemetry;
                        this.maxReaderHeapUsed = Math.max(this.maxReaderHeapUsed, message.telemetry.maxWorkerHeapUsed);
                    }
                    for (const warning of message.telemetry.cleanupFailures ?? [])
                        this.recordSpoolWarning(warning);
                }
                if (message.startup && !settled) {
                    this.workerTiming.add(worker);
                    const state = message.startup.state;
                    const progress = message.startup.progress;
                    this.startupState[role] = { ...this.startupState[role], state, progress,
                        updatedAt: Date.now(), elapsedMs: Date.now() - beganAt };
                    this.notifyDiagnostic(this.options.onStartupProgress, this.startupState[role]);
                    if (state === 'migrating' && progress) {
                        if (!migrationStarted) {
                            migrationStarted = true;
                            totalTimer = setTimeout(() => failStartup(rpcError('EFTSMIGRATIONTOTAL', 'FTS migration total deadline exceeded')), this.options.migrationTimeoutMs ?? 90000);
                        }
                        const key = `${progress.phase}:${progress.completed}`;
                        if (key !== lastProgressKey) {
                            lastProgressKey = key;
                            const locked = progress.phase === 'lock-wait';
                            armPhase(locked ? this.options.migrationLockTimeoutMs ?? 60000 : this.options.migrationStallTimeoutMs ?? 20000, locked ? 'EFTSMIGRATIONLOCK' : 'EFTSMIGRATIONSTALL', locked ? 'migration lock wait exceeded its bound' : 'migration made no progress within its bound');
                        }
                    }
                    else if (!migrationStarted)
                        armPhase(this.options.startupTimeoutMs ?? 15000, 'EFTSOPENING', 'database opening timed out');
                    return;
                }
                if (message.ready) {
                    if (settled)
                        return;
                    if (message.error) {
                        failStartup(new FtsRpcError(message.error));
                        return;
                    }
                    settled = true;
                    clear();
                    this.startupState[role] = { ...this.startupState[role], state: message.available ? 'ready' : 'failed',
                        updatedAt: Date.now(), elapsedMs: Date.now() - beganAt };
                    this.notifyDiagnostic(this.options.onStartupProgress, this.startupState[role]);
                    this.available = !!this.worker && !!this.reader && this.startupState.writer?.state === 'ready' && this.startupState.reader?.state === 'ready';
                    if (this.available)
                        this.degraded = false;
                    accept(!!message.available);
                    return;
                }
                if (message.id === undefined)
                    return;
                const request = this.pending.get(message.id);
                if (!request || request.worker !== worker)
                    return;
                if (message.started) {
                    // SQL starts only after this permit, so a queued timeout can never
                    // unknowingly leave native SQL running behind an unhandled cancel.
                    request.started = true;
                    worker.postMessage({ startAck: message.id });
                    return;
                }
                if (message.timing) {
                    Object.assign(request.diagnostic, message.timing);
                    request.diagnostic.responseTransportMs = Math.max(0, Date.now() - message.timing.responseAt);
                }
                this.release(message.id, request);
                if (message.error)
                    request.reject(new FtsRpcError(message.error));
                else
                    request.resolve(message.result);
            });
            const failed = (error) => {
                if (!current()) {
                    if (!settled) {
                        settled = true;
                        clear();
                        reject(rpcError(this.closing ? 'EFTSCLOSED' : 'EFTSRESTART', `FTS ${role} startup interrupted`));
                    }
                    return;
                }
                if (!settled) {
                    failStartup(error);
                    return;
                }
                this.failWorker(worker, error);
            };
            worker.on('error', error => failed(rpcError('EFTSWORKER', error.message)));
            worker.on('exit', code => failed(rpcError('EFTSEXIT', `FTS ${role} exited (${code})`)));
        });
    }
    release(id, request) {
        this.pending.delete(id);
        clearTimeout(request.timer);
        request.cleanup();
        this.queueBytes -= request.bytes;
        if (request.batch) {
            this.inFlightBatches--;
            for (const accept of this.batchWaiters)
                accept();
            this.batchWaiters.clear();
        }
    }
    rejectPending(error, worker) {
        for (const [id, request] of this.pending) {
            if (worker && request.worker !== worker)
                continue;
            this.release(id, request);
            request.reject(error);
        }
    }
    failWorker(worker, error, recover = true) {
        if (worker !== this.worker && worker !== this.reader)
            return;
        const role = worker === this.reader ? 'reader' : 'writer';
        this.transportFailures[role]++;
        const code = diagnosticCode(error);
        const safeMessage = `FTS ${role} ${code === 'EFTSTIMEOUT' ? 'deadline exceeded' : code === 'EFTSEXIT' ? 'exited' : 'failed'} (${code})`;
        this.roleLastError[role] = safeMessage;
        if (this.startupState[role])
            this.startupState[role] = { ...this.startupState[role], state: 'failed', updatedAt: Date.now() };
        this.available = false;
        this.degraded = true;
        this.lastTransportError = safeMessage;
        this.lastTransportErrorAt = Date.now();
        this.rejectPending(error, worker);
        if (!recover || this.closing)
            return;
        if (role === 'reader') {
            if (!this.readerRestartPromise && !this.restartPromise)
                void this.restartReader(safeMessage).catch(() => { });
            return;
        }
        if (!this.restartPromise) {
            this.automaticRestartTimes = this.automaticRestartTimes.filter(time => Date.now() - time < 30000);
            if (this.automaticRestartTimes.length >= 3) {
                this.restartSuspended = true;
                const writer = this.worker;
                const reader = this.reader;
                this.worker = null;
                this.reader = null;
                this.rejectPending(error);
                const directory = this.spoolDirectory;
                const readerDirectory = this.readerSpoolDirectory;
                void Promise.all([writer?.terminate(), reader?.terminate()]).then(async () => {
                    await this.cleanSpool(directory, 'restart');
                    if (readerDirectory)
                        await this.cleanSpool(readerDirectory, 'restart');
                }).catch(() => { });
            }
            else {
                this.automaticRestartTimes.push(Date.now());
                void this.restart(safeMessage).catch(() => { });
            }
        }
    }
    recordSpoolWarning(warning) {
        if (this.seenSpoolWarnings.has(warning.id))
            return;
        this.seenSpoolWarnings.add(warning.id);
        if (this.seenSpoolWarnings.size > 1024)
            this.seenSpoolWarnings.delete(this.seenSpoolWarnings.values().next().value);
        this.spoolCleanupFailureCount++;
        this.spoolWarnings.push(warning);
        if (this.spoolWarnings.length > 64)
            this.spoolWarnings.shift();
        try {
            if (this.options.onSpoolDiagnostic) {
                void Promise.resolve(this.options.onSpoolDiagnostic(warning)).catch(error => { this.lastSpoolDiagnosticCallbackError = String(error); });
            }
            else
                console.warn('[session-index] FTS spool cleanup warning', JSON.stringify(warning));
        }
        catch (error) {
            this.lastSpoolDiagnosticCallbackError = String(error);
        }
    }
    async cleanSpool(directory, phase) {
        try {
            const target = resolve(directory);
            if (!this.ownedSpools.has(target) || dirname(target) !== dirname(resolve(this.dbPath)) || !basename(target).startsWith(`.fts-staging-${process.pid}-`)) {
                throw rpcError('EFTSSPOOLPATH', 'Refusing cleanup of a staging directory not created by this client');
            }
            const info = await lstat(target).catch(error => {
                if (spoolError(error).code === 'ENOENT')
                    return null;
                throw error;
            });
            if (info && (!info.isDirectory() || info.isSymbolicLink()))
                throw rpcError('EFTSSPOOLPATH', 'Refusing cleanup of a staging path replaced by a file or symbolic link');
            if (info)
                await rm(target, { recursive: true, force: true });
            this.ownedSpools.delete(target);
            this.cleanupPendingDirectories.delete(target);
        }
        catch (error) {
            const warning = { ...spoolError(error), id: randomUUID(), path: directory, phase, at: Date.now() };
            this.cleanupPendingDirectories.add(resolve(directory));
            this.recordSpoolWarning(warning);
            return warning;
        }
    }
    async inspectSpools() {
        if (!this.spoolInspection) {
            this.spoolInspection = inspectFtsSpools(this.dbPath).then(inventory => {
                this.spoolInventory = inventory;
                return inventory;
            }).finally(() => { this.spoolInspection = null; });
        }
        let timeout;
        try {
            return await Promise.race([this.spoolInspection, new Promise(accept => {
                    timeout = setTimeout(() => accept({ ...(this.spoolInventory ?? { parentPath: dirname(resolve(this.dbPath)), entries: [], truncated: false }),
                        scannedAt: Date.now(), error: { code: 'EFTSSPOOLSCAN_TIMEOUT', message: 'FTS staging inventory exceeded 500 ms' } }), 500);
                })]);
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
        }
    }
    async restart(reason = 'FTS worker restart requested') {
        if (this.closing)
            throw rpcError('EFTSCLOSED', 'FTS client is closing');
        if (this.restartPromise)
            return this.restartPromise;
        this.restartSuspended = false;
        this.readerRestartSuspended = false;
        this.restartPromise = (async () => {
            const worker = this.worker;
            const reader = this.reader;
            const directory = this.spoolDirectory;
            const readerDirectory = this.readerSpoolDirectory;
            this.worker = null;
            this.reader = null;
            this.available = false;
            this.degraded = true;
            this.lastTransportError = 'FTS recovery requested (EFTSRESTART)';
            this.lastTransportErrorAt = Date.now();
            this.rejectPending(rpcError('EFTSRESTART', reason));
            await Promise.all([worker?.terminate(), reader?.terminate()]);
            await this.cleanSpool(directory, 'restart');
            if (readerDirectory)
                await this.cleanSpool(readerDirectory, 'restart');
            if (this.closing)
                return;
            this.restarts++;
            this.roleRestarts.writer++;
            this.roleRestarts.reader++;
            this.start();
            if (!(await this.readyPromise))
                throw rpcError('EFTSUNAVAILABLE', 'FTS unavailable after restart');
            queueMicrotask(() => {
                if (this.closing)
                    return;
                try {
                    void Promise.resolve(this.options.onRecovered?.()).catch(error => {
                        this.lastRecoveryCallbackError = error instanceof Error ? error.message : String(error);
                    });
                }
                catch (error) {
                    this.lastRecoveryCallbackError = error instanceof Error ? error.message : String(error);
                }
            });
        })().finally(() => { this.restartPromise = null; });
        void this.restartPromise.catch(() => { });
        return this.restartPromise;
    }
    restartReader(reason) {
        if (this.readerRestartPromise)
            return this.readerRestartPromise;
        this.readerRestartTimes = this.readerRestartTimes.filter(time => Date.now() - time < 30000);
        const suspended = this.readerRestartTimes.length >= 3;
        this.readerRestartSuspended = suspended;
        if (!suspended)
            this.readerRestartTimes.push(Date.now());
        const reader = this.reader;
        const ownerWriter = this.worker;
        const directory = this.readerSpoolDirectory;
        this.reader = null;
        this.available = false;
        if (reader)
            this.rejectPending(rpcError('EFTSRESTART', reason), reader);
        this.readerRestartPromise = (async () => {
            const terminationAt = Date.now();
            await reader?.terminate();
            this.lastReaderTerminationMs = Date.now() - terminationAt;
            this.maxReaderTerminationMs = Math.max(this.maxReaderTerminationMs, this.lastReaderTerminationMs);
            if (directory)
                await this.cleanSpool(directory, 'restart');
            if (this.closing || suspended || !this.worker || this.worker !== ownerWriter)
                return;
            this.restarts++;
            this.roleRestarts.reader++;
            const recoveryDirectory = join(dirname(resolve(this.dbPath)), `.fts-staging-${process.pid}-${randomUUID()}`);
            this.readerReadyPromise = this.startReader(recoveryDirectory);
            this.readyPromise = this.readerReadyPromise;
            if (!(await this.readerReadyPromise))
                throw rpcError('EFTSUNAVAILABLE', 'FTS reader unavailable after recovery');
            // The writer and its checkpoints are unchanged. No source reconciliation is
            // required merely because a read connection was replaced.
        })().finally(() => { this.readerRestartPromise = null; });
        void this.readerRestartPromise.catch(() => { });
        return this.readerRestartPromise;
    }
    async withinDeadline(promise, deadline, signal, diagnostic, phase) {
        if (signal?.aborted)
            throw rpcError('EFTSCANCELLED', `FTS ${diagnostic.op} cancelled`);
        if (Date.now() >= deadline) {
            diagnostic.timeoutPhase = phase;
            throw rpcError('EFTSTIMEOUT', `FTS ${diagnostic.op} deadline exhausted during ${phase}`);
        }
        let timer;
        let abort;
        try {
            return await Promise.race([promise, new Promise((_, reject) => {
                    timer = setTimeout(() => { diagnostic.timeoutPhase = phase; reject(rpcError('EFTSTIMEOUT', `FTS ${diagnostic.op} deadline exhausted during ${phase}`)); }, deadline - Date.now());
                    abort = () => reject(rpcError('EFTSCANCELLED', `FTS ${diagnostic.op} cancelled`));
                    signal?.addEventListener('abort', abort, { once: true });
                    if (signal?.aborted)
                        abort();
                })]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
            if (abort)
                signal?.removeEventListener('abort', abort);
        }
    }
    async call(op, args, requestOptions = {}, admitted = false, data) {
        const role = readerOperation(op) ? 'reader' : 'writer';
        const beganAt = Date.now();
        const id = ++this.sequence;
        const diagnostic = { requestId: id, op, backend: 'fts', role, generation: this.generation[role],
            parentRequestId: requestOptions.parentRequestId,
            startedAt: beganAt, totalMs: 0, readyWaitMs: 0, recoveryWaitMs: 0, admissionMs: 0, outcome: 'error' };
        const timeoutMs = requestOptions.timeoutMs ?? (role === 'reader' || op === 'health' ? this.options.queryTimeoutMs ?? 10000 : this.options.writeTimeoutMs ?? 120000);
        const deadline = requestOptions.deadlineAt ?? beganAt + timeoutMs;
        try {
            if (this.closing && !admitted)
                throw rpcError('EFTSCLOSED', 'FTS client is closing');
            if (requestOptions.signal?.aborted)
                throw rpcError('EFTSCANCELLED', `FTS ${op} cancelled`);
            const recovery = this.restartPromise ?? (role === 'reader' ? this.readerRestartPromise : null);
            if (recovery) {
                const recoveryAt = Date.now();
                try {
                    await this.withinDeadline(recovery, deadline, requestOptions.signal, diagnostic, 'recovery');
                }
                finally {
                    diagnostic.recoveryWaitMs = Date.now() - recoveryAt;
                }
            }
            const readyAt = Date.now();
            try {
                if (!(await this.withinDeadline(role === 'reader' ? this.readyPromise : this.writerReadyPromise, deadline, requestOptions.signal, diagnostic, 'ready')) || !this.worker)
                    throw rpcError('EFTSUNAVAILABLE', 'FTS worker is unavailable');
            }
            finally {
                diagnostic.readyWaitMs = Date.now() - readyAt;
            }
            if (requestOptions.signal?.aborted)
                throw rpcError('EFTSCANCELLED', `FTS ${op} cancelled`);
            const admissionAt = Date.now();
            while (data && this.inFlightBatches >= FTS_INFLIGHT_BATCHES) {
                await new Promise((accept, reject) => {
                    const timer = setTimeout(() => { cleanup(); diagnostic.timeoutPhase = 'admission'; reject(rpcError('EFTSTIMEOUT', 'FTS batch admission deadline exhausted')); }, Math.max(0, deadline - Date.now()));
                    const done = () => { cleanup(); accept(); };
                    const abort = () => { cleanup(); reject(rpcError('EFTSCANCELLED', 'FTS batch admission cancelled')); };
                    const cleanup = () => { clearTimeout(timer); this.batchWaiters.delete(done); requestOptions.signal?.removeEventListener('abort', abort); };
                    this.batchWaiters.add(done);
                    requestOptions.signal?.addEventListener('abort', abort, { once: true });
                    if (requestOptions.signal?.aborted)
                        abort();
                });
                if (requestOptions.signal?.aborted)
                    throw rpcError('EFTSCANCELLED', `FTS ${op} cancelled`);
                if (!this.worker || this.startupState.writer?.state !== 'ready')
                    throw rpcError('EFTSRESTART', 'FTS writer changed during batch admission');
            }
            diagnostic.admissionMs = Date.now() - admissionAt;
            if (this.pending.size >= (this.options.maxPendingRequests ?? 128))
                throw rpcError('EFTSQUEUE', 'FTS request queue is full');
            const bytes = data?.byteLength ?? Buffer.byteLength(JSON.stringify(args));
            if ((data && bytes > FTS_BATCH_BYTES) || this.queueBytes + this.queuedSourceBytes + bytes > FTS_QUEUE_BYTES)
                throw rpcError('EFTSQUEUE', 'FTS transfer byte budget exceeded');
            const worker = role === 'reader' ? this.reader : this.worker;
            if (!worker)
                throw rpcError('EFTSUNAVAILABLE', 'FTS request owner is unavailable');
            diagnostic.generation = this.generation[role];
            const result = await new Promise((accept, reject) => {
                const abort = () => {
                    const request = this.pending.get(id);
                    if (!request)
                        return;
                    this.release(id, request);
                    this.cancelledRequests++;
                    worker.postMessage({ cancel: id });
                    reject(rpcError('EFTSCANCELLED', `FTS ${op} cancelled`));
                    if (request.started && role === 'reader')
                        this.failWorker(worker, rpcError('EFTSCANCELLED', `FTS active ${op} cancelled`));
                };
                const timer = setTimeout(() => {
                    const request = this.pending.get(id);
                    if (!request)
                        return;
                    this.release(id, request);
                    this.requestTimeouts++;
                    diagnostic.timeoutPhase = request.started ? 'execution' : 'queue';
                    if (!request.started)
                        this.queueTimeouts++;
                    const error = rpcError(request.started ? 'EFTSTIMEOUT' : 'EFTSQUEUETIMEOUT', `FTS ${op} total deadline exceeded during ${diagnostic.timeoutPhase}`);
                    worker.postMessage({ cancel: id });
                    reject(error);
                    if (request.started)
                        this.failWorker(worker, error);
                }, Math.max(0, deadline - Date.now()));
                const request = { worker, role, started: !this.workerTiming.has(worker), diagnostic,
                    resolve: value => accept(value), reject, timer, bytes, batch: !!data,
                    cleanup: () => requestOptions.signal?.removeEventListener('abort', abort) };
                this.pending.set(id, request);
                this.queueBytes += bytes;
                this.maxQueueBytes = Math.max(this.maxQueueBytes, this.queueBytes + this.queuedSourceBytes);
                if (data) {
                    this.inFlightBatches++;
                    this.maxInFlightBatches = Math.max(this.maxInFlightBatches, this.inFlightBatches);
                    this.maxBatchBytes = Math.max(this.maxBatchBytes, bytes);
                }
                requestOptions.signal?.addEventListener('abort', abort, { once: true });
                try {
                    const message = { id, op, args, data, deadline, sentAt: Date.now() };
                    worker.postMessage(message);
                    if (requestOptions.signal?.aborted)
                        abort();
                }
                catch (error) {
                    this.release(id, request);
                    reject(error);
                }
            });
            diagnostic.outcome = 'ok';
            return result;
        }
        catch (error) {
            diagnostic.errorCode = error.code ?? 'EFTSTRANSPORT';
            diagnostic.outcome = diagnostic.errorCode === 'EFTSCANCELLED' ? 'cancelled' : 'error';
            if (diagnostic.errorCode === 'EFTSTIMEOUT' && diagnostic.timeoutPhase && /^(ready|recovery|admission)$/.test(diagnostic.timeoutPhase))
                this.requestTimeouts++;
            throw error;
        }
        finally {
            diagnostic.totalMs = Date.now() - beganAt;
            if (diagnostic.dispatchMs !== undefined) {
                // dispatchMs includes sqlMs. The remaining total is an estimate of IPC,
                // scheduling and client accounting, not a second measured SQL duration.
                diagnostic.transportMs = Math.max(0, diagnostic.totalMs - diagnostic.readyWaitMs - diagnostic.recoveryWaitMs - diagnostic.admissionMs
                    - (diagnostic.queueMs ?? 0) - diagnostic.dispatchMs - (diagnostic.serializationMs ?? 0) - (diagnostic.healthSnapshotMs ?? 0));
                diagnostic.transportIsResidual = true;
            }
            this.notifyDiagnostic(this.options.onRequestDiagnostic, diagnostic);
        }
    }
    write(work, file) {
        if (this.closing)
            return Promise.reject(rpcError('EFTSCLOSED', 'FTS client is closing'));
        if (this.writes.size >= (this.options.maxPendingRequests ?? 128))
            return Promise.reject(rpcError('EFTSQUEUE', 'FTS write admission queue is full'));
        const id = ++this.writeSequence;
        const promise = work();
        this.writes.set(id, promise);
        void promise.then(() => { if (file)
            this.failedFiles.delete(file); }, error => {
            this.failures.push({ id, error: error instanceof Error ? error : new Error(String(error)) });
            this.lastWriteError = error instanceof Error ? error.message : String(error);
            this.lastWriteErrorAt = Date.now();
            if (file)
                this.failedFiles.add(file);
        }).finally(() => { this.writes.delete(id); });
        return promise;
    }
    async stream(kind, header, rows, options) {
        options = { ...options, deadlineAt: options.deadlineAt ?? Date.now() + (options.timeoutMs ?? this.options.writeTimeoutMs ?? 120000) };
        if (options.signal?.aborted)
            throw rpcError('EFTSCANCELLED', 'FTS session transfer cancelled');
        const sourceBytes = Buffer.byteLength(JSON.stringify(header)) + rows.reduce((sum, row) => sum + 256 + Object.values(row).reduce((size, value) => size + (typeof value === 'string' ? value.length * 2 : 8), 0), 0);
        const bodyBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row.text) + Buffer.byteLength(row.toolName), 0);
        if (bodyBytes > FTS_SOURCE_BODY_BYTES)
            throw rpcError('EFTSSOURCE', 'FTS session body exceeds its 64 MiB UTF-8 budget');
        if (this.activeStreams >= 2) {
            // Waiting producers retain their caller-owned row arrays, so those count too.
            const bytes = sourceBytes;
            if (this.queueBytes + this.queuedSourceBytes + bytes > FTS_QUEUE_BYTES - FTS_INFLIGHT_BATCHES * FTS_BATCH_BYTES)
                throw rpcError('EFTSQUEUE', 'FTS queued source byte budget exceeded');
            this.queuedSourceBytes += bytes;
            this.maxQueueBytes = Math.max(this.maxQueueBytes, this.queueBytes + this.queuedSourceBytes);
            try {
                while (this.activeStreams >= 2) {
                    await new Promise((accept, reject) => {
                        const timer = setTimeout(() => { cleanup(); reject(rpcError('EFTSTIMEOUT', 'FTS producer admission deadline exhausted')); }, Math.max(0, options.deadlineAt - Date.now()));
                        const done = () => { cleanup(); accept(); };
                        const abort = () => { cleanup(); reject(rpcError('EFTSCANCELLED', 'FTS producer admission cancelled')); };
                        const cleanup = () => { clearTimeout(timer); this.producerWaiters.delete(done); options.signal?.removeEventListener('abort', abort); };
                        this.producerWaiters.add(done);
                        options.signal?.addEventListener('abort', abort, { once: true });
                        if (options.signal?.aborted)
                            abort();
                    });
                }
            }
            finally {
                this.queuedSourceBytes -= bytes;
            }
        }
        this.activeStreams++;
        this.activeSourceBytes += sourceBytes;
        this.activeBodyBytes += bodyBytes;
        this.maxActiveSourceBytes = Math.max(this.maxActiveSourceBytes, this.activeSourceBytes);
        this.maxActiveBodyBytes = Math.max(this.maxActiveBodyBytes, this.activeBodyBytes);
        const token = randomUUID();
        const inFlight = new Set();
        try {
            await this.call('stageBegin', [kind, header, token], options, true);
            let packet = new Uint8Array(FTS_BATCH_BYTES);
            let used = 0;
            let ordinal = 0;
            const send = async () => {
                if (!used)
                    return;
                while (inFlight.size >= FTS_INFLIGHT_BATCHES)
                    await Promise.race(inFlight);
                const bytes = packet.slice(0, used);
                const operation = this.call('stageBatch', [token, ordinal++], options, true, bytes);
                inFlight.add(operation);
                void operation.then(() => inFlight.delete(operation), () => { });
                packet = new Uint8Array(FTS_BATCH_BYTES);
                used = 0;
            };
            const encoder = new TextEncoder();
            function* segments(row) {
                yield '{';
                let separator = '';
                for (const [key, value] of Object.entries(row)) {
                    if (value === undefined)
                        continue;
                    yield separator + JSON.stringify(key) + ':';
                    separator = ',';
                    if (typeof value !== 'string') {
                        yield JSON.stringify(value);
                        continue;
                    }
                    yield '"';
                    for (let offset = 0; offset < value.length;) {
                        let end = Math.min(value.length, offset + 16384);
                        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end]))
                            end--;
                        yield JSON.stringify(value.slice(offset, end)).slice(1, -1);
                        offset = end;
                    }
                    yield '"';
                }
                yield '}\n';
            }
            for (let index = 0; index < rows.length; index++) {
                if (options.signal?.aborted)
                    throw rpcError('EFTSCANCELLED', 'FTS session transfer cancelled');
                if (Date.now() >= options.deadlineAt)
                    throw rpcError('EFTSTIMEOUT', 'FTS session transfer deadline exhausted');
                for (const serialized of segments(rows[index])) {
                    const bytes = encoder.encode(serialized);
                    let position = 0;
                    while (position < bytes.length) {
                        const count = Math.min(packet.length - used, bytes.length - position);
                        packet.set(bytes.subarray(position, position + count), used);
                        used += count;
                        position += count;
                        if (used === packet.length)
                            await send();
                    }
                }
                if (index % 64 === 63)
                    await new Promise(resolveImmediate => setImmediate(resolveImmediate));
            }
            await send();
            await Promise.all(inFlight);
            return await this.call('stageCommit', [token], options, true);
        }
        catch (error) {
            await Promise.allSettled(inFlight);
            await this.call('stageAbort', [token], { timeoutMs: 1000 }, true).catch(() => { });
            throw error;
        }
        finally {
            this.activeStreams--;
            this.activeSourceBytes -= sourceBytes;
            this.activeBodyBytes -= bodyBytes;
            for (const accept of this.producerWaiters)
                accept();
            this.producerWaiters.clear();
        }
    }
    syncSession(request, options = {}) {
        const { messages, ...header } = request;
        return this.write(() => this.stream('session', header, messages, options), request.meta.file);
    }
    syncMessages(file, rows, append, options = {}) {
        return this.write(() => this.stream('messages', { file, append }, rows, options), file);
    }
    upsertSession(meta) { return this.write(() => this.call('upsertSession', [meta], {}, true), meta.file); }
    removeSession(file) { return this.write(() => this.call('removeSession', [file], {}, true), file); }
    markPruned(count) { return this.write(() => this.call('markPruned', [count], {}, true)); }
    optimize() { return this.write(() => this.call('optimize', [], {}, true)); }
    vacuum() { return this.write(() => this.call('vacuum', [], {}, true)); }
    maybeMaintenance() { return this.write(() => this.call('maybeMaintenance', [], {}, true)); }
    getCheckpoint(file) { return this.call('getCheckpoint', [file]); }
    needsSync(meta) { return this.call('needsSync', [meta]); }
    listSessionFiles() { return this.call('listSessionFiles', []); }
    sessionCount() { return this.call('sessionCount', []); }
    lastPruneAt() { return this.call('lastPruneAt', []); }
    lastPruneCount() { return this.call('lastPruneCount', []); }
    async search(query, workspace, limit, filter, options = {}) {
        if (!Number.isInteger(limit) || limit < 1 || limit > FTS_MAX_QUERY_HITS)
            throw new RangeError(`FTS query limit must be 1..${FTS_MAX_QUERY_HITS}`);
        return this.call('search', [query, workspace, limit, filter], options);
    }
    async searchPage(query, workspace, limit, filter, options = {}) {
        if (!Number.isInteger(limit) || limit < 1 || limit > FTS_MAX_QUERY_HITS)
            throw new RangeError(`FTS query limit must be 1..${FTS_MAX_QUERY_HITS}`);
        return this.call('searchPage', [query, workspace, limit, filter], options);
    }
    around(sessionId, anchor, window = 5, options = {}) {
        return this.call('around', [sessionId, anchor, window], options);
    }
    resolveLegacyAnchor(sessionId, rowid) {
        return this.call('resolveLegacyAnchor', [sessionId, rowid]);
    }
    diagnostics() {
        return { degraded: this.degraded, workerReady: !!this.worker && this.startupState.writer?.state === 'ready',
            readerReady: !!this.reader && this.startupState.reader?.state === 'ready',
            restarts: this.restarts, restartSuspended: this.restartSuspended || this.readerRestartSuspended,
            writerRestartSuspended: this.restartSuspended,
            writerRestarts: this.roleRestarts.writer, readerRestarts: this.roleRestarts.reader,
            writerGeneration: this.generation.writer, readerGeneration: this.generation.reader,
            writerTransport: 'process', writerPid: this.worker?.pid, readerTransport: 'process', readerPid: this.reader?.pid,
            liveProcessPids: [...this.liveChannels].map(channel => channel.pid),
            lastReaderTerminationMs: this.lastReaderTerminationMs, maxReaderTerminationMs: this.maxReaderTerminationMs,
            writerTransportFailures: this.transportFailures.writer, readerTransportFailures: this.transportFailures.reader,
            writerLastTransportError: this.roleLastError.writer, readerLastTransportError: this.roleLastError.reader,
            writerPendingRequests: [...this.pending.values()].filter(request => request.role === 'writer').length,
            readerPendingRequests: [...this.pending.values()].filter(request => request.role === 'reader').length,
            readerRestartSuspended: this.readerRestartSuspended, startup: { ...this.startupState },
            requestTimeouts: this.requestTimeouts, queueTimeouts: this.queueTimeouts, cancelledRequests: this.cancelledRequests,
            lastDiagnosticCallbackError: this.diagnosticCallbackError,
            pendingRequests: this.pending.size, pendingWrites: this.writes.size, activeStreams: this.activeStreams,
            activeSourceBytes: this.activeSourceBytes, maxActiveSourceBytes: this.maxActiveSourceBytes,
            activeBodyBytes: this.activeBodyBytes, maxActiveBodyBytes: this.maxActiveBodyBytes,
            writerMemory: this.writerTelemetry?.memory, readerMemory: this.readerTelemetry?.memory,
            maxWriterHeapUsed: this.maxWriterHeapUsed, maxReaderHeapUsed: this.maxReaderHeapUsed,
            writerStagedBytes: this.writerTelemetry?.stagedBytes ?? 0, maxWriterStagedBytes: this.maxWriterStagedBytes,
            queueBytes: this.queueBytes + this.queuedSourceBytes, transportQueueBytes: this.queueBytes, queuedSourceBytes: this.queuedSourceBytes,
            queuedProducers: this.producerWaiters.size, maxQueueBytes: this.maxQueueBytes, inFlightBatches: this.inFlightBatches,
            maxInFlightBatches: this.maxInFlightBatches, maxBatchBytes: this.maxBatchBytes,
            lastTransportError: this.lastTransportError, lastTransportErrorAt: this.lastTransportErrorAt,
            lastRecoveryCallbackError: this.lastRecoveryCallbackError,
            lastWriteError: this.lastWriteError, lastWriteErrorAt: this.lastWriteErrorAt,
            failedSessions: this.failedFiles.size,
            spoolCleanupFailures: [...this.spoolWarnings], spoolCleanupFailureCount: this.spoolCleanupFailureCount,
            spoolCleanupPendingDirectories: [...this.cleanupPendingDirectories],
            spoolCleanupPendingStages: this.worker ? this.writerTelemetry?.cleanupPendingStages ?? 0 : 0,
            lastSpoolCleanupError: this.spoolWarnings.at(-1)?.message ?? '', lastSpoolDiagnosticCallbackError: this.lastSpoolDiagnosticCallbackError,
            spoolInventory: this.spoolInventory,
            orphanSpoolCount: this.spoolInventory?.entries.filter(entry => !this.ownedSpools.has(resolve(entry.path)) && entry.ownerState === 'dead').length ?? 0,
            unknownSpoolOwnerCount: this.spoolInventory?.entries.filter(entry => !this.ownedSpools.has(resolve(entry.path)) && entry.ownerState === 'unknown').length ?? 0,
            acceptingWrites: !this.closing && !!this.worker && this.startupState.writer?.state === 'ready', hostMemory: process.memoryUsage() };
    }
    async health() {
        // Startup progress is posted by synchronous migration batches. Querying the
        // worker while it is migrating would merely join the blocked SQL queue.
        if (this.startupState.writer?.state !== 'ready')
            return { ...this.lastHealth, ...this.diagnostics(), healthSnapshot: true };
        // Include an admitted mutation awaiting its permit: otherwise health can
        // join the writer queue just before that transaction enters native SQL.
        const mutation = [...this.pending.values()].find(request => request.role === 'writer' && writerMutation(request.diagnostic.op));
        if (mutation)
            return { ...this.lastHealth, ...this.diagnostics(), healthSnapshot: true, healthBusy: true,
                healthBusyOperation: mutation.diagnostic.op, healthBusyPhase: mutation.started ? 'execution' : 'queue',
                healthCheckErrorCode: '' };
        let healthSnapshot = false;
        let healthCheckErrorCode = '';
        try {
            this.lastHealth = await this.call('health', []);
            if (this.available)
                this.degraded = false;
        }
        catch (error) {
            this.degraded = true;
            this.lastTransportError = `FTS health check failed (${diagnosticCode(error)})`;
            this.lastTransportErrorAt = Date.now();
            healthSnapshot = true;
            healthCheckErrorCode = error.code ?? 'EFTSHEALTH';
        }
        this.spoolInventory = await this.inspectSpools();
        return { ...this.lastHealth, ...this.diagnostics(), healthSnapshot, healthBusy: false, healthCheckErrorCode };
    }
    async flush() {
        const boundary = this.writeSequence;
        await Promise.allSettled([...this.writes].filter(([id]) => id <= boundary).map(([, promise]) => promise));
        const failures = this.failures.filter(failure => failure.id <= boundary);
        let workerError;
        try {
            await this.call('flush', [], {}, true);
        }
        catch (error) {
            workerError = error;
        }
        this.failures = this.failures.filter(failure => failure.id > boundary);
        if (failures.length)
            throw new AggregateError(failures.map(failure => failure.error), failures.map(failure => failure.error.message).join('; '));
        if (workerError)
            throw workerError;
    }
    close() {
        if (this.closePromise)
            return this.closePromise;
        this.closing = true;
        this.closePromise = (async () => {
            let timeout;
            let primaryError;
            const cleanupFailures = [];
            try {
                await Promise.race([
                    (async () => { await this.flush(); await this.call('close', [], {}, true); })(),
                    new Promise((_, reject) => { timeout = setTimeout(() => reject(rpcError('EFTSCLOSETIMEOUT', 'FTS drain timed out')), this.options.closeTimeoutMs ?? 15000); }),
                ]);
            }
            catch (error) {
                primaryError = error;
            }
            finally {
                if (timeout)
                    clearTimeout(timeout);
                const worker = this.worker;
                const reader = this.reader;
                this.worker = null;
                this.reader = null;
                this.available = false;
                this.rejectPending(rpcError('EFTSCLOSED', 'FTS client closed'));
                try {
                    await Promise.all([worker?.terminate(), reader?.terminate(), ...this.retiredTerminations]);
                }
                catch (error) {
                    primaryError ??= error;
                }
                // Includes our retired directories whose earlier restart cleanup failed.
                // Historical orphan directories are never inserted into this ownership set.
                for (const directory of this.liveChannels.size ? [] : [...this.ownedSpools]) {
                    const failure = await this.cleanSpool(directory, 'client-close');
                    if (failure)
                        cleanupFailures.push(failure);
                }
            }
            if (primaryError)
                throw primaryError;
            if (cleanupFailures.length)
                throw rpcError('EFTSSPOOLCLEANUP', cleanupFailures.map(failure => `${failure.path}: ${failure.code}: ${failure.message}`).join('; '));
        })();
        void this.closePromise.catch(() => { });
        return this.closePromise;
    }
}
//# sourceMappingURL=fts-client.js.map