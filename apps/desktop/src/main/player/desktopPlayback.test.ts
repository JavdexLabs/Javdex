import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { test, type TestContext } from 'node:test'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type { CatalogBackend } from '../application/catalogBackend'
import { createPlaybackSession } from './playbackSession'
import { playbackCatalogKey } from './playbackSource'
import type { NativePlaybackState } from './nativePlayback'
import type { PlaybackSource } from './playbackSource'
import type { createAiSubtitleController } from './aiSubtitles/aiSubtitleController'
import type { BrowserWindow, WebContents } from 'electron'

const requireDependency = createRequire(import.meta.url)
const code = transpileModule(readFileSync(new URL('./desktopPlayback.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
}).outputText

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(t: TestContext, pause: 'recent' | 'playlist', renderPolling = true, platform: NodeJS.Platform = process.platform,
  startup: { args?: readonly string[]; gpuAvailable?: boolean; window?: BrowserWindow;
    retireSurface?: (contents: WebContents, surface: string) => Promise<void> } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'javdex-playback-start-'))
  const entered = deferred(), release = deferred(), finished = deferred()
  const removals: Array<{ catalog: string; videoId: number }> = []
  const released: PlaybackSource[] = []
  const timers = new Map<number, () => void>()
  let resolutions = 0, validations = 0, subtitleStops = 0
  let subtitleDependencies!: Parameters<typeof createAiSubtitleController>[0]
  let generation = 1
  const identity = { mode: 'remote' as const, catalogId: 'catalog-A', serverId: 'server-1' }
  const backend = {
    identity, mode: 'remote', get generation() { return generation },
    session: () => ({ state: 'available', writerEpoch: 1 }),
    playlists: {
      listForVideo: async () => {
        if (pause === 'playlist') { entered.resolve(); await release.promise }
        return [{ id: 2, system_kind: 'watch_later', remove_after_play: 1, contains_video: true, generation: 1, revision: 1 }]
      },
      removeVideo: async ({ videoId }: { videoId: number }) => { removals.push({ catalog: identity.catalogId, videoId }) }
    }
  } as unknown as CatalogBackend
  const source = { target: { libraryId: 1, videoId: 7, resourceId: 9 }, title: 'Synthetic', mode: 'remote',
    locator: 'https://fixture.invalid/video', identityKey: playbackCatalogKey(backend), revision: '1', resumeKey: 'a'.repeat(64) }
  let raw: NativePlaybackState = { alive: true, loadedFiles: 1, pause: false, seekable: true, duration: 300, 'time-pos': 1, presentedFrames: 1 }
  let gpuCreates = 0, cpuCreates = 0
  const native = { renderPolling, create() { gpuCreates++ }, destroy() {}, command() {}, load() {}, read: () => ({ ...raw }), render() {}, viewport() {}, addSubtitle() {} }
  const cpu = { ...native, create() { cpuCreates++ } }
  let session!: ReturnType<typeof createPlaybackSession>
  const mocks: Record<string, unknown> = {
    './linuxPlaybackDevice': { waitForLinuxPlaybackCompositing: async () => {} },
    './macCpuShutdown': { retireMacCpuSurface: startup.retireSurface ?? (async () => {}) },
    electron: { app: { getPath: () => root, isHardwareAccelerationEnabled: () => startup.gpuAvailable ?? true }, dialog: {}, shell: {}, powerSaveBlocker: { start: () => 1, stop() {} }, powerMonitor: { on() {}, off() {} } },
    './libmpvPlayback': { builtinPlaybackAvailability: () => ({ available: true }), createLibmpvPlayback: (_window: unknown, selected?: string) => selected === 'software' ? cpu : native },
    './playbackSource': { playbackCatalogKey, createPlaybackSourceResolver: () => ({
      resolve: async (target: PlaybackSource['target']) => { resolutions++; return { ...structuredClone(source), target } },
      validate: async () => { validations++ }, release: (value: PlaybackSource) => { released.push(value) }
    }) },
    '../ipc/appContractAdapter': { appCommandAdapter: { register() {} }, appEventAdapter: { send() {} } },
    '../desktop/windowNavigation': { navigateWindowHistory() {} },
    './aiSubtitles/aiSubtitleController': { createAiSubtitleController: (dependencies: typeof subtitleDependencies) => {
      subtitleDependencies = dependencies
      return { tick() {}, stop: async () => { subtitleStops++ }, close: async () => {}, snapshot() {}, command() {} }
    } },
    '../services/localModels/desktopLocalModels': { getLocalModels: () => ({ subtitleRuntime: () => ({}), acquireSubtitleRuntime() {}, onChanged() {} }) },
    './playbackSession': { createPlaybackSession: (dependencies: Parameters<typeof createPlaybackSession>[0]) => {
      const started = dependencies.started
      session = createPlaybackSession({ ...dependencies, started: async value => {
        try { await started(value) } finally { finished.resolve() }
      } })
      return session
    } }
  }
  const exports = {} as typeof import('./desktopPlayback')
  runInNewContext(code, { exports, Buffer, process: { ...process, platform, argv: [process.execPath, ...(startup.args ?? [])] }, console,
    setInterval: (callback: () => void, ms: number) => { timers.set(ms, callback); return { unref() {} } }, clearInterval() {},
    require: (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : requireDependency(name)
  }, { filename: 'desktopPlayback.ts' })
  const open = exports.registerBuiltinPlayback(backend, () => startup.window ?? null, { read: async () => ({ resumePlayback: false, playbackVolume: 50 }) } as never,
    async () => { if (pause === 'recent') { entered.resolve(); await release.promise } })
  t.after(async () => { release.resolve(); await exports.disposeBuiltinPlayback(); rmSync(root, { recursive: true, force: true }) })
  return { removals, entered, release, finished, open, source, released, native, timers, snapshot: () => session.snapshot(), subtitles: () => subtitleDependencies,
    setSurface: (surface: string) => { raw = { ...raw, sharedTextureSurface: surface, presentedFrames: 0 } },
    control: (command: Parameters<typeof session.control>[1]) => session.control(session.snapshot()!.sessionId, command),
    dispose: () => exports.disposeBuiltinPlayback(),
    resolutions: () => resolutions, validations: () => validations, subtitleStops: () => subtitleStops,
    creates: () => ({ gpu: gpuCreates, cpu: cpuCreates }),
    restore: () => { identity.catalogId = 'catalog-B'; generation++; exports.stopBuiltinPlayback() },
    start: async () => {
      assert.equal((await open(source.target)).ok, true)
      session.tick()
      raw = { ...raw, 'time-pos': 1.2, presentedFrames: 2 }
      session.tick()
      await entered.promise
    } }
}

