import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { IPC } from '@shared/ipc-channels'
import type { CatalogBackend } from '../application/catalogBackend'
import { removePlayedWatchLater } from '../application/watchLaterPlayback'

function load<T>(relative: string, mocks: Record<string, unknown>): T {
  const url = new URL(relative, import.meta.url)
  const fallback = createRequire(url)
  const code = transpileModule(readFileSync(url, 'utf8'), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  const exports = {}
  runInNewContext(code, { exports, process, Buffer, console,
    require: (name: string) => Object.hasOwn(mocks, name) ? mocks[name] : fallback(name)
  }, { filename: url.pathname })
  return exports as T
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

for (const mode of ['local', 'remote'] as const) {
  for (const pause of ['launch', 'recent', 'playlist', 'preference', 'path', ...(mode === 'remote' ? ['query', 'grant'] : [])]) {
    for (const change of ['catalog', 'generation', 'none'] as const) {
    test(`${mode} external playback ${pause} boundary with ${change} change`, { timeout: 5000 }, async () => {
      const entered = deferred(), release = deferred()
      const state = { catalogId: 'A', generation: 1 }
      const starts: string[] = [], removals: string[] = [], launches: string[] = []
      const boundary = async (name: string) => { if (pause === name) { entered.resolve(); await release.promise } }
      const resource = { id: 3, library_id: 1, video_id: 7, kind: 'local', locator: '/synthetic/movie.mp4', is_primary: 1 }
      const backend = {
        mode, get identity() { return { mode, catalogId: state.catalogId, serverId: mode === 'remote' ? 'server-1' : undefined } },
        get generation() { return state.generation }, session: () => ({ state: 'available', writerEpoch: 1 }),
        queries: { getResource: async () => { await boundary('query'); return resource } },
        assets: { grantPlayback: async () => { await boundary('grant'); return { playbackHandle: 'https://synthetic.invalid/grant' } } },
        playlists: {
          listForVideo: async () => { await boundary('playlist'); return [{ id: 2, generation: 1, revision: 1, system_kind: 'watch_later', remove_after_play: 1, contains_video: true }] },
          removeVideo: async () => { removals.push(state.catalogId) }
        }
      } as unknown as CatalogBackend
      const launch = async () => { launches.push(state.catalogId); await boundary('launch'); return { ok: true } }
      const serviceModule = load<typeof import('../services/playerService')>('../services/playerService.ts', {
        electron: { shell: {} },
        '@library/db/mediaLibraryRepo': { getMediaLibrary: () => ({ status: 'active' }) },
        '@library/db/videoRepo': { getVideoById: () => ({ id: 7 }), getPrimaryVideoResource: () => resource, getVideoResourceInLibrary: () => resource },
        '@library/catalog/catalogPlay': { resourceLocatorRevision: () => 'synthetic' }
      })
      type Handler = (libraryId: number, resourceId: number, videoId?: number) => Promise<unknown>
      const handlers = new Map<string, Handler>()
      const handlerModule = load<typeof import('./playerHandlers')>('./playerHandlers.ts', {
        '../services/playerService': { createPlayerService: (dependencies: Parameters<typeof serviceModule.createPlayerService>[0]) => serviceModule.createPlayerService({ ...dependencies, fileExists: () => true, spawnPlayer: launch }) },
        './appContractAdapter': { appCommandAdapter: { register: (name: string, handler: Handler) => handlers.set(name, handler) } },
        '../application/watchLaterPlayback': { removePlayedWatchLater }
      })
      let settingsReads = 0
      const settings = { read: async () => { await boundary(++settingsReads === 1 ? 'preference' : 'path'); return { playerPreference: 'external', playerPath: '/synthetic/player' } } }
      handlerModule.registerPlayerHandlers(backend, settings as never, async () => { throw new Error('unexpected native open') }, async () => {
        starts.push(state.catalogId)
        await boundary('recent')
      })
      const operation = handlers.get(IPC.PLAYER_OPEN_RESOURCE)!(1, 3, 7)
      await entered.promise
      if (change === 'catalog') state.catalogId = 'B'
      if (change !== 'none') state.generation++
      release.resolve()
      await operation
      assert.ok(!starts.includes('B'), 'late launch must not record a different catalog as recently played')
      assert.deepEqual(removals, change === 'none' ? ['A'] : [], 'only the original live owner may remove its watch-later item')
      assert.ok(!launches.includes('B'), 'stale lookup must not launch a replacement catalog resource')
      if (change === 'none') { assert.deepEqual(starts, ['A']); assert.deepEqual(launches, ['A']) }
    })
    }
  }
}
