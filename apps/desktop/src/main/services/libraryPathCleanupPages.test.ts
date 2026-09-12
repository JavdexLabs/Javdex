import { afterEach, beforeEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { createMediaLibrary } from '@library/db/mediaLibraryRepo'
import { insertLocalVideoResource, insertScannedVideo, importVideoLinkResourceRecord } from '@library/db/videoRepo'
import { createScanAuditWriter } from '@library/db/scanAuditWriter'
import { beginLibraryScanRun } from '@library/db/libraryScanRepo'
import { confirmLibraryPathRemoval, previewLibraryPathRemoval, createPendingLibraryPathCleanupPages } from './libraryPathCleanupService'
import { resetSettingsCacheForTests } from '../settings/settingsStore'

let directory: string, previous: string | undefined
beforeEach(() => {
  previous = process.env.JAVDEX_TEST_USER_DATA
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-deferred-pages-'))
  process.env.JAVDEX_TEST_USER_DATA = directory
})
afterEach(() => {
  closeDatabase(); resetSettingsCacheForTests()
  if (previous === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previous
  fs.rmSync(directory, { recursive: true, force: true })
})
function fixture(withLink = false) {
  const db = initDatabaseAtPath(path.join(directory, 'db.sqlite'))
  const roots = ['first', 'second'].map(name => {
    const folder = path.join(directory, name); fs.mkdirSync(folder); return { path: folder }
  })
  const library = createMediaLibrary({ name: 'Paged roots', roots })
  const first = path.join(roots[0].path, 'AAA-001.mp4'); fs.writeFileSync(first, 'video')
  const videoId = insertScannedVideo({ libraryId: library.id, rootId: library.roots[0].id, code: 'AAA-001', locator: first, size_bytes: 5 })!
  const add = (index: number) => insertLocalVideoResource({ libraryId: library.id, videoId,
    rootId: library.roots[index % 2].id, locator: path.join(roots[index % 2].path, `part-${index}.mp4`), sizeBytes: 5 })!
  for (let i = 1; i < 260; i++) add(i)
  let linkId: number | undefined
  if (withLink) {
    const link = importVideoLinkResourceRecord({ libraryId: library.id, code: 'AAA-001', target: { kind: 'existing', videoId },
      kind: 'web', locator: 'https://example.test/video', resourceKey: 'http:https://example.test/video', displayName: null, sizeBytes: null })
    assert.ok(!('duplicateOwnerCode' in link)); linkId = link.resource.id
    // Ordinary links with a root ID are not source-managed deletion targets.
    db.prepare('UPDATE video_resources SET root_id=? WHERE id=?').run(library.roots[0].id, linkId)
  }
  const jobs = library.roots.map(root => {
    const preview = previewLibraryPathRemoval({ libraryId: library.id, rootId: root.id })
    return confirmLibraryPathRemoval({ libraryId: library.id, rootId: root.id,
      expectedRevision: preview.libraryRevision, expectedImpactRevision: preview.impactRevision })
  })
  const high = (db.prepare('SELECT MAX(id) AS id FROM video_resources').get() as { id: number }).id
  const scope = { libraryId: library.id, runId: 'cleanup' }
  beginLibraryScanRun({ ...scope, configRevision: 1, trigger: 'manual', startedAt: 'start' })
  const writer = createScanAuditWriter(db, scope)
  writer.start({ schemaVersion: 2, ...scope, configRevision: 1, trigger: 'manual', startedAt: 'start', finishedAt: 'pending', status: 'success' })
  const pages = createPendingLibraryPathCleanupPages(jobs, high)
  const ids = (db.prepare('SELECT id FROM video_resources ORDER BY id LIMIT 128').all() as { id: number }[]).map(row => row.id)
  return { db, library, videoId, add, linkId, pages, ids, writer }
}

it('removes a >128-resource video across all job roots atomically and preserves an ordinary rooted link as primary', () => {
  const current = fixture(true)
  const result = current.db.transaction(() => current.pages.resources(current.ids,
    event => current.writer.writeBatch(event.section, [event.entry])))()
  assert.deepEqual(result, { removed: 260, promoted: 1 })
  assert.deepEqual(current.db.prepare('SELECT id,is_primary FROM video_resources').all(), [{ id: current.linkId, is_primary: 1 }])
  // A cancellation here leaves no partially removed target video; jobs remain pending.
  assert.deepEqual(current.db.prepare('SELECT DISTINCT state FROM library_root_cleanup_jobs').all(), [{ state: 'pending' }])
  current.db.transaction(() => current.pages.finish())()
  assert.deepEqual(current.db.prepare('SELECT DISTINCT state FROM library_root_cleanup_jobs').all(), [{ state: 'completed' }])
})

it('rolls a late same-video audit failure back across all roots and retries without a primary hole', () => {
  const current = fixture()
  current.db.exec(`CREATE TEMP TRIGGER fail_video_cleanup AFTER INSERT ON library_scan_audit_entries
    WHEN NEW.section='removedResources' AND NEW.ordinal=200 BEGIN SELECT RAISE(ABORT,'late video fault'); END;`)
  const run = () => current.db.transaction(() => current.pages.resources(current.ids,
    event => current.writer.writeBatch(event.section, [event.entry])))()
  assert.throws(run, /late video fault/)
  assert.deepEqual(current.db.prepare('SELECT COUNT(*) AS n,SUM(is_primary) AS primary_count FROM video_resources').get(), { n: 260, primary_count: 1 })
  assert.deepEqual(current.db.prepare('SELECT * FROM library_scan_audit_entries').all(), [])
  current.db.exec('DROP TRIGGER fail_video_cleanup')
  assert.equal(run().removed, 260)
  assert.deepEqual(current.db.prepare('SELECT * FROM video_resources').all(), [])
})

it('rejects a new target resource beyond the frozen high water before any video deletion', () => {
  const current = fixture()
  // Native write simulates an out-of-band insertion; normal APIs reject pending roots.
  current.db.prepare(`INSERT INTO video_resources(library_id,video_id,root_id,kind,locator,resource_key,source_identity)
    SELECT library_id,video_id,root_id,'local','/new-resource','new-key','new-source' FROM video_resources LIMIT 1`).run()
  assert.throws(() => current.db.transaction(() => current.pages.resources(current.ids,
    event => current.writer.writeBatch(event.section, [event.entry])))(), /新增/)
  assert.deepEqual(current.db.prepare('SELECT COUNT(*) AS n,SUM(is_primary) AS primary_count FROM video_resources').get(), { n: 261, primary_count: 1 })
  assert.deepEqual(current.db.prepare('SELECT * FROM library_scan_audit_entries').all(), [])
  assert.throws(() => current.db.transaction(() => current.pages.finish())(), /仍有待清理/)
  assert.deepEqual(current.db.prepare('SELECT DISTINCT state FROM library_root_cleanup_jobs').all(), [{ state: 'pending' }])
})
