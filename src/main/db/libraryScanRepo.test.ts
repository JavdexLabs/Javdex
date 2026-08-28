import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LibraryScanAudit, LibraryScanSummary } from '@shared/libraryTypes'
import { normalizeLocalPathIdentity } from '@shared/localPathIdentity'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { archiveMediaLibrary, createMediaLibrary } from './mediaLibraryRepo'
import { createMediaLibraryRootMigrationRepo } from './mediaLibraryRootMigrationRepo'
import {
  beginLibraryScanRun,
  finishLibraryScanRun,
  getLatestLibraryScanSnapshot,
  INTERRUPTED_LIBRARY_SCAN_ERROR,
  recoverInterruptedLibraryScanRuns
} from './libraryScanRepo'

let tempRoot = ''

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-library-scan-repo-'))
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
})

afterEach(() => {
  closeDatabase()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

function persistSuccessfulRun(input: {
  libraryId: number
  rootId: number
  runId: string
  filePath: string
}): void {
  const startedAt = '2026-08-29T01:00:00.000Z'
  const finishedAt = '2026-08-29T01:00:01.000Z'
  const summary: LibraryScanSummary = {
    libraryId: input.libraryId,
    runId: input.runId,
    configRevision: 1,
    trigger: 'manual',
    startedAt,
    finishedAt,
    status: 'success',
    scannedFiles: 1,
    resourcesAdded: 0,
    resourcesUpdated: 0,
    resourcesRemoved: 0,
    primaryResourcesPromoted: 0,
    videosDeleted: 0,
    skippedFiles: 0,
    failedFiles: 1,
    pendingScanGroups: 0,
    pendingScanResources: 0,
    offlineFolders: [],
    errorSummary: null
  }
  const audit: LibraryScanAudit = {
    schemaVersion: 1,
    libraryId: input.libraryId,
    runId: input.runId,
    configRevision: 1,
    trigger: 'manual',
    startedAt,
    finishedAt,
    status: 'success',
    files: [
      {
        rootId: input.rootId,
        filePath: input.filePath,
        sourceKind: 'local',
        outcome: 'unrecognized'
      }
    ],
    removedResources: [],
    promotedResources: [],
    deletedVideos: [],
    pendingGroups: []
  }
  beginLibraryScanRun({
    libraryId: input.libraryId,
    runId: input.runId,
    configRevision: 1,
    trigger: 'manual',
    startedAt
  })
  finishLibraryScanRun({
    libraryId: input.libraryId,
    runId: input.runId,
    status: 'completed',
    summary,
    audit,
    replaceUnrecognizedRootIds: [input.rootId],
    unrecognizedFiles: [
      {
        rootId: input.rootId,
        filePath: input.filePath,
        normalizedPath: normalizeLocalPathIdentity(input.filePath),
        reason: 'unrecognized_code'
      }
    ]
  })
}

describe('libraryScanRepo latest snapshot', () => {
  it('returns summary, audit, and unrecognized files only from the requested library', () => {
    const rootA = path.join(tempRoot, 'library-a')
    const rootB = path.join(tempRoot, 'library-b')
    fs.mkdirSync(rootA)
    fs.mkdirSync(rootB)
    const libraryA = createMediaLibrary({ name: 'A', roots: [{ path: rootA }] })
    const libraryB = createMediaLibrary({ name: 'B', roots: [{ path: rootB }] })
    const fileA = path.join(rootA, 'UNKNOWN-A.mp4')
    const fileB = path.join(rootB, 'UNKNOWN-B.mp4')

    persistSuccessfulRun({
      libraryId: libraryA.id,
      rootId: libraryA.roots[0].id,
      runId: 'scan-a',
      filePath: fileA
    })
    persistSuccessfulRun({
      libraryId: libraryB.id,
      rootId: libraryB.roots[0].id,
      runId: 'scan-b',
      filePath: fileB
    })

    const latestA = getLatestLibraryScanSnapshot(libraryA.id)
    const latestB = getLatestLibraryScanSnapshot(libraryB.id)
    assert.equal(latestA.summary?.runId, 'scan-a')
    assert.equal(latestA.audit?.runId, 'scan-a')
    assert.deepEqual(latestA.unrecognized, [
      { rootId: libraryA.roots[0].id, filePath: fileA }
    ])
    assert.equal(latestB.summary?.runId, 'scan-b')
    assert.equal(latestB.audit?.runId, 'scan-b')
    assert.deepEqual(latestB.unrecognized, [
      { rootId: libraryB.roots[0].id, filePath: fileB }
    ])
  })

  it('transactionally settles scan runs abandoned by the previous process', () => {
    const firstRoot = path.join(tempRoot, 'interrupted-a')
    const secondRoot = path.join(tempRoot, 'interrupted-b')
    fs.mkdirSync(firstRoot)
    fs.mkdirSync(secondRoot)
    const first = createMediaLibrary({ name: 'Interrupted A', roots: [{ path: firstRoot }] })
    const second = createMediaLibrary({ name: 'Interrupted B', roots: [{ path: secondRoot }] })
    const databasePath = path.join(tempRoot, 'library.db')
    getDb()
      .prepare(
        `INSERT INTO library_scan_runs (
           id, library_id, config_revision, trigger, status, started_at
         ) VALUES (?, ?, 1, 'manual', ?, ?)`
      )
      .run('previous-running', first.id, 'running', '2026-08-28T23:00:00.000Z')
    getDb()
      .prepare(
        `INSERT INTO library_scan_runs (
           id, library_id, config_revision, trigger, status, started_at
         ) VALUES (?, ?, 1, 'automatic', ?, ?)`
      )
      .run('previous-queued', second.id, 'queued', '2026-08-28T23:05:00.000Z')
    getDb()
      .prepare(
        'INSERT OR IGNORE INTO media_library_scan_state (library_id) VALUES (?), (?)'
      )
      .run(first.id, second.id)
    getDb()
      .prepare(
        `UPDATE media_library_scan_state
            SET active_run_id = ?, last_status = 'running',
                last_started_at = ?, last_summary_json = '{"stale":true}'
          WHERE library_id = ?`
      )
      .run('previous-running', '2026-08-28T23:00:00.000Z', first.id)
    getDb()
      .prepare(
        `UPDATE media_library_scan_state
            SET active_run_id = ?, last_status = 'queued', last_started_at = ?
          WHERE library_id = ?`
      )
      .run('previous-queued', '2026-08-28T23:05:00.000Z', second.id)

    closeDatabase()
    const restarted = initDatabaseAtPath(databasePath)
    const recoveredAt = '2026-08-29T00:00:00.000Z'
    assert.deepEqual(recoverInterruptedLibraryScanRuns(restarted, recoveredAt), {
      recoveredRunCount: 2,
      recoveredStateCount: 2
    })
    assert.deepEqual(
      restarted
        .prepare(
          `SELECT id, status, finished_at, error_summary
             FROM library_scan_runs ORDER BY id`
        )
        .all(),
      [
        {
          id: 'previous-queued',
          status: 'failed',
          finished_at: recoveredAt,
          error_summary: INTERRUPTED_LIBRARY_SCAN_ERROR
        },
        {
          id: 'previous-running',
          status: 'failed',
          finished_at: recoveredAt,
          error_summary: INTERRUPTED_LIBRARY_SCAN_ERROR
        }
      ]
    )
    assert.deepEqual(
      restarted
        .prepare(
          `SELECT library_id, active_run_id, last_status, last_finished_at,
                  last_summary_json, last_error, revision
             FROM media_library_scan_state
            WHERE library_id IN (?, ?)
            ORDER BY library_id`
        )
        .all(first.id, second.id),
      [
        {
          library_id: first.id,
          active_run_id: null,
          last_status: 'failed',
          last_finished_at: recoveredAt,
          last_summary_json: null,
          last_error: INTERRUPTED_LIBRARY_SCAN_ERROR,
          revision: 2
        },
        {
          library_id: second.id,
          active_run_id: null,
          last_status: 'failed',
          last_finished_at: recoveredAt,
          last_summary_json: null,
          last_error: INTERRUPTED_LIBRARY_SCAN_ERROR,
          revision: 2
        }
      ]
    )

    beginLibraryScanRun({
      libraryId: first.id,
      runId: 'current-process-run',
      configRevision: 1,
      trigger: 'manual',
      startedAt: '2026-08-29T00:01:00.000Z'
    })
    assert.deepEqual(
      restarted
        .prepare('SELECT status, finished_at, error_summary FROM library_scan_runs WHERE id = ?')
        .get('current-process-run'),
      { status: 'running', finished_at: null, error_summary: null }
    )
  })

  it('releases archive and root-migration busy gates after restart recovery', () => {
    const archiveRoot = path.join(tempRoot, 'archive-after-recovery')
    const sourceRoot = path.join(tempRoot, 'migrate-after-recovery')
    const targetRoot = path.join(tempRoot, 'migration-target')
    fs.mkdirSync(archiveRoot)
    fs.mkdirSync(sourceRoot)
    fs.mkdirSync(targetRoot)
    const archiveCandidate = createMediaLibrary({
      name: 'Archive after recovery',
      roots: [{ path: archiveRoot }]
    })
    const source = createMediaLibrary({
      name: 'Migrate after recovery',
      roots: [{ path: sourceRoot }]
    })
    const target = createMediaLibrary({ name: 'Migration target', roots: [{ path: targetRoot }] })
    const databasePath = path.join(tempRoot, 'library.db')
    const insertRun = getDb().prepare(
      `INSERT INTO library_scan_runs (
         id, library_id, config_revision, trigger, status, started_at
       ) VALUES (?, ?, 1, 'manual', 'running', '2026-08-28T23:00:00.000Z')`
    )
    insertRun.run('archive-stale-run', archiveCandidate.id)
    insertRun.run('migration-stale-run', source.id)
    getDb()
      .prepare(
        'INSERT OR IGNORE INTO media_library_scan_state (library_id) VALUES (?), (?)'
      )
      .run(archiveCandidate.id, source.id)
    const setActive = getDb().prepare(
      `UPDATE media_library_scan_state
          SET active_run_id = ?, last_status = 'running',
              last_started_at = '2026-08-28T23:00:00.000Z'
        WHERE library_id = ?`
    )
    setActive.run('archive-stale-run', archiveCandidate.id)
    setActive.run('migration-stale-run', source.id)

    closeDatabase()
    const restarted = initDatabaseAtPath(databasePath)
    recoverInterruptedLibraryScanRuns(restarted, '2026-08-29T00:00:00.000Z')

    const archived = archiveMediaLibrary({
      libraryId: archiveCandidate.id,
      expectedRevision: archiveCandidate.revision
    })
    assert.equal(archived.status, 'archived')
    const migrationPreview = createMediaLibraryRootMigrationRepo(restarted, {
      isLocalAccessible: fs.existsSync
    }).preview({
      sourceLibraryId: source.id,
      targetLibraryId: target.id,
      rootId: source.roots[0].id
    })
    assert.equal(migrationPreview.sourceLibraryId, source.id)
    assert.equal(migrationPreview.targetLibraryId, target.id)
  })

  it('returns an empty snapshot before the first run and rejects an unknown library', () => {
    const root = path.join(tempRoot, 'library')
    fs.mkdirSync(root)
    const library = createMediaLibrary({ name: 'Empty', roots: [{ path: root }] })

    assert.deepEqual(getLatestLibraryScanSnapshot(library.id), {
      summary: null,
      audit: null,
      unrecognized: []
    })
    assert.throws(() => getLatestLibraryScanSnapshot(99_999), /媒体库不存在/)
  })
})
