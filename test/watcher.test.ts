import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { FSWatcher } from 'node:fs'
import { createSessionWatcher } from '../src/watcher.js'

function fakeWatch() {
  const emitter = new EventEmitter()
  let listener: (() => void) | undefined
  let closed = 0
  const watch = (_root: string, onChange: () => void) => {
    listener = onChange
    return Object.assign(emitter, { close: () => { closed++ } }) as FSWatcher
  }
  return { emitter, watch, change: () => listener?.(), get closed() { return closed } }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('S1.4 watcher 有界 debounce 与资源生命周期', () => {
  it('持续事件在 maxWait 内刷新，尾沿继续收敛', async () => {
    const fake = fakeWatch()
    let changes = 0
    const watcher = createSessionWatcher('test-root', 40, () => { changes++ }, undefined, {
      watch: fake.watch, maxWaitMs: 70,
    })
    const events = setInterval(fake.change, 8)
    try {
      await delay(170)
      assert.ok(changes >= 1, '持续 change 不能一直推迟刷新')
      clearInterval(events)
      await delay(80)
      assert.ok(changes >= 2, '停止写入后应收敛最后一批事件')
    } finally {
      clearInterval(events)
      watcher.close()
    }
  })

  it('error 关闭失效 watcher 并取消 debounce，close 幂等且无迟到回调', async () => {
    const fake = fakeWatch()
    let changes = 0
    let errors = 0
    const watcher = createSessionWatcher('test-root', 20, () => { changes++ }, () => { errors++ }, {
      watch: fake.watch, maxWaitMs: 40,
    })
    fake.change()
    fake.emitter.emit('error', new Error('watch failed'))
    assert.equal(watcher.ok, false)
    assert.equal(errors, 1)
    watcher.close()
    fake.change()
    await delay(80)
    assert.equal(changes, 0)
    assert.equal(fake.closed, 1)
  })

  it('构造失败允许调用方回退；主动 close 取消两个计时器', async () => {
    const failed = createSessionWatcher('test-root', 10, () => {}, undefined, {
      watch: () => { throw new Error('watch unavailable') },
    })
    assert.equal(failed.ok, false)
    failed.close()
    const fake = fakeWatch()
    let changes = 0
    const watcher = createSessionWatcher('test-root', 20, () => { changes++ }, undefined, {
      watch: fake.watch, maxWaitMs: 40,
    })
    fake.change()
    watcher.close()
    await delay(70)
    assert.equal(changes, 0)
    assert.equal(fake.closed, 1)
  })
})
