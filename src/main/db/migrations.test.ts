import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'

function indexNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
    name: string
  }[]).map((r) => r.name)
}

describe('database migrations', () => {
  it('creates the current schema and records user_version', () => {
    const db = new Database(':memory:')
    try {
      migrateDatabase(db)
      migrateDatabase(db)

      assert.equal(db.pragma('user_version', { simple: true }), CURRENT_SCHEMA_VERSION)
      const expectedTables = [
        'videos',
        'actresses',
        'video_actress',
        'tags',
        'video_tag',
        'facet_entries',
        'video_external_ids',
        'video_external_stats',
        'video_assets',
        'playlists',
        'playlist_video',
        'actress_names',
        'actress_tags',
        'actress_tag',
        'actress_gallery_assets'
      ]
      assert.deepEqual(
        expectedTables.map(
          (name) =>
            db
              .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
              .get(name)
        ).map(Boolean),
        expectedTables.map(() => true)
      )
      assert.equal(indexNames(db).includes('idx_videos_release_date'), true)
      assert.equal(indexNames(db).includes('idx_video_tag_tag_id'), true)
      assert.equal(indexNames(db).includes('idx_videos_maker'), true)
      assert.equal(indexNames(db).includes('idx_playlist_video_video_id'), true)
      assert.equal(indexNames(db).includes('idx_videos_studio'), false)
    } finally {
      db.close()
    }
  })
})
