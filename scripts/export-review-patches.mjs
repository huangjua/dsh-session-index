import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

function git(...args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout
}
const tracked = git('diff', '--name-only', '-z').split('\0').filter(Boolean)
const fresh = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)
const all = [...tracked, ...fresh].sort()
const shared = new Set(['src/fts.ts', 'src/index.ts', 'src/session-index-builder.ts',
  'test/fts.test.ts', 'test/index.test.ts', 'test/fts-recovery.test.ts',
  'test/index-fts-recovery.test.ts', 'test/builder-fts-sync.test.ts',
  'test/support/sqlite-lock-child.ts', 'test/reconcile-same-size.test.ts'])
function phase(file) {
  if (file === '.gitignore' || file === 'base-commit.txt' || file.endsWith('.txt') || file.startsWith('scripts/')) return 'S0-isolation-and-handoff'
  if (shared.has(file)) return 'S2-shared-integration'
  return 'S1-boundaries-and-bookmarks'
}
function patch(files) {
  const changed = files.filter(file => tracked.includes(file))
  let output = changed.length ? git('diff', '--binary', '--no-ext-diff', '--', ...changed) : ''
  for (const file of files.filter(file => fresh.includes(file))) {
    const content = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    const lines = content.split('\n')
    if (lines.at(-1) === '') lines.pop()
    output += `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n`
    output += lines.map(line => `+${line}\n`).join('')
    if (!content.endsWith('\n')) output += '\\ No newline at end of file\n'
  }
  return output
}
mkdirSync('PATCHES', { recursive: true })
const groups = [...new Set(all.map(phase))]
for (const group of groups) writeFileSync(`PATCHES/${group}.patch`, patch(all.filter(file => phase(file) === group)))
writeFileSync('PATCHES/FULL-S0-S2.patch', patch(all))
writeFileSync('PATCHES/manifest.json', JSON.stringify({ base: git('rev-parse', 'HEAD').trim(),
  note: 'File ownership groups for review. Apply all three patches; shared S1/S2 FTS/index/builder wiring is in S2.',
  files: all.map(file => ({ file, phase: phase(file) })) }, null, 2) + '\n')
console.log(JSON.stringify({ patches: groups, files: all.length }))
