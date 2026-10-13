import assert from 'node:assert/strict'
import { it } from 'node:test'
import Database from 'better-sqlite3'
import { releasedV19Database } from '../testFixtures/releasedV19Database'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'

it('advances the released 0.8.0 database schema exactly once', () => {
  assert.equal(CURRENT_SCHEMA_VERSION, 20)
  const db = releasedV19Database()
  try {
    migrateDatabase(db)
    assert.equal(db.pragma('user_version', { simple: true }), 20)
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  } finally { db.close() }
})

it('upgrades released scores and custom playlists together without adopting same-name custom lists', () => {
  const db = releasedV19Database()
  try {
    db.exec(`INSERT INTO videos (id,code) VALUES (1,'KEEP-1'), (2,'KEEP-2');
      INSERT INTO video_external_stats (video_id,source,rating_average,fetched_at) VALUES
      (1,'Older',4,'2024-01-01'),(1,'B',4,'2025-01-01'),(1,'A',3,'2025-01-01'),
      (1,'Empty',NULL,'2026-01-01'),(2,'Empty',NULL,NULL);
      INSERT INTO playlists (id,name,created_at) VALUES (31,'我喜欢','2026-01-01'),(32,'稍后观看','2026-01-02');
      INSERT INTO playlist_video (playlist_id,video_id,position) VALUES (31,1,7);`)
    const scores = db.prepare('SELECT id,video_id,source,rating_average,fetched_at FROM video_external_stats ORDER BY id').all()
    const playlists = db.prepare('SELECT id,name,created_at FROM playlists ORDER BY id').all()
    const membership = db.prepare('SELECT * FROM playlist_video').all()
    migrateDatabase(db)
    assert.deepEqual(db.prepare('SELECT id,video_id,source,rating_average,fetched_at FROM video_external_stats ORDER BY id').all(), scores)
    assert.deepEqual(db.prepare('SELECT source FROM video_external_stats WHERE is_default=1').all(), [{ source: 'A' }])
    assert.deepEqual(db.prepare('SELECT id,name,created_at FROM playlists WHERE system_kind IS NULL ORDER BY id').all(), playlists)
    assert.deepEqual(db.prepare('SELECT * FROM playlist_video').all(), membership)
    assert.deepEqual(db.prepare('SELECT system_kind,remove_after_play FROM playlists WHERE system_kind IS NOT NULL ORDER BY system_kind').all(), [
      { system_kind: 'favorites', remove_after_play: 0 }, { system_kind: 'watch_later', remove_after_play: 0 }
    ])
    db.exec("UPDATE video_external_stats SET is_default=CASE WHEN source='Older' THEN 1 ELSE 0 END")
    const before = db.serialize()
    migrateDatabase(db)
    assert.deepEqual(db.serialize(), before, 'current-schema opens must not rewrite scores or recreate built-ins')
  } finally { db.close() }
})

for (const stage of ['rating-column', 'rating-backfill', 'playlists'] as const) {
  it(`rolls back the whole single upgrade when ${stage} fails and permits retry`, t => {
    const db = releasedV19Database()
    try {
      db.exec("INSERT INTO videos (id,code) VALUES (1,'ROLLBACK'); INSERT INTO video_external_stats (video_id,source,rating_average) VALUES (1,'Site',4)")
      const before = db.serialize()
      const exec = db.exec, prepare = db.prepare
      const execFault = t.mock.method(db, 'exec', (sql: string) => {
        const result = exec.call(db, sql)
        if ((stage === 'rating-column' && sql.includes('ADD COLUMN is_default'))
          || (stage === 'playlists' && sql.includes('ADD COLUMN system_kind'))) throw new Error(`failed ${stage}`)
        return result
      })
      const prepareFault = t.mock.method(db, 'prepare', (sql: string) => {
        if (stage === 'rating-backfill' && sql.startsWith('UPDATE video_external_stats SET is_default')) throw new Error(`failed ${stage}`)
        return prepare.call(db, sql)
      })
      assert.throws(() => migrateDatabase(db), new RegExp(`failed ${stage}`))
      assert.deepEqual(db.serialize(), before)
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
      execFault.mock.restore(); prepareFault.mock.restore()
      migrateDatabase(db)
      assert.equal(db.pragma('user_version', { simple: true }), 20)
    } finally { t.mock.restoreAll(); db.close() }
  })
}

it('rejects partial development schema 20 and higher development versions without changing them', () => {
  for (const version of [20, 21, 22]) {
    const db = releasedV19Database()
    try {
      db.exec('ALTER TABLE video_external_stats ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1))')
      db.pragma(`user_version = ${version}`)
      const before = db.serialize()
      assert.throws(() => migrateDatabase(db), /unreleased|no longer supported/)
      assert.deepEqual(db.serialize(), before)
    } finally { db.close() }
  }
})

it('fresh and upgraded catalogs expose identical tables, columns and indexes', () => {
  const upgraded = releasedV19Database(), fresh = new Database(':memory:')
  const structure = (db: Database.Database) => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[])
    return tables.map(({ name }) => ({ name,
      columns: (db.pragma(`table_info(${name})`) as Array<{ cid: number; name: string }>).map(({ cid: _cid, ...column }) => column).sort((a, b) => a.name.localeCompare(b.name)),
      indexes: (db.pragma(`index_list(${name})`) as Array<{ seq: number; name: string }>).map(({ seq: _seq, ...index }) => index).sort((a, b) => a.name.localeCompare(b.name)),
      foreignKeys: db.pragma(`foreign_key_list(${name})`)
    }))
  }
  try {
    migrateDatabase(upgraded); migrateDatabase(fresh)
    assert.deepEqual(structure(upgraded), structure(fresh))
    for (const db of [upgraded, fresh]) {
      assert.throws(() => db.exec("UPDATE playlists SET system_kind='custom'"), /CHECK/)
      assert.throws(() => db.exec('UPDATE playlists SET remove_after_play=2'), /CHECK/)
      assert.throws(() => db.exec("INSERT INTO playlists (name,system_kind) VALUES ('duplicate','favorites')"), /UNIQUE/)
      db.exec("INSERT INTO videos (id,code) VALUES (1,'CONSTRAINT')")
      assert.throws(() => db.exec("INSERT INTO video_external_stats (video_id,source,is_default) VALUES (1,'invalid',2)"), /CHECK/)
    }
    assert.deepEqual(fresh.pragma('foreign_key_check'), [])
  } finally { upgraded.close(); fresh.close() }
})
