import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { closeAcceptance, createAcceptanceDirectory, launchAcceptance, output, seedAcceptanceCatalog, waitForState } from './playback-acceptance-support.mjs'

if (process.platform !== 'darwin') throw new Error('This acceptance runner currently covers macOS only')
const directory = createAcceptanceDirectory()
const media = [path.join(output, 'synthetic-h264.mp4')]
if (!fs.existsSync(media[0])) {
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '120', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', media[0]], { stdio: 'inherit' })
  if (generated.status !== 0) throw new Error('Synthetic media generation failed')
}
const subtitles = path.join(output, 'synthetic.srt')
fs.writeFileSync(subtitles, '1\n00:00:00,000 --> 00:01:00,000\nJavdex subtitle test ONE\n\n2\n00:01:00,000 --> 00:02:00,000\nJavdex subtitle test TWO\n')
media.push(path.join(output, 'synthetic-subtitles.mkv'))
if (!fs.existsSync(media[1])) {
  const muxed = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', media[0], '-i', subtitles,
    '-map', '0:v', '-map', '0:a', '-map', '1:s', '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'srt',
    '-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default', media[1]], { stdio: 'inherit' })
  if (muxed.status !== 0) throw new Error('Synthetic subtitle fixture generation failed')
}
media.push(path.join(output, 'synthetic-unplayable.mp4'))
fs.writeFileSync(media[2], 'Synthetic unsupported media, not a playable video.\n')
seedAcceptanceCatalog(directory, media)
let application
let keepOpen = false
const errors = []
try {
  application = await launchAcceptance(directory)
  const page = await application.firstWindow()
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    globalThis.playbackWindowEvents = []
    for (const event of ['hide', 'show', 'enter-full-screen', 'leave-full-screen', 'minimize']) {
      window.on(event, () => globalThis.playbackWindowEvents.push({ event, visible: window.isVisible(), fullscreen: window.isFullScreen() }))
    }
  })
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => window.api?.playback && document.querySelector('nav'))
  const target = JSON.parse(fs.readFileSync(path.join(directory, 'targets.json'), 'utf8'))[0]
  await page.evaluate(() => window.api.thisComputer.update({ playerPreference: 'builtin' }))
  assert.equal(await page.evaluate(async () => (await window.api.thisComputer.get()).playerPreference), 'builtin')
  const result = await page.evaluate(target => window.api.player.play(target.libraryId, target.videoId), target)
  assert.equal(result.ok, true, JSON.stringify(result))
  const initial = await waitForState(page, state => state?.phase === 'playing' && state.position > 0.5 && state.info.hardwareDecoder != null, 'video did not start')
  fs.writeFileSync(path.join(output, 'initial-state.json'), JSON.stringify(initial, null, 2))
  assert.equal(initial.info.hardwareDecoder, 'videotoolbox')
  assert.equal(initial.info.audioOutput, 'coreaudio')
  const id = initial.sessionId
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('button[aria-label="播放来源"]')?.textContent.includes('测试视频 1'))
  assert.equal(await page.getByRole('button', { name: '播放来源', exact: true }).isDisabled(), true, 'one file must not offer a fictitious alternative')
  assert.equal(await page.getByRole('button', { name: '使用外部播放器打开', exact: true }).isEnabled(), true, 'external open is available before an error')
  assert.equal((await page.evaluate(() => window.api.playback.snapshot())).sessionId, id, 'reading options must preserve playback')
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  await page.getByRole('button', { name: '收起到底栏', exact: true }).click()
  await waitForState(page, state => state?.presentation === 'docked', 'dock')
  const docked = await page.evaluate(() => window.api.playback.snapshot())
  assert.equal(docked.sessionId, id)
  await waitForState(page, state => state?.position > docked.position + 1, 'docked playback clock')
  await page.getByRole('button', { name: '恢复展开', exact: true }).click()
  await waitForState(page, state => state?.presentation === 'expanded', 'expand')
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await waitForState(page, state => state?.presentation === 'fullscreen', 'fullscreen')
  await page.waitForTimeout(1500)
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), true)
  const fullscreenState = await page.evaluate(() => window.api.playback.snapshot())
  fs.writeFileSync(path.join(output, 'fullscreen-state.json'), JSON.stringify({ state: fullscreenState,
    events: await application.evaluate(() => globalThis.playbackWindowEvents) }, null, 2))
  assert.equal(fullscreenState.paused, false, 'entering fullscreen must preserve playing intent')
  await page.evaluate(id => window.api.playback.control(id, { kind: 'presentation', value: 'docked' }), id)
  await page.waitForTimeout(1500)
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), false)
  await page.evaluate(id => window.api.playback.control(id, { kind: 'pause', paused: true }), id)
  await waitForState(page, state => state?.paused, 'pause')
  const paused = await page.evaluate(() => window.api.playback.snapshot())
  await page.waitForTimeout(400)
  assert.ok(Math.abs((await page.evaluate(() => window.api.playback.snapshot())).position - paused.position) < 0.1)
  await page.evaluate(id => window.api.playback.control(id, { kind: 'seek', seconds: 30 }), id)
  await waitForState(page, state => state?.position != null && Math.abs(state.position - 30) < 0.2, 'paused seek')
  assert.equal((await page.evaluate(() => window.api.playback.snapshot())).paused, true)
  await page.evaluate(async id => {
    await window.api.playback.control(id, { kind: 'volume', value: 31 })
    await window.api.playback.control(id, { kind: 'stop' })
  }, id)
  await waitForState(page, state => state === null, 'volume stop/flush')
  assert.equal(await page.evaluate(async () => (await window.api.thisComputer.get()).playbackVolume), 31)
  const subtitleTarget = JSON.parse(fs.readFileSync(path.join(directory, 'targets.json'), 'utf8'))[1]
  assert.equal((await page.evaluate(target => window.api.player.openResource(target.libraryId, target.resourceId, target.videoId), subtitleTarget)).ok, true)
  const withSubtitles = await waitForState(page, state => state?.phase === 'playing' && state.tracks.some(track => track.type === 'sub' && track.selected), 'embedded subtitles')
  assert.notEqual(withSubtitles.sessionId, id)
  assert.equal(withSubtitles.volume, 31, 'new native decoder uses the saved device volume')
  await page.evaluate(async id => {
    await window.api.playback.control(id, { kind: 'pause', paused: true })
    await window.api.playback.control(id, { kind: 'subtitle-delay', seconds: 1.5 })
    await window.api.playback.control(id, { kind: 'subtitle-size', value: 70 })
  }, withSubtitles.sessionId)
  await waitForState(page, state => state?.paused && state.subtitleDelay === 1.5 && state.subtitleSize === 70, 'subtitle property roundtrip')
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  await page.getByRole('textbox', { name: '指定时间', exact: true }).fill('00:99:00')
  await page.getByRole('button', { name: '跳转到指定时间', exact: true }).click()
  assert.match(await page.getByRole('alert').innerText(), /请输入/)
  await page.getByRole('textbox', { name: '指定时间', exact: true }).fill('00:01:00')
  await page.getByRole('button', { name: '跳转到指定时间', exact: true }).click()
  await waitForState(page, state => state?.paused && Math.abs(state.position - 60) < 0.2, 'exact time form preserves pause')
  await page.getByRole('button', { name: '字幕字号', exact: true }).click()
  await page.getByRole('option', { name: '40', exact: true }).click()
  await page.getByRole('button', { name: '提前 0.5 秒', exact: true }).click()
  const adjustedSubtitles = await waitForState(page, state => state?.subtitleDelay === 1 && state.subtitleSize === 40, 'subtitle controls')
  await page.evaluate(id => window.api.playback.control(id, { kind: 'presentation', value: 'fullscreen' }), withSubtitles.sessionId)
  await page.waitForTimeout(1500)
  const subtitleId = adjustedSubtitles.tracks.find(track => track.type === 'sub' && track.selected).id
  await page.evaluate(id => window.api.playback.control(id, { kind: 'seek', seconds: 65 }), withSubtitles.sessionId)
  await waitForState(page, state => Math.abs(state.position - 65) < 0.2, 'subtitle interior cue')
  await page.evaluate(id => window.api.playback.control(id, { kind: 'track', type: 'sub', id: null }), withSubtitles.sessionId)
  await waitForState(page, state => !state.tracks.some(track => track.type === 'sub' && track.selected), 'subtitle baseline')
  await page.waitForTimeout(300)
  await application.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    globalThis.subtitleBaseline = require(app.getAppPath() + '/out/native-playback/playback.node').capture()
  })
  await page.evaluate(({ id, subtitleId }) => window.api.playback.control(id, { kind: 'track', type: 'sub', id: subtitleId }), { id: withSubtitles.sessionId, subtitleId })
  await waitForState(page, state => state.tracks.some(track => track.type === 'sub' && track.selected), 'subtitle clearance')
  await page.evaluate(id => window.api.playback.control(id, { kind: 'seek', seconds: 65 }), withSubtitles.sessionId)
  await page.waitForTimeout(300)
  const subtitleClearance = await application.evaluate(({ app, nativeImage }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const frame = require(app.getAppPath() + '/out/native-playback/playback.node').capture()
    const baseline = globalThis.subtitleBaseline
    delete globalThis.subtitleBaseline
    for (const [name, image] of [['baseline', baseline], ['subtitles', frame]]) {
      require('node:fs').writeFileSync(app.getAppPath() + '/out/playback-acceptance/' + name + '.png',
        nativeImage.createFromBitmap(image.data, { width: image.width, height: image.height }).toPNG())
    }
    if (frame.width !== baseline.width || frame.height !== baseline.height) throw new Error('Subtitle capture geometry changed')
    let count = 0, bottom = -1
    for (let y = Math.floor(frame.height / 2); y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const offset = (y * frame.width + x) * 4
        if ([0, 1, 2].every(channel => frame.data[offset + channel] > 220)
          && [0, 1, 2].some(channel => frame.data[offset + channel] - baseline.data[offset + channel] > 40)) {
          count++; bottom = y
        }
      }
    }
    return { count, bottom, controlsTop: frame.controlsTop, width: frame.width, height: frame.height }
  })
  fs.writeFileSync(path.join(output, 'subtitle-clearance.json'), JSON.stringify(subtitleClearance, null, 2))
  assert.ok(subtitleClearance.count > 100, 'subtitle pixels must actually be rendered')
  assert.ok(Number.isFinite(subtitleClearance.controlsTop), 'paused fullscreen controls must be visible')
  assert.ok(subtitleClearance.bottom < subtitleClearance.controlsTop, `Subtitle overlaps fullscreen controls: ${JSON.stringify(subtitleClearance)}`)
  await page.evaluate(id => window.api.playback.control(id, { kind: 'pause', paused: false }), withSubtitles.sessionId)
  await waitForState(page, state => state.phase === 'playing', 'resume before auto-hide')
  await page.waitForTimeout(3500)
  const hiddenControls = await application.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const { width, height, controlsTop } = require(app.getAppPath() + '/out/native-playback/playback.node').capture()
    return { width, height, controlsTop }
  })
  assert.equal(hiddenControls.controlsTop, undefined, 'fullscreen controls auto-hide while playing')
  assert.ok(hiddenControls.height > subtitleClearance.height, 'auto-hide releases the native video inset')
  await page.evaluate(id => window.api.playback.control(id, { kind: 'pause', paused: true }), withSubtitles.sessionId)
  await page.evaluate(id => window.api.playback.control(id, { kind: 'presentation', value: 'expanded' }), withSubtitles.sessionId)
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: '停止播放', exact: true }).click()
  await waitForState(page, state => state === null, 'stop before resume acceptance')
  const progressFile = path.join(directory, 'playback-progress.json')
  assert.equal(fs.existsSync(progressFile), false, 'default-off playback creates no progress file')
  await page.getByRole('link', { name: '设置', exact: true }).click()
  await page.getByRole('link', { name: '存储与导出', exact: true }).click()
  const recordingSwitch = page.getByRole('switch', { name: '保存续播进度', exact: true })
  assert.equal(await recordingSwitch.isChecked(), false)
  await recordingSwitch.check()
  assert.equal(await page.evaluate(async () => (await window.api.thisComputer.get()).resumePlayback), false, 'recording switch edits only the draft')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  assert.equal(await page.evaluate(async () => (await window.api.thisComputer.get()).resumePlayback), true)
  assert.equal((await page.evaluate(target => window.api.player.play(target.libraryId, target.videoId), target)).ok, true)
  const recording = await waitForState(page, state => state?.recordingProgress && state.phase === 'playing' && state.position > 0.8, 'recording playback')
  await page.evaluate(id => window.api.playback.control(id, { kind: 'seek', seconds: 40 }), recording.sessionId)
  await waitForState(page, state => state?.position > 40.5 && !state.seeking, 'recording seek completion')
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await waitForState(page, state => state?.paused, 'recording pause')
  assert.equal(fs.existsSync(progressFile), true)
  const savedPoint = JSON.parse(fs.readFileSync(progressFile, 'utf8')).entries[0]
  assert.ok(savedPoint.position > 40 && savedPoint.position < 45)
  assert.equal((await page.evaluate(() => window.api.playback.snapshot())).recordingProgress, true)
  await page.getByRole('button', { name: '停止播放', exact: true }).click()
  assert.equal((await page.evaluate(target => window.api.player.play(target.libraryId, target.videoId), target)).ok, true)
  const waitingResume = await waitForState(page, state => state?.resumePosition > 40 && state.phase === 'paused', 'waiting for resume decision')
  await page.waitForTimeout(400)
  assert.ok((await page.evaluate(() => window.api.playback.snapshot())).position < 0.1, 'resume preparation cannot start the movie')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640))
  await page.getByRole('button', { name: '收起到底栏', exact: true }).click()
  await waitForState(page, state => state?.presentation === 'docked' && state.paused && state.resumePosition > 40, 'dock cannot skip resume decision')
  await page.waitForTimeout(300)
  const narrowResume = await page.evaluate(() => {
    const root = document.querySelector('[data-playback-session]')
    const bounds = root.getBoundingClientRect()
    const controls = [...root.querySelectorAll('button,input')].filter(element => element.getClientRects().length > 0).map(element => {
      const rect = element.getBoundingClientRect()
      return { name: element.getAttribute('aria-label') ?? element.textContent?.trim(), left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    })
    return { root: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom }, viewport: { width: innerWidth, height: innerHeight }, controls }
  })
  await page.screenshot({ path: path.join(output, 'narrow-resume-choice.png') })
  assert.ok(narrowResume.root.right <= narrowResume.viewport.width && narrowResume.root.bottom <= narrowResume.viewport.height)
  for (const control of narrowResume.controls) assert.ok(control.left >= narrowResume.root.left - 1 && control.right <= narrowResume.root.right + 1
    && control.top >= narrowResume.root.top - 1 && control.bottom <= narrowResume.root.bottom + 1, `narrow resume clips ${JSON.stringify(control)}`)
  assert.equal((await page.evaluate(() => window.api.playback.snapshot())).sessionId, waitingResume.sessionId)
  await page.getByRole('button', { name: '恢复展开', exact: true }).click()
  await waitForState(page, state => state?.presentation === 'expanded' && state.paused && state.resumePosition > 40, 'restore resume decision')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1380, 880))
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(output, 'resume-choice.png') })
  await page.getByRole('button', { name: /^继续 / }).click()
  await waitForState(page, state => state?.resumePosition === null && state.phase === 'playing' && state.position > waitingResume.resumePosition + 0.5, 'continued from saved position')
  await page.getByRole('button', { name: '停止播放', exact: true }).click()
  const beforePrivate = fs.readFileSync(progressFile, 'utf8')
  assert.equal((await page.evaluate(target => window.api.playback.open(target, { privateSession: true }), target)).ok, true)
  const privatePlayback = await waitForState(page, state => state?.phase === 'playing' && state.position > 0.5 && state.position < 3, 'private playback starts from zero')
  assert.equal(privatePlayback.resumePosition, null)
  assert.equal(privatePlayback.recordingProgress, false)
  await page.evaluate(id => window.api.playback.control(id, { kind: 'seek', seconds: 119 }), privatePlayback.sessionId)
  await waitForState(page, state => state?.phase === 'ended', 'private playback EOF')
  await page.getByRole('button', { name: '停止播放', exact: true }).click()
  assert.equal(fs.readFileSync(progressFile, 'utf8'), beforePrivate, 'private EOF and stop leave old progress untouched')
  assert.equal((await page.evaluate(target => window.api.player.play(target.libraryId, target.videoId), target)).ok, true)
  await waitForState(page, state => state?.resumePosition > 40 && state.phase === 'paused', 'resume before from-start choice')
  await page.getByRole('button', { name: '从头播放', exact: true }).click()
  await waitForState(page, state => state?.phase === 'playing' && state.position > 0.5 && state.position < 3, 'explicit from-start choice')
  await page.getByRole('button', { name: '收起到底栏', exact: true }).click()
  await waitForState(page, state => state?.presentation === 'docked', 'dock before disabling recording')
  await recordingSwitch.uncheck()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await waitForState(page, state => state?.recordingProgress === false, 'global off immediately stops current recording')
  await page.getByRole('button', { name: '停止播放', exact: true }).click()
  assert.equal(fs.readFileSync(progressFile, 'utf8'), beforePrivate, 'global off does not update or remove old progress')
  await page.getByRole('button', { name: '清除全部本机续播进度', exact: true }).click()
  await page.getByRole('dialog', { name: '清除全部本机续播进度', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(fs.readFileSync(progressFile, 'utf8'), beforePrivate, 'canceling clear retains all progress')
  const unplayableTarget = JSON.parse(fs.readFileSync(path.join(directory, 'targets.json'), 'utf8'))[2]
  assert.equal((await page.evaluate(target => window.api.playback.open(target, { privateSession: true }), unplayableTarget)).ok, true)
  const failed = await waitForState(page, state => state?.phase === 'error', 'unsupported media error')
  assert.match(failed.error, /格式/)
  assert.equal(failed.presentation, 'expanded')
  assert.match(await page.getByRole('alert').innerText(), /格式/)
  await page.screenshot({ path: path.join(output, 'format-error.png') })
  await page.getByRole('button', { name: '重试所选资源', exact: true }).click()
  const retried = await waitForState(page, state => state?.phase === 'error' && state.sessionId !== failed.sessionId, 'explicit error retry')
  assert.deepEqual(retried.target, failed.target, 'retry never changes resource')
  assert.equal(retried.recordingProgress, false, 'retry keeps the private session private')
  assert.equal(await application.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    return require(app.getAppPath() + '/out/native-playback/playback.node').inspect().alive
  }), false, 'failure releases the native decoder')
  await page.getByRole('button', { name: '关闭播放器', exact: true }).click()
  await waitForState(page, state => state === null, 'close error surface')
  // Exercise the real detail-page trigger, not just an API open with body focus.
  await page.getByRole('link', { name: '默认媒体库', exact: true }).click()
  await page.getByRole('button', { name: /^PLAYBACK-1 未刮削/ }).click()
  const detailPlay = page.getByRole('toolbar', { name: '影片操作', exact: true }).getByRole('button', { name: '播放', exact: true })
  await detailPlay.click()
  const focusSession = await waitForState(page, state => state?.phase === 'playing' && state.position > 0.5, 'detail playback trigger')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await waitForState(page, state => state?.presentation === 'fullscreen', 'detail fullscreen')
  const focusDeadline = Date.now() + 5000
  while (!await application.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    return require(app.getAppPath() + '/out/native-playback/playback.node').inspect().focusedControl === 'video'
  })) {
    if (Date.now() > focusDeadline) throw new Error('Fullscreen did not acquire native video focus')
    await page.waitForTimeout(100)
  }
  assert.equal(await application.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    return Object.hasOwn(require(app.getAppPath() + '/out/native-playback/playback.node').inspect(), 'actions')
  }), false, 'read-only diagnostics do not consume or expose the native action queue')
  await page.evaluate(id => window.api.playback.control(id, { kind: 'stop' }), focusSession.sessionId)
  await waitForState(page, state => state === null, 'detail fullscreen stop')
  await page.waitForFunction(() => document.activeElement instanceof HTMLButtonElement
    && document.activeElement.textContent?.trim() === '播放' && document.activeElement.closest('[role="toolbar"]')?.getAttribute('aria-label') === '影片操作')
  await page.waitForTimeout(1500)
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), false,
    'stopping releases the native fullscreen presentation')
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isFocused()), true,
    'stopping fullscreen must return the native responder to HTML without losing the detail trigger')
  const focusChecks = { nativeFullscreenFocus: true, stoppedDetailTriggerRestored: true, htmlResponderRestored: true }
  const detailRoute = await page.evaluate(() => window.location.hash)
  await page.waitForFunction(() => !window.history.state?.avOverlay)
  await detailPlay.click()
  const historySession = await waitForState(page, state => state?.phase === 'playing' && state.position > 0.5, 'viewing history playback')
  const historyId = historySession.sessionId
  await page.evaluate(id => window.api.playback.control(id, { kind: 'pause', paused: true }), historyId)
  await waitForState(page, state => state?.phase === 'paused', 'history pause')
  const historyPosition = (await page.evaluate(() => window.api.playback.snapshot())).position
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  await page.waitForFunction(() => window.history.state?.avOverlay?.kind === 'playback-options')
  await page.evaluate(() => window.history.back())
  await page.getByRole('complementary', { name: '播放选项', exact: true }).waitFor({ state: 'hidden' })
  assert.equal(await page.evaluate(() => window.history.state?.avOverlay?.kind), 'playback-expanded')
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await waitForState(page, state => state?.presentation === 'fullscreen', 'history fullscreen')
  await page.waitForTimeout(1500)
  await page.waitForFunction(() => window.history.state?.avOverlay?.kind === 'playback-fullscreen')
  await page.evaluate(() => window.history.back())
  await waitForState(page, state => state?.presentation === 'expanded', 'back exits fullscreen first')
  await page.waitForTimeout(1500)
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), false)
  await page.evaluate(() => window.history.back())
  await waitForState(page, state => state?.presentation === 'docked', 'back collapses expanded playback')
  assert.equal(await page.evaluate(() => window.location.hash), detailRoute, 'viewing back must not leave the movie detail')
  assert.equal(await page.evaluate(() => window.history.state?.avOverlay), undefined)
  const collapsed = await page.evaluate(() => window.api.playback.snapshot())
  assert.equal(collapsed.sessionId, historyId)
  assert.equal(collapsed.paused, true)
  assert.ok(Math.abs(collapsed.position - historyPosition) < 0.1)
  assert.equal(await application.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    return require(app.getAppPath() + '/out/native-playback/playback.node').inspect().loadedFiles
  }), 1)
  // Docked playback must not consume an ordinary page back.
  await page.evaluate(() => window.history.back())
  await page.waitForFunction(() => window.location.hash === '#/libraries/1')
  assert.equal((await page.evaluate(() => window.api.playback.snapshot())).sessionId, historyId)
  await page.getByRole('button', { name: /^PLAYBACK-1 未刮削/ }).click()
  await page.getByRole('button', { name: '恢复展开', exact: true }).click()
  await page.waitForFunction(() => window.history.state?.avOverlay?.kind === 'playback-expanded')
  await page.getByRole('button', { name: '停止播放', exact: true }).click()
  await waitForState(page, state => state === null, 'history explicit stop')
  await page.waitForFunction(() => !window.history.state?.avOverlay)
  assert.equal(await page.evaluate(() => window.location.hash), detailRoute)
  const historyChecks = { optionsBack: true, fullscreenBack: true, expandedBack: true, dockedPageBack: true, explicitStopConsumesMarker: true,
    samePausedSession: historyId, loadedFiles: 1 }
  // Reopen with recording off to preserve a live application for manual UI acceptance.
  assert.equal((await page.evaluate(target => window.api.player.play(target.libraryId, target.videoId), target)).ok, true)
  await waitForState(page, state => state?.phase === 'playing' && state.position > 0.5 && state.resumePosition === null, 'disabled resume starts from zero')
  const resumeChecks = { savedPosition: savedPoint.position, preparedPosition: waitingResume.resumePosition, narrowResume, privateEofPreserved: true, globalOffPreserved: true }
  const errorChecks = { controlledMessage: failed.error, retriedSameResource: true, nativeReleased: true }
  const report = { status: 'partial acceptance passed', directory, initial, paused, adjustedSubtitles, subtitleClearance, hiddenControls, resumeChecks, errorChecks, focusChecks, historyChecks,
    checks: ['real application startup', 'default player.play / openResource routing', 'options query the scoped file source and expose external open during playback', 'device volume survives stop and decoder replacement', 'H264/VideoToolbox and CoreAudio', 'expanded/docked/fullscreen same session', 'pause and exact seek', 'exact time form validation', 'embedded SRT size/delay controls', 'fullscreen subtitle/control separation', 'auto-hide restores native viewport', 'default-off progress file absent', 'recording preference uses saved draft', 'paused resume preparation and continue/from-start choices', 'private EOF preserves old progress', 'global off stops recording immediately', 'cancel clear preserves progress', 'controlled format error', 'explicit retry rechecks same resource', 'error releases native decoder', 'native fullscreen focus and detail trigger restoration', 'real browser history closes options/fullscreen/expanded before page back', 'explicit stop consumes viewing marker'],
    pending: ['native screen/mini-video frame inspection', 'fullscreen native control interaction', 'remote source', 'full feature/packaging acceptance'], errors }
  assert.deepEqual(errors, [])
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  if (process.argv.includes('--keep-open')) {
    keepOpen = true
    if (process.argv.includes('--observe-focus')) {
      const live = await page.evaluate(() => window.api.playback.snapshot())
      await page.evaluate(id => window.api.playback.control(id, { kind: 'pause', paused: true }), live.sessionId)
      await waitForState(page, state => state?.phase === 'paused', 'prepare keyboard observation')
    }
    let lastObservation = ''
    const observation = process.argv.includes('--observe-focus') ? setInterval(async () => {
      try {
        const native = await application.evaluate(({ app, BrowserWindow }) => {
          const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
          const state = require(app.getAppPath() + '/out/native-playback/playback.node').inspect()
          const window = BrowserWindow.getAllWindows()[0]
          return { alive: state.alive, focusedControl: state.focusedControl, fullscreenControlsVisible: state.fullscreenControlsVisible,
            webContentsFocused: window?.webContents.isFocused(),
            loadedFiles: state.loadedFiles }
        })
        const state = await page.evaluate(async () => {
          const playback = await window.api.playback.snapshot()
          return { sessionId: playback?.sessionId, presentation: playback?.presentation, phase: playback?.phase,
            paused: playback?.paused, position: playback?.position, volume: playback?.volume,
            focusedElement: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName,
            route: window.location.hash.split('?')[0], viewingHistory: window.history.state?.avOverlay?.kind ?? null,
            focusedButton: document.activeElement instanceof HTMLButtonElement ? document.activeElement.textContent?.trim().slice(0, 80) : undefined }
        })
        const value = { native, state }
        fs.writeFileSync(path.join(output, 'focus-observation.json'), JSON.stringify(value, null, 2))
        const key = JSON.stringify([native, state.sessionId, state.presentation, state.phase, state.paused, state.volume, state.focusedElement, state.route, state.viewingHistory])
        if (key !== lastObservation) {
          lastObservation = key
          fs.appendFileSync(path.join(output, 'focus-observations.jsonl'), JSON.stringify(value) + '\n')
        }
      } catch { /* Window shutdown invalidates observations. */ }
    }, 1000) : null
    console.log(`Acceptance window ready; isolated catalog: ${directory}`)
    await new Promise(resolve => application.on('close', resolve))
    if (observation) clearInterval(observation)
  } else {
    await page.getByRole('button', { name: '停止播放', exact: true }).click()
    await waitForState(page, state => state === null, 'stop')
    assert.equal(await page.locator('[data-playback-session]').count(), 0)
    console.log('macOS partial application playback acceptance passed')
  }
} catch (error) {
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, directory, errors }, null, 2))
  throw error
} finally { if (application && !keepOpen) console.log(JSON.stringify({ cleanup: await closeAcceptance(application) })) }
