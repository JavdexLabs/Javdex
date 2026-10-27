// Serial, visible-window Linux measurements. Readback is outside the timed run.
// CPU 100% = one logical core. Captures prove composited content, not scanout.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createAcceptanceDirectory, seedAcceptanceCatalog, launchAcceptance,
  waitForState, waitForValue, closeAcceptance, captureAcceptanceFrame } from './playback-acceptance-support.mjs'

const [input, destination, display, mode, resolution, fpsArg, secondsArg = '60'] = process.argv.slice(2)
assert(input && destination && ['wayland', 'x11'].includes(display) && ['gpu', 'cpu'].includes(mode)
  && ['1080', '2160', 'native'].includes(resolution),
'Usage: linux-playback-profile.mjs MEDIA NEW_OUTPUT wayland|x11 gpu|cpu 1080|2160|native SOURCE_FPS [SECONDS]')
const seconds = Number(secondsArg), sourceFps = Number(fpsArg)
const decoderPreference = process.env.JAVDEX_PROFILE_HWDEC
assert(!decoderPreference || mode === 'gpu' && ['auto-copy', 'nvdec,auto-copy', 'vaapi,auto-copy', 'no'].includes(decoderPreference))
const expectedDecoder = process.env.JAVDEX_PROFILE_EXPECT_HWDEC
assert(!expectedDecoder || ['nvdec', 'vaapi', 'nvdec-copy', 'vaapi-copy', 'no'].includes(expectedDecoder))
const deviceScaleFactor = process.env.JAVDEX_PROFILE_DEVICE_SCALE_FACTOR
assert(!deviceScaleFactor || /^\d+(?:\.\d+)?$/.test(deviceScaleFactor) && Number(deviceScaleFactor) >= 1 && Number(deviceScaleFactor) <= 3,
  'JAVDEX_PROFILE_DEVICE_SCALE_FACTOR must be a number from 1 to 3')
assert(Number.isInteger(seconds) && seconds >= 60 && seconds <= 660)
assert(Number.isFinite(sourceFps) && sourceFps > 0 && sourceFps <= 240)
const output = path.resolve(destination), media = path.resolve(input)
fs.mkdirSync(output)
const profile = createAcceptanceDirectory('profile-')
const [target] = seedAcceptanceCatalog(profile, [media])
fs.writeFileSync(path.join(profile, 'this-computer.json'), JSON.stringify({ mode: 'local', closeToTray: false,
  playbackRenderMode: mode, resumePlayback: false, playbackVolume: 5 }))
const hash = async file => { const h = createHash('sha256'); for await (const b of fs.createReadStream(file)) h.update(b); return h.digest('hex') }
const report = { status: 'running', media, mediaSha256: await hash(media), display, mode, sourceFps, seconds,
  decoderPreference: decoderPreference ?? 'runtime-default', expectedDecoder,
  harnessSha256: await hash(fileURLToPath(import.meta.url)),
  warmupSeconds: 5, requestedResolution: resolution, outputPixels: { width: Number(resolution) * 16 / 9, height: Number(resolution) }, samples: [],
  logicalCpus: os.availableParallelism(), rssAccounting: 'Sum of per-process RSS; shared pages may be counted more than once', clockTicks: Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' })),
  limits: ['One machine; composited screenshots are not physical scanout or audible synchronization evidence',
    'Source/native/submitted counts are distinct from unique displayed frames; missing stage timings stay absent',
    'cpuPercentOneCore sums the process tree and mainCpuPercentOneCore is the Electron main pid; 100% is one logical core',
    'Producer and consumer stage means overlap and must not be added into one frame period'] }
