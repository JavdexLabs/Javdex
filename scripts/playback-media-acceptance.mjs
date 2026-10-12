import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { captureAcceptanceFrame, closeAcceptance, recordAcceptanceCleanup, createAcceptanceDirectory, launchAcceptance, nativeEvidence, seedAcceptanceCatalog, waitForState, waitForValue } from './playback-acceptance-support.mjs'
import { prepareMediaFixtures } from './playback-media-fixtures.mjs'
import { checkBitmapSubtitlePixels, checkComplexSubtitlePixels } from './playback-subtitle-checks.mjs'

assert.ok(['darwin', 'win32'].includes(process.platform), 'this runner accepts macOS and Windows only')
const fixtures = prepareMediaFixtures()
const directory = createAcceptanceDirectory('media-')
const targets = seedAcceptanceCatalog(directory, fixtures.media)
const report = { status: 'running', platform: `${process.platform}/${process.arch}`, ffmpeg: fixtures.version, checks: [], evidence: {}, pending: [
  'human audio listening, channel mapping, pitch and lip-sync', 'real-film subtitles, further bitmap formats and real long movies',
  'screen-reader speech, physical navigation gestures and multi-display DPI', 'relocatable runtime, clean packages and other-platform acceptance'
] }
const reportFile = path.join(fixtures.directory, 'report.json')
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
let application
let keepOpen = false
const errors = []

const frame = (name, options) => captureAcceptanceFrame(application, fixtures.directory, name, options)

