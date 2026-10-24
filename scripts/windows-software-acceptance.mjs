// Native Windows acceptance with isolated catalogs and synthetic fixtures.
// --mode=disabled verifies automatic recovery with Chromium GPU acceleration
// disabled; initialization injects only the GL create failure; gpu-fault kills
// only this acceptance host's GPU child. No system driver/device is changed.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { bitmapFixture } from './playback-pgs-fixture.mjs'
import { createAcceptanceDirectory, seedAcceptanceCatalog, launchAcceptance, waitForState, waitForValue,
  closeAcceptance, output } from './playback-acceptance-support.mjs'
import { prepareNonRecordingPlayback } from './playback-acceptance-settings.mjs'
import { closeAcceptanceAndSave } from './playback-acceptance-cleanup.mjs'
import { checkSyntheticCanvasFrame } from './windows-canvas-checks.mjs'

assert.equal(process.platform, 'win32')
const mode = process.argv.find(v => v.startsWith('--mode='))?.slice(7) ?? 'disabled'
const playingFault = process.argv.includes('--playing-fault')
assert(['disabled', 'forced', 'initialization', 'gpu-fault', 'legacy'].includes(mode))
const media = process.argv.slice(2).filter(v => !v.startsWith('--')).map(v => path.resolve(v))
assert(media.length > 0, 'Pass synthetic media files for the acceptance catalog')
for (const file of media) assert(fs.statSync(file).isFile())
assert(media.every(file => path.dirname(file) === path.dirname(media[0])), 'Acceptance seed requires media under the same authorized library root; run different fixture directories separately')
fs.mkdirSync(output, { recursive: true })
const directory = createAcceptanceDirectory('windows-cpu-'), targets = seedAcceptanceCatalog(directory, media)
const report = { passed: false, mode, playingFault, directory, checks: [], pending: ['physical GPU-less machine', 'Intel-only WGL display and additional GPU/driver combinations', 'long playback', 'signed package'] }
report.nativeSha256 = createHash('sha256').update(fs.readFileSync('out/native-playback/playback.node')).digest('hex')
const save = () => fs.writeFileSync(path.join(output, `windows-cpu-${mode}.json`), JSON.stringify(report, null, 2) + '\n')
let application
try {
  const args = mode === 'disabled' ? ['--disable-gpu'] : mode === 'forced' ? ['--javdex-cpu'] : mode === 'gpu-fault' ? ['--javdex-windows-canvas'] : []
  application = await launchAcceptance(directory, `windows-cpu-${mode}.log`, args)
  const page = await application.firstWindow()
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  await prepareNonRecordingPlayback(page)
  report.gpu = await application.evaluate(async ({ app }) => ({ acceleration: app.isHardwareAccelerationEnabled(),
    features: app.getGPUFeatureStatus(), info: await app.getGPUInfo('basic') }))
  await application.evaluate(({ ipcMain, BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    globalThis.cpuReceipts = new Map()
    ipcMain.on('playback:shared-texture-submitted', (event, value) => {
      if (event.sender !== contents || event.senderFrame !== contents.mainFrame || !value?.surfaceToken?.startsWith('cpu:')) return
      globalThis.cpuReceipts.set(value.surfaceToken, (globalThis.cpuReceipts.get(value.surfaceToken) ?? 0) + 1)
    })
  })
  if (mode === 'initialization') await application.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const file = require.resolve(app.getAppPath() + '/out/native-playback/playback.node'), original = require(file)
    const injected = Object.create(null)
    for (const name of Object.getOwnPropertyNames(original)) injected[name] = original[name]
    injected.create = () => { throw new Error('OpenGL 3.2 core context is unavailable (acceptance injection)') }
    require.cache[file].exports = injected
  })
  const native = () => application.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const addon = require(app.getAppPath() + '/out/native-playback/playback.node'), s = addon.software.inspect()
    return { alive: s.alive, backend: s.backend, width: s.pixelWidth, height: s.pixelHeight, frames: s.nativeFrames,
      position: s['time-pos'], audioPosition: s['audio-pts'], decoder: s['hwdec-current'], audio: s['current-ao'],
      volume: s.volume, muted: s.mute, speed: s.speed, sid: s.sid, aid: s.aid,
      droppedFrames: s['frame-drop-count'],
      error: s.error, loaded: s.loadedFiles, legacyAlive: addon.inspect().alive, canvasAlive: addon.sharedTexture.inspect().alive }
  })
  const capture = async name => {
    const png = await page.locator('canvas[data-playback-surface]').screenshot()
    fs.writeFileSync(path.join(output, `${mode}-${name}.png`), png)
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    for (let i = 0; i < data.length; i += 4) { const r = data[i]; data[i] = data[i + 2]; data[i + 2] = r }
    return { data, width: info.width, height: info.height }
  }
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index], label = path.basename(media[index]), check = { label }
    const pausedPosition = label === 'bitmap-pgs.mkv' ? (bitmapFixture.cues[0].start + bitmapFixture.cues[0].end) / 2 : 3
    const opened = await page.evaluate(t => window.api.player.openResource(t.libraryId, t.resourceId, t.videoId), target)
    assert.equal(opened.ok, true, opened.error)
    let state = await waitForState(page, s => s?.phase === 'playing' && s.position > .7, label)
    const control = value => page.evaluate(({ id, value }) => window.api.playback.control(id, value), { id: state.sessionId, value })
    if (mode === 'legacy') {
      assert.equal(state.info.playbackMode, 'gpu'); assert.equal(state.info.playbackFallback, false)
      check.info = state.info; await control({ kind: 'stop' }); report.checks.push(check); save(); continue
    }
    if (mode === 'gpu-fault') {
      assert.equal(state.info.playbackMode, 'gpu')
      await control({ kind: 'pause', paused: true }); await control({ kind: 'seek', seconds: 3 })
      await control({ kind: 'volume', value: 31 }); await control({ kind: 'mute', muted: true }); await control({ kind: 'speed', value: 1.25 })
      const sub = state.tracks.find(t => t.type === 'sub')
      if (sub) await control({ kind: 'track', type: 'sub', id: sub.id })
      if (playingFault) await control({ kind: 'pause', paused: false })
      check.before = await waitForState(page, s => s?.paused === !playingFault && Math.abs(s.position - 3) < 1 && s.speed === 1.25, 'state before GPU fault')
      const restoredPosition = value => playingFault ? value >= check.before.position - .5 : Math.abs(value - 3) < .5
      check.killedGpu = await application.evaluate(({ app }) => {
        const gpu = app.getAppMetrics().find(p => p.type === 'GPU')
        if (!gpu || gpu.pid === process.pid) throw new Error('No owned GPU child to terminate')
        process.kill(gpu.pid); return gpu.pid
      })
      state = await waitForState(page, s => s?.info?.playbackMode === 'cpu' && s.paused === !playingFault && restoredPosition(s.position), 'automatic CPU recovery after actual GPU child exit')
      assert.equal(state.info.playbackFallback, true)
      await waitForValue(native, n => n.alive && n.frames >= 1 && restoredPosition(n.position), 'native CPU restored position')
      state = await waitForState(page, s => s?.volume === 31 && s.muted && s.speed === 1.25 && s.paused === !playingFault && restoredPosition(s.position), 'restored volume/mute/speed and pause')
      check.restoredNative = await waitForValue(native, n => n.volume === 31 && n.muted && n.speed === 1.25 && restoredPosition(n.position), 'native settings restored after asynchronous command replies')
      assert.equal(state.volume, 31); assert.equal(state.muted, true); assert.equal(state.speed, 1.25)
      check.after = state
    }
    state = await waitForState(page, s => s?.info?.playbackMode === 'cpu' && s.sharedTextureSurface?.startsWith('cpu:'), 'CPU surface')
    assert.equal(state.info.hardwareDecoder, 'no')
    if (mode !== 'gpu-fault') {
      check.playingNative = await native()
      if (check.playingNative.audio === 'wasapi') {
        assert.equal(typeof check.playingNative.audioPosition, 'number')
        assert(Math.abs(check.playingNative.position - check.playingNative.audioPosition) < .5, 'native audio/video clocks must stay within 500ms')
      }
    }
    assert.equal(state.info.playbackFallback, mode !== 'forced')
    if (mode === 'disabled') assert.equal(state.info.playbackDiagnostics.fallbackReason, 'GPU_DISABLED')
    await waitForValue(() => application.evaluate((_electron, surface) => globalThis.cpuReceipts.get(surface) ?? 0, state.sharedTextureSurface), n => n >= (mode === 'gpu-fault' ? 1 : 3), 'actual CPU Canvas submissions')
    if (mode !== 'gpu-fault') {
      await control({ kind: 'pause', paused: true }); await control({ kind: 'seek', seconds: pausedPosition })
      await waitForState(page, s => s?.paused && Math.abs(s.position - pausedPosition) < .5, 'CPU paused seek')
    }
    check.native = await native(); assert(check.native.width <= 8192 && check.native.height <= 8192)
    check.canvasSize = await page.locator('canvas[data-playback-surface]').evaluate(canvas => ({
      width: canvas.width, height: canvas.height,
      expectedWidth: Math.round(canvas.getBoundingClientRect().width * devicePixelRatio),
      expectedHeight: Math.round(canvas.getBoundingClientRect().height * devicePixelRatio)
    }))
    assert(Math.abs(check.native.width - check.canvasSize.expectedWidth) <= 1 && Math.abs(check.native.height - check.canvasSize.expectedHeight) <= 1,
      'CPU renderer must match the physical viewport without downscaling')
    assert.equal(check.native.decoder, 'no'); assert.equal(check.native.error, '')
    if (mode !== 'gpu-fault') { assert.equal(check.native.legacyAlive, false); assert.equal(check.native.canvasAlive, false) }
    const sub = state.tracks.find(t => t.type === 'sub')
    if (sub) {
      await control({ kind: 'track', type: 'sub', id: null }); await page.waitForTimeout(200)
      const off = await capture(`${index}-sub-off`)
      await control({ kind: 'track', type: 'sub', id: sub.id }); await page.waitForTimeout(200)
      const on = await capture(`${index}-sub-on`)
      assert.equal(on.data.length, off.data.length)
      let changed = 0
      for (let i = 0; i < on.data.length; i += 4)
        if (Math.max(Math.abs(on.data[i] - off.data[i]), Math.abs(on.data[i + 1] - off.data[i + 1]), Math.abs(on.data[i + 2] - off.data[i + 2])) > 40) changed++
      assert(changed > 50, 'embedded subtitle must change actual Canvas pixels'); check.subtitlePixels = changed
    } else {
      const first = checkSyntheticCanvasFrame(await capture(`${index}-paused`))
      await control({ kind: 'pause', paused: false })
      await waitForState(page, s => s?.position > 4.5, 'CPU video advances')
      check.pixels = checkSyntheticCanvasFrame(await capture(`${index}-playing`), first.hash)
    }
    await control({ kind: 'presentation', value: 'docked' }); await page.waitForTimeout(200)
    await control({ kind: 'presentation', value: 'expanded' })
    await control({ kind: 'presentation', value: 'fullscreen' }); await page.waitForTimeout(250)
    check.fullscreenSize = await page.locator('canvas[data-playback-surface]').evaluate(canvas => ({
      width: Math.round(canvas.getBoundingClientRect().width * devicePixelRatio),
      height: Math.round(canvas.getBoundingClientRect().height * devicePixelRatio)
    }))
    check.fullscreenNative = await waitForValue(native, n => Math.abs(n.width - check.fullscreenSize.width) <= 1
      && Math.abs(n.height - check.fullscreenSize.height) <= 1, 'full-size CPU fullscreen output')
    await waitForValue(() => page.locator('canvas[data-playback-surface]').evaluate(canvas => ({ width: canvas.width, height: canvas.height })),
      size => size.width === check.fullscreenNative.width && size.height === check.fullscreenNative.height, 'full-size CPU Canvas backing')
    await control({ kind: 'presentation', value: 'expanded' })
    await control({ kind: 'pause', paused: false })
    await page.evaluate(() => { const end = performance.now() + 650; while (performance.now() < end) { /* bounded slow CPU consumer */ } })
    assert.equal((await page.evaluate(() => window.api.playback.snapshot())).info.playbackMode, 'cpu')
    await control({ kind: 'stop' }); await waitForState(page, s => s === null, 'CPU stop')
    check.stopped = await native(); assert.equal(check.stopped.alive, false); assert.equal(check.stopped.width, 0)
    report.checks.push(check); save()
    if (mode === 'gpu-fault') break
  }
  report.passed = true
} catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1 }
finally { save(); await closeAcceptanceAndSave(report, application, closeAcceptance, save) }
