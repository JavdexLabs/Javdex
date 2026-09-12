import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LibraryScanAudit } from '@shared/libraryTypes'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { createMediaLibrary } from '../db/mediaLibraryRepo'
import {
  libraryScanAuditContainsPath,
  readLibraryScanAudit,
  writeLibraryScanAudit
} from './libraryScanAuditStore'

let tempRoot = ''
let previousUserData: string | undefined

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-scan-audit-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
})

afterEach(() => {
  closeDatabase()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function audit(): LibraryScanAudit {
  return {
    schemaVersion: 1,
    libraryId: 1,
    runId: 'scan-audit-test',
    configRevision: 1,
    trigger: 'manual',
    startedAt: '2026-08-24T01:00:00.000Z',
    finishedAt: '2026-08-24T01:00:01.000Z',
    status: 'success',
    files: [
      {
        rootId: 1,
        filePath: 'D:\\Media\\A-001.mp4',
        sourceKind: 'local',
        outcome: 'unrecognized'
      }
    ],
    removedResources: [],
    promotedResources: [],
    deletedVideos: [],
    pendingGroups: []
  }
}

describe('libraryScanAuditStore', () => {
  it('uses the latest non-NULL database body and never falls back to disk on missing or malformed persisted audit', () => {
    initDatabaseAtPath(path.join(tempRoot, 'library.db'))
    const directory = path.join(tempRoot, 'media')
    fs.mkdirSync(directory)
    const library = createMediaLibrary({ name: 'Audit', roots: [{ path: directory }] })
    const value = { ...audit(), libraryId: library.id }
    writeLibraryScanAudit(value)
    assert.equal(readLibraryScanAudit(library.id), null)
    const insert = getDb().prepare(`
      INSERT INTO library_scan_runs(id, library_id, config_revision, trigger, status, started_at, audit_json)
      VALUES (?, ?, 1, 'manual', 'running', ?, ?)
    `)
    for (const [runId, startedAt, body] of [
      ['z-old', '2026-08-01', JSON.stringify({ ...value, runId: 'z-old' })],
      ['a-new', '2026-09-01', JSON.stringify({ ...value, runId: 'a-new' })],
      ['b-new', '2026-09-01', JSON.stringify({ ...value, runId: 'b-new' })],
      ['c-null', '2026-10-01', null]
    ]) insert.run(runId, library.id, startedAt, body)
    assert.equal(readLibraryScanAudit(library.id)?.runId, 'b-new')
    getDb().prepare('UPDATE library_scan_runs SET audit_json = ? WHERE id = ?').run('{malformed', 'b-new')
    assert.equal(readLibraryScanAudit(library.id), null)
    getDb().prepare('UPDATE library_scan_runs SET audit_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...value, libraryId: library.id + 1 }), 'b-new')
    assert.equal(readLibraryScanAudit(library.id), null)
  })

  it('atomically replaces and restores the complete latest audit', () => {
    const value = audit()
    writeLibraryScanAudit(value)

    assert.deepEqual(readLibraryScanAudit(1), value)
    assert.equal(readLibraryScanAudit(2), null)
    assert.equal(libraryScanAuditContainsPath(value, 'd:\\media\\A-001.mp4'), true)
  })

  it('fails closed for malformed audit documents', () => {
    fs.writeFileSync(path.join(tempRoot, 'library-scan-audit-1.json'), '{"schemaVersion":1}')
    assert.equal(readLibraryScanAudit(1), null)
  })

  it('reads schema 2 NFO dispositions while retaining schema 1 compatibility', () => {
    const value: LibraryScanAudit = {
      ...audit(),
      schemaVersion: 2,
      files: [
        {
          rootId: 1,
          filePath: 'D:\\Media\\NFO-001.mp4',
          sourceKind: 'local',
          outcome: 'added',
          videoId: 10,
          videoCode: 'NFO-001',
          resourceId: 20,
          resourceKind: 'local',
          createdVideo: true,
          nfo: {
            disposition: 'warning',
            warnings: [{ code: 'nfo-warning', message: '远程图片已忽略' }]
          }
        }
      ]
    }
    writeLibraryScanAudit(value)
    assert.deepEqual(readLibraryScanAudit(1), value)

    fs.writeFileSync(
      path.join(tempRoot, 'library-scan-audit-2.json'),
      JSON.stringify({ ...value, libraryId: 2, files: [{ ...value.files[0], nfo: { disposition: 'bad' } }] })
    )
    assert.equal(readLibraryScanAudit(2), null)
  })
})
