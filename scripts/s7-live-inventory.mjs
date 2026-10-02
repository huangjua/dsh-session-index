// Inspect only the real Desktop renderer's API inventory via its parent debugger.
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const entries = await (await fetch('http://127.0.0.1:9229/json/list')).json()
const target = entries.find(entry => entry.type === 'node')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let id = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  if (message.id && pending.has(message.id)) { const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error('CDP error')) : item.resolve(message.result) }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const requestId = ++id
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('CDP timeout')) }, 20_000)
  pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params }))
})
const renderer = `(async () => {
  const response = await fetch('/api/pluginInventory/list', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 's7-live-inventory', method: 'pluginInventory/list', payload: { args: {} } }) });
  const envelope = await response.json();
  const inventory = envelope.result?.value;
  const rows = Array.isArray(inventory?.entries) ? inventory.entries : [];
  return { httpStatus: response.status, envelopeType: envelope.type, hasValue: Boolean(inventory),
    selected: rows.filter(row => row.moduleName === '@dsh-external/dsh-session-index').map(row => ({
      moduleName: row.moduleName, enabled: row.enabled === true,
      fiberPhase: ['failed','pending','active','loading','unloading'].includes(row.fiberPhase) ? row.fiberPhase : null,
      fieldNames: Object.keys(row).filter(key => /^[A-Za-z][A-Za-z0-9_]{0,50}$/.test(key)).sort(),
      errorPresent: Boolean(row.error) })) };
})()`
const expression = process.argv.includes('--quit') ? `(() => {
  const electron = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron');
  setTimeout(() => electron.app.quit(), 100);
  return { status: 'desktop-quit-requested', mainPid: process.pid };
})()` : `(async () => {
  const electron = process.getBuiltinModule('node:module').createRequire(process.execPath)('electron');
  const windows = electron.BrowserWindow.getAllWindows();
  const app = windows.find(window => window.webContents.getURL().startsWith('dsh-app://app/'));
  if (!app) return { status: 'no-app-window', windowCount: windows.length };
  return await app.webContents.executeJavaScript(${JSON.stringify(renderer)});
})()`
try {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  const record = { time: new Date().toISOString(), result: result.exceptionDetails ? { status: 'evaluate-error', exceptionClass: result.exceptionDetails.exception?.className } : result.result?.value }
  const filename = process.argv.includes('--quit') ? `LIVE_TEST_QUIT_${Date.now()}.json` : `LIVE_TEST_INVENTORY_${Date.now()}.json`
  await writeFile(fileURLToPath(new URL('../DEPLOYMENT_RESULTS/' + filename, import.meta.url)), JSON.stringify(record, null, 2) + '\n')
  console.log(JSON.stringify(record))
} finally { socket.close() }
