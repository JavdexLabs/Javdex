import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateDatabase } from './migrations'
import { ensureVideoMembership, removeResourceLessMemberships, removeResourceLessMembershipsWithAudit,
  type RemovedResourceLessMembership } from './libraryMembershipRepo'
import { createScanAuditWriter } from './scanAuditWriter'

let db: Database.Database
beforeEach(() => { db = new Database(':memory:'); db.pragma('foreign_keys = ON'); migrateDatabase(db) })
afterEach(() => db.close())
function member(id: number, libraryId = 1, title: string | null = null) {
  db.prepare('INSERT OR IGNORE INTO videos(id,code,title) VALUES(?,?,?)').run(id, `VIDEO-${id}`, title)
  ensureVideoMembership({ libraryId, videoId: id, addedVia: 'scan' }, db)
}
function remaining() {
  return db.prepare('SELECT * FROM library_video_memberships ORDER BY library_id,video_id').all()
}
function noTemp() {
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'membership_cleanup_%'").all(), [])
}

it('preserves scope, pinned, playlist and resource exclusions and leaves catalog videos untouched', () => {
  db.exec("INSERT INTO media_libraries(id,name) VALUES(2,'Other')")
  for (let id = 1; id <= 5; id++) member(id)
  member(1, 2); member(5, 2)
  db.exec(`UPDATE library_video_memberships SET is_pinned=1 WHERE library_id=1 AND video_id=2;
    INSERT INTO playlists(id,name) VALUES(1,'Keep');
    INSERT INTO playlist_video(playlist_id,video_id,position) VALUES(1,3,0);
    INSERT INTO video_resources(library_id,video_id,kind,locator,resource_key,source_identity) VALUES(1,4,'local','/local','local-four','local-four');
    INSERT INTO video_resources(library_id,video_id,kind,locator,resource_key,source_identity) VALUES(2,5,'local','/other','other-five','other-five');`)
  const events: RemovedResourceLessMembership[] = []
  assert.equal(removeResourceLessMembershipsWithAudit(1, (entry) => { events.push(entry) }, db), 2)
  assert.deepEqual(events.map((entry) => entry.videoId), [1, 5])
  assert.deepEqual(db.prepare('SELECT video_id FROM library_video_memberships WHERE library_id=1 ORDER BY video_id').all(),
    [{ video_id: 2 }, { video_id: 3 }, { video_id: 4 }])
  assert.ok(db.prepare('SELECT 1 FROM library_video_memberships WHERE library_id=2 AND video_id=1').get())
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM videos').get(), { count: 5 })
  assert.throws(() => removeResourceLessMembershipsWithAudit(0, () => {}, db))
  assert.equal(removeResourceLessMembershipsWithAudit(999, () => { throw new Error('unexpected') }, db), 0)
  noTemp()
})

it('pages a large initial snapshot with at most 256 rows, ordered IDs and no unbounded JS all', () => {
  db.transaction(() => { for (let id = 1; id <= 1030; id++) member(id) })()
  const originalPrepare = db.prepare, prepare = db.prepare.bind(db), lengths: number[] = []
  db.prepare = ((sql: string) => {
    const statement = prepare(sql), all = statement.all.bind(statement)
    statement.all = ((...args: unknown[]) => {
      assert.match(sql, /FROM temp\.membership_cleanup_.*\s+WHERE video_id>\? ORDER BY video_id LIMIT 256/)
      const rows = all(...args)
      assert.ok(rows.length <= 256)
      lengths.push(rows.length)
      return rows
    }) as typeof statement.all
    return statement
  }) as typeof db.prepare
  let expectedId = 1
  try {
    assert.equal(removeResourceLessMembershipsWithAudit(1, (entry) => {
      assert.equal(entry.videoId, expectedId++)
      assert.equal(db.inTransaction, true)
      assert.equal(db.prepare('SELECT 1 FROM library_video_memberships WHERE library_id=1 AND video_id=?').get(entry.videoId), undefined)
    }, db), 1030)
  } finally { db.prepare = originalPrepare }
  assert.deepEqual(lengths, [256, 256, 256, 256, 6, 0])
  noTemp()
})

