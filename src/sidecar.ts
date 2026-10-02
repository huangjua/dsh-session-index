/**
 * sidecar.ts — JSONL 旁车文件公共层（C10 收敛）
 *
 * bookmark.ts（书签）与 llm-summary.ts（LLM 摘要缓存）各自实现了一遍同构逻辑：
 * 进程内 per-path 互斥、追加行（open 'a' + write + sync）、mtime+size 指纹缓存、
 * 行级校验守卫（isRecord/str/num）。三份实现里 core.ts saveIndex 的原子写最弱
 * （固定 tmp 名、无 fsync、无校验），bookmark 的 atomicWriteText 居中，
 * atomic-write.ts 的 atomicWriteJson 最完整。
 *
 * 本模块收敛为单一事实源：
 * - withPathLock：进程内 per-path 串行；withFileLock：用户书签跨进程互斥
 * - appendLine：追加 + fsync
 * - atomicWriteText：tmp + fsync + rename（与 atomic-write.ts 同款强度）
 * - createFingerprintCache：mtime+size 指纹缓存（解析逻辑由调用方注入）
 * - isRecord/str/num：行级校验守卫
 *
 * 注意：合并后两个模块共享**同一个** pathLocks Map——互斥粒度是「同路径」，
 * 不同路径互不阻塞，书签与摘要缓存路径本就不同，行为不变。
 */
import { mkdir, open, readFile, stat, rename, unlink, realpath, readdir, rmdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, basename, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

/* ── 进程内 per-path 互斥 ─────────────────────────────────────────────────── */

const pathLocks = new Map<string, Promise<unknown>>()

/**
 * 同一路径上的操作串行执行（跨路径并行）。
 * 链上保留（即使本次失败也不阻塞后续）；调用方仍收到本次的 rejection。
 */
export function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  const prev = pathLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn)
  const settled = next.catch(() => undefined)
  pathLocks.set(key, settled)
  void settled.then(() => { if (pathLocks.get(key) === settled) pathLocks.delete(key) })
  return next
}

/* ── 跨进程文件互斥：完整 owner 目录原子发布，死进程恢复 ─────────────────── */

export interface FileLockOptions {
  /** 包括同进程排队的总等待预算；超时显式抛出 ELOCKTIMEOUT。 */
  timeoutMs?: number
  retryMs?: number
}

interface LockOwner { v: 1; pid: number; token: string }

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code
}

/** realpath 消除 junction/symlink 别名；缺失文件按真实父目录定位。 */
export async function canonicalFilePath(path: string): Promise<string> {
  const absolute = resolve(path)
  let actual: string
  try { actual = await realpath(absolute) }
  catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
    actual = join(await realpath(dirname(absolute)), basename(absolute))
  }
  return process.platform === 'win32' ? actual.toLowerCase() : actual
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) {
    if (errorCode(error) === 'ESRCH') return false
    if (errorCode(error) === 'EPERM') return true
    throw error
  }
}

/** 只删除 token 命名的 owner 文件；新 owner 的非空目录不能被 rmdir 删除。 */
async function removeOwnedLock(lockDir: string, ownerName: string, token: string): Promise<void> {
  let owner: LockOwner
  try { owner = JSON.parse(await readFile(join(lockDir, ownerName), 'utf8')) as LockOwner }
  catch (error) { if (errorCode(error) === 'ENOENT') return; throw error }
  if (owner.token !== token) return
  try { await unlink(join(lockDir, ownerName)) }
  catch (error) { if (errorCode(error) === 'ENOENT') return; throw error }
  try { await rmdir(lockDir) }
  catch (error) {
    // POSIX rename 可以替换刚释放的空目录；Windows 会等待 rmdir 后重试。
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) throw error
  }
}

async function recoverDeadLock(lockDir: string): Promise<void> {
  let names: string[]
  try { names = await readdir(lockDir) }
  catch (error) { if (errorCode(error) === 'ENOENT') return; throw error }
  if (names.length === 0) {
    try { await rmdir(lockDir) }
    catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) throw error }
    return
  }
  const ownerName = names.length === 1 && /^owner-[0-9]+-[a-f0-9-]+\.json$/.test(names[0]) ? names[0] : null
  const ownerPid = ownerName ? Number(ownerName.split('-')[1]) : 0
  // 文件名携带已发布的 PID；存活 owner 不读文件，避免 Windows 释放时的 delete-pending 打开竞争。
  if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && processIsAlive(ownerPid)) return
  let owner: LockOwner | null = null
  if (ownerName) {
    try { owner = JSON.parse(await readFile(join(lockDir, ownerName), 'utf8')) as LockOwner }
    catch (error) { if (errorCode(error) === 'ENOENT') return; throw error }
  }
  if (!ownerName || !owner || owner.v !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.token !== 'string' || ownerName !== `owner-${owner.pid}-${owner.token}.json`) {
    throw Object.assign(new Error(`Invalid file lock owner: ${lockDir}`), { code: 'ELOCKCORRUPT' })
  }
  // 不按 TTL 抢占：即使持锁很久，存活/权限不足的 PID 仍受保护。
  if (!processIsAlive(owner.pid)) await removeOwnedLock(lockDir, ownerName, owner.token)
}

