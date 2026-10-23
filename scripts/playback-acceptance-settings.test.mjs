import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { test } from 'node:test'
import { createThisComputerSettingsStore, thisComputerSettingsPath } from '../apps/desktop/src/main/desktop/thisComputerSettingsStore.ts'
import { prepareNonRecordingPlayback } from './playback-acceptance-settings.mjs'
import { assertOrdinaryAcceptanceExit, closeAcceptanceAndSave } from './playback-acceptance-cleanup.mjs'
import { captureAcceptanceImage, nativeEvidence } from './playback-acceptance-support.mjs'
import { revealFullscreenControls, hideFullscreenControls } from './playback-settings-ui.mjs'
import { installCanvasSubmissionObserver, checkSyntheticCanvasFrame } from './windows-canvas-checks.mjs'

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
  for (const state of [{ presentation: 'expanded', rendererFullscreenControls: true },
    { presentation: 'fullscreen', rendererFullscreenControls: false }, { presentation: 'fullscreen', rendererFullscreenControls: true }]) {
    const calls = []; let evaluations = 0
    const page = { evaluate: async () => ++evaluations === 1 ? state : { width: 700, height: 450 },
      mouse: { move: async (x, y) => calls.push(['move', x, y]) },
      getByRole: (role, options) => ({ waitFor: async value => calls.push([role, options.name, value.state]) }) }
    await revealFullscreenControls(page)
    assert.deepEqual(calls, state.presentation === 'fullscreen' && state.rendererFullscreenControls
      ? [['move', 350, 448], ['slider', '播放进度', 'visible']] : [])
  }
})

test('full-frame pixel inspection hides overlay chrome without changing playback or video geometry', async () => {
  const calls = []; let evaluations = 0
  const page = { evaluate: async () => ++evaluations === 1 ? { presentation: 'fullscreen', rendererFullscreenControls: true } : { width: 700, height: 450 },
    mouse: { move: async (x, y) => calls.push(['move', x, y]) },
    getByRole: (role, options) => ({ focus: async () => calls.push([role, options.name, 'focus']) }),
    locator: selector => ({ waitFor: async () => calls.push(['wait', selector]) }) }
  await hideFullscreenControls(page)
  assert.deepEqual(calls, [['move', 350, 225], ['button', '视频画面，单击播放或暂停，双击全屏', 'focus'],
    ['wait', '[data-playback-session][data-controls-visible="false"][data-header-visible="false"]']])
})

for (const platform of ['darwin', 'win32']) test(`${platform} evidence names render/presentation counters without confusing Canvas production with screen presentation`, async () => {
  const state = { alive: true, loadedFiles: 1, presentedFrames: platform === 'darwin' ? 0 : 70, nativeFrames: 100 }
  const application = { evaluate: callback => vm.runInNewContext(`(${callback.toString()})({app})`, {
    app: { getAppPath: () => '/app', commandLine: { hasSwitch: () => false } }, process: { platform, getBuiltinModule: () => ({ createRequire: () => () => ({ inspect: () => state }) }) }
  }) }
  const result = await nativeEvidence(application)
  assert.equal(result.renderedFrames, platform === 'darwin' ? 100 : 70)
  assert.equal(result.presentedFrames, platform === 'darwin' ? undefined : 70)
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

test('Windows Canvas evidence observes its producer instead of the idle legacy backend', async () => {
  const application = { evaluate: callback => vm.runInNewContext(`(${callback.toString()})({app})`, {
    app: { getAppPath: () => '/app', commandLine: { hasSwitch: name => name === 'javdex-windows-canvas' } },
    process: { platform: 'win32', getBuiltinModule: () => ({ createRequire: () => () => ({
      inspect: () => { throw Error('legacy backend must not be observed') },
      sharedTexture: { inspect: () => ({ alive: true, nativeFrames: 23, presentedFrames: 0 }) }
    }) }) }
  }) }
  const result = await nativeEvidence(application)
  assert.equal(result.alive, true); assert.equal(result.renderedFrames, 23)
  assert.equal(result.presentedFrames, undefined)
})
test('Windows formal capture keeps the existing native adapter in development and packaged hosts', async () => {
  for (const packaged of [false, true]) {
    const files = [], frame = { width: 2, height: 1, data: Buffer.alloc(8) }
    const application = { evaluate: callback => vm.runInNewContext(`(${callback.toString()})(dependencies)`, {
      dependencies: { app: { isPackaged: packaged, getAppPath: () => '/app', commandLine: { hasSwitch: () => false } } },
      process: { platform: 'win32', resourcesPath: '/resources', getBuiltinModule: () => ({ createRequire: () => file => {
        files.push(file); return { capture: () => frame }
      } }) }
    }) }
    assert.equal(await captureAcceptanceImage(application), frame)
    assert.deepEqual(files, [packaged ? '/resources/native-playback/playback.node' : '/app/out/native-playback/playback.node'])
  }
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
  for (const file of ['playback-acceptance.mjs', 'playback-media-acceptance.mjs']) {
    const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.match(source, /await prepareNonRecordingPlayback\(page\)/, file)
  }
})
