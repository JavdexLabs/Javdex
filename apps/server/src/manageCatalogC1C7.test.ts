import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { isStructuredError } from '@shared/protocol/errors'
import { dispatchCatalogManage } from './manageCatalogHandlers'

function dispatch(
  operation: Parameters<typeof dispatchCatalogManage>[0],
  input: unknown
): unknown {
  return dispatchCatalogManage(operation, { input }, { epoch: 1 })
}

function asError(error: unknown): { code: string; message: string } {
  assert.ok(isStructuredError(error), String(error))
  return error
}

describe('C1-C7 catalog manage handlers', () => {
  const roots: string[] = []

  afterEach(() => {
    closeDatabase()
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('T1 locates queue pages, exact pending presence, scrape ids, and audit filters', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-c1c7-t1-'))
    roots.push(root)
    const db = initDatabaseAtPath(path.join(root, 'catalog.db'))
    db.exec(`
      INSERT INTO media_libraries(id,name,position) VALUES(2,'Other',1);
      INSERT INTO media_library_roots(id,library_id,path,normalized_path)
        VALUES(1,1,'/one','/one'),(2,2,'/two','/two');
      INSERT INTO pending_scan_groups(id,library_id,normalized_code,updated_at)
        VALUES(1,1,'G-ONE','2026'),(2,2,'G-TWO','2026');
      INSERT INTO pending_resource_identities(
        id,library_id,root_id,file_path,normalized_path,source_kind,filename_code,nfo_code,updated_at
      ) VALUES
        (1,1,1,'/one/visible.mp4','/one/visible.mp4','local','FILE','NFO','2026'),
        (2,2,2,'/two/other.mp4','/two/other.mp4','local','OTHER','NFO','2026');
      INSERT INTO videos(id,code) VALUES(11,'VID-011'),(12,'VID-012');
      INSERT INTO pending_video_scrapes(
        id,video_id,selected_fields_json,applicable_fields_json,update_mode,
        request_json,warnings_json,created_at,updated_at
      ) VALUES
        (8,11,'[]','[]','replace','{}','[]','2026','2026'),
        (9,12,'[]','[]','replace','{}','[]','2026','2026');
    `)

    assert.deepEqual(
      dispatch('pendingAudit.presence', {
        libraryId: 1,
        groupIds: [1, 2, 99],
        identityIds: [1, 2],
        scrapeIds: [8, 9, 99]
      }),
      { groupIds: [1], identityIds: [1], scrapeIds: [8, 9] }
    )

    try {
      dispatch('pendingAudit.presence', { libraryId: 9, groupIds: [1], identityIds: [], scrapeIds: [] })
      assert.fail('expected missing library to fail')
    } catch (error) {
      assert.equal(asError(error).code, 'INVALID_INPUT')
      assert.match(asError(error).message, /不存在/)
    }

    const queued = dispatch('pendingScan.queuePage', {
      libraryId: 1,
      limit: 50,
      offset: 0,
      anchor: { kind: 'identity', id: 1 }
    }) as { total: number; offset: number; items: Array<{ kind: string; id: number; libraryId: number }> }
    assert.equal(queued.total, 2)
    assert.equal(queued.items.length, 2)
    assert.ok(queued.items.every((item) => item.libraryId === 1))
    assert.ok(queued.items.some((item) => item.kind === 'identity' && item.id === 1))
    assert.ok(!JSON.stringify(queued).includes('/one/visible.mp4'))

    const missingAnchor = dispatch('pendingScan.queuePage', {
      libraryId: 1,
      anchor: { kind: 'group', id: 99 }
    }) as { total: number; offset: number; items: unknown[] }
    assert.equal(missingAnchor.total, 2)
    assert.equal(missingAnchor.offset, 0)

    assert.deepEqual(dispatch('pendingVideoScrapes.existingIds', { scrapeIds: [8, 99, 8] }), [8])
    assert.deepEqual(dispatch('pendingVideoScrapes.existingIds', { videoIds: [12, 11, 99] }), [11, 12])

    const scrapePage = dispatch('pendingVideoScrapes.page', { videoId: 12, limit: 50, offset: 0 }) as {
      total: number
      items: Array<{ id: number; videoId: number }>
    }
    assert.equal(scrapePage.total, 2)
    assert.ok(scrapePage.items.some((item) => item.videoId === 12))

    const audit = dispatch('scans.auditPage', {
      libraryId: 1,
      section: 'files',
      attention: true,
      limit: 20,
      offset: 5
    }) as { snapshot: null; section: string; items: unknown[]; total: number; offset: number }
    assert.equal(audit.snapshot, null)
    assert.equal(audit.section, 'files')
    assert.deepEqual(audit.items, [])
  })
})
