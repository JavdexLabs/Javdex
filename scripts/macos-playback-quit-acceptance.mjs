// Real macOS app quit while its isolated playback host is actively producing.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { closeAcceptance, createAcceptanceDirectory, launchAcceptance, nativeEvidence, output,
  seedAcceptanceCatalog, waitForState, waitForValue } from './playback-acceptance-support.mjs'
import { prepareNonRecordingPlayback } from './playback-acceptance-settings.mjs'

assert.equal(process.platform, 'darwin', 'this acceptance requires macOS')
const [input, scenario = 'cpu'] = process.argv.slice(2)
assert(input && ['cpu', 'gpu', 'recovery'].includes(scenario), 'Usage: node scripts/macos-playback-quit-acceptance.mjs MEDIA [cpu|gpu|recovery]')
const mode = scenario === 'recovery' ? 'cpu' : scenario
if (scenario === 'recovery') process.env.JAVDEX_PLAYBACK_DIAGNOSTICS = '1'
const directory = createAcceptanceDirectory('macos-quit-')
const [target] = seedAcceptanceCatalog(directory, [path.resolve(input)])
const reportFile = path.join(output, `macos-quit-${scenario}-${randomUUID()}.json`)
const receiptFile = path.join(directory, 'cpu-retired.json')
const report = { passed: false, mode, scenario, platform: `${process.platform}/${process.arch}`,
  scope: 'isolated development application; application quit while playback is active' }
let application
try {
  application = await launchAcceptance(directory, 'macos-quit-application.log', scenario === 'cpu' ? ['--javdex-cpu'] : [])
  const page = await application.firstWindow()
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  await prepareNonRecordingPlayback(page)
  await page.evaluate(value => window.api.thisComputer.update({ playbackRenderMode: value }), scenario === 'recovery' ? 'auto' : mode)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1920, 1200))
  const opened = await page.evaluate(value => window.api.player.openResource(value.libraryId, value.resourceId, value.videoId), target)
  assert.equal(opened.ok, true, opened.error)
  if (scenario === 'recovery') {
    await waitForState(page, value => value?.phase === 'playing' && value.position > 1
      && value.info.playbackMode === 'gpu', 'GPU playback before recovery')
    await application.evaluate(() => {
      process.getBuiltinModule('diagnostics_channel').channel('javdex.playback.host.control').publish({ mode: 'gpu', operation: 'kill' })
    })
  }
  const state = await waitForState(page, value => value?.phase === 'playing' && value.position > 3
    && value.info.playbackMode === mode, 'playback before app quit')
  if (scenario === 'recovery') assert.equal(state.info.playbackFallback, true, 'the same session must recover to CPU')
  if (mode === 'cpu') assert.match(state.sharedTextureSurface, /^cpu:/)
  if (mode === 'cpu') await waitForValue(() => page.evaluate(surface => {
    const video = document.querySelector('video[data-playback-surface]')
    return video instanceof HTMLVideoElement && video.dataset.playbackSurface === surface && video.srcObject !== null
  }, state.sharedTextureSurface), Boolean, 'current CPU video stream is mounted before app quit')
  const native = await waitForValue(() => nativeEvidence(application), value => value.alive && value.renderedFrames > 0,
    'isolated producer before app quit')
  assert.ok(Number.isSafeInteger(native.pid) && native.pid > 0)
  report.before = { mode: state.info.playbackMode, surface: state.sharedTextureSurface,
    width: native.pixelWidth, height: native.pixelHeight, nativeFrames: native.renderedFrames, pid: native.pid }
  if (mode === 'cpu') {
    await application.evaluate(({ BrowserWindow, ipcMain }, { receiptFile, surface }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      ipcMain.on('playback:cpu-shutdown-ready', (event, value) => {
        if (event.sender === contents && event.senderFrame === contents.mainFrame && value?.surfaceToken === surface)
          process.getBuiltinModule('fs').writeFileSync(receiptFile, JSON.stringify({ surface }))
      })
    }, { receiptFile, surface: state.sharedTextureSurface })
  }
  report.cleanup = await closeAcceptance(application)
  application = undefined
  assert.equal(report.cleanup.forced, false, 'app quit must not require a forced kill')
  assert.equal(report.cleanup.code, 0, 'app quit must exit successfully')
  if (mode === 'cpu') {
    assert.ok(fs.existsSync(receiptFile), 'the current CPU surface must acknowledge retirement')
    assert.equal(JSON.parse(fs.readFileSync(receiptFile, 'utf8')).surface, state.sharedTextureSurface)
  }
  await waitForValue(() => {
    try { process.kill(native.pid, 0); return true }
    catch (error) { if (error.code === 'ESRCH') return false; throw error }
  }, alive => !alive, 'isolated playback host exits after app quit', 5000)
  report.passed = true
} catch (error) {
  report.error = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  if (application) report.cleanup = await closeAcceptance(application)
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
}
console.log(JSON.stringify({ report: reportFile, passed: report.passed, mode, scenario, cleanup: report.cleanup, error: report.error }))
