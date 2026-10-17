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
    './playbackSource': { playbackCatalogKey, createPlaybackSourceResolver: () => ({ resolve: async () => structuredClone(source), validate: async () => {} }) },
    '../ipc/appContractAdapter': { appCommandAdapter: { register() {} }, appEventAdapter: { send() {} } },
    '../desktop/windowNavigation': { navigateWindowHistory() {} },
    './aiSubtitles/aiSubtitleController': { createAiSubtitleController: () => ({ tick() {}, close: async () => {}, snapshot() {}, command() {} }) },
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
  return { removals, entered, release, finished,
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
