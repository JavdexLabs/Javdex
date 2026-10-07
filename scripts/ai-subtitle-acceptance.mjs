// Real offline engines + isolated Electron application. Run after desktop:build.
// node --import tsx scripts/ai-subtitle-acceptance.mjs --runtime-root <installed models root> --audio <public Japanese fixture>
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { AI_SUBTITLE_RUNTIME_VERSION } from '../apps/desktop/src/main/player/aiSubtitles/runtimeManifest.ts'
import { createAcceptanceDirectory, seedAcceptanceCatalog, launchAcceptance, waitForState, nativeEvidence,
  captureAcceptanceFrame, closeAcceptance, recordAcceptanceCleanup } from './playback-acceptance-support.mjs'

assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
const argument = (name, fallback) => { const index = process.argv.indexOf(name); return path.resolve(index >= 0 ? process.argv[index + 1] : fallback) }
const runtimeRoot = argument('--runtime-root', '.tmp-ai-subtitle/runtime')
const audio = argument('--audio', '.tmp-ai-subtitle/sample-ja.wav')
const runtime = path.join(runtimeRoot, AI_SUBTITLE_RUNTIME_VERSION)
assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, 'installed.json'), 'utf8')).version, AI_SUBTITLE_RUNTIME_VERSION)
assert.ok(fs.statSync(audio).isFile())
const output = path.resolve('out/playback-acceptance/ai-subtitles')
fs.mkdirSync(output, { recursive: true })
const video = path.join(output, 'japanese-two-tracks.mp4')
const ffmpeg = path.join(runtime, 'ffmpeg/ffmpeg.exe')
const encoded = spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x1f3e60:s=960x540:r=24',
  '-i', audio, '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '90', '-map', '0:v', '-map', '1:a', '-map', '2:a',
  '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'aac', '-metadata:s:a:0', 'language=jpn', '-metadata:s:a:1', 'title=Silence', '-y', video],
{ windowsHide: true, timeout: 60000, encoding: 'utf8' })
assert.equal(encoded.status, 0, encoded.stderr)
const directory = createAcceptanceDirectory('ai-subtitles-')
fs.mkdirSync(path.join(directory, 'ai-subtitles'), { recursive: true })
fs.symlinkSync(runtimeRoot, path.join(directory, 'ai-subtitles/models'), 'junction')
const [target] = seedAcceptanceCatalog(directory, [video])
const report = { status: 'running', scope: 'Windows x64, public Japanese sample, two audio tracks, actual local inference and mpv pixels', checks: [] }
let application
try {
  application = await launchAcceptance(directory, 'ai-subtitle-application.log')
  // Prove inference succeeds with all non-loopback fetches rejected, after model installation.
  await application.evaluate(() => {
    const original = globalThis.fetch
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.hostname !== '127.0.0.1') throw new Error('Acceptance rejects external inference requests')
      return original(input, init)
    }
  })
  const page = await application.firstWindow()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => window.api?.playback)
  assert.equal((await page.evaluate(target => window.api.playback.open(target), target)).ok, true)
  await waitForState(page, value => value?.phase === 'playing' && value.seekable && value.duration > 80, 'Japanese fixture starts')
  const id = (await page.evaluate(() => window.api.playback.snapshot())).sessionId
  const command = command => page.evaluate(({ id, command }) => window.api.playback.aiSubtitleCommand(id, command), { id, command })
  const control = command => page.evaluate(({ id, command }) => window.api.playback.control(id, command), { id, command })
  const ai = () => page.evaluate(() => window.api.playback.aiSubtitleSnapshot())
  async function waitAi(predicate, label, timeout = 180000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { const value = await ai(); if (predicate(value)) return value; await delay(250) }
    throw new Error(`${label}: ${JSON.stringify(await ai())}`)
  }
  assert.equal((await ai()).installed, true)
  await control({ kind: 'pause', paused: true })
  const started = Date.now()
  await command({ action: 'start' })
  const generated = await waitAi(value => value.translatedSeconds >= 30, 'first bilingual chunk')
  report.checks.push({ name: 'actual-offline-bilingual-generation', externalInferenceFetchBlocked: true, elapsedMs: Date.now() - started, generated })
  const isGenerated = track => track.type === 'sub' && /^AI 日中字幕(?:\.ass)?$/.test(track.title ?? '')
  await waitForState(page, value => value.tracks.some(track => isGenerated(track) && track.selected), 'generated track selected')
  const state = await page.evaluate(() => window.api.playback.snapshot())
  const subtitle = state.tracks.find(isGenerated)
  assert.ok(subtitle?.selected, 'generated subtitle must be selected')
  await control({ kind: 'seek', seconds: 2 })
  await waitForState(page, value => !value.seeking && Math.abs(value.position - 2) < 0.5, 'seek to known spoken cue')
  const bilingual = await captureAcceptanceFrame(application, output, 'bilingual-window', { whiteBounds: true })
  assert.ok(bilingual.whiteBounds?.pixels > 50 || bilingual.whitePixels > 50, 'bilingual subtitle pixels required')
  await page.getByRole('button', { name: '播放设置', exact: true }).click()
  await page.getByRole('tab', { name: '字幕', exact: true }).click()
  await page.getByRole('button', { name: '停止 AI 字幕', exact: true }).waitFor()
  await page.screenshot({ path: path.join(output, 'ai-subtitle-settings.png') })
  await page.getByRole('button', { name: '关闭播放设置', exact: true }).click()
  await control({ kind: 'pause', paused: false })
  const advancing = await waitForState(page, value => value.phase === 'playing' && value.position > 5, 'playback advances while generating next chunk')
  assert.ok((await ai()).enabled)
  report.checks.push({ name: 'playback-advances-during-generation', position: advancing.position, subtitle: await ai() })
  await control({ kind: 'pause', paused: true })
  await control({ kind: 'seek', seconds: 2 })
  await waitForState(page, value => !value.seeking && Math.abs(value.position - 2) < 0.5, 'return to spoken cue')
  await control({ kind: 'presentation', value: 'fullscreen' })
  await delay(1000)
  const fullscreen = await captureAcceptanceFrame(application, output, 'bilingual-fullscreen', { whiteBounds: true })
  assert.ok(fullscreen.visiblePixels > 10000, 'video remains visible')
  await command({ action: 'display', value: 'japanese' }); await delay(600)
  const japanese = await captureAcceptanceFrame(application, output, 'japanese-fullscreen', { whiteBounds: true })
  assert.notEqual(japanese.sha256, fullscreen.sha256, 'display mode must change subtitle pixels')
  assert.equal((await nativeEvidence(application)).loadedFiles, 1, 'subtitle updates must not reopen video')
  await control({ kind: 'seek', seconds: 67 })
  await waitAi(value => value.activeStart === 60 || value.translatedSeconds >= 90, 'seek prioritizes destination')
  await control({ kind: 'seek', seconds: 2 })
  await command({ action: 'stop' })
  assert.equal((await ai()).enabled, false)
  await waitForState(page, value => !value.tracks.some(isGenerated), 'generated track removed')
  assert.ok(!(await page.evaluate(() => window.api.playback.snapshot())).tracks.some(isGenerated))
  const restarted = Date.now()
  await command({ action: 'start' }); await waitAi(value => value.translatedSeconds >= 30, 'reuse cached subtitles', 10000)
  report.checks.push({ name: 'cache-reuse', elapsedMs: Date.now() - restarted })
  const audioTracks = (await page.evaluate(() => window.api.playback.snapshot())).tracks.filter(track => track.type === 'audio')
  assert.equal(audioTracks.length, 2)
  await control({ kind: 'track', type: 'audio', id: audioTracks[1].id })
  await waitAi(value => value.phase === 'preparing' || value.recognizedSeconds === 0, 'audio switch resets generation')
  await waitAi(value => value.phase === 'ready' && value.recognizedSeconds >= 30 && value.translatedSeconds >= 30, 'silent alternate audio track')
  await command({ action: 'stop' })
  const final = await nativeEvidence(application)
  assert.equal(final.loadedFiles, 1); assert.equal(final.commandErrors, 0)
  assert.deepEqual(errors, [])
  report.checks.push({ name: 'presentation-seek-audio-switch-stop', native: final, bilingual, fullscreen, japanese })
  // Exit while an uncached chunk is still in inference, rather than only testing idle shutdown.
  await control({ kind: 'track', type: 'audio', id: audioTracks[0].id })
  await waitForState(page, value => value.tracks.some(track => track.type === 'audio' && track.id === audioTracks[0].id && track.selected), 'original audio restored')
  await control({ kind: 'seek', seconds: 67 })
  await command({ action: 'start' })
  await waitAi(value => value.phase === 'recognizing' || value.phase === 'translating', 'active inference before shutdown')
  report.checks.push({ name: 'shutdown-during-active-inference', before: await ai() })
  report.status = 'pass'
} catch (error) { report.status = 'failed'; report.failure = error.stack ?? String(error); throw error }
finally {
  if (application) recordAcceptanceCleanup(report, await closeAcceptance(application))
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ report: path.join(output, 'report.json'), status: report.status }))
}
