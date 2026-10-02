/** Runs the actual engine with SQLite explicitly disabled in its Node runtime. */
import { fork, type ForkOptions } from 'node:child_process'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const config = JSON.parse(process.argv[2] ?? '{}')
config.spoolDirectory = join(dirname(config.dbPath), `.fts-staging-${process.pid}-${randomUUID()}`)
const options: ForkOptions & { windowsHide: boolean } = { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  execArgv: ['--no-experimental-sqlite'], windowsHide: true,
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' }
const child = fork(fileURLToPath(new URL('../src/fts-worker.js', import.meta.url)), [JSON.stringify(config)], options)
child.on('message', message => process.send?.(message as Parameters<NonNullable<typeof process.send>>[0]))
child.on('error', () => process.send?.({ ready: true, available: false,
  error: { name: 'Error', code: 'EFTSFIXTURESPAWN', message: 'Isolated unsupported SQLite fixture could not start' } }))
process.on('message', message => { if (child.connected) child.send(message as Parameters<typeof child.send>[0]) })
process.once('disconnect', () => { child.kill('SIGKILL') })
