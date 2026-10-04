// Real application/native pixel checks, not a mock mpv or a product diagnostics API.
import assert from 'node:assert/strict'
import path from 'node:path'
import sharp from 'sharp'
import { captureAcceptanceFrame, nativeEvidence, waitForState, waitForValue } from './playback-acceptance-support.mjs'
import { bitmapFixture } from './playback-pgs-fixture.mjs'

export async function checkBitmapSubtitlePixels(application, page, directory, prefix) {
  assert.match(prefix, /^[a-z-]+$/)
  const initial = await page.evaluate(() => window.api.playback.snapshot())
  assert.ok(initial?.sessionId)
  const sid = initial.tracks.find(track => track.type === 'sub' && track.codec === 'hdmv_pgs_subtitle' && track.selected)?.id
  assert.ok(sid != null, 'the fixture must have a selected PGS track')
  let intendedPosition = initial.position
  const control = command => page.evaluate(({ id, command }) => window.api.playback.control(id, command), { id: initial.sessionId, command })
  const seek = async seconds => {
    intendedPosition = seconds
    await control({ kind: 'seek', seconds })
    await waitForState(page, state => state?.paused && !state.seeking && Math.abs(state.position - seconds) < 0.15, 'PGS paused seek')
  }
  const capture = (name, options = {}) => captureAcceptanceFrame(application, directory, `${prefix}-${name}`, { ...options, whiteBounds: true })
  const geometry = (frame, cue) => {
    const { canvas, object } = bitmapFixture
    const scale = Math.min(frame.width / canvas.width, frame.height / canvas.height)
    const offset = { x: (frame.width - canvas.width * scale) / 2, y: (frame.height - canvas.height * scale) / 2 }
    const expected = { x: offset.x + (cue.x + object.border) * scale, y: offset.y + (cue.y + object.border) * scale,
      width: (object.width - 2 * object.border) * scale, height: (object.height - 2 * object.border) * scale }
    return { scale, offset, expected, tolerance: Math.max(3, Math.ceil(scale)) }
  }
  const ready = async (name, cue) => {
    const start = Date.now()
    let reads = 0
    const frame = await waitForValue(async () => {
      reads++
      const frame = await capture(name)
      const state = await page.evaluate(() => window.api.playback.snapshot())
      return { ...frame, clock: { position: state?.position, paused: state?.paused, seeking: state?.seeking } }
    }, frame => {
      if (!frame.clock.paused || frame.clock.seeking || Math.abs(frame.clock.position - intendedPosition) >= 0.15) return false
      if (!cue) return frame.whitePixels === 0
      const { expected, tolerance } = geometry(frame, cue)
      // White pixels from a stale, different cue are not completion evidence.
      return frame.whitePixels > 100 && frame.whiteBounds
        && ['x', 'y', 'width', 'height'].every(key => Math.abs(frame.whiteBounds[key] - expected[key]) <= tolerance)
    },
      `PGS native pixels did not ${cue ? 'reconstruct' : 'clear'} at ${name}`, 5000)
    return { ...frame, readyAfterMs: Date.now() - start, reads }
  }
  const checkIdentity = async () => {
    const state = await page.evaluate(() => window.api.playback.snapshot())
    const native = await nativeEvidence(application)
    assert.equal(state.sessionId, initial.sessionId)
    assert.equal(native.loadedFiles, 1)
    assert.equal(native.commandErrors, 0)
  }
  const measure = async (name, frame, cue) => {
    if (!cue) {
      assert.equal(frame.whiteBounds, null, 'cleared PGS must not leave visible bitmap pixels')
      assert.equal(frame.whitePixels, 0)
      return frame
    }
    const { object } = bitmapFixture
    const { scale, offset, expected, tolerance } = geometry(frame, cue)
    assert.ok(frame.whiteBounds, 'PGS must render a white bitmap, not just enumerate a selected track')
    // Bounding bright pixels is not the full rescaled rectangle: integer corner
    // rounding and filtered edge pixels allow at most one source pixel (min 3px).
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(frame.whiteBounds[key] - expected[key]) <= tolerance,
      `PGS ${key} must follow positioned video-space coordinates: ${frame.whiteBounds[key]} vs ${expected[key]}`)
    assert.ok(Math.abs(frame.whitePixels / (3648 * scale * scale) - 1) < 0.16, 'PGS visible area must scale with the same fitted video')
    const current = await sharp(path.join(directory, `${prefix}-${name}.png`)).ensureAlpha().raw().toBuffer()
    const baseline = await sharp(path.join(directory, `${prefix}-${name.replace(/-on$/, '-off')}.png`)).ensureAlpha().raw().toBuffer()
    const { hole } = object
    const points = [
      ['left border', 1.5, object.height / 2], ['right border', object.width - 1.5, object.height / 2],
      ['top border', object.width / 2, 1.5], ['bottom border', object.width / 2, object.height - 1.5],
      ['center hole', hole.x + hole.width / 2, hole.y + hole.height / 2]
    ]
    const transparency = points.map(([name, x, y]) => {
      const px = Math.floor(offset.x + (cue.x + x) * scale), py = Math.floor(offset.y + (cue.y + y) * scale)
      const at = (py * frame.width + px) * 4
      const delta = Math.max(...[0, 1, 2].map(channel => Math.abs(current[at + channel] - baseline[at + channel])))
      assert.ok(delta <= 16, `PGS ${name} must remain transparent over the original video, not become an opaque black patch: ${delta}`)
      return { name, x: px, y: py, delta }
    })
    return { ...frame, expected, transparency }
  }
  const compare = async (name, cue) => {
    const beforeToggle = await ready(`${name}-before-toggle`, cue)
    await control({ kind: 'track', type: 'sub', id: null })
    await waitForState(page, state => !state.tracks.some(track => track.type === 'sub' && track.selected), 'PGS off')
    await page.waitForTimeout(300)
    const off = await capture(`${name}-off`, { baseline: true })
    assert.equal(off.whitePixels, 0)
    await control({ kind: 'track', type: 'sub', id: sid })
    await waitForState(page, state => state.tracks.some(track => track.type === 'sub' && track.id === sid && track.selected), 'PGS on')
    const reconstructed = await ready(`${name}-ready`, cue)
    const on = await capture(`${name}-on`, { compare: true })
    assert.ok(cue ? on.differentPixels > 100 : on.differentPixels === 0, 'PGS display/clear must change only its intended pixels')
    const measured = await measure(`${name}-on`, on, cue)
    await checkIdentity()
    assert.equal((await page.evaluate(() => window.api.playback.snapshot())).paused, true)
    return { ...measured, readiness: { beforeToggle: { reads: beforeToggle.reads, ms: beforeToggle.readyAfterMs },
      reconstructed: { reads: reconstructed.reads, ms: reconstructed.readyAfterMs } } }
  }
  const [first, second] = bitmapFixture.cues
  await control({ kind: 'pause', paused: true })
  await waitForState(page, state => state?.paused, 'pause PGS fixture')
  // First seek of a newly opened session, before sequentially reaching 8s.
  // A warm decoder/cue cache must not disguise a late seek into a long bitmap.
  await seek(19)
  const coldLateCue = await compare('cold-late-cue', second)
  await seek(0.25)
  const beforeCue = await capture('natural-before')
  assert.equal(beforeCue.whitePixels, 0)
  await control({ kind: 'pause', paused: false })
  await waitForState(page, state => !state.paused && state.position >= 1.6 && state.position < 2.6, 'PGS natural onset')
  const visibleCue = await capture('natural-visible')
  assert.ok(visibleCue.whitePixels > 100, 'PGS must appear during actual clock advance')
  await waitForState(page, state => !state.paused && state.position >= 3.6, 'PGS natural clear')
  const afterCue = await capture('natural-cleared')
  assert.equal(afterCue.whitePixels, 0, 'PGS must clear during actual playback, not only after a seek')
  await control({ kind: 'pause', paused: true })
  await waitForState(page, state => state.paused, 'pause after PGS natural timing')
  await checkIdentity()
  await seek(2)
  const firstFrame = await compare('first-expanded', first)
  await seek(4)
  const firstClear = await compare('first-cleared', null)
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '字幕字号', exact: true }).isDisabled(), true, 'bitmap subtitles must not offer plaintext font size')
  await page.getByRole('button', { name: '延后 0.5 秒', exact: true }).click()
  await waitForState(page, state => state.subtitleDelay === 0.5 && state.paused, 'PGS delay UI')
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  await seek(3.25)
  const delayed = await compare('delayed-first', first)
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  await page.getByRole('button', { name: '重置延迟', exact: true }).click()
  await waitForState(page, state => state.subtitleDelay === 0, 'PGS delay reset UI')
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  await seek(3.25)
  const resetDelay = await compare('reset-delay', null)
  await seek(12)
  const expanded = await compare('second-expanded', second)
  await seek(22)
  const secondClear = await compare('second-cleared', null)
  await seek(2)
  const backwards = await compare('backwards-seek', first)
  await seek(12)
  await page.getByRole('button', { name: '收起到底栏', exact: true }).click()
  await waitForState(page, state => state.presentation === 'docked' && state.paused, 'PGS dock keeps pause')
  await page.waitForTimeout(400)
  const docked = await compare('docked', second)
  await page.getByRole('button', { name: '恢复展开', exact: true }).click()
  await waitForState(page, state => state.presentation === 'expanded' && state.paused, 'PGS restore')
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await waitForState(page, state => state.presentation === 'fullscreen' && state.paused, 'PGS fullscreen')
  await page.waitForTimeout(1500)
  const fullscreen = await compare('fullscreen', second)
  assert.ok(Number.isFinite(fullscreen.controlsTop) && fullscreen.bottom < fullscreen.controlsTop,
    'PGS must remain above visible native fullscreen controls')
  await control({ kind: 'presentation', value: 'expanded' })
  await waitForState(page, state => state.presentation === 'expanded' && state.paused, 'PGS exit fullscreen')
  await page.waitForTimeout(1500)
  await checkIdentity()
  assert.ok(Math.abs((await page.evaluate(() => window.api.playback.snapshot())).position - 12) < 0.15)
  return { name: `${prefix} original PGS bitmap, alpha, cue timing, paused seeks and same-session presentations`,
    coldLateCue, firstFrame, firstClear, delayed, resetDelay, expanded, secondClear, backwards, docked, fullscreen,
    naturalTiming: { before: beforeCue, visible: visibleCue, cleared: afterCue } }
}

