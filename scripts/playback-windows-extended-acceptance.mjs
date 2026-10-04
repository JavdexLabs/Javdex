// Isolated Windows 4K/60 and long-timeline acceptance. No personal catalog.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { closeAcceptance, createAcceptanceDirectory, launchAcceptance, output, seedAcceptanceCatalog, waitForState, waitForValue } from './playback-acceptance-support.mjs'

assert.equal(process.platform, 'win32')
const soakSeconds = Number(process.argv.find(argument => argument.startsWith('--soak-seconds='))?.split('=')[1] ?? 600)
assert.ok(Number.isInteger(soakSeconds) && soakSeconds >= 30 && soakSeconds <= 7200, 'invalid soak duration')
const media = path.join(output, 'windows-4k60-two-hours.mkv')
const reportFile = path.join(output, 'windows-extended-report.json')
const report = { status: 'running', platform: 'win32/x64', checks: [], samples: [], pending: [
  'human audio and reader speech', 'real long movie and complex high-bitrate 4K',
  'physical cross-display DPI', 'signed release and clean separate machine installation' ] }
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
fs.mkdirSync(output, { recursive: true })
save()
let application
const errors = []
try {
  if (!fs.existsSync(media)) {
    const sample = path.join(output, 'windows-4k60-sample.mp4')
    const recipes = []
    if (!fs.existsSync(sample)) recipes.push(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'smptebars=size=3840x2160:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-vf', 'scroll=horizontal=0.005', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', sample])
    recipes.push(['-hide_banner', '-loglevel', 'error', '-stream_loop', '599', '-i', sample,
      '-t', '7200', '-c', 'copy', media])
    report.generatedFixtureCommands = recipes
    save()
    for (const args of recipes) {
      const encoded = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 300000 })
      if (encoded.error) throw encoded.error
      assert.equal(encoded.status, 0, encoded.stderr)
    }
  }
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', media], { encoding: 'utf8', timeout: 10000 })
  if (probe.error) throw probe.error
  assert.equal(probe.status, 0, probe.stderr)
  const metadata = JSON.parse(probe.stdout)
  const video = metadata.streams.find(stream => stream.codec_type === 'video')
  assert.equal(video.width, 3840)
  assert.equal(video.height, 2160)
  assert.equal(video.r_frame_rate, '60/1')
  assert.ok(Number(metadata.format.duration) >= 7200)
  report.fixture = { synthetic: true, looped: true, reused: !report.generatedFixtureCommands,
    duration: Number(metadata.format.duration), width: video.width, height: video.height,
    fps: video.r_frame_rate, bytes: Number(metadata.format.size) }
  save()
  const directory = createAcceptanceDirectory('windows-extended-')
  const [target] = seedAcceptanceCatalog(directory, [media])
  application = await launchAcceptance(directory, 'windows-extended-application.log')
  report.host = await application.evaluate(({ app }) => ({ packaged: app.isPackaged,
    executable: process.execPath, resourcesPath: process.resourcesPath, cwd: process.cwd(),
    path: process.env.Path ?? process.env.PATH, mpvPrefix: process.env.JAVDEX_MPV_PREFIX ?? null }))
  const page = await application.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  await page.evaluate(() => window.api.thisComputer.update({ playerPreference: 'builtin' }))
  assert.equal((await page.evaluate(target => window.api.player.play(target.libraryId, target.videoId), target)).ok, true)
  const initial = await waitForState(page, state => state?.phase === 'playing' && state.position > 1, '4K startup')
  const id = initial.sessionId
  assert.equal(initial.info.width, 3840)
  assert.equal(initial.info.height, 2160)
  assert.equal(initial.info.audioOutput, 'wasapi')
  report.initial = initial
  const control = action => page.evaluate(({ id, action }) => window.api.playback.control(id, action), { id, action })
  const observe = async () => {
    const state = await page.evaluate(() => window.api.playback.snapshot())
    const native = await application.evaluate(async ({ app, BrowserWindow, screen }) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
      const value = require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node').inspect()
      const window = BrowserWindow.getAllWindows()[0]
      return { alive: value.alive, loadedFiles: value.loadedFiles, presentedFrames: value.presentedFrames,
        commandErrors: value.commandErrors, audioPosition: value['audio-pts'], videoPosition: value['time-pos'],
        pixelWidth: value.pixelWidth, pixelHeight: value.pixelHeight,
        controlsVisible: value.fullscreenControlsVisible, bounds: window.getBounds(),
        focused: window.isFocused(), visible: window.isVisible(), minimized: window.isMinimized(),
        renderCalls: value.renderCalls, measuredFrames: value.measuredFrames,
        frameWakeups: value.frameWakeups,
        renderMilliseconds: value.renderMilliseconds, swapMilliseconds: value.swapMilliseconds,
        maxRenderMilliseconds: value.maxRenderMilliseconds, maxSwapMilliseconds: value.maxSwapMilliseconds,
        renderingElapsedMilliseconds: value.renderingElapsedMilliseconds,
        scale: screen.getDisplayMatching(window.getBounds()).scaleFactor, zoom: window.webContents.getZoomFactor(),
        memory: await process.getProcessMemoryInfo() }
    })
    assert.equal(state.sessionId, id)
    assert.equal(state.recordingProgress, false)
    assert.notEqual(state.phase, 'error', state.error)
    assert.equal(native.loadedFiles, 1)
    assert.equal(native.commandErrors, 0)
    assert.equal(native.alive, true)
    return { wallTime: Date.now(), state, native }
  }
  report.displays = await application.evaluate(({ screen }) => screen.getAllDisplays().map(display => ({
    id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor, displayFrequency: display.displayFrequency,
    rotation: display.rotation, internal: display.internal })))
  await control({ kind: 'pause', paused: true })
  for (const seconds of [3599, 3601, 7198, 0]) {
    await control({ kind: 'seek', seconds })
    await waitForState(page, state => state?.paused && !state.seeking && Math.abs(state.position - seconds) < 0.12, `two-hour seek ${seconds}`)
    report.checks.push({ name: `paused long-timeline seek ${seconds}`, evidence: await observe() })
    save()
  }
  for (const zoom of [1, 1.25, 1.5, 1.75, 2]) {
    await application.evaluate(({ BrowserWindow }, zoom) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setSize(1000, 640)
      window.webContents.setZoomFactor(zoom)
    }, zoom)
    const geometry = await waitForValue(async () => {
      const evidence = await observe()
      const surface = await page.evaluate(() => document.querySelector('[data-playback-session] button[aria-label^="视频画面"]')?.getBoundingClientRect().toJSON())
      return { evidence, surface }
    }, value => value.surface && Math.abs(value.evidence.native.pixelWidth - Math.round(value.surface.width * zoom * value.evidence.native.scale)) <= 2
      && Math.abs(value.evidence.native.pixelHeight - Math.round(value.surface.height * zoom * value.evidence.native.scale)) <= 2, `native geometry zoom ${zoom}`)
    report.checks.push({ name: `application zoom ${zoom}`, ...geometry })
    save()
  }
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.setZoomFactor(1)
    window.setSize(1369, 875)
    window.focus()
  })
  if (process.argv.includes('--require-focus')) {
    console.log('4K fixture ready: activate the isolated Javdex window before the performance sample')
    await waitForValue(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), Boolean, 'actual foreground focus', 120000)
  }
  await control({ kind: 'seek', seconds: 0 })
  await control({ kind: 'pause', paused: false })
  await waitForState(page, state => state?.phase === 'playing' && state.position > 0.5, 'soak start')
  const started = await observe()
  const soakMilliseconds = soakSeconds * 1000
  report.soak = { durationMilliseconds: soakMilliseconds, started }
  save()
  console.log(`4K/60 ${soakSeconds}-second continuous playback started`)
  let changed = 0
  let previous = started
  while (Date.now() - started.wallTime < soakMilliseconds) {
    await page.waitForTimeout(2000)
    const sample = await observe()
    // Retain failing samples too. Renderer snapshot and the main inspector are
    // separate calls; compare AV clocks within one native state observation.
    report.samples.push(sample)
    save()
    assert.ok(sample.state.position > previous.state.position + 0.2, '4K clock stalled')
    assert.ok(sample.native.presentedFrames > previous.native.presentedFrames, '4K frame presentation stalled')
    assert.ok(Number.isFinite(sample.native.audioPosition), 'audio clock missing')
    assert.ok(Number.isFinite(sample.native.videoPosition), 'native video clock missing')
    assert.ok(Math.abs(sample.native.audioPosition - sample.native.videoPosition) < 0.5,
      `audio clock diverged from native video clock: ${JSON.stringify({ audio: sample.native.audioPosition, video: sample.native.videoPosition, renderer: sample.state.position })}`)
    previous = sample
    const step = Math.floor((sample.wallTime - started.wallTime) / 120000)
    if (step > changed && step < 5) {
      changed = step
      await control({ kind: 'presentation', value: ['expanded', 'docked', 'expanded', 'fullscreen', 'expanded'][step] })
    }
    save()
  }
  const finished = await observe()
  report.soak.finished = finished
  report.soak.elapsedMilliseconds = finished.wallTime - started.wallTime
  report.soak.presentedFrames = finished.native.presentedFrames - started.native.presentedFrames
  report.soak.droppedFrames = finished.state.info.droppedFrames - started.state.info.droppedFrames
  report.soak.presentedFramesPerSecond = report.soak.presentedFrames / (report.soak.elapsedMilliseconds / 1000)
  assert.ok(Math.abs((finished.state.position - started.state.position) - report.soak.elapsedMilliseconds / 1000) < 2, 'soak wall/video clocks disagree')
  report.checks.push({ name: `${soakSeconds}-second 4K/60 continuous playback clocks`, elapsedMilliseconds: report.soak.elapsedMilliseconds,
    presentedFrames: report.soak.presentedFrames, droppedFrames: report.soak.droppedFrames })
  await control({ kind: 'presentation', value: 'expanded' })
  await control({ kind: 'seek', seconds: 7198 })
  const ended = await waitForState(page, state => state?.phase === 'ended', 'two-hour EOF', 20000)
  assert.ok(ended.position > 7199)
  assert.equal(ended.sessionId, id)
  report.checks.push({ name: 'two-hour EOF', state: ended, native: (await observe()).native })
  assert.ok(report.soak.presentedFramesPerSecond >= 55, `4K/60 frame presentation too slow: ${report.soak.presentedFramesPerSecond.toFixed(2)} fps`)
  assert.ok(report.soak.droppedFrames <= soakSeconds * 60 * 0.05, `4K/60 excessive frame drops: ${report.soak.droppedFrames}`)
  report.checks.push({ name: '4K/60 frame rate and drops', fps: report.soak.presentedFramesPerSecond, droppedFrames: report.soak.droppedFrames })
  assert.deepEqual(errors, [])
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  if (application) {
    report.cleanup = await closeAcceptance(application)
    if (report.cleanup.forced || report.cleanup.code !== 0) {
      report.status = 'failed'
      report.error ??= 'acceptance host did not exit normally'
      process.exitCode = 1
    }
  }
  save()
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, cleanup: report.cleanup, error: report.error }))
}