try {
  application = await launchAcceptance(directory, 'media-application.log')
  const page = await application.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  await page.evaluate(() => window.api.thisComputer.update({ playerPreference: 'builtin' }))
  const open = async (index, codec) => {
    const result = await page.evaluate(target => window.api.player.openResource(target.libraryId, target.resourceId, target.videoId), targets[index])
    assert.equal(result.ok, true, result.error)
    const state = await waitForState(page, state => state?.phase === 'playing' && state.position > 0.6
      && state.info.videoCodec?.includes(codec), `fixture ${index} did not play`)
    const native = await nativeEvidence(application)
    assert.equal(native.loadedFiles, 1)
    assert.ok(native.presentedFrames > 0)
    assert.equal(state.recordingProgress, false)
    return state
  }
  const select = async (label, option) => {
    await page.getByRole('button', { name: label, exact: true }).click()
    await page.getByRole('option', { name: option }).click()
  }
  const stop = async () => {
    await page.getByRole('button', { name: '停止播放', exact: true }).click()
    await waitForState(page, state => state === null, 'stop and release')
    assert.equal((await nativeEvidence(application)).alive, false)
  }

  const multi = await open(0, 'H.264')
  report.evidence.multi = multi
  report.evidence.native = await nativeEvidence(application)
  save()
  const audio = multi.tracks.filter(track => track.type === 'audio')
  assert.deepEqual(audio.map(track => [track.title, track.language, track.codec]),
    [['Main', 'eng', 'aac'], ['Dub', 'jpn', 'ac3'], ['Commentary', 'fra', 'eac3'], ['Alternate', 'deu', 'dts']])
  assert.deepEqual(multi.chapters.map(chapter => [chapter.title, chapter.time]), [['Opening', 0], ['Middle', 12], ['Ending', 24]])
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  await page.getByRole('button', { name: '音轨', exact: true }).click()
  report.evidence.audioLabels = await page.getByRole('option').allTextContents()
  save()
  // A title must not conceal available language and channel hints.
  assert.match(report.evidence.audioLabels.find(label => label.startsWith('Main')) ?? '', /eng.*2 声道/)
  assert.match(report.evidence.audioLabels.find(label => label.startsWith('Dub')) ?? '', /jpn.*6 声道/)
  await page.getByRole('option', { name: /^Main/ }).click()
  const decodedCodec = { aac: /AAC/, ac3: /AC-3/, eac3: /E-AC-3/, dts: /DTS/ }
  for (const track of audio) {
    await select('音轨', new RegExp(`^${track.title}`))
    await waitForState(page, state => state?.tracks.some(item => item.type === 'audio' && item.id === track.id && item.selected)
      && state.info.audioOutput === (process.platform === 'win32' ? 'wasapi' : 'coreaudio') && decodedCodec[track.codec].test(state.info.audioCodec ?? ''), `switch ${track.codec}`)
    const before = await waitForValue(() => nativeEvidence(application), value => Number.isFinite(value.audioPosition), `${track.codec} audio clock missing`)
    const after = await waitForValue(() => nativeEvidence(application), value => value.audioPosition > before.audioPosition + 0.4
      && value.presentedFrames > before.presentedFrames, `${track.codec} clock/frames did not advance`)
    assert.equal(after.commandErrors, 0)
    assert.equal(after.loadedFiles, 1)
    assert.equal((await page.evaluate(() => window.api.playback.snapshot())).sessionId, multi.sessionId)
    report.checks.push({ name: `audio ${track.codec}`, decoder: (await page.evaluate(() => window.api.playback.snapshot())).info.audioCodec,
      channelHint: fixtures.files['multi-audio-ass-chapters.mkv'].probe.streams
      .filter(stream => stream.codec_type === 'audio')[audio.indexOf(track)].channels, before, after, humanListening: 'pending' })
  }
  await select('音轨', '关闭音轨')
  await waitForState(page, state => !state.tracks.some(track => track.type === 'audio' && track.selected), 'explicit audio off')
  assert.equal((await page.evaluate(() => window.api.playback.snapshot())).muted, false, 'audio off is not mute')
  await select('音轨', /^Main/)
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await waitForState(page, state => state.paused, 'pause before ASS and chapters')
  await select('章节', 'Ending')
  const chapter = await waitForState(page, state => state.paused && !state.seeking && Math.abs(state.position - 24) < 0.15, 'paused chapter selection')
  assert.equal(chapter.sessionId, multi.sessionId)
  assert.equal((await nativeEvidence(application)).loadedFiles, 1)
  report.checks.push({ name: 'chapter UI selection preserves pause', position: chapter.position })
  assert.equal(await page.getByRole('button', { name: '字幕字号', exact: true }).isDisabled(), true, 'ASS style is not overwritten by plaintext size')
  await select('字幕', '关闭字幕')
  await page.evaluate(id => window.api.playback.control(id, { kind: 'seek', seconds: 4 }), multi.sessionId)
  await waitForState(page, state => state.paused && !state.seeking && Math.abs(state.position - 4) < 0.15, 'ASS baseline seek')
  await page.waitForTimeout(300)
  await frame('ass-off', { baseline: true })
  await select('字幕', /^Styled/)
  await waitForState(page, state => state.tracks.some(track => track.codec === 'ass' && track.selected), 'ASS selected')
  await page.evaluate(id => window.api.playback.control(id, { kind: 'seek', seconds: 4 }), multi.sessionId)
  await page.waitForTimeout(300)
  const assFrame = await frame('ass-on', { compare: true })
  assert.ok(assFrame.differentPixels > 200, 'ASS must render actual styled pixels, not only a selected track')
  await page.getByRole('button', { name: '延后 0.5 秒', exact: true }).click()
  await waitForState(page, state => state.subtitleDelay === 0.5 && state.paused, 'ASS delay')
  await page.getByRole('button', { name: '重置延迟', exact: true }).click()
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await waitForState(page, state => state.presentation === 'fullscreen' && state.paused, 'ASS fullscreen')
  await page.waitForTimeout(1500)
  // An options pane changes geometry, so take a fresh baseline in native fullscreen.
  const sid = multi.tracks.find(track => track.codec === 'ass').id
  await page.evaluate(id => window.api.playback.control(id, { kind: 'track', type: 'sub', id: null }), multi.sessionId)
  await waitForState(page, state => !state.tracks.some(track => track.type === 'sub' && track.selected), 'fullscreen ASS off')
  await page.waitForTimeout(300)
  await frame('ass-fullscreen-off', { baseline: true })
  await page.evaluate(({ id, sid }) => window.api.playback.control(id, { kind: 'track', type: 'sub', id: sid }), { id: multi.sessionId, sid })
  await waitForState(page, state => state.tracks.some(track => track.type === 'sub' && track.selected), 'fullscreen ASS on')
  await page.waitForTimeout(300)
  const assFullscreen = await frame('ass-fullscreen-on', { compare: true })
  assert.ok(assFullscreen.differentPixels > 200)
  assert.ok(Number.isFinite(assFullscreen.controlsTop))
  assert.ok(assFullscreen.bottom < assFullscreen.controlsTop, 'ASS cannot overlap native fullscreen controls')
  report.checks.push({ name: 'ASS styled pixels, disabled size, delay and fullscreen clearance', expanded: assFrame, fullscreen: assFullscreen })
  await page.evaluate(id => window.api.playback.control(id, { kind: 'presentation', value: 'expanded' }), multi.sessionId)
  await page.waitForTimeout(1500)
  await stop()

  const hevc = await open(1, 'HEVC')
  if (process.platform === 'darwin') assert.equal(hevc.info.hardwareDecoder, 'videotoolbox', 'Main10 hardware decode must be observed, not inferred from hwdec=auto')
  assert.deepEqual([hevc.info.width, hevc.info.height], [640, 360])
  const hevcFrame = await frame('hevc-main10')
  assert.ok(hevcFrame.visiblePixels > hevcFrame.width * hevcFrame.height * 0.2)
  report.checks.push({ name: 'HEVC Main10 SDR', state: hevc, frame: hevcFrame, HDR: 'not tested' })
  await page.getByRole('button', { name: '收起到底栏', exact: true }).click()
  const dock = await waitForState(page, state => state.presentation === 'docked', 'HEVC dock')
  const dockFrame = await frame('hevc-docked-before')
  await waitForState(page, state => state.position > dock.position + 0.6, 'HEVC live mini-video clock')
  const nextDockFrame = await frame('hevc-docked-after')
  assert.notEqual(nextDockFrame.sha256, dockFrame.sha256, 'dock must render live video')
  assert.equal((await nativeEvidence(application)).loadedFiles, 1)
  await page.getByRole('button', { name: '恢复展开', exact: true }).click()
  await stop()

  const silent = await open(2, 'H.264')
  assert.equal(silent.tracks.filter(track => track.type === 'audio').length, 0)
  assert.equal(silent.info.audioCodec, null)
  assert.equal(silent.info.audioOutput, null)
  assert.equal(silent.muted, false)
  const silentFrame = await frame('no-audio')
  assert.ok(silentFrame.visiblePixels > silentFrame.width * silentFrame.height * 0.2)
  report.checks.push({ name: 'video without audio', state: silent, frame: silentFrame })
  await stop()

  const normal = await open(3, 'H.264')
  assert.equal(normal.speed, 1, 'new movie defaults to normal speed')
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  for (const rate of [0.5, 0.75, 1, 1.25, 1.5, 2]) {
    await select('倍速', `${rate}×`)
    const before = await waitForState(page, state => state.speed === rate && state.phase === 'playing', `speed ${rate}`)
    const after = await waitForState(page, state => state.position > before.position + 0.2, `speed ${rate} clock`)
    assert.equal(after.sessionId, normal.sessionId)
    assert.equal((await nativeEvidence(application)).loadedFiles, 1)
  }
  await stop()
  report.checks.push({ name: 'six speed controls and new movie reset', pitchListening: 'pending' })
  for (const [index, aspect] of fixtures.aspects.entries()) {
    const [numerator, denominator] = aspect.display.split(':').map(Number)
    const ratio = numerator / denominator
    const playing = await open(index + 4, 'H.264')
    assert.equal(playing.speed, 1, 'new movie resets speed')
    assert.deepEqual([playing.info.width, playing.info.height], [aspect.width, aspect.height])
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await waitForState(page, state => state.paused, 'pause aspect fixture')
    const measure = async presentation => {
      const viewport = await page.evaluate(() => {
        const video = document.querySelector('[data-playback-session] button[aria-label="视频画面，单击播放或暂停，双击全屏"], [data-playback-session] button[aria-label="恢复展开播放器"]')
        const bounds = video.getBoundingClientRect()
        return { width: bounds.width * devicePixelRatio, height: bounds.height * devicePixelRatio }
      })
      const capture = await waitForValue(() => frame(`${aspect.file.replace('.mp4', '')}-${presentation}`, { whiteBounds: true }), image => {
        const bounds = image.whiteBounds
        if (!bounds) return false
        if (Math.abs(image.width - viewport.width) > 2
          || presentation !== 'fullscreen' && Math.abs(image.height - viewport.height) > 2) return false
        // The native view already reserves the fullscreen controls outside its
        // render surface; controlsTop can therefore be below the captured image.
        const height = Math.min(image.controlsTop ?? image.height, image.height)
        const width = Math.min(image.width, height * ratio), expectedHeight = Math.min(height, image.width / ratio)
        return Math.abs(bounds.width - width) <= 4 && Math.abs(bounds.height - expectedHeight) <= 4
          && Math.abs(bounds.x - (image.width - bounds.width) / 2) <= 3
          && Math.abs(bounds.y - (height - bounds.height) / 2) <= 3
      }, `${aspect.file} ${presentation} did not fit/center without distortion`)
      assert.equal((await page.evaluate(() => window.api.playback.snapshot())).sessionId, playing.sessionId)
      assert.equal((await nativeEvidence(application)).loadedFiles, 1)
      return { ...capture, viewport }
    }
    const expanded = await measure('expanded')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640))
    await page.waitForTimeout(400)
    const resized = await measure('resized')
    await page.getByRole('button', { name: '收起到底栏', exact: true }).click()
    await waitForState(page, state => state.presentation === 'docked' && state.paused, 'aspect dock keeps pause')
    await page.waitForTimeout(300)
    const docked = await measure('docked')
    await page.getByRole('button', { name: '恢复展开', exact: true }).click()
    await waitForState(page, state => state.presentation === 'expanded' && state.paused, 'aspect restore keeps pause')
    await page.getByRole('button', { name: '全屏', exact: true }).click()
    await waitForState(page, state => state.presentation === 'fullscreen' && state.paused, 'aspect fullscreen keeps pause')
    await page.waitForTimeout(1500)
    const fullscreen = await measure('fullscreen')
    await page.evaluate(id => window.api.playback.control(id, { kind: 'presentation', value: 'expanded' }), playing.sessionId)
    await waitForState(page, state => state.presentation === 'expanded', 'aspect fullscreen exit')
    await page.waitForTimeout(1500)
    await stop()
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1380, 880))
    report.checks.push({ name: `${aspect.file} display aspect in expanded/resized/docked/fullscreen`, source: aspect, expanded, resized, docked, fullscreen })
    save()
  }
  await open(fixtures.complexIndex, 'H.264')
  report.checks.push(await checkComplexSubtitlePixels(application, page, fixtures.directory, 'local-complex-ass'))
  save()
  await stop()
  await open(fixtures.bitmapIndex, 'H.264')
  report.checks.push(await checkBitmapSubtitlePixels(application, page, fixtures.directory, 'local-pgs'))
  report.evidence.bitmapReference = fixtures.bitmapReference
  save()
  await stop()
  const reset = await open(0, 'H.264')
  assert.equal(reset.speed, 1)
  assert.equal(fs.existsSync(path.join(directory, 'playback-progress.json')), false, 'default-off matrix must not persist progress')
  assert.deepEqual(errors, [])
  report.status = 'partial-pass'
  save()
  console.log(JSON.stringify({ report: reportFile, checks: report.checks.map(check => check.name), isolatedDirectory: directory }))
  if (process.argv.includes('--keep-open')) {
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await page.getByRole('button', { name: '播放选项', exact: true }).click()
    keepOpen = true
    const observation = setInterval(async () => {
      try {
        const state = await page.evaluate(() => window.api.playback.snapshot())
        const native = await nativeEvidence(application)
        fs.writeFileSync(path.join(fixtures.directory, 'interactive-state.json'), JSON.stringify({ state, native }, null, 2))
      } catch { /* The application can close between read-only observations. */ }
    }, 1000)
    await application.waitForEvent('close', { timeout: 0 })
    clearInterval(observation)
  } else await stop()
} catch (error) {
  report.status = 'failed'
  report.failure = error.stack ?? String(error)
  save()
  throw error
} finally {
  if (application && !keepOpen) {
    recordAcceptanceCleanup(report, await closeAcceptance(application))
    save()
  }
}
