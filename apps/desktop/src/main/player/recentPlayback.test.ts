import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import type { ScopedVideoDetail } from '@shared/catalogTypes'
import { createRecentPlayback, recentPlaybackCatalogKey } from './recentPlayback'

function video(id: number): ScopedVideoDetail {
  return { id, code: `V-${id}`, title: '播放资料', cover_path: null, scraped_status: 1, resource_kinds: ['local'],
    resources: [{ locator: '/private/film.mp4?secret=grant' }], summary: 'not saved' } as unknown as ScopedVideoDetail
}
function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-recent-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'history.json')
  const backend = { identity: { mode: 'local' as const, catalogId: 'catalog-a' }, generation: 1,
    queries: { getVideo: async ({ videoId }: { videoId: number }) => video(videoId) } }
  let time = 1000, events = 0
  const history = createRecentPlayback(backend, filename, () => events++, () => time)
  return { backend, filename, history, time: (next: number) => { time = next }, events: () => events }
}

test('records device-only narrow snapshots, deduplicates and promotes a repeated play', async t => {
  const f = fixture(t)
  assert.equal(f.history.metadata().video_count, 0)
  await f.history.started(1); await f.history.started(2); await f.history.started(1)
  assert.deepEqual(f.history.page({}).videos.map(item => item.id), [1, 2])
  assert.equal(f.history.metadata().local_kind, 'recently_played')
  assert.equal(f.history.metadata().id, 0)
  assert.equal(f.events(), 3)
  const text = fs.readFileSync(f.filename, 'utf8')
  assert.ok(!/secret|locator|grant|summary|catalog-a/.test(text))
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.filename).mode & 0o777, 0o600)
  f.history.remove(1)
  assert.deepEqual(f.history.page({}).videos.map(item => item.id), [2])
})

test('isolates local/remote catalogs and servers and clears only the current catalog', async t => {
  const f = fixture(t)
  await f.history.started(1)
  f.backend.identity.catalogId = 'catalog-b'
  assert.equal(f.history.metadata().video_count, 0)
  await f.history.started(2)
  f.history.clear()
  assert.equal(f.history.metadata().video_count, 0)
  f.backend.identity.catalogId = 'catalog-a'
  assert.equal(f.history.metadata().video_count, 1)
  const local = recentPlaybackCatalogKey(f.backend.identity)
  assert.notEqual(local, recentPlaybackCatalogKey({ ...f.backend.identity, mode: 'remote', serverId: 'server-a' }))
  assert.notEqual(recentPlaybackCatalogKey({ mode: 'remote', catalogId: 'c', serverId: 'a' }), recentPlaybackCatalogKey({ mode: 'remote', catalogId: 'c', serverId: 'b' }))
})

test('late reads cannot undo clear/remove, cross catalog generation or replace a newer play', async t => {
  const f = fixture(t)
  const requests: Array<(value: ScopedVideoDetail) => void> = []
  f.backend.queries.getVideo = () => new Promise(resolve => requests.push(resolve))
  const old = f.history.started(1)
  const newer = f.history.started(1)
  requests[1](video(1)); await newer
  requests[0]({ ...video(1), title: 'old' }); await old
  assert.equal(f.history.page({}).videos[0].title, '播放资料')
  const pending = f.history.started(2)
  f.history.clear(); requests[2](video(2)); await pending
  assert.equal(f.history.metadata().video_count, 0)
  const changed = f.history.started(3)
  f.backend.generation++; requests[3](video(3)); await changed
  assert.equal(f.history.metadata().video_count, 0)
  const unrelated = f.history.started(4)
  f.history.remove(3)
  requests[4](video(4)); await unrelated
  assert.deepEqual(f.history.page({}).videos.map(item => item.id), [4])
})

test('bounds storage and filters/pages snapshots without catalog queries or remote writes', async t => {
  const f = fixture(t)
  const entries = Array.from({ length: 1000 }, (_, index) => ({ catalog: recentPlaybackCatalogKey(f.backend.identity), playedAt: index,
    video: { id: index + 1, code: `V-${index}`, title: null, cover_path: null, scraped_status: 1, resource_kinds: index % 2 ? ['local'] : ['web'] } }))
  fs.writeFileSync(f.filename, JSON.stringify({ version: 1, entries }))
  await f.history.started(1001)
  assert.equal(f.history.metadata().video_count, 1000)
  const page = f.history.page({ limit: 2, offset: 1, resourceKinds: ['local'] })
  assert.equal(page.total, 1000); assert.equal(page.filteredTotal, 501); assert.equal(page.videos.length, 2)
  for (const query of [{ limit: 101 }, { offset: -1 }, { limit: 0 }]) assert.throws(() => f.history.page(query))
  assert.equal(f.history.page({ resourceKinds: ['none'] }).videos.length, 0)
})

test('does not overwrite corrupt/newer files or an existing file when atomic replacement fails', async t => {
  const f = fixture(t)
  fs.writeFileSync(f.filename, '{"version":2,"entries":[]}')
  await assert.rejects(f.history.started(1), /无法读取/)
  assert.throws(f.history.clear, /无法读取/)
  assert.equal(fs.readFileSync(f.filename, 'utf8'), '{"version":2,"entries":[]}')
  fs.unlinkSync(f.filename)
  await f.history.started(1)
  const previous = fs.readFileSync(f.filename, 'utf8')
  t.mock.method(fs, 'renameSync', () => { throw new Error('disk error') })
  await assert.rejects(f.history.started(2), /无法保存/)
  assert.equal(fs.readFileSync(f.filename, 'utf8'), previous)
  assert.deepEqual(fs.readdirSync(path.dirname(f.filename)), ['history.json'])
})

test('evicts oldest snapshots before a write exceeds the readable UTF-8 byte budget', async t => {
  const f = fixture(t)
  const byteLimit = 8 * 1024 * 1024
  const entry = { catalog: recentPlaybackCatalogKey(f.backend.identity), playedAt: 1,
    video: { ...video(1), cover_path: '封'.repeat(3000), title: null } }
  delete (entry.video as Partial<ScopedVideoDetail>).resources
  delete (entry.video as Partial<ScopedVideoDetail>).summary
  const entries = Array.from({ length: 1000 }, (_, index) => ({ ...entry, playedAt: index, video: { ...entry.video, id: index + 1 } }))
  while (Buffer.byteLength(JSON.stringify({ version: 1, entries })) > byteLimit - 1000) entries.pop()
  fs.writeFileSync(f.filename, JSON.stringify({ version: 1, entries }))
  f.backend.queries.getVideo = async () => ({ ...video(1001), cover_path: '封'.repeat(4096), title: '字'.repeat(1024) })
  await f.history.started(1001)
  assert.ok(fs.statSync(f.filename).size <= byteLimit, 'a successful write must remain readable')
  assert.equal(f.history.page({}).videos[0].id, 1001)
  assert.ok(f.history.metadata().video_count < entries.length + 1)
})
