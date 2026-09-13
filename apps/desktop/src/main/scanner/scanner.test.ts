import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import {
  listLocalVideoResources as listLocalVideoResourcesScoped,
  insertLocalVideoResource,
  listVideoResources as listVideoResourcesScoped,
  listVideos
} from '@library/db/videoRepo'
import {
  importManual as importManualScoped,
  renameAndImport as renameAndImportScoped,
  scanFolders as scanFoldersScoped,
  type ScanOptions,
  type ScanProgressFn
} from './scanner'
import { insertTestVideoWithFile as insertTestVideoWithFileBase } from '@library/db/testVideoFixtures'
import { ensureVideoMembership } from '@library/db/libraryMembershipRepo'
import {
  listPendingScanGroups as listPendingScanGroupsScoped,
  resolvePendingScanGroup as resolvePendingScanGroupScoped,
  upsertPendingScanResources as upsertPendingScanResourcesScoped,
  type PendingScanResourceInput
} from '@library/db/pendingScanRepo'
import { selectPrimaryVideoResourceCandidate } from '../services/videoResourcePromotion'
import { createVideoMaintenanceService } from '../services/videoMaintenanceService'
import type {
  LibraryScanFileAuditEntry,
  PendingScanGroupResolution
} from '@shared/libraryTypes'
import type { VideoResourceImportTarget } from '@shared/videoTypes'
import {
  archiveMediaLibrary,
  createMediaLibrary,
  getMediaLibraryRoot,
  MediaLibraryRepoError,
  resolveMediaLibraryRootPath
} from '@library/db/mediaLibraryRepo'
import { isPathUnderRoot } from '@library/scan/libraryPathUtils'
import { listPendingResourceIdentities } from '@library/db/pendingResourceIdentityRepo'
import { resolvePendingResourceIdentity } from '../services/pendingResourceIdentityService'
import type {
  LocalNfoScanApplyResult,
  LocalNfoScanService
} from '../services/localNfoScanService'
import type {
  LocalNfoAnchor,
  LocalNfoIdentityInspection
} from '../metadata-sources'

const TEST_LIBRARY_ID = 1
let testRunSequence = 0

function ensureTestRoot(rootPath: string): number {
  const db = getDb()
  const identity = resolveMediaLibraryRootPath(rootPath)
  const existing = db
    .prepare(
      'SELECT id FROM media_library_roots WHERE library_id = ? AND normalized_path = ?'
    )
    .get(TEST_LIBRARY_ID, identity.normalizedPath) as { id: number } | undefined
  if (existing) return existing.id
  return Number(
    db
      .prepare(
        `INSERT INTO media_library_roots (
           library_id, path, normalized_path, real_path, normalized_real_path,
           device_id, inode, position, state
         ) VALUES (?, ?, ?, ?, ?, ?, ?,
           (SELECT COUNT(*) FROM media_library_roots WHERE library_id = ?), 'active')`
      )
      .run(
        TEST_LIBRARY_ID,
        identity.path,
        identity.normalizedPath,
        identity.realPath,
        identity.normalizedRealPath,
        identity.deviceId,
        identity.inode,
        TEST_LIBRARY_ID
      ).lastInsertRowid
  )
}

function rootIdForFile(filePath: string): number {
  const roots = getDb()
    .prepare(
      "SELECT id, path FROM media_library_roots WHERE library_id = ? AND state = 'active'"
    )
    .all(TEST_LIBRARY_ID) as Array<{ id: number; path: string }>
  const root = roots
    .filter((candidate) => isPathUnderRoot(filePath, candidate.path))
    .sort((left, right) => right.path.length - left.path.length)[0]
  return root?.id ?? ensureTestRoot(path.dirname(filePath))
}

type LegacyScanOptions = ScanOptions & { unavailableRoots?: string[] }

async function scanFolders(
  folders: string[],
  onProgress?: ScanProgressFn,
  options: LegacyScanOptions = {}
) {
  const roots = folders.map((rootPath) => {
    const root = getMediaLibraryRoot(TEST_LIBRARY_ID, ensureTestRoot(rootPath))
    assert.ok(root)
    return root
  })
  const { unavailableRoots = [], ...scopedOptions } = options
  return scanFoldersScoped(
    {
      libraryId: TEST_LIBRARY_ID,
      runId: `scanner-test-${++testRunSequence}`,
      roots
    },
    onProgress,
    {
      ...scopedOptions,
      resultMode: 'detailed',
      unavailableRootIds: unavailableRoots.map(ensureTestRoot),
      autoMergeSameCodeResources: scopedOptions.autoMergeSameCodeResources ?? true
    }
  )
}

function insertTestVideoWithFile(
  db: Parameters<typeof insertTestVideoWithFileBase>[0],
  options: Parameters<typeof insertTestVideoWithFileBase>[1]
) {
  const missingParent = !fs.existsSync(path.dirname(options.filePath))
  return insertTestVideoWithFileBase(db, {
    ...options,
    ...(missingParent ? { rootId: ensureTestRoot(path.dirname(options.filePath)) } : {})
  })
}

function listVideoResources(videoId: number) {
  return listVideoResourcesScoped(TEST_LIBRARY_ID, videoId)
}

function listLocalVideoResources(videoId: number) {
  return listLocalVideoResourcesScoped(TEST_LIBRARY_ID, videoId)
}

function listPendingScanGroups() {
  return listPendingScanGroupsScoped(TEST_LIBRARY_ID)
}

function upsertPendingScanResources(
  code: string,
  inputs: Array<Omit<PendingScanResourceInput, 'rootId'> & { scanRoot: string }>
) {
  return upsertPendingScanResourcesScoped(
    TEST_LIBRARY_ID,
    code,
    inputs.map(({ scanRoot, ...input }) => ({
      ...input,
      rootId: ensureTestRoot(scanRoot)
    }))
  )
}

function resolvePendingScanGroup(
  groupId: number,
  resolution: Omit<PendingScanGroupResolution, 'expectedRevision'> & {
    expectedRevision?: number
  },
  options?: Parameters<typeof resolvePendingScanGroupScoped>[3]
) {
  const group = listPendingScanGroupsScoped(TEST_LIBRARY_ID).find((item) => item.id === groupId)
  return resolvePendingScanGroupScoped(
    TEST_LIBRARY_ID,
    groupId,
    {
      ...resolution,
      expectedRevision: resolution.expectedRevision ?? group?.revision ?? 1
    },
    options
  )
}

function importManual(
  filePath: string,
  code: string,
  target: VideoResourceImportTarget
) {
  return importManualScoped({
    libraryId: TEST_LIBRARY_ID,
    rootId: rootIdForFile(filePath),
    filePath,
    code,
    target
  })
}

function renameAndImport(
  oldPath: string,
  newName: string
) {
  return renameAndImportScoped({
    libraryId: TEST_LIBRARY_ID,
    rootId: rootIdForFile(oldPath),
    oldPath,
    newName
  })
}

let tempRoot: string | null = null

function makeTempRoot(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-scan-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  return tempRoot
}

afterEach(() => {
  closeDatabase()
  resetSettingsCacheForTests()
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
  delete process.env.JAVDEX_TEST_USER_DATA
})

