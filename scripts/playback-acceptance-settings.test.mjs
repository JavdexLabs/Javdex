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
    app: { getAppPath: () => '/app' }, process: { platform, getBuiltinModule: () => ({ createRequire: () => () => ({ inspect: () => state }) }) }
  }) }
  const result = await nativeEvidence(application)
  assert.equal(result.renderedFrames, platform === 'darwin' ? 100 : 70)
  assert.equal(result.presentedFrames, platform === 'darwin' ? undefined : 70)
})

for (const { visible, fullscreen } of [{ visible: true, fullscreen: true }, { visible: false, fullscreen: true },
  { visible: true, fullscreen: false }]) test(`macOS Canvas captures retain only actual fullscreen toolbar geometry: visible=${visible}, fullscreen=${fullscreen}`, async () => {
  const crops = [], bytes = Buffer.from([0, 1, 2, 255])
  const image = { getSize: () => ({ width: 1400, height: 900 }), crop: rect => {
    crops.push(rect)
    return { getSize: () => ({ width: rect.width, height: rect.height }), toBitmap: () => bytes }
  } }
  const dependencies = { BrowserWindow: { getAllWindows: () => [{ webContents: {
    capturePage: async () => image,
    executeJavaScript: async source => vm.runInNewContext(source, { innerWidth: 700, document: {
      querySelector: () => ({ getBoundingClientRect: () => ({ x: 10, y: 20, width: 640, height: 360 }),
        closest: () => ({ dataset: { controlsVisible: String(visible), rendererFullscreen: String(fullscreen) },
          querySelector: () => ({ parentElement: { parentElement: { getBoundingClientRect: () => ({ top: 330 }) } } }) }) })
    } })
  } }] } }
  const application = { evaluate: callback => vm.runInNewContext(`(${callback.toString()})(dependencies)`, {
    dependencies, process: { platform: 'darwin', getBuiltinModule: () => { throw new Error('macOS must not use native capture') } }
  }) }
  const result = await captureAcceptanceImage(application)
  assert.deepEqual(JSON.parse(JSON.stringify(crops)), [{ x: 20, y: 40, width: 1280, height: 720 }])
  assert.equal(result.width, 1280)
  assert.equal(result.height, 720)
  assert.equal(result.data, bytes)
  assert.equal(result.controlsTop, visible && fullscreen ? 620 : undefined)
  assert.equal(result.rendererFullscreen, fullscreen)
})

test('Windows formal capture keeps the existing native adapter in development and packaged hosts', async () => {
  for (const packaged of [false, true]) {
    const files = [], frame = { width: 2, height: 1, data: Buffer.alloc(8) }
    const application = { evaluate: callback => vm.runInNewContext(`(${callback.toString()})(dependencies)`, {
      dependencies: { app: { isPackaged: packaged, getAppPath: () => '/app' } },
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
