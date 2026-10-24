// Explicit Windows-device follow-up, never a Mac/cross-compiler acceptance.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { prepareMediaFixtures } from './playback-media-fixtures.mjs'
import { prepareNonRecordingPlayback } from './playback-acceptance-settings.mjs'
import { captureAcceptanceImage, captureAcceptanceFrame, createAcceptanceDirectory, seedAcceptanceCatalog, launchAcceptance,
  nativeEvidence, output, waitForState, waitForValue, closeAcceptance } from './playback-acceptance-support.mjs'
import { closeAcceptanceAndSave } from './playback-acceptance-cleanup.mjs'
import { installCanvasSubmissionObserver, checkSyntheticCanvasFrame } from './windows-canvas-checks.mjs'

assert.equal(process.platform, 'win32', 'Windows Canvas acceptance requires a native Windows desktop')
const fixture = prepareMediaFixtures(), directory = createAcceptanceDirectory('windows-canvas-')
const [target, assTarget, pgsTarget] = seedAcceptanceCatalog(directory,
  [fixture.media[0], fixture.media[fixture.complexIndex], fixture.media[fixture.bitmapIndex]])
const report = { passed: false, backend: 'windows-d3d11-nt-canvas2d', checks: [], pending: [
  'four-corner orientation, SDR reference colors and HDR mapping',
  'device removal, renderer/GPU crash quarantine, multi-GPU/display/remote-desktop compatibility',
  'physical display/audio sync, long-run handles/memory/power and installed/signed packages'
] }
const reportFile = path.join(output, 'windows-canvas-report.json')
let application, surfaceToken
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
try {
  application = await launchAcceptance(directory, 'windows-canvas-application.log', [])
  const page = await application.firstWindow()
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  await prepareNonRecordingPlayback(page)
  await application.evaluate(({ app }) => {
    assertStartup()
    function assertStartup() {
      if (app.commandLine.hasSwitch('disable-direct-composition'))
        throw Error('Canvas startup selection/composition is incorrect')
    }
  })
  await application.evaluate(installCanvasSubmissionObserver)
  const inspect = () => application.evaluate(({ app }, surfaceToken) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const state = require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node').sharedTexture.inspect()
    return { alive: state.alive, outstanding: state.outstandingSurfaces, peak: state.peakOutstandingSurfaces,
      frames: state.nativeFrames, width: state.pixelWidth, height: state.pixelHeight,
      adapter: [state.producerAdapterLuidLow, state.producerAdapterLuidHigh], submitted: globalThis.windowsCanvasReceipts.get(surfaceToken)?.count ?? 0 }
  }, surfaceToken)
  for (let iteration = 0; iteration < 3; iteration++) {
    const opened = await page.evaluate(t => window.api.player.openResource(t.libraryId, t.resourceId, t.videoId), target)
    assert.equal(opened.ok, true, opened.error)
    const state = await waitForState(page, s => s?.phase === 'playing' && s.position > .5, 'Windows Canvas playback')
    assert.ok(state.sharedTextureSurface); assert.equal(state.rendererFullscreenControls, true)
    surfaceToken = state.sharedTextureSurface
    await waitForValue(inspect, s => s.frames > 2 && s.submitted > 1, 'native production and real Canvas submission')
    assert.equal((await nativeEvidence(application)).presentedFrames, undefined, 'Canvas receipt is not physical presentation')
    const image = await captureAcceptanceImage(application)
    const firstPixels = checkSyntheticCanvasFrame(image)
    await waitForState(page, s => s?.position > state.position + 1, 'synthetic video clock advances')
    const laterPixels = checkSyntheticCanvasFrame(await captureAcceptanceImage(application), firstPixels.hash)
    await page.screenshot({ path: path.join(output, `windows-canvas-${iteration}.png`) })
    const control = value => page.evaluate(({ id, value }) => window.api.playback.control(id, value), { id: state.sessionId, value })
    await control({ kind: 'pause', paused: true }); await waitForState(page, s => s?.paused, 'pause')
    await control({ kind: 'seek', seconds: 2, relative: false }); await waitForState(page, s => s?.paused && s.position >= 1.8, 'paused seek')
    await control({ kind: 'presentation', value: 'fullscreen' })
    await waitForState(page, s => s?.presentation === 'fullscreen', 'DOM fullscreen')
    await page.keyboard.press('Escape'); await waitForState(page, s => s?.presentation !== 'fullscreen', 'Escape exits fullscreen')
    await control({ kind: 'pause', paused: false })
    // Real delayed consumer while main/native remain responsive. It must fill
    // only the same three export tickets, never allocate an extra export pool.
    const blocked = page.evaluate(() => { const until = performance.now() + 750; while (performance.now() < until) { /* deliberate consumer stall */ } })
    await new Promise(resolve => setTimeout(resolve, 250))
    const busy = await inspect(); assert.ok(busy.outstanding >= 1 && busy.outstanding <= 3); assert.ok(busy.peak <= 3)
    await blocked
    const beforeStop = await inspect()
    await control({ kind: 'stop' }); await waitForState(page, s => s === null, 'stop')
    const stopped = await waitForValue(inspect, s => !s.alive && s.outstanding === 0, 'late references release before reopen', 10000)
    report.checks.push({ iteration, surfaceToken, firstPixels, laterPixels, beforeStop, stopped }); save()
  }
  // The basic video fixture cannot detect compatibility-profile GL failures
  // when mpv first draws ASS glyphs or a PGS bitmap. Verify actual subtitle
  // pixels while remaining on the GPU path, in both presentation modes.
  for (const [name, subtitleTarget] of [['ass', assTarget], ['pgs', pgsTarget]]) {
    assert.equal((await page.evaluate(t => window.api.playback.open(t), subtitleTarget)).ok, true)
    const state = await waitForState(page, s => s?.phase === 'playing' && s.position > .5, `${name} starts on Canvas`)
    surfaceToken = state.sharedTextureSurface
    const sub = state.tracks.find(t => t.type === 'sub'); assert.ok(sub)
    const control = value => page.evaluate(({ id, value }) => window.api.playback.control(id, value), { id: state.sessionId, value })
    await control({ kind: 'pause', paused: true })
    const frames = []
    for (const presentation of ['expanded', 'fullscreen']) {
      await control({ kind: 'presentation', value: presentation })
      await waitForState(page, s => s?.presentation === presentation && s.paused, `${name} ${presentation}`)
      await page.waitForTimeout(250)
      await control({ kind: 'track', type: 'sub', id: null })
      await waitForState(page, s => !s.tracks.some(t => t.type === 'sub' && t.selected), 'subtitle disabled')
      await control({ kind: 'seek', seconds: 2 })
      await waitForState(page, s => !s.seeking && Math.abs(s.position - 2) < .15, 'subtitle-off seek')
      await page.waitForTimeout(250)
      await captureAcceptanceFrame(application, output, `${name}-${presentation}-off`, { baseline: true })
      await control({ kind: 'track', type: 'sub', id: sub.id })
      await waitForState(page, s => s.tracks.some(t => t.type === 'sub' && t.id === sub.id && t.selected), 'subtitle enabled')
      await control({ kind: 'seek', seconds: 2 })
      await waitForState(page, s => !s.seeking && Math.abs(s.position - 2) < .15, 'subtitle-on seek')
      const frame = await waitForValue(() => captureAcceptanceFrame(application, output, `${name}-${presentation}-on`, { compare: true, whiteBounds: true }),
        value => value.differentPixels > 100 && (name !== 'pgs' || value.whitePixels > 100), `${name} actual subtitle pixels`)
      const current = await page.evaluate(() => window.api.playback.snapshot())
      assert.equal(current.info.playbackMode, 'gpu'); assert.equal(current.info.playbackFallback, false)
      assert.equal(current.sessionId, state.sessionId)
      const native = await nativeEvidence(application)
      assert.equal(native.loadedFiles, 1); assert.equal(native.commandErrors, 0)
      frames.push({ presentation, frame, native })
    }
    await control({ kind: 'presentation', value: 'expanded' }); await control({ kind: 'stop' })
    await waitForState(page, s => s === null, 'subtitle stop')
    const stopped = await waitForValue(inspect, s => !s.alive && s.outstanding === 0, 'subtitle references released')
    report.checks.push({ subtitle: name, frames, stopped }); save()
  }
  report.passed = true
} catch (error) { report.error = error.stack ?? String(error); throw error }
finally {
  save()
  await closeAcceptanceAndSave(report, application, closeAcceptance, save)
}
