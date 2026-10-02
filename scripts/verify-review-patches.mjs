import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'

const directory = resolve('validation/patch-check')
if (existsSync(directory)) throw new Error('Patch verification checkout already exists; preserve it and choose a fresh directory')
const logs = []
function git(args, cwd = process.cwd()) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  logs.push({ args, cwd, exitCode: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` })
  writeFileSync('TEST_RESULTS/patch-verification.json', JSON.stringify(logs, null, 2) + '\n')
  if (result.status !== 0) throw new Error(logs.at(-1).output)
}
git(['clone', '--no-hardlinks', '--no-checkout', '.', directory])
const manifest = JSON.parse(readFileSync('PATCHES/manifest.json', 'utf8'))
git(['checkout', '--detach', manifest.base], directory)
git(['apply', '--check', resolve('PATCHES/FULL-S0-S2.patch')], directory)
for (const name of ['S0-isolation-and-handoff', 'S1-boundaries-and-bookmarks', 'S2-shared-integration']) {
  git(['apply', '--check', resolve(`PATCHES/${name}.patch`)], directory)
  git(['apply', resolve(`PATCHES/${name}.patch`)], directory)
}
for (const { file } of manifest.files) {
  const expected = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const actual = readFileSync(join(directory, file), 'utf8').replace(/\r\n/g, '\n')
  if (actual !== expected) throw new Error(`Patch replay differs: ${file}`)
}
console.log(`All patches replayed on ${manifest.base}; ${manifest.files.length} source files match.`)
