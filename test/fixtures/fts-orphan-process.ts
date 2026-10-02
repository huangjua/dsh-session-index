/** Leave one acknowledged-on-disk batch behind by killing the owning process. */
import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createFtsClient } from '../../src/fts-client.js'
import { FTS_PARSER_VERSION } from '../../src/fts.js'
const dbPath = process.argv[2]!
const client = await createFtsClient(dbPath, { workerUrl: new URL('../spool-cleanup-worker.js', import.meta.url) })
if (!client) throw new Error('Crash fixture could not start SQLite workers')
const file = '/synthetic/parent-crash'
void client.syncSession({ meta: { file, id: 'crash', workspace: '', title: '', agentPreset: '', createdAt: 1, lastTime: 2 },
  sourceFingerprint: { file, sessionId: 'crash', size: 1000, mtimeMs: 1, ctimeMs: 1, indexedBytes: 1000, complete: true },
  parserVersion: FTS_PARSER_VERSION, mode: 'replace', messages: [{ sessionFile: file, role: 'user', text: 'crash-batch', toolName: '' }] }).catch(() => {})
const deadline = Date.now() + 10000
while (Date.now() < deadline) {
  for (const directory of await readdir(dirname(dbPath))) {
    if (!directory.startsWith(`.fts-staging-${process.pid}-`)) continue
    const path = join(dirname(dbPath), directory)
    for (const name of await readdir(path)) {
      if (!name.endsWith('.jsonl')) continue
      if ((await stat(join(path, name))).size > 0) {
        process.stdout.write(JSON.stringify({ pid: process.pid, path, batch: join(path, name) }) + '\n', () => process.kill(process.pid, 'SIGKILL'))
        await new Promise<void>(() => {})
      }
    }
  }
  await new Promise<void>(accept => setTimeout(accept, 5))
}
throw new Error('Crash fixture did not observe a staged batch')
