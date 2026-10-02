// Synthetic-only S5.1 benchmark. Run after tsc -p tsconfig.test.json.
// DSH_HOME, TEMP and TMP must all point inside this checkout's validation directory.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'

const checkout = fileURLToPath(new URL('../', import.meta.url))
const validation = resolve(checkout, 'validation')
function isolated(path) {
  const part = relative(validation, resolve(path))
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part))
}
for (const variable of ['DSH_HOME', 'TEMP', 'TMP']) {
  assert.ok(process.env[variable] && isolated(process.env[variable]), `${variable} must be inside ${validation}`)
}
const modulePath = resolve(checkout, process.argv[2] ?? '.test-build/src/native-zstd.js')
const output = resolve(checkout, process.argv[3] ?? 'validation/BENCHMARK_RESULTS/delta-io.json')
assert.ok(isolated(output), 'benchmark output must be inside this checkout validation directory')
const { nativeDecodeZstd } = await import(pathToFileURL(modulePath).href)
await mkdir(dirname(output), { recursive: true })
const dataRoot = await mkdtemp(join(tmpdir(), 'delta-io-benchmark-'))

// Find a stable 32-byte complete tail frame while retaining the JSONL newline invariant.
let tailText
let tail
for (let i = 0; i < 500; i++) {
  const candidate = `{"tail":"${i.toString(36)}${'x'.repeat(i % 40)}"}\n`
  const compressed = zstdCompressSync(Buffer.from(candidate))
  if (compressed.length === 32) { tailText = candidate; tail = compressed; break }
}
assert.ok(tail, 'could not construct a 32-byte zstd tail frame')
const first = zstdCompressSync(Buffer.from('{}\n'))
const block = Buffer.alloc(512 * 1024)
const results = []
for (const prefixMiB of [1, 16, 64]) {
  const prefixBytes = prefixMiB * 1024 * 1024
  const file = join(dataRoot, `history-${prefixMiB}MiB.zstd`)
  const handle = await open(file, 'wx')
  try {
    await handle.write(first)
    const skip = Buffer.alloc(8)
    skip.writeUInt32LE(0x184d2a50, 0)
    skip.writeUInt32LE(prefixBytes - first.length - skip.length, 4)
    await handle.write(skip)
    let remaining = prefixBytes - first.length - skip.length
    while (remaining > 0) {
      const length = Math.min(block.length, remaining)
      const { bytesWritten } = await handle.write(block, 0, length)
      assert.equal(bytesWritten, length)
      remaining -= bytesWritten
    }
    await handle.write(tail)
  } finally { await handle.close() }

  const rounds = []
  for (let round = 0; round < 5; round++) {
    const baselineStart = performance.now()
    // The audited implementation readFile(file) before taking its tail subarray.
    const whole = await readFile(file)
    assert.equal(zstdDecompressSync(whole.subarray(prefixBytes)).toString(), tailText)
    const baseline = {
      elapsedMs: performance.now() - baselineStart,
      readBytes: whole.length, allocatedBytes: whole.length,
    }
    const candidateStart = performance.now()
    const chunks = []
    const stats = await nativeDecodeZstd(file, (chunk) => { chunks.push(chunk) }, {
      startOffset: prefixBytes, maxCompressedBytes: tail.length,
    })
    assert.equal(Buffer.concat(chunks).toString(), tailText)
    assert.equal(stats.readBytes, tail.length)
    assert.equal(stats.allocatedBytes, tail.length)
    assert.equal(stats.discoveredBytes, prefixBytes + tail.length)
    rounds.push({ round: round + 1, baseline, candidate: { elapsedMs: performance.now() - candidateStart, ...stats } })
  }
  results.push({ prefixMiB, prefixBytes, tailBytes: tail.length, rounds })
}
const report = {
  version: 1, generatedAt: new Date().toISOString(), node: process.version,
  syntheticDataRoot: dataRoot, comparison: 'audited readFile+subarray versus bounded FileHandle.read tail',
  baselineReadBytesNote: 'readFile returns the full file; reported input allocation excludes internal fs buffers',
  roundsPerPrefix: 5, results,
}
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ output, node: process.version, results: results.map((item) => ({
  prefixMiB: item.prefixMiB, baselineReadBytes: item.rounds[0].baseline.readBytes,
  candidateReadBytes: item.rounds[0].candidate.readBytes,
  candidateAllocatedBytes: item.rounds[0].candidate.allocatedBytes,
})) }, null, 2)}\n`)
