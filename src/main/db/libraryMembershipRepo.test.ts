import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateDatabase } from './migrations'
import {
  discoveryKeyForMembership,
  ensureVideoMembership,
  hasActiveVisibleVideoMembership,
  hasVideoMembership,
  removeVideoMembership
} from './libraryMembershipRepo'

describe('library membership repo', () => {
  it('creates an idempotent explicit membership with a stable discovery key', () => {
    const database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    try {
      migrateDatabase(database)
      database.prepare("INSERT INTO videos (id, code) VALUES (11, 'MEM-011')").run()
      assert.equal(
        ensureVideoMembership(
          { libraryId: 1, videoId: 11, addedVia: 'scan', addedAt: '2026-01-02T00:00:00Z' },
          database
        ),
        true
      )
      assert.equal(
        ensureVideoMembership(
          { libraryId: 1, videoId: 11, addedVia: 'manual', addedAt: '2026-02-03T00:00:00Z' },
          database
        ),
        false
      )
      assert.deepEqual(
        database
          .prepare(
            `SELECT added_at, added_via, discovery_key
             FROM library_video_memberships WHERE library_id = 1 AND video_id = 11`
          )
          .get(),
        {
          added_at: '2026-01-02T00:00:00Z',
          added_via: 'scan',
          discovery_key: discoveryKeyForMembership(1, 11)
        }
      )
    } finally {
      database.close()
    }
  })

  it('removes only the selected library membership', () => {
    const database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    try {
      migrateDatabase(database)
      database.exec(`
        INSERT INTO media_libraries (id, name) VALUES (2, 'B');
        INSERT INTO media_library_configs (library_id) VALUES (2);
        INSERT INTO videos (id, code) VALUES (12, 'MEM-012');
      `)
      ensureVideoMembership({ libraryId: 1, videoId: 12, addedVia: 'scan' }, database)
      ensureVideoMembership({ libraryId: 2, videoId: 12, addedVia: 'shared' }, database)
      assert.equal(removeVideoMembership(1, 12, database), true)
      assert.equal(hasVideoMembership(1, 12, database), false)
      assert.equal(hasVideoMembership(2, 12, database), true)
      assert.equal(
        (database.prepare('SELECT COUNT(*) AS count FROM videos WHERE id = 12').get() as {
          count: number
        }).count,
        1
      )
    } finally {
      database.close()
    }
  })

  it('rejects archived or missing libraries', () => {
    const database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    try {
      migrateDatabase(database)
      database.prepare("INSERT INTO videos (id, code) VALUES (13, 'MEM-013')").run()
      database.prepare("UPDATE media_libraries SET status = 'archived' WHERE id = 1").run()
      assert.throws(
        () => ensureVideoMembership({ libraryId: 1, videoId: 13, addedVia: 'manual' }, database),
        /不存在/
      )
    } finally {
      database.close()
    }
  })

  it('recognizes only visible memberships in an active library surface', () => {
    const database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    try {
      migrateDatabase(database)
      database.prepare("INSERT INTO videos (id, code) VALUES (14, 'MEM-014')").run()
      ensureVideoMembership({ libraryId: 1, videoId: 14, addedVia: 'manual' }, database)

      assert.equal(hasActiveVisibleVideoMembership(1, 14, database), true)
      database
        .prepare(
          'UPDATE library_video_memberships SET is_hidden = 1 WHERE library_id = 1 AND video_id = 14'
        )
        .run()
      assert.equal(hasActiveVisibleVideoMembership(1, 14, database), false)
      database
        .prepare(
          'UPDATE library_video_memberships SET is_hidden = 0 WHERE library_id = 1 AND video_id = 14'
        )
        .run()
      database.prepare("UPDATE media_libraries SET status = 'archived' WHERE id = 1").run()
      assert.equal(hasActiveVisibleVideoMembership(1, 14, database), false)
    } finally {
      database.close()
    }
  })
})
