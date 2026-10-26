// Disposable synthetic media only. Faults are injected through main-process
// diagnostics; no product command API or user profile is changed.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createAcceptanceDirectory, seedAcceptanceCatalog, launchAcceptance, closeAcceptance,
  captureAcceptanceFrame, waitForValue, waitForState } from './playback-acceptance-support.mjs'
import { waitForNativeFrame } from './playback-acceptance-support.mjs'

const [media, destination, display, mode = 'gpu', consumer = 'video'] = process.argv.slice(2)
assert(media && destination && ['x11', 'wayland'].includes(display)
  && ['gpu', 'cpu', 'auto'].includes(mode) && consumer === 'video')
const output = path.resolve(destination); fs.mkdirSync(output)
const directory = createAcceptanceDirectory('texture-lifecycle-')
const [target] = seedAcceptanceCatalog(directory, [path.resolve(media)])
fs.writeFileSync(path.join(directory, 'this-computer.json'), JSON.stringify({ mode: 'local', closeToTray: false,
  playbackRenderMode: mode, resumePlayback: false, playbackVolume: 5 }))
const report = { passed: false, display, mode, consumer, operations: [], limits: ['Compositor captures; no physical scanout/audio synchronization proof'] }
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let application
try {
  if (mode === 'auto') process.env.JAVDEX_PLAYBACK_DIAGNOSTICS = '1'
  application = await launchAcceptance(directory, 'lifecycle-application.log', [`--javdex-${display}`, `--ozone-platform=${display}`,
    ...(!process.env.JAVDEX_PLAYBACK_ACCEPTANCE_EXECUTABLE ? ['--no-sandbox'] : []),
    ...(process.env.JAVDEX_PROFILE_ANGLE === 'gl' ? ['--use-angle=gl'] : []),
    ...(process.env.JAVDEX_PROFILE_DISABLE_GPU === '1' ? ['--disable-gpu'] : []),
    ...(process.env.JAVDEX_PROFILE_DYNAMIC_ANGLE === '1' ? ['--use-dynamic-angle'] : [])])
  let page = await application.firstWindow()
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  report.gpuFeatures = await application.evaluate(({ app }) => app.getGPUFeatureStatus())
  if (process.env.JAVDEX_PROFILE_TRACE === '1') await application.evaluate(async ({ contentTracing }) =>
    contentTracing.startRecording({ included_categories: ['media', 'gpu', 'disabled-by-default-gpu.service'] }))
  await application.evaluate(({ ipcMain }) => {
    globalThis.linuxAcceptanceProbes = []
    const emit = ipcMain.emit
    ipcMain.emit = function (name, ...args) {
      if (name === 'playback:shared-texture-self-test') globalThis.linuxAcceptanceProbes.push({
        sequence: args[1]?.sequence, samples: args[1]?.samples, probeFailure: args[1]?.probeFailure })
      return emit.call(this, name, ...args)
    }
  })
  assert.equal(await page.evaluate(() => window.api.playback.sharedTextureConsumer), consumer)
  const inspect = () => application.evaluate(() => {
    const channel = process.getBuiltinModule('diagnostics_channel').channel
    const hosts = { gpu: { alive: false }, cpu: { alive: false } }, lifecycle = { owners: [] }
    channel('javdex.playback.host.statistics').publish(hosts)
    channel('javdex.playback.linux-texture.statistics').publish(lifecycle)
    return { hosts, ...lifecycle }
  })
  const expectMode = mode === 'cpu' ? 'cpu' : 'gpu'
  const play = async () => {
    const opened = await page.evaluate(t => window.api.player.openResource(t.libraryId, t.resourceId, t.videoId), target)
    assert.equal(opened.ok, true, JSON.stringify(opened))
    return waitForState(page, s => s?.phase === 'playing' && s.info.playbackMode === expectMode, 'lifecycle playing')
  }
  const control = async value => {
    const state = await page.evaluate(() => window.api.playback.snapshot())
    return page.evaluate(({ id, value }) => window.api.playback.control(id, value), { id: state.sessionId, value })
  }
  const stopped = async () => {
    const old = await inspect(), pids = Object.values(old.hosts).map(h => h.pid).filter(Boolean)
    await control({ kind: 'stop' }); await waitForState(page, s => s === null, 'lifecycle stopped')
    return waitForValue(inspect, s => !s.hosts.gpu.alive && !s.hosts.cpu.alive && s.owners.length === 0
      && pids.every(pid => !fs.existsSync(`/proc/${pid}`)), 'retired transfers and helper descriptors released', 10000)
  }
  await play()
  // Exercise a timeline change while the asynchronous synthetic probe may
  // still own its old stream. A cancelled probe must be requested again.
  await control({ kind: 'seek', seconds: 2 })
  await waitForValue(async () => { const s = await page.evaluate(() => window.api.playback.snapshot());
    assert(s?.phase !== 'error', JSON.stringify(s)); return s }, s => s?.phase === 'playing' && s.position > 2.3
    && (expectMode === 'cpu' || s.info.playbackDiagnostics?.displayProbe === 'passed'), 'probe after initial seek')
  report.operations.push('seek during startup / display probe passed')
  await control({ kind: 'pause', paused: true })
  const paused = await waitForState(page, s => s?.paused, 'lifecycle paused')
  await sleep(500)
  assert(Math.abs((await page.evaluate(() => window.api.playback.snapshot())).position - paused.position) < .25)
  await control({ kind: 'pause', paused: false })
  await waitForState(page, s => s && !s.paused && s.position > paused.position + .3, 'lifecycle resumed')
  report.operations.push('pause / resume')
  const beforeHide = await inspect()
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
  try {
    await sleep(500)
    const settled = await inspect(); await sleep(1000)
    report.hidden = await inspect()
    const a = settled.hosts[expectMode].transportStats, b = report.hidden.hosts[expectMode].transportStats
    if (a && b) assert(b.wakeups - a.wakeups <= 2, 'Hidden socket must not spin')
  } finally { await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show()) }
  report.afterShow = await page.evaluate(() => window.api.playback.snapshot())
  // The app intentionally pauses playback on hide; showing is not consent to resume.
  await control({ kind: 'pause', paused: false })
  await waitForValue(inspect, s => s.hosts[expectMode].pid === beforeHide.hosts[expectMode].pid
    && s.hosts[expectMode].nativeFrames > beforeHide.hosts[expectMode].nativeFrames + 5, 'same producer after hide/show')
  report.operations.push('hide / no readiness spin / show + explicit resume keeps producer')
  if (expectMode === 'gpu') {
    const before = await inspect(), cdp = await page.context().newCDPSession(page)
    await cdp.send('Debugger.enable')
    const paused = new Promise(resolve => cdp.once('Debugger.paused', resolve))
    await cdp.send('Debugger.pause'); await paused
    try {
      await sleep(2100)
      report.delayedRenderer = await inspect()
      assert(report.delayedRenderer.hosts.gpu.outstandingSurfaces <= 3)
    } finally { await cdp.send('Debugger.resume'); await cdp.send('Debugger.disable'); await cdp.detach() }
    await waitForValue(inspect, s => s.hosts.gpu.pid === before.hosts.gpu.pid
      && s.hosts.gpu.nativeFrames > before.hosts.gpu.nativeFrames + 5, 'same GPU producer after delayed acquisition', 10000)
    await waitForState(page, s => s?.phase === 'playing' && s.info.playbackMode === 'gpu', 'GPU survived renderer stall')
    report.operations.push('renderer paused >2s / same GPU producer recovered')
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1180, 760))
  await control({ kind: 'presentation', value: 'fullscreen' }); await sleep(400)
  await control({ kind: 'presentation', value: 'expanded' }); await sleep(400)
  const first = await captureAcceptanceFrame(application, output, 'before', { baseline: true })
  await sleep(500)
  const after = await captureAcceptanceFrame(application, output, 'after', { compare: true })
  assert(first.visiblePixels > 1000 && after.differentPixels > 50, 'Synthetic compositor content/motion missing')
  report.capture = after; report.operations.push('resize / fullscreen / visible motion')
  report.firstStop = await stopped()
  await play()
  await waitForState(page, s => s?.position > .5
    && (expectMode === 'cpu' || s.info.playbackDiagnostics?.displayProbe === 'passed'), 'reopened display probe')
  report.operations.push('stop / final GPU release / reopen')
  if (mode === 'auto') {
    report.faultInjected = await application.evaluate(() => {
      const control = process.getBuiltinModule('diagnostics_channel').channel('javdex.playback.host.control')
      if (!control.hasSubscribers) throw new Error('Fault-injection diagnostics are not enabled')
      control.publish({ mode: 'gpu', operation: 'kill' }); return true
    })
    report.recovered = await waitForState(page, s => s?.phase === 'playing' && s.info.playbackMode === 'cpu'
      && s.info.playbackFallback && s.position > .5, 'independent automatic CPU recovery')
    await waitForNativeFrame(application, page)
    report.recoveryPixels = await waitForValue(() => captureAcceptanceFrame(application, output, 'cpu-recovery'),
      pixels => pixels.visiblePixels > 1000, 'visible CPU recovery frame', 5000)
    report.operations.push('GPU helper termination / actual CPU recovery content')
  } else {
    // A page exit is a page failure, never a graphics retry into a new session.
    const old = await inspect(), pids = Object.values(old.hosts).map(h => h.pid).filter(Boolean)
    await page.reload(); await page.waitForFunction(() => window.api?.playback)
    report.pageExit = await waitForValue(inspect, s => !s.hosts.gpu.alive && !s.hosts.cpu.alive
      && s.owners.length === 0 && pids.every(pid => !fs.existsSync(`/proc/${pid}`)), 'page exit releases old stream', 15000)
    report.operations.push('page reload / no dangling retired transfer')
  }
  const state = await page.evaluate(() => window.api.playback.snapshot())
  if (state) report.finalStop = await stopped()
  report.passed = true
} catch (error) { report.error = error.stack; process.exitCode = 1 }
finally {
  if (application && process.env.JAVDEX_PROFILE_TRACE === '1') {
    const file = path.join(output, 'chromium-trace.json')
    await application.evaluate(async ({ contentTracing }, file) => contentTracing.stopRecording(file), file)
    const events = JSON.parse(fs.readFileSync(file, 'utf8')).traceEvents
    report.trace = { events: events.length, copyRgbaToVideoFrame: events.filter(e => e.name === 'CopyRGBATextureToVideoFrame').length,
      relatedNames: [...new Set(events.filter(e => /NV12|ConvertVideo|CopyRGB|VideoFrame/.test(e.name)).map(e => e.name))] }
  }
  if (application) report.probes = await application.evaluate(() => globalThis.linuxAcceptanceProbes).catch(() => undefined)
  if (application) report.cleanup = await closeAcceptance(application)
  if (report.cleanup?.forced || report.cleanup?.code !== 0) { report.passed = false; process.exitCode = 1 }
  save()
}
console.log(JSON.stringify({ passed: report.passed, operations: report.operations, error: report.error }))