export async function checkComplexSubtitlePixels(application, page, directory, prefix) {
  assert.match(prefix, /^[a-z-]+$/)
  const initial = await page.evaluate(() => window.api.playback.snapshot())
  assert.ok(initial?.sessionId)
  const sid = initial.tracks.find(track => track.type === 'sub' && track.codec === 'ass' && track.selected)?.id
  assert.ok(sid != null, 'the fixture must have a selected ASS track')
  const control = command => page.evaluate(({ id, command }) => window.api.playback.control(id, command),
    { id: initial.sessionId, command })
  await control({ kind: 'pause', paused: true })
  await control({ kind: 'seek', seconds: 4 })
  await waitForState(page, state => state?.paused && !state.seeking && Math.abs(state.position - 4) < 0.15, 'complex ASS paused frame')
  const compare = async name => {
    await control({ kind: 'track', type: 'sub', id: null })
    await waitForState(page, state => !state.tracks.some(track => track.type === 'sub' && track.selected), 'complex ASS off')
    await page.waitForTimeout(300)
    await captureAcceptanceFrame(application, directory, `${prefix}-${name}-off`, { baseline: true })
    await control({ kind: 'track', type: 'sub', id: sid })
    await waitForState(page, state => state.tracks.some(track => track.type === 'sub' && track.id === sid && track.selected), 'complex ASS on')
    await page.waitForTimeout(300)
    const frame = await captureAcceptanceFrame(application, directory, `${prefix}-${name}-on`, { compare: true })
    assert.ok(frame.differentPixels > 200, 'the selected ASS track must change native pixels')
    for (const count of Object.values(frame.differentQuadrants)) assert.ok(count > 10, 'signs/dialogue must compose in all four quadrants')
    for (const name of ['cyan', 'magenta', 'green', 'yellow', 'red', 'white']) {
      assert.ok(frame.changedColors[name] > 8, `complex ASS ${name} pixels must render`)
    }
    // The green drawing is 120x50, but its independent rectangular clip keeps
    // only 60x50; the cyan drawing is 120x42. Ignoring the clip doubles this ratio.
    const clipRatio = frame.changedColors.green / frame.changedColors.cyan
    assert.ok(Math.abs(clipRatio - 3000 / 5040) < 0.1, `ASS vector clip is not respected: ${clipRatio}`)
    const state = await page.evaluate(() => window.api.playback.snapshot())
    assert.equal(state.sessionId, initial.sessionId)
    assert.equal(state.paused, true)
    assert.equal((await nativeEvidence(application)).loadedFiles, 1)
    return frame
  }
  const expanded = await compare('expanded')
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: '字幕字号', exact: true }).isDisabled(), true)
  await page.getByRole('button', { name: '延后 0.5 秒', exact: true }).click()
  await waitForState(page, state => state.subtitleDelay === 0.5 && state.paused, 'complex ASS delay UI')
  await page.getByRole('button', { name: '重置延迟', exact: true }).click()
  await waitForState(page, state => state.subtitleDelay === 0, 'complex ASS delay reset')
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  await control({ kind: 'seek', seconds: 16 })
  await waitForState(page, state => state.paused && !state.seeking && Math.abs(state.position - 16) < 0.15, 'karaoke later frame')
  const later = await compare('karaoke-later')
  assert.ok(later.changedColors.yellow > expanded.changedColors.yellow * 1.2, 'karaoke fill must advance with media time')
  await control({ kind: 'seek', seconds: 4 })
  await waitForState(page, state => state.paused && !state.seeking && Math.abs(state.position - 4) < 0.15, 'restore ASS comparison time')
  await page.getByRole('button', { name: '收起到底栏', exact: true }).click()
  await waitForState(page, state => state.presentation === 'docked' && state.paused, 'complex ASS dock')
  await page.waitForTimeout(400)
  const docked = await compare('docked')
  await page.getByRole('button', { name: '恢复展开', exact: true }).click()
  await waitForState(page, state => state.presentation === 'expanded' && state.paused, 'complex ASS restore')
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await waitForState(page, state => state.presentation === 'fullscreen' && state.paused, 'complex ASS fullscreen')
  await page.waitForTimeout(1500)
  const fullscreen = await compare('fullscreen')
  assert.ok(Number.isFinite(fullscreen.controlsTop) && fullscreen.bottom < fullscreen.controlsTop,
    'complex ASS must remain above visible native fullscreen controls')
  await control({ kind: 'presentation', value: 'expanded' })
  await waitForState(page, state => state.presentation === 'expanded', 'complex ASS fullscreen exit')
  await page.waitForTimeout(1500)
  const final = await page.evaluate(() => window.api.playback.snapshot())
  assert.equal(final.sessionId, initial.sessionId)
  assert.equal(final.paused, true)
  assert.ok(Math.abs(final.position - 4) < 0.15)
  assert.equal((await nativeEvidence(application)).loadedFiles, 1)
  return { name: `${prefix} complex ASS composition, vector clip, karaoke and same-session presentations`,
    expanded, later, docked, fullscreen }
}