test('macOS CPU shutdown stops playback and waits for the current renderer surface to retire', async t => {
  const retire = deferred(), calls: Array<{ contents: WebContents; surface: string }> = []
  t.after(() => retire.resolve())
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, focus() {}, getZoomFactor: () => 1 }) as unknown as WebContents
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false,
    isFullScreen: () => false, setFullScreen() {}, getContentSize: () => [1280, 720] }) as unknown as BrowserWindow
  const f = fixture(t, 'recent', false, 'darwin', { args: ['--javdex-cpu'], window,
    retireSurface: (received, surface) => { calls.push({ contents: received, surface }); return retire.promise } })
  assert.equal((await f.open(f.source.target)).ok, true)
  const surface = 'cpu:11111111-1111-4111-8111-111111111111'
  f.setSurface(surface); f.timers.get(200)!()
  assert.equal(f.snapshot()?.sharedTextureSurface, surface)
  let settled = false
  const pending = f.dispose().then(() => { settled = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.snapshot(), null, 'the producer is stopped before awaiting the renderer')
  assert.deepEqual(calls, [{ contents, surface }])
  assert.equal(settled, false, 'shutdown must wait for renderer retirement')
  retire.resolve(); await pending
})

for (const [platform, args, surface] of [
  ['darwin', [], '11111111-1111-4111-8111-111111111111'],
  ['win32', ['--javdex-cpu'], 'cpu:11111111-1111-4111-8111-111111111111'],
  ['linux', ['--javdex-cpu'], 'cpu:11111111-1111-4111-8111-111111111111']
] as const) test(`${platform} ${surface.startsWith('cpu:') ? 'CPU' : 'GPU'} shutdown does not use the Mac CPU retirement handshake`, async t => {
  const calls: string[] = []
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, focus() {}, getZoomFactor: () => 1 }) as unknown as WebContents
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false,
    isFullScreen: () => false, setFullScreen() {}, getContentSize: () => [1280, 720], focusOnWebView() {} }) as unknown as BrowserWindow
  const f = fixture(t, 'recent', false, platform, { args, window, retireSurface: async (_contents, token) => { calls.push(token) } })
  assert.equal((await f.open(f.source.target)).ok, true)
  f.setSurface(surface); f.timers.get(200)!()
  assert.equal(f.snapshot()?.sharedTextureSurface, surface)
  if (platform === 'darwin') f.native.read = () => {
    throw Object.assign(new Error('graphics failure'), { playbackFailureKind: 'graphics' })
  }
  await f.dispose()
  assert.deepEqual(calls, [])
  if (platform === 'darwin') assert.equal(f.creates().cpu, 0, 'quit must not start CPU recovery')
})

