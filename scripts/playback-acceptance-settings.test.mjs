import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import crypto from 'node:crypto'
import { test } from 'node:test'
import { createThisComputerSettingsStore, thisComputerSettingsPath } from '../apps/desktop/src/main/desktop/thisComputerSettingsStore.ts'
import { prepareNonRecordingPlayback } from './playback-acceptance-settings.mjs'
import { assertOrdinaryAcceptanceExit, closeAcceptanceAndSave } from './playback-acceptance-cleanup.mjs'
import { captureAcceptanceImage, captureAcceptanceFrame, nativeEvidence, output } from './playback-acceptance-support.mjs'
import { revealFullscreenControls, hideFullscreenControls } from './playback-settings-ui.mjs'
import { installCanvasSubmissionObserver, checkSyntheticCanvasFrame } from './windows-canvas-checks.mjs'
import { checkLocalSubtitlePicker, whiteBitmapCoverage, bitmapTransparency } from './playback-subtitle-checks.mjs'
import { bitmapFixture } from './playback-pgs-fixture.mjs'

function localSrtPickerFixture({ value = 136, pixels = 1000 } = {}) {
  const state = { sessionId: 'fixture', source: 'remote', paused: true, position: 4, tracks: [], subtitleSize: 38 }
  const api = { playback: { snapshot: () => structuredClone(state), control: async (_id, command) => {
    if (command.kind === 'track') state.tracks[0].selected = command.id !== null
    if (command.kind === 'presentation') state.presentation = command.value
  } } }
  const page = { evaluate: async (callback, args) => vm.runInNewContext(`(${callback.toString()})(args)`, { window: { api }, args }),
    waitForTimeout: async () => {}, getByRole: (_role, { name }) => ({ isDisabled: async () => false, click: async () => {
      if (name === '选择本机外挂字幕') state.tracks.push({ type: 'sub', id: 2, codec: 'subrip', selected: true })
      if (name === '收起到底栏') state.presentation = 'docked'
      if (name === '恢复展开') state.presentation = 'expanded'
      if (name === '全屏') state.presentation = 'fullscreen'
    } }) }
  let fullscreenPrefix, ready = false
  const context = { assert, process, path, whiteBitmapCoverage, application: {}, page,
    // Filtered small glyphs can have substantial coverage without bright cores.
    sharp: file => ({ ensureAlpha: () => ({ raw: () => ({ toBuffer: async () =>
      Buffer.alloc(pixels * 4, Buffer.from(file.endsWith('-on.png') ? [value, value, value, 255] : [17, 17, 17, 255])) }) }) }),
    openPlaybackSettings: async () => {}, closePlaybackSettings: async () => {},
    selectPlaybackSetting: async () => { state.subtitleSize = 40 },
    waitForState: async (_page, predicate, description) => { assert.ok(predicate(state), description); return structuredClone(state) },
    waitForNativeFrame: async () => {},
    waitForValue: async (read, predicate, description) => { const value = await read(); assert.ok(predicate(value), description); return value },
    nativeEvidence: async () => ({ loadedFiles: 1 }),
    captureAcceptanceFrame: async () => ({ changedColors: { white: 3 } }),
    fullscreenSubtitleComposition: async (_app, _page, _dir, prefix, compare) => { fullscreenPrefix = prefix; return compare() },
    ready: () => { ready = true } }
  return { run: async () => {
    const result = await vm.runInNewContext(`(${checkLocalSubtitlePicker.toString()})(application,page,'/fixture','external.srt',ready)`, context)
    return { result, ready, fullscreenPrefix, state }
  } }
}

test('remote local-SRT picker reaches fullscreen composition with its own evidence prefix', async () => {
  const { result, ready, fullscreenPrefix, state } = await localSrtPickerFixture().run()
  assert.equal(ready, true)
  assert.equal(fullscreenPrefix, 'remote-local-srt')
  assert.equal(result.size, 40)
  assert.equal(state.paused, true)
  assert.equal(state.position, 4)
})

for (const value of [17, 18]) test(`local SRT pixels reject absent text over a ${value === 17 ? 'stable' : 'slightly drifting'} background`, async () => {
  await assert.rejects(localSrtPickerFixture({ value, pixels: 100000 }).run(), /actual local SRT must render white coverage/)
})

