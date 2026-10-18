import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

const requireDependency = createRequire(import.meta.url)
const code = transpileModule(readFileSync(new URL('./desktopPlayback.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
}).outputText

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(t: TestContext, pause: 'recent' | 'playlist') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'javdex-playback-start-'))
  const entered = deferred(), release = deferred(), finished = deferred()
  const removals: Array<{ catalog: string; videoId: number }> = []
  const released: PlaybackSource[] = []
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
  const native = { create() {}, destroy() {}, command() {}, load() {}, read: () => ({ ...raw }), render() {}, viewport() {}, addSubtitle() {} }
  let session!: ReturnType<typeof createPlaybackSession>
  const mocks: Record<string, unknown> = {
    electron: { app: { getPath: () => root }, dialog: {}, shell: {}, powerSaveBlocker: { start: () => 1, stop() {} }, powerMonitor: { on() {}, off() {} } },
    './libmpvPlayback': { builtinPlaybackAvailability: () => ({ available: true }), createLibmpvPlayback: () => native },
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
  runInNewContext(code, { exports, Buffer, process, console,
    setInterval: () => ({ unref() {} }), clearInterval() {},
    require: (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : requireDependency(name)
  }, { filename: 'desktopPlayback.ts' })
  const open = exports.registerBuiltinPlayback(backend, () => null, { read: async () => ({ resumePlayback: false, playbackVolume: 50 }) } as never,
    async () => { if (pause === 'recent') { entered.resolve(); await release.promise } })
  t.after(async () => { release.resolve(); await exports.disposeBuiltinPlayback(); rmSync(root, { recursive: true, force: true }) })
  return { removals, entered, release, finished, open, source, released, subtitles: () => subtitleDependencies,
    resolutions: () => resolutions, validations: () => validations, subtitleStops: () => subtitleStops,
    restore: () => { identity.catalogId = 'catalog-B'; generation++; exports.stopBuiltinPlayback() },
    start: async () => {
      assert.equal((await open(source.target)).ok, true)
      session.tick()
      raw = { ...raw, 'time-pos': 1.2, presentedFrames: 2 }
      session.tick()
      await entered.promise
    } }
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
