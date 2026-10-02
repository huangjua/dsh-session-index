/** Deterministic filesystem faults in this worker only; no production fault switches. */
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'
const config=parentPort ? workerData : JSON.parse(process.argv[2])
const mode = String(config.dbPath)
const originalRm = fs.rm
const originalAppend = fs.appendFile
let failures = 0
fs.rm = async (path, options) => {
  if (String(path).endsWith('.jsonl') && (mode.includes('cleanup-always') || (mode.includes('cleanup-once') && failures++ === 0))) {
    throw Object.assign(new Error('injected staging unlink EACCES'), { code: 'EACCES' })
  }
  return originalRm(path, options)
}
fs.appendFile = async (path, data, options) => {
  await originalAppend(path, data, options)
  if (mode.includes('parent-crash') && String(path).endsWith('.jsonl') && data instanceof Uint8Array && data.byteLength) {
    await new Promise<void>(() => {})
  }
}
syncBuiltinESMExports()
await import('../src/fts-worker.js')