test('bitmap area integrates filtered white coverage and subtracts the unchanged background', () => {
  const rgba = values => Buffer.from(values.flatMap(value => [value, value, value, 255]))
  assert.equal(whiteBitmapCoverage(rgba([255, 136, 17, 136]), rgba([17, 17, 17, 17])), 2)
  assert.equal(whiteBitmapCoverage(rgba([32, 64, 128, 255]), rgba([32, 64, 128, 255])), 0)
  assert.equal(whiteBitmapCoverage(rgba([17, 17]), rgba([17, 17])), 0, 'cleared cue has no area')
})

test('small PGS transparency checks the center hole when borders cannot be sampled reliably', () => {
  const frame = { width: 272, height: 182, whiteBounds: { x: 111, y: 141, width: 50, height: 14 } }
  const baseline = Buffer.alloc(frame.width * frame.height * 4, Buffer.from([20, 20, 20, 255]))
  const current = Buffer.from(baseline)
  for (let x = 111; x < 161; x++) current.set([91, 91, 91, 255], (140 * frame.width + x) * 4)
  assert.deepEqual(bitmapTransparency(frame, current, baseline, bitmapFixture.cues[1]).map(point => point.name), ['center hole'])
  current.set([0, 0, 0, 255], (147 * frame.width + 136) * 4)
  assert.throws(() => bitmapTransparency(frame, current, baseline, bitmapFixture.cues[1]), /center hole.*opaque black patch/)
})

test('enlarged PGS transparency sampling stays beyond the scaled filter footprint', () => {
  const frame = { width: 1280, height: 720, whiteBounds: { x: 520, y: 596, width: 240, height: 64 } }
  const baseline = Buffer.alloc(frame.width * frame.height * 4, Buffer.from([20, 20, 20, 255]))
  const current = Buffer.from(baseline)
  current.set([117, 117, 117, 255], (628 * frame.width + 518) * 4)
  assert.equal(bitmapTransparency(frame, current, baseline, bitmapFixture.cues[1]).length, 5)
  current.set([0, 0, 0, 255], (628 * frame.width + 515) * 4)
  assert.throws(() => bitmapTransparency(frame, current, baseline, bitmapFixture.cues[1]), /left border.*opaque black patch/)
})

test('Windows follow-up submissions belong to the current surface, not any previous open', () => {
  let receive
  const contents = { mainFrame: {} }, first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222'
  const context = { dependencies: { BrowserWindow: { getAllWindows: () => [{ webContents: contents }] },
    ipcMain: { on: (_channel, callback) => { receive = callback } } } }
  vm.runInNewContext(`(${installCanvasSubmissionObserver.toString()})(dependencies)`, context)
  const event = { sender: contents, senderFrame: contents.mainFrame }
  receive(event, { surfaceToken: first, sequence: 1 }); receive(event, { surfaceToken: first, sequence: 2 })
  assert.equal(context.windowsCanvasReceipts.get(first).count, 2)
  assert.equal(context.windowsCanvasReceipts.get(second)?.count ?? 0, 0, 'reopen requires fresh submissions')
  receive({ ...event, senderFrame: {} }, { surfaceToken: second, sequence: 3 })
  assert.equal(context.windowsCanvasReceipts.get(second)?.count ?? 0, 0)
  receive(event, { surfaceToken: second, sequence: 3 }); receive(event, { surfaceToken: second, sequence: 3 })
  assert.equal(context.windowsCanvasReceipts.get(second).count, 1, 'duplicates cannot create fresh progress')
})
const animatedPixels = () => {
  const data = Buffer.alloc(16 * 16 * 4)
  for (let pixel = 0; pixel < 256; pixel++) data.set([[0, 0, 255, 255], [0, 255, 0, 255], [255, 0, 0, 255], [255, 255, 255, 255]][pixel % 4], pixel * 4)
  return { width: 16, height: 16, data }
}

