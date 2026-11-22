import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import type { CatalogIdentity } from '@shared/protocol/identity'
import { DIRECT_ID_BATCH_MAX } from '@shared/protocol/limits'
import type { VideoCard } from '@shared/videoTypes'
import { createRecentPlayback, recentPlaybackCatalogKey } from './recentPlayback'

function video(id: number): VideoCard {
  return { id, code: `V-${id}`, title: '当前标题', cover_path: null, scraped_status: 1, resource_kinds: ['local'] }
}

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-recent-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'history.json')
  const backend = { identity: { mode: 'local', catalogId: 'catalog-a' } as CatalogIdentity, generation: 1,
    queries: { videoCardsByIds: async ({ videoIds }: { videoIds: number[] }) => videoIds.map(video) } }
  let events = 0
  const history = createRecentPlayback(backend, filename, () => events++, () => 1000)
  const catalog = () => recentPlaybackCatalogKey(backend.identity)
  const read = () => JSON.parse(fs.readFileSync(filename, 'utf8'))
  return { backend, filename, history, catalog, read, events: () => events }
}

test('saves only device history keys and promotes a repeated play without reading the catalog', async t => {
  const f = fixture(t)
  assert.equal((await f.history.metadata()).video_count, 0)
  const queries = t.mock.method(f.backend.queries, 'videoCardsByIds')
  f.history.started(1); f.history.started(2); f.history.started(1)
  assert.equal(queries.mock.callCount(), 0)
  assert.deepEqual(f.read(), { version: 2, entries: [
    { catalog: f.catalog(), videoId: 1, playedAt: 1002 },
    { catalog: f.catalog(), videoId: 2, playedAt: 1001 }
  ] })
  assert.deepEqual((await f.history.page({})).videos.map(item => item.id), [1, 2])
  assert.equal((await f.history.metadata()).local_kind, 'recently_played')
  assert.equal((await f.history.metadata()).id, 0)
  assert.equal(f.events(), 3)
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.filename).mode & 0o777, 0o600)
  f.history.remove(1)
  assert.deepEqual((await f.history.page({})).videos.map(item => item.id), [2])
})

test('migrates old snapshots and returns the current cover, title and resource kinds in the original order', async t => {
  const f = fixture(t)
  const catalog = f.catalog()
  const entries = [
    { catalog, playedAt: 1090, video: video(1) },
    { catalog, playedAt: 1100, video: { ...video(534), title: '旧标题', code: 'ATKD-107', cover_path: 'covers/ATKD-107_e8481fbc.jpg' } },
    { catalog, playedAt: 1090, video: video(2) }
  ]
  fs.writeFileSync(f.filename, JSON.stringify({ version: 1, entries }))
  const updated: VideoCard = { ...video(534), code: 'ATKD-107', cover_path: 'covers/ATKD-107_3110336e.jpg', resource_kinds: ['web'] }
  const queries = t.mock.method(f.backend.queries, 'videoCardsByIds', async ({ videoIds }: { videoIds: number[] }) =>
    videoIds.map(id => id === updated.id ? updated : video(id)))
  const page = await f.history.page({})
  assert.deepEqual(page.videos.map(item => item.id), [534, 2, 1])
  assert.deepEqual(page.videos[0], updated)
  assert.deepEqual(queries.mock.calls[0].arguments[0].videoIds, [1, 2, 534])
  assert.equal((await f.history.metadata()).updated_at, new Date(1100).toISOString())
  assert.deepEqual((await f.history.page({ resourceKinds: ['web'] })).videos.map(item => item.id), [534])
  assert.deepEqual(f.read(), { version: 2, entries: [
    { catalog, playedAt: 1100, videoId: 534 },
    { catalog, playedAt: 1090, videoId: 2 },
    { catalog, playedAt: 1090, videoId: 1 }
  ] })
  assert.equal(f.events(), 0, 'changing the file format does not change the playback history')
})

test('isolates local/remote catalogs and servers and clears only the current catalog', async t => {
  const f = fixture(t)
  f.history.started(1)
  f.backend.identity.catalogId = 'catalog-b'
  assert.equal((await f.history.metadata()).video_count, 0)
  f.history.started(2)
  f.history.clear()
  assert.equal((await f.history.metadata()).video_count, 0)
  f.backend.identity.catalogId = 'catalog-a'
  assert.equal((await f.history.metadata()).video_count, 1)
  assert.notEqual(f.catalog(), recentPlaybackCatalogKey({ ...f.backend.identity, mode: 'remote', serverId: 'server-a' }))
  assert.notEqual(recentPlaybackCatalogKey({ mode: 'remote', catalogId: 'c', serverId: 'a' }),
    recentPlaybackCatalogKey({ mode: 'remote', catalogId: 'c', serverId: 'b' }))
})

