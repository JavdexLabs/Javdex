// Local opt-in acceptance only. Never opens the user's profile or private media.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createAcceptanceDirectory, seedAcceptanceCatalog, launchAcceptance, closeAcceptance, waitForState, waitForValue } from './playback-acceptance-support.mjs'
import { prepareNonRecordingPlayback } from './playback-acceptance-settings.mjs'

assert.equal(process.platform, 'darwin')
const shared = !process.argv.includes('--baseline')
const color = process.argv.includes('--color')
const stress = process.argv.includes('--stress')
const crash = process.argv.includes('--crash')
const benchmark = process.argv.includes('--benchmark')
const files = process.argv.slice(2).filter(arg => !['--baseline', '--color', '--stress', '--crash', '--benchmark'].includes(arg)).map(file => path.resolve(file))
assert.ok(files.length, 'supply synthetic media paths')
assert.ok(files.every(file => path.dirname(file) === path.dirname(files[0])), 'synthetic fixtures must share one isolated library root')
const directory = createAcceptanceDirectory(shared ? 'mac-shared-' : 'mac-baseline-')
const targets = seedAcceptanceCatalog(directory, files)
const report = { shared, color, directory, files: files.map(file => path.basename(file)), checks: [], samples: [], pending: [
  'physical scanout, screen-reader speech, listening/lip-sync, multi-display moves and energy/power',
  'HDR/wide gamut/colorimetric acceptance and packaged runtime/signing'
] }
const save = () => fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
save(); console.log(directory)
let application
try {
  application = await launchAcceptance(directory, shared ? 'mac-shared-application.log' : 'mac-baseline-application.log', shared ? ['--javdex-mac-shared-texture'] : [])
  const page = await application.firstWindow()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  await prepareNonRecordingPlayback(page)
  if (shared) await application.evaluate(({ ipcMain }) => {
    globalThis.macAcceptanceReceipts = { count: 0, recent: [], released: [] }
    ipcMain.on('playback:mac-texture-released', (_event, data) => {
      const stats = globalThis.macAcceptanceReceipts
      stats.released.push(data.sequence); if (stats.released.length > 120) stats.released.shift()
    })
    ipcMain.on('playback:shared-texture-submitted', (_event, data) => {
      const stats = globalThis.macAcceptanceReceipts; stats.count++
      stats.recent.push({ sequence: data.sequence, timeline: data.timeline, readyTime: data.readyTime, submittedTime: data.submittedTime })
      if (stats.recent.length > 120) stats.recent.shift()
    })
  })
  const inspect = () => application.evaluate(({ app }, shared) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const state = require(app.getAppPath() + '/out/native-playback/' + (shared ? 'playback-shared.node' : 'playback.node')).inspect()
    return { alive: state.alive, outstanding: state.outstandingSurfaces, outstandingSequences: state.outstandingSurfaceSequences,
      width: state.pixelWidth, height: state.pixelHeight,
      observedAt: Number(process.hrtime.bigint()) / 1e6,
      position: state['time-pos'], audioPosition: state['audio-pts'], hwdec: state['hwdec-current'], presented: state.presentedFrames,
      nativeFrames: state.nativeFrames, loadedFiles: state.loadedFiles, droppedFrames: state['frame-drop-count'], commandErrors: state.commandErrors,
      ...(shared ? { receipts: globalThis.macAcceptanceReceipts } : {}),
      processMetrics: app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type, cpu: p.cpu, memory: p.memory })) }
  }, shared)
  const capture = async name => {
    // This is the composed Chromium window, not libmpv's private FBO capture.
    await page.screenshot({ path: path.join(directory, name + '.png') })
  }
  const control = (id, value) => page.evaluate(({ id, value }) => window.api.playback.control(id, value), { id, value })
  const iterations = stress ? Array.from({ length: 5 }, () => targets[0]) : targets
  for (const [index, target] of iterations.entries()) {
    const opened = await page.evaluate(t => window.api.player.openResource(t.libraryId, t.resourceId, t.videoId), target)
    assert.equal(opened.ok, true, opened.error)
    const state = await waitForState(page, s => s?.phase === 'playing' && s.position > 1, 'real playback')
    assert.equal(Boolean(state.sharedTextureSurface), shared)
    if (shared) await page.locator('canvas[data-playback-surface]').waitFor()
    const id = state.sessionId
    if (crash) {
      assert.ok(shared)
      const busy = page.evaluate(() => { const until = performance.now() + 1500; while (performance.now() < until) { /* crash in-flight imports */ } }).catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 100))
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
      await busy; await new Promise(resolve => setTimeout(resolve, 1200))
      const after = await inspect()
      assert.equal(after.alive, false); assert.ok(after.outstanding <= 3)
      report.checks.push({ name: 'renderer crash stops producer; unacknowledged leases remain quarantined until exit', native: after })
      break
    }
    if (stress) {
      await page.evaluate(() => { const until = performance.now() + 1500; while (performance.now() < until) { /* real slow consumer */ } })
      await page.waitForTimeout(500)
      const sample = await inspect()
      report.samples.push({ index, n: -1, ...sample, snapshot: await page.evaluate(() => window.api.playback.snapshot()) }); save()
      assert.ok(sample.outstanding <= 3); assert.equal(sample.commandErrors, 0)
    }
    if (color) {
      await control(id, { kind: 'pause', paused: true }); await waitForState(page, s => s?.paused, 'color pause')
      await page.waitForTimeout(300)
      const pixels = await application.evaluate(async ({ app, BrowserWindow }, { shared, directory, index }) => {
        const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
        let data, width, height
        if (shared) {
          const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage()
          require('node:fs').writeFileSync(require('node:path').join(directory, 'color-window-' + index + '.png'), image.toPNG())
          data = image.toBitmap(); ({ width, height } = image.getSize())
          // DOM bounds are converted to the captured window's backing pixels.
          const rect = await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`(() => {
            const r = document.querySelector('canvas[data-playback-surface]').getBoundingClientRect();
            return {x:r.x,y:r.y,width:r.width,height:r.height,windowWidth:innerWidth}
          })()`)
          const scale = width / rect.windowWidth
          return { width, height, samples: sample(data, width, rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale) }
        }
        const frame = require(app.getAppPath() + '/out/native-playback/playback.node').capture()
        data = frame.data; width = frame.width; height = frame.height
        return { width, height, samples: sample(data, width, 0, 0, width, height) }
        function sample(bytes, stride, x, y, w, h) {
          const vw = Math.min(w, h * 16 / 9), vh = Math.min(h, w * 9 / 16)
          x += (w - vw) / 2; y += (h - vh) / 2
          return [.25, .75].map(fy => Array.from({ length: 8 }, (_, i) => {
            const offset = (Math.floor(y + vh * fy) * stride + Math.floor(x + vw * (i + .5) / 8)) * 4
            const [b, g, r, a] = bytes.subarray(offset, offset + 4); return [r, g, b, a]
          }))
        }
      }, { shared, directory, index })
      const [gray, colors] = pixels.samples
      assert.ok(pixels.samples.flat().every(pixel => pixel[3] === 255), 'opaque output')
      assert.ok(gray.every((rgb, i) => i === 0 || rgb[0] >= gray[i - 1][0]), 'monotonic neutral ramp')
      assert.ok(gray.every(rgb => Math.max(...rgb.slice(0, 3)) - Math.min(...rgb.slice(0, 3)) <= 3), 'neutral remains neutral')
      if (shared && path.basename(files[index]).startsWith('sdr-')) {
        // libmpv's display-referred BT.709 uses BT.1886 (gamma 2.4), mapped
        // explicitly to the sRGB Canvas. This is not HDR passthrough.
        const srgb = v => 255 * (v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055)
        const expected = [0, .02, .08, .22, .5, .75, .94, 1].map(v => srgb(v ** 2.4))
        assert.ok(gray.every((rgb, i) => rgb.slice(0, 3).every(v => Math.abs(v - expected[i]) <= 3)), JSON.stringify(gray))
        for (const [i, rgb] of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [0, 255, 255], [255, 0, 255], [255, 255, 0]].entries())
          assert.ok(rgb.every((v, c) => Math.abs(v - colors[i][c]) <= 3), 'SDR primaries not swapped')
      } else if (shared) {
        assert.ok(gray[0][0] <= 3 && gray[7][0] >= 250 && gray[6][0] > gray[5][0] + 20, 'HDR mapped to SDR with highlight separation')
      }
      report.checks.push({ name: 'synthetic color patches', file: path.basename(files[index]), pixels }); save()
      await control(id, { kind: 'stop' }); await waitForState(page, s => s === null, 'color stop')
      continue
    }
    await capture('playing-' + index)
    const before = await inspect(); report.samples.push({ index, n: -1, ...(await inspect()) }); save()
    for (let n = 0; n < 8; n++) { await page.waitForTimeout(1000); report.samples.push({ index, n, ...(await inspect()) }); save() }
    assert.ok((await inspect()).position > before.position + 3, 'media clock advances')
    if (benchmark) {
      report.checks.push({ name: 'eight-second steady playback sample', index, state, native: await inspect() })
      await control(id, { kind: 'stop' }); await waitForState(page, s => s === null, 'benchmark stop')
      if (shared) await waitForValue(inspect, s => s.outstanding === 0 && !s.alive, 'benchmark release')
      continue
    }
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    const paused = await waitForState(page, s => s?.paused, 'pause')
    await page.waitForTimeout(300)
    assert.ok(Math.abs((await page.evaluate(() => window.api.playback.snapshot())).position - paused.position) < .15)
    if (shared && state.tracks.filter(t => t.type === 'audio').length > 1) {
      for (const track of state.tracks.filter(t => t.type === 'audio')) {
        await control(id, { kind: 'track', type: 'audio', id: track.id })
        await waitForState(page, s => s.tracks.some(t => t.type === 'audio' && t.id === track.id && t.selected)
          && s.info.audioOutput === 'coreaudio' && s.paused, 'audio selection preserves pause')
      }
      for (const selection of [null, state.tracks.find(t => t.type === 'sub')?.id]) {
        if (selection === undefined) continue
        await control(id, { kind: 'track', type: 'sub', id: selection })
        await waitForState(page, s => selection === null ? !s.tracks.some(t => t.type === 'sub' && t.selected)
          : s.tracks.some(t => t.type === 'sub' && t.id === selection && t.selected), 'subtitle selection')
        await page.waitForTimeout(300); await capture(selection === null ? 'subtitles-off' : 'subtitles-on')
      }
      assert.equal((await inspect()).loadedFiles, 1, 'track changes do not reopen media')
      report.checks.push({ name: 'AAC/AC3/EAC3/DTS CoreAudio selection, ASS off/on, same session', tracks: state.tracks })
    }
    for (const seconds of [5, 12, 3]) {
      await control(id, { kind: 'seek', seconds })
      await waitForState(page, s => s?.paused && !s.seeking && Math.abs(s.position - seconds) < .2, 'paused seek')
    }
    await capture('paused-seek-' + index)
    await control(id, { kind: 'presentation', value: 'fullscreen' })
    await waitForState(page, s => s?.presentation === 'fullscreen' && s.paused, 'fullscreen preserves pause')
    await page.waitForTimeout(800); await page.mouse.move(500, 600)
    await capture('fullscreen-' + index)
    if (shared) {
      await page.mouse.move(100, await page.evaluate(() => innerHeight - 10))
      const seek = page.getByRole('slider', { name: '播放进度', exact: true })
      await seek.focus(); await page.keyboard.press('ArrowRight')
      await waitForState(page, s => s.paused && !s.seeking && Math.abs(s.position - 8) < .2, 'focused slider uses 5-second step')
      await page.keyboard.press('Tab')
      assert.ok(await page.evaluate(() => Boolean(document.activeElement?.closest('[aria-label="内置播放器"]'))), 'Tab stays in player')
      report.checks.push({ name: 'fullscreen DOM controls and keyboard focus', aria: await page.getByRole('dialog', { name: '内置播放器' }).ariaSnapshot() })
      await control(id, { kind: 'seek', seconds: 3 })
      await waitForState(page, s => s.paused && !s.seeking && Math.abs(s.position - 3) < .2, 'reset keyboard test seek')
    }
    await page.keyboard.press('Escape')
    await waitForState(page, s => s?.presentation === 'expanded', 'escape exits fullscreen')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 720))
    if (shared) {
      const geometry = await page.locator('canvas[data-playback-surface]').evaluate(c => ({ w: c.width, h: c.height, css: c.getBoundingClientRect().toJSON(), dpr: devicePixelRatio }))
      report.checks.push({ name: 'Retina canvas', geometry }); save()
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.25))
      await page.waitForTimeout(500)
      const zoom = await page.locator('canvas[data-playback-surface]').evaluate(c => ({ w: c.width, h: c.height, css: c.getBoundingClientRect().toJSON(), dpr: devicePixelRatio }))
      assert.ok(Math.abs(zoom.w - zoom.css.width * zoom.dpr) <= 2)
      report.checks.push({ name: 'zoom 125%', geometry: zoom })
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
    }
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide())
    await page.waitForTimeout(250)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: '播放', exact: true }).click()
    await waitForState(page, s => !s.paused && s.position > 3.4, 'resume after hide')
    await capture('restored-' + index)
    report.checks.push({ name: 'play/pause/seek/fullscreen/escape/resize/hide/restore', index, state, native: await inspect() }); save()
    await control(id, { kind: 'stop' }); await waitForState(page, s => s === null, 'stop')
    if (shared) await waitForValue(inspect, s => s.outstanding === 0 && !s.alive, 'consumer references released', 10000)
  }
  report.displays = await application.evaluate(({ screen }) => screen.getAllDisplays().map(d => ({ id: d.id, scaleFactor: d.scaleFactor, bounds: d.bounds })))
  report.pageErrors = errors; assert.deepEqual(errors, [])
  report.passed = true
} catch (error) { report.error = error.stack; throw error }
finally { if (application) report.cleanup = await closeAcceptance(application); save() }
