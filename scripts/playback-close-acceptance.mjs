// Normal accepted window close, not fault injection. macOS keeps the process
// alive after its last window closes, so inspect the native owner before quit.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { acceptanceProcess, closeAcceptance, recordAcceptanceCleanup, createAcceptanceDirectory, launchAcceptance, nativeEvidence, output, seedAcceptanceCatalog, waitForState, waitForValue } from './playback-acceptance-support.mjs'
import { prepareMediaFixtures } from './playback-media-fixtures.mjs'

assert.ok(['darwin', 'win32'].includes(process.platform), 'this acceptance runner covers macOS and Windows only')
const fixture = prepareMediaFixtures()
const directory = createAcceptanceDirectory('close-')
const [target] = seedAcceptanceCatalog(directory, [fixture.media[0]])
const report = { status: 'running', platform: `${process.platform}/${process.arch}`, checks: [],
  pending: ['abnormal process termination and clean installed runtime acceptance'] }
const reportFile = path.join(output, 'close-report.json')
let application
try {
  application = await launchAcceptance(directory, 'close-application.log')
  const page = await application.firstWindow()
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  assert.equal((await page.evaluate(() => window.api.thisComputer.get())).closeToTray, false)
  await page.evaluate(() => window.api.thisComputer.update({ playerPreference: 'builtin' }))
  const result = await page.evaluate(target => window.api.player.openResource(target.libraryId, target.resourceId, target.videoId), target)
  assert.equal(result.ok, true, result.error)
  await waitForState(page, state => state?.phase === 'playing' && state.position > 0.5, 'play before normal close')
  report.before = await nativeEvidence(application)
  assert.equal(report.before.alive, true)
  assert.ok(report.before.presentedFrames > 0)
  if (process.platform === 'win32') {
    // Windows quits on last-window close. Persist observations while the main
    // inspector is still alive instead of keeping the process open artificially.
    const traceFile = path.join(output, 'windows-close-trace.json')
    await application.evaluate(({ app, BrowserWindow }, traceFile) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
      const bridge = require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node')
      const window = BrowserWindow.getAllWindows()[0]
      const trace = { events: [] }
      const save = () => require('node:fs').writeFileSync(traceFile, JSON.stringify(trace, null, 2))
      window.once('close', event => { trace.atClose = { prevented: event.defaultPrevented,
        parentDestroyed: window.isDestroyed(), nativeAlive: bridge.inspect().alive }; save() })
      window.once('closed', () => { trace.events.push({ kind: 'original-closed', nativeAlive: bridge.inspect().alive }); save() })
      app.once('will-quit', () => { trace.atQuit = { remainingWindows: BrowserWindow.getAllWindows().length,
        nativeAlive: bridge.inspect().alive }; save() })
      window.close()
    }, traceFile).catch(error => {
      if (!fs.existsSync(traceFile)) throw error
    })
    await waitForValue(() => acceptanceProcess(application).exitCode, value => value !== null, 'normal last-window close exits Windows application')
    report.closeTrace = JSON.parse(fs.readFileSync(traceFile, 'utf8'))
    assert.equal(report.closeTrace.atClose.prevented, false)
    assert.equal(report.closeTrace.atClose.parentDestroyed, false)
    assert.equal(report.closeTrace.atClose.nativeAlive, true)
    assert.ok(report.closeTrace.events.some(event => event.kind === 'original-closed'))
    assert.deepEqual(report.closeTrace.atQuit, { remainingWindows: 0, nativeAlive: false })
    report.checks.push('accepted close destroys Windows parent during active playback', 'native core released before normal process exit')
  } else {
  report.atClose = await application.evaluate(({ app, BrowserWindow }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const bridge = require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node')
    const window = BrowserWindow.getAllWindows()[0]
    let observed
    globalThis.playbackCloseTrace = { originalId: window.id, events: [] }
    const trace = globalThis.playbackCloseTrace.events
    window.once('closed', () => trace.push({ kind: 'original-closed' }))
    window.webContents.once('will-prevent-unload', () => trace.push({ kind: 'renderer-veto' }))
    app.on('activate', () => trace.push({ kind: 'activate' }))
    app.on('browser-window-created', (_, created) => trace.push({ kind: 'created', id: created.id }))
    // Registered after product listeners. Capture the accepted close; release
    // belongs to `closed`, not a close that may still be vetoed by beforeunload.
    window.once('close', event => { observed = { prevented: event.defaultPrevented, parentDestroyed: window.isDestroyed(), nativeAlive: bridge.inspect().alive } })
    window.close()
    return observed
  })
  assert.equal(report.atClose.prevented, false)
  assert.equal(report.atClose.parentDestroyed, false)
  await waitForValue(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), value => value === 0, 'normal close destroys main window', 3000)
  assert.equal((await nativeEvidence(application)).alive, false)
  report.checks.push('accepted close actually destroys main window during active playback', 'last-window close releases native playback before process quit')
  report.closeTrace = await application.evaluate(() => globalThis.playbackCloseTrace)
  }
  report.status = 'partial-pass'
} catch (error) {
  report.status = 'failed'; report.error = error.message
  if (application) report.closeTrace = await application.evaluate(({ BrowserWindow }) => ({ ...globalThis.playbackCloseTrace,
    remaining: BrowserWindow.getAllWindows().map(window => ({ id: window.id, title: window.getTitle(), visible: window.isVisible() })) })).catch(() => null)
  throw error
} finally {
  if (application) recordAcceptanceCleanup(report, await closeAcceptance(application))
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
}
assert.equal(report.cleanup.forced, false, 'application must quit normally')
assert.equal(report.cleanup.code, 0)
console.log(JSON.stringify({ report: reportFile, checks: report.checks, cleanup: report.cleanup }))
