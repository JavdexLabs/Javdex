// Disposable bright synthetic media only. Capture the compositor before any
// Canvas readback so seeking cannot hide blank video frames behind a readback.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createAcceptanceDirectory, seedAcceptanceCatalog, launchAcceptance, closeAcceptance,
  waitForState, output } from './playback-acceptance-support.mjs'

const [media, display = 'wayland', mode = 'gpu'] = process.argv.slice(2)
assert(media && ['wayland', 'x11'].includes(display) && ['gpu', 'cpu'].includes(mode))
const directory = createAcceptanceDirectory('seek-continuity-')
const [target] = seedAcceptanceCatalog(directory, [path.resolve(media)])
fs.writeFileSync(path.join(directory, 'this-computer.json'), JSON.stringify({ mode: 'local', closeToTray: false,
  playbackRenderMode: mode, resumePlayback: false, playbackVolume: 5 }))
const report = { passed: false, display, mode, captures: [], limits: ['Compositor captures, not physical scanout; sampling can miss shorter flashes'] }
let application
try {
  application = await launchAcceptance(directory, 'seek-application.log', [`--javdex-${display}`,
    ...(!process.env.JAVDEX_PLAYBACK_ACCEPTANCE_EXECUTABLE ? ['--no-sandbox'] : [])])
  const page = await application.firstWindow()
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  await application.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]; w.setAlwaysOnTop(true); w.show(); w.focus()
  })
  assert.equal((await page.evaluate(t => window.api.player.openResource(t.libraryId, t.resourceId, t.videoId), target)).ok, true)
  const state = await waitForState(page, s => s?.phase === 'playing' && s.position > 1 && s.info.playbackMode === mode, 'seek test playing')
  const control = value => page.evaluate(({ id, value }) => window.api.playback.control(id, value), { id: state.sessionId, value })
  const capture = async phase => {
    const item = await application.evaluate(async ({ BrowserWindow }, { output, index }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const rect = await w.webContents.executeJavaScript(`(() => { const v=document.querySelector('[data-playback-surface]'), r=v.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,viewport:innerWidth,ready:v.readyState}; })()`)
      const image = await w.webContents.capturePage(), scale = image.getSize().width / rect.viewport
      const crop = image.crop({ x: Math.round((rect.x + rect.width * .1) * scale), y: Math.round((rect.y + rect.height * .1) * scale),
        width: Math.round(rect.width * .8 * scale), height: Math.round(rect.height * .8 * scale) })
      const data = crop.toBitmap(); let lit = 0, sampled = 0
      for (let n = 0; n < data.length; n += 64) { sampled++; if (Math.max(data[n], data[n+1], data[n+2]) > 30) lit++ }
      const fraction = lit / sampled
      if (fraction < .1 || index === 0) process.getBuiltinModule('fs').writeFileSync(process.getBuiltinModule('path').join(output, `frame-${index}.png`), crop.toPNG())
      return { fraction, ready: rect.ready }
    }, { output, index: report.captures.length })
    report.captures.push({ phase, ...item })
  }
  await capture('initial')
  // Seek while both playing and paused. Send the next seek without waiting for
  // the previous seek's replacement frame, as with a held navigation key.
  for (const paused of [false, true]) {
    await control({ kind: 'pause', paused })
    for (let n = 0; n < 20; n++) {
      await control({ kind: 'seek', seconds: 2 + (n % 10) * 2 })
      for (let sample = 0; sample < 3; sample++) {
        await capture(paused ? 'paused-seek' : 'playing-seek')
        await page.waitForTimeout(20)
      }
    }
  }
  await control({ kind: 'pause', paused: false })
  await waitForState(page, s => s?.phase === 'playing' && s.position > 20.2 && s.info.playbackMode === mode, 'resume after repeated seeking')
  await capture('resumed')
  await control({ kind: 'stop' })
  await waitForState(page, s => s === null, 'stop after seek captures')
  report.blankFrames = report.captures.filter(c => c.fraction < .1).length
  assert.equal(report.blankFrames, 0, 'Seeking exposed blank compositor frames')
  report.passed = true
} catch (error) { report.error = error.stack; process.exitCode = 1 }
finally {
  if (application) report.cleanup = await closeAcceptance(application)
  if (report.cleanup?.forced || report.cleanup?.code !== 0) { report.passed = false; process.exitCode = 1 }
  fs.writeFileSync(path.join(output, 'seek.json'), JSON.stringify(report, null, 2))
}
console.log(JSON.stringify({ passed: report.passed, blankFrames: report.blankFrames, captures: report.captures.length, error: report.error }))
