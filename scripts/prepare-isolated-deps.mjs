import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { createRequire } from 'node:module'

// Copy resolved packages as ordinary files; never reuse mutable runtime junctions.
const source = process.argv[2]
if (!source || resolve(source) === process.cwd()) throw new Error('Provide the runtime source repository')
const target = join(process.cwd(), 'node_modules')
mkdirSync(target, { recursive: true })
const copied = new Map()
function locate(name, base) {
  let current = base
  while (true) {
    const candidate = join(current, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) return dirname(realpathSync(candidate))
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}
function copy(name, base) {
  const from = locate(name, base)
  if (!from) return
  const pkg = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'))
  if (copied.has(name)) {
    if (copied.get(name) !== pkg.version) throw new Error(`Version conflict: ${name}`)
    return
  }
  copied.set(name, pkg.version)
  cpSync(from, join(target, name), { recursive: true, dereference: true,
    filter: (path) => path === from || !['node_modules', '.git'].includes(basename(path)) })
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) copy(dep, from)
}
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) copy(name, source)
console.log(JSON.stringify({ source, target, packages: Object.fromEntries(copied) }, null, 2))
