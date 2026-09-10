#!/usr/bin/env node
/**
 * Refuse an install that resolves the external plugin against a mixed DSH
 * runtime.  The traversal follows only resolver-visible package links; it
 * deliberately does not inspect node_modules/.pnpm as a cache directory.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = process.cwd()
const target = '0.1.5-rc.1'
const expected = {
  '@deepseek-ai/dsh-llm': target,
  '@deepseek-ai/dsh-tools': target,
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/schemastery': '3.18.2',
}
const errors = []
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const lockText = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')

function fail(message) {
  errors.push(message)
}

function checkManifest(section, name, expectedValue) {
  const actual = packageJson[section]?.[name]
  if (actual !== expectedValue) fail(`package.json ${section}.${name} is ${String(actual)}, expected ${expectedValue}`)
}

for (const [name, version] of Object.entries(expected)) {
  if (name === '@deepseek-ai/cordis' || name === '@deepseek-ai/schemastery') {
    checkManifest('peerDependencies', name, `^${version}`)
  } else {
    checkManifest('peerDependencies', name, version)
  }
  checkManifest('devDependencies', name, version)
}

function lockImporter(name) {
  const quoted = `'${name}':`
  const lines = lockText.split(/\r?\n/)
  const start = lines.findIndex((line) => line === `      ${quoted}`)
  if (start < 0) return undefined
  const fields = {}
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.startsWith('        ')) break
    const match = /^        (specifier|version): (.+)$/.exec(line)
    if (match) fields[match[1]] = match[2]
  }
  return fields
}

for (const [name, version] of Object.entries(expected)) {
  const entry = lockImporter(name)
  if (!entry) {
    fail(`pnpm-lock.yaml importer is missing ${name}`)
    continue
  }
  const expectedSpecifier = (name === '@deepseek-ai/cordis' || name === '@deepseek-ai/schemastery')
    ? version
    : target
  if (entry.specifier !== expectedSpecifier) {
    fail(`pnpm-lock.yaml importer ${name} specifier is ${String(entry.specifier)}, expected ${expectedSpecifier}`)
  }
  if (!entry.version?.startsWith(version)) {
    fail(`pnpm-lock.yaml importer ${name} resolves ${String(entry.version)}, expected ${version}`)
  }
}

function packagePath(base, name) {
  return join(base, 'node_modules', ...name.split('/'), 'package.json')
}

const visited = new Set()
const versions = new Map()

function visit(name, base) {
  const candidate = packagePath(base, name)
  if (!existsSync(candidate)) return
  const jsonPath = realpathSync(candidate)
  if (visited.has(jsonPath)) return
  visited.add(jsonPath)
  const pkg = JSON.parse(readFileSync(jsonPath, 'utf8'))
  if (pkg.name.startsWith('@deepseek-ai/dsh-')) {
    const found = versions.get(pkg.name) ?? new Set()
    found.add(pkg.version)
    versions.set(pkg.name, found)
  }
  const dependencies = {
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  }
  const packageRoot = dirname(jsonPath)
  for (const dependency of Object.keys(dependencies)) {
    if (dependency.startsWith('@deepseek-ai/dsh-')) visit(dependency, packageRoot)
  }
}

for (const name of Object.keys(expected)) visit(name, root)
for (const [name, found] of versions) {
  if (found.size !== 1 || !found.has(target)) {
    fail(`resolver-visible ${name} versions are ${[...found].join(', ')}, expected only ${target}`)
  }
}
for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools']) {
  if (!versions.has(name)) fail(`resolver could not reach ${name}`)
}

if (errors.length > 0) {
  console.error('INCOMPATIBLE')
  for (const message of errors) console.error(`- ${message}`)
  process.exitCode = 1
} else {
  console.log(`COMPATIBLE: DSH ${target}; Cordis ${expected['@deepseek-ai/cordis']}; Schemastery ${expected['@deepseek-ai/schemastery']}`)
}
