import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { insertTestVideoWithFile } from './testVideoFixtures'
import {
  addVideoToPlaylist,
  createPlaylistRecord,
  getPlaylistDetail,
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
})
