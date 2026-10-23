import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { captureAcceptanceFrame, captureAcceptanceImage, closeAcceptance, recordAcceptanceCleanup, createAcceptanceDirectory, launchAcceptance, output, seedAcceptanceCatalog, waitForState } from './playback-acceptance-support.mjs'
import { prepareNonRecordingPlayback } from './playback-acceptance-settings.mjs'

if (!['darwin', 'win32'].includes(process.platform)) throw new Error('This acceptance runner covers macOS and Windows only')
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
let application, report
let keepOpen = false
const errors = []
try {
  application = await launchAcceptance(directory)
  const page = await application.firstWindow()
  const clickChrome = async (name, title = false) => {
    const state = await page.evaluate(() => window.api?.playback?.snapshot())
    if (state?.presentation === 'fullscreen' && state.rendererFullscreenControls) {
      const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      await page.mouse.move(size.width / 2, title ? 2 : size.height - 2)
    }
    await page.getByRole('button', { name, exact: true }).click()
  }
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
  await prepareNonRecordingPlayback(page)
  const result = await page.evaluate(target => window.api.player.play(target.libraryId, target.videoId), target)
  assert.equal(result.ok, true, JSON.stringify(result))
  const initial = await waitForState(page, state => state?.phase === 'playing' && state.position > 0.5, 'video did not start')
  fs.writeFileSync(path.join(output, 'initial-state.json'), JSON.stringify(initial, null, 2))
  if (process.platform === 'darwin') assert.equal(initial.info.hardwareDecoder, 'videotoolbox')
  assert.equal(initial.info.audioOutput, process.platform === 'win32' ? 'wasapi' : 'coreaudio')
  const id = initial.sessionId
  const seekDragChecks = []
  const dragSeek = async fraction => {
    const slider = page.getByRole('slider', { name: '播放进度', exact: true })
    const box = await slider.boundingBox()
    assert.ok(box, 'expanded playback seek slider is visible')
    const before = await page.evaluate(() => window.api.playback.snapshot())
    const value = Number(await slider.inputValue())
    const x = box.x + 8 + (box.width - 16) * value / before.duration
    await page.mouse.move(x, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + 8 + (box.width - 16) * fraction, box.y + box.height / 2, { steps: 8 })
    const requested = Number(await slider.inputValue())
    assert.ok(Math.abs(requested - before.position) > 5, 'mouse drag changes the seek target')
    await page.mouse.up()
    const samples = []
    for (let sample = 0; sample < 6; sample++) {
      const displayed = Number(await slider.inputValue())
      assert.ok(Math.abs(displayed - requested) < 2, `released seek thumb reverted: ${displayed} instead of ${requested}`)
      samples.push(displayed)
      await page.waitForTimeout(100)
    }
    const after = await waitForState(page, state => !state.seeking && Math.abs(state.position - requested) < 2, 'dragged seek completion')
    assert.equal(after.paused, before.paused, 'dragging preserves playing/paused intent')
    seekDragChecks.push({ paused: before.paused, requested, samples, actual: after.position })
  }
  await dragSeek(0.6)
  await dragSeek(0.2)
  await page.evaluate(id => window.api.playback.control(id, { kind: 'pause', paused: true }), id)
  await waitForState(page, state => state.paused, 'pause before drag')
  await dragSeek(0.5)
  await page.evaluate(id => window.api.playback.control(id, { kind: 'pause', paused: false }), id)
  await waitForState(page, state => !state.paused, 'resume after drag')
  fs.writeFileSync(path.join(output, 'seek-drag-state.json'), JSON.stringify(seekDragChecks, null, 2))
  await clickChrome('播放设置')
  await page.waitForFunction(() => document.querySelector('button[aria-label="播放来源"]')?.textContent.includes('测试视频 1'))
  assert.equal(await page.getByRole('button', { name: '播放来源', exact: true }).isDisabled(), true, 'one file must not offer a fictitious alternative')
  assert.equal(await page.getByRole('button', { name: '使用外部播放器打开', exact: true }).isEnabled(), true, 'external open is available before an error')
  assert.equal((await page.evaluate(() => window.api.playback.snapshot())).sessionId, id, 'reading options must preserve playback')
  await clickChrome('播放设置')
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
  if (fullscreenState.rendererFullscreenControls) {
    const videoBounds = () => page.getByRole('button', { name: '视频画面，单击播放或暂停，双击全屏', exact: true }).boundingBox()
    const fullscreenVideo = await videoBounds()
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    assert.deepEqual(fullscreenVideo, { x: 0, y: 0, ...viewport }, 'fullscreen video spans the complete window behind chrome')
    await clickChrome('播放设置')
    await page.getByRole('complementary', { name: '播放设置', exact: true }).waitFor()
    const settingsChrome = await page.evaluate(() => {
      const root = document.querySelector('[data-playback-session]')
      const header = root.querySelector('header').getBoundingClientRect()
      const settings = root.querySelector('aside[aria-label="播放设置"]').getBoundingClientRect()
      return { header: root.dataset.headerVisible, controls: root.dataset.controlsVisible, headerBottom: header.bottom, settingsTop: settings.top }
    })
    assert.equal(settingsChrome.header, 'true', 'fullscreen settings keep the title bar visible')
    assert.equal(settingsChrome.controls, 'true', 'fullscreen settings keep the toolbar visible')
    assert.equal(settingsChrome.settingsTop, settingsChrome.headerBottom, 'settings meet the title bar without a gap')
    assert.equal((await page.evaluate(() => window.api.playback.snapshot())).sessionId, id)
    assert.deepEqual(await videoBounds(), fullscreenVideo, 'opening settings overlays video without resizing it')
    await page.getByRole('button', { name: '关闭播放设置', exact: true }).click()
    await page.mouse.move(viewport.width / 2, viewport.height / 2)
    await page.waitForFunction(() => document.querySelector('[data-playback-session]').dataset.headerVisible === 'false')
    assert.deepEqual(await videoBounds(), fullscreenVideo, 'closing settings restores hover chrome without resizing video')
    await clickChrome('播放设置')
    await page.getByRole('tab', { name: '字幕', exact: true }).click()
    await page.getByRole('button', { name: '字幕', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[role="listbox"]'))
    await page.waitForTimeout(200)
    const clipped = await application.evaluate(({ app }) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
      return require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node').inspect()
    })
    if (process.platform === 'win32') {
      assert.ok(clipped.occlusionRegions > 0, 'HTML quick menu clips only its own native video intersection')
      assert.ok(clipped.alive && clipped.presentedFrames > 0, 'native video keeps rendering with the quick menu open')
    } else {
      assert.ok(clipped.alive && clipped.nativeFrames > 0, 'Canvas remains composed under the HTML menu')
      await page.locator('canvas[data-playback-surface]').waitFor()
    }
    await page.getByRole('option', { name: '关闭字幕', exact: true }).click()
    await page.getByRole('button', { name: '关闭播放设置', exact: true }).click()
    await page.mouse.move(viewport.width / 2, viewport.height - 2)
    const fullSlider = page.getByRole('slider', { name: '播放进度', exact: true })
    const fullBox = await fullSlider.boundingBox()
    await page.mouse.click(fullBox.x + 6 + (fullBox.width - 12) * 0.7, fullBox.y + fullBox.height / 2)
    const clickedSeek = await waitForState(page, state => !state.seeking && Math.abs(state.position - 84) < 2, 'fullscreen click seek')
    assert.equal(clickedSeek.paused, false)
    const fullVolume = page.getByRole('slider', { name: '音量', exact: true })
    const volumeBox = await fullVolume.boundingBox()
    await page.mouse.click(volumeBox.x + 6 + (volumeBox.width - 12) * 0.25, volumeBox.y + volumeBox.height / 2)
    await waitForState(page, state => Math.abs(state.volume - 25) <= 1, 'fullscreen click volume')
  }
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
  // The old exact-time form was removed; exercise the actual progress control.
  const progress = page.getByRole('slider', { name: '播放进度', exact: true })
  await progress.focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await waitForState(page, state => state?.paused && !state.seeking && Math.abs(state.position - 60) < 0.2, 'precise progress seek preserves pause')
  await progress.focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowLeft')
  await waitForState(page, state => state?.paused && !state.seeking && Math.abs(state.position - 35) < 0.2, 'progress keyboard steps preserve pause')
  await clickChrome('播放设置')
  await page.getByRole('tab', { name: '字幕', exact: true }).click()
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
  await captureAcceptanceFrame(application, output, 'baseline', { baseline: true })
  await page.evaluate(({ id, subtitleId }) => window.api.playback.control(id, { kind: 'track', type: 'sub', id: subtitleId }), { id: withSubtitles.sessionId, subtitleId })
  await waitForState(page, state => state.tracks.some(track => track.type === 'sub' && track.selected), 'subtitle clearance')
  await page.evaluate(id => window.api.playback.control(id, { kind: 'seek', seconds: 65 }), withSubtitles.sessionId)
  await page.waitForTimeout(300)
  const capturedSubtitles = await captureAcceptanceImage(application)
  const subtitleClearance = await application.evaluate(({ app, nativeImage }, { frame, outputDirectory }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const baseline = globalThis.playbackAcceptanceBaseline
    delete globalThis.playbackAcceptanceBaseline
    for (const [name, image] of [['baseline', baseline], ['subtitles', frame]]) {
      require('node:fs').writeFileSync(require('node:path').join(outputDirectory, name + '.png'),
        nativeImage.createFromBitmap(Buffer.from(image.data), { width: image.width, height: image.height }).toPNG())
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
  }, { frame: capturedSubtitles, outputDirectory: output })
  if (fullscreenState.rendererFullscreenControls) {
    const geometry = await page.evaluate(() => {
      const root = document.querySelector('[data-playback-session]')
      const slider = root.querySelector('input[aria-label="播放进度"]')
      const video = root.querySelector('button[aria-label^="视频画面"]')
      return { controlsTop: slider.parentElement.parentElement.getBoundingClientRect().top, video: video.getBoundingClientRect().toJSON() }
    })
    subtitleClearance.controlsTop = (geometry.controlsTop - geometry.video.top) * subtitleClearance.height / geometry.video.height
  }
  fs.writeFileSync(path.join(output, 'subtitle-clearance.json'), JSON.stringify(subtitleClearance, null, 2))
  assert.ok(subtitleClearance.count > 100, 'subtitle pixels must actually be rendered')
  assert.ok(Number.isFinite(subtitleClearance.controlsTop), 'fullscreen toolbar geometry is available')
  if (!fullscreenState.rendererFullscreenControls) assert.ok(subtitleClearance.bottom < subtitleClearance.controlsTop, `Subtitle overlaps fullscreen controls: ${JSON.stringify(subtitleClearance)}`)
  await page.evaluate(id => window.api.playback.control(id, { kind: 'pause', paused: false }), withSubtitles.sessionId)
  // Win32 controls deliberately stay visible while a native control has focus.
  // Claim the window before testing inactivity so its video receives focus.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus())
  await waitForState(page, state => state.phase === 'playing', 'resume before auto-hide')
  if (fullscreenState.rendererFullscreenControls) {
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    await page.mouse.move(size.width / 2, size.height / 2)
  }
  await page.waitForTimeout(3500)
  const { width, height, controlsTop } = await captureAcceptanceImage(application)
  const hiddenControls = { width, height, controlsTop }
  assert.equal(hiddenControls.controlsTop, undefined, 'fullscreen controls auto-hide while playing')
  if (fullscreenState.rendererFullscreenControls) {
    assert.equal(await page.getByRole('slider', { name: '播放进度', exact: true }).isVisible(), false, 'renderer toolbar auto-hides while playing')
    assert.deepEqual({ width: hiddenControls.width, height: hiddenControls.height },
      { width: subtitleClearance.width, height: subtitleClearance.height }, 'showing and hiding chrome keeps the native video size unchanged')
  } else assert.ok(hiddenControls.height > subtitleClearance.height, 'auto-hide releases the native video inset')
  await page.evaluate(id => window.api.playback.control(id, { kind: 'pause', paused: true }), withSubtitles.sessionId)
  await page.evaluate(id => window.api.playback.control(id, { kind: 'presentation', value: 'expanded' }), withSubtitles.sessionId)
  await page.waitForTimeout(1500)
  await clickChrome('停止播放', true)
  await waitForState(page, state => state === null, 'stop before resume acceptance')
  const progressFile = path.join(directory, 'playback-progress.json')
  assert.equal(fs.existsSync(progressFile), false, 'explicitly disabled recording creates no progress file')
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
  await clickChrome('停止播放', true)
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
  await clickChrome('停止播放', true)
  const beforeDisabled = fs.readFileSync(progressFile, 'utf8')
  assert.equal((await page.evaluate(target => window.api.player.play(target.libraryId, target.videoId), target)).ok, true)
  await waitForState(page, state => state?.resumePosition > 40 && state.phase === 'paused', 'resume before from-start choice')
  await page.getByRole('button', { name: '从头播放', exact: true }).click()
  await waitForState(page, state => state?.phase === 'playing' && state.position > 0.5 && state.position < 3, 'explicit from-start choice')
  await page.getByRole('button', { name: '收起到底栏', exact: true }).click()
  await waitForState(page, state => state?.presentation === 'docked', 'dock before disabling recording')
  await recordingSwitch.uncheck()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await waitForState(page, state => state?.recordingProgress === false, 'global off immediately stops current recording')
  await clickChrome('停止播放', true)
  assert.equal(fs.readFileSync(progressFile, 'utf8'), beforeDisabled, 'global off does not update or remove old progress')
  await page.getByRole('button', { name: '清除全部本机续播进度', exact: true }).click()
  await page.getByRole('dialog', { name: '清除全部本机续播进度', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(fs.readFileSync(progressFile, 'utf8'), beforeDisabled, 'canceling clear retains all progress')
  const unplayableTarget = JSON.parse(fs.readFileSync(path.join(directory, 'targets.json'), 'utf8'))[2]
  assert.equal((await page.evaluate(target => window.api.playback.open(target), unplayableTarget)).ok, true)
  const failed = await waitForState(page, state => state?.phase === 'error', 'unsupported media error')
  assert.match(failed.error, /格式/)
  assert.equal(failed.presentation, 'expanded')
  assert.match(await page.getByRole('alert').innerText(), /格式/)
  await page.screenshot({ path: path.join(output, 'format-error.png') })
  await page.getByRole('button', { name: '重试所选资源', exact: true }).click()
  const retried = await waitForState(page, state => state?.phase === 'error' && state.sessionId !== failed.sessionId, 'explicit error retry')
  assert.deepEqual(retried.target, failed.target, 'retry never changes resource')
  assert.equal(retried.recordingProgress, false, 'retry respects the disabled global recording setting')
  assert.equal(await application.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    return require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node').inspect().alive
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
  // isFullScreen/styleMask can become true before AppKit finishes replacing the
  // responder. Checking native focus before this event misses that late reset.
  const enteredFullscreen = application.evaluate(({ BrowserWindow }) => new Promise((resolve, reject) => {
    const window = BrowserWindow.getAllWindows()[0]
    const finished = () => { clearTimeout(timer); resolve(true) }
    const timer = setTimeout(() => { window.off('enter-full-screen', finished); reject(new Error('Fullscreen transition did not finish')) }, 5000)
    window.once('enter-full-screen', finished)
  })).then(() => null, error => error)
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await waitForState(page, state => state?.presentation === 'fullscreen', 'detail fullscreen')
  const transitionFailure = await enteredFullscreen
  if (transitionFailure) throw transitionFailure
  if (process.platform === 'darwin') {
    await page.locator('button[aria-label^="视频画面"]').focus()
    assert.ok(await page.evaluate(() => document.activeElement?.matches('button[aria-label^="视频画面"]')), 'normal macOS fullscreen keeps focus in HTML')
  } else {
    const focusDeadline = Date.now() + 5000
    while (!await application.evaluate(({ app }) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
      return require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node').inspect().focusedControl === 'video'
    })) {
      if (Date.now() > focusDeadline) throw new Error('Fullscreen did not acquire native video focus')
      await page.waitForTimeout(100)
    }
  }
  assert.equal(await application.evaluate(({ app }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    return Object.hasOwn(require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node').inspect(), 'actions')
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
  const focusChecks = { rendererFullscreenFocus: process.platform === 'darwin', nativeFullscreenFocus: process.platform === 'win32', stoppedDetailTriggerRestored: true, htmlResponderRestored: true }
  const detailRoute = await page.evaluate(() => window.location.hash)
  await page.waitForFunction(() => !window.history.state?.avOverlay)
  await detailPlay.click()
  const historySession = await waitForState(page, state => state?.phase === 'playing' && state.position > 0.5, 'viewing history playback')
  const historyId = historySession.sessionId
  await page.evaluate(id => window.api.playback.control(id, { kind: 'pause', paused: true }), historyId)
  await waitForState(page, state => state?.phase === 'paused', 'history pause')
  const historyPosition = (await page.evaluate(() => window.api.playback.snapshot())).position
  const expandedMarker = await page.evaluate(() => window.history.state?.avOverlay)
  await clickChrome('播放设置')
  assert.deepEqual(await page.evaluate(() => window.history.state?.avOverlay), expandedMarker, 'settings share the viewing marker')
  await page.evaluate(() => window.history.back())
  await page.getByRole('complementary', { name: '播放设置', exact: true }).waitFor({ state: 'hidden' })
  await waitForState(page, state => state?.presentation === 'docked', 'back docks playback with settings open')
  assert.equal(await page.evaluate(() => window.location.hash), detailRoute)
  await page.getByRole('button', { name: '恢复展开', exact: true }).click()
  await waitForState(page, state => state?.presentation === 'expanded', 'restore for fullscreen history')
  const fullscreenMarker = await page.evaluate(() => window.history.state?.avOverlay)
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await waitForState(page, state => state?.presentation === 'fullscreen', 'history fullscreen')
  await page.waitForTimeout(1500)
  assert.deepEqual(await page.evaluate(() => window.history.state?.avOverlay), fullscreenMarker, 'fullscreen shares the viewing marker')
  await page.evaluate(() => window.history.back())
  await waitForState(page, state => state?.presentation === 'docked', 'one back docks fullscreen playback')
  await page.waitForTimeout(1500)
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()), false)
  await page.getByRole('button', { name: '恢复展开', exact: true }).click()
  await waitForState(page, state => state?.presentation === 'expanded', 'restore for expanded history')
  const retiredToken = await page.evaluate(() => window.history.state?.avOverlay?.token)
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
    return require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node').inspect().loadedFiles
  }), 1)
  await page.evaluate(() => window.history.forward())
  await page.waitForFunction(token => window.history.state?.avOverlay?.token === token, retiredToken)
  assert.equal((await page.evaluate(() => window.api.playback.snapshot())).presentation, 'docked', 'Forward never resurrects a consumed view')
  await page.getByRole('button', { name: '恢复展开', exact: true }).click()
  await page.waitForFunction(token => window.history.state?.avOverlay?.kind === 'playback-expanded'
    && window.history.state.avOverlay.token !== token, retiredToken)
  await page.evaluate(() => window.history.back())
  await waitForState(page, state => state?.presentation === 'docked', 'back after reopening a retired viewing slot')
  assert.equal(await page.evaluate(() => window.history.state?.avOverlay), undefined, 'no empty viewing step is left behind')
  // Docked playback must not consume an ordinary page back.
  await page.evaluate(() => window.history.back())
  await page.waitForFunction(() => window.location.hash === '#/libraries/1')
  assert.equal((await page.evaluate(() => window.api.playback.snapshot())).sessionId, historyId)
  await page.getByRole('button', { name: /^PLAYBACK-1 未刮削/ }).click()
  await page.getByRole('button', { name: '恢复展开', exact: true }).click()
  await page.waitForFunction(() => window.history.state?.avOverlay?.kind === 'playback-expanded')
  if (process.platform === 'win32') {
    await page.reload()
    await page.getByRole('button', { name: '收起到底栏', exact: true }).waitFor({ state: 'visible' })
    await page.evaluate(() => window.history.back())
    await waitForState(page, state => state?.presentation === 'docked', 'reloaded renderer reclaims the live viewing marker')
    assert.equal(await page.evaluate(() => window.location.hash), detailRoute)
    assert.equal((await page.evaluate(() => window.api.playback.snapshot())).sessionId, historyId)
    await page.getByRole('button', { name: '恢复展开', exact: true }).click()
    await page.waitForFunction(() => window.history.state?.avOverlay?.kind === 'playback-expanded')
  }
  await clickChrome('停止播放', true)
  await waitForState(page, state => state === null, 'history explicit stop')
  await page.waitForFunction(() => !window.history.state?.avOverlay)
  assert.equal(await page.evaluate(() => window.location.hash), detailRoute)
  const historyChecks = { optionsBackDocks: true, fullscreenBackDocks: true, expandedBack: true, retiredViewingSlotReused: true,
    rendererReloadReclaimsMarker: process.platform === 'win32', dockedPageBack: true, explicitStopConsumesMarker: true,
    samePausedSession: historyId, loadedFiles: 1 }
  // Reopen with recording off to preserve a live application for manual UI acceptance.
  assert.equal((await page.evaluate(target => window.api.player.play(target.libraryId, target.videoId), target)).ok, true)
  await waitForState(page, state => state?.phase === 'playing' && state.position > 0.5 && state.resumePosition === null, 'disabled resume starts from zero')
  let reloadChecks
  if (process.platform === 'darwin' && !process.argv.includes('--keep-open')) {
    // Navigation invalidates consumer ownership; never demand unsafe recovery.
    await page.reload()
    const invalidated = await waitForState(page, state => state?.phase === 'error', 'reload fails closed')
    assert.match(invalidated.error, /完全退出并重启应用/)
    assert.match(await page.getByRole('alert').innerText(), /完全退出并重启应用/)
    const native = await application.evaluate(({ app }) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
      return require(app.getAppPath() + '/out/native-playback/playback.node').inspect()
    })
    assert.equal(native.alive, false, 'navigation must stop the producer')
    assert.ok(Number.isInteger(native.outstandingSurfaces) && native.outstandingSurfaces >= 0 && native.outstandingSurfaces <= 3,
      'unknown ownership remains bounded, never forcibly recycled')
    reloadChecks = { controlledError: invalidated.error, native }
  }
  const resumeChecks = { savedPosition: savedPoint.position, preparedPosition: waitingResume.resumePosition, narrowResume, privateEofPreserved: true, globalOffPreserved: true }
  const errorChecks = { controlledMessage: failed.error, retriedSameResource: true, nativeReleased: true }
  report = { status: 'partial acceptance passed', directory, initial, paused, adjustedSubtitles, subtitleClearance, hiddenControls, resumeChecks, errorChecks, focusChecks, historyChecks, reloadChecks,
    platform: `${process.platform}/${process.arch}`,
    checks: ['real application startup', 'default player.play / openResource routing', 'options query the scoped file source and expose external open during playback', 'device volume survives stop and decoder replacement', 'H264 decode and platform audio output (decoder recorded in initial state)', 'expanded/docked/fullscreen same session', 'pause and exact seek', 'actual progress keyboard steps preserve pause', 'embedded SRT size/delay controls', fullscreenState.rendererFullscreenControls ? 'fullscreen video size stays fixed behind chrome and settings' : 'fullscreen subtitle/control separation', fullscreenState.rendererFullscreenControls ? 'auto-hide reveals the full frame without resizing' : 'auto-hide restores native viewport', 'default-on preference and explicit non-recording progress file absence', 'recording preference uses saved draft', 'paused resume preparation and continue/from-start choices', 'private EOF preserves old progress', 'global off stops recording immediately', 'cancel clear preserves progress', 'controlled format error', 'explicit retry rechecks same resource', 'error releases native decoder', 'fullscreen focus after animation and detail trigger restoration', 'one history back docks settings/fullscreen/expanded before page back', 'retired viewing slot reuse', ...(reloadChecks ? ['renderer reload stops production and requires restart'] : process.platform === 'win32' ? ['renderer reload reclaims viewing marker'] : []), 'explicit stop consumes viewing marker'],
    pending: [process.platform === 'win32' ? 'native screen/mini-video frame inspection' : 'physical display inspection', ...(process.platform === 'win32' ? ['fullscreen native control interaction'] : []), 'remote source', 'full feature/packaging acceptance'], errors }
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
          const state = require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node').inspect()
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
    await clickChrome('停止播放', true)
    await waitForState(page, state => state === null, 'stop')
    assert.equal(await page.locator('[data-playback-session]').count(), 0)
    console.log(`${process.platform} partial application playback acceptance passed`)
  }
} catch (error) {
  const failure = { status: 'failed', platform: `${process.platform}/${process.arch}`, message: error.message, directory, errors }
  if (application) failure.observation = await application.evaluate(({ app, BrowserWindow }) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
    const native = require(app.isPackaged ? process.resourcesPath + '/native-playback/playback.node' : app.getAppPath() + '/out/native-playback/playback.node').inspect()
    const window = BrowserWindow.getAllWindows()[0]
    return { packaged: app.isPackaged, resourcesPath: process.resourcesPath, focused: window?.isFocused(),
      fullscreen: window?.isFullScreen(), webContentsFocused: window?.webContents.isFocused(),
      focusedControl: native.focusedControl, alive: native.alive, loadedFiles: native.loadedFiles }
  }).catch(() => null)
  report = failure
  fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify(failure, null, 2))
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(failure, null, 2))
  throw error
} finally {
  if (application && !keepOpen) {
    const cleanup = await closeAcceptance(application)
    console.log(JSON.stringify({ cleanup }))
    recordAcceptanceCleanup(report, cleanup)
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    if (report.status === 'failed') fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify(report, null, 2))
  }
}
