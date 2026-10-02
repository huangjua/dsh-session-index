export interface FtsSpoolOwner {
    version: 1;
    pid: number;
    /** Dedicated SQLite child PID; creator PID remains the directory identity. */
    workerPid?: number;
    token: string;
    role: 'writer' | 'reader';
    createdAt: number;
    databasePath: string;
}
export interface FtsSpoolError {
    code: string;
    message: string;
}
export interface FtsSpoolEntry {
    path: string;
    ownerState: 'alive' | 'dead' | 'unknown';
    ownerPid?: number;
    role?: 'writer' | 'reader';
    owner?: FtsSpoolOwner;
    error?: FtsSpoolError;
    verification: 'owner-metadata-and-pid' | 'directory-pid-only' | 'unverified';
}
export interface FtsSpoolInventory {
    parentPath: string;
    scannedAt: number;
    entries: FtsSpoolEntry[];
    truncated: boolean;
    error?: FtsSpoolError;
}
export interface FtsSpoolCleanupFailure extends FtsSpoolError {
    id: string;
    path: string;
    phase: 'commit' | 'rollback' | 'abort' | 'close' | 'restart' | 'client-close' | 'retry';
    at: number;
    /** Set only when the engine's receipt or primary SQL failure proved its state. */
    writeCommitted?: boolean;
}
export declare function spoolIdentity(directory: string): {
    pid: number;
    token: string;
    role: 'writer' | 'reader';
} | null;
export declare function spoolError(error: unknown, fallback?: string): FtsSpoolError;
export declare function probeSpoolOwner(pid: number, probe?: (pid: number) => void): {
    state: FtsSpoolEntry['ownerState'];
    error?: FtsSpoolError;
};
export declare function writeSpoolOwner(directory: string, databasePath: string): Promise<void>;
export declare function inspectFtsSpools(databasePath: string): Promise<FtsSpoolInventory>;
