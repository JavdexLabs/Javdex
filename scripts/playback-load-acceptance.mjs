// Visible-window load sampling with a real source and isolated playback host.
// No per-frame tracing or readback during timing; this is not screen scanout proof.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createAcceptanceDirectory, seedAcceptanceCatalog, launchAcceptance, waitForState,
  waitForValue, closeAcceptance, output } from './playback-acceptance-support.mjs'
import { prepareNonRecordingPlayback } from './playback-acceptance-settings.mjs'
const [input, mode = 'gpu'] = process.argv.slice(2)
assert(input && ['gpu', 'cpu'].includes(mode), 'Usage: node scripts/playback-load-acceptance.mjs MEDIA gpu|cpu')
const file = path.resolve(input), directory = createAcceptanceDirectory('load-')
const [target] = seedAcceptanceCatalog(directory, [file])
const report = { passed: false, mode, platform: process.platform, file, stages: [],
  limits: ['One local device and short synthetic load; no physical display timing or power measurement',
    'CPU percentages and working-set memory are Electron app metrics, not whole-system utilization'] }
const save = () => fs.writeFileSync(path.join(output, `load-${mode}.json`), JSON.stringify(report, null, 2) + '\n')
let application
try {
  application = await launchAcceptance(directory, 'load-application.log', mode === 'cpu' ? ['--javdex-cpu'] : [])
  const page = await application.firstWindow()
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  await prepareNonRecordingPlayback(page)
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setContentSize(1920, 1200))
  assert.equal((await page.evaluate(t => window.api.player.openResource(t.libraryId,t.resourceId,t.videoId), target)).ok, true)
  const state = await waitForState(page, s => s?.phase === 'playing' && s.position > 1, 'load playback started')
  const control = value => page.evaluate(({id,value}) => window.api.playback.control(id,value), {id:state.sessionId,value})
  const inspect = () => application.evaluate(({app}) => {
    const hosts = {gpu:{alive:false,outstandingSurfaces:0},cpu:{alive:false,outstandingSurfaces:0}}
    process.getBuiltinModule('diagnostics_channel').channel('javdex.playback.host.statistics').publish(hosts)
    return {hosts,metrics:app.getAppMetrics().map(({pid,type,cpu,memory}) => ({pid,type,cpu,memory}))}
  })
  report.environment = await application.evaluate(async ({app,screen}) => ({versions:process.versions,gpu:await app.getGPUInfo('basic'),displays:screen.getAllDisplays()}))
  for (const [phase, seconds] of [['playing', 8], ['paused', 4]]) {
    if (phase === 'paused') { await control({kind:'pause',paused:true}); await waitForState(page,s=>s?.paused,'load paused') }
    const before = await page.evaluate(() => window.api.playback.snapshot()), start = performance.now(), stage = {phase,before,samples:[]}
    for (let second = 1; second <= seconds; second++) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0,start + second*1000-performance.now())))
      const snapshot = await page.evaluate(() => window.api.playback.snapshot()), sample = {elapsed:performance.now()-start,snapshot,...await inspect()}
      stage.samples.push(sample)
      assert.equal(snapshot.info.playbackMode,mode); assert.equal(snapshot.paused,phase==='paused'); assert.equal(snapshot.error,null)
      assert(sample.hosts[mode].alive)
      assert(sample.hosts.gpu.outstandingSurfaces<=3); assert((sample.hosts.cpu.queuedFrames??0)<=2)
      assert((sample.hosts.gpu.peakOutstandingSurfaces??0)<=3)
    }
    const after = stage.samples.at(-1).snapshot
    stage.positionAdvance = after.position-before.position
    if (phase==='playing') assert(stage.positionAdvance>seconds-1.5,'playback must keep real time')
    else assert(Math.abs(stage.positionAdvance)<.25,'pause must hold its position')
    stage.droppedFrames = after.info.droppedFrames-before.info.droppedFrames
    report.stages.push(stage); save()
  }
  report.canvas = await page.evaluate(() => {const c=document.querySelector('canvas[data-playback-surface]');return {width:c.width,height:c.height}})
  await control({kind:'stop'}); await waitForState(page,s=>s===null,'load stopped')
  report.stopped = await waitForValue(inspect,s=>!s.hosts.gpu.alive&&!s.hosts.cpu.alive&&s.hosts.gpu.outstandingSurfaces===0,'load resources released')
  report.passed = true
} catch(error) { report.error=error.stack;process.exitCode=1 }
finally { if(application)report.cleanup=await closeAcceptance(application);if(report.cleanup?.forced||report.cleanup?.code!==0){report.passed=false;process.exitCode=1}save() }
console.log(JSON.stringify({passed:report.passed,mode,stages:report.stages.map(({phase,positionAdvance,droppedFrames})=>({phase,positionAdvance,droppedFrames})),error:report.error}))
