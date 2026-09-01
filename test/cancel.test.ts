/**
 * cancel.test.ts — orCancel 移植测试
 * 翻译自 codex async-utils/src/lib.rs tests（tokio select! → AbortSignal）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { orCancel, CancelError, isCancelError, throwIfAborted } from '../src/cancel.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('orCancel', () => {
  it('promise 先完成 → 正常返回（returns_ok_when_future_completes_first）', async () => {
    const ac = new AbortController()
    const value = await orCancel(Promise.resolve(42), ac.signal)
    assert.equal(value, 42)
  })

  it('signal 先触发 → CancelError（returns_err_when_token_cancelled_first）', async () => {
    const ac = new AbortController()
    const result = orCancel(sleep(100).then(() => 7), ac.signal)
    setTimeout(() => ac.abort(), 10)
    await assert.rejects(result, (e) => isCancelError(e))
  })

  it('signal 已中止 → 立即拒绝（returns_err_when_token_already_cancelled）', async () => {
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(
      orCancel(sleep(50).then(() => 5), ac.signal),
      (e) => isCancelError(e),
    )
  })

  it('无 signal → 原样返回', async () => {
    assert.equal(await orCancel(Promise.resolve('x')), 'x')
  })

  it('promise 拒绝原样传播', async () => {
    await assert.rejects(
      orCancel(Promise.reject(new Error('boom')), undefined),
      /boom/,
    )
  })
})

describe('throwIfAborted / CancelError', () => {
  it('未中止不抛', () => {
    throwIfAborted(undefined)
    throwIfAborted(new AbortController().signal)
  })

  it('已中止抛 CancelError', () => {
    const ac = new AbortController()
    ac.abort()
    assert.throws(() => throwIfAborted(ac.signal), CancelError)
  })

  it('isCancelError 识别 DOMException AbortError', () => {
    assert.equal(isCancelError(new DOMException('x', 'AbortError')), true)
    assert.equal(isCancelError(new CancelError()), true)
    assert.equal(isCancelError(new Error('other')), false)
  })
})
