// One-shot, loopback-only debugger controller for the real installed Desktop.
// The installed files and environment are unchanged. Only its next actual host
// spawn receives the guarded E-only preload; original IPC/options are preserved.
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const started = Date.now()
const record = { startedAt: new Date().toISOString(), port: 9229, status: 'pending' }
let socket
try {
  let target
  while (Date.now() - started < 30_000) {
    try {
      const response = await fetch('http://127.0.0.1:9229/json/list')
      const entries = await response.json()
      target = entries.find(entry => entry.type === 'node' && typeof entry.webSocketDebuggerUrl === 'string')
      if (target) break
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  if (!target) throw Object.assign(new Error(), { code: 'NO_MAIN_INSPECTOR' })
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id && pending.has(message.id)) { const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Object.assign(new Error(), { code: 'CDP_ERROR' })) : item.resolve(message.result) }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(), { code: 'CDP_TIMEOUT' })) }, 10_000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  await send('Debugger.enable')
  await send('Runtime.enable')
  const diagUrl = new URL('./s7-host-diagnostics.mjs', import.meta.url).href
  const expression = `(() => {
    const cp = process.getBuiltinModule('node:child_process');
    const mod = process.getBuiltinModule('node:module');
    const original = cp.spawn;
    const target = 'E:/Program Files (x86)/DSH-D/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'.toLowerCase();
    cp.spawn = function(executable, args, options) {
      const index = Array.isArray(args) ? args.findIndex(arg => typeof arg === 'string' && arg.replaceAll('\\\\', '/').toLowerCase() === target) : -1;
      if (index < 0) return Reflect.apply(original, this, arguments);
      const nextArgs = args.slice(); nextArgs.splice(index, 0, '--import', ${JSON.stringify(diagUrl)});
      cp.spawn = original; mod.syncBuiltinESMExports();
      return Reflect.apply(original, this, [executable, nextArgs, options]);
    };
    mod.syncBuiltinESMExports(); return 'one-host-preload-armed';
  })()`
  const evaluated = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (evaluated.exceptionDetails || evaluated.result?.value !== 'one-host-preload-armed') throw Object.assign(new Error(), { code: 'ARM_NOT_CONFIRMED' })
  record.status = 'armed'
  await send('Runtime.runIfWaitingForDebugger')
  try { await send('Debugger.resume') } catch {}
  await send('Debugger.disable')
  record.status = 'armed-and-resumed'
} catch (error) {
  record.status = 'failed'; record.errorCode = /^[A-Z_]{1,60}$/.test(error?.code) ? error.code : 'UNSPECIFIED'
  process.exitCode = 1
} finally {
  socket?.close()
  record.finishedAt = new Date().toISOString()
  await writeFile(fileURLToPath(new URL('../DEPLOYMENT_RESULTS/LIVE_TEST_DIAGNOSTICS_ARM.json', import.meta.url)), JSON.stringify(record, null, 2) + '\n')
  console.log(JSON.stringify(record))
}