// This mode intentionally needs a real system file-picker operation. It never
// replaces showOpenDialog, supplies a path through renderer IPC, or uploads it.
export async function checkLocalSubtitlePicker(application, page, directory, file, ready) {
  assert.ok(['external.srt', 'complex.ass'].includes(file))
  const before = await page.evaluate(() => window.api.playback.snapshot())
  assert.equal(before?.source, 'remote')
  assert.equal(before.paused, true)
  const originalIds = new Set(before.tracks.filter(track => track.type === 'sub').map(track => track.id))
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  await page.getByRole('button', { name: '选择本机外挂字幕', exact: true }).click()
  ready()
  const codec = file.endsWith('.srt') ? 'subrip' : 'ass'
  const selected = await waitForState(page, state => state?.tracks.some(track => track.type === 'sub' && track.selected
    && !originalIds.has(track.id) && track.codec === codec), `real system picker did not load ${file}`, 120000)
  assert.equal(selected.sessionId, before.sessionId)
  assert.equal(selected.paused, true)
  assert.ok(Math.abs(selected.position - before.position) < 0.15)
  assert.equal((await nativeEvidence(application)).loadedFiles, 1)
  const snapshot = JSON.stringify(selected)
  assert.ok(!snapshot.includes(directory) && !snapshot.includes('?t='), 'no local sidecar path or playback grant in renderer snapshot')
  assert.equal(await page.getByRole('button', { name: '字幕字号', exact: true }).isDisabled(), codec === 'ass')
  if (codec === 'ass') {
    await page.getByRole('button', { name: '播放选项', exact: true }).click()
    return { file, selection: `real ${process.platform} system picker`,
      ...await checkComplexSubtitlePixels(application, page, directory, 'remote-local-ass') }
  }
  await page.getByRole('button', { name: '字幕字号', exact: true }).click()
  await page.getByRole('option', { name: '40', exact: true }).click()
  await waitForState(page, state => state.subtitleSize === 40, 'local SRT size UI')
  await page.getByRole('button', { name: '播放选项', exact: true }).click()
  const sid = selected.tracks.find(track => track.type === 'sub' && track.selected).id
  const control = command => page.evaluate(({ id, command }) => window.api.playback.control(id, command), { id: before.sessionId, command })
  const compare = async (name, minimum) => {
    await control({ kind: 'track', type: 'sub', id: null })
    await waitForState(page, state => !state.tracks.some(track => track.type === 'sub' && track.selected), 'local SRT off')
    await page.waitForTimeout(300)
    await captureAcceptanceFrame(application, directory, `remote-local-srt-${name}-off`, { baseline: true })
    await control({ kind: 'track', type: 'sub', id: sid })
    await waitForState(page, state => state.tracks.some(track => track.id === sid && track.type === 'sub' && track.selected), 'local SRT on')
    await page.waitForTimeout(300)
    const frame = await captureAcceptanceFrame(application, directory, `remote-local-srt-${name}-on`, { compare: true })
    assert.ok(frame.changedColors.white > minimum, 'the actual local SRT must render white pixels over remote media')
    const current = await page.evaluate(() => window.api.playback.snapshot())
    assert.equal(current.sessionId, before.sessionId)
    assert.equal(current.paused, true)
    assert.ok(Math.abs(current.position - before.position) < 0.15)
    assert.equal((await nativeEvidence(application)).loadedFiles, 1)
    return frame
  }
  const expanded = await compare('expanded', 150)
  await page.getByRole('button', { name: '收起到底栏', exact: true }).click()
  await waitForState(page, state => state.presentation === 'docked' && state.paused, 'local SRT remote dock')
  await page.waitForTimeout(400)
  const docked = await compare('docked', 8)
  await page.getByRole('button', { name: '恢复展开', exact: true }).click()
  await waitForState(page, state => state.presentation === 'expanded', 'local SRT remote restore')
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await waitForState(page, state => state.presentation === 'fullscreen' && state.paused, 'local SRT remote fullscreen')
  await page.waitForTimeout(1500)
  const fullscreen = await compare('fullscreen', 150)
  assert.ok(Number.isFinite(fullscreen.controlsTop) && fullscreen.bottom < fullscreen.controlsTop,
    'local SRT must remain above remote fullscreen controls')
  await control({ kind: 'presentation', value: 'expanded' })
  await waitForState(page, state => state.presentation === 'expanded', 'local SRT fullscreen exit')
  await page.waitForTimeout(1500)
  return { name: 'local SRT over remote media in one paused session', file, selection: `real ${process.platform} system picker`,
    size: 40, expanded, docked, fullscreen }
}
