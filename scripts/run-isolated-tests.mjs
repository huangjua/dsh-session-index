import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const [label, ...files] = process.argv.slice(2)
if (!label || !/^[a-zA-Z0-9_-]+$/.test(label) || files.length === 0) throw new Error('Provide a label and explicit affected test files')
for (const file of files) {
  if (!/^[a-zA-Z0-9_-]+$/.test(file) || !existsSync(`.test-build/test/${file}.test.js`)) throw new Error(`Missing compiled test: ${file}`)
}
const root = resolve('validation')
for (const dir of ['temp', 'dsh-home', 'data', 'sessions']) mkdirSync(join(root, dir), { recursive: true })
mkdirSync('TEST_RESULTS', { recursive: true })
const env = { ...process.env, DSH_HOME: join(root, 'dsh-home'), TEMP: join(root, 'temp'), TMP: join(root, 'temp'),
  DSH_SESSION_INDEX_DATA_DIR: join(root, 'data'), DSH_SESSION_INDEX_SESSIONS_ROOT: join(root, 'sessions') }
const args = ['--test', '--test-concurrency=1', ...files.map(file => `.test-build/test/${file}.test.js`)]
const outputPath=`TEST_RESULTS/${label}.txt`
writeFileSync(outputPath,'')
const child=spawn(process.execPath,args,{env,stdio:['ignore','pipe','pipe']})
let output='',spawnError=null
for(const stream of [child.stdout,child.stderr]) stream.on('data',chunk=>{
  const text=chunk.toString();appendFileSync(outputPath,text);output=(output+text).slice(-64000)
})
child.on('error',error=>{spawnError=error.message})
const status=await new Promise(resolve=>child.on('close',code=>resolve(code)))
writeFileSync(`TEST_RESULTS/${label}.json`,JSON.stringify({args,environment:{
  DSH_HOME:env.DSH_HOME,TEMP:env.TEMP,TMP:env.TMP,dataDir:env.DSH_SESSION_INDEX_DATA_DIR,
  sessionsRoot:env.DSH_SESSION_INDEX_SESSIONS_ROOT},exitCode:status,error:spawnError},null,2))
console.log(output.split(/\r?\n/).slice(-18).join('\n'))
process.exitCode=status ?? 1
