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
 * - withPathLock：进程内 per-path 串行（codex SESSION_INDEX_LOCK 的进程内语义）
 * - appendLine：追加 + fsync
 * - atomicWriteText：tmp + fsync + rename（与 atomic-write.ts 同款强度）
 * - createFingerprintCache：mtime+size 指纹缓存（解析逻辑由调用方注入）
 * - isRecord/str/num：行级校验守卫
 *
 * 注意：合并后两个模块共享**同一个** pathLocks Map——互斥粒度是「同路径」，
 * 不同路径互不阻塞，书签与摘要缓存路径本就不同，行为不变。
 */
import { mkdir, open, readFile, stat, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'

/* ── 进程内 per-path 互斥 ─────────────────────────────────────────────────── */

const pathLocks = new Map<string, Promise<unknown>>()

/**
 * 同一路径上的操作串行执行（跨路径并行）。
 * 链上保留（即使本次失败也不阻塞后续）；调用方仍收到本次的 rejection。
 */
export function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = pathLocks.get(path) ?? Promise.resolve()
  const next = prev.then(fn)
  pathLocks.set(path, next.catch(() => undefined))
  return next
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
  size: number
}

export interface FingerprintCache<T> {
  /** 显式失效（写入后调用），防同 ms 同 size 撞车。 */
  invalidate(path: string): void
  /** 命中指纹直接返回缓存值；否则整读 → parse → 回填。文件缺失/读失败 → fallback。 */
  read(path: string, parse: (text: string) => T, fallback: () => T): Promise<T>
}

export function createFingerprintCache<T>(): FingerprintCache<T> {
  const map = new Map<string, Fingerprint & { value: T }>()
  return {
    invalidate(path: string): void {
      map.delete(path)
    },
    async read(path: string, parse: (text: string) => T, fallback: () => T): Promise<T> {
      let st
      try {
        st = await stat(path)
      } catch {
        map.delete(path)
        return fallback()
      }
      const cached = map.get(path)
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        return cached.value
      }
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch {
        map.delete(path)
        return fallback()
      }
      const value = parse(text)
      map.set(path, { mtimeMs: st.mtimeMs, size: st.size, value })
      return value
    },
  }
}
