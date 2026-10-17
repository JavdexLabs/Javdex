import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import electron from 'electron'
import { captureAcceptanceFrame, closeAcceptance, recordAcceptanceCleanup, createAcceptanceDirectory, launchAcceptance, nativeEvidence, output, root, seedAcceptanceCatalog, waitForValue as until } from './playback-acceptance-support.mjs'
import { prepareMediaFixtures } from './playback-media-fixtures.mjs'
import { checkBitmapSubtitlePixels, checkComplexSubtitlePixels, checkLocalSubtitlePicker } from './playback-subtitle-checks.mjs'
import { openPlaybackSettings, closePlaybackSettings, selectPlaybackSetting } from './playback-settings-ui.mjs'
import { startPlaybackRemoteServer } from './playback-remote-server.ts'
import { assertOrdinaryAcceptanceExit } from './playback-acceptance-cleanup.mjs'

if (!['darwin', 'win32'].includes(process.platform)) throw new Error('This acceptance covers macOS and Windows desktops only')
assert.equal(process.versions.electron, undefined, 'the server must run on Node, not Electron')
const serverEntry = path.join(root, 'out/server/index.js')
const fixtures = process.argv.includes('--media-matrix') ? prepareMediaFixtures() : null
const subtitlePicker = process.argv.includes('--system-subtitle-picker')
assert.ok(!subtitlePicker || fixtures, '--system-subtitle-picker requires --media-matrix')
const media = fixtures?.media ?? ['synthetic-h264.mp4', 'synthetic-subtitles.mkv'].map(file => path.join(output, file))
for (const file of [serverEntry, electron, ...media]) {
  if (!fs.existsSync(file)) throw new Error('Requires server:build, desktop:build, playback:native:build and the local playback acceptance fixtures')
}
const serverDirectory = createAcceptanceDirectory('server-')
const desktopDirectory = createAcceptanceDirectory('remote-')
seedAcceptanceCatalog(serverDirectory, media)
const configFile = path.join(serverDirectory, 'server.json')
fs.writeFileSync(configFile, JSON.stringify({
  listenHost: '127.0.0.1', port: 0, accessHosts: ['127.0.0.1'], dataDir: path.join(serverDirectory, 'data'),
  imagesDir: path.join(serverDirectory, 'images'), staticRoot: path.join(root, 'out/server/web'),
  mediaMounts: { synthetic: output }, web: { username: 'acceptance' }
}), { mode: 0o600 })
const statsFile = path.join(serverDirectory, 'traffic.json')
const server = await startPlaybackRemoteServer(serverDirectory, serverEntry, configFile, statsFile)
let application, report
const errors = []
const traffic = () => {
  try { return JSON.parse(fs.readFileSync(statsFile, 'utf8')) } catch { return null }
}
try {
  const baseUrl = server.origin
  fs.writeFileSync(path.join(desktopDirectory, 'this-computer.json'), JSON.stringify({
    mode: 'remote', remoteBaseUrl: baseUrl, playerPreference: 'builtin', resumePlayback: false
  }))
  application = await launchAcceptance(desktopDirectory, 'remote-application.log')
  let page = await application.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => window.api?.desktop && window.api.playback)
  const session = () => page.evaluate(() => window.api.desktop.getSession())
  await until(session, value => value.session.state === 'claimRequired', 'desktop did not request writer claim')
  const claim = await page.evaluate(({ remoteBaseUrl, oneTimeToken }) => window.api.serverUpdate.control({ action: 'connect', remoteBaseUrl, oneTimeToken }),
    { remoteBaseUrl: baseUrl, oneTimeToken: server.oneTimeToken })
  assert.equal(claim.paired, true); assert.equal(claim.connectionRestartRequired, true)
  const pairingCleanup = await closeAcceptance(application)
  assertOrdinaryAcceptanceExit(pairingCleanup)
  application = await launchAcceptance(desktopDirectory, 'remote-restarted-application.log')
  page = await application.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => window.api?.desktop && window.api.playback)
  const available = await until(session, value => value.session.state === 'available', 'remote desktop did not become available after restart')
  assert.equal(available.session.mode, 'remote')
  const targets = JSON.parse(fs.readFileSync(path.join(serverDirectory, 'targets.json'), 'utf8'))
  const target = targets[0]
  const result = await page.evaluate(target => window.api.player.play(target.libraryId, target.videoId), target)
  assert.equal(result.ok, true, result.error)
  const state = () => page.evaluate(() => window.api.playback.snapshot())
  const playing = await until(state, value => value?.source === 'remote' && value.phase === 'playing' && value.position > 1,
    'remote original file did not start')
  if (process.platform === 'darwin') assert.equal(playing.info.hardwareDecoder, 'videotoolbox')
  assert.equal(playing.info.audioOutput, process.platform === 'win32' ? 'wasapi' : 'coreaudio')
  assert.equal(playing.recordingProgress, false)
  const nativeState = () => nativeEvidence(application)
  const nativeBefore = await nativeState()
  assert.ok(nativeBefore.presentedFrames > 0, 'remote playback presents actual native frames')
  const before = await until(traffic, value => value?.grantRequests === 1 && value.rangeRequests > 0 && value.mediaBytesQueued > 0,
    'server did not grant and serve original Range bytes')
  await page.getByRole('button', { name: '收起到底栏', exact: true }).click()
  await until(state, value => value?.presentation === 'docked', 'remote dock')
  const docked = await state()
  await until(state, value => value?.position > docked.position + 1, 'remote docked clock did not advance')
  assert.ok((await nativeState()).presentedFrames > nativeBefore.presentedFrames)
  await page.getByRole('button', { name: '恢复展开', exact: true }).click()
  await until(state, value => value?.presentation === 'expanded', 'remote expand')
  assert.equal((await state()).sessionId, playing.sessionId)
  assert.equal((await nativeState()).loadedFiles, 1)
  assert.equal((await page.evaluate(target => window.api.player.play(target.libraryId, target.videoId), target)).ok, true)
  assert.equal((await state()).sessionId, playing.sessionId, 'same remote resource restores the same session')
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await until(state, value => value?.paused, 'remote pause')
  const paused = await state()
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.ok(Math.abs((await state()).position - paused.position) < 0.1)
  const seconds = fixtures ? 24 : 65
  await page.evaluate(({ id, seconds }) => window.api.playback.control(id, { kind: 'seek', seconds }), { id: playing.sessionId, seconds })
  await until(state, value => value?.paused && !value.seeking && Math.abs(value.position - seconds) < 0.2, 'remote exact paused seek')
  await openPlaybackSettings(page)
  await page.screenshot({ path: path.join(output, 'remote-player.png') })
  await new Promise(resolve => setTimeout(resolve, 600))
  const after = traffic()
  assert.equal(after.grantRequests, before.grantRequests, 'presentation, paused seek and reopening the same resource must not re-grant')
  const matrix = []
  if (fixtures) {
    assert.deepEqual(playing.tracks.filter(track => track.type === 'audio').map(track => [track.codec, track.channelCountHint]),
      [['aac', 2], ['ac3', 6], ['eac3', 6], ['dts', 2]])
    assert.equal(playing.tracks.find(track => track.type === 'sub' && track.selected).codec, 'ass')
    assert.deepEqual(playing.chapters.map(chapter => chapter.time), [0, 12, 24])
    const decodedCodec = { aac: /AAC/, ac3: /AC-3/, eac3: /E-AC-3/, dts: /DTS/ }
    await page.getByRole('button', { name: '播放', exact: true }).click()
    for (const track of playing.tracks.filter(track => track.type === 'audio')) {
      await selectPlaybackSetting(page, '音轨', new RegExp(`^${track.title}`))
      const switched = await until(state, value => value?.tracks.some(item => item.type === 'audio' && item.id === track.id && item.selected)
        && value.info.audioOutput === (process.platform === 'win32' ? 'wasapi' : 'coreaudio') && decodedCodec[track.codec].test(value.info.audioCodec ?? ''), `remote ${track.codec}`)
      const first = await until(nativeState, value => Number.isFinite(value.audioPosition), 'remote audio clock')
      const next = await until(nativeState, value => value.audioPosition > first.audioPosition + 0.3 && value.presentedFrames > first.presentedFrames, 'remote audio/frame advance')
      assert.equal(next.loadedFiles, 1)
      assert.equal(switched.sessionId, playing.sessionId)
      matrix.push({ name: `remote ${track.codec}`, decoder: switched.info.audioCodec, channelHint: track.channelCountHint,
        before: first.audioPosition, after: next.audioPosition, humanListening: 'pending' })
    }
    await page.getByRole('button', { name: '暂停', exact: true }).click()
    await until(state, value => value?.paused, 'remote pause before chapter selection')
    await selectPlaybackSetting(page, '章节', 'Middle')
    const chapter = await until(state, value => value?.paused && !value.seeking && Math.abs(value.position - 12) < 0.15, 'remote chapter UI seek')
    assert.equal(chapter.sessionId, playing.sessionId)
    const frame = (name, options) => captureAcceptanceFrame(application, fixtures.directory, name, options)
    await selectPlaybackSetting(page, '字幕', '关闭字幕')
    await until(state, value => !value.tracks.some(track => track.type === 'sub' && track.selected), 'remote ASS off')
    await page.waitForTimeout(300)
    await frame('remote-ass-off', { baseline: true })
    await selectPlaybackSetting(page, '字幕', /^Styled/)
    await until(state, value => value.tracks.some(track => track.type === 'sub' && track.codec === 'ass' && track.selected), 'remote ASS selected')
    await page.waitForTimeout(300)
    const assExpanded = await frame('remote-ass-on', { compare: true })
    assert.ok(assExpanded.differentPixels > 200, 'remote subtitle must render actual pixels')
    assert.equal(await page.getByRole('button', { name: '字幕字号', exact: true }).isDisabled(), true)
    await closePlaybackSettings(page)
    await page.getByRole('button', { name: '全屏', exact: true }).click()
    await until(state, value => value?.presentation === 'fullscreen' && value.paused, 'remote ASS fullscreen')
    await page.waitForTimeout(1500)
    await page.evaluate(id => window.api.playback.control(id, { kind: 'track', type: 'sub', id: null }), playing.sessionId)
    await until(state, value => !value.tracks.some(track => track.type === 'sub' && track.selected), 'remote fullscreen subtitle off')
    await page.waitForTimeout(300)
    await frame('remote-ass-fullscreen-off', { baseline: true })
    const sid = playing.tracks.find(track => track.type === 'sub' && track.codec === 'ass').id
    await page.evaluate(({ id, sid }) => window.api.playback.control(id, { kind: 'track', type: 'sub', id: sid }), { id: playing.sessionId, sid })
    await until(state, value => value.tracks.some(track => track.type === 'sub' && track.id === sid && track.selected), 'remote fullscreen ASS on')
    await page.waitForTimeout(300)
    const assFullscreen = await frame('remote-ass-fullscreen-on', { compare: true })
    assert.ok(assFullscreen.differentPixels > 200)
    assert.ok(Number.isFinite(assFullscreen.controlsTop) && assFullscreen.bottom < assFullscreen.controlsTop,
      'remote ASS must remain above visible fullscreen controls')
    assert.equal((await state()).sessionId, playing.sessionId)
    assert.equal((await nativeState()).loadedFiles, 1)
    matrix.push({ name: 'remote chapter UI and ASS pixels', chapter: chapter.position, expanded: assExpanded, fullscreen: assFullscreen })
    await page.evaluate(id => window.api.playback.control(id, { kind: 'presentation', value: 'expanded' }), playing.sessionId)
    await until(state, value => value.presentation === 'expanded', 'remote return from fullscreen')
    await page.waitForTimeout(1500)
    assert.equal(traffic().grantRequests, 1, 'remote track selection does not re-grant')
    await page.getByRole('button', { name: '停止播放', exact: true }).click()
    await until(state, value => value === null, 'remote stop before HEVC')
    const hevcTarget = targets[1]
    assert.equal((await page.evaluate(target => window.api.player.openResource(target.libraryId, target.resourceId, target.videoId), hevcTarget)).ok, true)
    const hevc = await until(state, value => value?.source === 'remote' && value.phase === 'playing' && value.position > 0.6
      && value.info.videoCodec?.includes('HEVC'), 'remote Main10')
    if (process.platform === 'darwin') assert.equal(hevc.info.hardwareDecoder, 'videotoolbox')
    assert.equal(hevc.info.audioOutput, process.platform === 'win32' ? 'wasapi' : 'coreaudio')
    const hevcBefore = await nativeState()
    await until(state, value => value?.position > hevc.position + 0.6, 'remote HEVC clock')
    assert.ok((await nativeState()).presentedFrames > hevcBefore.presentedFrames)
    assert.equal((await nativeState()).loadedFiles, 1)
    await until(traffic, value => value?.grantRequests === 2 && value.mediaBytesQueued > after.mediaBytesQueued, 'HEVC original Range bytes')
    matrix.push({ name: 'remote HEVC Main10 SDR', state: hevc, humanListening: 'pending', HDR: 'not tested' })
    await page.getByRole('button', { name: '停止播放', exact: true }).click()
    await until(state, value => value === null, 'remote stop before complex ASS')
    const complexTarget = targets[fixtures.complexIndex]
    assert.equal((await page.evaluate(target => window.api.player.openResource(target.libraryId, target.resourceId, target.videoId), complexTarget)).ok, true)
    await until(state, value => value?.source === 'remote' && value.phase === 'playing' && value.position > 0.6, 'remote complex ASS starts')
    matrix.push(await checkComplexSubtitlePixels(application, page, fixtures.directory, 'remote-complex-ass'))
    await until(traffic, value => value?.grantRequests === 3, 'complex ASS original resource grant')
    if (subtitlePicker) {
      const requestFile = path.join(output, 'remote-picker-request.json')
      for (const file of ['external.srt', 'complex.ass']) {
        const selected = await checkLocalSubtitlePicker(application, page, fixtures.directory, file, () => {
          fs.writeFileSync(requestFile, JSON.stringify({ status: 'awaiting-system-picker', file: path.join(fixtures.directory, file) }))
          console.log(`Remote native subtitle picker ready: ${file}`)
        })
        matrix.push(selected)
        fs.writeFileSync(requestFile, JSON.stringify({ status: 'passed', file, evidence: selected }))
        assert.equal(traffic().grantRequests, 3, 'a local subtitle does not need a new remote media grant')
      }
    }
    await page.getByRole('button', { name: '停止播放', exact: true }).click()
    await until(state, value => value === null, 'remote stop before bitmap PGS')
    const bitmapTarget = targets[fixtures.bitmapIndex]
    assert.equal((await page.evaluate(target => window.api.player.openResource(target.libraryId, target.resourceId, target.videoId), bitmapTarget)).ok, true)
    await until(state, value => value?.source === 'remote' && value.phase === 'playing' && value.position > 0.6, 'remote bitmap PGS starts')
    matrix.push(await checkBitmapSubtitlePixels(application, page, fixtures.directory, 'remote-pgs'))
    await until(traffic, value => value?.grantRequests === 4, 'bitmap PGS original resource grant')
  }
  assert.ok(!JSON.stringify(await state()).includes('?t='), 'playback snapshots never contain the grant URL')
  assert.equal(fs.existsSync(path.join(desktopDirectory, 'playback-progress.json')), false)
  assert.equal(fs.existsSync(path.join(desktopDirectory, 'data/library.db')), false, 'remote mode never opens a local catalog')
  assert.deepEqual(errors, [])
  report = { status: 'partial-pass', platform: `${process.platform}/${process.arch}`, desktopDirectory, serverDirectory,
    serverRuntime: `Node ${process.version}`, scope: 'same-source independent Node host on loopback; not Docker or clean-package acceptance',
    initial: playing, final: await state(), traffic: traffic(), matrix,
    checks: ['unified HTTPS pairing, ordinary restart and remote catalog', 'real player.play routing', 'client decoder and platform audio output', 'original HTTPS-proxied Range bytes',
      'native frames and docked clock advance', 'same-session restore and reopen without a second grant', 'paused exact seek', 'default-off no progress file', 'no local catalog'],
    pending: ['independent machine/network conditions', 'long video and audio listening', 'further bitmap formats and real-film subtitle styles',
      ...(!subtitlePicker ? ['real system picker for local sidecars with remote playback'] : []), 'packaged runtime'], errors }
  fs.writeFileSync(path.join(output, fixtures ? 'remote-media-report.json' : 'remote-report.json'), JSON.stringify(report, null, 2))
  if (process.argv.includes('--keep-open')) {
    console.log(`Remote acceptance window ready; isolated catalog: ${desktopDirectory}`)
    await new Promise(resolve => application.on('close', resolve))
  } else {
    await page.getByRole('button', { name: '停止播放', exact: true }).click()
    await until(state, value => value === null, 'remote stop')
    console.log(`${process.platform} partial remote application playback acceptance passed`)
  }
} catch (error) {
  report = { status: 'failed', platform: `${process.platform}/${process.arch}`, message: error.message,
    desktopDirectory, serverDirectory, errors, pending: [] }
  fs.writeFileSync(path.join(output, 'remote-failure.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(output, fixtures ? 'remote-media-report.json' : 'remote-report.json'), JSON.stringify(report, null, 2))
  throw error
} finally {
  try {
    if (application) {
      const cleanup = await closeAcceptance(application)
      console.log(JSON.stringify({ cleanup }))
      if (report) {
        recordAcceptanceCleanup(report, cleanup)
        fs.writeFileSync(path.join(output, fixtures ? 'remote-media-report.json' : 'remote-report.json'), JSON.stringify(report, null, 2))
      }
    }
  } finally {
    await server.stop()
  }
}
