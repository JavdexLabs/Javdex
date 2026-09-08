import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, initDatabaseAtPath } from '../db/database'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import { addMediaLibraryRoot } from '../db/mediaLibraryRepo'
import { WebCatalog } from './catalog'
import { mediaAssetStore } from '../services/mediaAssetStore'
import type Database from 'better-sqlite3'

describe('Web read-only catalog scope', () => {
  let directory: string
  let db: Database.Database
  let catalog: WebCatalog
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-web-catalog-'))
    process.env.JAVDEX_TEST_USER_DATA = directory
    db = initDatabaseAtPath(path.join(directory, 'test.db'))
    catalog = new WebCatalog(db)
  })
  afterEach(() => {
    closeDatabase()
    delete process.env.JAVDEX_TEST_USER_DATA
    fs.rmSync(directory, { recursive: true, force: true })
  })
  it('filters archived/hidden memberships for lists, details, images, and media', () => {
    const visible = insertTestVideoWithFile(db, {
      code: 'VISIBLE',
      filePath: '/private/movie.mp4',
      title: 'Visible'
    })
    const hidden = insertTestVideoWithFile(db, {
      code: 'HIDDEN',
      filePath: '/private/hidden.mp4'
    })
    db.prepare(
      'UPDATE library_video_memberships SET is_hidden = 1 WHERE video_id = ?'
    ).run(hidden.videoId)
    db.prepare(
      "INSERT INTO media_libraries(id, name, status) VALUES (2, 'Archived', 'active')"
    ).run()
    const archived = insertTestVideoWithFile(db, {
      code: 'ARCHIVED',
      filePath: '/private/archive.mp4',
      libraryId: 2
    })
    db.prepare(
      "UPDATE media_libraries SET status = 'archived' WHERE id = 2"
    ).run()
    const result = catalog.browse(new URLSearchParams())
    assert.equal(result.total, 1)
    assert.equal(result.items[0].id, visible.videoId)
    for (const video of [hidden, archived]) {
      assert.throws(() => catalog.detail(video.videoId))
      assert.throws(() => catalog.image(video.videoId, 'cover'))
      assert.throws(() => catalog.media(video.videoId, video.fileId))
    }
    assert.equal(catalog.collections().libraries.length, 1)
    assert.equal(catalog.collections().libraries[0].count, 1)
    const detail = catalog.detail(visible.videoId)
    assert.doesNotMatch(
      JSON.stringify(detail),
      /private|locator|root_id|source_identity|cover_path/
    )
    assert.equal(detail.resources[0].playable, false)
    assert.throws(() => catalog.media(visible.videoId, visible.fileId))
  })
  it('uses the cover rather than the background for browse, detail and image requests', (t) => {
    const { videoId } = insertTestVideoWithFile(db, {
      code: 'ARTWORK',
      filePath: '/video/artwork.mp4'
    })
    db.prepare('UPDATE videos SET cover_path = ?, poster_path = ? WHERE id = ?')
      .run('covers/front.png', 'posters/background.png', videoId)
    const image = { body: Buffer.from('cover'), mime: 'image/png' }
    const read = t.mock.method(mediaAssetStore, 'readForServe', (rel: string) => {
      assert.equal(rel, 'covers/front.png')
      return image
    })
    const coverUrl = `/api/videos/${videoId}/images/cover`
    assert.equal(catalog.browse(new URLSearchParams()).items[0].cover, coverUrl)
    assert.equal(catalog.detail(videoId).cover, coverUrl)
    assert.deepEqual(catalog.image(videoId, 'cover'), image)
    assert.equal(read.mock.callCount(), 1)

    db.prepare('UPDATE videos SET cover_path = NULL WHERE id = ?').run(videoId)
    assert.equal(catalog.browse(new URLSearchParams()).items[0].cover, null)
    assert.equal(catalog.detail(videoId).cover, null)
    assert.throws(() => catalog.image(videoId, 'cover'), /图片不存在/)
    assert.equal(read.mock.callCount(), 1)
  })
  it('queries with parameters, paginates stably and filters clear membership scopes', () => {
    for (let index = 0; index < 40; index++)
      insertTestVideoWithFile(db, {
        code: `CODE-${index}`,
        filePath: `/video/${index}.mp4`,
        title: index === 0 ? '100% story' : 'Story',
        releaseDate: '2026-01-01'
      })
    const first = catalog.browse(new URLSearchParams())
    const second = catalog.browse(new URLSearchParams('page=2'))
    assert.equal(first.items.length, 36)
    assert.equal(second.items.length, 4)
    assert.equal(
      new Set([...first.items, ...second.items].map((v) => v.id)).size,
      40
    )
    assert.equal(catalog.browse(new URLSearchParams({ q: '%' })).total, 1)
    assert.equal(
      catalog.browse(new URLSearchParams({ q: "' OR 1=1 --" })).total,
      0
    )
    assert.equal(catalog.browse(new URLSearchParams('library=999')).total, 0)
    assert.equal(catalog.browse(new URLSearchParams('year=2025')).total, 0)
    assert.throws(() => catalog.browse(new URLSearchParams('sort=constructor')))
    assert.throws(() => catalog.browse(new URLSearchParams('page=-1')))
  })
  it('uses stable desktop discovery and respects library home participation', () => {
    const root = addMediaLibraryRoot({ libraryId: 1, expectedRevision: 1, root: { path: directory } })
    for (let index = 0; index < 20; index++) {
      insertTestVideoWithFile(db, { code: `HOME-${index}`, filePath: path.join(directory, `${index}.mp4`), rootId: root.id })
    }
    const first = catalog.home('stable-seed')
    assert.equal(first.discovery.length, 12)
    assert.equal(first.recent.length, 12)
    assert.deepEqual(catalog.home('stable-seed'), first)
    assert.equal(new Set(first.discovery.map(video => video.id)).size, 12)
    assert.doesNotMatch(JSON.stringify(first), /private|locator|cover_path/)
    db.prepare('UPDATE media_library_configs SET include_in_home_discovery = 0').run()
    assert.deepEqual(catalog.home('stable-seed'), { discovery: [], recent: [] })
    assert.throws(() => catalog.home('x'.repeat(101)))
  })
  it('exposes cast display metadata and only serves avatars linked to visible videos', (t) => {
    const { videoId } = insertTestVideoWithFile(db, { code: 'CAST', filePath: '/private/cast.mp4' })
    const insert = db.prepare('INSERT INTO actresses (main_name, gender, avatar_path) VALUES (?, ?, ?)')
    const actorId = Number(insert.run('Sample actor', 'male', 'avatars/sample.png').lastInsertRowid)
    const otherId = Number(insert.run('Other actor', null, 'avatars/other.png').lastInsertRowid)
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(videoId, actorId)
    const cast = catalog.detail(videoId).actresses
    assert.deepEqual(cast.map(({ id, name, gender, avatar }) => ({ id, name, gender, avatar })), [{
      id: actorId, name: 'Sample actor', gender: 'male', avatar: `/api/videos/${videoId}/images/actress-${actorId}`
    }])
    const read = t.mock.method(mediaAssetStore, 'readForServe', (rel: string) => {
      assert.equal(rel, 'avatars/sample.png')
      return { body: Buffer.from('avatar'), mime: 'image/png' }
    })
    assert.equal(catalog.image(videoId, `actress-${actorId}`).body.toString(), 'avatar')
    assert.throws(() => catalog.image(videoId, `actress-${otherId}`))
    db.prepare('UPDATE library_video_memberships SET is_hidden = 1 WHERE video_id = ?').run(videoId)
    assert.throws(() => catalog.image(videoId, `actress-${actorId}`))
    assert.equal(read.mock.callCount(), 1)
  })
  it('resolves only authorized files and refuses symlink escapes and disabled roots', () => {
    const mediaRoot = path.join(directory, 'media')
    fs.mkdirSync(mediaRoot)
    const root = addMediaLibraryRoot({
      libraryId: 1,
      expectedRevision: 1,
      root: { path: mediaRoot }
    })
    const movie = path.join(mediaRoot, 'safe.mp4')
    fs.writeFileSync(movie, 'movie')
    const record = insertTestVideoWithFile(db, {
      code: 'SAFE',
      filePath: movie,
      rootId: root.id
    })
    const resource = catalog.media(record.videoId, record.fileId)
    assert.ok('file' in resource)
    assert.equal(resource.file, fs.realpathSync(movie))
    const outside = path.join(directory, 'private.mp4')
    fs.writeFileSync(outside, 'private')
    fs.unlinkSync(movie)
    try {
      fs.symlinkSync(outside, movie)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      // Windows without symlink privilege still exercises disabled-root authorization below.
      fs.writeFileSync(movie, 'movie')
    }
    if (fs.lstatSync(movie).isSymbolicLink())
      assert.throws(() => catalog.media(record.videoId, record.fileId))
    db.prepare(
      "UPDATE media_library_roots SET state = 'disabled' WHERE id = ?"
    ).run(root.id)
    assert.throws(() => catalog.media(record.videoId, record.fileId))
  })
})
