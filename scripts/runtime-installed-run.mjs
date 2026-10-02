import {spawn} from 'node:child_process'
const [script,...args]=process.argv.slice(2)
const env={...process.env,ELECTRON_RUN_AS_NODE:'1'};delete env.NODE_OPTIONS
const child=spawn('E:/Program Files (x86)/DSH-D/DeepSeek Harness.exe',['--no-warnings',script,...args],{env,windowsHide:true,stdio:'inherit'})
child.on('error',error=>{console.error(error.code??'spawn-failed');process.exitCode=1})
const code=await new Promise(accept=>child.on('exit',accept));process.exitCode=code??1