/**
 * 完整的跨进程临界区。fn 使用规范化实际路径，确保锁与 rename 指向同一资源。
 * owner 在私有目录写入并 fsync 后才 rename 发布，因此崩溃不会留下无 owner 的锁。
 */
export async function withFileLock<T>(
  path: string, fn: (actualPath: string) => Promise<T>, options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000
  const retryMs = options.retryMs ?? 20
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(retryMs) || retryMs <= 0) {
    throw new RangeError('File lock timeoutMs/retryMs must be finite and non-negative/positive')
  }
  const deadline = Date.now() + timeoutMs
  await mkdir(dirname(resolve(path)), { recursive: true })
  const actualPath = await canonicalFilePath(path)
  const lockDir = `${actualPath}.lock`
  const token = randomUUID()
  const ownerName = `owner-${process.pid}-${token}.json`
  const candidate = `${lockDir}.candidate-${process.pid}-${token}`
  await mkdir(candidate)
  let acquired = false
  try {
    const handle = await open(join(candidate, ownerName), 'wx')
    try { await handle.writeFile(JSON.stringify({ v: 1, pid: process.pid, token }), 'utf8'); await handle.sync() }
    finally { await handle.close() }
    for (;;) {
      try { await rename(candidate, lockDir); acquired = true; break }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(errorCode(error) ?? '')) throw error
        // EPERM/EACCES 也可能是目录权限问题，不能折叠成锁争用。
        try { await stat(lockDir) }
        catch (missing) {
          if (errorCode(missing) !== 'ENOENT') throw missing
          if (errorCode(error) === 'EACCES' || Date.now() >= deadline) throw error
          continue // 竞争者刚释放；下一次原子 rename 再判定。
        }
        await recoverDeadLock(lockDir)
        if (Date.now() >= deadline) {
          throw Object.assign(new Error(`Timed out waiting for file lock after ${timeoutMs}ms: ${actualPath}`),
            { code: 'ELOCKTIMEOUT', path: actualPath })
        }
        await new Promise((done) => setTimeout(done, Math.min(retryMs, Math.max(1, deadline - Date.now()))))
      }
    }
    return await fn(actualPath)
  } finally {
    if (acquired) await removeOwnedLock(lockDir, ownerName, token)
    else {
      try { await unlink(join(candidate, ownerName)) } catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
      await rmdir(candidate)
    }
  }
}

/* ── 行级校验守卫 ────────────────────────────────────────────────────────── */

export function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object'
}

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/* ── 追加行（append + flush；与 codex file.flush() 对齐）──────────────────── */

export async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  let fh: FileHandle | null = null
  try {
    fh = await open(path, 'a')
    await fh.writeFile(line + '\n', 'utf8')
    await fh.sync() // flush
    await fh.close()
    fh = null
  } finally {
    if (fh) {
      try {
        await fh.close()
      } catch {
        /* 忽略 */
      }
    }
  }
}

/* ── 原子写文本（tmp + fsync + rename；与 atomic-write.ts 同款强度）────────── */

let tmpSeq = 0

export async function atomicWriteText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `${basename(path)}.tmp.${process.pid}.${tmpSeq++}`)
  let fh: FileHandle | null = null
  try {
    fh = await open(tmp, 'wx')
    await fh.writeFile(text, 'utf8')
    await fh.sync()
    await fh.close()
    fh = null
    await rename(tmp, path) // Windows: MoveFileEx(REPLACE_EXISTING)
  } catch (e) {
    if (fh) {
      try {
        await fh.close()
      } catch {
        /* 忽略 */
      }
    }
    try {
      await unlink(tmp)
    } catch {
      /* 忽略 */
    }
    throw e
  }
}

/* ── mtime+size 指纹缓存（解析逻辑由调用方注入）───────────────────────────── */

export interface Fingerprint {
  mtimeMs: number
  ctimeMs: number
  size: number
}

export interface FingerprintCache<T> {
  /** 显式失效（写入后调用），防同 ms 同 size 撞车。 */
  invalidate(path: string): void
  /** 命中指纹直接返回缓存值；否则整读 → parse → 回填。strictErrors 时仅 ENOENT fallback。 */
  read(path: string, parse: (text: string) => T, fallback: () => T): Promise<T>
}

export function createFingerprintCache<T>(options: { strictErrors?: boolean } = {}): FingerprintCache<T> {
  const map = new Map<string, Fingerprint & { value: T }>()
  return {
    invalidate(path: string): void {
      map.delete(path)
    },
    async read(path: string, parse: (text: string) => T, fallback: () => T): Promise<T> {
      let st
      try {
        st = await stat(path)
      } catch (error) {
        map.delete(path)
        if (options.strictErrors && errorCode(error) !== 'ENOENT') throw error
        return fallback()
      }
      const cached = map.get(path)
      if (cached && cached.mtimeMs === st.mtimeMs && cached.ctimeMs === st.ctimeMs && cached.size === st.size) {
        return cached.value
      }
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        map.delete(path)
        if (options.strictErrors && errorCode(error) !== 'ENOENT') throw error
        return fallback()
      }
      const value = parse(text)
      map.set(path, { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, value })
      return value
    },
  }
}
