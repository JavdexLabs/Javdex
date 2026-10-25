// Short, isolated GPU/CPU profile using product defaults.
// This does not certify physical display latency.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createAcceptanceDirectory, seedAcceptanceCatalog, launchAcceptance, waitForState,
  closeAcceptance, captureAcceptanceImage, output } from './playback-acceptance-support.mjs'
import { checkSyntheticCanvasFrame } from './windows-canvas-checks.mjs'
import { prepareNonRecordingPlayback } from './playback-acceptance-settings.mjs'

assert.equal(process.platform, 'win32', 'Requires native Windows')
const [file, backend = 'gpu', secondsText = '10'] = process.argv.slice(2)
assert.ok(file, 'Pass a synthetic test video')
assert.ok(['gpu', 'cpu'].includes(backend), 'Unknown backend')
const seconds = Number(secondsText)
assert.ok(Number.isFinite(seconds) && seconds >= 3 && seconds <= 120, 'Use 3–120 seconds')
const warmup = Number(process.argv.find(value => value.startsWith('--warmup='))?.slice(9) ?? '2')
assert.ok(Number.isFinite(warmup) && warmup >= 0 && warmup <= 10)
const sourceFps = Number(process.argv.find(value => value.startsWith('--source-fps='))?.slice(13))
const consumerLuid = process.argv.find(value => value.startsWith('--consumer-luid='))?.slice(16)
if (consumerLuid) assert.match(consumerLuid, /^-?\d+,\d+$/, 'Consumer LUID must be high,low decimal parts')
const contentSize = process.argv.find(value => value.startsWith('--content-size='))?.slice(15) ?? '1920x1200'
assert.match(contentSize, /^\d+x\d+$/)
const [contentWidth, contentHeight] = contentSize.split('x').map(Number)
assert.ok(contentWidth >= 1000 && contentWidth <= 3840 && contentHeight >= 640 && contentHeight <= 2160)
process.env.JAVDEX_PLAYBACK_DIAGNOSTICS = '1'
const directory = createAcceptanceDirectory('gpu-profile-')
const [target] = seedAcceptanceCatalog(directory, [path.resolve(file)])
const executable = process.env.JAVDEX_PLAYBACK_ACCEPTANCE_EXECUTABLE
const nativeDirectory = executable ? path.join(path.dirname(path.resolve(executable)), 'resources/native-playback') : path.resolve('out/native-playback')
const artifacts = Object.fromEntries(['playback.node', 'playback-interop.node', 'libmpv-2.dll'].map(name =>
  [name, createHash('sha256').update(fs.readFileSync(path.join(nativeDirectory, name))).digest('hex')]))
const report = { passed: false, artifacts, requestedBackend: backend, seconds,
  warmupSeconds: warmup,
  consumerLuidOverride: consumerLuid,
  requestedContentSize: { width: contentWidth, height: contentHeight },
  timingScope: 'host wall times; renderCall can include uploads; glFinishWait confirms GPU completion; no physical presentation measurement',
  samples: [] }
