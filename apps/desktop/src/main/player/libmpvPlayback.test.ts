import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { setTimeout as delay } from 'node:timers/promises'
import type { BrowserWindow } from 'electron'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type { NativePlaybackState } from './nativePlayback'
import type { PlaybackSnapshot } from '@shared/desktop/playback'
import { createPlaybackEngine } from './playbackEngine'
import { createGeneratedSubtitleDisplay } from './generatedSubtitleDisplay'
import { isGraphicsPlaybackFailure } from './playbackGraphicsFailure'

// Exercise the production wrapper with isolated import adapters, without loading
// Electron or a native binary, changing process.platform, or adding a production seam.
const wrapperCode = transpileModule(readFileSync(new URL('./libmpvPlayback.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
}).outputText
const factoryCode = transpileModule(readFileSync(new URL('./playbackHostFactory.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
}).outputText
const subtitleFile = path.resolve('fixture-subtitles', 'AI 日中字幕.ass')
const newSubtitleFile = path.resolve('fixture-subtitles', 'new.ass')

function fixture(platform: 'darwin' | 'win32' | 'linux', software = false,
  options: { deferCreate?: boolean; renderNode?: () => string; windowDestroyed?: boolean; createFailure?: boolean; destroyFailure?: boolean } = {}) {
  const commands: string[][] = []
  const loaded: string[] = []
  let created = false, destroys = 0
  const handles: number[] = [], sharedProducer = {}
  const viewports: unknown[] = []
  let pending = 0, replies = 0, errors = 2, generatedErrors = 0, held = false
  let generatedPending = 0, generatedReplies = 0
  let overlayRevision = 0
  let inspectionFailed = false
  const overlays: Array<{ operation: string; document: string; visible: boolean; revision: number }> = []
  let sid = '7', aid = '2'
  const waiting: Array<{ args: string[]; generated: boolean }> = []
  let frozen: NativePlaybackState | null = null
  const tracks: Array<Record<string, unknown>> = [
    { id: 2, type: 'audio', selected: true, 'ff-index': 1 },
    { id: 4, type: 'audio', selected: false, 'ff-index': 2 },
    { id: 3, type: 'sub', selected: false },
    { id: 7, type: 'sub', selected: true, 'external-filename': subtitleFile }
  ]
  const snapshot = (): NativePlaybackState => ({ alive: created, subtitleCommandErrors: errors,
    generatedSubtitleCommandErrors: generatedErrors,
    generatedSubtitleCommandsPending: generatedPending, generatedSubtitleCommandReplies: generatedReplies,
    generatedSubtitleOverlayVersion: 1, generatedSubtitleRevision: overlayRevision,
    subtitleCommandsPending: pending, subtitleCommandReplies: replies, sid, aid, 'track-list': JSON.stringify(tracks) })
  const complete = (args: string[], generated: boolean, failed = false): void => {
    pending--; replies++
    if (generated) { generatedPending--; generatedReplies++ }
    if (args[0] === 'overlay') overlayRevision = Number(args[4])
    if (failed) { errors++; if (generated) generatedErrors++; return }
    if (args[0] === 'sub-add') tracks.push({ id: 8, type: 'sub', selected: args[2] === 'select', 'external-filename': args[1] })
    if (args[0] === 'sub-remove') tracks.splice(tracks.findIndex(track => String(track.id) === args[1]), 1)
    if (args[0] === 'set' && args[1] === 'sid') sid = args[2]
  }
  const bridge = {
    create() { handles.push(0); created = true; if (options.createFailure) throw new Error('partial initialization') },
    setBounds(bounds: unknown) { viewports.push(bounds) },
    setVisible() {},
    render() {},
    command(args: string[], generated = false) {
      commands.push([...args])
      if (args[0].startsWith('sub-') || args[0] === 'set' && ['sid', 'sub-delay', 'sub-font-size'].includes(args[1])) {
        pending++
        if (generated) generatedPending++
        if (held) waiting.push({ args, generated })
        else complete(args, generated)
      }
    },
    inspect: () => { if (inspectionFailed) throw Object.assign(new Error('GPU playback bridge is unavailable'), { playbackFailureKind: 'graphics' }); return frozen ?? snapshot() },
    generatedSubtitles(operation: string, document: string, visible: boolean, revision: number) {
      overlays.push({ operation, document, visible, revision })
      const args = ['overlay', operation, document, String(visible), String(revision)]
      pending++; generatedPending++
      if (held) waiting.push({ args, generated: true }); else complete(args, true)
    },
    state(): NativePlaybackState {
      return snapshot()
    },
    destroy() { destroys++; created = false; if (options.destroyFailure) throw new Error('lost context') }
  }
  const moduleExports = {} as Pick<typeof import('./libmpvPlayback'), 'createLibmpvPlayback'>
  const factoryExports = {} as typeof import('./playbackHostFactory')
  const sandbox = {
    Buffer,
    process: { platform, resourcesPath: path.resolve('fixture-resources'), env: { DISPLAY: ':fixture' } },
    require(id: string): unknown {
      switch (id) {
        case './playbackHostFactory': return factoryExports
        case './generatedSubtitleDisplay': return { createGeneratedSubtitleDisplay: () => createGeneratedSubtitleDisplay(platform) }
        case 'electron': return {
          app: { isPackaged: false, getAppPath: () => path.resolve('fixture-app') },
          screen: { getDisplayMatching: () => ({ scaleFactor: 1 }) }
        }
        case 'node:fs': return { existsSync: () => true }
        case 'node:path': return path
        case 'node:timers/promises': return { setTimeout: delay }
        case './isolatedPlaybackHost': return { createIsolatedPlaybackHost: (filename: string) => { loaded.push(filename); return sharedProducer } }
        case './playbackGraphicsFailure': return { graphicsPlaybackFailure: (code: string) => Object.assign(new Error(code), { playbackFailureKind: 'graphics' }) }
        case './playbackDisplay': return { linuxPlaybackBackend: () => 'dmabuf' }
        case './linuxPlaybackBridge': return { createLinuxPlaybackBridge: () => bridge }
        case './linuxSharedTexture': return { createLinuxSharedTexture: () => { throw new Error('Wrapper fixture does not materialize its deferred frame channel') } }
        case './linuxGpuImport': return { linuxGpuImportLoader: () => undefined }
        case './macSharedTexture': return { createMacSharedTextureBridge: () => bridge }
        case './nativeSharedTexture': return { createNativeSharedTextureBridge: (producer: unknown, _window: unknown, selected: string) => {
          assert.equal(producer, sharedProducer); assert.equal(selected, platform); return bridge
        } }
        case './windowsSoftwarePlayback': return { createWindowsSoftwarePlaybackBridge: (producer: unknown) => { assert.equal(producer, sharedProducer); return bridge } }
        case './softwarePlayback': return { createSoftwarePlaybackBridge: (producer: unknown, _window: unknown, selected: string) => {
          assert.equal(selected, platform); assert.equal(producer, sharedProducer); return bridge
        } }
        case './linuxPlaybackDevice': return { linuxPlaybackRenderNode: options.renderNode ?? (() => '/dev/dri/renderD129') }
        default: throw new Error(`Unexpected playback wrapper dependency: ${id}`)
      }
    }
  }
  runInNewContext(factoryCode, { ...sandbox, exports: factoryExports }, { filename: 'playbackHostFactory.ts' })
  runInNewContext(wrapperCode, { ...sandbox, exports: moduleExports }, { filename: 'libmpvPlayback.ts' })
  const window = {
    isDestroyed: () => options.windowDestroyed ?? false,
    getNativeWindowHandle: () => { throw new Error('Canvas playback must never request an HWND') },
    getBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
    webContents: { getZoomFactor: () => 1 }
  } as unknown as BrowserWindow
  const native = software ? moduleExports.createLibmpvPlayback(() => window, 'software') : moduleExports.createLibmpvPlayback(() => window)
  if (!options.deferCreate) {
    native.create()
    assert.equal(created, true, 'the real wrapper must load the fixture bridge')
  }
  return { native, commands, overlays, viewports, loaded, handles, destroys: () => destroys,
    failInspection: (): void => { inspectionFailed = true },
    hold: (): void => { held = true },
    observeSelection: (sub: string, audio = aid): void => { sid = sub; aid = audio },
    freeze: (): void => { frozen = snapshot() }, thaw: (): void => { frozen = null },
    complete: (failed = false): void => { const value = waiting.shift(); assert.ok(value); complete(value.args, value.generated, failed) },
    release: (): void => { held = false; for (const value of waiting.splice(0)) complete(value.args, value.generated) } }
}

for (const platform of ['win32', 'darwin', 'linux'] as const)
  for (const destroyFailure of [false, true]) test(`${platform}: partial GPU creation is cleaned before CPU recovery (cleanup throws: ${destroyFailure})`, t => {
    const gpu = fixture(platform, false, { deferCreate: true, createFailure: true, destroyFailure })
    const cpu = fixture(platform, true, { deferCreate: true })
    const engine = createPlaybackEngine(gpu.native, cpu.native, { mode: () => 'auto', gpuAvailable: () => true }, platform)
    t.after(() => engine.destroy())
    engine.create()
    assert.equal(gpu.destroys(), 1)
    assert.equal(engine.read().playbackMode, 'cpu')
    assert.equal(cpu.handles.length, 1)
  })

for (const failure of ['no matching DRM render node', 'X11 direct DMA-BUF import unavailable']) {
  for (const mode of ['auto', 'gpu'] as const) test(`Linux ${mode}: ${failure} during host preparation`, t => {
    let probes = 0
    const gpu = fixture('linux', false, { deferCreate: true, renderNode: () => { probes++; throw new Error(failure) } })
    const cpu = fixture('linux', true, { deferCreate: true, renderNode: () => assert.fail('CPU must not query GPU devices') })
    const engine = createPlaybackEngine(gpu.native, cpu.native, { mode: () => mode, gpuAvailable: () => true }, 'linux')
    t.after(() => engine.destroy())
    if (mode === 'gpu') {
      assert.throws(() => engine.create(), isGraphicsPlaybackFailure)
      assert.equal(cpu.handles.length, 0, 'explicit GPU must not create a CPU session')
    } else {
      engine.create()
      const state = engine.read()
      assert.equal(state.playbackMode, 'cpu')
      assert.equal(state.playbackFallback, true)
      assert.equal(state.playbackFallbackReason, 'GPU_INITIALIZATION_FAILED')
      assert.equal(cpu.handles.length, 1)
      engine.load('/fixture.mkv', { paused: false })
      assert.deepEqual(cpu.commands.filter(args => args[0] === 'loadfile'), [['loadfile', '/fixture.mkv', 'replace']])
      assert.equal(gpu.commands.length, 0)
    }
    assert.equal(probes, 1)
    assert.equal(gpu.handles.length, 0, 'device checks fail before bridge.create')
  })
}

test('Linux manual CPU never queries a missing virtual GPU', t => {
  const gpu = fixture('linux', false, { deferCreate: true, renderNode: () => assert.fail('manual CPU must not query GPU devices') })
  const cpu = fixture('linux', true, { deferCreate: true, renderNode: () => assert.fail('CPU host must not query GPU devices') })
  const engine = createPlaybackEngine(gpu.native, cpu.native, { mode: () => 'cpu', gpuAvailable: () => true }, 'linux')
  t.after(() => engine.destroy())
  engine.create()
  assert.equal(engine.read().playbackMode, 'cpu')
  assert.equal(engine.read().playbackFallback, false)
  assert.equal(gpu.handles.length, 0)
  assert.equal(cpu.handles.length, 1)
})

test('a closed page during host preparation does not trigger CPU recovery', t => {
  const gpu = fixture('linux', false, { deferCreate: true, windowDestroyed: true })
  const cpu = fixture('linux', true, { deferCreate: true })
  const engine = createPlaybackEngine(gpu.native, cpu.native, { mode: () => 'auto', gpuAvailable: () => true }, 'linux')
  t.after(() => engine.destroy())
  assert.throws(() => engine.create(), /主窗口不可用/)
  assert.equal(cpu.handles.length, 0)
})

test('Linux uses the common Canvas viewport contract', t => {
  for (const platform of ['linux'] as const) {
    const f = fixture(platform)
    t.after(() => f.native.destroy())
    f.native.viewport({ x: 10, y: 12, width: 640, height: 360 }, true,
      { presentation: 'fullscreen' } as PlaybackSnapshot)
    assert.deepEqual(JSON.parse(JSON.stringify(f.viewports)), [{ x: 10, y: 12, width: 640, height: 360, scale: 1 }])
  }
})

test('macOS default playback uses the shared Canvas addon and DOM controls without switches', t => {
  const f = fixture('darwin'); t.after(f.native.destroy)
  assert.equal(f.native.renderPolling, false)
  assert.deepEqual(f.loaded, [path.resolve('fixture-app/out/native-playback/playback.node')])
  f.native.viewport({ x: 0, y: 0, width: 640, height: 360 }, true, { presentation: 'expanded' } as PlaybackSnapshot)
  assert.equal((f.viewports[0] as { scale?: number }).scale, 1)
})

test('macOS software playback selects the independent software export without a GPU surface', t => {
  const f = fixture('darwin', true); t.after(f.native.destroy)
  assert.equal(f.native.renderPolling, false)
  assert.deepEqual(f.loaded, [path.resolve('fixture-app/out/native-playback/playback.node')])
})
test('Windows normal playback uses the shared Canvas producer without an HWND or startup switch', t => {
  const f = fixture('win32'); t.after(f.native.destroy)
  assert.equal(f.native.renderPolling, false)
  assert.deepEqual(f.handles, [0], 'Canvas must not receive an HWND')
  assert.deepEqual(f.loaded, [path.resolve('fixture-app/out/native-playback/playback.node')])
})

test('Windows software playback uses copied Canvas pixels without requesting an HWND', t => {
  const f = fixture('win32', true); t.after(f.native.destroy)
  assert.equal(f.native.renderPolling, false); assert.deepEqual(f.handles, [0])
  assert.deepEqual(f.loaded, [path.resolve('fixture-app/out/native-playback/playback.node')])
})

const timeline = 'generated timeline fixture'
for (const platform of ['darwin', 'win32'] as const) {
  for (const lostInspection of [false, true]) {
    for (const selection of ['refresh', 'hidden', 'sidecar', 'reselected'] as const) {
      test(`${platform}: CPU recovery preserves AI overlay selection after ${selection} (lost inspection: ${lostInspection})`, async t => {
        const gpu = fixture(platform), cpu = fixture(platform, true)
        let failed = false
        const native = createPlaybackEngine({ ...gpu.native, render() {
          if (failed) throw Object.assign(new Error('OpenGL frame rendering failed'), { playbackFailureKind: 'graphics' })
          gpu.native.render()
        } }, { ...cpu.native, read: () => ({ ...cpu.native.read(), loadedFiles: 1, seekable: false }) },
        { mode: () => 'auto', gpuAvailable: () => true }, platform)
        t.after(() => native.destroy())
        native.create(); native.load('/fixture.mkv')
        // The real AI controller selects once, then refreshes with select=false.
        await native.updateGeneratedSubtitle!(subtitleFile, true, undefined, timeline)
        await native.updateGeneratedSubtitle!(subtitleFile, false, undefined, timeline + ' future cues')
        if (selection === 'hidden' || selection === 'reselected') native.command({ kind: 'track', type: 'sub', id: 3 })
        if (selection === 'sidecar') native.addSubtitle(newSubtitleFile)
        if (selection === 'reselected') native.command({ kind: 'track', type: 'sub', id: Number.MAX_SAFE_INTEGER })
        const selected = selection === 'refresh' || selection === 'reselected'
        assert.equal(gpu.native.generatedSubtitleSelected!(subtitleFile), selected)
        if (lostInspection) gpu.failInspection()
        failed = true; native.render(); native.read()
        await delay(50)
        assert.equal(cpu.overlays.find(item => item.operation === 'update')?.document, timeline + ' future cues')
        assert.equal(cpu.native.generatedSubtitleSelected!(subtitleFile), selected, 'CPU must preserve actual visibility, not the refresh select argument')
      })
    }
  }
}
for (const platform of ['darwin', 'win32', 'linux'] as const) {
  test(`${platform}: persistent AI display keeps virtual selection, manual selection ownership`, async t => {
    const f = fixture(platform)
    t.after(() => f.native.destroy())
    await f.native.updateGeneratedSubtitle!(subtitleFile, true, undefined, timeline)
    assert.equal(f.native.generatedSubtitleSelected!(subtitleFile), true)
    await f.native.updateGeneratedSubtitle!(subtitleFile, false, undefined, timeline + ' future cues')
    assert.deepEqual(f.commands, [['set', 'sid', 'no']], 'future results never reload or recreate tracks')
    assert.equal(f.overlays.at(-1)!.visible, true)
    const state = f.native.read()
    const virtual = JSON.parse(state['track-list']!).find((track: { title: string }) => track.title === 'AI 日中字幕')
    assert.equal(virtual.id, Number.MAX_SAFE_INTEGER)
    f.native.command({ kind: 'track', type: 'sub', id: 3 })
    assert.equal(f.native.generatedSubtitleSelected!(subtitleFile), false)
    assert.equal(f.overlays.at(-1)!.visible, false)
    f.native.command({ kind: 'track', type: 'sub', id: virtual.id })
    assert.equal(f.native.generatedSubtitleSelected!(subtitleFile), true)
    assert.deepEqual(f.commands.at(-1), ['set', 'sid', 'no'])
    await f.native.removeGeneratedSubtitle!(subtitleFile, 3)
    assert.deepEqual(f.commands.at(-1), ['set', 'sid', '3'])
    assert.equal(f.overlays.at(-1)!.operation, 'clear')
    assert.equal(f.native.selectedAudioStream!(), 1)
  })
}

test('cancelling startup waits for the pending native operation and restores the original subtitle', async t => {
  const f = fixture('win32')
  t.after(() => f.native.destroy())
  f.hold()
  const controller = new AbortController()
  const update = f.native.updateGeneratedSubtitle!(subtitleFile, true, controller.signal, timeline)
  const rejected = assert.rejects(Promise.resolve(update), { name: 'AbortError' })
  await delay(5)
  controller.abort(); f.release(); f.observeSelection('7') // the command reply can precede its sid observation
  await rejected
  await f.native.removeGeneratedSubtitle!(subtitleFile, 3)
  assert.deepEqual(f.commands, [['set', 'sid', 'no'], ['set', 'sid', '3']])
})

test('overlay errors reject only optional subtitle display and preserve video playback', async t => {
  const f = fixture('win32')
  t.after(() => f.native.destroy())
  f.hold()
  const update = f.native.updateGeneratedSubtitle!(subtitleFile, false, undefined, timeline)
  const rejected = assert.rejects(Promise.resolve(update), /播放器未能更新 AI 字幕显示/)
  await delay(5); f.complete(true)
  await rejected
  assert.equal(f.native.read().alive, true)
})

test('Linux snapshots cannot acknowledge an overlay until its explicit revision arrives', async t => {
  const f = fixture('linux')
  t.after(() => f.native.destroy())
  f.hold(); f.freeze()
  let settled = false
  const update = Promise.resolve(f.native.updateGeneratedSubtitle!(subtitleFile, false, undefined, timeline)).then(() => { settled = true })
  await delay(25)
  f.complete()
  await delay(25)
  assert.equal(settled, false)
  f.thaw(); await update
  assert.equal(settled, true)
})

test('a manual selection arriving during AI startup wins over automatic display', async t => {
  const f = fixture('win32')
  t.after(() => f.native.destroy())
  f.hold()
  const update = f.native.updateGeneratedSubtitle!(newSubtitleFile, true, undefined, timeline)
  await delay(5)
  f.native.command({ kind: 'track', type: 'sub', id: 3 })
  f.release(); await update
  assert.equal(f.overlays.at(-1)!.visible, false)
  assert.equal(f.native.generatedSubtitleSelected!(newSubtitleFile), false)
  await f.native.removeGeneratedSubtitle!(newSubtitleFile, 7)
  assert.deepEqual(f.commands.at(-1), ['set', 'sid', '3'], 'stop must not override the manual selection')
})

test('cached native selection flags cannot override sid or aid observations', t => {
  const f = fixture('win32')
  t.after(() => f.native.destroy())
  f.observeSelection('no', '4')
  assert.equal(f.native.generatedSubtitleSelected!(subtitleFile), false)
  assert.equal(f.native.selectedAudioStream!(), 2)
  const tracks = JSON.parse(f.native.read()['track-list']!) as Array<{ type: string; id: number; selected: boolean }>
  assert.equal(tracks.some(track => track.type === 'sub' && track.selected), false)
  assert.equal(tracks.find(track => track.type === 'audio' && track.selected)?.id, 4)
})
