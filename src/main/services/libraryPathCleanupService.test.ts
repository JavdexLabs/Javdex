import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SETTINGS } from '@shared/settingsTypes'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import {
  createMediaLibrary,
  getMediaLibrary,
  getMediaLibraryDetail,
  getMediaLibraryRoot,
  listMediaLibraryAutomaticScanStates,
  updateMediaLibraryConfig,
  updateMediaLibraryRoot
} from '../db/mediaLibraryRepo'
import {
  importVideoLinkResourceRecord,
  insertLocalVideoResource,
  insertScannedVideo,
  insertStrmVideoResource,
  listVideoResources
} from '../db/videoRepo'
import { createScanCoordinator } from '../scanner/scanCoordinator'
import {
  applyPendingLibraryPathCleanups,
  cancelLibraryPathRemoval,
  confirmLibraryPathRemoval,
  consumePendingLibraryPathCleanups,
  listPendingLibraryPathCleanupRoots,
  previewLibraryPathRemoval,
  runLibraryScanCleanupTransaction
} from './libraryPathCleanupService'
import {
  bootstrapLegacyMediaLibrary,
  LEGACY_CLEANUP_WAITING_ERROR
} from './legacyMediaLibraryBootstrap'
import { mediaLibraryService } from './mediaLibraryService'

let tempRoot = ''

function makeDirectory(name: string): string {
  const directory = path.join(tempRoot, name)
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

function createLibrary(name: string, rootPath: string) {
  const library = createMediaLibrary({ name, roots: [{ path: rootPath }] })
  return {
    libraryId: library.id,
    rootId: library.roots[0].id,
    revision: library.revision,
    path: rootPath
  }
}

function createLocalVideo(input: {
  libraryId: number
  rootId: number
  code: string
  filePath: string
}): number {
  fs.mkdirSync(path.dirname(input.filePath), { recursive: true })
  fs.writeFileSync(input.filePath, input.code)
  const videoId = insertScannedVideo({
    libraryId: input.libraryId,
    rootId: input.rootId,
    code: input.code,
    locator: input.filePath,
    size_bytes: input.code.length
  })
  assert.ok(videoId)
  return videoId
}

function addLocalResource(input: {
  libraryId: number
  rootId: number | null
  videoId: number
  filePath: string
}): number {
  fs.mkdirSync(path.dirname(input.filePath), { recursive: true })
  fs.writeFileSync(input.filePath, 'copy')
  const resourceId = insertLocalVideoResource({
    libraryId: input.libraryId,
    rootId: input.rootId,
    videoId: input.videoId,
    locator: input.filePath,
    sizeBytes: 4
  })
  assert.ok(resourceId)
  return resourceId
}

function addWebResource(libraryId: number, videoId: number, code: string): number {
  const locator = `https://example.test/watch/${code}`
  const result = importVideoLinkResourceRecord({
    libraryId,
    code,
    target: { kind: 'existing', videoId },
    kind: 'web',
    locator,
    resourceKey: `http:${locator}`,
    displayName: null,
    sizeBytes: null
  })
  assert.ok(!('duplicateOwnerCode' in result))
  return result.resource.id
}

function resourceCount(libraryId: number, rootId: number): number {
  return (
    getDb()
      .prepare(
        'SELECT COUNT(*) AS count FROM video_resources WHERE library_id = ? AND root_id = ?'
      )
      .get(libraryId, rootId) as { count: number }
  ).count
}

interface LegacyCleanupState {
  root_state: string
  job_state: string
  last_error: string | null
}

function readRootId(libraryId: number, rootPath: string): number {
  const row = getDb()
    .prepare('SELECT id FROM media_library_roots WHERE library_id = ? AND path = ?')
    .get(libraryId, rootPath) as { id: number } | undefined
  assert.ok(row)
  return row.id
}

function readLegacyCleanupState(libraryId: number, rootId: number): LegacyCleanupState {
  const row = getDb()
    .prepare(
      `SELECT root.state AS root_state, job.state AS job_state, job.last_error
         FROM media_library_roots root
         JOIN library_root_cleanup_jobs job
           ON job.library_id = root.library_id AND job.root_id = root.id
        WHERE root.library_id = ? AND root.id = ?`
    )
    .get(libraryId, rootId) as LegacyCleanupState | undefined
  assert.ok(row)
  return row
}

async function observeLegacyCleanupDuringFullScan(input: {
  libraryId: number
  activeRootId: number
  activeRootPath: string
  cleanupRootId: number
}): Promise<LegacyCleanupState> {
  let stateDuringScan: LegacyCleanupState | null = null
  const coordinator = createScanCoordinator({
    createRunId: () => 'legacy-overlap-recovery-run',
    now: () => '2026-08-29T00:00:00.000Z',
    scanFolders: async (request) => {
      const activeRoot = getMediaLibraryRoot(input.libraryId, input.activeRootId)
      assert.ok(activeRoot)
      assert.deepEqual(request.roots, [activeRoot])
      stateDuringScan = readLegacyCleanupState(input.libraryId, input.cleanupRootId)
      return {
        libraryId: request.libraryId,
        runId: request.runId,
        scannedFiles: 0,
        imported: 0,
        skipped: 0,
        skippedShort: 0,
        failed: 0,
        pendingGroups: 0,
        pendingResources: 0,
        relocated: 0,
        refreshed: 0,
        removed: 0,
        promoted: 0,
        deletedVideos: 0,
        offlineFolders: [],
        newCodes: [],
        unrecognizedFiles: [],
        strmFailures: [],
        omittedStrmFailures: 0
      }
    }
  })

  await coordinator.run({ libraryId: input.libraryId, trigger: 'manual' })
  assert.ok(stateDuringScan)
  return stateDuringScan
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-root-cleanup-'))
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
})

