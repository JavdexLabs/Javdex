import { createAsyncVideoQueryService } from './videoQueryService'
import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { initDatabaseAtPath, closeDatabase, getDatabaseReadRevision } from '@library/db/database'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { createScopedVideoCatalogRepo } from '@library/db/scopedVideoCatalogRepo'
import { createHomeDiscoveryRepo } from '@library/db/homeDiscoveryRepo'
import { registerVideoHandlers } from '../ipc/videoHandlers'
import { registerMediaLibraryHandlers } from '../ipc/mediaLibraryHandlers'
import { createTypedIpcAdapter } from '../ipc/typedIpcAdapter'
import { createMediaLibraryCommandAdapter } from '../ipc/mediaLibraryContractAdapter'
import { videoIpcSchemas } from '../ipc/ipcCommandSchemas'
import type { ScopedVideoListResult } from '@shared/catalogTypes'
import type { VideoIpcContract } from '@shared/videoIpcContract'
import { IPC } from '@shared/ipc-channels'
import { WebCatalog } from '../web/catalog'
import { createWorkerWebCatalog } from '../web/catalogWorkerAdapter'
import { CatalogReadWorkerClient } from './catalogReadWorkerClient'
import { createCatalogReadWorkerTransport } from './catalogReadWorkerTransport'
import { createLocalCatalogBackend } from '../backends/local/localCatalogBackend'

let root: string
let bundle: string
let previous: string | undefined
let client: CatalogReadWorkerClient | undefined
let sequence = 0
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-highfreq-worker-'))
  bundle = path.join(root, 'worker.cjs')
  const built = buildSync({ entryPoints: [path.resolve('apps/desktop/src/main/services/catalogReadWorker.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', metafile: true,
    tsconfig: path.resolve('tsconfig.node.json'),
    banner: { js: `require = require('node:module').createRequire(${JSON.stringify(path.resolve('package.json'))});` } })
  // New Web SQL has no path through the main-process media adapter or service singleton.
  assert.ok(!Object.keys(built.metafile!.inputs).some(file => /web\/(catalog|catalogWorkerAdapter)\.ts$/.test(file)))
})
beforeEach(() => { previous = process.env.JAVDEX_TEST_USER_DATA; process.env.JAVDEX_TEST_USER_DATA = root })
afterEach(async () => {
  try { await client?.dispose() } finally {
    client = undefined; closeDatabase()
    if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previous
  }
})
after(() => fs.rmSync(root, { recursive: true, force: true }))
function setup() {
  const db = initDatabaseAtPath(path.join(root, `${sequence++}.db`))
  for (let i = 0; i < 75; i++) insertTestVideoWithFile(db, {
    code: `READ-${i}`, filePath: `/synthetic/${i}.mp4`, title: i % 2 ? 'Literal %_\\' : 'Other',
    releaseDate: i % 3 ? '2025-01-01' : null
  })
  db.exec("INSERT INTO tags(id,name) VALUES(1,'Manual'); INSERT INTO video_tag(video_id,tag_id,origin) VALUES(1,1,'manual')")
  client = new CatalogReadWorkerClient({ contextProvider: () => {
    const revision = getDatabaseReadRevision(db)
    return { identity: db, path: db.name, revision: JSON.stringify([revision.changes, revision.dataVersion]) }
  }, transportFactory: context => createCatalogReadWorkerTransport(bundle, context.path) })
  return db
}

