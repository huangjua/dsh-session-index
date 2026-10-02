import { parentPort, workerData } from 'node:worker_threads'
const config = parentPort ? workerData : JSON.parse(process.argv[2])
const port = parentPort ?? {postMessage:(value:unknown)=>process.send?.(value as any),on:(_event:string,listener:(value:any)=>void)=>process.on('message',listener)}
port.postMessage({ ready: true, available: !String(config.dbPath).includes('unavailable') })
port.on('message', (message: { id?: number; op?: string; args?: unknown[]; cancel?: number }) => {
  if (message.cancel !== undefined) return
  const query = String(message.args?.[0] ?? '')
  if (query === '__exit') process.exit(42)
  if (query === '__hang') { while (true) { /* deterministic unresponsive transport */ } }
  if (message.op === 'vacuum' && String(config.dbPath).includes('hang-writer')) { while (true) { /* deterministic unresponsive writer */ } }
  const reply = () => port.postMessage({ id: message.id,
    result: message.op === 'sessionCount' ? 7 : message.op === 'health' ? { messages: 0 } : message.op === 'search' ? [] : undefined })
  if (query === '__slow') setTimeout(reply, 300)
  else reply()
})
