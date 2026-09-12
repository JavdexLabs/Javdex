import { beforeEach, afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabaseAtPath, closeDatabase, getDb } from '@library/db/database'
import { readScanAuditHeader } from './scanAuditReadHeader'
import { createScanAuditReadIndex } from './scanAuditReadIndex'
import { SCAN_AUDIT_SECTIONS, SCAN_AUDIT_OUTCOMES } from '@shared/scanAuditReadTypes'
import type { ScanAuditViewQuery } from '@shared/scanAuditReadTypes'
import { readLibraryScanAudit } from '../scanner/libraryScanAuditStore'
import { getLatestLibraryScanSnapshot } from '@library/db/libraryScanRepo'
let directory: string, filename: string
const identity = { libraryId: 1, runId: 'dual', finishedAt: 'finish' }
const limits = { sourceBytes: 8 * 1024 * 1024, indexBytes: 16 * 1024 * 1024, pageBytes: 1024 * 1024 }
function audit() {
  return { ...identity, schemaVersion: 2, configRevision: 1, trigger: 'manual', status: 'success', startedAt: 'start',
    files: Array.from({ length: 205 }, (_, i) => ({ rootId: 1, filePath: `/media/中文-${i}.mp4`, sourceKind: 'local', outcome: SCAN_AUDIT_OUTCOMES[i % 7] })),
    removedResources: [{ resourceId: 1, videoId: 1, videoCode: 'ONE', sourcePath: '/removed', resourceKind: 'local', displayName: null, videoTitle: null, reason: 'missing' }],
    promotedResources: [{ resourceId: 2, videoId: 2, videoCode: 'TWO', sourcePath: '/promoted', resourceKind: 'local', displayName: null, videoTitle: null, reason: 'promoted_after_removal' }],
    deletedVideos: [{ videoId: 3, videoCode: 'THREE', reason: 'resource_less' }],
    pendingGroups: [{ groupId: 1, normalizedCode: 'PENDING', resourceCount: 1 }]
  }
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-dual-audit-')); filename = path.join(directory, 'db.sqlite')
  const db = initDatabaseAtPath(filename)
  db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,finished_at,audit_json) VALUES('dual',1,1,'manual','completed','start','finish',?)").run(JSON.stringify(audit()))
  db.prepare('UPDATE media_library_scan_state SET last_summary_json=? WHERE library_id=1').run(JSON.stringify(identityWithStatus()))
})
afterEach(() => { closeDatabase(); fs.rmSync(directory, { recursive: true, force: true }) })
function identityWithStatus() { return { ...identity, status: 'success' } }
function entries(state: 'collecting' | 'sealed' | 'published' | 'abandoned' = 'published', overrides = {}) {
  const db = getDb(), value = audit()
  db.transaction(() => {
    db.prepare("DELETE FROM library_scan_runs WHERE id='dual'").run()
    db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at) VALUES('dual',1,1,'manual','running','start')").run()
    const meta = Object.fromEntries(Object.entries(value).filter(([key]) => !(SCAN_AUDIT_SECTIONS as readonly string[]).includes(key)))
    db.prepare("INSERT INTO library_scan_audit_manifests(run_id,meta_json) VALUES('dual',?)").run(JSON.stringify({ ...meta, ...overrides }))
    const insert = db.prepare("INSERT INTO library_scan_audit_entries(run_id,section,ordinal,entry_key,entry_json,entry_bytes) VALUES('dual',?,?,?,?,?)")
    for (const section of SCAN_AUDIT_SECTIONS) value[section].forEach((item, ordinal) => {
      const body = JSON.stringify(item)
      insert.run(section, ordinal, section === 'files' ? (item as { filePath: string }).filePath : null, body, Buffer.byteLength(body))
    })
    if (state === 'sealed' || state === 'published') db.exec("UPDATE library_scan_audit_manifests SET state='sealed',sealed_at='seal' WHERE run_id='dual'")
    if (state === 'published') {
      db.exec("UPDATE library_scan_runs SET status='completed',finished_at='finish' WHERE id='dual'")
      db.exec("UPDATE library_scan_audit_manifests SET state='published',published_at='finish' WHERE run_id='dual'")
    } else if (state === 'abandoned') db.exec("UPDATE library_scan_audit_manifests SET state='abandoned' WHERE run_id='dual'")
  })()
}
it('matches legacy raw pages, filtered views, header and compatibility readers for published entries', () => {
  const legacy = createScanAuditReadIndex(filename, identity, limits, { views: true })
  try {
    entries()
    const current = createScanAuditReadIndex(filename, identity, limits, { views: true })
    try {
      for (const section of SCAN_AUDIT_SECTIONS) for (const offset of [0, 100, 200, 300]) {
        assert.deepEqual(current.readPage({ section, offset }), legacy.readPage({ section, offset }))
      }
      for (const outcome of SCAN_AUDIT_OUTCOMES) for (const attention of [undefined, true, false]) {
        assert.deepEqual(current.readPage({ section: 'files', outcome, attention }), legacy.readPage({ section: 'files', outcome, attention }))
      }
      const queries: ScanAuditViewQuery[] = [{ tab: 'failed' }, { tab: 'all', search: '中文-1' }, { tab: 'added_updated' }, { tab: 'skipped' },
        ...(['all', 'removed', 'promoted', 'deleted'] as const).map(changesFilter => ({ tab: 'changes' as const, changesFilter })),
        { tab: 'failed', anchor: { kind: 'group', id: 1 } }]
      for (const query of queries) for (const offset of [0, 100, 200]) assert.deepEqual(current.readViewPage({ ...query, offset }), legacy.readViewPage({ ...query, offset }))
      assert.deepEqual(readScanAuditHeader(getDb(), 1).snapshot, identity)
      assert.deepEqual(readLibraryScanAudit(1), audit())
      assert.deepEqual(getLatestLibraryScanSnapshot(1).audit, audit())
      getDb().exec("DELETE FROM library_scan_runs WHERE id='dual'")
      assert.deepEqual(current.readPage({ section: 'files' }), legacy.readPage({ section: 'files' }))
    } finally { current.dispose() }
  } finally { legacy.dispose() }
})
it('keeps all unpublished states unavailable and preserves source, index and page budgets', () => {
  for (const state of ['collecting', 'sealed', 'abandoned'] as const) {
    entries(state)
    assert.equal(readScanAuditHeader(getDb(), 1).snapshot, null)
    assert.equal(readLibraryScanAudit(1), null)
    assert.throws(() => createScanAuditReadIndex(filename, identity, limits), /unavailable/)
  }
  entries()
  assert.throws(() => createScanAuditReadIndex(filename, identity, { ...limits, sourceBytes: 100 }), /source exceeds/)
  assert.throws(() => createScanAuditReadIndex(filename, identity, { ...limits, indexBytes: 4096 }), /full|space budget/)
  const index = createScanAuditReadIndex(filename, identity, { ...limits, pageBytes: 1000 })
  try {
    assert.throws(() => index.readPage({ section: 'files' }), /page exceeds/)
    assert.equal(index.readPage({ section: 'files', limit: 1 }).items.length, 1)
  } finally { index.dispose() }
})
it('rejects published metadata with wrong identities or embedded collections instead of silently overriding it', () => {
  for (const override of [{ libraryId: 2 }, { runId: 'other' }, { finishedAt: 'other' }, { files: [] }, { schemaVersion: true }, { configRevision: -1 }, { configRevision: undefined }, { trigger: 'invalid' }, { status: 'running' }, { startedAt: null }]) {
    entries('published', override)
    assert.throws(() => createScanAuditReadIndex(filename, identity, limits), /identity or structure/)
    assert.equal(readLibraryScanAudit(1), null)
  }
})
