import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { SqliteNfoExportRepository } from './nfoExportRepository'

let tempRoot: string | null = null

afterEach(() => {
  closeDatabase()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('SqliteNfoExportRepository', () => {
  it('projects exportable metadata while excluding personal rating and watch state', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-nfo-export-repo-'))
    const db = initDatabaseAtPath(path.join(tempRoot, 'library.db'))
    const anchor = path.join(tempRoot, 'ABC-001.mp4')
    fs.writeFileSync(anchor, 'video')
    db.prepare(`INSERT INTO media_library_roots
      (id, library_id, path, normalized_path, real_path, normalized_real_path, state)
      VALUES (1, 1, ?, ?, ?, ?, 'active')`).run(tempRoot, tempRoot, tempRoot, tempRoot)
    db.prepare(`INSERT INTO videos
      (id, code, title, summary, cover_path, poster_path, rating, release_date, duration_seconds, updated_at)
      VALUES (1, 'ABC-001', 'Title', 'Summary', 'covers/a.jpg', 'samples/bg.jpg', 5,
        '2025-03-04', 3600, '2026-09-05')`).run()
    db.prepare(`INSERT INTO library_video_memberships
      (library_id, video_id, added_via, discovery_key) VALUES (1, 1, 'scan', 1)`).run()
    db.prepare(`INSERT INTO video_resources
      (id, library_id, video_id, root_id, kind, locator, resource_key, source_identity, size_bytes, file_mtime_ms)
      VALUES (1, 1, 1, 1, 'local', ?, 'key', 'source', 5, 10)`).run(anchor)
    db.prepare(`INSERT INTO tags (id, name) VALUES (1, 'Drama')`).run()
    db.prepare(`INSERT INTO video_tag (video_id, tag_id, origin) VALUES (1, 1, 'manual')`).run()
    db.prepare(`INSERT INTO actresses (id, main_name, avatar_path, gender, revision)
      VALUES (1, 'Alice', 'avatars/a.jpg', 'female', 3)`).run()
    db.prepare(`INSERT INTO video_actress (video_id, actress_id) VALUES (1, 1)`).run()
    db.prepare(`INSERT INTO video_external_stats
      (video_id, source, rating_average, rating_count) VALUES (1, 'javdb', 4.2, 12)`).run()
    db.prepare(`INSERT INTO video_sources
      (video_id, source, external_code, url) VALUES (1, 'javdb', 'site-1', 'https://example.test')`).run()
    db.prepare(`INSERT INTO video_assets
      (video_id, type, position, local_path) VALUES (1, 'sample', 0, 'samples/one.jpg')`).run()

    const root: MediaLibraryRoot = {
      id: 1, libraryId: 1, path: tempRoot, normalizedPath: tempRoot,
      realPath: tempRoot, normalizedRealPath: tempRoot, deviceId: null, inode: null,
      position: 0, state: 'active', createdAt: '', updatedAt: ''
    }
    const repository = new SqliteNfoExportRepository(getDb, () => root)
    const [snapshot] = repository.listResourceSnapshots([1])
    assert.equal(snapshot.anchorPath, anchor)
    assert.equal(snapshot.title, 'Title')
    assert.deepEqual(snapshot.tags, ['Drama'])
    assert.deepEqual(snapshot.actors, [{
      name: 'Alice', gender: 'female', avatarPath: 'avatars/a.jpg', actressRevision: 3
    }])
    assert.deepEqual(snapshot.ratings, [{ source: 'javdb', average: 4.2, count: 12 }])
    assert.deepEqual(snapshot.identities, [{ source: 'javdb', code: 'site-1' }])
    assert.deepEqual(snapshot.samples, ['samples/one.jpg'])
    assert.equal('rating' in snapshot, false)
    assert.equal('url' in snapshot, false)
  })
})