test('subtitle pixel inspection recognizes antialiased hues without counting neutral gray as colored', async () => {
  let colored = false
  const hues = [[144, 144, 16], [144, 16, 144], [16, 144, 16], [16, 144, 144], [16, 16, 144], [220, 220, 220]]
  const context = vm.createContext({ Buffer, dependencies: { app: { getAppPath: () => process.cwd() },
    nativeImage: { createFromBitmap: () => ({ toPNG: () => Buffer.alloc(0) }) } },
  process: { getBuiltinModule: () => ({ createRequire: () => id => ({
    'node:fs': { writeFileSync() {} }, 'node:path': path, 'node:crypto': crypto
  })[id] }) } })
  const application = { evaluate: async (callback, args) => {
    assert.ok(args.inspect, 'pixel analysis must remain beside the captured bitmap')
    const frame = { width: 6, height: 2, data: Buffer.from(Array.from({ length: 12 }, (_, i) =>
      [...(colored ? i < 6 ? hues[i] : [128, 128, 128] : [32, 32, 32]), 255]).flat()) }
    context.args = { ...args.options, frame }
    return vm.runInContext(`(${args.inspect})(dependencies,args)`, context)
  } }
  await captureAcceptanceFrame(application, path.join(output, 'pixel-check'), 'off', { baseline: true })
  colored = true
  const result = await captureAcceptanceFrame(application, path.join(output, 'pixel-check'), 'on', { compare: true })
  assert.deepEqual(JSON.parse(JSON.stringify(result.changedColors)), { cyan: 1, magenta: 1, green: 1, yellow: 1, red: 1, white: 1 })
  const repeated = await captureAcceptanceFrame(application, path.join(output, 'pixel-check'), 'on-ready', { compare: true })
  assert.equal(repeated.differentPixels, result.differentPixels, 'bounded readiness reads must retain their subtitle-off baseline')
})
test('Windows follow-up rejects black, blank and transparent synthetic screenshots', () => {
  for (const bgra of [[0, 0, 0, 255], [200, 200, 200, 255], [0, 0, 255, 255], [0, 0, 0, 0]]) {
    const image = animatedPixels()
    for (let pixel = 0; pixel < 256; pixel++) image.data.set(bgra, pixel * 4)
    assert.throws(() => checkSyntheticCanvasFrame(image), /opaque|colored regions/)
  }
  assert.throws(() => checkSyntheticCanvasFrame({ width: 16, height: 16, data: Buffer.alloc(4) }), /complete BGRA/)
})
test('Windows follow-up requires advancing animated pixels, not just production counters', () => {
  const image = animatedPixels(), first = checkSyntheticCanvasFrame(image)
  assert.throws(() => checkSyntheticCanvasFrame(image, first.hash), /must advance/)
  image.data[0] = 1
  assert.notEqual(checkSyntheticCanvasFrame(image, first.hash).hash, first.hash)
})

test('formal fullscreen geometry checks reveal renderer chrome through actual pointer interaction only', async () => {
  for (const state of [{ presentation: 'expanded' }, { presentation: 'fullscreen' }]) {
    const calls = []; let evaluations = 0
    const page = { evaluate: async () => ++evaluations === 1 ? state : { width: 700, height: 450 },
      mouse: { move: async (x, y) => calls.push(['move', x, y]) },
      getByRole: (role, options) => ({ waitFor: async value => calls.push([role, options.name, value.state]) }) }
    await revealFullscreenControls(page)
    assert.deepEqual(calls, state.presentation === 'fullscreen'
      ? [['move', 350, 448], ['slider', '播放进度', 'visible']] : [])
  }
})

test('full-frame pixel inspection hides overlay chrome without changing playback or video geometry', async () => {
  const calls = []; let evaluations = 0
  const page = { evaluate: async () => ++evaluations === 1 ? { presentation: 'fullscreen' } : { width: 700, height: 450 },
    mouse: { move: async (x, y) => calls.push(['move', x, y]) },
    getByRole: (role, options) => ({ focus: async () => calls.push([role, options.name, 'focus']) }),
    locator: selector => ({ waitFor: async () => calls.push(['wait', selector]) }) }
  await hideFullscreenControls(page)
  assert.deepEqual(calls, [['move', 350, 225], ['button', '视频画面，单击播放或暂停，双击全屏', 'focus'],
    ['wait', '[data-playback-session][data-controls-visible="false"][data-header-visible="false"]']])
})