for (const [name, startup, expected] of [
  ['default', {}, 'gpu'],
  ['forced', { args: ['--javdex-cpu'] }, 'cpu'],
  ['disabled acceleration', { gpuAvailable: false }, 'cpu'],
  ['argument after --', { args: ['--', '--javdex-cpu'] }, 'gpu']
] as const) test(`macOS ${name} selects the correct backend through the production registration`, async t => {
  const f = fixture(t, 'recent', false, 'darwin', startup)
  assert.equal((await f.open(f.source.target)).ok, true)
  f.timers.get(200)!()
  assert.equal(f.snapshot()!.info.playbackMode, expected)
  assert.deepEqual(f.creates(), { gpu: expected === 'gpu' ? 1 : 0, cpu: expected === 'cpu' ? 1 : 0 })
})

for (const platform of ['darwin', 'win32', 'linux'] as const)
  for (const flag of ['--javdex-software', '--javdex-startup-recovery=1'])
    test(`${platform}: ${flag} forces CPU through production playback registration`, async t => {
      const f = fixture(t, 'recent', false, platform, { args: [flag] })
      assert.equal((await f.open(f.source.target)).ok, true)
      f.timers.get(200)!()
      assert.deepEqual(f.creates(), { gpu: 0, cpu: 1 })
      assert.equal(f.snapshot()!.info.playbackMode, 'cpu')
    })

test('macOS graphics failure recovers in CPU without requesting another authorization', async t => {
  const f = fixture(t, 'recent', false, 'darwin')
  assert.equal((await f.open(f.source.target)).ok, true)
  f.timers.get(200)!()
  f.native.read = () => { throw Object.assign(new Error('macOS 共享视频帧消费失败'), { playbackFailureKind: 'graphics' }) }
  f.timers.get(200)!()
  assert.equal(f.snapshot()!.info.playbackMode, 'cpu')
  assert.equal(f.snapshot()!.info.playbackFallback, true)
  assert.equal(f.resolutions(), 1)
  assert.deepEqual(f.creates(), { gpu: 1, cpu: 1 })
})

test('macOS shutdown retires the CPU surface after automatic GPU recovery', async t => {
  const calls: string[] = []
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, focus() {}, getZoomFactor: () => 1 }) as unknown as WebContents
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false,
    isFullScreen: () => false, setFullScreen() {}, getContentSize: () => [1280, 720] }) as unknown as BrowserWindow
  const f = fixture(t, 'recent', false, 'darwin', { window, retireSurface: async (_contents, surface) => { calls.push(surface) } })
  assert.equal((await f.open(f.source.target)).ok, true)
  f.timers.get(200)!()
  const surface = 'cpu:11111111-1111-4111-8111-111111111111'
  f.setSurface(surface)
  f.native.read = () => { throw Object.assign(new Error('graphics failure'), { playbackFailureKind: 'graphics' }) }
  f.timers.get(200)!()
  f.timers.get(200)!()
  assert.equal(f.snapshot()?.info.playbackMode, 'cpu')
  assert.equal(f.snapshot()?.info.playbackFallback, true)
  assert.equal(f.snapshot()?.sharedTextureSurface, surface)
  await f.dispose()
  assert.deepEqual(calls, [surface])
})

