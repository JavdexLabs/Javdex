// Interactive Windows host for real SendInput/UIA checks. The fixture catalog
// and diagnostics are isolated; it exposes no product or network control API.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { captureAcceptanceFrame, closeAcceptance, createAcceptanceDirectory, launchAcceptance, output, seedAcceptanceCatalog, waitForState } from './playback-acceptance-support.mjs'

assert.equal(process.platform, 'win32')
const directory = createAcceptanceDirectory('windows-input-')
const [target] = seedAcceptanceCatalog(directory, [path.join(output, 'synthetic-subtitles.mkv')])
const reportFile = path.join(output, 'windows-input-state.json')
const application = await launchAcceptance(directory, 'windows-input-application.log',
  process.argv.includes('--disable-direct-composition') ? ['--disable-direct-composition'] : [])
let timer
try {
  const page = await application.firstWindow()
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  await page.evaluate(() => window.api.thisComputer.update({ playerPreference: 'builtin' }))
  assert.equal((await page.evaluate(target => window.api.player.play(target.libraryId, target.videoId), target)).ok, true)
  const initial = await waitForState(page, state => state?.phase === 'playing' && state.position > 0.5, 'input fixture startup')
  await page.evaluate(id => window.api.playback.control(id, { kind: 'pause', paused: true }), initial.sessionId)
  await page.evaluate(id => window.api.playback.control(id, { kind: 'seek', seconds: 20 }), initial.sessionId)
  await waitForState(page, state => state?.paused && !state.seeking && Math.abs(state.position - 20) < 0.15, 'input fixture paused frame')
  await captureAcceptanceFrame(application, output, 'windows-input-expanded')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
  const startup = await application.evaluate(({ app }) => ({
    directCompositionDisabled: app.commandLine.hasSwitch('disable-direct-composition'),
    gpu: app.getGPUFeatureStatus()
  }))
  console.log(JSON.stringify({ startup }))
  let observing = false
  const observe = async () => {
    if (observing) return
    observing = true
    try {
      const state = await page.evaluate(async () => {
        const state = await window.api.playback.snapshot()
        return { sessionId: state?.sessionId, presentation: state?.presentation, paused: state?.paused,
          position: state?.position, volume: state?.volume, muted: state?.muted, phase: state?.phase,
          focusedElement: document.activeElement?.getAttribute('aria-label'),
          surface: document.querySelector('[data-playback-session] button[aria-label^="视频画面"]')?.getBoundingClientRect().toJSON() }
      })
      const native = await application.evaluate(({ app, BrowserWindow, screen }) => {
        const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
        const value = require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node').inspect()
        return { alive: value.alive, loadedFiles: value.loadedFiles, focusedControl: value.focusedControl,
          dpi: value.dpi, scale: screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds()).scaleFactor,
          pixelWidth: value.pixelWidth, pixelHeight: value.pixelHeight,
          fullscreenControlsVisible: value.fullscreenControlsVisible, controlsHovered: value.controlsHovered,
          controlsFocused: value.controlsFocused, idleMilliseconds: value.idleMilliseconds }
      })
      fs.writeFileSync(reportFile, JSON.stringify({ platform: 'win32/x64', startup, state, native }, null, 2))
    } catch { /* The real user/window close can race this read-only observation. */ }
    finally { observing = false }
  }
  await observe()
  timer = setInterval(observe, 500)
  console.log(`Windows input fixture ready: ${reportFile}`)
  await application.waitForEvent('close', { timeout: 0 })
} finally {
  clearInterval(timer)
  console.log(JSON.stringify({ cleanup: await closeAcceptance(application) }))
}
