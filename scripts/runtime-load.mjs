import {spawn} from 'node:child_process'
import {resolve,join} from 'node:path'
import {writeFileSync,readFileSync} from 'node:fs'
export function recordLoad(directory) {
  const stop=join(directory,'WINDOWS_LOAD.stop'),file=join(directory,'WINDOWS_LOAD.jsonl')
  const quote=value=>"'"+value.replaceAll("'","''")+"'"
  const command='& {\n'+readFileSync(resolve('scripts/runtime-load.ps1'),'utf8')+'\n} -Output '+quote(file)+' -StopFile '+quote(stop)
  const child=spawn('powershell.exe',['-NoProfile','-Command',command],{windowsHide:true,stdio:['ignore','ignore','pipe']})
  let stderr='';child.stderr.on('data',bytes=>{stderr+=bytes})
  const exited=new Promise(accept=>{child.once('exit',accept);child.once('error',()=>accept(-1))})
  return async()=>{
    writeFileSync(stop,'done\n')
    const completed=await Promise.race([exited,new Promise(accept=>setTimeout(()=>accept('timeout'),5000))])
    if(completed==='timeout')child.kill()
    writeFileSync(join(directory,'WINDOWS_LOAD_SAMPLER.json'),JSON.stringify({exit:completed,samplesAvailable:completed===0,stderr,intervalMs:3000,counters:'Win32_PerfFormattedData CPU/physical disks; global system load; OS cache uncontrolled'},null,2)+'\n')
  }
}
