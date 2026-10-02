import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createFtsClient, FtsClient, FtsRpcError } from '../src/fts-client.js'
import type { FtsStartupDiagnostic } from '../src/fts-client.js'

async function scratch(work: (directory: string) => Promise<void>): Promise<void> {
  const parent = resolve(tmpdir())
  const directory = await mkdtemp(join(parent, 'dsh-runtime-error-'))
  try { await work(directory) }
  finally {
    assert.equal(dirname(resolve(directory)), parent)
    assert.ok(basename(directory).startsWith('dsh-runtime-error-'))
    await rm(directory, { recursive: true, force: true })
  }
}
async function failedFactory(dbPath: string): Promise<FtsStartupDiagnostic> {
  const failures: FtsStartupDiagnostic[] = []
  const client = await createFtsClient(dbPath, { onStartupFailure: failure => failures.push(failure) })
  assert.equal(client, null)
  assert.equal(failures.length, 1)
  assert.equal(failures[0].state, 'failed')
  assert.equal(failures[0].error?.code, 'ERR_SQLITE_ERROR')
  assert.ok(Number.isSafeInteger(failures[0].error?.sqliteErrorCode))
  assert.equal(failures[0].error?.message, 'FTS writer startup failed (ERR_SQLITE_ERROR)')
  assert.equal(failures[0].error?.stack, undefined)
  return failures[0]
}

describe('public startup errors retain actual SQLite numeric codes', () => {
  it('a non-SQLite file fails publicly with the actual SQLITE_NOTADB code', async () => scratch(async directory => {
    const dbPath = join(directory, 'not-sqlite.db')
    await writeFile(dbPath, 'isolated file which is not a SQLite database\n')
    const failure = await failedFactory(dbPath)
    assert.equal(failure.error!.sqliteErrorCode! & 255, 26)
  }))

  it('an actual SQLite schema btree fault fails publicly with SQLITE_CORRUPT', async () => scratch(async directory => {
    const dbPath = join(directory, 'corrupt-schema.db')
    const initialized = await createFtsClient(dbPath)
    assert.ok(initialized)
    await initialized.close()
    const file = await open(dbPath, 'r+')
    try {
      const signature = Buffer.alloc(16)
      await file.read(signature, 0, 16, 0)
      assert.equal(signature.toString('binary'), 'SQLite format 3\0')
      // Keep the SQLite header; invalidate page 1's schema btree page type.
      await file.write(Buffer.from([0]), 0, 1, 100)
    } finally { await file.close() }
    const failure = await failedFactory(dbPath)
    assert.equal(failure.error!.sqliteErrorCode! & 255, 11)
  }))

  it('unsupported SQLite is an actual disabled-runtime module failure, without a fabricated SQLite code', async () => scratch(async directory => {
    assert.ok(process.allowedNodeEnvironmentFlags.has('--no-experimental-sqlite'), 'installed runtime supports disabling SQLite for this isolated fault')
    const failures: FtsStartupDiagnostic[] = []
    const client = await createFtsClient(join(directory, 'unsupported.db'), {
      workerUrl: new URL('./runtime-transport-unsupported-fixture.js', import.meta.url), onStartupFailure: failure => failures.push(failure),
    })
    assert.equal(client, null)
    assert.equal(failures[0]?.state, 'failed')
    assert.equal(failures[0]?.error?.code, 'ERR_UNKNOWN_BUILTIN_MODULE')
    assert.equal(failures[0]?.error?.sqliteErrorCode, undefined)
  }))

  it('progressing migration remains migrating, separate from failed/corrupt/unsupported states', async () => scratch(async directory => {
    const failures: FtsStartupDiagnostic[] = []
    const client = new FtsClient(join(directory, 'migration-progress.db'), {
      workerUrl: new URL('./runtime-transport-fixture.js', import.meta.url), onStartupFailure: failure => failures.push(failure),
    })
    try {
      const deadline = Date.now() + 3000
      while (client.diagnostics().startup.writer?.state !== 'migrating') {
        assert.ok(Date.now() < deadline)
        await new Promise<void>(accept => setTimeout(accept, 10))
      }
      const status = await client.health()
      assert.equal(status.healthSnapshot, true)
      assert.equal(status.startup.writer?.state, 'migrating')
      assert.equal(status.startup.writer?.error, undefined)
      assert.equal(failures.length, 0)
      assert.equal(await client.ready(), true)
    } finally { await client.close() }
  }))

  it('FtsRpcError preserves the transferred numeric metadata without interpreting message text', () => {
    const error = new FtsRpcError({ name: 'Error', code: 'ERR_SQLITE_ERROR', message: 'private internal message', sqliteErrorCode: 267 })
    assert.equal(error.sqliteErrorCode, 267)
    assert.equal(error.code, 'ERR_SQLITE_ERROR')
  })
})
