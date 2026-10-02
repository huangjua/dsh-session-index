import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { addBookmark, removeBookmarks } from '../../src/bookmark.js'
import type { BookmarkInput } from '../../src/bookmark.js'
import { withFileLock } from '../../src/sidecar.js'

interface Command {
  operation: 'add' | 'remove' | 'hold'
  path: string
  input?: BookmarkInput
  id?: string
  now?: number
  pauseBeforeRename?: boolean
  observeLock?: boolean
  timeoutMs?: number
}

const send = (value: unknown): void => { process.send?.(value) }
const nextMessage = (): Promise<any> => new Promise((done) => process.once('message', done))
send({ event: 'ready' })
const command = await nextMessage() as Command
const originalRename = fsPromises.rename
let paused = false
let observed = false
fsPromises.rename = async (from, to) => {
  const target = String(to)
  const sameFile = process.platform === 'win32'
    ? target.toLowerCase() === command.path.toLowerCase() : target === command.path
  if (command.pauseBeforeRename && !paused && sameFile) {
    paused = true
    send({ event: 'paused' })
    await nextMessage()
  }
  try { return await originalRename(from, to) }
  catch (error) {
    if (command.observeLock && !observed && target.endsWith('.lock')) {
      observed = true
      send({ event: 'blocked' })
    }
    throw error
  }
}
syncBuiltinESMExports()
try {
  let result: unknown
  if (command.operation === 'hold') {
    result = await withFileLock(command.path, async () => {
      send({ event: 'held' })
      await nextMessage()
      return 'released'
    }, { timeoutMs: command.timeoutMs })
  } else if (command.operation === 'add') {
    result = await addBookmark(command.path, command.input!, command.now)
  } else {
    result = await removeBookmarks(command.path, { id: command.id })
  }
  send({ event: 'done', result })
} catch (error) {
  send({ event: 'failed', message: (error as Error).message, code: (error as NodeJS.ErrnoException).code })
} finally {
  fsPromises.rename = originalRename
  syncBuiltinESMExports()
  process.disconnect()
}
