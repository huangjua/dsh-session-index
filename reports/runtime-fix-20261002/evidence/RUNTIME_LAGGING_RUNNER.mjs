import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import ts from '../work/node_modules/typescript/lib/typescript.js'
const work = fileURLToPath(new URL('../work/', import.meta.url))
const mode = process.argv[2]
if (!['red', 'final'].includes(mode)) throw new Error('Explicit red or final mode required')
if (mode === 'red') {
  const source = readFileSync(new URL('../work/test/runtime-lagging-retry.test.ts', import.meta.url), 'utf8')
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.ES2022, sourceMap: false }, fileName: 'runtime-lagging-retry.test.ts' })
  writeFileSync(new URL('../work/.test-build/test/runtime-lagging-retry.test.js', import.meta.url), result.outputText)
}
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_OPTIONS
const args = ['--no-warnings', '--test', '--test-concurrency=1']
if (mode === 'red') args.push('--test-name-pattern=public apply retries')
args.push('.test-build/test/runtime-lagging-retry.test.js')
const child = spawn('E:/Program Files (x86)/DSH-D/DeepSeek Harness.exe', args,
  { cwd: work, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  output += chunk.toString(); process.stdout.write(chunk)
})
const result = await new Promise(resolve => {
  child.once('error', error => resolve({ error: error.code }))
  child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }))
})
writeFileSync(new URL(`RUNTIME_LAGGING_RETRY_${mode.toUpperCase()}.txt`, import.meta.url), output + JSON.stringify(result) + '\n')
console.log(JSON.stringify(result))
process.exitCode = result.exitCode ?? 1
