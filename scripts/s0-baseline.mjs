import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createSessionFts, SessionFts } from '../validation/s0-baseline/runtime/fts.js'
import { SessionIndexBuilder } from '../validation/s0-baseline/runtime/session-index-builder.js'
import { saveIndex, loadIndex } from '../validation/s0-baseline/runtime/core.js'

const root = await mkdtemp(join(tmpdir(), 's0-baseline-'))
const meta = { file: '/s', id: 's', workspace: '/outside', title: 'old', agentPreset: '', createdAt: 0,
  lastTime: 1, size: 1, mtimeMs: 1, ctimeMs: 1, firstUserText: '', lastAssistantText: '', counts: {}, toolNames: [], toolCallCounts: {} }
const row = text => ({ sessionFile: '/s', role: 'assistant', text, toolName: '' })
const result = { base: '70800ed7be77b31527a955ea2f6cc6a750dafef8', root, checks: [] }
const f = await createSessionFts(join(root, 'filter.db'))
f.upsertSession(meta)
f.syncMessages('/s', [row('认证说明')], false)
const hits = await f.search('认证 不存在', '/allowed', 10, { role: 'user', sinceMs: 500 })
result.checks.push({ issue: '#01', correctBehavior: hits.length === 0, actualHits: hits.length })
await f.flush(); await f.close()
let fail = false
class FaultDb extends DatabaseSync {
  prepare(sql) {
    const stmt = super.prepare(sql)
    if (!sql.startsWith('INSERT INTO messages(')) return stmt
    return { run(...args) { if (fail) { fail = false; throw new Error('injected INSERT fault') } return stmt.run(...args) } }
  }
}
const faulty = new SessionFts(join(root, 'fault.db'), FaultDb)
faulty.upsertSession(meta); faulty.syncMessages('/s', [row('oldneedle')], false); await faulty.flush()
fail = true
faulty.syncMessages('/s', [row('newneedle')], false)
let rejected = false
try { await faulty.flush() } catch { rejected = true }
const oldHits = await faulty.search('oldneedle', '', 10)
result.checks.push({ issue: '#02', correctBehavior: rejected && oldHits.length === 1, flushRejected: rejected, oldHits: oldHits.length })
await faulty.close()
const indexFile = join(root, 'index.json')
const missingRoot = join(root, 'absent')
saveIndex(indexFile, { version: 1, root: missingRoot, updatedAt: 0, sessions: [meta] })
const builder = new SessionIndexBuilder({ root: missingRoot, indexFile, poolSize: 1 })
const report = await builder.build()
result.checks.push({ issue: '#07', correctBehavior: loadIndex(indexFile).sessions.length === 1 && report.status !== 'completed', report, remaining: loadIndex(indexFile).sessions.length })
builder.dispose()
assert.ok(result.checks.every(c => !c.correctBehavior), 'baseline must fail the correct-behavior assertions')
await writeFile('TEST_RESULTS/S0-baseline.json', JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