function evidenceApplication(hosts) {
  return { evaluate: callback => vm.runInNewContext(`(${callback.toString()})()`, {
    process: { getBuiltinModule: name => {
      assert.equal(name, 'diagnostics_channel', 'evidence must not load a native decoder in main')
      return { channel: name => {
        assert.equal(name, 'javdex.playback.host.statistics')
        return { publish: request => Object.assign(request, hosts) }
      } }
    } }
  }) }
}
for (const mode of ['gpu', 'cpu']) test(`${mode} evidence projects isolated-host production without implying screen presentation`, async () => {
  const state = { alive: true, loadedFiles: 1, presentedFrames: 70, nativeFrames: 100,
    'track-list': JSON.stringify([{type: 'audio', id: 1, title: 'Audio', 'external-filename': '/private/video'}]) }
  const result = await nativeEvidence(evidenceApplication({[mode]: state}))
  assert.equal(result.renderedFrames, 100)
  assert.equal(result.presentedFrames, undefined)
  assert.equal(result.loadedFiles, 1)
  assert.equal(JSON.stringify(result).includes('/private/'), false)
})

for (const platform of ['darwin', 'win32'])
for (const { visible, fullscreen } of [{ visible: true, fullscreen: true }, { visible: false, fullscreen: true },
  { visible: true, fullscreen: false }]) test(`${platform} Canvas captures retain only actual fullscreen toolbar geometry: visible=${visible}, fullscreen=${fullscreen}`, async () => {
  const crops = [], bytes = Buffer.from([0, 1, 2, 255])
  const image = { getSize: () => ({ width: 1400, height: 900 }), crop: rect => {
    crops.push(rect)
    return { getSize: () => ({ width: rect.width, height: rect.height }), toBitmap: () => bytes }
  } }
  const dependencies = { app: { commandLine: { hasSwitch: () => true } }, BrowserWindow: { getAllWindows: () => [{ webContents: {
    capturePage: async () => image,
    executeJavaScript: async source => vm.runInNewContext(source, { innerWidth: 700, document: {
      querySelector: () => ({ getBoundingClientRect: () => ({ x: 10, y: 20, width: 640, height: 360 }),
        closest: () => ({ dataset: { controlsVisible: String(visible), rendererFullscreen: String(fullscreen) },
          querySelector: () => ({ parentElement: { parentElement: { getBoundingClientRect: () => ({ top: 330 }) } } }) }) })
    } })
  } }] } }
  const application = { evaluate: callback => vm.runInNewContext(`(${callback.toString()})(dependencies)`, {
    dependencies, process: { platform, getBuiltinModule: () => { throw new Error('Canvas must not use native HWND capture') } }
  }) }
  const result = await captureAcceptanceImage(application)
  assert.deepEqual(JSON.parse(JSON.stringify(crops)), [{ x: 20, y: 40, width: 1280, height: 720 }])
  assert.equal(result.width, 1280)
  assert.equal(result.height, 720)
  assert.equal(result.data, bytes)
  assert.equal(result.controlsTop, visible && fullscreen ? 620 : undefined)
  assert.equal(result.rendererFullscreen, fullscreen)
})

test('evidence observes CPU after GPU recovery and an empty state after stop', async () => {
  const result = await nativeEvidence(evidenceApplication({gpu: {alive: false}, cpu: {alive: true, nativeFrames: 19}}))
  assert.equal(result.alive, true); assert.equal(result.renderedFrames, 19)
  assert.equal((await nativeEvidence(evidenceApplication({}))).alive, false)
})

test('a fullscreen layout change during capture retries before using crop geometry', async () => {
  let height = 360, captures = 0
  const crops = []
  const dependencies = { BrowserWindow: { getAllWindows: () => [{ webContents: {
    capturePage: async () => { captures++; height = 361; return {
      getSize: () => ({ width: 1400, height: 900 }),
      crop: rect => { crops.push(rect); return { getSize: () => rect, toBitmap: () => Buffer.alloc(0) } }
    } },
    executeJavaScript: async () => ({ x: 10, y: 20, width: 640, height, windowWidth: 700, rendererFullscreen: true })
  } }] } }
  const application = { evaluate: callback => vm.runInNewContext(`(${callback.toString()})(dependencies)`, { dependencies }) }
  const frame = await captureAcceptanceImage(application)
  assert.equal(captures, 2, 'do not combine the previous screenshot with the new fullscreen bounds')
  assert.equal(crops.length, 1)
  assert.equal(frame.height, 722)
})

