/** Bounded, read-only inventory for current and historical FTS staging directories. */
import { lstat, open, opendir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
const NAME = /^\.fts-staging-(\d+)-([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})(-reader)?$/i;
export function spoolIdentity(directory) {
    const match = NAME.exec(basename(directory));
    if (!match)
        return null;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff)
        return null;
    return { pid, token: match[2], role: match[3] ? 'reader' : 'writer' };
}
export function spoolError(error, fallback = 'EFTSSPOOL') {
    const value = error;
    return { code: typeof value?.code === 'string' ? value.code : fallback,
        message: typeof value?.message === 'string' ? value.message : String(error) };
}
export function probeSpoolOwner(pid, probe = value => { process.kill(value, 0); }) {
    try {
        probe(pid);
        return { state: 'alive' };
    }
    catch (error) {
        const diagnostic = spoolError(error);
        return diagnostic.code === 'ESRCH' ? { state: 'dead' } : { state: 'unknown', error: diagnostic };
    }
}
export async function writeSpoolOwner(directory, databasePath) {
    const identity = spoolIdentity(directory);
    if (!identity || (identity.pid !== process.pid && identity.pid !== process.ppid) || dirname(resolve(directory)) !== dirname(resolve(databasePath))) {
        throw Object.assign(new Error('Unsafe FTS spool owner path'), { code: 'EFTSSPOOLPATH' });
    }
    const owner = { ...identity, version: 1, createdAt: Date.now(), databasePath: resolve(databasePath) };
    if (identity.pid !== process.pid)
        owner.workerPid = process.pid;
    await writeFile(join(directory, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
}
async function inspectEntry(path) {
    const identity = spoolIdentity(path);
    const entry = { path, ownerState: 'unknown', verification: 'unverified' };
    if (!identity)
        return { ...entry, error: { code: 'EFTSSPOOLOWNER', message: 'Malformed spool directory identity' } };
    entry.ownerPid = identity.pid;
    entry.role = identity.role;
    let owner;
    try {
        if ((await lstat(path)).isSymbolicLink())
            return { ...entry, error: { code: 'EFTSSPOOLPATH', message: 'Spool is a symbolic link; diagnostic does not follow it' } };
        const ownerPath = join(path, 'owner.json');
        if ((await lstat(ownerPath)).isSymbolicLink())
            throw Object.assign(new Error('Spool owner metadata is a symbolic link'), { code: 'EFTSSPOOLOWNER' });
        const file = await open(ownerPath, 'r');
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > 4096)
                throw Object.assign(new Error('Spool owner metadata exceeds its 4096-byte limit'), { code: 'EFTSSPOOLOWNER' });
            const buffer = Buffer.alloc(4097);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
            if (bytesRead > 4096)
                throw Object.assign(new Error('Spool owner metadata grew beyond its limit'), { code: 'EFTSSPOOLOWNER' });
            owner = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
        }
        finally {
            await file.close();
        }
        if (owner.version !== 1 || owner.pid !== identity.pid || owner.token !== identity.token || owner.role !== identity.role ||
            typeof owner.databasePath !== 'string' || !Number.isFinite(owner.createdAt) ||
            (owner.workerPid !== undefined && (!Number.isSafeInteger(owner.workerPid) || owner.workerPid <= 0))) {
            throw Object.assign(new Error('Spool owner metadata does not match its directory identity'), { code: 'EFTSSPOOLOWNER' });
        }
        entry.owner = owner;
        entry.verification = 'owner-metadata-and-pid';
    }
    catch (error) {
        entry.error = spoolError(error, 'EFTSSPOOLOWNER');
        if (entry.error.code !== 'ENOENT')
            return entry;
        // Legacy directories did not have owner.json. A dead PID is useful evidence;
        // a live PID alone cannot establish that the original owner still exists.
        const legacy = probeSpoolOwner(identity.pid);
        entry.verification = 'directory-pid-only';
        if (legacy.state === 'dead')
            entry.ownerState = 'dead';
        if (legacy.error)
            entry.error = legacy.error;
        return entry;
    }
    const probe = probeSpoolOwner(identity.pid);
    const childProbe = owner.workerPid === undefined ? null : probeSpoolOwner(owner.workerPid);
    entry.ownerState = probe.state === 'alive' || childProbe?.state === 'alive' ? 'alive' :
        probe.state === 'unknown' || childProbe?.state === 'unknown' ? 'unknown' : 'dead';
    if (probe.error)
        entry.error = probe.error;
    else if (childProbe?.error)
        entry.error = childProbe.error;
    return entry;
}
export async function inspectFtsSpools(databasePath) {
    const result = { parentPath: dirname(resolve(databasePath)), scannedAt: Date.now(), entries: [], truncated: false };
    try {
        const directory = await opendir(result.parentPath);
        let visited = 0;
        for await (const entry of directory) {
            if (++visited > 4096) {
                result.truncated = true;
                break;
            }
            if (!entry.name.toLowerCase().startsWith('.fts-staging-'))
                continue;
            if (result.entries.length >= 128) {
                result.truncated = true;
                break;
            }
            const path = join(result.parentPath, entry.name);
            if (!entry.isDirectory() && !entry.isSymbolicLink()) {
                result.entries.push({ path, ownerState: 'unknown', verification: 'unverified',
                    error: { code: 'EFTSSPOOLPATH', message: 'Spool candidate is not a directory' } });
            }
            else
                result.entries.push(await inspectEntry(path));
        }
    }
    catch (error) {
        result.error = spoolError(error, 'EFTSSPOOLSCAN');
    }
    return result;
}
//# sourceMappingURL=fts-spool.js.map