test('bounds storage and batches, and filters before paginating', async t => {
  const f = fixture(t)
  const entries = Array.from({ length: 1000 }, (_, index) => ({ catalog: f.catalog(), playedAt: index, videoId: index + 1 }))
  fs.writeFileSync(f.filename, JSON.stringify({ version: 2, entries }))
  f.history.started(1001)
  const lookups = t.mock.method(f.backend.queries, 'videoCardsByIds', async ({ videoIds }: { videoIds: number[] }) =>
    videoIds.map(id => ({ ...video(id), resource_kinds: id % 2 ? ['local'] : ['web'] } satisfies VideoCard)))
  const page = await f.history.page({ limit: 2, offset: 1, resourceKinds: ['local'] })
  assert.equal(page.total, 1000); assert.equal(page.filteredTotal, 500)
  assert.deepEqual(page.videos.map(item => item.id), [999, 997])
  assert.equal(lookups.mock.callCount(), Math.ceil(1000 / DIRECT_ID_BATCH_MAX))
  assert.ok(lookups.mock.calls.every(call => call.arguments[0].videoIds.length <= DIRECT_ID_BATCH_MAX))
  for (const query of [{ limit: 101 }, { offset: -1 }, { limit: 0 }]) await assert.rejects(f.history.page(query))
})

test('prunes confirmed deletions and keeps playback events in other catalogs', async t => {
  const f = fixture(t)
  f.backend.identity.catalogId = 'other'
  f.history.started(2)
  f.backend.identity.catalogId = 'catalog-a'
  for (const id of [1, 2, 3, 4]) f.history.started(id)
  f.backend.queries.videoCardsByIds = async ({ videoIds }) => videoIds.filter(id => id % 2 === 1).map(video)
  const page = await f.history.page({ resourceKinds: ['local'], limit: 1, offset: 1 })
  assert.deepEqual(page.videos.map(item => item.id), [1])
  assert.equal(page.total, 2)
  assert.equal(page.filteredTotal, 2)
  assert.equal(f.events(), 6)
  assert.equal((await f.history.metadata()).video_count, 2)
  assert.equal(f.events(), 6, 'a second read should not rewrite history')
  assert.deepEqual(f.read().entries.map((entry: { videoId: number }) => entry.videoId), [3, 1, 2])
})

test('an outstanding card read respects a replay, a clear and a catalog switch', async t => {
  const f = fixture(t)
  f.history.started(1)
  let finish!: (found: VideoCard[]) => void
  const waitForCards = () => new Promise<VideoCard[]>(resolve => { finish = resolve })
  f.backend.queries.videoCardsByIds = waitForCards
  const beforeReplay = f.history.page({})
  f.history.started(1); f.history.started(2)
  f.backend.queries.videoCardsByIds = async ({ videoIds }) => videoIds.map(video)
  finish([])
  assert.deepEqual((await beforeReplay).videos.map(item => item.id), [2, 1])

  f.backend.queries.videoCardsByIds = waitForCards
  const beforeClear = f.history.metadata()
  f.history.clear()
  finish([video(1)])
  assert.equal((await beforeClear).video_count, 0)

  f.history.started(3)
  const beforeSwitch = f.history.page({})
  f.backend.generation++
  finish([])
  await assert.rejects(beforeSwitch, /资料库已切换/)
  assert.equal(f.events(), 5)
})

test('an incomplete remote read retains all records and reports that current cards are unavailable', async t => {
  const f = fixture(t)
  f.backend.identity = { mode: 'remote', catalogId: 'catalog-a', serverId: 'server-a' }
  const entries = Array.from({ length: DIRECT_ID_BATCH_MAX + 1 }, (_, i) => ({ catalog: f.catalog(), playedAt: i, videoId: i + 1 }))
  const serialized = JSON.stringify({ version: 2, entries })
  fs.writeFileSync(f.filename, serialized)
  f.backend.queries.videoCardsByIds = async ({ videoIds }) => {
    if (videoIds.includes(entries.length)) throw new Error('unavailable')
    return []
  }
  assert.equal((await f.history.metadata()).video_count, entries.length)
  await assert.rejects(f.history.page({}), /暂时无法读取/)
  assert.equal(fs.readFileSync(f.filename, 'utf8'), serialized)
  f.backend.queries.videoCardsByIds = async () => []
  assert.equal((await f.history.metadata()).video_count, 0)
})

test('protects newer files and keeps existing history when atomic replacement fails', t => {
  const f = fixture(t)
  fs.writeFileSync(f.filename, '{"version":3,"entries":[]}')
  assert.throws(() => f.history.started(1), /无法读取/)
  assert.throws(f.history.clear, /无法读取/)
  assert.equal(fs.readFileSync(f.filename, 'utf8'), '{"version":3,"entries":[]}')
  fs.unlinkSync(f.filename)
  f.history.started(1)
  const previous = fs.readFileSync(f.filename, 'utf8')
  t.mock.method(fs, 'renameSync', () => { throw new Error('disk error') })
  assert.throws(() => f.history.started(2), /无法保存/)
  assert.equal(fs.readFileSync(f.filename, 'utf8'), previous)
  assert.deepEqual(fs.readdirSync(path.dirname(f.filename)), ['history.json'])
})
