#!/usr/bin/env node
/**
 * Refuse an install that resolves the external plugin against a mixed DSH
 * runtime.  The traversal follows only resolver-visible package links; it
 * deliberately does not inspect node_modules/.pnpm as a cache directory.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import semver from 'semver'

const root = process.cwd()
const target = '0.2.0-rc.2'
const expected = {
  '@deepseek-ai/dsh-llm': target,
  '@deepseek-ai/dsh-tools': target,
  '@deepseek-ai/cordis': '4.0.4',
  '@deepseek-ai/schemastery': '3.18.4',
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

/**
 * Peer ranges are checked by *coverage* rather than literal equality: a range
 * must accept the version this tree is built against, under the same
 * prerelease-inclusive semantics the DSH launcher itself uses
 * (`semver.satisfies(_, _, { includePrerelease })`).  devDependencies stay
 * exact — they are what this tree compiles against.
 *
 * The baseline differs per package: the DSH runtime packages move with the
 * harness release (`target`), while cordis/schemastery keep independent
 * version lines and are pinned to their own resolved versions.
 *
 * Unbounded ranges are refused so the plugin cannot silently claim future
 * runtimes it was never built against.
 */
function checkPeerRange(name, baseline, expectedRange) {
  const actual = packageJson.peerDependencies?.[name]
  if (typeof actual !== 'string' || actual.trim() === '') {
    fail(`package.json peerDependencies.${name} is ${String(actual)}, expected a range covering ${baseline}`)
    return
  }
  if (!semver.validRange(actual)) {
    fail(`package.json peerDependencies.${name} is not a valid semver range: ${actual}`)
    return
  }
  if (!semver.satisfies(baseline, actual, { includePrerelease: true })) {
    fail(`package.json peerDependencies.${name} is ${actual}, which does not cover ${baseline}`)
    return
  }
  if (semver.minVersion(actual) === null) {
    fail(`package.json peerDependencies.${name} is ${actual}, which has no lower bound`)
    return
  }
  // 有界性防呆：范围必须排掉下一个次版本，否则等于对未知未来放行。
  const next = semver.inc(baseline, 'minor', { includePrerelease: true })
  const probes = [next, semver.inc(baseline, 'major', { includePrerelease: true })].filter(Boolean)
  if (actual === '*' || (probes.length > 0 && probes.every((probe) => semver.satisfies(probe, actual, { includePrerelease: true })))) {
    fail(`package.json peerDependencies.${name} is ${actual}, which is unbounded past ${baseline}`)
    return
  }
  if (actual !== expectedRange) {
    // 不是错误：只提示与脚本记录的期望范围不同，便于人工复核。
    console.warn(`note: peerDependencies.${name} is ${actual} (script records ${expectedRange})`)
  }
}

for (const [name, version] of Object.entries(expected)) {
  const independent = name === '@deepseek-ai/cordis' || name === '@deepseek-ai/schemastery'
  checkPeerRange(name, version, independent ? `^${version}` : `>=${version} <0.3.0`)
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