afterEach(() => {
  closeDatabase()
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('libraryPathCleanupService', () => {
  it('previews only resources owned by the selected library and root', () => {
    const first = createLibrary('First', makeDirectory('first'))
    const second = createLibrary('Second', makeDirectory('second'))

    const sharedVideoId = createLocalVideo({
      ...first,
      code: 'SHARED-001',
      filePath: path.join(first.path, 'shared.mp4')
    })
    addLocalResource({
      ...second,
      videoId: sharedVideoId,
      filePath: path.join(second.path, 'shared.mp4')
    })

    const linkedVideoId = createLocalVideo({
      ...first,
      code: 'LINKED-001',
      filePath: path.join(first.path, 'linked.mp4')
    })
    addWebResource(first.libraryId, linkedVideoId, 'LINKED-001')
    const strmPath = path.join(first.path, 'LINKED-001.strm')
    fs.writeFileSync(strmPath, 'https://example.test/LINKED-001.mp4')
    assert.ok(
      insertStrmVideoResource({
        libraryId: first.libraryId,
        rootId: first.rootId,
        videoId: linkedVideoId,
        sourcePath: strmPath,
        kind: 'direct',
        locator: 'https://example.test/LINKED-001.mp4'
      })
    )

    const unmanagedVideoId = createLocalVideo({
      ...first,
      code: 'UNMANAGED-001',
      filePath: path.join(first.path, 'unmanaged.mp4')
    })
    getDb()
      .prepare('UPDATE video_resources SET root_id = NULL WHERE library_id = ? AND video_id = ?')
      .run(first.libraryId, unmanagedVideoId)

    const preview = previewLibraryPathRemoval({
      libraryId: first.libraryId,
      rootId: first.rootId
    })
    assert.match(preview.impactRevision, /^[a-f0-9]{64}$/)
    const { impactRevision: _impactRevision, ...projectedPreview } = preview
    assert.deepEqual(
      projectedPreview,
      {
        libraryId: first.libraryId,
        rootId: first.rootId,
        libraryRevision: first.revision,
        path: first.path,
        localResourceCount: 2,
        strmResourceCount: 1,
        pendingScanResourceCount: 0,
        unrecognizedFileCount: 0,
        terminalCleanupJobCount: 0,
        videosBecomingResourceLess: 1
      }
    )
    assert.throws(
      () => previewLibraryPathRemoval({ libraryId: first.libraryId, rootId: second.rootId }),
      /根目录不存在/
    )
  })

  it('previews and safely cleans a disabled root including pending and diagnostic rows', () => {
    const library = createLibrary('Disabled cleanup', makeDirectory('disabled-cleanup'))
    createLocalVideo({
      ...library,
      code: 'DISABLED-001',
      filePath: path.join(library.path, 'disabled.mp4')
    })
    const database = getDb()
    database
      .prepare(
        `INSERT INTO library_scan_runs (
           id, library_id, config_revision, trigger, status, started_at, finished_at
         ) VALUES ('disabled-cleanup-run', ?, 1, 'manual', 'completed', CURRENT_TIMESTAMP,
                   CURRENT_TIMESTAMP)`
      )
      .run(library.libraryId)
    const groupId = Number(
      database
        .prepare(
          `INSERT INTO pending_scan_groups (library_id, normalized_code)
           VALUES (?, 'PENDING-001')`
        )
        .run(library.libraryId).lastInsertRowid
    )
    database
      .prepare(
        `INSERT INTO pending_scan_resources (
           library_id, group_id, root_id, file_path, normalized_path, source_kind
         ) VALUES (?, ?, ?, ?, ?, 'local')`
      )
      .run(
        library.libraryId,
        groupId,
        library.rootId,
        path.join(library.path, 'pending.mp4'),
        path.join(library.path, 'pending.mp4')
      )
    database
      .prepare(
        `INSERT INTO library_unrecognized_files (
           library_id, root_id, file_path, normalized_path, reason, scan_run_id, last_seen_at
         ) VALUES (?, ?, ?, ?, 'unsupported_extension', 'disabled-cleanup-run', CURRENT_TIMESTAMP)`
      )
      .run(
        library.libraryId,
        library.rootId,
        path.join(library.path, 'unknown.bin'),
        path.join(library.path, 'unknown.bin')
      )
    database
      .prepare(
        `INSERT INTO pending_resource_identities (
           library_id, root_id, file_path, normalized_path, source_kind,
           filename_code, nfo_code, revision
         ) VALUES (?, ?, ?, ?, 'local', 'FILE-001', 'NFO-002', 1)`
      )
      .run(
        library.libraryId,
        library.rootId,
        path.join(library.path, 'identity.mp4'),
        path.join(library.path, 'identity.mp4')
      )
    updateMediaLibraryRoot({
      libraryId: library.libraryId,
      rootId: library.rootId,
      expectedRevision: library.revision,
      patch: { state: 'disabled' }
    })

    const preview = previewLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId
    })
    assert.equal(preview.localResourceCount, 1)
    assert.equal(preview.pendingScanResourceCount, 2)
    assert.equal(preview.unrecognizedFileCount, 1)
    const cleanup = confirmLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId,
      expectedRevision: preview.libraryRevision,
      expectedImpactRevision: preview.impactRevision
    })
    applyPendingLibraryPathCleanups([cleanup])

    assert.equal(resourceCount(library.libraryId, library.rootId), 0)
    assert.equal(
      database
        .prepare('SELECT COUNT(*) FROM pending_scan_resources WHERE root_id = ?')
        .pluck()
        .get(library.rootId),
      0
    )
    assert.equal(
      database
        .prepare('SELECT COUNT(*) FROM pending_resource_identities WHERE root_id = ?')
        .pluck()
        .get(library.rootId),
      0
    )
    assert.equal(
      database
        .prepare('SELECT COUNT(*) FROM pending_scan_groups WHERE library_id = ?')
        .pluck()
        .get(library.libraryId),
      0
    )
    assert.equal(
      database
        .prepare('SELECT COUNT(*) FROM library_unrecognized_files WHERE root_id = ?')
        .pluck()
        .get(library.rootId),
      0
    )
    assert.equal(getMediaLibraryRoot(library.libraryId, library.rootId)?.state, 'disabled')
    const finalPreview = previewLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId
    })
    assert.equal(finalPreview.terminalCleanupJobCount, 1)
    mediaLibraryService.removeRoot({
      libraryId: library.libraryId,
      rootId: library.rootId,
      expectedRevision: finalPreview.libraryRevision,
      expectedImpactRevision: finalPreview.impactRevision
    })
    assert.equal(getMediaLibraryRoot(library.libraryId, library.rootId), null)
    assert.equal(
      database
        .prepare('SELECT COUNT(*) FROM library_root_cleanup_jobs WHERE root_id = ?')
        .pluck()
        .get(library.rootId),
      0
    )
  })

  it('confirms with the current revision and queues an identity snapshot without deleting data', () => {
    const library = createLibrary('Queue', makeDirectory('queue'))
    const filePath = path.join(library.path, 'queued.mp4')
    createLocalVideo({ ...library, code: 'QUEUE-001', filePath })
    const preview = previewLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId
    })

    assert.throws(
      () =>
        confirmLibraryPathRemoval({
          libraryId: library.libraryId,
          rootId: library.rootId,
          expectedRevision: library.revision + 1,
          expectedImpactRevision: preview.impactRevision
        }),
      /刷新后重试/
    )

    const cleanup = confirmLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId,
      expectedRevision: library.revision,
      expectedImpactRevision: preview.impactRevision
    })
    const root = getMediaLibraryRoot(library.libraryId, library.rootId)
    const job = getDb()
      .prepare(
        `SELECT library_id, root_id, state, root_path, normalized_root_path,
                normalized_real_path, device_id, inode, config_revision
           FROM library_root_cleanup_jobs WHERE id = ?`
      )
      .get(cleanup.jobId) as {
      library_id: number
      root_id: number
      state: string
      root_path: string
      normalized_root_path: string
      normalized_real_path: string | null
      device_id: string | null
      inode: string | null
      config_revision: number
    }

    assert.deepEqual(cleanup, {
      jobId: cleanup.jobId,
      libraryId: library.libraryId,
      rootId: library.rootId
    })
    assert.equal(root?.state, 'pending_removal')
    assert.equal(getMediaLibrary(library.libraryId)?.revision, library.revision + 1)
    assert.deepEqual(job, {
      library_id: library.libraryId,
      root_id: library.rootId,
      state: 'pending',
      root_path: library.path,
      normalized_root_path: root?.normalizedPath,
      normalized_real_path: root?.normalizedRealPath,
      device_id: root?.deviceId,
      inode: root?.inode,
      config_revision: 1
    })
    assert.equal(resourceCount(library.libraryId, library.rootId), 1)
    assert.equal(fs.existsSync(filePath), true)
  })

  it('rejects a confirmation when scan-owned resources changed after preview without a revision bump', () => {
    const library = createLibrary('Stale impact', makeDirectory('stale-impact'))
    createLocalVideo({
      ...library,
      code: 'STALE-001',
      filePath: path.join(library.path, 'first.mp4')
    })
    const preview = previewLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId
    })
    createLocalVideo({
      ...library,
      code: 'STALE-002',
      filePath: path.join(library.path, 'second.mp4')
    })

    assert.throws(
      () =>
        confirmLibraryPathRemoval({
          libraryId: library.libraryId,
          rootId: library.rootId,
          expectedRevision: preview.libraryRevision,
          expectedImpactRevision: preview.impactRevision
        }),
      /影响范围已变化|重新预览/
    )
    assert.equal(getMediaLibraryRoot(library.libraryId, library.rootId)?.state, 'active')
    assert.equal(
      getDb()
        .prepare('SELECT COUNT(*) AS count FROM library_root_cleanup_jobs')
        .pluck()
        .get(),
      0
    )
  })

  it('removes and promotes resources only inside the confirmed library and root', () => {
    const first = createLibrary('First', makeDirectory('first'))
    const second = createLibrary('Second', makeDirectory('second'))
    const sharedFirstPath = path.join(first.path, 'shared.mp4')
    const sharedVideoId = createLocalVideo({
      ...first,
      code: 'SHARED-002',
      filePath: sharedFirstPath
    })
    const sharedSecondPath = path.join(second.path, 'shared.mp4')
    const secondResourceId = addLocalResource({
      ...second,
      videoId: sharedVideoId,
      filePath: sharedSecondPath
    })
    const webResourceId = addWebResource(first.libraryId, sharedVideoId, 'SHARED-002')
    const onlyPath = path.join(first.path, 'only.mp4')
    const onlyVideoId = createLocalVideo({
      ...first,
      code: 'ONLY-002',
      filePath: onlyPath
    })
    const preview = previewLibraryPathRemoval({
      libraryId: first.libraryId,
      rootId: first.rootId
    })

    const cleanup = confirmLibraryPathRemoval({
      libraryId: first.libraryId,
      rootId: first.rootId,
      expectedRevision: first.revision,
      expectedImpactRevision: preview.impactRevision
    })
    const result = consumePendingLibraryPathCleanups(first.libraryId)

    assert.deepEqual(result, {
      removed: 2,
      promoted: 1,
      consumedRoots: [{ libraryId: first.libraryId, rootId: first.rootId }]
    })
    assert.deepEqual(listPendingLibraryPathCleanupRoots(first.libraryId), [])
    assert.equal(listVideoResources(first.libraryId, onlyVideoId).length, 0)
    assert.deepEqual(
      listVideoResources(first.libraryId, sharedVideoId).map((resource) => ({
        id: resource.id,
        isPrimary: resource.is_primary
      })),
      [{ id: webResourceId, isPrimary: 1 }]
    )
    assert.deepEqual(
      listVideoResources(second.libraryId, sharedVideoId).map((resource) => ({
        id: resource.id,
        isPrimary: resource.is_primary
      })),
      [{ id: secondResourceId, isPrimary: 1 }]
    )
    assert.equal(getMediaLibraryRoot(first.libraryId, first.rootId)?.state, 'disabled')
    assert.equal(getMediaLibraryRoot(second.libraryId, second.rootId)?.state, 'active')
    assert.equal(getMediaLibrary(first.libraryId)?.revision, first.revision + 2)
    assert.equal(getMediaLibrary(second.libraryId)?.revision, second.revision)
    assert.equal(
      (
        getDb()
          .prepare('SELECT state FROM library_root_cleanup_jobs WHERE id = ?')
          .get(cleanup.jobId) as { state: string }
      ).state,
      'completed'
    )
    assert.equal(fs.existsSync(sharedFirstPath), true)
    assert.equal(fs.existsSync(sharedSecondPath), true)
    assert.equal(fs.existsSync(onlyPath), true)
  })

  it('lets a cleanup-only scan consume the last removed root without touching another library', async () => {
    const first = createLibrary('Cleanup only', makeDirectory('cleanup-only'))
    const second = createLibrary('Other library', makeDirectory('other-library'))
    const videoId = createLocalVideo({
      ...first,
      code: 'CLEANUP-ONLY-001',
      filePath: path.join(first.path, 'cleanup-only.mp4')
    })
    const otherResourceId = addLocalResource({
      ...second,
      videoId,
      filePath: path.join(second.path, 'preserved.mp4')
    })
    const preview = previewLibraryPathRemoval({
      libraryId: first.libraryId,
      rootId: first.rootId
    })
    confirmLibraryPathRemoval({
      libraryId: first.libraryId,
      rootId: first.rootId,
      expectedRevision: first.revision,
      expectedImpactRevision: preview.impactRevision
    })

    let ordinaryScanRootCount: number | null = null
    let inspectedRootCount = 0
    const coordinator = createScanCoordinator({
      createRunId: () => 'cleanup-only-run',
      now: () => '2026-08-29T00:00:00.000Z',
      inspectRoot: async () => {
        inspectedRootCount += 1
        return true
      },
      scanFolders: async (request) => {
        ordinaryScanRootCount = request.roots.length
        return {
          libraryId: request.libraryId,
          runId: request.runId,
          scannedFiles: 0,
          imported: 0,
          skipped: 0,
          skippedShort: 0,
          failed: 0,
          pendingGroups: 0,
          pendingResources: 0,
          relocated: 0,
          refreshed: 0,
          removed: 0,
          promoted: 0,
          deletedVideos: 0,
          offlineFolders: [],
          newCodes: [],
          unrecognizedFiles: [],
          strmFailures: [],
          omittedStrmFailures: 0
        }
      }
    })

    const result = await coordinator.run({ libraryId: first.libraryId, trigger: 'manual' })

    assert.equal(ordinaryScanRootCount, 0)
    assert.equal(inspectedRootCount, 0)
    assert.equal(result.removed, 1)
    assert.deepEqual(listPendingLibraryPathCleanupRoots(first.libraryId), [])
    assert.equal(getMediaLibraryRoot(first.libraryId, first.rootId)?.state, 'disabled')
    assert.equal(getMediaLibraryRoot(second.libraryId, second.rootId)?.state, 'active')
    assert.deepEqual(
      listVideoResources(second.libraryId, videoId).map((resource) => resource.id),
      [otherResourceId]
    )
  })

  it('recovers an offline legacy cleanup intent when a later full scan sees the root online', async () => {
    const recoveredRootPath = path.join(tempRoot, 'legacy-reconnected')
    const bootstrap = bootstrapLegacyMediaLibrary({
      database: getDb(),
      readSettings: () => ({
        ...DEFAULT_SETTINGS,
        libraryPaths: [],
        pendingLibraryPathCleanups: [recoveredRootPath]
      }),
      updateSettings: () => undefined
    })
    const importedRoot = getMediaLibraryRoot(bootstrap.libraryId, 1)
    const waitingJob = getDb()
      .prepare(
        `SELECT state, last_error, normalized_real_path, device_id, inode
           FROM library_root_cleanup_jobs WHERE library_id = ?`
      )
      .get(bootstrap.libraryId)

    assert.equal(importedRoot?.state, 'disabled')
    assert.deepEqual(waitingJob, {
      state: 'failed',
      last_error: LEGACY_CLEANUP_WAITING_ERROR,
      normalized_real_path: null,
      device_id: null,
      inode: null
    })
    const waitingLibrary = getMediaLibraryDetail(bootstrap.libraryId)
    assert.equal(waitingLibrary?.activeRootCount, 0)
    assert.equal(
      waitingLibrary?.pendingCleanupJobCount,
      1,
      'the settings-page scan gate must treat the recoverable intent as runnable work'
    )
    assert.equal(
      listMediaLibraryAutomaticScanStates().find(
        (library) => library.libraryId === bootstrap.libraryId
      )?.pendingCleanupJobCount,
      1,
      'the automatic scheduler must also be able to retry the waiting intent'
    )

    let scannedRootCount: number | null = null
    let runSequence = 0
    const coordinator = createScanCoordinator({
      createRunId: () => `legacy-cleanup-recovery-run-${++runSequence}`,
      now: () => '2026-08-29T00:00:00.000Z',
      scanFolders: async (request) => {
        scannedRootCount = request.roots.length
        return {
          libraryId: request.libraryId,
          runId: request.runId,
          scannedFiles: 0,
          imported: 0,
          skipped: 0,
          skippedShort: 0,
          failed: 0,
          pendingGroups: 0,
          pendingResources: 0,
          relocated: 0,
          refreshed: 0,
          removed: 0,
          promoted: 0,
          deletedVideos: 0,
          offlineFolders: [],
          newCodes: [],
          unrecognizedFiles: [],
          strmFailures: [],
          omittedStrmFailures: 0
        }
      }
    })

    await assert.rejects(
      () => coordinator.run({ libraryId: bootstrap.libraryId, trigger: 'manual' }),
      (error: unknown) =>
        error instanceof Error && error.message === LEGACY_CLEANUP_WAITING_ERROR
    )
    assert.equal(scannedRootCount, null)
    assert.deepEqual(
      getDb()
        .prepare(
          `SELECT run.status, run.error_summary, state.active_run_id, state.last_status,
                  state.last_error
             FROM library_scan_runs run
             JOIN media_library_scan_state state ON state.library_id = run.library_id
            WHERE run.id = 'legacy-cleanup-recovery-run-1'`
        )
        .get(),
      {
        status: 'failed',
        error_summary: LEGACY_CLEANUP_WAITING_ERROR,
        active_run_id: null,
        last_status: 'failed',
        last_error: LEGACY_CLEANUP_WAITING_ERROR
      }
    )

    fs.mkdirSync(recoveredRootPath)
    await coordinator.run({ libraryId: bootstrap.libraryId, trigger: 'manual' })

    const recoveredRoot = getMediaLibraryRoot(bootstrap.libraryId, 1)
    const completedJob = getDb()
      .prepare(
        `SELECT state, last_error, normalized_real_path, device_id, inode
           FROM library_root_cleanup_jobs WHERE library_id = ?`
      )
      .get(bootstrap.libraryId) as {
      state: string
      last_error: string | null
      normalized_real_path: string | null
      device_id: string | null
      inode: string | null
    }
    assert.equal(scannedRootCount, 0)
    assert.equal(recoveredRoot?.state, 'disabled')
    assert.ok(recoveredRoot?.normalizedRealPath)
    assert.ok(recoveredRoot?.deviceId)
    assert.ok(recoveredRoot?.inode)
    assert.deepEqual(completedJob, {
      state: 'completed',
      last_error: null,
      normalized_real_path: recoveredRoot?.normalizedRealPath,
      device_id: recoveredRoot?.deviceId,
      inode: recoveredRoot?.inode
    })
  })

  it('keeps an overlapping legacy cleanup root waiting during a later full scan', async () => {
    const parentPath = makeDirectory('legacy-overlap-parent')
    const childPath = makeDirectory('legacy-overlap-parent/cleanup-child')
    const bootstrap = bootstrapLegacyMediaLibrary({
      database: getDb(),
      readSettings: () => ({
        ...DEFAULT_SETTINGS,
        libraryPaths: [parentPath],
        pendingLibraryPathCleanups: [childPath]
      }),
      updateSettings: () => undefined
    })
    const childRootId = readRootId(bootstrap.libraryId, childPath)
    const parentRootId = readRootId(bootstrap.libraryId, parentPath)
    const revisionBeforeScan = getMediaLibrary(bootstrap.libraryId)?.revision
    const expectedWaitingState = {
      root_state: 'disabled',
      job_state: 'failed',
      last_error: LEGACY_CLEANUP_WAITING_ERROR
    } satisfies LegacyCleanupState
    assert.deepEqual(readLegacyCleanupState(bootstrap.libraryId, childRootId), expectedWaitingState)

    const stateDuringScan = await observeLegacyCleanupDuringFullScan({
      libraryId: bootstrap.libraryId,
      activeRootId: parentRootId,
      activeRootPath: parentPath,
      cleanupRootId: childRootId
    })

    assert.deepEqual(stateDuringScan, expectedWaitingState)
    assert.deepEqual(readLegacyCleanupState(bootstrap.libraryId, childRootId), expectedWaitingState)
    assert.equal(getMediaLibrary(bootstrap.libraryId)?.revision, revisionBeforeScan)
  })

  it('keeps an overlapping parent legacy cleanup root waiting during a later full scan', async () => {
    const parentPath = makeDirectory('legacy-overlap-parent-cleanup')
    const childPath = makeDirectory('legacy-overlap-parent-cleanup/active-child')
    const bootstrap = bootstrapLegacyMediaLibrary({
      database: getDb(),
      readSettings: () => ({
        ...DEFAULT_SETTINGS,
        libraryPaths: [childPath],
        pendingLibraryPathCleanups: [parentPath]
      }),
      updateSettings: () => undefined
    })
    const cleanupRootId = readRootId(bootstrap.libraryId, parentPath)
    const activeRootId = readRootId(bootstrap.libraryId, childPath)
    const expectedWaitingState = {
      root_state: 'disabled',
      job_state: 'failed',
      last_error: LEGACY_CLEANUP_WAITING_ERROR
    } satisfies LegacyCleanupState

    assert.deepEqual(readLegacyCleanupState(bootstrap.libraryId, cleanupRootId), expectedWaitingState)
    assert.deepEqual(
      await observeLegacyCleanupDuringFullScan({
        libraryId: bootstrap.libraryId,
        activeRootId,
        activeRootPath: childPath,
        cleanupRootId
      }),
      expectedWaitingState
    )
    assert.deepEqual(readLegacyCleanupState(bootstrap.libraryId, cleanupRootId), expectedWaitingState)
  })

  it('keeps a realpath-alias legacy cleanup root waiting across libraries', async () => {
    const managedPath = makeDirectory('legacy-alias-managed')
    const aliasPath = path.join(tempRoot, 'legacy-alias-cleanup')
    fs.symlinkSync(managedPath, aliasPath, process.platform === 'win32' ? 'junction' : 'dir')
    createMediaLibrary({ name: 'Alias owner', roots: [{ path: managedPath }] })
    const activeDefaultPath = makeDirectory('legacy-alias-default-active')
    const bootstrap = bootstrapLegacyMediaLibrary({
      database: getDb(),
      readSettings: () => ({
        ...DEFAULT_SETTINGS,
        libraryPaths: [activeDefaultPath],
        pendingLibraryPathCleanups: [aliasPath]
      }),
      updateSettings: () => undefined
    })
    const cleanupRootId = readRootId(bootstrap.libraryId, aliasPath)
    const activeRootId = readRootId(bootstrap.libraryId, activeDefaultPath)
    const expectedWaitingState = {
      root_state: 'disabled',
      job_state: 'failed',
      last_error: LEGACY_CLEANUP_WAITING_ERROR
    } satisfies LegacyCleanupState

    assert.deepEqual(readLegacyCleanupState(bootstrap.libraryId, cleanupRootId), expectedWaitingState)
    assert.deepEqual(
      await observeLegacyCleanupDuringFullScan({
        libraryId: bootstrap.libraryId,
        activeRootId,
        activeRootPath: activeDefaultPath,
        cleanupRootId
      }),
      expectedWaitingState
    )
    assert.deepEqual(readLegacyCleanupState(bootstrap.libraryId, cleanupRootId), expectedWaitingState)
  })

  it('fails closed when a confirmed root is offline', () => {
    const library = createLibrary('Offline', makeDirectory('offline'))
    const filePath = path.join(library.path, 'offline.mp4')
    createLocalVideo({ ...library, code: 'OFFLINE-001', filePath })
    const preview = previewLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId
    })
    confirmLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId,
      expectedRevision: library.revision,
      expectedImpactRevision: preview.impactRevision
    })
    const detachedPath = `${library.path}-detached`
    fs.renameSync(library.path, detachedPath)

    assert.throws(() => consumePendingLibraryPathCleanups(library.libraryId), /根目录不可用/)
    assert.equal(resourceCount(library.libraryId, library.rootId), 1)
    assert.equal(getMediaLibraryRoot(library.libraryId, library.rootId)?.state, 'pending_removal')
    assert.equal(listPendingLibraryPathCleanupRoots(library.libraryId).length, 1)
    assert.equal(fs.existsSync(path.join(detachedPath, 'offline.mp4')), true)
  })

  it('fails closed when the path now resolves to a replacement directory', () => {
    const library = createLibrary('Replaced', makeDirectory('replaced'))
    createLocalVideo({
      ...library,
      code: 'REPLACED-001',
      filePath: path.join(library.path, 'replaced.mp4')
    })
    const preview = previewLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId
    })
    confirmLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId,
      expectedRevision: library.revision,
      expectedImpactRevision: preview.impactRevision
    })
    fs.renameSync(library.path, `${library.path}-original`)
    fs.mkdirSync(library.path)

    assert.throws(() => consumePendingLibraryPathCleanups(library.libraryId), /根目录身份已变化/)
    assert.equal(resourceCount(library.libraryId, library.rootId), 1)
    assert.equal(getMediaLibraryRoot(library.libraryId, library.rootId)?.state, 'pending_removal')
  })

  it('cancels a failed removal into a disabled, archiveable root without deleting records', async () => {
    const library = createLibrary('Cancellation', makeDirectory('cancellation'))
    createLocalVideo({
      ...library,
      code: 'CANCEL-001',
      filePath: path.join(library.path, 'cancel.mp4')
    })
    const frozenIdentity = getMediaLibraryRoot(library.libraryId, library.rootId)
    assert.ok(frozenIdentity?.normalizedRealPath)
    const preview = previewLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId
    })
    const cleanup = confirmLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId,
      expectedRevision: library.revision,
      expectedImpactRevision: preview.impactRevision
    })
    fs.renameSync(library.path, `${library.path}-original`)
    fs.mkdirSync(library.path)

    await assert.rejects(
      () => createScanCoordinator().run({ libraryId: library.libraryId, trigger: 'manual' }),
      /根目录身份已变化/
    )
    const revisionAfterFailure = getMediaLibrary(library.libraryId)?.revision
    assert.equal(revisionAfterFailure, library.revision + 1)
    assert.throws(
      () =>
        cancelLibraryPathRemoval({
          libraryId: library.libraryId,
          rootId: library.rootId,
          expectedRevision: library.revision
        }),
      (error: unknown) =>
        error instanceof Error && error.message.includes('媒体库已被其他操作更新')
    )

    const cancelled = cancelLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId,
      expectedRevision: revisionAfterFailure!
    })
    assert.equal(cancelled.state, 'disabled')
    assert.equal(cancelled.normalizedRealPath, frozenIdentity.normalizedRealPath)
    assert.equal(cancelled.deviceId, frozenIdentity.deviceId)
    assert.equal(cancelled.inode, frozenIdentity.inode)
    assert.equal(resourceCount(library.libraryId, library.rootId), 1)
    assert.deepEqual(listPendingLibraryPathCleanupRoots(library.libraryId), [])
    const cancelledJob = getDb()
      .prepare('SELECT state, completed_at FROM library_root_cleanup_jobs WHERE id = ?')
      .get(cleanup.jobId) as { state: string; completed_at: string | null }
    assert.equal(cancelledJob.state, 'cancelled')
    assert.ok(cancelledJob.completed_at)

    const currentRevision = getMediaLibrary(library.libraryId)?.revision
    const archived = mediaLibraryService.archive({
      libraryId: library.libraryId,
      expectedRevision: currentRevision!
    })
    assert.equal(archived.status, 'archived')
    assert.equal(resourceCount(library.libraryId, library.rootId), 1)
  })

  it('completes a confirmed cleanup after an unrelated library configuration edit', () => {
    const library = createLibrary('Revision', makeDirectory('revision'))
    createLocalVideo({
      ...library,
      code: 'REVISION-001',
      filePath: path.join(library.path, 'revision.mp4')
    })
    const preview = previewLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId
    })
    confirmLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId,
      expectedRevision: library.revision,
      expectedImpactRevision: preview.impactRevision
    })
    const config = updateMediaLibraryConfig({
      libraryId: library.libraryId,
      expectedRevision: 1,
      patch: { autoScanIntervalMinutes: 60 }
    })

    assert.equal(config.revision, 2)
    assert.deepEqual(consumePendingLibraryPathCleanups(library.libraryId), {
      removed: 1,
      promoted: 0,
      consumedRoots: [{ libraryId: library.libraryId, rootId: library.rootId }]
    })
    assert.equal(resourceCount(library.libraryId, library.rootId), 0)
    assert.equal(listPendingLibraryPathCleanupRoots(library.libraryId).length, 0)
    assert.equal(getMediaLibraryRoot(library.libraryId, library.rootId)?.state, 'disabled')
    assert.deepEqual(
      getDb()
        .prepare(
          'SELECT state, config_revision FROM library_root_cleanup_jobs WHERE library_id = ?'
        )
        .get(library.libraryId),
      { state: 'completed', config_revision: 1 },
      'the confirmation-time config revision remains an audit snapshot'
    )
  })

  it('rolls back resource removal, promotion, root state, and job completion together', () => {
    const library = createLibrary('Rollback', makeDirectory('rollback'))
    const videoId = createLocalVideo({
      ...library,
      code: 'ROLLBACK-001',
      filePath: path.join(library.path, 'rollback.mp4')
    })
    const preview = previewLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId
    })
    const cleanup = confirmLibraryPathRemoval({
      libraryId: library.libraryId,
      rootId: library.rootId,
      expectedRevision: library.revision,
      expectedImpactRevision: preview.impactRevision
    })
    const pending = listPendingLibraryPathCleanupRoots(library.libraryId)

    assert.throws(
      () =>
        runLibraryScanCleanupTransaction(() => {
          applyPendingLibraryPathCleanups(pending)
          throw new Error('forced later cleanup failure')
        }),
      /forced later cleanup failure/
    )

    assert.equal(listVideoResources(library.libraryId, videoId).length, 1)
    assert.equal(getMediaLibraryRoot(library.libraryId, library.rootId)?.state, 'pending_removal')
    assert.equal(
      (
        getDb()
          .prepare('SELECT state FROM library_root_cleanup_jobs WHERE id = ?')
          .get(cleanup.jobId) as { state: string }
      ).state,
      'pending'
    )
  })
})
