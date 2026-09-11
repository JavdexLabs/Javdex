import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import type { VideoResourceFilter } from '@shared/videoTypes'
import { insertTestVideoWithFile } from './testVideoFixtures'
import {
  addVideoToPlaylist,
  createPlaylistRecord,
  getPlaylistDetail,
  getPlaylistPage,
  getPlaylistMetadata,
  listPlaylistVideoPage,
  listPlaylists,
  listPlaylistsForVideo,
  removeVideoFromPlaylist,
  updatePlaylistRecord
} from './playlistRepo'

let tempRoot: string | null = null

function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-playlist-repo-'))
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const db = getDb()
  insertTestVideoWithFile(db, {
    code: 'IPX-535',
    filePath: 'a.mp4',
    title: 'First',
    releaseDate: '2024-03-01',
    scrapedStatus: 1,
    addTime: '2024-01-01'
  })
  db.prepare('UPDATE videos SET cover_path = ? WHERE code = ?').run('covers/ipx-535.jpg', 'IPX-535')
  insertTestVideoWithFile(db, {
    code: 'MUKD-501',
    filePath: 'b.mp4',
    title: 'Second',
    releaseDate: '2024-04-01',
    scrapedStatus: 1,
    addTime: '2024-01-02'
  })
}

afterEach(() => {
  closeDatabase()
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('playlistRepo', () => {
  it('paginates and filters identically to the full playlist without losing zero-resource rows', () => {
    setupDb()
    const db = getDb()
    db.exec("INSERT INTO videos (id, code, release_date) VALUES (3, 'EMPTY-3', ''), (4, 'EMPTY-4', NULL), (5, 'EMPTY-5', '   ')")
    const id = createPlaylistRecord({ name: 'Paged' })
    for (const videoId of [1, 2, 3, 4, 5]) addVideoToPlaylist({ playlistId: id, videoId })
    db.exec(`UPDATE videos SET release_date = '2024-03-01' WHERE id IN (1, 2);
      INSERT INTO video_resources (library_id, video_id, kind, locator, resource_key)
      VALUES (1, 2, 'web', 'https://example.test/2', 'web:2');`)
    const filterSets: VideoResourceFilter[][] = [[], ['local'], ['none'], ['web'], ['local', 'none']]
    for (const sortBy of ['added_at', 'release_date'] as const) {
      for (const sortDir of ['asc', 'desc'] as const) {
        const full = getPlaylistDetail(id, { sortBy, sortDir })!
        for (const resourceKinds of filterSets) {
          const filtered = full.videos.filter(video => resourceKinds.length === 0 || resourceKinds.some(kind =>
            kind === 'none' ? video.resource_kinds?.length === 0 : video.resource_kinds?.includes(kind)))
          const actual = []
          for (let offset = 0; offset <= filtered.length; offset++) {
            const page = getPlaylistPage(id, { sortBy, sortDir, resourceKinds, offset, limit: 1 })!
            assert.equal(page.total, 5)
            assert.equal(page.filteredTotal, filtered.length)
            assert.equal(page.preview_cover_path, full.videos.find(video => video.cover_path)?.cover_path ?? null)
            assert.ok(page.videos.length <= 1)
            actual.push(...page.videos)
          }
          assert.deepEqual(actual, filtered.map(({ id, code, title, cover_path, scraped_status,
            has_pending_scrape, resource_kinds }) => ({
            id, code, title, cover_path, scraped_status, has_pending_scrape, resource_kinds
          })))
        }
      }
    }
    assert.equal(getPlaylistPage(-1), null)
  })

  it('limits a large playlist before returning card details', () => {
    setupDb()
    const db = getDb()
    const id = createPlaylistRecord({ name: 'Large' })
    db.exec(`WITH RECURSIVE n(id) AS (SELECT 3 UNION ALL SELECT id + 1 FROM n WHERE id < 30002)
      INSERT INTO videos (id, code) SELECT id, 'PAGE-' || id FROM n;
      INSERT INTO playlist_video (playlist_id, video_id, position, added_at)
        SELECT ${id}, id, id, '2026' FROM videos;`)
    db.exec(`UPDATE videos SET summary = printf('%65536s', 'long description')
      WHERE id IN (SELECT video_id FROM playlist_video WHERE playlist_id = ${id}
        ORDER BY added_at DESC, position DESC, video_id DESC LIMIT 200 OFFSET 200)`)
    const page = getPlaylistPage(id, { offset: 200, limit: 999 })!
    assert.equal(page.total, 30002)
    assert.equal(page.videos.length, 200)
    assert.equal(page.limit, 200)
    assert.ok(page.videos.every(video => !Object.hasOwn(video, 'summary')))
    assert.equal(new Set(page.videos.map(video => video.id)).size, 200)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 512 * 1024)
  })

  it('keeps metadata out of subsequent video-page queries', () => {
    setupDb()
    const db = getDb()
    const description = 'metadata-only '.repeat(10000)
    const id = createPlaylistRecord({ name: 'Metadata', description })
    addVideoToPlaylist({ playlistId: id, videoId: 1 })
    assert.equal(getPlaylistMetadata(id)?.description, description.trim())
    assert.equal(Object.hasOwn(getPlaylistMetadata(id)!, 'videos'), false)
    const statements: string[] = []
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      statements.push(sql)
      return prepare(sql)
    }) as typeof db.prepare
    const page = listPlaylistVideoPage(id)!
    assert.equal(page.total, 1)
    assert.equal(Object.hasOwn(page, 'description'), false)
    assert.equal(statements.some(sql => /SELECT \* FROM playlists|playlist_links|v\.cover_path IS NOT NULL/.test(sql)), false)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 1024)
  })

  it('creates playlists with required name and optional fields', () => {
    setupDb()

    const id = createPlaylistRecord(
      { name: '  Favorites  ', description: '  Keepers  ' },
      'playlist_covers/fav.jpg'
    )

    const items = listPlaylists()
    assert.equal(items.length, 1)
    assert.equal(items[0].id, id)
    assert.equal(items[0].name, 'Favorites')
    assert.equal(items[0].description, 'Keepers')
    assert.equal(items[0].cover_path, 'playlist_covers/fav.jpg')
    assert.equal(items[0].video_count, 0)
  })

  it('adds videos once per playlist and lists detail videos', () => {
    setupDb()
    const id = createPlaylistRecord({ name: 'Queue' })

    assert.equal(addVideoToPlaylist({ playlistId: id, videoId: 1 }), true)
    assert.equal(addVideoToPlaylist({ playlistId: id, videoId: 1 }), false)
    assert.equal(addVideoToPlaylist({ playlistId: id, videoId: 2 }), true)
    const db = getDb()
    db.prepare(
      `UPDATE playlist_video
       SET added_at = CASE video_id
         WHEN 1 THEN '2024-01-03T00:00:00.000Z'
         WHEN 2 THEN '2024-01-04T00:00:00.000Z'
       END
       WHERE playlist_id = ?`
    ).run(id)

    const detail = getPlaylistDetail(id)
    assert.equal(detail?.videos.length, 2)
    assert.deepEqual(detail?.videos.map((video) => video.code), ['MUKD-501', 'IPX-535'])
    assert.deepEqual(
      getPlaylistDetail(id, { sortBy: 'added_at', sortDir: 'asc' })?.videos.map((video) => video.code),
      ['IPX-535', 'MUKD-501']
    )
    assert.deepEqual(
      getPlaylistDetail(id, { sortBy: 'release_date', sortDir: 'asc' })?.videos.map((video) => video.code),
      ['IPX-535', 'MUKD-501']
    )
    assert.equal(listPlaylists()[0].video_count, 2)
    assert.equal(listPlaylists()[0].preview_cover_path, 'covers/ipx-535.jpg')
  })

  it('keeps playlist references visible across hidden, archived and missing memberships', () => {
    setupDb()
    const db = getDb()
    const playlistId = createPlaylistRecord({ name: 'Reachable only' })
    addVideoToPlaylist({ playlistId, videoId: 1 })
    addVideoToPlaylist({ playlistId, videoId: 2 })
    db.prepare('UPDATE library_video_memberships SET is_hidden = 1 WHERE video_id = 2').run()

    assert.deepEqual(getPlaylistDetail(playlistId)?.videos.map((video) => video.id), [2, 1])
    assert.equal(listPlaylists()[0].video_count, 2)

    db.prepare('DELETE FROM library_video_memberships WHERE video_id = 1').run()
    assert.deepEqual(getPlaylistDetail(playlistId)?.videos.map((video) => video.id), [2, 1])
    assert.equal(listPlaylists()[0].video_count, 2)
    assert.equal(listPlaylists()[0].preview_cover_path, 'covers/ipx-535.jpg')
    assert.deepEqual(
      getPlaylistDetail(playlistId)?.videos.find((video) => video.id === 1)?.resource_kinds,
      []
    )
  })

  it('updates playlist metadata and custom cover', () => {
    setupDb()
    const id = createPlaylistRecord(
      { name: 'Queue', description: 'Old' },
      'playlist_covers/old.jpg'
    )

    const oldCover = updatePlaylistRecord(
      id,
      { name: '  Watch Later  ', description: '  New notes  ' },
      'playlist_covers/new.jpg'
    )

    const detail = getPlaylistDetail(id)
    assert.equal(oldCover, 'playlist_covers/old.jpg')
    assert.equal(detail?.name, 'Watch Later')
    assert.equal(detail?.description, 'New notes')
    assert.equal(detail?.cover_path, 'playlist_covers/new.jpg')

    assert.equal(updatePlaylistRecord(id, { name: 'Watch Later', removeCover: true }), 'playlist_covers/new.jpg')
    assert.equal(getPlaylistDetail(id)?.cover_path, null)
  })

  it('reports video membership and removes videos', () => {
    setupDb()
    const first = createPlaylistRecord({ name: 'First' })
    const second = createPlaylistRecord({ name: 'Second' })
    addVideoToPlaylist({ playlistId: first, videoId: 1 })

    const memberships = listPlaylistsForVideo(1)
    assert.deepEqual(
      memberships.map((item) => [item.name, item.contains_video]),
      [
        ['Second', false],
        ['First', true]
      ]
    )

    assert.equal(removeVideoFromPlaylist({ playlistId: first, videoId: 1 }), true)
    assert.equal(removeVideoFromPlaylist({ playlistId: second, videoId: 1 }), false)
    assert.equal(getPlaylistDetail(first)?.videos.length, 0)
  })

  it('allows one video in multiple playlists without duplicates in one playlist', () => {
    setupDb()
    const first = createPlaylistRecord({ name: 'First' })
    const second = createPlaylistRecord({ name: 'Second' })

    assert.equal(addVideoToPlaylist({ playlistId: first, videoId: 1 }), true)
    assert.equal(addVideoToPlaylist({ playlistId: second, videoId: 1 }), true)
    assert.equal(addVideoToPlaylist({ playlistId: second, videoId: 1 }), false)

    const memberships = listPlaylistsForVideo(1)
    assert.deepEqual(
      memberships.map((item) => [item.name, item.contains_video, item.video_count]),
      [
        ['Second', true, 1],
        ['First', true, 1]
      ]
    )
  })

  it('rejects blank playlist names', () => {
    setupDb()
    assert.throws(() => createPlaylistRecord({ name: '   ' }), /清单名称不能为空/)
  })

  it('stores related links on create and update', () => {
    setupDb()
    const id = createPlaylistRecord({
      name: 'Queue',
      links: [
        { label: '', url: 'https://example.com/list' },
        { label: 'Dup', url: 'https://example.com/list#x' },
        { label: 'Forum', url: 'https://forum.example/thread' }
      ]
    })

    assert.deepEqual(
      getPlaylistDetail(id)?.links.map((link) => [link.label, link.url, link.position]),
      [
        ['example.com', 'https://example.com/list', 0],
        ['Forum', 'https://forum.example/thread', 1]
      ]
    )

    updatePlaylistRecord(id, {
      name: 'Queue',
      links: [{ label: 'Wiki', url: 'https://example.com/wiki' }]
    })
    assert.deepEqual(getPlaylistDetail(id)?.links.map((link) => link.label), ['Wiki'])

    updatePlaylistRecord(id, { name: 'Renamed' })
    assert.deepEqual(getPlaylistDetail(id)?.links.map((link) => link.label), ['Wiki'])
  })
})
