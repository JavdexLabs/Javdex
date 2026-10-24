// Production app/DB/preload/renderer/CPU decoder with an isolated test library.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createAcceptanceDirectory, seedAcceptanceCatalog, launchAcceptance, waitForState, waitForValue, closeAcceptance, output } from './playback-acceptance-support.mjs'
import { prepareNonRecordingPlayback } from './playback-acceptance-settings.mjs'

const media = path.resolve(process.argv[2] ?? 'out/playback-acceptance/synthetic-h264.mp4')
assert.ok(fs.statSync(media).isFile())
const results = []
for (const mode of ['normal', 'software']) {
  const directory = createAcceptanceDirectory('startup-')
  const targets = seedAcceptanceCatalog(directory, [media])
  let application
  try {
    application = await launchAcceptance(directory, `startup-${mode}.log`, mode === 'software' ? ['--javdex-software'] : [])
    const page = await application.firstWindow()
    await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
    await waitForValue(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
      Boolean, 'main window must actually become visible')
    await page.screenshot({ path: path.join(output, `startup-${mode}.png`), timeout: 5000 })
    await prepareNonRecordingPlayback(page)
    const acceleration = await application.evaluate(({ app }) => app.isHardwareAccelerationEnabled())
    assert.equal(acceleration, mode !== 'software')
    if (mode === 'software') {
      const opened = await page.evaluate(t => window.api.player.openResource(t.libraryId, t.resourceId, t.videoId), targets[0])
      assert.equal(opened.ok, true, opened.error)
      const state = await waitForState(page, s => s?.info.playbackMode === 'cpu' && s.position > .3, 'CPU decoder advances in the real application')
      assert.equal(state.info.hardwareDecoder, 'no')
      await page.evaluate(id => window.api.playback.control(id, { kind: 'stop' }), state.sessionId)
      await waitForState(page, s => s === null, 'isolated playback stopped')
    }
    const pid = application.process().pid
    await application.evaluate(({ app }) => app.emit('child-process-gone', {}, { type: 'GPU', reason: 'launch-failed', exitCode: 17 }))
    await page.waitForTimeout(200)
    assert.equal(application.process().pid, pid, 'healthy application must not relaunch on runtime graphics events')
    const cleanup = await closeAcceptance(application)
    application = null
    assert.equal(cleanup.forced, false); assert.equal(cleanup.code, 0)
    const log = fs.readFileSync(path.join(directory, 'logs/startup.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(log.filter(v => v.code === 'WINDOW_READY').length, 1)
    assert.equal(log.some(v => v.code === 'SOFTWARE_RELAUNCH'), false)
    results.push({ mode, acceleration, directory, cleanup, passed: true })
  } finally { if (application) await closeAcceptance(application) }
}
fs.writeFileSync(path.join(output, 'startup-app.json'), JSON.stringify({ platform: process.platform, results }, null, 2) + '\n')
console.log(JSON.stringify(results))
