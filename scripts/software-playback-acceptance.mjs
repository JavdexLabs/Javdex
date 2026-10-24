// Native macOS/Windows acceptance with isolated catalogs and synthetic fixtures.
// --mode=disabled verifies automatic recovery with Chromium GPU acceleration
// disabled; initialization injects only the GL create failure; gpu-fault kills
// only this acceptance host's GPU child. producer-fault injects one native
// nextFrame exception through the real shared-frame bridge. No driver is changed.
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

assert(['darwin', 'win32'].includes(process.platform))
const host = process.platform === 'darwin' ? 'macos' : 'windows'
const mode = process.argv.find(v => v.startsWith('--mode='))?.slice(7) ?? 'disabled'
const playingFault = process.argv.includes('--playing-fault')
const agedSession = process.argv.includes('--aged-session')
const savedVolumeArg = process.argv.find(v => v.startsWith('--saved-volume='))
const savedVolume = savedVolumeArg === undefined ? undefined : Number(savedVolumeArg.slice('--saved-volume='.length))
if (savedVolume !== undefined) assert(Number.isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 100)
const recoveryVolume = savedVolume ?? 31
assert(['disabled', 'forced', 'initialization', 'gpu-fault', 'producer-fault'].includes(mode))
const recoveringFault = mode === 'gpu-fault' || mode === 'producer-fault'
const media = process.argv.slice(2).filter(v => !v.startsWith('--')).map(v => path.resolve(v))
assert(media.length > 0, 'Pass synthetic media files for the acceptance catalog')
assert(mode !== 'producer-fault' || media.length === 1, 'Run each producer-fault fixture in a fresh host; CPU recovery stays active until restart')
for (const file of media) assert(fs.statSync(file).isFile())
assert(media.every(file => path.dirname(file) === path.dirname(media[0])), 'Acceptance seed requires media under the same authorized library root; run different fixture directories separately')
fs.mkdirSync(output, { recursive: true })
const directory = createAcceptanceDirectory(`${host}-cpu-`), targets = seedAcceptanceCatalog(directory, media)
const report = { passed: false, mode, playingFault, agedSession, savedVolume, directory, checks: [], pending: ['physical GPU-less machine', 'additional GPU/driver/display combinations', 'long playback', 'signed package'] }
const nativeFile = process.env.JAVDEX_PLAYBACK_ACCEPTANCE_EXECUTABLE
  ? path.join(path.dirname(path.resolve(process.env.JAVDEX_PLAYBACK_ACCEPTANCE_EXECUTABLE)), 'resources/native-playback/playback.node')
  : path.resolve('out/native-playback/playback.node')