describe('scanFolders', () => {
  function fakeLocalNfoService(input: {
    inspect: (anchor: LocalNfoAnchor) => LocalNfoIdentityInspection
    apply?: (
      videoId: number,
      code: string,
      anchors: readonly LocalNfoAnchor[]
    ) => Promise<LocalNfoScanApplyResult>
  }): LocalNfoScanService {
    return {
      inspectIdentity: input.inspect,
      apply:
        input.apply ??
        (async () => ({ disposition: 'none' as const, warnings: [] }))
    }
  }

  it('rejects an archived library atomically when manual import resumes after probing', async () => {
    const root = makeTempRoot()
    const libraryPath = path.join(root, 'manual-import-race')
    fs.mkdirSync(libraryPath, { recursive: true })
    const filePath = path.join(libraryPath, 'RACE-001.mp4')
    fs.writeFileSync(filePath, 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const library = createMediaLibrary({
      name: 'Manual import race',
      roots: [{ path: libraryPath }]
    })
    const rootId = library.roots[0]?.id
    assert.ok(rootId)
    const videoId = Number(
      getDb()
        .prepare("INSERT INTO videos (code, scraped_status) VALUES ('RACE-001', 0)")
        .run().lastInsertRowid
    )
    ensureVideoMembership({ libraryId: library.id, videoId, addedVia: 'manual' })

    await assert.rejects(
      importManualScoped(
        {
          libraryId: library.id,
          rootId,
          filePath,
          code: 'RACE-001',
          target: { kind: 'existing', videoId }
        },
        {
          readDurationSeconds: async () => {
            archiveMediaLibrary({
              libraryId: library.id,
              expectedRevision: library.revision
            })
            return 3600
          }
        }
      ),
      (error: unknown) =>
        error instanceof MediaLibraryRepoError && error.code === 'LIBRARY_ARCHIVED'
    )

    assert.equal(
      (getDb()
        .prepare('SELECT COUNT(*) AS count FROM video_resources WHERE library_id = ?')
        .get(library.id) as { count: number }).count,
      0
    )
    assert.equal(
      (getDb()
        .prepare('SELECT COUNT(*) AS count FROM library_video_memberships WHERE library_id = ?')
        .get(library.id) as { count: number }).count,
      1
    )
  })

  it('rejects manual import when the root is physically replaced while duration probing is suspended', async () => {
    const root = makeTempRoot()
    const libraryPath = path.join(root, 'manual-import-replaced-root')
    const detachedOriginalPath = path.join(root, 'detached-original-root')
    fs.mkdirSync(libraryPath, { recursive: true })
    const filePath = path.join(libraryPath, 'RACE-002.mp4')
    fs.writeFileSync(filePath, 'original video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const library = createMediaLibrary({
      name: 'Manual import replaced root',
      roots: [{ path: libraryPath }]
    })
    const libraryRoot = library.roots[0]
    assert.ok(libraryRoot)
    assert.ok(libraryRoot.inode)
    const videoId = Number(
      getDb()
        .prepare("INSERT INTO videos (code, scraped_status) VALUES ('RACE-002', 0)")
        .run().lastInsertRowid
    )
    ensureVideoMembership({ libraryId: library.id, videoId, addedVia: 'manual' })

    let releaseProbe!: (durationSeconds: number) => void
    const probeRelease = new Promise<number>((resolve) => {
      releaseProbe = resolve
    })
    let markProbeStarted!: () => void
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve
    })
    const importPromise = importManualScoped(
      {
        libraryId: library.id,
        rootId: libraryRoot.id,
        filePath,
        code: 'RACE-002',
        target: { kind: 'existing', videoId }
      },
      {
        readDurationSeconds: async () => {
          markProbeStarted()
          return probeRelease
        }
      }
    )

    await probeStarted
    fs.renameSync(libraryPath, detachedOriginalPath)
    fs.mkdirSync(libraryPath)
    fs.writeFileSync(filePath, 'replacement video')
    assert.notEqual(
      fs.statSync(libraryPath).ino.toString(),
      libraryRoot.inode,
      'test setup must replace the stored physical directory identity'
    )
    releaseProbe(3600)

    const outcome = await importPromise.then(
      (result) => ({ status: 'resolved' as const, result }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    )

    assert.deepEqual(
      {
        outcome: outcome.status,
        resources: getDb()
          .prepare(
            `SELECT library_id, video_id, root_id, kind, locator, size_bytes,
                    duration_seconds, file_mtime_ms
             FROM video_resources
             WHERE library_id = ?
             ORDER BY id`
          )
          .all(library.id),
        memberships: (getDb()
          .prepare('SELECT COUNT(*) AS count FROM library_video_memberships WHERE library_id = ?')
          .get(library.id) as { count: number }).count,
        pendingGroups: (getDb()
          .prepare('SELECT COUNT(*) AS count FROM pending_scan_groups WHERE library_id = ?')
          .get(library.id) as { count: number }).count,
        unrecognizedFiles: (getDb()
          .prepare('SELECT COUNT(*) AS count FROM library_unrecognized_files WHERE library_id = ?')
          .get(library.id) as { count: number }).count
      },
      {
        outcome: 'rejected',
        resources: [],
        memberships: 1,
        pendingGroups: 0,
        unrecognizedFiles: 0
      },
      'a replacement root must not inherit the old root or receive any resumed import writes'
    )
  })

  it('keeps scan state unchanged when a frozen root is physically replaced during probing', async () => {
    const root = makeTempRoot()
    const libraryPath = path.join(root, 'scan-replaced-root')
    const detachedOriginalPath = path.join(root, 'detached-scan-root')
    fs.mkdirSync(libraryPath, { recursive: true })
    const filePath = path.join(libraryPath, 'RACE-003.mp4')
    fs.writeFileSync(filePath, 'original scan video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const library = createMediaLibrary({
      name: 'Scan replaced root',
      roots: [{ path: libraryPath }]
    })
    const libraryRoot = library.roots[0]
    assert.ok(libraryRoot)
    assert.ok(libraryRoot.inode)

    let releaseProbe!: (durationSeconds: number) => void
    const probeRelease = new Promise<number>((resolve) => {
      releaseProbe = resolve
    })
    let markProbeStarted!: () => void
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve
    })
    const audit: LibraryScanFileAuditEntry[] = []
    const scanPromise = scanFoldersScoped(
      {
        libraryId: library.id,
        runId: 'replaced-root-during-probe',
        roots: [libraryRoot]
      },
      undefined,
      {
        readDurationSeconds: async () => {
          markProbeStarted()
          return probeRelease
        },
        autoMergeSameCodeResources: true,
        onFileResult: (entry) => audit.push(entry)
      }
    )

    await probeStarted
    fs.renameSync(libraryPath, detachedOriginalPath)
    fs.mkdirSync(libraryPath)
    fs.writeFileSync(filePath, 'replacement scan video')
    assert.notEqual(fs.statSync(libraryPath).ino.toString(), libraryRoot.inode)
    releaseProbe(3600)

    const result = await scanPromise
    assert.deepEqual(
      {
        imported: result.imported,
        failed: result.failed,
        pendingResources: result.pendingResources,
        relocated: result.relocated,
        refreshed: result.refreshed,
        resources: (getDb()
          .prepare('SELECT COUNT(*) AS count FROM video_resources WHERE library_id = ?')
          .get(library.id) as { count: number }).count,
        memberships: (getDb()
          .prepare('SELECT COUNT(*) AS count FROM library_video_memberships WHERE library_id = ?')
          .get(library.id) as { count: number }).count,
        pendingGroups: (getDb()
          .prepare('SELECT COUNT(*) AS count FROM pending_scan_groups WHERE library_id = ?')
          .get(library.id) as { count: number }).count,
        videos: (getDb()
          .prepare("SELECT COUNT(*) AS count FROM videos WHERE code = 'RACE-003'")
          .get() as { count: number }).count,
        auditOutcome: audit[0]?.outcome
      },
      {
        imported: 0,
        failed: 1,
        pendingResources: 0,
        relocated: 0,
        refreshed: 0,
        resources: 0,
        memberships: 0,
        pendingGroups: 0,
        videos: 0,
        auditOutcome: 'processing_failure'
      }
    )
  })

  it('does not commit or rename a replacement-root file when rename-import resumes after probing', async () => {
    const root = makeTempRoot()
    const libraryPath = path.join(root, 'rename-import-replaced-root')
    const detachedOriginalPath = path.join(root, 'detached-rename-root')
    fs.mkdirSync(libraryPath, { recursive: true })
    const oldPath = path.join(libraryPath, 'UNKNOWN.mp4')
    const newName = 'RACE-004.mp4'
    const newPath = path.join(libraryPath, newName)
    fs.writeFileSync(oldPath, 'original rename video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const library = createMediaLibrary({
      name: 'Rename import replaced root',
      roots: [{ path: libraryPath }]
    })
    const libraryRoot = library.roots[0]
    assert.ok(libraryRoot)
    const videoId = Number(
      getDb()
        .prepare("INSERT INTO videos (code, scraped_status) VALUES ('RACE-004', 0)")
        .run().lastInsertRowid
    )
    ensureVideoMembership({ libraryId: library.id, videoId, addedVia: 'manual' })

    let releaseProbe!: (durationSeconds: number) => void
    const probeRelease = new Promise<number>((resolve) => {
      releaseProbe = resolve
    })
    let markProbeStarted!: () => void
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve
    })
    const importPromise = renameAndImportScoped(
      {
        libraryId: library.id,
        rootId: libraryRoot.id,
        oldPath,
        newName
      },
      {
        readDurationSeconds: async () => {
          markProbeStarted()
          return probeRelease
        }
      }
    )

    await probeStarted
    fs.renameSync(libraryPath, detachedOriginalPath)
    fs.mkdirSync(libraryPath)
    fs.writeFileSync(newPath, 'replacement rename video')
    releaseProbe(3600)

    assert.equal((await importPromise).outcome, 'failed')
    assert.equal(fs.readFileSync(newPath, 'utf8'), 'replacement rename video')
    assert.equal(
      fs.readFileSync(path.join(detachedOriginalPath, newName), 'utf8'),
      'original rename video'
    )
    assert.equal(fs.existsSync(path.join(detachedOriginalPath, path.basename(oldPath))), false)
    assert.equal(
      (getDb()
        .prepare('SELECT COUNT(*) AS count FROM video_resources WHERE library_id = ?')
        .get(library.id) as { count: number }).count,
      0
    )
    assert.equal(
      (getDb()
        .prepare('SELECT COUNT(*) AS count FROM pending_scan_groups WHERE library_id = ?')
        .get(library.id) as { count: number }).count,
      0
    )
  })

  it('rejects a disabled target root at the resource transaction boundary', () => {
    const root = makeTempRoot()
    const libraryPath = path.join(root, 'disabled-write-target')
    fs.mkdirSync(libraryPath, { recursive: true })
    const filePath = path.join(libraryPath, 'ROOT-001.mp4')
    fs.writeFileSync(filePath, 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const library = createMediaLibrary({
      name: 'Disabled resource target',
      roots: [{ path: libraryPath }]
    })
    const rootId = library.roots[0]?.id
    assert.ok(rootId)
    const videoId = Number(
      getDb()
        .prepare("INSERT INTO videos (code, scraped_status) VALUES ('ROOT-001', 0)")
        .run().lastInsertRowid
    )
    ensureVideoMembership({ libraryId: library.id, videoId, addedVia: 'manual' })
    getDb()
      .prepare("UPDATE media_library_roots SET state = 'disabled' WHERE id = ?")
      .run(rootId)

    assert.throws(
      () =>
        insertLocalVideoResource({
          libraryId: library.id,
          videoId,
          rootId,
          locator: filePath,
          sizeBytes: 5
        }),
      (error: unknown) =>
        error instanceof MediaLibraryRepoError && error.code === 'ROOT_NOT_FOUND'
    )
    assert.equal(
      (getDb()
        .prepare('SELECT COUNT(*) AS count FROM video_resources WHERE library_id = ?')
        .get(library.id) as { count: number }).count,
      0
    )
  })

  it('reuses archived local and STRM source paths without crossing library ownership', async () => {
    const root = makeTempRoot()
    const sharedRoot = path.join(root, 'shared-library')
    fs.mkdirSync(sharedRoot, { recursive: true })
    fs.writeFileSync(path.join(sharedRoot, 'SCOPE-001.mp4'), 'local video')
    fs.writeFileSync(path.join(sharedRoot, 'SCOPE-001.strm'), 'https://example.test/SCOPE-001.mp4')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const archivedLibrary = createMediaLibrary({
      name: 'Archived source owner',
      roots: [{ path: sharedRoot }]
    })
    const archivedRoot = archivedLibrary.roots[0]
    const first = await scanFoldersScoped(
      {
        libraryId: archivedLibrary.id,
        runId: 'archived-library-scan',
        roots: [archivedRoot]
      },
      undefined,
      { readDurationSeconds: async () => 3600, autoMergeSameCodeResources: true }
    )
    assert.equal(first.imported, 2)
    const videoId = listVideos().items.find((video) => video.code === 'SCOPE-001')?.id
    assert.ok(videoId)

    archiveMediaLibrary({
      libraryId: archivedLibrary.id,
      expectedRevision: archivedLibrary.revision
    })
    const activeLibrary = createMediaLibrary({
      name: 'Current source owner',
      roots: [{ path: sharedRoot }]
    })
    const activeRoot = activeLibrary.roots[0]
    const second = await scanFoldersScoped(
      {
        libraryId: activeLibrary.id,
        runId: 'replacement-library-scan',
        roots: [activeRoot]
      },
      undefined,
      { readDurationSeconds: async () => 3600, autoMergeSameCodeResources: true }
    )

    assert.equal(second.imported, 2)
    assert.equal(listVideoResourcesScoped(archivedLibrary.id, videoId).length, 2)
    assert.equal(listVideoResourcesScoped(activeLibrary.id, videoId).length, 2)
    assert.ok(
      listVideoResourcesScoped(archivedLibrary.id, videoId).every(
        (resource) => resource.library_id === archivedLibrary.id
      )
    )
    assert.ok(
      listVideoResourcesScoped(activeLibrary.id, videoId).every(
        (resource) => resource.library_id === activeLibrary.id
      )
    )
  })

  it('imports mixed local and STRM resources into one video and keeps the local file primary', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const localPath = path.join(library, 'MIX-001.mp4')
    const strmPath = path.join(library, 'MIX-001.strm')
    fs.writeFileSync(localPath, 'local video')
    fs.writeFileSync(strmPath, 'https://example.test/MIX-001.mp4?token=secret')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const probed: string[] = []

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async (file) => {
        probed.push(file)
        return 3600
      },
      minImportDurationSeconds: 3000
    })

    assert.equal(result.imported, 2)
    assert.equal(result.failed, 0)
    assert.deepEqual(probed, [localPath])
    const videos = listVideos({}).items
    assert.equal(videos.length, 1)
    const resources = listVideoResources(videos[0].id)
    assert.equal(resources.length, 2)
    assert.equal(resources.find((resource) => resource.is_primary === 1)?.kind, 'local')
    assert.deepEqual(
      resources
        .filter((resource) => resource.strm_source_path)
        .map((resource) => ({
          kind: resource.kind,
          locator: resource.locator,
          sourcePath: resource.strm_source_path,
          displayName: resource.display_name,
          sizeBytes: resource.size_bytes,
          durationSeconds: resource.duration_seconds
        })),
      [
        {
          kind: 'direct',
          locator: 'https://example.test/MIX-001.mp4?token=secret',
          sourcePath: strmPath,
          displayName: 'MIX-001.strm',
          sizeBytes: null,
          durationSeconds: null
        }
      ]
    )
  })

  it('chooses the scan primary independently of directory entry order', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const strmPath = path.join(library, 'ORDER-001-a.strm')
    const localPath = path.join(library, 'ORDER-001-z.mp4')
    fs.writeFileSync(strmPath, 'https://example.test/ORDER-001.mp4')
    fs.writeFileSync(localPath, 'local')
    initDatabaseAtPath(path.join(root, 'library.db'))

    await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3600,
      minImportDurationSeconds: null
    })

    const video = listVideos({}).items[0]
    assert.equal(listVideoResources(video.id).find((resource) => resource.is_primary)?.kind, 'local')
  })

  it('reselects the primary when scanning into an existing resource-less video', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const strmPath = path.join(library, 'EMPTY-001-a.strm')
    const localPath = path.join(library, 'EMPTY-001-z.mp4')
    fs.writeFileSync(strmPath, 'https://example.test/EMPTY-001.mp4')
    fs.writeFileSync(localPath, 'local')
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    const videoId = Number(
      db.prepare("INSERT INTO videos (code, scraped_status) VALUES ('EMPTY-001', 0)").run()
        .lastInsertRowid
    )

    await scanFolders([library], undefined, {
      readDirectory: async (directory) =>
        (await fs.promises.readdir(directory, { withFileTypes: true })).sort((left, right) =>
          left.name.endsWith('.strm') ? -1 : right.name.endsWith('.strm') ? 1 : 0
        ),
      readDurationSeconds: async () => 3600,
      minImportDurationSeconds: null
    })

    const resources = listVideoResources(videoId)
    assert.equal(resources.length, 2)
    assert.equal(resources.find((resource) => resource.is_primary === 1)?.kind, 'local')
  })

  it('keeps mixed local and STRM resources in one masked pending group', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const localPath = path.join(library, 'WAIT-001.mp4')
    const strmPath = path.join(library, 'WAIT-001.strm')
    fs.writeFileSync(localPath, 'local')
    fs.writeFileSync(strmPath, 'https://example.test/watch?id=1&token=secret')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3600,
      minImportDurationSeconds: null,
      autoMergeSameCodeResources: false
    })
    const [group] = listPendingScanGroups()

    assert.equal(result.pendingGroups, 1)
    assert.equal(result.pendingResources, 2)
    assert.deepEqual(
      group.resources.map((resource) => ({
        path: resource.filePath,
        sourceKind: resource.sourceKind,
        targetKind: resource.targetKind,
        targetDisplay: resource.targetDisplay
      })),
      [
        { path: localPath, sourceKind: 'local', targetKind: null, targetDisplay: null },
        {
          path: strmPath,
          sourceKind: 'strm',
          targetKind: 'web',
          targetDisplay: 'example.test / watch'
        }
      ]
    )
    assert.doesNotMatch(JSON.stringify(group), /token|secret/)

    const resolved = resolvePendingScanGroup(group.id, {
      assignments: group.resources.map((resource) => ({
        resourceId: resource.id,
        target: { kind: 'new' as const, groupKey: 'mixed' }
      }))
    })
    const resources = listVideoResources(resolved.createdVideoIds[0])
    assert.equal(resources.length, 2)
    assert.equal(resources.find((resource) => resource.is_primary === 1)?.kind, 'local')
    assert.equal(resources.find((resource) => resource.strm_source_path)?.locator,
      'https://example.test/watch?id=1&token=secret')
  })

  it('rejects a stale pending STRM assignment, refreshes its snapshot, then accepts it', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const existingPath = path.join(root, 'existing.mp4')
    const strmPath = path.join(library, 'STALE-001.strm')
    fs.writeFileSync(existingPath, 'existing')
    const infoHash = '1234567890abcdef1234567890abcdef12345678'
    fs.writeFileSync(strmPath, `magnet:?xt=urn:btih:${infoHash}&dn=Old`)
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    const { videoId } = insertTestVideoWithFile(db, {
      code: 'STALE-001',
      filePath: existingPath
    })
    await scanFolders([library], undefined, {
      minImportDurationSeconds: null,
      autoMergeSameCodeResources: false
    })
    const [group] = listPendingScanGroups()
    const resolution = {
      assignments: [
        { resourceId: group.resources[0].id, target: { kind: 'existing' as const, videoId } }
      ]
    }
    fs.writeFileSync(strmPath, `magnet:?xt=urn:btih:${infoHash}&dn=New`)

    assert.throws(() => resolvePendingScanGroup(group.id, resolution), /已变化.*已刷新/)
    assert.equal(listVideoResources(videoId).length, 1)
    const refreshed = listPendingScanGroups()[0]
    assert.equal(refreshed.resources[0].targetDisplay, 'Magnet · New')
    assert.doesNotMatch(JSON.stringify(refreshed), /btih|1234567890abcdef/i)

    const resolved = resolvePendingScanGroup(refreshed.id, resolution)
    assert.equal(resolved.assignedResources, 1)
    assert.equal(listVideoResources(videoId).length, 2)
    assert.equal(
      listVideoResources(videoId).find((resource) => resource.strm_source_path)?.locator,
      `magnet:?xt=urn:btih:${infoHash}&dn=New`
    )
  })

  it('removes an invalidated STRM snapshot from the pending group on a later scan', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const existingPath = path.join(root, 'existing.mp4')
    const strmPath = path.join(library, 'INVA-001.strm')
    fs.writeFileSync(existingPath, 'existing')
    fs.writeFileSync(strmPath, 'https://example.test/valid.mp4')
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    insertTestVideoWithFile(db, { code: 'INVA-001', filePath: existingPath })
    await scanFolders([library], undefined, {
      minImportDurationSeconds: null,
      autoMergeSameCodeResources: false
    })
    assert.equal(listPendingScanGroups().length, 1)
    fs.writeFileSync(strmPath, 'plugin://invalid/target')

    const result = await scanFolders([library], undefined, {
      minImportDurationSeconds: null,
      autoMergeSameCodeResources: false
    })

    assert.equal(result.failed, 1)
    assert.equal(listPendingScanGroups().length, 0)
  })

  it('syncs a changed STRM target in place while preserving primary and user-maintained fields', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const sourcePath = path.join(library, 'SYNC-001.strm')
    fs.writeFileSync(sourcePath, 'https://example.test/first.mp4')
    initDatabaseAtPath(path.join(root, 'library.db'))

    await scanFolders([library], undefined, { minImportDurationSeconds: null })
    const videoId = listVideos({}).items[0].id
    const original = listVideoResources(videoId)[0]
    getDb()
      .prepare('UPDATE video_resources SET display_name = ?, size_bytes = ? WHERE id = ?')
      .run('用户名称', 987654321, original.id)
    fs.writeFileSync(
      sourcePath,
      'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789&dn=Changed'
    )

    const result = await scanFolders([library], undefined, { minImportDurationSeconds: null })
    const updated = listVideoResources(videoId)[0]

    assert.equal(result.refreshed, 1)
    assert.equal(updated.id, original.id)
    assert.equal(updated.video_id, original.video_id)
    assert.equal(updated.is_primary, 1)
    assert.equal(updated.kind, 'magnet')
    assert.match(updated.locator, /^magnet:/)
    assert.equal(updated.strm_source_path, sourcePath)
    assert.equal(updated.display_name, '用户名称')
    assert.equal(updated.size_bytes, 987654321)
  })

  it('isolates invalid STRM files and retries them without replacing a bound target', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const boundPath = path.join(library, 'KEEP-001.strm')
    const newInvalidPath = path.join(library, 'BAD-001.strm')
    fs.writeFileSync(boundPath, 'https://example.test/keep.mp4')
    initDatabaseAtPath(path.join(root, 'library.db'))
    await scanFolders([library], undefined, { minImportDurationSeconds: null })
    const videoId = listVideos({}).items[0].id
    const original = listVideoResources(videoId)[0]
    fs.writeFileSync(boundPath, 'https://example.test/one\nhttps://example.test/two')
    fs.writeFileSync(newInvalidPath, 'plugin://unsafe/target')

    const failed = await scanFolders([library], undefined, { minImportDurationSeconds: null })

    assert.equal(failed.failed, 2)
    assert.deepEqual(
      failed.strmFailures.map((failure) => [failure.sourcePath, failure.code]).sort(),
      [
        [boundPath, 'multiple_targets'],
        [newInvalidPath, 'unsupported_target']
      ].sort()
    )
    assert.equal(listVideos({}).total, 1)
    assert.equal(listVideoResources(videoId)[0].locator, original.locator)

    fs.writeFileSync(boundPath, 'https://example.test/recovered.mp4')
    fs.writeFileSync(newInvalidPath, 'https://example.test/new.mp4')
    const recovered = await scanFolders([library], undefined, { minImportDurationSeconds: null })
    assert.equal(recovered.failed, 0)
    assert.equal(recovered.refreshed, 1)
    assert.equal(recovered.imported, 1)
  })

  it('relocates STRM only when the complete filename and target identify one missing source', async () => {
    const root = makeTempRoot()
    const firstRoot = path.join(root, 'first')
    const secondRoot = path.join(root, 'second')
    fs.mkdirSync(firstRoot, { recursive: true })
    fs.mkdirSync(secondRoot, { recursive: true })
    const originalPath = path.join(firstRoot, 'MOVE-001.strm')
    const relocatedPath = path.join(secondRoot, 'MOVE-001.strm')
    const renamedPath = path.join(firstRoot, 'MOVE-001-copy.strm')
    const target = 'https://example.test/move.mp4?source=one'
    fs.writeFileSync(originalPath, target)
    initDatabaseAtPath(path.join(root, 'library.db'))
    await scanFolders([firstRoot, secondRoot], undefined, { minImportDurationSeconds: null })
    const videoId = listVideos({}).items[0].id
    const originalId = listVideoResources(videoId)[0].id

    fs.renameSync(originalPath, relocatedPath)
    const relocated = await scanFolders([firstRoot, secondRoot], undefined, {
      minImportDurationSeconds: null
    })
    assert.equal(relocated.relocated, 1)
    assert.equal(listVideoResources(videoId)[0].id, originalId)
    assert.equal(listVideoResources(videoId)[0].strm_source_path, relocatedPath)

    fs.renameSync(relocatedPath, renamedPath)
    const renamed = await scanFolders([firstRoot, secondRoot], undefined, {
      minImportDurationSeconds: null
    })
    assert.equal(renamed.relocated, 0)
    assert.equal(renamed.imported, 1)
    assert.equal(listVideoResources(videoId).length, 2)
  })

  it('loads STRM candidates once per scan across imports, moves and pending writes', async (t) => {
    const root = makeTempRoot()
    const before = path.join(root, 'before')
    const after = path.join(root, 'after')
    fs.mkdirSync(before)
    fs.mkdirSync(after)
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    for (let i = 1; i <= 40; i++) {
      fs.writeFileSync(path.join(before, `MOVE-${String(i).padStart(3, '0')}.strm`), `https://example.test/${i}.mp4`)
    }
    let candidateLists = 0
    const prepare = db.prepare.bind(db)
    t.mock.method(db, 'prepare', (sql: string) => {
      if (sql.includes('strm_source_path AS source_path')) candidateLists++
      return prepare(sql)
    })
    const imported = await scanFolders([before, after], undefined, { minImportDurationSeconds: null })
    assert.equal(imported.imported, 40)
    assert.equal(candidateLists, 1)
    const ids = (db.prepare('SELECT id FROM video_resources ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id)
    for (const name of fs.readdirSync(before)) fs.renameSync(path.join(before, name), path.join(after, name))
    const moved = await scanFolders([before, after], undefined, { minImportDurationSeconds: null })
    assert.equal(moved.relocated, 40)
    assert.equal(moved.imported, 0)
    assert.equal(candidateLists, 2)
    const resources = db.prepare('SELECT id, strm_source_path FROM video_resources ORDER BY id').all() as Array<{ id: number; strm_source_path: string }>
    assert.deepEqual(resources.map((r) => r.id), ids)
    assert.ok(resources.every((r) => path.dirname(r.strm_source_path) === after))
    for (let i = 1; i <= 40; i++) {
      const code = String(i).padStart(3, '0')
      fs.writeFileSync(path.join(after, `MOVE-${code}-extra.strm`), `https://example.test/extra-${i}.mp4`)
      fs.writeFileSync(path.join(after, `NEW-${code}.strm`), `https://example.test/new-${i}.mp4`)
    }
    const mixed = await scanFolders([before, after], undefined, {
      minImportDurationSeconds: null, autoMergeSameCodeResources: false
    })
    assert.equal(mixed.imported, 40)
    assert.equal(mixed.pendingResources, 40)
    assert.equal(candidateLists, 3, 'pending-only writes do not reload the resource index')
  })

  it('relocates a bound STRM after its video code has been corrected', async () => {
    const root = makeTempRoot()
    const firstRoot = path.join(root, 'first')
    const secondRoot = path.join(root, 'second')
    fs.mkdirSync(firstRoot, { recursive: true })
    fs.mkdirSync(secondRoot, { recursive: true })
    const originalPath = path.join(firstRoot, 'OLD-001.strm')
    const relocatedPath = path.join(secondRoot, 'OLD-001.strm')
    fs.writeFileSync(originalPath, 'https://example.test/corrected.mp4')
    initDatabaseAtPath(path.join(root, 'library.db'))
    await scanFolders([firstRoot, secondRoot], undefined, { minImportDurationSeconds: null })
    const videoId = listVideos({}).items[0].id
    const resourceId = listVideoResources(videoId)[0].id
    createVideoMaintenanceService().correctImport(videoId, 'NEW-001')
    fs.renameSync(originalPath, relocatedPath)

    const result = await scanFolders([firstRoot, secondRoot], undefined, {
      minImportDurationSeconds: null
    })

    assert.equal(result.relocated, 1)
    assert.equal(listVideos({ search: 'NEW-001' }).items[0].id, videoId)
    assert.deepEqual(
      listVideoResources(videoId).map((resource) => [resource.id, resource.strm_source_path]),
      [[resourceId, relocatedPath]]
    )
  })

  it('holds new resources for confirmation when several videos already use the code', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const newPath = path.join(library, 'DUP-001-new.mp4')
    fs.writeFileSync(newPath, 'new resource')
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    insertTestVideoWithFile(db, {
      code: 'DUP-001',
      filePath: path.join(root, 'first.mp4'),
      title: 'First'
    })
    insertTestVideoWithFile(db, {
      code: 'DUP-001',
      filePath: path.join(root, 'second.mp4'),
      title: 'Second'
    })

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3600,
      minImportDurationSeconds: null
    })

    assert.equal(result.imported, 0)
    assert.equal(result.pendingGroups, 1)
    assert.equal(result.pendingResources, 1)
    assert.equal(listVideos({}).total, 2)
    assert.deepEqual(
      listPendingScanGroups().map((group) => ({
        code: group.normalizedCode,
        paths: group.resources.map((resource) => resource.filePath)
      })),
      [{ code: 'DUP-001', paths: [newPath] }]
    )
  })

  it('keeps an already-pending path out of relocation and refreshes its pending snapshot', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const missingPath = path.join(root, 'missing', 'PEN-001.mp4')
    const pendingPath = path.join(library, 'PEN-001-new.mp4')
    fs.writeFileSync(pendingPath, 'same-size')
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    const { videoId } = insertTestVideoWithFile(db, {
      code: 'PEN-001',
      filePath: missingPath,
      fileSize: Buffer.byteLength('same-size')
    })
    upsertPendingScanResources('PEN-001', [
      {
        filePath: pendingPath,
        scanRoot: library,
        sizeBytes: null,
        durationSeconds: null,
        fileMtimeMs: null
      }
    ])

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 2400,
      minImportDurationSeconds: 3000
    })

    assert.equal(result.relocated, 0)
    assert.deepEqual(
      listLocalVideoResources(videoId).map((resource) => resource.locator),
      [missingPath]
    )
    const [pending] = listPendingScanGroups()[0].resources
    assert.equal(pending.filePath, pendingPath)
    assert.equal(pending.durationSeconds, 2400)
    assert.equal(pending.sizeBytes, Buffer.byteLength('same-size'))
  })

  it('holds a same-scan multi-file code together when automatic assignment is disabled', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const first = path.join(library, 'OFF-001-a.mp4')
    const second = path.join(library, 'OFF-001-b.mp4')
    fs.writeFileSync(first, 'first')
    fs.writeFileSync(second, 'second')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async (file) => (file === first ? 1800 : 3600),
      minImportDurationSeconds: null,
      autoMergeSameCodeResources: false
    })

    assert.equal(result.imported, 0)
    assert.equal(result.pendingGroups, 1)
    assert.equal(result.pendingResources, 2)
    assert.equal(listVideos({}).total, 0)
    assert.deepEqual(
      listPendingScanGroups()[0]?.resources.map((resource) => resource.filePath).sort(),
      [first, second].sort()
    )
  })

  it('does not let an invalid STRM force a valid same-code video into confirmation', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const localPath = path.join(library, 'VALID-001.mp4')
    const invalidStrmPath = path.join(library, 'VALID-001.strm')
    fs.writeFileSync(localPath, 'local')
    fs.writeFileSync(invalidStrmPath, 'plugin://unsupported/target')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const result = await scanFolders([library], undefined, {
      readDirectory: async (directory) =>
        (await fs.promises.readdir(directory, { withFileTypes: true })).sort((left, right) =>
          left.name.endsWith('.mp4') ? -1 : right.name.endsWith('.mp4') ? 1 : 0
        ),
      readDurationSeconds: async () => 3600,
      minImportDurationSeconds: null,
      autoMergeSameCodeResources: false
    })

    assert.equal(result.imported, 1)
    assert.equal(result.failed, 1)
    assert.equal(result.pendingGroups, 0)
    assert.equal(listPendingScanGroups().length, 0)
    assert.equal(listVideos({}).total, 1)
  })

  it('persists a pending scan group across database reopen and assigns it atomically', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const first = path.join(library, 'KEEP-002-a.mp4')
    const second = path.join(library, 'KEEP-002-b.mp4')
    fs.writeFileSync(first, 'first')
    fs.writeFileSync(second, 'second')
    const databasePath = path.join(root, 'library.db')
    initDatabaseAtPath(databasePath)
    await scanFolders([library], undefined, {
      readDurationSeconds: async (file) => (file === first ? 1800 : 3600),
      minImportDurationSeconds: null,
      autoMergeSameCodeResources: false
    })
    closeDatabase()
    initDatabaseAtPath(databasePath)
    const [group] = listPendingScanGroups()
    assert.equal(group.resources.length, 2)

    assert.throws(
      () =>
        resolvePendingScanGroup(group.id, {
          assignments: [
            { resourceId: group.resources[0].id, target: { kind: 'new', groupKey: 'one' } }
          ]
        }),
      /每条资源恰好分配一次/
    )
    assert.equal(listPendingScanGroups()[0]?.resources.length, 2)

    const resolved = resolvePendingScanGroup(group.id, {
      assignments: group.resources.map((resource) => ({
        resourceId: resource.id,
        target: { kind: 'new' as const, groupKey: 'one' }
      }))
    })

    assert.equal(resolved.assignedResources, 2)
    assert.equal(resolved.createdVideoIds.length, 1)
    assert.equal(listPendingScanGroups().length, 0)
    const resources = listLocalVideoResources(resolved.createdVideoIds[0])
    assert.equal(resources.length, 2)
    assert.equal(resources.find((resource) => resource.is_primary === 1)?.locator, second)
  })

  it('rolls back every scan assignment when final pending-group deletion fails', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const first = path.join(library, 'ROLL-001-a.mp4')
    const second = path.join(library, 'ROLL-001-b.mp4')
    fs.writeFileSync(first, 'first')
    fs.writeFileSync(second, 'second')
    initDatabaseAtPath(path.join(root, 'library.db'))
    await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3600,
      minImportDurationSeconds: null,
      autoMergeSameCodeResources: false
    })
    const [group] = listPendingScanGroups()
    getDb().exec(`
      CREATE TRIGGER fail_pending_scan_group_delete
      BEFORE DELETE ON pending_scan_groups
      BEGIN
        SELECT RAISE(ABORT, 'forced pending scan delete failure');
      END;
    `)

    assert.throws(
      () =>
        resolvePendingScanGroup(group.id, {
          assignments: group.resources.map((resource) => ({
            resourceId: resource.id,
            target: { kind: 'new' as const, groupKey: 'one' }
          }))
        }),
      /forced pending scan delete failure/
    )

    assert.equal(listVideos({}).total, 0)
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS c FROM video_resources').get() as { c: number }).c,
      0
    )
    assert.equal(listPendingScanGroups()[0]?.resources.length, 2)
  })

  it('imports one unambiguous file normally when automatic assignment is disabled', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    fs.writeFileSync(path.join(library, 'ONLY-001.mp4'), 'single')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3600,
      minImportDurationSeconds: null,
      autoMergeSameCodeResources: false
    })

    assert.equal(result.imported, 1)
    assert.equal(result.pendingGroups, 0)
    assert.equal(listVideos({}).total, 1)
  })

  it('holds a new resource that matches one existing video when automatic assignment is disabled', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const existingPath = path.join(root, 'existing.mp4')
    const newPath = path.join(library, 'EXIST-001-new.mp4')
    fs.writeFileSync(existingPath, 'existing')
    fs.writeFileSync(newPath, 'new resource')
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    const existing = insertTestVideoWithFile(db, {
      code: 'EXIST-001',
      filePath: existingPath
    })

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3600,
      minImportDurationSeconds: null,
      autoMergeSameCodeResources: false
    })

    assert.equal(result.imported, 0)
    assert.equal(result.pendingGroups, 1)
    assert.equal(result.pendingResources, 1)
    assert.deepEqual(
      listLocalVideoResources(existing.videoId).map((resource) => resource.locator),
      [existingPath]
    )
    assert.deepEqual(
      listPendingScanGroups()[0].resources.map((resource) => resource.filePath),
      [newPath]
    )
  })

  it('promotes the available resource when assigning into an existing video without a primary', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const missingPath = path.join(root, 'missing', 'NPR-001-old.mp4')
    const newPath = path.join(library, 'NPR-001-new.mp4')
    fs.writeFileSync(newPath, 'new resource')
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    const existing = insertTestVideoWithFile(db, {
      code: 'NPR-001',
      filePath: missingPath,
      isPrimary: false,
      fileSize: 1
    })
    await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3600,
      minImportDurationSeconds: null,
      autoMergeSameCodeResources: false
    })
    const [group] = listPendingScanGroups()

    resolvePendingScanGroup(
      group.id,
      {
        assignments: [
          {
            resourceId: group.resources[0].id,
            target: { kind: 'existing', videoId: existing.videoId }
          }
        ]
      },
      {
        selectFallbackPrimaryResourceId: (videoId) =>
          selectPrimaryVideoResourceCandidate(listVideoResources(videoId), fs.existsSync)?.id ??
          null
      }
    )

    const primaryByLocator = new Map(
      listLocalVideoResources(existing.videoId).map((resource) => [
        resource.locator,
        resource.is_primary
      ])
    )
    assert.equal(primaryByLocator.get(missingPath), 0)
    assert.equal(primaryByLocator.get(newPath), 1)
  })

  it('normalizes a manual code and attaches to an existing case-insensitive identity', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const existingPath = path.join(library, 'ABC-123.mp4')
    const manualPath = path.join(library, 'manual-copy.mp4')
    fs.writeFileSync(existingPath, 'existing')
    fs.writeFileSync(manualPath, 'manual')
    initDatabaseAtPath(path.join(root, 'library.db'))
    await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3600,
      minImportDurationSeconds: null
    })

    const result = await importManual(manualPath, ' abc-123 ', {
      kind: 'existing',
      videoId: 1
    })

    assert.equal(result.code, 'ABC-123')
    assert.equal(result.imported, true)
    assert.equal(listVideos({}).total, 1)
    assert.equal(listLocalVideoResources(1).length, 2)
  })

  it('aborts when a nested directory cannot be audited', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    const inaccessible = path.join(library, 'inaccessible')
    fs.mkdirSync(inaccessible, { recursive: true })
    initDatabaseAtPath(path.join(root, 'library.db'))

    await assert.rejects(
      () =>
        scanFolders([library], undefined, {
          minImportDurationSeconds: null,
          readDirectory: async (dir) => {
            if (dir === inaccessible) throw new Error('EACCES')
            return fs.promises.readdir(dir, { withFileTypes: true })
          }
        }),
      /无法读取媒体目录.*EACCES/
    )
  })

  it('imports a symbolic-link video by its link path and file name', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    const targetDir = path.join(library, 'targets')
    fs.mkdirSync(library, { recursive: true })
    fs.mkdirSync(targetDir, { recursive: true })
    const targetPath = path.join(targetDir, 'source.bin')
    const linkPath = path.join(library, 'IPX-777.mp4')
    fs.writeFileSync(targetPath, 'video')
    fs.symlinkSync(targetPath, linkPath, 'file')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3661,
      minImportDurationSeconds: null
    })

    assert.equal(result.scannedFiles, 1)
    assert.equal(result.imported, 1)
    assert.deepEqual(result.newCodes, ['IPX-777'])
    const videos = listVideos({ limit: 10, offset: 0 })
    assert.equal(videos.total, 1)
    assert.equal(listLocalVideoResources(videos.items[0].id)[0]?.locator, linkPath)
  })

  it('does not follow symbolic-link directories', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    const targetDir = path.join(root, 'targets')
    fs.mkdirSync(library, { recursive: true })
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(path.join(targetDir, 'IPX-778.mp4'), 'video')
    fs.symlinkSync(targetDir, path.join(library, 'linked-directory'), 'junction')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3661,
      minImportDurationSeconds: null
    })

    assert.equal(result.scannedFiles, 0)
    assert.equal(result.imported, 0)
    assert.equal(listVideos({ limit: 10, offset: 0 }).total, 0)
  })

  it('silently skips a broken symbolic-link video', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    fs.symlinkSync(
      path.join(root, 'missing.mp4'),
      path.join(library, 'IPX-779.mp4'),
      'file'
    )
    initDatabaseAtPath(path.join(root, 'library.db'))

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3661,
      minImportDurationSeconds: null
    })

    assert.equal(result.scannedFiles, 0)
    assert.equal(result.imported, 0)
    assert.equal(result.failed, 0)
    assert.equal(result.unrecognizedFiles.length, 0)
  })

  it('leaves missing-resource cleanup to the high-level scan coordinator', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    const targetDir = path.join(library, 'targets')
    const targetPath = path.join(targetDir, 'target.bin')
    const linkPath = path.join(library, 'IPX-780.mp4')
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(targetPath, 'video')
    fs.symlinkSync(targetPath, linkPath, 'file')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const options = {
      readDurationSeconds: async (): Promise<number> => 3661,
      minImportDurationSeconds: null
    }

    const first = await scanFolders([library], undefined, options)
    fs.unlinkSync(targetPath)
    const second = await scanFolders([library], undefined, options)

    assert.equal(first.imported, 1)
    assert.equal(second.scannedFiles, 0)
    assert.equal(second.removed, 0)
    assert.equal(listVideos({ limit: 10, offset: 0 }).total, 1)
  })

  it('keeps distinct symbolic-link paths that point to the same target', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    const firstDir = path.join(library, 'first')
    const secondDir = path.join(library, 'second')
    const targetDir = path.join(library, 'targets')
    const targetPath = path.join(targetDir, 'target.bin')
    fs.mkdirSync(firstDir, { recursive: true })
    fs.mkdirSync(secondDir, { recursive: true })
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(targetPath, 'video')
    fs.symlinkSync(targetPath, path.join(firstDir, 'IPX-781.mp4'), 'file')
    fs.symlinkSync(targetPath, path.join(secondDir, 'IPX-781.mp4'), 'file')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3661,
      minImportDurationSeconds: null
    })

    assert.equal(result.scannedFiles, 2)
    assert.equal(result.imported, 2)
    const videos = listVideos({ limit: 10, offset: 0 })
    assert.equal(videos.total, 1)
    const resources = listLocalVideoResources(videos.items[0].id)
    assert.deepEqual(
      resources.map((resource) => resource.locator),
      [
        path.join(firstDir, 'IPX-781.mp4'),
        path.join(secondDir, 'IPX-781.mp4')
      ].sort()
    )
  })

  it('keeps a resource under an unavailable root when the same code appears online', async () => {
    const root = makeTempRoot()
    const unavailableLibrary = path.join(root, 'unavailable-library')
    const onlineLibrary = path.join(root, 'online-library')
    fs.mkdirSync(unavailableLibrary, { recursive: true })
    fs.mkdirSync(onlineLibrary, { recursive: true })
    const unavailablePath = path.join(unavailableLibrary, 'IPX-782.mp4')
    const onlinePath = path.join(onlineLibrary, 'IPX-782.mp4')
    fs.writeFileSync(unavailablePath, 'offline copy')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const options = {
      readDurationSeconds: async (): Promise<number> => 3661,
      minImportDurationSeconds: null
    }

    await scanFolders([unavailableLibrary], undefined, options)
    fs.rmSync(unavailableLibrary, { recursive: true })
    fs.writeFileSync(onlinePath, 'online copy')
    const result = await scanFolders([onlineLibrary], undefined, {
      ...options,
      unavailableRoots: [unavailableLibrary]
    })

    assert.equal(result.imported, 1)
    assert.equal(result.relocated, 0)
    const [video] = listVideos({ search: 'IPX-782' }).items
    assert.deepEqual(
      listLocalVideoResources(video.id)
        .map((resource) => resource.locator)
        .sort(),
      [onlinePath, unavailablePath].sort()
    )
  })

  it('relocates one same-code video by a unique file-size match without requiring the old name', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const oldPath = path.join(root, 'missing', 'unrelated-name.mp4')
    const newPath = path.join(library, 'MOVE-001-new.mp4')
    fs.writeFileSync(newPath, 'same bytes')
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    const { videoId } = insertTestVideoWithFile(db, {
      code: 'MOVE-001',
      filePath: oldPath,
      fileSize: Buffer.byteLength('same bytes')
    })

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3600,
      minImportDurationSeconds: null
    })

    assert.equal(result.relocated, 1)
    assert.equal(result.imported, 0)
    assert.deepEqual(
      listLocalVideoResources(videoId).map((resource) => resource.locator),
      [newPath]
    )
  })

  it('uses full file name and size to relocate safely when several videos share a code', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const newPath = path.join(library, 'MULTI-001.mp4')
    fs.writeFileSync(newPath, 'same bytes')
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    const exact = insertTestVideoWithFile(db, {
      code: 'MULTI-001',
      filePath: path.join(root, 'missing-a', 'MULTI-001.mp4'),
      fileSize: Buffer.byteLength('same bytes')
    })
    const other = insertTestVideoWithFile(db, {
      code: 'MULTI-001',
      filePath: path.join(root, 'missing-b', 'MULTI-001-other.mp4'),
      fileSize: Buffer.byteLength('same bytes')
    })

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3600,
      minImportDurationSeconds: null
    })

    assert.equal(result.relocated, 1)
    assert.deepEqual(listLocalVideoResources(exact.videoId).map((item) => item.locator), [newPath])
    assert.deepEqual(
      listLocalVideoResources(other.videoId).map((item) => item.locator),
      [path.join(root, 'missing-b', 'MULTI-001-other.mp4')]
    )
    assert.equal(listPendingScanGroups().length, 0)
  })

  it('does not relocate when full file name and size match more than one duplicate-code video', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const newPath = path.join(library, 'AMB-001.mp4')
    fs.writeFileSync(newPath, 'same bytes')
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    for (const directory of ['missing-a', 'missing-b']) {
      insertTestVideoWithFile(db, {
        code: 'AMB-001',
        filePath: path.join(root, directory, 'AMB-001.mp4'),
        fileSize: Buffer.byteLength('same bytes')
      })
    }

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3600,
      minImportDurationSeconds: null
    })

    assert.equal(result.relocated, 0)
    assert.equal(result.pendingResources, 1)
    assert.deepEqual(listPendingScanGroups()[0].resources.map((resource) => resource.filePath), [
      newPath
    ])
  })

  it('treats a new file normally when an old same-code path cannot be audited', async () => {
    const root = makeTempRoot()
    const oldLibrary = path.join(root, 'old-library')
    const newLibrary = path.join(root, 'new-library')
    fs.mkdirSync(oldLibrary)
    fs.mkdirSync(newLibrary)
    const oldPath = path.join(oldLibrary, 'IPX-783.mp4')
    const newPath = path.join(newLibrary, 'IPX-783.mp4')
    fs.writeFileSync(oldPath, 'old copy')
    fs.writeFileSync(newPath, 'new copy')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const baseOptions = {
      readDurationSeconds: async (): Promise<number> => 3661,
      minImportDurationSeconds: null
    }
    await scanFolders([oldLibrary], undefined, baseOptions)

    const result = await scanFolders([newLibrary], undefined, {
      ...baseOptions,
      inspectPath: (filePath) => (filePath === oldPath ? 'unknown' : 'present')
    })

    assert.equal(result.failed, 0)
    assert.equal(result.relocated, 0)
    assert.equal(result.imported, 1)
    const [video] = listVideos({ search: 'IPX-783' }).items
    assert.deepEqual(
      listLocalVideoResources(video.id).map((resource) => resource.locator).sort(),
      [newPath, oldPath].sort()
    )
  })

  it('keeps an unrecognized rename and only rediscovers the renamed file', async () => {
    const root = makeTempRoot()
    const directory = path.join(root, 'library')
    fs.mkdirSync(directory)
    const oldPath = path.join(directory, 'unknown.mp4')
    fs.writeFileSync(oldPath, 'video')
    fs.writeFileSync(path.join(directory, 'IPX-999.mp4'), 'unrelated video')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const unrecognized = await renameAndImport(oldPath, 'still-unknown')
    assert.equal(unrecognized.outcome, 'unrecognized')
    assert.equal(unrecognized.code, null)
    assert.equal(fs.existsSync(oldPath), false)
    assert.equal(fs.existsSync(unrecognized.newPath), true)
    assert.equal(listVideos({}).total, 0)

    const recognized = await renameAndImport(unrecognized.newPath, 'LOMD-007')
    assert.equal(recognized.outcome, 'imported')
    assert.equal(recognized.code, 'LOMD-007')
    assert.deepEqual(listVideos({}).items.map((video) => video.code), ['LOMD-007'])
  })

  it('uses the scan same-code pending flow when automatic merging is disabled', async () => {
    const root = makeTempRoot()
    const directory = path.join(root, 'library')
    fs.mkdirSync(directory)
    const oldPath = path.join(directory, 'unknown.mp4')
    fs.writeFileSync(oldPath, 'video')
    fs.writeFileSync(path.join(directory, 'IPX-900.mp4'), 'existing video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const library = createMediaLibrary({ name: '待确认', roots: [{ path: directory }],
      config: { autoMergeSameCodeResources: false, minImportDurationMinutes: 0 } })
    await scanFoldersScoped({ libraryId: library.id, runId: 'before-rename', roots: library.roots })

    const result = await renameAndImportScoped({
      libraryId: library.id, rootId: library.roots[0].id, oldPath, newName: 'IPX-900-extra'
    })
    assert.equal(result.outcome, 'pending')
    assert.equal(result.imported, false)
    assert.equal(fs.existsSync(result.newPath), true)
    const groups = listPendingScanGroupsScoped(library.id)
    assert.equal(groups.length, 1)
    assert.equal(groups[0].resources[0].filePath, result.newPath)
    assert.equal(listVideos({}).total, 1)
  })

  it('renames and discovers the code without a manual code or target', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const oldPath = path.join(library, 'unrecognized.mp4')
    fs.writeFileSync(oldPath, 'video')
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    const existing = insertTestVideoWithFile(db, {
      code: 'IPX-900',
      filePath: path.join(root, 'existing.mp4')
    })

    const result = await renameAndImport(oldPath, 'IPX-900-extra')

    const renamedPath = path.join(library, 'IPX-900-extra.mp4')
    assert.deepEqual(result, {
      newPath: renamedPath,
      newName: 'IPX-900-extra.mp4',
      imported: true,
      outcome: 'imported',
      code: 'IPX-900'
    })
    assert.equal(fs.existsSync(oldPath), false)
    assert.equal(fs.existsSync(renamedPath), true)
    assert.equal(
      listLocalVideoResources(existing.videoId).some((resource) => resource.locator === renamedPath),
      true
    )
  })

  it('renames and imports an unrecognized STRM as a source-managed link', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const sourcePath = path.join(library, 'unknown.strm')
    fs.writeFileSync(sourcePath, 'https://example.test/manual.mp4?token=secret')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const scan = await scanFolders([library], undefined, { minImportDurationSeconds: null })
    assert.deepEqual(scan.unrecognizedFiles, [sourcePath])

    const imported = await renameAndImport(sourcePath, 'MANUAL-001.strm')
    const newPath = path.join(library, 'MANUAL-001.strm')
    const video = listVideos({}).items[0]
    const resource = listVideoResources(video.id)[0]

    assert.equal(imported.newPath, newPath)
    assert.equal(imported.imported, true)
    assert.equal(resource.kind, 'direct')
    assert.equal(resource.strm_source_path, newPath)
    assert.equal(resource.locator, 'https://example.test/manual.mp4?token=secret')
    assert.equal(resource.display_name, 'MANUAL-001.strm')
    assert.equal(resource.size_bytes, null)
  })

  it('imports recognized videos and reports unrecognized files', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    fs.writeFileSync(path.join(library, 'IPX-535.mp4'), 'video')
    fs.writeFileSync(path.join(library, 'random_movie.mp4'), 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const progress: Array<{ scanned: number; imported: number; currentFile: string }> = []
    const result = await scanFolders([library], (p) => progress.push(p), { yieldEvery: 1 })

    assert.equal(result.scannedFiles, 2)
    assert.equal(result.imported, 1)
    assert.equal(result.failed, 1)
    assert.deepEqual(result.newCodes, ['IPX-535'])
    assert.equal(result.unrecognizedFiles.length, 1)
    assert.equal(progress.length, 2)

    const videos = listVideos({ limit: 10, offset: 0 })
    assert.equal(videos.total, 1)
    assert.equal(videos.items[0].code, 'IPX-535')
  })

  it('reuses scanned directory entries when checking a directory without NFO files', async (context) => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library)
    for (let index = 1; index <= 30; index += 1) {
      fs.writeFileSync(path.join(library, `FILE-${String(index).padStart(3, '0')}.mp4`), 'video')
    }
    initDatabaseAtPath(path.join(root, 'library.db'))
    const originalRead = fs.readdirSync
    let synchronousReads = 0
    context.mock.method(fs, 'readdirSync', (...args: unknown[]) => {
      if (args[0] === library) synchronousReads += 1
      return Reflect.apply(originalRead, fs, args)
    })
    const result = await scanFolders([library], undefined, {
      autoImportLocalNfo: true, readDurationSeconds: async () => null
    })
    assert.equal(result.imported, 30)
    assert.equal(synchronousReads, 0, 'sidecar lookup must reuse the collected directory index')
  })

  for (const sourceKind of ['local', 'strm'] as const) {
    it(`refreshes a changed ${sourceKind} identity snapshot on rescan before user confirmation`, async () => {
      const root = makeTempRoot()
      const library = path.join(root, 'library')
      fs.mkdirSync(library)
      const filePath = path.join(library, sourceKind === 'local' ? 'FILE-001.mp4' : 'FILE-001.strm')
      fs.writeFileSync(filePath, sourceKind === 'local' ? 'video' : 'https://example.test/old.mp4')
      initDatabaseAtPath(path.join(root, 'library.db'))
      const service = fakeLocalNfoService({ inspect: () => ({ status: 'found', code: 'NFO-999', warnings: [] }) })
      const options = { autoImportLocalNfo: true, localNfoService: service, readDurationSeconds: async () => null }
      await scanFolders([library], undefined, options)
      const previous = listPendingResourceIdentities(TEST_LIBRARY_ID)[0]
      assert.ok(previous)
      const newContent = sourceKind === 'local' ? 'changed video bytes' : 'https://example.test/changed-target.mp4'
      fs.writeFileSync(filePath, newContent)
      await assert.rejects(resolvePendingResourceIdentity(TEST_LIBRARY_ID, previous.id, {
        expectedRevision: previous.revision, choice: 'nfo'
      }, { nfoService: service }), /重新扫描/u)

      await scanFolders([library], undefined, options)
      assert.equal(listVideos({}).total, 0, 'rescan must keep the identity decision pending')
      const refreshed = listPendingResourceIdentities(TEST_LIBRARY_ID)[0]
      assert.equal(refreshed.id, previous.id)
      assert.ok(refreshed.revision > previous.revision)
      const result = await resolvePendingResourceIdentity(TEST_LIBRARY_ID, refreshed.id, {
        expectedRevision: refreshed.revision, choice: 'nfo'
      }, { nfoService: service, readDurationSeconds: async () => null })
      assert.equal(result.status, 'assigned')
      assert.equal(listPendingResourceIdentities(TEST_LIBRARY_ID).length, 0)
      if (result.status === 'assigned') {
        assert.ok(result.videoId)
        assert.equal(listVideoResources(result.videoId)[0].locator, sourceKind === 'local' ? filePath : newContent)
      }
    })
  }

  it('uses NFO identity only for newly discovered resources when automatic import is enabled', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const existingPath = path.join(library, 'EXIST-001.mp4')
    const disabledPath = path.join(library, 'disabled-name.mp4')
    fs.writeFileSync(existingPath, 'existing video')
    fs.writeFileSync(disabledPath, 'disabled video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    await scanFolders([library], undefined, { minImportDurationSeconds: null })

    let inspected = 0
    const service = fakeLocalNfoService({
      inspect: () => {
        inspected += 1
        return { status: 'found', code: 'NFO-001', warnings: [] }
      }
    })
    await scanFolders([library], undefined, {
      autoImportLocalNfo: false,
      localNfoService: service,
      minImportDurationSeconds: null
    })
    assert.equal(inspected, 0)

    fs.rmSync(disabledPath)
    const enabledPath = path.join(library, 'enabled-name.mp4')
    fs.writeFileSync(enabledPath, 'enabled video')
    const result = await scanFolders([library], undefined, {
      autoImportLocalNfo: true,
      localNfoService: service,
      minImportDurationSeconds: null
    })

    assert.equal(inspected, 1, 'the already registered resource must not trigger NFO I/O')
    assert.equal(result.imported, 1)
    assert.equal(listVideos({ search: 'NFO-001' }).total, 1)
    assert.equal(listVideos({ search: 'EXIST-001' }).total, 1)
    assert.equal(enabledPath.endsWith('enabled-name.mp4'), true)
  })

  it('yields between immediately resolved NFO batches so abort runs without losing committed audits or primaries', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'nfo-tail-yield')
    fs.mkdirSync(library)
    const codes = Array.from({ length: 30 }, (_, index) => `NFO-${300 + index}`)
    for (const code of codes) fs.writeFileSync(path.join(library, `${code}.mp4`), 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const controller = new AbortController()
    const applied: Array<{ videoId: number; anchors: string[] }> = []
    const audit: LibraryScanFileAuditEntry[] = []
    let observedApplied = 0
    let signalDelivered!: () => void
    const delivered = new Promise<void>(resolve => { signalDelivered = resolve })
    const result = await scanFolders([library], undefined, {
      signal: controller.signal,
      yieldEvery: 5,
      minImportDurationSeconds: null,
      autoImportLocalNfo: true,
      localNfoService: fakeLocalNfoService({
        inspect: anchor => ({ status: 'found', code: path.basename(anchor.anchorPath, '.mp4'), warnings: [] }),
        apply: (videoId, _code, anchors) => {
          applied.push({ videoId, anchors: anchors.map(anchor => anchor.anchorPath) })
          if (applied.length === 1) setImmediate(() => {
            observedApplied = applied.length
            controller.abort()
            signalDelivered()
          })
          return Promise.resolve({ disposition: 'imported', warnings: [] })
        }
      }),
      onFileResult: entry => audit.push(structuredClone(entry))
    })
    await delivered
    // All resources were committed before the NFO tail; cancellation must not lose any.
    assert.equal(result.imported, codes.length)
    assert.equal(result.scannedFiles, codes.length)
    assert.equal(audit.length, codes.length)
    assert.equal(new Set(audit.map(entry => entry.filePath)).size, codes.length)
    assert.ok(audit.every(entry => entry.outcome === 'added'))
    assert.equal(listVideos({}).total, codes.length)
    for (const entry of audit) {
      assert.equal(entry.outcome, 'added')
      if (entry.outcome !== 'added') continue
      const resources = listVideoResources(entry.videoId)
      assert.equal(resources.length, 1)
      assert.equal(resources.filter(resource => resource.is_primary).length, 1)
    }
    const committedNfoPaths = applied.flatMap(batch => batch.anchors).sort()
    assert.deepEqual(audit.filter(entry => entry.nfo?.disposition === 'imported').map(entry => entry.filePath).sort(), committedNfoPaths)
    assert.ok(observedApplied > 0 && observedApplied < codes.length,
      `setImmediate abort must run before all 30 immediate NFO applications; observed ${observedApplied}`)
    assert.equal(applied.length, observedApplied)
    assert.equal(result.cancelled, true)
  })

  it('yields while delivering final audits but drains every committed entry and reports cancellation', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'audit-tail-yield')
    fs.mkdirSync(library)
    const codes = Array.from({ length: 30 }, (_, index) => `TAIL-${400 + index}`)
    for (const code of codes) fs.writeFileSync(path.join(library, `${code}.mp4`), 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const controller = new AbortController()
    const audit: LibraryScanFileAuditEntry[] = []
    let observedDelivered = 0
    let signalDelivered!: () => void
    const delivered = new Promise<void>(resolve => { signalDelivered = resolve })
    const result = await scanFolders([library], undefined, {
      signal: controller.signal,
      yieldEvery: 5,
      minImportDurationSeconds: null,
      autoImportLocalNfo: false,
      onFileResult: entry => {
        audit.push(structuredClone(entry))
        if (audit.length === 1) setImmediate(() => {
          observedDelivered = audit.length
          controller.abort()
          signalDelivered()
        })
      }
    })
    await delivered
    assert.equal(result.imported, codes.length)
    assert.equal(result.scannedFiles, codes.length)
    assert.equal(audit.length, codes.length, 'abort must not truncate already committed audit delivery')
    assert.equal(new Set(audit.map(entry => entry.filePath)).size, codes.length)
    assert.ok(audit.every(entry => entry.outcome === 'added'))
    for (const entry of audit) {
      if (entry.outcome === 'added') assert.equal(listVideoResources(entry.videoId).filter(resource => resource.is_primary).length, 1)
    }
    assert.ok(observedDelivered > 0 && observedDelivered < codes.length,
      `setImmediate must observe partial audit delivery; observed ${observedDelivered}`)
    assert.equal(result.cancelled, true)
  })

  it('yields inside one committed NFO batch and retains imported audits for all its anchors', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'single-batch-anchor-yield')
    fs.mkdirSync(library)
    const filePaths = Array.from({ length: 30 }, (_, index) => path.join(library,
      `fragment-${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}.mp4`))
    for (const filePath of filePaths) fs.writeFileSync(filePath, 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const controller = new AbortController()
    const audit: LibraryScanFileAuditEntry[] = []
    const restore: Array<() => void> = []
    let applications = 0
    let readAnchors = 0
    let observedAnchors = 0
    let observedAudits = -1
    let firstAuditSawAbort = false
    let signalDelivered!: () => void
    const delivered = new Promise<void>(resolve => { signalDelivered = resolve })
    try {
      const result = await scanFolders([library], undefined, {
        signal: controller.signal, yieldEvery: 5, minImportDurationSeconds: null,
        autoImportLocalNfo: true,
        localNfoService: fakeLocalNfoService({
          inspect: () => ({ status: 'found', code: 'NFO-700', warnings: [] }),
          apply: (_videoId, _code, anchors) => {
            applications++
            assert.equal(anchors.length, filePaths.length)
            // Observe consumption of the actual service-provided anchors, not an imitation loop.
            for (const anchor of anchors) {
              const descriptor = Object.getOwnPropertyDescriptor(anchor, 'anchorPath')!
              const anchorPath = anchor.anchorPath
              Object.defineProperty(anchor, 'anchorPath', { configurable: true, enumerable: true,
                get: () => { readAnchors++; return anchorPath } })
              restore.push(() => Object.defineProperty(anchor, 'anchorPath', descriptor))
            }
            setImmediate(() => {
              observedAnchors = readAnchors
              observedAudits = audit.length
              controller.abort()
              signalDelivered()
            })
            return Promise.resolve({ disposition: 'imported', warnings: [] })
          }
        }),
        onFileResult: entry => {
          if (!audit.length) firstAuditSawAbort = controller.signal.aborted
          audit.push(structuredClone(entry))
        }
      })
      await delivered
      assert.equal(applications, 1)
      assert.ok(observedAnchors > 0 && observedAnchors < filePaths.length,
        `abort must run inside the anchor loop, not at batch end; observed ${observedAnchors}`)
      assert.equal(observedAudits, 0)
      assert.equal(firstAuditSawAbort, true)
      assert.equal(result.cancelled, true)
      assert.equal(result.imported, filePaths.length)
      assert.deepEqual(audit.map(entry => entry.filePath).sort(), [...filePaths].sort())
      assert.ok(audit.every(entry => entry.nfo?.disposition === 'imported'))
      const videos = listVideos({})
      assert.equal(videos.total, 1)
      const resources = listVideoResources(videos.items[0].id)
      assert.equal(resources.length, filePaths.length)
      assert.equal(resources.filter(resource => resource.is_primary).length, 1)
    } finally {
      for (const undo of restore) undo()
    }
  })

  it('yields between completed primary selections and still settles every committed resource after abort', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'primary-tail-yield')
    fs.mkdirSync(library)
    const codes = Array.from({ length: 30 }, (_, index) => `PRIM-${800 + index}`)
    for (const code of codes) fs.writeFileSync(path.join(library, `${code}.mp4`), 'video')
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    const originalPrepare = db.prepare
    const prepare = db.prepare.bind(db)
    const controller = new AbortController()
    const audit: LibraryScanFileAuditEntry[] = []
    let selected = 0
    let observedSelected = 0
    let observedAudits = -1
    let inTransactionAtYield: boolean | undefined
    let signalDelivered!: () => void
    const delivered = new Promise<void>(resolve => { signalDelivered = resolve })
    db.prepare = ((sql: string) => {
      const statement = prepare(sql)
      if (sql === 'UPDATE video_resources SET is_primary = 1 WHERE id = ? AND library_id = ?') {
        const run = statement.run.bind(statement)
        statement.run = ((...args: unknown[]) => {
          const result = run(...args)
          selected++
          if (selected === 1) setImmediate(() => {
            observedSelected = selected
            observedAudits = audit.length
            inTransactionAtYield = db.inTransaction
            controller.abort()
            signalDelivered()
          })
          return result
        }) as typeof statement.run
      }
      return statement
    }) as typeof db.prepare
    try {
      const result = await scanFolders([library], undefined, {
        signal: controller.signal, yieldEvery: 5, minImportDurationSeconds: null,
        autoImportLocalNfo: false,
        onFileResult: entry => audit.push(structuredClone(entry))
      })
      await delivered
      assert.ok(observedSelected > 0 && observedSelected < codes.length,
        `setImmediate must run before all primary selections finish; observed ${observedSelected}`)
      assert.equal(inTransactionAtYield, false, 'the per-primary transaction must commit before yielding')
      assert.equal(observedAudits, 0, 'this must be a primary-loop yield, not final audit delivery')
      assert.equal(selected, codes.length, 'abort must not abandon primary selection for committed resources')
      assert.equal(result.cancelled, true)
      assert.equal(result.imported, codes.length)
      assert.equal(audit.length, codes.length)
      assert.equal(new Set(audit.map(entry => entry.filePath)).size, codes.length)
      for (const entry of audit) {
        assert.equal(entry.outcome, 'added')
        if (entry.outcome !== 'added') continue
        const resources = listVideoResources(entry.videoId)
        assert.equal(resources.length, 1)
        assert.equal(resources.filter(resource => resource.is_primary).length, 1)
      }
    } finally {
      db.prepare = originalPrepare
    }
  })

  it('handles cancellation during the only or first NFO application and preserves committed file audits', async () => {
    for (const codes of [['NFO-201'], ['NFO-201', 'NFO-202']]) {
      const root = makeTempRoot()
      const library = path.join(root, 'library')
      fs.mkdirSync(library)
      for (const code of codes) {
        fs.writeFileSync(path.join(library, `${code}.mp4`), 'video')
      }
      initDatabaseAtPath(path.join(root, 'library.db'))
      const controller = new AbortController()
      let applied = 0
      const audit: LibraryScanFileAuditEntry[] = []
      const result = await scanFolders([library], undefined, {
        signal: controller.signal,
        autoImportLocalNfo: true,
        minImportDurationSeconds: null,
        onFileResult: entry => audit.push(entry),
        localNfoService: fakeLocalNfoService({
          inspect: anchor => ({
            status: 'found', code: path.basename(anchor.anchorPath, '.mp4'), warnings: []
          }),
          apply: async () => {
            applied++
            controller.abort()
            return { disposition: 'imported', warnings: [] }
          }
        })
      })
      assert.equal(applied, 1)
      assert.equal(result.cancelled, true)
      assert.equal(result.imported, codes.length)
      assert.equal(audit.length, codes.length)
      assert.equal(audit.filter(entry => entry.nfo?.disposition === 'imported').length, 1)
      assert.equal(listVideos({}).total, codes.length)
      closeDatabase()
    }
  })

  it('aggregates first-discovery NFO candidates once per video after all resources are assigned', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    fs.writeFileSync(path.join(library, 'part-one.mp4'), 'first')
    fs.writeFileSync(path.join(library, 'part-two.mp4'), 'second')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const applied: Array<{ videoId: number; code: string; anchors: string[] }> = []
    const service = fakeLocalNfoService({
      inspect: () => ({ status: 'found', code: 'NFO-200', warnings: [] }),
      apply: async (videoId, code, anchors) => {
        applied.push({ videoId, code, anchors: anchors.map((anchor) => anchor.anchorPath) })
        return { disposition: 'imported', warnings: [] }
      }
    })
    const audit: LibraryScanFileAuditEntry[] = []
    const result = await scanFolders([library], undefined, {
      autoImportLocalNfo: true,
      localNfoService: service,
      minImportDurationSeconds: null,
      onFileResult: (entry) => audit.push(structuredClone(entry))
    })

    assert.equal(result.imported, 2)
    assert.equal(listVideos({ search: 'NFO-200' }).total, 1)
    assert.equal(applied.length, 1)
    assert.equal(applied[0]?.code, 'NFO-200')
    assert.equal(applied[0]?.anchors.length, 2)
    assert.equal(audit.length, 2)
    assert.equal(audit.every((entry) => entry.nfo?.disposition === 'imported'), true)
  })

  it('does not count an existing pending resource identity as a new same-code file', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const conflictedPath = path.join(library, 'SAME-001-CD1.mp4')
    fs.writeFileSync(conflictedPath, 'first video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const service = fakeLocalNfoService({
      inspect: (candidate) =>
        candidate.anchorPath === conflictedPath
          ? { status: 'found', code: 'OTHER-999', warnings: [] }
          : { status: 'missing', code: null, warnings: [] }
    })

    await scanFolders([library], undefined, {
      autoImportLocalNfo: true,
      autoMergeSameCodeResources: false,
      localNfoService: service,
      minImportDurationSeconds: null
    })
    fs.writeFileSync(path.join(library, 'SAME-001-CD2.mp4'), 'second video')
    const second = await scanFolders([library], undefined, {
      autoImportLocalNfo: true,
      autoMergeSameCodeResources: false,
      localNfoService: service,
      minImportDurationSeconds: null
    })

    assert.equal(second.imported, 1)
    assert.equal(second.pendingGroups, 0)
    assert.equal(listVideos({ search: 'SAME-001' }).total, 1)
    assert.equal(listPendingResourceIdentities(TEST_LIBRARY_ID).length, 1)
  })

  it('keeps distinct local NFO candidates in the existing confirmation workflow', async () => {
    const root = makeTempRoot()
    initDatabaseAtPath(path.join(root, 'library.db'))
    const libraryRoot = path.join(root, 'multi-nfo-library')
    fs.mkdirSync(libraryRoot)
    const library = createMediaLibrary({ name: 'Multi NFO', roots: [{ path: libraryRoot }] })
    for (const [part, title] of [
      ['CD1', 'Candidate one'],
      ['CD2', 'Candidate two']
    ]) {
      fs.writeFileSync(path.join(libraryRoot, `MULTI-001-${part}.mp4`), `video-${part}`)
      fs.writeFileSync(
        path.join(libraryRoot, `MULTI-001-${part}.nfo`),
        `<movie><num>MULTI-001</num><title>${title}</title></movie>`
      )
    }
    const audit: LibraryScanFileAuditEntry[] = []

    const result = await scanFoldersScoped(
      { libraryId: library.id, runId: 'multi-nfo', roots: library.roots },
      undefined,
      {
        autoImportLocalNfo: true,
        autoMergeSameCodeResources: true,
        minImportDurationSeconds: null,
        readDurationSeconds: async () => 3600,
        onFileResult: (entry) => audit.push(entry)
      }
    )

    assert.equal(result.imported, 2)
    const video = listVideos({ search: 'MULTI-001' }).items[0]
    assert.ok(video)
    assert.equal(video.title, null)
    assert.equal(listVideoResourcesScoped(library.id, video.id).length, 2)
    assert.deepEqual(
      getDb()
        .prepare(
          `SELECT json_extract(result_json, '$.title') AS title
             FROM pending_video_scrape_candidates
            ORDER BY position`
        )
        .all(),
      [{ title: 'Candidate one' }, { title: 'Candidate two' }]
    )
    assert.equal(audit.every((entry) => entry.nfo?.disposition === 'pending-candidate'), true)
  })

  it('persists a filename/NFO identity conflict without creating formal library records', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const filePath = path.join(library, 'FILE-001.mp4')
    fs.writeFileSync(filePath, 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const audit: LibraryScanFileAuditEntry[] = []

    const result = await scanFolders([library], undefined, {
      autoImportLocalNfo: true,
      localNfoService: fakeLocalNfoService({
        inspect: () => ({ status: 'found', code: 'NFO-999', warnings: [] })
      }),
      minImportDurationSeconds: null,
      onFileResult: (entry) => audit.push(entry)
    })

    assert.equal(result.imported, 0)
    assert.equal(result.pendingResources, 1)
    assert.equal(listVideos({}).total, 0)
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS count FROM video_resources').get() as { count: number })
        .count,
      0
    )
    assert.deepEqual(
      listPendingResourceIdentities(TEST_LIBRARY_ID).map((identity) => ({
        displayName: identity.displayName,
        filenameCode: identity.filenameCode,
        nfoCode: identity.nfoCode
      })),
      [{ displayName: path.basename(filePath), filenameCode: 'FILE-001', nfoCode: 'NFO-999' }]
    )
    assert.equal(audit[0]?.outcome, 'pending')
    assert.equal(audit[0]?.nfo?.disposition, 'identity-conflict')
  })

  it('persists only a masked STRM target projection for an NFO identity conflict', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const filePath = path.join(library, 'FILE-001.strm')
    fs.writeFileSync(filePath, 'https://example.test/video.mp4?token=secret')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const result = await scanFolders([library], undefined, {
      autoImportLocalNfo: true,
      localNfoService: fakeLocalNfoService({
        inspect: () => ({ status: 'found', code: 'NFO-999', warnings: [] })
      }),
      minImportDurationSeconds: null
    })
    const [visible] = listPendingResourceIdentities(TEST_LIBRARY_ID)

    assert.equal(result.pendingResources, 1)
    assert.equal(listVideos({}).total, 0)
    assert.equal(visible.sourceKind, 'strm')
    assert.match(visible.targetDisplay ?? '', /example\.test/u)
    assert.equal(JSON.stringify(visible).includes('token=secret'), false)
    assert.equal(JSON.stringify(visible).includes(filePath), false)
  })

  it('keeps a valid filename import when its NFO is invalid and records only a secondary warning', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    fs.writeFileSync(path.join(library, 'SAFE-001.mp4'), 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const audit: LibraryScanFileAuditEntry[] = []

    const result = await scanFolders([library], undefined, {
      autoImportLocalNfo: true,
      localNfoService: fakeLocalNfoService({
        inspect: () => ({ status: 'warning', code: null, warnings: ['NFO XML 不安全，已忽略'] })
      }),
      minImportDurationSeconds: null,
      onFileResult: (entry) => audit.push(entry)
    })

    assert.equal(result.imported, 1)
    assert.equal(result.failed, 0)
    assert.equal(listVideos({ search: 'SAFE-001' }).total, 1)
    assert.equal(audit[0]?.outcome, 'added')
    assert.equal(audit[0]?.nfo?.disposition, 'warning')
    assert.deepEqual(audit[0]?.nfo?.warnings?.map((warning) => warning.code), ['nfo-warning'])
  })

  it('uses NFO identity across libraries but never overwrites a globally scraped-success video', async () => {
    const root = makeTempRoot()
    initDatabaseAtPath(path.join(root, 'library.db'))
    const firstRoot = path.join(root, 'first-library')
    const secondRoot = path.join(root, 'second-library')
    fs.mkdirSync(firstRoot)
    fs.mkdirSync(secondRoot)
    const firstLibrary = createMediaLibrary({ name: 'First', roots: [{ path: firstRoot }] })
    const secondLibrary = createMediaLibrary({ name: 'Second', roots: [{ path: secondRoot }] })
    const firstPath = path.join(firstRoot, 'GLOBAL-001.mp4')
    fs.writeFileSync(firstPath, 'first video')
    const { videoId } = insertTestVideoWithFileBase(getDb(), {
      code: 'GLOBAL-001',
      title: 'Preserved global title',
      filePath: firstPath,
      libraryId: firstLibrary.id,
      rootId: firstLibrary.roots[0].id,
      scrapedStatus: 1
    })
    const secondPath = path.join(secondRoot, 'unknown-name.mp4')
    fs.writeFileSync(secondPath, 'second video')
    fs.writeFileSync(
      path.join(secondRoot, 'unknown-name.nfo'),
      '<movie><num>GLOBAL-001</num><title>Must not overwrite</title></movie>'
    )
    const audit: LibraryScanFileAuditEntry[] = []

    const result = await scanFoldersScoped(
      {
        libraryId: secondLibrary.id,
        runId: 'global-status-one',
        roots: secondLibrary.roots
      },
      undefined,
      {
        autoImportLocalNfo: true,
        autoMergeSameCodeResources: true,
        minImportDurationSeconds: null,
        readDurationSeconds: async () => 3600,
        onFileResult: (entry) => audit.push(entry)
      }
    )

    assert.equal(result.imported, 1)
    assert.deepEqual(
      getDb().prepare('SELECT title, scraped_status FROM videos WHERE id = ?').get(videoId),
      { title: 'Preserved global title', scraped_status: 1 }
    )
    assert.equal(listVideoResourcesScoped(secondLibrary.id, videoId).length, 1)
    assert.equal(audit[0]?.nfo?.disposition, 'skipped')
  })

  it('applies local NFO with fill-empty semantics for new and failed videos', async () => {
    const root = makeTempRoot()
    initDatabaseAtPath(path.join(root, 'library.db'))
    const libraryRoot = path.join(root, 'nfo-status-library')
    fs.mkdirSync(libraryRoot)
    const library = createMediaLibrary({ name: 'NFO status', roots: [{ path: libraryRoot }] })
    const newPath = path.join(libraryRoot, 'ZERO-001.mp4')
    const failedPath = path.join(libraryRoot, 'FAIL-002.mp4')
    fs.writeFileSync(newPath, 'new video')
    fs.writeFileSync(failedPath, 'failed video')
    fs.writeFileSync(
      path.join(libraryRoot, 'ZERO-001.nfo'),
      '<movie><num>ZERO-001</num><title>New NFO title</title></movie>'
    )
    fs.writeFileSync(
      path.join(libraryRoot, 'FAIL-002.nfo'),
      '<movie><num>FAIL-002</num><title>Overwrite attempt</title><plot>Filled summary</plot></movie>'
    )
    const failedVideoId = Number(
      getDb()
        .prepare(
          `INSERT INTO videos (code, title, summary, scraped_status)
           VALUES ('FAIL-002', 'Keep manual title', NULL, 2)`
        )
        .run().lastInsertRowid
    )

    const result = await scanFoldersScoped(
      { libraryId: library.id, runId: 'status-zero-two', roots: library.roots },
      undefined,
      {
        autoImportLocalNfo: true,
        autoMergeSameCodeResources: true,
        minImportDurationSeconds: null,
        readDurationSeconds: async () => 3600
      }
    )

    assert.equal(result.imported, 2)
    assert.deepEqual(
      getDb()
        .prepare(
          `SELECT code, title, summary, scraped_status
             FROM videos WHERE code IN ('ZERO-001', 'FAIL-002') ORDER BY code`
        )
        .all(),
      [
        {
          code: 'FAIL-002',
          title: 'Keep manual title',
          summary: 'Filled summary',
          scraped_status: 1
        },
        { code: 'ZERO-001', title: 'New NFO title', summary: null, scraped_status: 1 }
      ]
    )
    assert.equal(listVideoResourcesScoped(library.id, failedVideoId).length, 1)
  })

  it('reattaches a scanned file to an existing no-resource video without replacing metadata', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const filePath = path.join(library, 'KEEP-001.mp4')
    fs.writeFileSync(filePath, 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    getDb()
      .prepare(
        `INSERT INTO videos (code, title, scraped_status, add_time)
         VALUES ('KEEP-001', 'Preserved metadata', 1, '2026-01-01')`
      )
      .run()

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3661,
      minImportDurationSeconds: null
    })
    const [video] = listVideos({ search: 'KEEP-001' }).items

    assert.equal(result.imported, 1)
    assert.equal(video.title, 'Preserved metadata')
    assert.equal(video.scraped_status, 1)
    const [resource] = listLocalVideoResources(video.id)
    assert.equal(resource?.locator, filePath)
    assert.equal(resource?.is_primary, 1)
  })

  it('yields while scanning large batches', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    for (let i = 1; i <= 30; i++) {
      fs.writeFileSync(path.join(library, `IPX-${String(i).padStart(3, '0')}.mp4`), 'video')
    }
    initDatabaseAtPath(path.join(root, 'library.db'))

    let scanDone = false
    const scanPromise = scanFolders([library], undefined, { yieldEvery: 1 }).then((result) => {
      scanDone = true
      return result
    })

    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(scanDone, false)

    const result = await scanPromise
    assert.equal(result.imported, 30)
  })

  it('collects a very large root without overflowing call arguments before cancellation', async () => {
    for (const size of [300_382, 600_764]) {
      const root = makeTempRoot()
      const library = path.join(root, 'library')
      fs.mkdirSync(library)
      initDatabaseAtPath(path.join(root, 'library.db'))
      const controller = new AbortController()
      const result = await scanFolders([library], undefined, {
        signal: controller.signal,
        readDirectory: async () => {
          // Abort on the last entry, after the whole root has been accumulated.
          return Array.from({ length: size }, (_, index) => ({
            name: `TEST-${index}.mp4`,
            isFile: () => {
              if (index === size - 1) controller.abort()
              return true
            },
            isDirectory: () => false
          }) as fs.Dirent)
        }
      })
      assert.equal(result.cancelled, true)
      assert.equal(result.imported, 0)
      closeDatabase()
    }
  })

  it('stops when cancelled', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    for (let i = 1; i <= 30; i++) {
      fs.writeFileSync(path.join(library, `MUKD-${String(i).padStart(3, '0')}.mp4`), 'video')
    }
    initDatabaseAtPath(path.join(root, 'library.db'))

    const controller = new AbortController()
    const result = await scanFolders(
      [library],
      (progress) => {
        if (progress.scanned === 5) controller.abort()
      },
      { signal: controller.signal, yieldEvery: 1 }
    )

    assert.equal(result.cancelled, true)
    assert.equal(result.scannedFiles < 30, true)
  })

  it('skips new imports shorter than 30 minutes', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    fs.writeFileSync(path.join(library, 'IPX-100.mp4'), 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 10 * 60,
      minImportDurationSeconds: 30 * 60
    })

    assert.equal(result.imported, 0)
    assert.equal(result.skippedShort, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.unrecognizedFiles.length, 0)
    assert.equal(listVideos({ limit: 10, offset: 0 }).total, 0)
  })

  it('skips short files before unrecognized handling', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    fs.writeFileSync(path.join(library, '1f1hurx.mp4'), 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))

    const result = await scanFolders([library], undefined, {
      readDurationSeconds: async () => 114,
      minImportDurationSeconds: 30 * 60
    })

    assert.equal(result.imported, 0)
    assert.equal(result.skippedShort, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.unrecognizedFiles.length, 0)
  })

  it('stores probed duration on import', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const filePath = path.join(library, 'IPX-535.mp4')
    fs.writeFileSync(filePath, 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))

    await scanFolders([library], undefined, {
      readDurationSeconds: async () => 3661,
      minImportDurationSeconds: null
    })

    const row = getDb()
      .prepare("SELECT duration_seconds AS file_duration_seconds FROM video_resources WHERE kind = 'local' AND locator = ?")
      .get(filePath) as { file_duration_seconds: number | null }
    assert.equal(row.file_duration_seconds, 3661)
  })

  it('refreshes duration when the file changes on rescan', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const filePath = path.join(library, 'IPX-535.mp4')
    fs.writeFileSync(filePath, 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))

    let duration = 1000
    const scanOptions = {
      readDurationSeconds: async () => duration,
      minImportDurationSeconds: null
    }

    await scanFolders([library], undefined, { ...scanOptions, yieldEvery: 1 })
    fs.writeFileSync(filePath, 'updated video content')
    duration = 2000
    const result = await scanFolders([library], undefined, { ...scanOptions, yieldEvery: 1 })

    assert.equal(result.imported, 0)
    assert.equal(result.skipped, 0)
    assert.equal(result.refreshed, 1)
    const row = getDb()
      .prepare("SELECT duration_seconds AS file_duration_seconds FROM video_resources WHERE kind = 'local' AND locator = ?")
      .get(filePath) as { file_duration_seconds: number | null }
    assert.equal(row.file_duration_seconds, 2000)
  })

  it('skips duration probe on rescan when file is unchanged', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    const filePath = path.join(library, 'IPX-535.mp4')
    fs.writeFileSync(filePath, 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))

    let probeCount = 0
    const scanOptions = {
      readDurationSeconds: async () => {
        probeCount += 1
        return 3661
      },
      minImportDurationSeconds: null,
      yieldEvery: 1
    }

    await scanFolders([library], undefined, scanOptions)
    const afterFirst = probeCount
    await scanFolders([library], undefined, scanOptions)

    assert.equal(probeCount, afterFirst)
    const row = getDb()
      .prepare(
        "SELECT duration_seconds AS file_duration_seconds, file_mtime_ms FROM video_resources WHERE kind = 'local' AND locator = ?"
      )
      .get(filePath) as { file_duration_seconds: number | null; file_mtime_ms: number | null }
    assert.equal(row.file_duration_seconds, 3661)
    assert.notEqual(row.file_mtime_ms, null)
  })

  it('emits one final audit outcome for every processed file', async () => {
    const root = makeTempRoot()
    const library = path.join(root, 'library')
    fs.mkdirSync(library, { recursive: true })
    fs.writeFileSync(path.join(library, 'AUDIT-001.mp4'), 'video')
    fs.writeFileSync(path.join(library, 'unknown-name.mp4'), 'video')
    initDatabaseAtPath(path.join(root, 'library.db'))
    const entries: LibraryScanFileAuditEntry[] = []

    const result = await scanFolders([library], undefined, {
      minImportDurationSeconds: null,
      readDurationSeconds: async () => 3600,
      onFileResult: (entry) => entries.push(entry)
    })

    assert.equal(entries.length, result.scannedFiles)
    assert.deepEqual(entries.map((entry) => entry.outcome).sort(), ['added', 'unrecognized'])
    assert.equal(entries.filter((entry) => entry.outcome === 'added').length, result.imported)
    assert.equal(entries.filter((entry) => entry.outcome === 'unrecognized').length, result.failed)
  })
})
