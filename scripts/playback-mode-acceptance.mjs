// Real Windows/macOS mode choices, including a failed GPU initialization.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createAcceptanceDirectory,seedAcceptanceCatalog,launchAcceptance,waitForState,waitForValue,closeAcceptance,output} from './playback-acceptance-support.mjs'
import {prepareNonRecordingPlayback} from './playback-acceptance-settings.mjs'
assert(['win32','darwin'].includes(process.platform))
assert(process.argv[2],'Pass a synthetic video')
const directory=createAcceptanceDirectory('modes-'),[target]=seedAcceptanceCatalog(directory,[path.resolve(process.argv[2])])
const report={passed:false,checks:[]};let application
try {
 application=await launchAcceptance(directory,'modes-application.log')
 const page=await application.firstWindow();await page.waitForFunction(()=>window.api?.playback&&document.querySelector('nav'));await prepareNonRecordingPlayback(page)
 const setting=mode=>page.evaluate(mode=>window.api.thisComputer.update({playbackRenderMode:mode}),mode)
 const open=()=>page.evaluate(t=>window.api.player.openResource(t.libraryId,t.resourceId,t.videoId),target)
 const hosts=()=>application.evaluate(()=>{const value={cpu:{alive:false,outstandingSurfaces:0},gpu:{alive:false,outstandingSurfaces:0}};process.getBuiltinModule('diagnostics_channel').channel('javdex.playback.host.statistics').publish(value);return value})
 const stop=async()=>{const s=await page.evaluate(()=>window.api.playback.snapshot());if(s)await page.evaluate(id=>window.api.playback.control(id,{kind:'stop'}),s.sessionId);await waitForState(page,s=>s===null,'mode stop');await waitForValue(hosts,s=>!s.cpu.alive&&!s.gpu.alive&&s.gpu.outstandingSurfaces===0,'mode resources released')}
 await application.evaluate(({utilityProcess})=>{globalThis.originalPlaybackFork=utilityProcess.fork;utilityProcess.fork=(entry,args,options)=>{if(args[1]==='gpu')throw Error('GPU initialization acceptance failure');return globalThis.originalPlaybackFork.call(utilityProcess,entry,args,options)}})
 await setting('gpu');const rejected=await open();assert.equal(rejected.ok,false);assert.equal((await hosts()).cpu.alive,false)
 report.checks.push({choice:'gpu',initializationRejected:true,cpuStarted:false});await stop()
 for(const [choice,fallback] of [['auto',true],['cpu',false],['auto',true]]) {
  await setting(choice);assert.equal((await open()).ok,true)
  const state=await waitForState(page,s=>s?.phase==='playing'&&s.position>.5,'CPU mode started')
  assert.equal(state.info.playbackMode,'cpu');assert.equal(state.info.playbackFallback,fallback)
  assert.equal(state.info.playbackDiagnostics.fallbackReason!==null,fallback)
  report.checks.push({choice,state});await stop()
 }
 await application.evaluate(({utilityProcess})=>{utilityProcess.fork=globalThis.originalPlaybackFork})
 if (process.platform === 'win32') {
  // Real native identity rejection, not a mocked GPU/frame result. CPU still
  // decodes and draws normally and must never depend on this GPU snapshot.
  await application.evaluate(({app})=>{globalThis.originalPlaybackGpuInfo=app.getGPUInfo;app.getGPUInfo=async()=>({gpuDevice:[{active:true,vendorId:65535,deviceId:65534}]})})
  await setting('auto');assert.equal((await open()).ok,true)
  const recovered=await waitForState(page,s=>s?.phase==='playing'&&s.position>.5&&s.info.playbackMode==='cpu','adapter mismatch CPU recovery')
  assert.equal(recovered.info.playbackFallback,true);report.checks.push({choice:'auto',adapterMismatch:true,state:recovered});await stop()
  await setting('gpu');await open()
  const failed=await waitForState(page,s=>s?.phase==='error','explicit GPU adapter mismatch')
  assert.equal((await hosts()).cpu.alive,false);report.checks.push({choice:'gpu',adapterMismatch:true,state:failed});await stop()
  await application.evaluate(({app})=>{app.getGPUInfo=globalThis.originalPlaybackGpuInfo})
 }
 await setting('gpu');assert.equal((await open()).ok,true)
 const state=await waitForState(page,s=>s?.phase==='playing'&&s.position>.5&&s.info.playbackDiagnostics.displayProbe==='passed','explicit GPU retry')
 assert.equal(state.info.playbackMode,'gpu');assert.equal(state.info.playbackFallback,false);report.checks.push({choice:'gpu',state});await stop()
 report.passed=true
}catch(error){report.error=error.stack;process.exitCode=1}
finally{if(application)report.cleanup=await closeAcceptance(application);if(report.cleanup?.forced||report.cleanup?.code!==0){report.passed=false;process.exitCode=1}fs.writeFileSync(path.join(output,'modes.json'),JSON.stringify(report,null,2)+'\n')}
console.log(JSON.stringify({passed:report.passed,error:report.error}))