it('routes actual desktop IPC registration and Web catalog queries through the native reader', async t => {
  const db = setup()
  const catalog = createScopedVideoCatalogRepo(db)
  const home = createHomeDiscoveryRepo({ database: db })
  const legacy = new WebCatalog(db)
  const scope = { kind: 'all' as const }
  const input = { seed: 'fixture' }
  const expected = { list: catalog.list(scope, { limit: 60 }), years: catalog.listYears(scope),
    home: home.load(input), search: home.search({ search: 'READ', limit: 60 }),
    web: legacy.browse(new URLSearchParams('q=READ')), webHome: legacy.home('fixture'), collections: legacy.collections() }
  const handlers = new Map<string, (event: never, ...args: unknown[]) => unknown>()
  const queries = createAsyncVideoQueryService(client!)
  const backend = createLocalCatalogBackend({
    identity: { mode: 'local', catalogId: 'highfreq-worker' },
    queries,
    reads: {
      homeLoad: (input) => client!.readHome(input),
      homeSearch: (input) => client!.searchHome(input),
      tagFilterOptions: (query) => client!.read(query),
      imagePage: (entity, query) => client!.readImageCandidates(entity, query ?? {})
    }
  })
  registerVideoHandlers(
    backend,
    undefined,
    createTypedIpcAdapter<VideoIpcContract>(videoIpcSchemas, (channel, handler) =>
      handlers.set(channel, handler)
    )
  )
  registerMediaLibraryHandlers(
    backend,
    undefined,
    createMediaLibraryCommandAdapter((channel, handler) => handlers.set(channel, handler))
  )
  const web = createWorkerWebCatalog(db, client!)
  const prepare = db.prepare.bind(db)
  t.mock.method(db, 'prepare', (sql: string) => {
    assert.ok(!/\b(?:FROM|JOIN)\s+(?:videos|media_libraries|library_video_memberships|tags|playlists)\b/i.test(sql), `main catalog SQL: ${sql}`)
    return prepare(sql)
  })
  const actualList = await handlers.get(IPC.VIDEO_LIST)!(undefined as never, scope, { limit: 60 }) as ScopedVideoListResult
  const sameBusinessPage = (actual: ScopedVideoListResult, oracle: ScopedVideoListResult) => {
    const { readRevision: actualRevision, ...actualBusiness } = actual
    const { readRevision: oracleRevision, ...oracleBusiness } = oracle
    assert.equal(typeof actualRevision, 'string')
    assert.equal(typeof oracleRevision, 'string')
    assert.notEqual(actualRevision, oracleRevision, 'different native connections own distinct snapshot identities')
    assert.deepEqual(actualBusiness, oracleBusiness)
  }
  sameBusinessPage(actualList, expected.list)
  const nextPage = await handlers.get(IPC.VIDEO_LIST)!(undefined as never, scope, { limit: 60, offset: 60 }) as ScopedVideoListResult
  assert.equal(nextPage.readRevision, actualList.readRevision, 'unchanged pages from one worker share a revision')
  assert.deepEqual(await handlers.get(IPC.VIDEO_YEARS)!(undefined as never, scope), expected.years)
  assert.deepEqual(await handlers.get(IPC.HOME_LOAD)!(undefined as never, input), expected.home)
  sameBusinessPage(await handlers.get(IPC.HOME_SEARCH)!(undefined as never, { search: 'READ', limit: 60 }) as ScopedVideoListResult, expected.search)
  assert.deepEqual(await web.browse(new URLSearchParams('q=READ')), expected.web)
  assert.deepEqual(await web.home('fixture'), expected.webHome)
  assert.deepEqual(await web.collections(), expected.collections)
  assert.equal((await client!.read({})).items.length, 1)
})

it('preserves Web search/sort/filter/page semantics and observes committed membership changes', async () => {
  const db = setup(), legacy = new WebCatalog(db)
  db.exec("INSERT INTO playlists(id,name) VALUES(1,'List'); INSERT INTO playlist_video(playlist_id,video_id) VALUES(1,1); UPDATE library_video_memberships SET is_hidden=1 WHERE video_id=2")
  const web = createWorkerWebCatalog(db, client!)
  for (const query of ['', 'page=2', 'page=99', 'q=%25_', 'q=READ&year=2025', 'library=1&tag=1', 'playlist=1', 'sort=code', 'sort=rating', 'sort=released']) {
    assert.deepEqual(await web.browse(new URLSearchParams(query)), legacy.browse(new URLSearchParams(query)))
  }
  const before = await client!.readVideos({ kind: 'all' })
  db.exec('UPDATE library_video_memberships SET is_hidden=1')
  assert.ok(before.total > 0)
  assert.equal((await client!.readVideos({ kind: 'all' })).total, 0)
  assert.equal((await web.browse(new URLSearchParams())).total, 0)
  assert.deepEqual(await web.collections(), legacy.collections())
  assert.deepEqual(await client!.readVideoYears({ kind: 'all' }), [])
  assert.deepEqual(await client!.readHome({ seed: 'fixture' }), createHomeDiscoveryRepo({ database: db }).load({ seed: 'fixture' }))
})
