import { it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rename, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { addBookmark, readBookmarks, invalidateBookmarkCache } from '../src/bookmark.js'
import { canonicalFilePath, withFileLock } from '../src/sidecar.js'

interface Message { event: string; result?: any; code?: string; message?: string }
interface Peer { process: ChildProcess; event: (name: string) => Promise<Message>; start: (command: unknown) => void }
const dirs: string[] = []
const peers: ChildProcess[] = []
after(async () => {
  for (const child of peers) if (child.exitCode === null && child.signalCode === null) child.kill()
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})
const input = (sessionId: string, label = sessionId) => ({ sessionId, sessionFile: `/${sessionId}`, label, title: '', workspace: '' })
async function file(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bookmark-multiprocess-'))
  dirs.push(dir)
  return join(dir, 'bookmarks.jsonl')
}
async function peer(): Promise<Peer> {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/bookmark-process.js', import.meta.url))], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env },
  })
  peers.push(child)
  const messages: Message[] = []
  const waiters: Array<{ event: string; resolve: (value: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = []
  let stderr = ''
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  child.on('message', (value) => {
    const message = value as Message
    const index = waiters.findIndex((waiter) => waiter.event === message.event)
    if (index < 0) messages.push(message)
    else { const [waiter] = waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message) }
  })
  const result: Peer = {
    process: child,
    start(command) { child.send(command as any) },
    event(name) {
      const index = messages.findIndex((message) => message.event === name)
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Child event ${name} timed out: ${stderr}; ${JSON.stringify(messages)}`)), 10_000)
        waiters.push({ event: name, resolve, reject, timer })
      })
    },
  }
  await result.event('ready')
  return result
}

it('跨进程 remove 在 rename barrier 持锁时，成功 add 不会被旧快照覆盖', { timeout: 15_000 }, async () => {
  const path = await file()
  const old = await addBookmark(path, input('old'), 1)
  const remover = await peer()
  remover.start({ operation: 'remove', path, id: old.bookmark.id, pauseBeforeRename: true })
  await remover.event('paused')
  const adder = await peer()
  adder.start({ operation: 'add', path, input: input('new'), now: 2, observeLock: true })
  await adder.event('blocked')
  remover.process.send({ resume: true })
  assert.equal((await remover.event('done')).result, 1)
  assert.equal((await adder.event('done')).result.replaced, false)
  invalidateBookmarkCache(path)
  assert.deepEqual((await readBookmarks(path)).bookmarks.map((bookmark) => bookmark.sessionId), ['new'])
})

it('独立进程同锚点 add/update 串行，后写更新保留首写 createdAt', { timeout: 15_000 }, async () => {
  const path = await file()
  const first = await peer()
  first.start({ operation: 'add', path, input: input('same', 'first'), now: 100, pauseBeforeRename: true })
  await first.event('paused')
  const second = await peer()
  second.start({ operation: 'add', path, input: input('same', 'second'), now: 200, observeLock: true })
  await second.event('blocked')
  first.process.send({ resume: true })
  assert.equal((await first.event('done')).result.replaced, false)
  const update = (await second.event('done')).result
  assert.equal(update.replaced, true)
  assert.equal(update.bookmark.createdAt, 100)
  const rows = (await readBookmarks(path)).bookmarks
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, 'second')
  assert.equal(rows[0].updatedAt, 200)
})

it('崩溃持锁 PID 已死可恢复；活着的 owner 即使超时也不被抢占', { timeout: 15_000 }, async () => {
  const path = await file()
  const owner = await peer()
  owner.start({ operation: 'hold', path })
  await owner.event('held')
  const lock = `${await canonicalFilePath(path)}.lock`
  const before = await readdir(lock)
  await assert.rejects(withFileLock(path, async () => assert.fail('cannot enter live lock'), { timeoutMs: 80, retryMs: 10 }),
    (error: any) => error.code === 'ELOCKTIMEOUT')
  assert.deepEqual(await readdir(lock), before, '超时不能删除仍存活 owner')
  const exit = once(owner.process, 'exit')
  owner.process.kill('SIGKILL')
  await exit
  await addBookmark(path, input('after-crash'))
  assert.equal((await readBookmarks(path)).bookmarks[0].sessionId, 'after-crash')
  assert.ok(!(await readdir(dirname(path))).some((name) => name.includes('.lock')), '共享锁和候选目录均已释放')
})

it('旧 owner 释放时不能移除新 token 的锁', async () => {
  const path = await file()
  let moved = ''
  let nextOwnerFile = ''
  await withFileLock(path, async (actualPath) => {
    const lock = `${actualPath}.lock`
    moved = `${lock}.old-test-owner`
    await rename(lock, moved)
    await mkdir(lock)
    const token = randomUUID()
    nextOwnerFile = join(lock, `owner-${process.pid}-${token}.json`)
    await writeFile(nextOwnerFile, JSON.stringify({ v: 1, pid: process.pid, token }))
  })
  assert.ok(JSON.parse(await readFile(nextOwnerFile, 'utf8')).token)
  assert.equal((await readdir(moved)).length, 1, '旧 owner 文件也未误删新路径')
})

it('目录路径别名与 Windows 大小写定位同一锁资源', { timeout: 15_000 }, async () => {
  const path = await file()
  const dir = dirname(path)
  const aliasDir = `${dir}-alias`
  const { symlink } = await import('node:fs/promises')
  await symlink(dir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir')
  dirs.push(aliasDir)
  const alias = join(aliasDir, 'BOOKMARKS.jsonl')
  const aliasPath = process.platform === 'win32' ? alias : join(aliasDir, 'bookmarks.jsonl')
  assert.equal(await canonicalFilePath(path), await canonicalFilePath(aliasPath))
  const owner = await peer()
  owner.start({ operation: 'hold', path })
  await owner.event('held')
  await assert.rejects(withFileLock(aliasPath, async () => assert.fail('alias must wait'), { timeoutMs: 80 }),
    (error: any) => error.code === 'ELOCKTIMEOUT')
  owner.process.send({ resume: true })
  await owner.event('done')
  await addBookmark(aliasPath, input('through-alias'))
  assert.equal((await readBookmarks(path)).bookmarks[0].sessionId, 'through-alias')
})
