import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { addMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
import { WebCatalog } from './catalog'
import { mediaAssetStore } from '@library/mediaAssetStore'
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
  for (const change of ['hidden', 'archived', 'cover', 'cast', 'sample'] as const) {
    it(`rechecks image authorization after async work when ${change} changes`, async (t) => {
      const { videoId } = insertTestVideoWithFile(db, { code: 'ASYNC', filePath: '/video/async.mp4' })
      db.prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run('covers/old.png', videoId)
      const actressId = Number(db.prepare("INSERT INTO actresses (main_name, avatar_path) VALUES ('Async', 'avatars/old.png')").run().lastInsertRowid)
      db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(videoId, actressId)
      const assetId = Number(db.prepare("INSERT INTO video_assets (video_id, type, local_path) VALUES (?, 'sample', 'samples/old.png')").run(videoId).lastInsertRowid)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      t.mock.method(mediaAssetStore, 'readForServeAsync', async () => {
        await gate
        return { body: Buffer.from('old image'), mime: 'image/png' }
      })
      const key = change === 'cast' ? `actress-${actressId}` : change === 'sample' ? String(assetId) : 'cover'
      const result = catalog.image(videoId, key)
      const rejected = assert.rejects(result, /图片/)
      if (change === 'hidden') db.prepare('UPDATE library_video_memberships SET is_hidden = 1 WHERE video_id = ?').run(videoId)
      else if (change === 'archived') db.prepare("UPDATE media_libraries SET status = 'archived'").run()
      else if (change === 'cover') db.prepare("UPDATE videos SET cover_path = 'covers/new.png' WHERE id = ?").run(videoId)
      else if (change === 'cast') db.prepare('DELETE FROM video_actress WHERE video_id = ?').run(videoId)
      else db.prepare('DELETE FROM video_assets WHERE id = ?').run(assetId)
      release()
      await rejected
    })
  }

  it('reads only the authorized image path before and after serving, without full details', async (t) => {
    const { videoId } = insertTestVideoWithFile(db, { code: 'SLIM', filePath: '/video/slim.mp4', summary: 'large'.repeat(20000) })
    db.prepare("UPDATE videos SET cover_path = 'covers/slim.png' WHERE id = ?").run(videoId)
    const sql: string[] = []
    const prepare = db.prepare.bind(db)
    t.mock.method(db, 'prepare', (query: string) => { sql.push(query); return prepare(query) })
    t.mock.method(mediaAssetStore, 'readForServeAsync', async () => ({ body: Buffer.from('image'), mime: 'image/png' }))
    assert.equal((await catalog.image(videoId, 'cover')).body.toString(), 'image')
    assert.equal(sql.length, 2)
    assert.ok(sql.every((query) => query.startsWith('SELECT v.cover_path AS path')))
    assert.ok(sql.every((query) => !query.includes('v.*')))
  })

  it('forwards thumbnail size through the real catalog while preserving original requests', async (t) => {
    const { videoId } = insertTestVideoWithFile(db, { code: 'THUMB', filePath: '/video/thumb.mp4' })
    db.prepare("UPDATE videos SET cover_path = 'covers/thumb.png' WHERE id = ?").run(videoId)
    const read = t.mock.method(mediaAssetStore, 'readForServeAsync', async () => ({ body: Buffer.from('image'), mime: 'image/webp' }))
    const abort = new AbortController()
    await catalog.image(videoId, 'cover', abort.signal, 640)
    assert.deepEqual(read.mock.calls[0].arguments, ['covers/thumb.png', abort.signal, 640])
    await catalog.image(videoId, 'cover')
    assert.deepEqual(read.mock.calls[1].arguments, ['covers/thumb.png', undefined, undefined])
  })

  it('forwards the caller signal to the async Store and drops a cancelled result', async (t) => {
    const { videoId } = insertTestVideoWithFile(db, { code: 'CANCEL', filePath: '/video/cancel.mp4' })
    db.prepare("UPDATE videos SET cover_path = 'covers/cancel.png' WHERE id = ?").run(videoId)
    const abort = new AbortController()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    t.mock.method(mediaAssetStore, 'readForServeAsync', async (rel: string, signal?: AbortSignal) => {
      assert.equal(rel, 'covers/cancel.png')
      assert.equal(signal, abort.signal)
      await gate
      return { body: Buffer.from('image'), mime: 'image/png' }
    })
    const operation = catalog.image(videoId, 'cover', abort.signal)
    const rejected = assert.rejects(operation, { name: 'AbortError' })
    abort.abort()
    release()
    await rejected
  })
  it('filters archived/hidden memberships for lists, details, images, and media', async () => {
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
      await assert.rejects(() => catalog.image(video.videoId, 'cover'))
      assert.throws(() => catalog.media(video.videoId, video.fileId))
    }
    assert.equal(catalog.collections().libraries.length, 1)
    assert.equal(catalog.collections().libraries[0].count, 1)
    const detail = catalog.detail(visible.videoId)
    assert.equal(detail.resources[0].libraryId, 1)
    assert.doesNotMatch(
      JSON.stringify(detail),
      /private|locator|root_id|source_identity|cover_path/
    )
    assert.equal(detail.resources[0].playable, false)
    assert.throws(() => catalog.media(visible.videoId, visible.fileId))
  })
  it('describes local resources without exposing their directory', async () => {
    const { videoId, fileId } = insertTestVideoWithFile(db, {
      code: 'RESOURCE', filePath: '/private/library/sample-CD1.mp4'
    })
    db.prepare('UPDATE video_resources SET size_bytes = ?, duration_seconds = ? WHERE id = ?')
      .run(3 * 1024 ** 3, 3600, fileId)
    const resource = catalog.detail(videoId).resources[0]
    assert.equal(resource.name, 'sample-CD1.mp4')
    assert.equal(resource.format, 'MP4')
    assert.equal(resource.sizeBytes, 3 * 1024 ** 3)
    assert.equal(resource.durationSeconds, 3600)
    assert.doesNotMatch(JSON.stringify(resource), /private|locator/)
    db.prepare('UPDATE video_resources SET display_name = ? WHERE id = ?').run('自定义版本', fileId)
    assert.equal(catalog.detail(videoId).resources[0].name, '自定义版本')
  })
  it('uses the cover rather than the background for browse, detail and image requests', async (t) => {
    const { videoId } = insertTestVideoWithFile(db, {
      code: 'ARTWORK',
      filePath: '/video/artwork.mp4'
    })
    db.prepare('UPDATE videos SET cover_path = ?, poster_path = ? WHERE id = ?')
      .run('covers/front.png', 'posters/background.png', videoId)
    const image = { body: Buffer.from('cover'), mime: 'image/png' }
    const read = t.mock.method(mediaAssetStore, 'readForServeAsync', async (rel: string) => {
      assert.equal(rel, 'covers/front.png')
      return image
    })
    const coverUrl = `/api/videos/${videoId}/images/cover`
    assert.equal(catalog.browse(new URLSearchParams()).items[0].cover, coverUrl)
    assert.equal(catalog.detail(videoId).cover, coverUrl)
    assert.deepEqual(await catalog.image(videoId, 'cover'), image)
    assert.equal(read.mock.callCount(), 1)

    db.prepare('UPDATE videos SET cover_path = NULL WHERE id = ?').run(videoId)
    assert.equal(catalog.browse(new URLSearchParams()).items[0].cover, null)
    assert.equal(catalog.detail(videoId).cover, null)
    await assert.rejects(() => catalog.image(videoId, 'cover'), /图片不存在/)
    assert.equal(read.mock.callCount(), 1)
  })
  it('queries with parameters, paginates stably and filters clear membership scopes', async () => {
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
  it('uses stable desktop discovery and respects library home participation', async () => {
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
  it('exposes cast display metadata and only serves avatars linked to visible videos', async (t) => {
    const { videoId } = insertTestVideoWithFile(db, { code: 'CAST', filePath: '/private/cast.mp4' })
    const insert = db.prepare('INSERT INTO actresses (main_name, gender, avatar_path) VALUES (?, ?, ?)')
    const actorId = Number(insert.run('Sample actor', 'male', 'avatars/sample.png').lastInsertRowid)
    const otherId = Number(insert.run('Other actor', null, 'avatars/other.png').lastInsertRowid)
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(videoId, actorId)
    const cast = catalog.detail(videoId).actresses
    assert.deepEqual(cast.map(({ id, name, gender, avatar }) => ({ id, name, gender, avatar })), [{
      id: actorId, name: 'Sample actor', gender: 'male', avatar: `/api/videos/${videoId}/images/actress-${actorId}`
    }])
    const read = t.mock.method(mediaAssetStore, 'readForServeAsync', async (rel: string) => {
      assert.equal(rel, 'avatars/sample.png')
      return { body: Buffer.from('avatar'), mime: 'image/png' }
    })
    assert.equal((await catalog.image(videoId, `actress-${actorId}`)).body.toString(), 'avatar')
    await assert.rejects(() => catalog.image(videoId, `actress-${otherId}`))
    db.prepare('UPDATE library_video_memberships SET is_hidden = 1 WHERE video_id = ?').run(videoId)
    await assert.rejects(() => catalog.image(videoId, `actress-${actorId}`))
    assert.equal(read.mock.callCount(), 1)
  })
  it('downloads non-playable files and exposes only supported external links', async () => {
    const root = addMediaLibraryRoot({ libraryId: 1, expectedRevision: 1, root: { path: directory } })
    const file = path.join(directory, 'sample.avi')
    fs.writeFileSync(file, 'download bytes')
    const record = insertTestVideoWithFile(db, { code: 'DOWNLOAD', filePath: file, rootId: root.id })
    const resource = catalog.detail(record.videoId).resources[0]
    assert.equal(resource.playable, false)
    assert.equal(resource.downloadUrl, `/api/videos/${record.videoId}/media/${record.fileId}?download=1`)
    assert.throws(() => catalog.media(record.videoId, record.fileId))
    const download = catalog.media(record.videoId, record.fileId, true)
    assert.ok('file' in download)
    assert.equal(download.mime, 'application/octet-stream')
    const original = db.prepare('SELECT source_identity FROM video_resources WHERE id = ?').get(record.fileId) as { source_identity: string }
    for (const [kind, locator, expected] of [
      ['web', 'https://example.com/watch?id=1', 'https://example.com/watch?id=1'],
      ['magnet', 'magnet:?xt=urn:btih:abcdef', 'magnet:?xt=urn:btih:abcdef'],
      ['web', 'javascript:alert(1)', null],
      ['direct', 'https://user:password@example.com/video', null]
    ]) {
      db.prepare('UPDATE video_resources SET kind = ?, locator = ?, source_identity = NULL, root_id = NULL WHERE id = ?').run(kind, locator, record.fileId)
      assert.equal(catalog.detail(record.videoId).resources[0].link, expected)
      assert.equal(catalog.detail(record.videoId).resources[0].downloadUrl, null)
    }
    db.prepare("UPDATE video_resources SET kind = 'local', locator = ?, source_identity = ?, root_id = ? WHERE id = ?").run(file, original.source_identity, root.id, record.fileId)
    db.prepare('UPDATE library_video_memberships SET is_hidden = 1 WHERE video_id = ?').run(record.videoId)
    assert.throws(() => catalog.media(record.videoId, record.fileId, true))
  })
  it('resolves only authorized files and refuses symlink escapes and disabled roots', async () => {
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
    // Match the guard's native canonical path (Windows expands 8.3 temp-directory names).
    assert.equal(resource.file, fs.realpathSync.native(movie))
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
    assert.throws(() => catalog.media(record.videoId, record.fileId, true))
  })
})