test('macOS shutdown finds a CPU surface when recovery outruns the state sample', async t => {
  const calls: string[] = []
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, focus() {}, getZoomFactor: () => 1 }) as unknown as WebContents
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false,
    isFullScreen: () => false, setFullScreen() {}, getContentSize: () => [1280, 720] }) as unknown as BrowserWindow
  const f = fixture(t, 'recent', false, 'darwin', { window, retireSurface: async (_contents, surface) => { calls.push(surface) } })
  assert.equal((await f.open(f.source.target)).ok, true)
  f.setSurface('11111111-1111-4111-8111-111111111111'); f.timers.get(200)!()
  const cpuSurface = 'cpu:22222222-2222-4222-8222-222222222222'
  f.setSurface(cpuSurface)
  f.native.command = () => { throw Object.assign(new Error('graphics failure'), { playbackFailureKind: 'graphics' }) }
  f.control({ kind: 'pause', paused: true })
  assert.notEqual(f.snapshot()?.sharedTextureSurface, cpuSurface)
  await f.dispose()
  assert.deepEqual(calls, [cpuSurface])
})

test('self-driven native hosts omit the render poll but still publish controlled failures through state observation', async t => {
  // The self-driven host is macOS; Linux deliberately wraps its native hosts
  // in a polling fallback controller, independently of the test runner's OS.
  const f = fixture(t, 'recent', false, 'darwin')
  assert.equal((await f.open(f.source.target)).ok, true)
  assert.equal(f.timers.has(16), false)
  assert.ok(f.timers.has(200))
  f.native.read = () => { throw Object.assign(new Error('private native state'), { code: 'PLAYBACK_RESTART_REQUIRED' }) }
  f.timers.get(200)!()
  assert.match(f.snapshot()!.error!, /重启应用/)
})

for (const interval of [16, 200]) {
  for (const restart of [false, true]) {
    test(`${interval}ms playback observer preserves restart-required failures without exposing native details: ${restart}`, async t => {
      const f = fixture(t, 'recent')
      assert.equal((await f.open(f.source.target)).ok, true)
      const error = Object.assign(new Error('/private/movie.mp4?token=secret'), restart ? { code: 'PLAYBACK_RESTART_REQUIRED' } : {})
      if (interval === 16) f.native.render = () => { throw error }
      else f.native.read = () => { throw error }
      f.timers.get(interval)!()
      const state = f.snapshot()!
      assert.equal(state.phase, 'error')
      assert.equal(state.error!.includes('重启应用'), restart)
      assert.ok(!state.error!.includes('/private'))
      assert.ok(!state.error!.includes('secret'))
    })
  }
}

for (const pause of ['recent', 'playlist'] as const) {
  test(`a restore during ${pause} lookup cannot remove watch-later from another catalog`, { timeout: 5000 }, async t => {
    const f = fixture(t, pause)
    await f.start()
    f.restore()
    f.release.resolve()
    await f.finished.promise
    assert.deepEqual(f.removals, [])
  })
}

test('confirmed playback still removes its original watch-later item', { timeout: 5000 }, async t => {
  const f = fixture(t, 'recent')
  await f.start()
  f.release.resolve()
  await f.finished.promise
  assert.deepEqual(f.removals, [{ catalog: 'catalog-A', videoId: 7 }])
})

test('more than 128 subtitle chunks share the decoder grant and switching ends old subtitle ownership', async t => {
  const f = fixture(t, 'recent')
  assert.equal((await f.open(f.source.target)).ok, true)
  for (let index = 0; index < 260; index++) {
    const resolved = await f.subtitles().resolve(f.source as PlaybackSource)
    assert.equal(resolved.locator, f.source.locator)
  }
  assert.equal(f.resolutions(), 1)
  assert.equal(f.validations(), 260, 'reuse must still verify resource and catalog identity')
  assert.equal(f.released.length, 0, 'subtitle reads cannot release the decoder route')
  assert.equal((await f.open({ ...f.source.target, resourceId: 10 })).ok, true)
  assert.equal(f.subtitleStops(), 1)
  assert.equal(f.released.length, 1)
  assert.equal(f.released[0].target.resourceId, 9)
})