it('freezes initial candidate metadata, skips newly protected or ignored deletions, and excludes later candidates', () => {
  member(1); member(2); member(3); member(4)
  db.exec(`CREATE TRIGGER ignore_cleanup_test BEFORE DELETE ON library_video_memberships
    WHEN OLD.video_id=4 BEGIN SELECT RAISE(IGNORE); END`)
  const events: RemovedResourceLessMembership[] = []
  assert.equal(removeResourceLessMembershipsWithAudit(1, (entry) => {
    events.push(entry)
    if (entry.videoId === 1) {
      member(5)
      db.prepare('UPDATE library_video_memberships SET is_pinned=1 WHERE video_id=2').run()
      db.prepare("UPDATE videos SET code='CHANGED',title='changed' WHERE id=3").run()
    }
  }, db), 2)
  assert.deepEqual(events, [{ videoId: 1, videoCode: 'VIDEO-1', videoTitle: null },
    { videoId: 3, videoCode: 'VIDEO-3', videoTitle: null }])
  assert.deepEqual(db.prepare('SELECT video_id FROM library_video_memberships ORDER BY video_id').all(),
    [{ video_id: 2 }, { video_id: 4 }, { video_id: 5 }])
  noTemp()
})

it('rolls back native audit failure and outer business changes with nested writer savepoints, then retries', () => {
  member(1); member(2); member(3)
  db.exec("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at) VALUES('cleanup',1,1,'manual','running','start')")
  const writer = createScanAuditWriter(db, { libraryId: 1, runId: 'cleanup' })
  writer.start({ schemaVersion: 2, libraryId: 1, runId: 'cleanup', configRevision: 1,
    trigger: 'manual', status: 'success', startedAt: 'start', finishedAt: 'finish' })
  const before = remaining(), oldName = db.prepare('SELECT name FROM media_libraries WHERE id=1').get()
  db.exec(`CREATE TRIGGER fail_cleanup_audit AFTER INSERT ON library_scan_audit_entries
    WHEN NEW.section='deletedVideos' AND NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'native audit fault'); END`)
  const visit = (entry: RemovedResourceLessMembership) => {
    writer.writeBatch('deletedVideos', [{ ...entry, reason: 'resource_less' }])
  }
  assert.throws(() => db.transaction(() => {
    db.prepare("UPDATE media_libraries SET name='business' WHERE id=1").run()
    removeResourceLessMembershipsWithAudit(1, visit, db)
  })(), /native audit fault/)
  assert.deepEqual(remaining(), before)
  assert.deepEqual(db.prepare('SELECT name FROM media_libraries WHERE id=1').get(), oldName)
  assert.equal(db.prepare('SELECT 1 FROM library_scan_audit_entries').get(), undefined)
  noTemp()
  db.exec('DROP TRIGGER fail_cleanup_audit')
  assert.equal(removeResourceLessMembershipsWithAudit(1, visit, db), 3)
  assert.deepEqual(db.prepare('SELECT COUNT(*) AS count FROM library_scan_audit_entries').get(), { count: 3 })
  noTemp()
})

it('preserves untruncated long metadata through both callback and legacy array wrapper', () => {
  const title = '很长标题'.repeat(300_000)
  member(1, 1, title)
  let delivered: RemovedResourceLessMembership | undefined
  assert.equal(removeResourceLessMembershipsWithAudit(1, (entry) => { delivered = entry }, db), 1)
  assert.deepEqual(delivered, { videoId: 1, videoCode: 'VIDEO-1', videoTitle: title })
  member(1)
  assert.deepEqual(removeResourceLessMemberships(1, db), [delivered])
  noTemp()
})

for (const rejected of [false, true]) {
  it(`rejects ${rejected ? 'rejected' : 'resolved'} asynchronous callbacks and restores membership state`, async () => {
    member(1); member(2)
    const before = remaining()
    assert.throws(() => removeResourceLessMembershipsWithAudit(1, async () => {
      if (rejected) throw new Error('async failure')
    }, db), /must be synchronous/)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(remaining(), before)
    assert.equal(db.inTransaction, false)
    noTemp()
  })
}