let application
try {
  application = await launchAcceptance(directory, `gpu-profile-${backend}.log`, [
    ...(consumerLuid ? [`--use-adapter-luid=${consumerLuid}`] : [])
  ])
  report.runtime = await application.evaluate(() => ({ electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node }))
  const page = await application.firstWindow()
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  await prepareNonRecordingPlayback(page)
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setFullScreen(false); window.unmaximize() })
  await page.waitForTimeout(200)
  await application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width: contentWidth, height: contentHeight })
  report.window = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ id: window.id,
    bounds: window.getBounds(), contentBounds: window.getContentBounds(), maximized: window.isMaximized(), zoom: window.webContents.getZoomFactor() })))
  report.cssViewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scale: devicePixelRatio }))
  // Windows rounds non-client borders at fractional DPI (this machine: 175%).
  // Record actual sizes rather than inferring the physical output dimensions.
  assert.ok(Math.abs(report.window[0].contentBounds.width - contentWidth) <= 2)
  assert.ok(Math.abs(report.window[0].contentBounds.height - contentHeight) <= 2)
  await page.evaluate(mode => window.api.thisComputer.update({ playbackRenderMode: mode }), backend === 'cpu' ? 'cpu' : 'gpu')
  const opened = await page.evaluate(t => window.api.player.openResource(t.libraryId, t.resourceId, t.videoId), target)
  assert.equal(opened.ok, true, opened.error)
  const playing = await waitForState(page, state => state?.phase === 'playing' && state.position > .5
    && (backend === 'cpu' || state.info.playbackDiagnostics.displayProbe === 'passed'), 'profile playback')
  await delay(warmup * 1000)
  report.initialPlayback = await page.evaluate(() => window.api.playback.snapshot())
  const start = performance.now()
  for (let index = 0; index <= seconds * 2; index++) {
    await delay(Math.max(0, start + index * 500 - performance.now()))
    const sample = await application.evaluate(({ app }) => {
      const value = { gpu: { alive: false }, cpu: { alive: false } }
      process.getBuiltinModule('diagnostics_channel').channel('javdex.playback.host.statistics').publish(value)
      const transport = {}
      process.getBuiltinModule('diagnostics_channel').channel('javdex.playback.windows-shared-texture.statistics').publish(transport)
      return { hosts: value, transport, metrics: app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({ pid, type, cpu, memory })) }
    })
    report.samples.push({ elapsedMs: performance.now() - start, ...sample })
  }
  report.finalPlayback = await page.evaluate(() => window.api.playback.snapshot())
  assert.ok(report.finalPlayback.position > playing.position + seconds * .5, 'Playback clock must advance')
  const native = report.samples.at(-1).hosts[backend === 'cpu' ? 'cpu' : 'gpu']
  assert.equal(native.alive, true)
  if (backend !== 'cpu') {
    assert.ok(native.producerTimings?.renderCall.samples > 0, 'Native timing instrumentation must be active')
    assert.equal(native.producerBackend, 'angle-d3d11')
    assert.equal(native.producerOutput, 'direct-shared')
    assert.equal(native.producerSynchronization, 'gl-finish')
    assert.ok(native.directOutputFrames > 0, 'Direct output must actually produce frames')
    assert.equal(native.producerTimings.glFinishWait.samples, native.directOutputFrames)
    if (native.consumerGpu?.adapterSelection === 'chromium-active-pci')
      assert.match(native.producerAdapterSelection, /^chromium-active-/)
  }
  report.deviceAndTimings = native
  const first = report.samples[0].hosts[backend === 'cpu' ? 'cpu' : 'gpu']
  report.intervalTimings = Object.fromEntries(Object.entries(native.producerTimings ?? {}).flatMap(([name, last]) => {
    const before = first.producerTimings?.[name], samples = last.samples - (before?.samples ?? 0)
    return samples > 0 ? [[name, { samples, meanMs: (last.meanMs * last.samples - (before?.meanMs ?? 0) * (before?.samples ?? 0)) / samples }]] : []
  }))
  const duration = (report.samples.at(-1).elapsedMs - report.samples[0].elapsedMs) / 1000
  const mean = values => values.reduce((total, value) => total + value, 0) / values.length
  report.performance = {
    durationSeconds: duration,
    producerFps: ((native.producerTimings?.renderCall.samples ?? 0) - (first.producerTimings?.renderCall.samples ?? 0)) / duration,
    canvasSubmittedFps: (report.samples.at(-1).transport.submittedFrames - report.samples[0].transport.submittedFrames) / duration,
    droppedFrames: report.finalPlayback.info.droppedFrames - report.initialPlayback.info.droppedFrames,
    appCpuPercent: mean(report.samples.slice(1).map(sample => sample.metrics.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0))),
    meanWorkingSetMiB: mean(report.samples.slice(1).map(sample => sample.metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize / 1024, 0))),
    peakWorkingSetMiB: Math.max(...report.samples.map(sample => sample.metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize / 1024, 0))),
    ...(Number.isFinite(sourceFps) ? { sourceFps } : {})
  }
  // Capture only after timed samples; readback can perturb the Canvas backend.
  const image = await captureAcceptanceImage(application)
  report.canvas = checkSyntheticCanvasFrame(image)
  await page.screenshot({ path: path.join(output, `gpu-profile-${backend}.png`) })
  await page.evaluate(id => window.api.playback.control(id, { kind: 'stop' }), playing.sessionId)
  await waitForState(page, state => state === null, 'profile stop')
  report.passed = true
} catch (error) {
  report.error = error.stack
  process.exitCode = 1
} finally {
  if (application) report.cleanup = await closeAcceptance(application)
  if (report.cleanup?.forced || report.cleanup?.code !== 0) { report.passed = false; process.exitCode = 1 }
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, `gpu-profile-${backend}.json`), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: report.passed, requestedBackend: backend, error: report.error }))