const pixelOverride = process.env.JAVDEX_PROFILE_PIXELS
if (pixelOverride) {
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(pixelOverride)
  assert(match, 'JAVDEX_PROFILE_PIXELS must be WIDTHxHEIGHT')
  const width = Number(match[1]), height = Number(match[2])
  assert(width <= 8192 && height <= 8192 && width * height * 4 <= 256 * 1024 * 1024, 'profile pixels exceed the frame limit')
  report.outputPixels = { width, height }
  report.requestedResolution = `${resolution}+pixels`
}
if (process.env.JAVDEX_PROFILE_LABEL) report.label = process.env.JAVDEX_PROFILE_LABEL
const developmentRuntime = path.resolve('out/linux-software-runtime/linux-x64')
report.developmentRuntime = {}
for (const name of ['playback-software-helper', 'playback-fd.node']) {
  const file = path.join(developmentRuntime, name)
  if (fs.existsSync(file)) report.developmentRuntime[name] = await hash(file)
}
const save = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const sleep = ms => new Promise(r => setTimeout(r, ms))
function processes(root) {
  const all = []
  for (const name of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) try {
    const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const status = fs.readFileSync(`/proc/${name}/status`, 'utf8')
    all.push({ pid: Number(name), parent: Number(fields[1]), startTicks: fields[19], ticks: Number(fields[11]) + Number(fields[12]),
      rssKiB: Number(status.match(/VmRSS:\s+(\d+)/)?.[1] ?? 0),
      name: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')), fds: fs.readdirSync(`/proc/${name}/fd`).length })
  } catch { /* Processes can exit during a /proc snapshot. */ }
  const tree = new Set([root]); let changed = true
  while (changed) { changed = false; for (const p of all) if (tree.has(p.parent) && !tree.has(p.pid)) { tree.add(p.pid); changed = true } }
  return all.filter(p => tree.has(p.pid))
}
function accumulatedTicks(samples, include) {
  let ticks = 0
  for (let i = 1; i < samples.length; i++) for (const process of samples[i].processes) {
    if (!include(process)) continue
    const previous = samples[i - 1].processes.find(candidate => candidate.pid === process.pid && candidate.startTicks === process.startTicks)
    if (previous && include(previous)) ticks += Math.max(0, process.ticks - previous.ticks)
  }
  return ticks
}
let application
try {
  if (decoderPreference) process.env.JAVDEX_PLAYBACK_DIAGNOSTICS = '1'
  // The launch helper also writes stderr here; never share a directory with another run.
  fs.mkdirSync(process.env.JAVDEX_PLAYBACK_ACCEPTANCE_OUTPUT ?? 'out/playback-acceptance', { recursive: true })
  report.launchArguments = [`--javdex-${display}`,
    ...(process.env.JAVDEX_PROFILE_DYNAMIC_ANGLE === '1' ? ['--use-dynamic-angle'] : []),
    ...(process.env.JAVDEX_PROFILE_ANGLE === 'gl' ? ['--use-angle=gl'] : []),
    ...(deviceScaleFactor ? [`--force-device-scale-factor=${deviceScaleFactor}`] : [])]
  application = await launchAcceptance(profile, 'profile-application.log', report.launchArguments)
  const page = await application.firstWindow()
  await page.waitForFunction(() => window.api?.player && document.querySelector('nav'))
  // A window occluded by another application can retain all video textures.
  // Measure visible playback, not Chromium's background/occlusion policy.
  report.windowPolicy = 'visible, focused, always-on-top during isolated measurement'
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.setAlwaysOnTop(true); window.show(); window.focus()
  })
  report.environment = await application.evaluate(async ({ app, screen }) => {
    let gpu
    try { gpu = await app.getGPUInfo('complete') }
    catch (error) {
      gpu = { unavailable: String(error && error.message || error) }
      try { gpu.basic = await app.getGPUInfo('basic') } catch (basicError) { gpu.basicError = String(basicError && basicError.message || basicError) }
    }
    return { pid: process.pid, executable: process.execPath, versions: process.versions, gpu, displays: screen.getAllDisplays() }
  })
  const executable = process.env.JAVDEX_PLAYBACK_ACCEPTANCE_EXECUTABLE
  report.executable = executable ?? 'development Electron'
  if (executable) report.executableSha256 = await hash(executable)
  report.actualExecutableSha256 = await hash(report.environment.executable)
  report.packagedInputs = {}
  for (const name of ['resources/app.asar', 'libEGL.so', 'libGLESv2.so', 'javdex-angle.json',
    'resources/linux-texture-experimental/playback-dmabuf-helper', 'resources/linux-texture-experimental/libmpv.so.2',
    'resources/linux-texture-experimental/playback-fd.node', 'resources/linux-software-playback/playback-software-helper',
    'resources/linux-software-playback/libmpv.so.2', 'resources/linux-software-playback/playback-fd.node']) {
    const file = path.join(path.dirname(report.environment.executable), name)
    if (fs.existsSync(file)) report.packagedInputs[name] = await hash(file)
  }
  if (decoderPreference) await application.evaluate((_electron, preference) => {
    // Main-only acceptance hook, before any load. No arbitrary decoder option
    // or command is exposed through product IPC/settings.
    const cp = process.getBuiltinModule('child_process'), spawn = cp.spawn
    const encode = fields => {
      const values = fields.map(v => Buffer.from(v)), b = Buffer.alloc(8 + values.reduce((n, v) => n + 4 + v.length, 0))
      b.writeUInt32LE(b.length - 4); b.writeUInt32LE(values.length, 4)
      let p = 8
      for (const value of values) { b.writeUInt32LE(value.length, p); p += 4; value.copy(b, p); p += value.length }
      return b
    }
    cp.spawn = function (...args) {
      const child = spawn.apply(this, args)
      if (String(args[0]).endsWith('playback-dmabuf-helper')) {
        const write = child.stdin.write.bind(child.stdin)
        child.stdin.write = function (b, ...rest) {
          if (Buffer.isBuffer(b) && b.length >= 8) {
            const fields = []; let p = 8
            for (let i = 0; i < b.readUInt32LE(4); i++) { const n = b.readUInt32LE(p); p += 4; fields.push(b.toString('utf8', p, p + n)); p += n }
            if (fields[0] === 'command' && fields[1] === 'loadfile') write(encode(['command', 'set', 'hwdec', preference]))
          }
          return write(b, ...rest)
        }
      }
      return child
    }
  }, decoderPreference)
  await page.evaluate(t => { document.title = t }, `Javdex Linux 性能对照 ${display} / ${mode} / ${resolution}`)
  assert.equal((await page.evaluate(t => window.api.player.openResource(t.libraryId, t.resourceId, t.videoId), target)).ok, true)
  const initial = await waitForState(page, s => s?.phase === 'playing' && s.position > .3, 'profile playback started')
  const control = value => page.evaluate(({ id, value }) => window.api.playback.control(id, value), { id: initial.sessionId, value })
  await control({ kind: 'pause', paused: true })
  const geometry = () => page.evaluate(() => {
    const s = document.querySelector('[data-playback-surface]'), r = s.getBoundingClientRect()
    return { tag: s.tagName, width: s.videoWidth ?? s.width, height: s.videoHeight ?? s.height,
      cssWidth: r.width, cssHeight: r.height, dpr: devicePixelRatio, innerWidth, innerHeight }
  })
  if (resolution === '1080') await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setMinimumSize(640, 480))
  if (resolution === '2160' || resolution === 'native') {
    await control({ kind: 'presentation', value: 'fullscreen' })
    await sleep(500)
    if (resolution === 'native') { const g = await geometry(); report.outputPixels = { width: Math.round(g.cssWidth * g.dpr), height: Math.round(g.cssHeight * g.dpr) } }
  }
  // Resize the actual window, never spoof helper bounds or lower producer output.
  for (let i = 0; i < 8; i++) {
    const g = await geometry(), dw = report.outputPixels.width / g.dpr - g.cssWidth, dh = report.outputPixels.height / g.dpr - g.cssHeight
    if (Math.abs(dw) <= .5 && Math.abs(dh) <= (resolution === '1080' ? 1 : .5)) break
    assert(resolution !== '2160', 'Fullscreen playback surface does not cover the physical 4K display')
    await application.evaluate(({ BrowserWindow }, size) => { const w = BrowserWindow.getAllWindows()[0]; w.unmaximize(); w.setContentSize(...size) },
      [Math.round(g.innerWidth + dw), Math.round(g.innerHeight + dh)])
    await sleep(250)
  }
  await waitForValue(geometry, g => g.width === report.outputPixels.width && Math.abs(g.height - report.outputPixels.height) <= (resolution === '1080' ? 2 : 0),
    'real producer/consumer pixel geometry', 10000)
  await control({ kind: 'seek', seconds: 0 })
  await control({ kind: 'pause', paused: false })
  await sleep(report.warmupSeconds * 1000)
  report.activeGpu = await application.evaluate(async ({ app }) => {
    try { return await app.getGPUInfo('complete') }
    catch (error) { return { unavailable: String(error && error.message || error) } }
  })
  const inspect = () => application.evaluate(() => {
    const hosts = { gpu: { alive: false }, cpu: { alive: false } }, lifecycle = { owners: [] }
    process.getBuiltinModule('diagnostics_channel').channel('javdex.playback.host.statistics').publish(hosts)
    process.getBuiltinModule('diagnostics_channel').channel('javdex.playback.linux-texture.statistics').publish(lifecycle)
    return { ...hosts, owners: lifecycle.owners }
  })
  const sample = async elapsedMs => ({ elapsedMs, ...await page.evaluate(async () => {
    const snapshot = await window.api.playback.snapshot(), video = document.querySelector('video[data-playback-surface]')
    const q = video?.getVideoPlaybackQuality()
    return { snapshot, videoQuality: q ? { totalFrames: q.totalVideoFrames, droppedFrames: q.droppedVideoFrames } : null }
  }), hosts: await inspect(), processes: processes(report.environment.pid) })
  await application.evaluate(() => {
    const { monitorEventLoopDelay } = process.getBuiltinModule('perf_hooks')
    const histogram = monitorEventLoopDelay({ resolution: 10 })
    histogram.enable()
    globalThis.__javdexProfileEventLoop = histogram
  })
  const started = performance.now()
  report.samples.push(await sample(0))
  for (let i = 1; i <= seconds; i++) {
    await sleep(Math.max(0, started + i * 1000 - performance.now()))
    const s = await sample(performance.now() - started)
    report.samples.push(s)
    assert.equal(s.snapshot?.phase, 'playing'); assert.equal(s.snapshot.info.playbackMode, mode)
    if (expectedDecoder) assert.equal(s.snapshot.info.hardwareDecoder, expectedDecoder, 'Requested direct decoder did not activate')
    assert.equal(s.snapshot.paused, false); assert.equal(s.snapshot.error, null)
    assert(s.hosts[mode].alive); assert(s.hosts[mode].outstandingSurfaces <= 3)
    save()
  }
  report.geometry = await geometry()
  report.eventLoopDelay = await application.evaluate(() => {
    const histogram = globalThis.__javdexProfileEventLoop
    if (!histogram || typeof histogram.disable !== 'function') return { available: false }
    histogram.disable()
    const milliseconds = value => Number.isFinite(value) ? value / 1e6 : null
    return { available: histogram.count > 0, samples: histogram.count, resolutionMs: 10,
      meanMs: milliseconds(histogram.mean), minMs: milliseconds(histogram.min),
      p50Ms: milliseconds(histogram.percentile(50)), p99Ms: milliseconds(histogram.percentile(99)),
      maxMs: milliseconds(histogram.max) }
  })
  const first = report.samples[0], last = report.samples.at(-1), elapsed = (last.elapsedMs - first.elapsedMs) / 1000
  const percent = value => value / report.clockTicks / elapsed * 100
  const ticks = accumulatedTicks(report.samples, () => true)
  const mainTicks = accumulatedTicks(report.samples, process => process.pid === report.environment.pid)
  const helperTicks = accumulatedTicks(report.samples, process => process.name.startsWith('playback-'))
  const pixelWidth = last.hosts[mode].pixelWidth, pixelHeight = last.hosts[mode].pixelHeight
  report.summary = { cpuPercentOneCore: percent(ticks), mainCpuPercentOneCore: percent(mainTicks),
    helperCpuPercentOneCore: percent(helperTicks),
    rssMeanMiB: report.samples.reduce((n, s) => n + s.processes.reduce((a, p) => a + p.rssKiB, 0), 0) / report.samples.length / 1024,
    mainRssMeanMiB: report.samples.reduce((n, s) => n + (s.processes.find(p => p.pid === report.environment.pid)?.rssKiB ?? 0), 0) / report.samples.length / 1024,
    eventLoopDelayMs: report.eventLoopDelay,
    nativeFps: (last.hosts[mode].nativeFrames - first.hosts[mode].nativeFrames) / elapsed,
    ...(Number.isFinite(last.hosts[mode].submittedFrames) && Number.isFinite(first.hosts[mode].submittedFrames)
      ? { submittedFps: (last.hosts[mode].submittedFrames - first.hosts[mode].submittedFrames) / elapsed }
      : { submittedFpsUnavailable: true }),
    droppedFrames: last.snapshot.info.droppedFrames - first.snapshot.info.droppedFrames,
    positionAdvance: last.snapshot.position - first.snapshot.position }
  if (Number.isInteger(pixelWidth) && pixelWidth > 0 && Number.isInteger(pixelHeight) && pixelHeight > 0) {
    const stride = (pixelWidth * 4 + 63) & ~63
    report.summary.frameLayout = { pixelWidth, pixelHeight, stride, rowPadding: stride - pixelWidth * 4,
      tightlyPacked: stride === pixelWidth * 4 }
  }
  if (first.videoQuality && last.videoQuality) report.summary.videoQuality = {
    countedFps: (last.videoQuality.totalFrames - first.videoQuality.totalFrames) / elapsed,
    droppedFrames: last.videoQuality.droppedFrames - first.videoQuality.droppedFrames }
  report.summary.consumerStages = {}
  for (const [name, end] of Object.entries(last.hosts[mode].consumerTimings ?? {})) {
    const start = first.hosts[mode].consumerTimings?.[name]
    if (start && end.samples > start.samples) report.summary.consumerStages[name] = {
      samples: end.samples - start.samples, meanMs: (end.totalMs - start.totalMs) / (end.samples - start.samples) }
  }
  report.summary.producerStages = {}
  for (const [name, end] of Object.entries(last.hosts[mode].producerTimings ?? {})) {
    const start = first.hosts[mode].producerTimings?.[name]
    if (start && end.samples > start.samples && Number.isFinite(end.totalMs) && Number.isFinite(start.totalMs))
      report.summary.producerStages[name] = { samples: end.samples - start.samples,
        meanMs: (end.totalMs - start.totalMs) / (end.samples - start.samples) }
  }
  if (Number.isFinite(first.hosts[mode].hwdownloadSamples) && Number.isFinite(last.hosts[mode].hwdownloadSamples)) {
    const count = last.hosts[mode].hwdownloadSamples - first.hosts[mode].hwdownloadSamples
    report.summary.hwdownload = { samples: count, ...(count > 0 ? {
      meanMs: (last.hosts[mode].hwdownloadTotalUs - first.hosts[mode].hwdownloadTotalUs) / count / 1000 } : {}) }
  }
  if (first.hosts[mode].transportStats && last.hosts[mode].transportStats) {
    report.summary.transport = Object.fromEntries(Object.entries(last.hosts[mode].transportStats)
      .map(([name, value]) => [name, value - first.hosts[mode].transportStats[name]]))
  }
  report.rendererProbeAfterTiming = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
    const gl = canvas.getContext('webgl')
    if (!gl) return { available: false }
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      return { available: true, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : undefined,
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : undefined, version: gl.getParameter(gl.VERSION) }
    } finally { gl.getExtension('WEBGL_lose_context')?.loseContext(); canvas.width = canvas.height = 0 }
  })
  // Capture the window's composited output after timing, including video consumers.
  await captureAcceptanceFrame(application, output, 'before', { baseline: true })
  await sleep(600)
  await captureAcceptanceFrame(application, output, 'after', { compare: true })
  const a = await sharp(path.join(output, 'before.png')).ensureAlpha().raw().toBuffer(), b = await sharp(path.join(output, 'after.png')).ensureAlpha().raw().toBuffer()
  assert.equal(a.length, b.length)
  let changed = 0, colored = 0
  for (let i = 0; i < a.length; i += 4) {
    if (Math.max(...[0, 1, 2].map(c => Math.abs(a[i + c] - b[i + c]))) > 20) changed++
    if (Math.max(a[i], a[i + 1], a[i + 2]) - Math.min(a[i], a[i + 1], a[i + 2]) > 50) colored++
  }
  report.captures = { changedPixels: changed, coloredPixels: colored }
  assert(changed > 50 && colored > 1000, 'Composited synthetic content/motion missing')
  if (process.env.JAVDEX_PROFILE_TRACE === '1') {
    // Separate diagnostic interval; tracing must not contaminate CPU samples.
    await application.evaluate(async ({ contentTracing }) => contentTracing.startRecording({
      included_categories: ['media', 'gpu', 'disabled-by-default-gpu.service'] }))
    await sleep(4000)
    const traceFile = path.join(output, 'chromium-trace.json')
    await application.evaluate(async ({ contentTracing }, file) => contentTracing.stopRecording(file), traceFile)
    const events = JSON.parse(fs.readFileSync(traceFile, 'utf8')).traceEvents
    report.trace = { eventCount: events.length, mediaEvents: events.filter(e => e.cat?.split(',').includes('media')).length,
      rgbaToVideoFrameEvents: events.filter(e => e.name === 'CopyRGBATextureToVideoFrame').length,
      relatedNames: [...new Set(events.filter(e => /NV12|ConvertVideoFrame|CopyRGBATextureToVideoFrame/.test(e.name)).map(e => e.name))],
      limits: 'A separate Chromium trace; no event is not proof of an entirely copy-free pipeline' }
  }
  const producerPids = [last.hosts.gpu.pid, last.hosts.cpu.pid].filter(Boolean)
  await control({ kind: 'stop' })
  await waitForState(page, s => s === null, 'profile stopped')
  report.stopped = await waitForValue(inspect, h => !h.gpu.alive && !h.cpu.alive
    && h.owners.length === 0 && producerPids.every(pid => !fs.existsSync(`/proc/${pid}`)), 'profile leases released')
  report.status = 'measured'
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1 }
finally {
  if (application) report.cleanup = await closeAcceptance(application)
  if (report.cleanup?.forced || report.cleanup?.code !== 0) { report.status = 'failed'; process.exitCode = 1 }
  save()
}
console.log(JSON.stringify({ status: report.status, summary: report.summary, error: report.error }))
