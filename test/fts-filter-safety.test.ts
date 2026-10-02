import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionFts } from '../src/fts.js'
import type { SearchFilter } from '../src/fts.js'

it('S1 #01: LIKE two/three term OR respects each filter and combinations with literal wildcard characters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fts-filter-'))
  const fts = await createSessionFts(join(root, 'fts.db'))
  assert.ok(fts)
  try {
    const sessions = [
      { file: '/allowed', workspace: '/allowed%_\\', role: 'user' as const, lastTime: 1000 },
      { file: '/outside', workspace: '/outside', role: 'assistant' as const, lastTime: 1 },
      { file: '/wrongrole', workspace: '/allowed%_\\', role: 'assistant' as const, lastTime: 1000 },
      { file: '/early', workspace: '/allowed%_\\', role: 'user' as const, lastTime: 1 },
      { file: '/late', workspace: '/allowed%_\\', role: 'user' as const, lastTime: 9000 },
    ]
    for (const s of sessions) {
      await fts.upsertSession({ ...s, id: s.file, title: '', createdAt: 0, agentPreset: '' })
      await fts.syncMessages(s.file, [{ sessionFile: s.file, role: s.role, text: '认证 %_\\ 内容', toolName: '' }], false)
    }
    const checks: { workspace: string; filter: SearchFilter; expected: string[] }[] = [
      { workspace: '/allowed%_\\', filter: {}, expected: ['/allowed', '/wrongrole', '/early', '/late'] },
      { workspace: '', filter: { role: 'user' }, expected: ['/allowed', '/early', '/late'] },
      { workspace: '', filter: { sinceMs: 500 }, expected: ['/allowed', '/wrongrole', '/late'] },
      { workspace: '', filter: { untilMs: 2000 }, expected: ['/allowed', '/wrongrole', '/early', '/outside'] },
      { workspace: '/allowed%_\\', filter: { role: 'user', sinceMs: 500, untilMs: 2000 }, expected: ['/allowed'] },
    ]
    for (const query of ['认证 不存在', '认证 不存在 也不存在', '"认证" 不存在', '%_\\ 不存在']) {
      for (const check of checks) {
        const hits = await fts.search(query, check.workspace, 30, check.filter)
        assert.deepEqual(hits.map(hit => hit.sessionFile).sort(), [...check.expected].sort(), `${query}: ${JSON.stringify(check)}`)
      }
    }
    assert.deepEqual(await fts.search('%% 不存在', '', 30), [])
    assert.deepEqual(await fts.search('__ 不存在', '', 30), [])
  } finally { await fts.close(); await rm(root, { recursive: true, force: true }) }
})
