// Hard-exit recovery uses only this runner's isolated process tree/catalog.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { acceptanceProcess, closeAcceptance, createAcceptanceDirectory, launchAcceptance, nativeEvidence, output, seedAcceptanceCatalog, waitForState, waitForValue } from './playback-acceptance-support.mjs'

assert.equal(process.platform, 'win32')
const directory = createAcceptanceDirectory('windows-restart-')
const reportFile = path.join(output, 'windows-restart-report.json')
const report = { status: 'running', platform: 'win32/x64', directory, intentionalHardExit: true }
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
let application
try {
  const [target] = seedAcceptanceCatalog(directory, [path.join(output, 'synthetic-subtitles.mkv')])
  application = await launchAcceptance(directory, 'windows-restart-application.log')
  let page = await application.firstWindow()
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  await page.evaluate(() => window.api.thisComputer.update({ playerPreference: 'builtin' }))
  assert.equal((await page.evaluate(target => window.api.player.play(target.libraryId, target.videoId), target)).ok, true)
  report.beforeExit = await waitForState(page, state => state?.phase === 'playing' && state.position > 1, 'play before hard exit')
  report.nativeBeforeExit = await nativeEvidence(application)
  const owned = acceptanceProcess(application)
  assert.equal(owned.exitCode, null)
  const killed = spawnSync('taskkill', ['/PID', String(owned.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
  assert.equal(killed.status, 0, killed.stderr)
  await waitForValue(() => owned.exitCode, value => value !== null, 'owned hard-exit process')
  report.hardExitCode = owned.exitCode
  // This is intentional termination, not a graceful-close acceptance result.
  await application.close().catch(() => {})
  application = undefined
  application = await launchAcceptance(directory, 'windows-restart-application.log')
  page = await application.firstWindow()
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  assert.equal(await page.evaluate(() => window.api.playback.snapshot()), null)
  assert.equal((await nativeEvidence(application)).alive, false)
  assert.equal((await page.evaluate(target => window.api.player.play(target.libraryId, target.videoId), target)).ok, true)
  report.afterRestart = await waitForState(page, state => state?.phase === 'playing' && state.position > 1, 'play after hard exit')
  report.nativeAfterRestart = await nativeEvidence(application)
  assert.notEqual(report.afterRestart.sessionId, report.beforeExit.sessionId)
  assert.equal(report.nativeAfterRestart.loadedFiles, 1)
  assert.equal(report.nativeAfterRestart.commandErrors, 0)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  if (application) {
    report.cleanup = await closeAcceptance(application)
    if (report.cleanup.forced || report.cleanup.code !== 0) { report.status = 'failed'; process.exitCode = 1 }
  }
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