report.nativeSha256 = createHash('sha256').update(fs.readFileSync(nativeFile)).digest('hex')
const save = () => fs.writeFileSync(path.join(output, `${host}-cpu-${mode}.json`), JSON.stringify(report, null, 2) + '\n')
let application
try {
  const args = mode === 'disabled' ? ['--disable-gpu'] : mode === 'forced' ? ['--javdex-cpu'] : []
  application = await launchAcceptance(directory, `${host}-cpu-${mode}.log`, args)
  let page = await application.firstWindow()
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  await prepareNonRecordingPlayback(page)
  if (savedVolume !== undefined) {
    // Volume is owned by playback, not the generic settings-update contract.
    // Save it through the real control, then cold-start the same isolated profile.
    const opened = await page.evaluate(t => window.api.player.openResource(t.libraryId, t.resourceId, t.videoId), targets[0])
    assert.equal(opened.ok, true, opened.error)
    const state = await waitForState(page, s => s?.phase === 'playing' && s.position > .3, 'seed remembered playback volume')
    await page.evaluate(({ id, volume }) => window.api.playback.control(id, { kind: 'volume', value: volume }), { id: state.sessionId, volume: savedVolume })
    await waitForState(page, s => s?.volume === savedVolume, 'volume control applied')
    await page.waitForTimeout(400)
    const seeded = await closeAcceptance(application)
    report.savedVolumeSeed = { value: savedVolume, cleanup: seeded }
    assert.equal(seeded.forced, false); assert.equal(seeded.code, 0)
    application = await launchAcceptance(directory, `${host}-cpu-${mode}-restore.log`, args)
    page = await application.firstWindow()
    await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
    assert.equal((await page.evaluate(() => window.api.thisComputer.get())).resumePlayback, false)
  }
  report.gpu = await application.evaluate(async ({ app }) => {
    const acceleration = app.isHardwareAccelerationEnabled()
    let info
    try { info = await app.getGPUInfo('basic') }
    catch (error) {
      if (acceleration) throw error
      info = { unavailable: String(error.message) }
    }
    return { acceleration, features: app.getGPUFeatureStatus(), info }
  })
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
    const file = require.resolve(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node'), original = require(file)
    const injected = Object.create(null)
    for (const name of Object.getOwnPropertyNames(original)) injected[name] = original[name]
    const gpu = process.platform === 'darwin' ? injected : Object.fromEntries(Object.getOwnPropertyNames(original.sharedTexture).map(key => [key, original.sharedTexture[key]]))
    gpu.create = () => { throw new Error('OpenGL 3.2 core context is unavailable (acceptance injection)') }
    if (process.platform === 'win32') injected.sharedTexture = gpu
    require.cache[file].exports = injected
  })
  if (mode === 'producer-fault') await application.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const file = require.resolve(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node')
    const original = require(file)
    const producer = process.platform === 'darwin' ? original : original.sharedTexture
    const shared = Object.fromEntries(Object.getOwnPropertyNames(producer).map(key => [key, producer[key]]))
    shared.nextFrame = (...args) => {
      if (globalThis.injectProducerFault) {
        globalThis.injectProducerFault = false
        throw new Error('Shared GL render failed (acceptance injection)')
      }
      return producer.nextFrame(...args)
    }
    require.cache[file].exports = process.platform === 'darwin' ? shared
      : { ...Object.fromEntries(Object.getOwnPropertyNames(original).map(key => [key, original[key]])), sharedTexture: shared }
  })
  const native = () => application.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const addon = require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node'), s = addon.software.inspect()
    return { alive: s.alive, backend: s.backend, width: s.pixelWidth, height: s.pixelHeight, frames: s.nativeFrames,
      position: s['time-pos'], audioPosition: s['audio-pts'], decoder: s['hwdec-current'], audio: s['current-ao'],
      volume: s.volume, muted: s.mute, speed: s.speed, sid: s.sid, aid: s.aid,
      droppedFrames: s['frame-drop-count'],
      error: s.error, loaded: s.loadedFiles, canvasAlive: (process.platform === 'darwin' ? addon : addon.sharedTexture).inspect().alive }
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
    if (recoveringFault) {
      assert.equal(state.info.playbackMode, 'gpu')
      const faultPosition = mode === 'producer-fault' ? pausedPosition : 3
      await control({ kind: 'pause', paused: true }); await control({ kind: 'seek', seconds: faultPosition })
      if (savedVolume === undefined) await control({ kind: 'volume', value: recoveryVolume })
      await control({ kind: 'mute', muted: true }); await control({ kind: 'speed', value: 1.25 })
      const sub = state.tracks.find(t => t.type === 'sub')
      if (sub) await control({ kind: 'track', type: 'sub', id: sub.id })
      if (playingFault) await control({ kind: 'pause', paused: false })
      check.before = await waitForState(page, s => s?.paused === !playingFault && !s.seeking && Math.abs(s.position - faultPosition) < .15 && s.volume === recoveryVolume && s.muted && s.speed === 1.25
        && (!sub || s.tracks.some(t => t.type === 'sub' && t.id === sub.id && t.selected)), 'state before GPU fault')
      const restoredPosition = value => playingFault ? value >= check.before.position - .5 : Math.abs(value - faultPosition) < .5
      if (agedSession) await page.waitForTimeout(31000)
      if (mode === 'producer-fault') {
        await application.evaluate(() => { globalThis.injectProducerFault = true })
        check.injected = 'one native nextFrame exception; actual CPU decoder/rendering and bridge recovery'
      } else check.killedGpu = await application.evaluate(({ app }) => {
        const gpu = app.getAppMetrics().find(p => p.type === 'GPU')
        if (!gpu || gpu.pid === process.pid) throw new Error('No owned GPU child to terminate')
        process.kill(gpu.pid); return gpu.pid
      })
      state = await waitForState(page, s => s?.info?.playbackMode === 'cpu' && s.paused === !playingFault && restoredPosition(s.position), 'automatic CPU recovery after graphics fault')
      assert.equal(state.info.playbackFallback, true)
      await waitForValue(native, n => n.alive && n.frames >= 1 && restoredPosition(n.position), 'native CPU restored position')
      state = await waitForState(page, s => s?.volume === recoveryVolume && s.muted && s.speed === 1.25 && s.paused === !playingFault && restoredPosition(s.position), 'restored volume/mute/speed and pause')
      check.restoredNative = await waitForValue(native, n => n.volume === recoveryVolume && n.muted && n.speed === 1.25 && restoredPosition(n.position), 'native settings restored after asynchronous command replies')
      assert.equal(state.volume, recoveryVolume); assert.equal(state.muted, true); assert.equal(state.speed, 1.25)
      check.after = state
      if (sub) assert(state.tracks.some(t => t.type === 'sub' && t.id === sub.id && t.selected), 'recovery retains the selected subtitle')
    }
    state = await waitForState(page, s => s?.info?.playbackMode === 'cpu' && s.sharedTextureSurface?.startsWith('cpu:'), 'CPU surface')
    assert.equal(state.info.hardwareDecoder, 'no')
    if (!recoveringFault) {
      check.playingNative = await native()
      if (['wasapi', 'coreaudio'].includes(check.playingNative.audio)) {
        assert.equal(typeof check.playingNative.audioPosition, 'number')
        assert(Math.abs(check.playingNative.position - check.playingNative.audioPosition) < .5, 'native audio/video clocks must stay within 500ms')
      }
    }
    assert.equal(state.info.playbackFallback, mode !== 'forced')
    if (mode === 'disabled') assert.equal(state.info.playbackDiagnostics.fallbackReason, 'GPU_DISABLED')
    await waitForValue(() => application.evaluate((_electron, surface) => globalThis.cpuReceipts.get(surface) ?? 0, state.sharedTextureSurface), n => n >= (recoveringFault ? 1 : 3), 'actual CPU Canvas submissions')
    if (!recoveringFault) {
      await control({ kind: 'pause', paused: true }); await control({ kind: 'seek', seconds: pausedPosition })
      await waitForState(page, s => s?.paused && !s.seeking && Math.abs(s.position - pausedPosition) < .5, 'CPU paused seek')
      await waitForValue(native, n => n.loaded === 1 && Math.abs(n.position - pausedPosition) < .5, 'native CPU paused seek')
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
    if (!recoveringFault) assert.equal(check.native.canvasAlive, false)
    const sub = state.tracks.find(t => t.type === 'sub')
    if (sub) {
      await control({ kind: 'track', type: 'sub', id: null })
      await waitForValue(native, n => n.sid === 'no', 'native subtitle deselection')
      await page.waitForTimeout(200)
      const off = await capture(`${index}-sub-off`)
      await control({ kind: 'track', type: 'sub', id: sub.id })
      await waitForValue(native, n => n.sid === String(sub.id), 'native subtitle selection')
      // Native commands and copied Canvas delivery are asynchronous. Observe
      // the unchanged pixel threshold instead of assuming a 200ms screenshot
      // has already consumed the newly selected ASS/PGS frame.
      let attempt = 0
      check.subtitlePixels = await waitForValue(async () => {
        const on = await capture(`${index}-sub-on-${++attempt}`)
        assert.equal(on.data.length, off.data.length)
        let changed = 0
        for (let i = 0; i < on.data.length; i += 4)
          if (Math.max(Math.abs(on.data[i] - off.data[i]), Math.abs(on.data[i + 1] - off.data[i + 1]), Math.abs(on.data[i + 2] - off.data[i + 2])) > 40) changed++
        return changed
      }, changed => changed > 50, 'embedded subtitle must change actual Canvas pixels', 3000)
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
