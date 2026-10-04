import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { closeAcceptance, recordAcceptanceCleanup, createAcceptanceDirectory, launchAcceptance, nativeEvidence, seedAcceptanceCatalog, waitForState } from './playback-acceptance-support.mjs'
import { prepareMediaFixtures } from './playback-media-fixtures.mjs'
import { checkBitmapSubtitlePixels, checkComplexSubtitlePixels } from './playback-subtitle-checks.mjs'

assert.ok(['darwin', 'win32'].includes(process.platform), 'this runner accepts macOS and Windows only')
const fixtures = prepareMediaFixtures()
const directory = createAcceptanceDirectory('subtitles-')
const bitmapOnly = process.argv.includes('--bitmap-only')
const targets = seedAcceptanceCatalog(directory, bitmapOnly ? [fixtures.media[fixtures.bitmapIndex]]
  : [fixtures.media[fixtures.complexIndex], fixtures.media[fixtures.bitmapIndex]])
const reportFile = path.join(fixtures.directory, 'subtitle-report.json')
const report = { status: 'running', platform: `${process.platform}/${process.arch}`,
  scope: `synthetic ${bitmapOnly ? 'original PGS' : 'complex ASS and original PGS'}, not all subtitles or clean installation`,
  bitmapReference: fixtures.bitmapReference, checks: [] }
let application
try {
  application = await launchAcceptance(directory, 'subtitle-application.log')
  const page = await application.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => window.api?.player && document.querySelector('nav'))
  await page.evaluate(() => window.api.thisComputer.update({ playerPreference: 'builtin' }))
  for (const [index, target] of targets.entries()) {
    const result = await page.evaluate(target => window.api.player.openResource(target.libraryId, target.resourceId, target.videoId), target)
    assert.equal(result.ok, true, result.error)
    await waitForState(page, state => state?.phase === 'playing' && state.position > 0.6, 'subtitle fixture starts')
    report.checks.push(index === 0 && !bitmapOnly ? await checkComplexSubtitlePixels(application, page, fixtures.directory, 'local-complex-ass')
      : await checkBitmapSubtitlePixels(application, page, fixtures.directory, 'local-pgs'))
    await page.getByRole('button', { name: '停止播放', exact: true }).click()
    await waitForState(page, state => state === null, 'subtitle test stop')
    assert.equal((await nativeEvidence(application)).alive, false)
  }
  assert.equal(fs.existsSync(path.join(directory, 'playback-progress.json')), false)
  assert.deepEqual(errors, [])
  report.status = 'partial-pass'
  console.log(JSON.stringify({ report: reportFile, checks: report.checks.map(check => check.name) }))
} catch (error) {
  report.status = 'failed'; report.failure = error.stack ?? String(error)
  throw error
} finally {
  if (application) recordAcceptanceCleanup(report, await closeAcceptance(application))
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
}