test('capture projections return statistics without serializing raw frame bytes to the controller', async () => {
  const data = Buffer.alloc(16 * 9 * 4, 127)
  const dependencies = { BrowserWindow: { getAllWindows: () => [{ webContents: {
    executeJavaScript: async () => ({ x: 0, y: 0, width: 16, height: 9, windowWidth: 16, rendererFullscreen: false }),
    capturePage: async () => ({ getSize: () => ({ width: 16, height: 9 }), crop: () => ({
      getSize: () => ({ width: 16, height: 9 }), toBitmap: () => data
    }) })
  } }] } }
  const application = { evaluate: (callback, projection) => {
    assert.equal(Object.hasOwn(projection.options, 'frame'), false)
    return vm.runInNewContext(`(${callback.toString()})(dependencies,projection)`, { dependencies, projection })
  } }
  const result = await captureAcceptanceImage(application, {
    inspect: '(_dependencies, { frame }) => ({ width: frame.width, byteCount: frame.data.length })', options: {}
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { width: 16, byteCount: data.length })
  assert.equal(result.data, undefined)
})

test('non-recording playback explicitly changes the real fresh default, not product policy', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-playback-settings-'))
  try {
    const store = createThisComputerSettingsStore(thisComputerSettingsPath(directory))
    const patches = []
    const api = { get: () => store.read(), update: async patch => {
      patches.push(patch)
      return { settings: await store.write(patch), restartRequired: false }
    } }
    const page = { evaluate: callback => vm.runInNewContext(`(${callback.toString()})()`, { window: { api: { thisComputer: api } } }) }
    await prepareNonRecordingPlayback(page)
    assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ resumePlayback: false }])
    assert.equal((await store.read()).resumePlayback, false)
    assert.equal((await store.read()).playerPreference, 'builtin')
    const fresh = createThisComputerSettingsStore(path.join(directory, 'another-new-profile.json'))
    assert.equal((await fresh.read()).resumePlayback, true)
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})

test('ordinary restart accepts only an unforced successful non-signaled exit', () => {
  assert.doesNotThrow(() => assertOrdinaryAcceptanceExit({ forced: false, code: 0, signal: null }))
  for (const cleanup of [
    { forced: false, code: 1, signal: null }, { forced: false, code: null, signal: 'SIGABRT' },
    { forced: true, code: 0, signal: null }, { forced: false, code: null, signal: null },
    { forced: false, code: 0, signal: 'SIGTERM' }
  ]) assert.throws(() => assertOrdinaryAcceptanceExit(cleanup), { name: 'AssertionError' })
})

// Exercise the formal runner's real close/save helper without starting a GUI.
function acceptanceFixture(cleanup, startupError = false) {
  const run = { passed: !startupError, ...(startupError ? { error: 'original startup failure' } : {}) }, saved = []
  const report = { runs: [run] }
  return { run: () => closeAcceptanceAndSave(run, {}, async () => {
    if (cleanup instanceof Error) throw cleanup
    return cleanup
  }, () => saved.push(JSON.parse(JSON.stringify(report)))), report, saved }
}

test('formal acceptance report is saved after an ordinary successful exit', async () => {
  const f = acceptanceFixture({ forced: false, code: 0, signal: null })
  await f.run()
  assert.equal(f.saved.at(-1).runs[0].passed, true)
  assert.equal(f.saved.at(-1).runs[0].cleanup.code, 0)
})

for (const cleanup of [
  { forced: false, code: 1, signal: null }, { forced: false, code: null, signal: 'SIGABRT' },
  { forced: true, code: 0, signal: null }, new Error('cleanup failed')
]) test(`formal acceptance report rejects and saves abnormal cleanup: ${JSON.stringify(cleanup)} ${cleanup.message ?? ''}`, async () => {
  const f = acceptanceFixture(cleanup)
  await assert.rejects(f.run())
  assert.equal(f.saved.at(-1).runs[0].passed, false)
  assert.ok(f.saved.at(-1).runs[0].error)
})

test('formal cleanup failure still saves the original playback error', async () => {
  const f = acceptanceFixture({ forced: true, code: 0, signal: null }, true)
  await assert.rejects(f.run())
  assert.match(f.saved.at(-1).runs[0].error, /original startup failure/)
  assert.equal(f.saved.at(-1).runs[0].cleanup.forced, true)
})

test('local playback entry points explicitly prepare their non-recording scenario', () => {
  for (const file of ['windows-canvas-acceptance.mjs', 'playback-media-acceptance.mjs']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(source, /await prepareNonRecordingPlayback\(page\)/, file)
  }
})
