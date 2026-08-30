import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeLocalPathIdentity } from '@shared/localPathIdentity'
import { DEFAULT_MEDIA_LIBRARY_ID, type MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { ensureVideoMembership } from './libraryMembershipRepo'
import {
  confirmLibraryPathRemoval,
  previewLibraryPathRemoval
} from '../services/libraryPathCleanupService'
import {
  MediaLibraryRepoError,
  addMediaLibraryRoot,
  archiveMediaLibrary,
  bindOnlineMediaLibraryRootIdentities,
  createMediaLibrary,
  deleteMediaLibrary,
  deleteMediaLibraryRoot,
  getMediaLibrary,
  getMediaLibraryDetail,
  listMediaLibraryAutomaticScanStates,
  listMediaLibraries,
  previewMediaLibraryDeletion,
  readMediaLibraryScanSnapshot,
  restoreMediaLibrary,
  updateMediaLibrary,
  updateMediaLibraryConfig,
  updateMediaLibraryRoot
} from './mediaLibraryRepo'
import {
  getLocalVideoResourceByLocator,
  getStrmVideoResourceBySourcePath,
  insertNewScannedStrmVideo,
  insertScannedVideo,
  localVideoResourceExistsByLocator
} from './videoRepo'
import { createVideoLifecycleRepo } from './videoLifecycleRepo'

let tempRoot: string | null = null

function setupDb(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-media-library-repo-'))
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  return tempRoot
}

function makeDirectory(...parts: string[]): string {
  if (!tempRoot) throw new Error('test database is not initialized')
  const directory = path.join(tempRoot, ...parts)
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

function hasCode(code: MediaLibraryRepoError['code']): (error: unknown) => boolean {
  return (error) => error instanceof MediaLibraryRepoError && error.code === code
}

type ContinuityOwnedDataKind = 'resource' | 'pending' | 'unrecognized'

function seedContinuityOwnedData(input: {
  libraryId: number
  root: MediaLibraryRoot
  kind: ContinuityOwnedDataKind
  key: string
}): void {
  const database = getDb()
  const filePath = path.join(input.root.path, `${input.key}.mp4`)
  fs.writeFileSync(filePath, input.key)
  if (input.kind === 'resource') {
    assert.ok(
      insertScannedVideo({
        libraryId: input.libraryId,
        rootId: input.root.id,
        code: input.key,
        locator: filePath,
        size_bytes: input.key.length
      })
    )
    return
  }

  if (input.kind === 'pending') {
    const groupId = Number(
      database
        .prepare(
          `INSERT INTO pending_scan_groups (library_id, normalized_code)
           VALUES (?, ?)`
        )
        .run(input.libraryId, input.key).lastInsertRowid
    )
    database
      .prepare(
        `INSERT INTO pending_scan_resources (
           library_id, group_id, root_id, file_path, normalized_path, source_kind
         ) VALUES (?, ?, ?, ?, ?, 'local')`
      )
      .run(
        input.libraryId,
        groupId,
        input.root.id,
        filePath,
        normalizeLocalPathIdentity(filePath)
      )
    return
  }

  const scanRunId = `continuity-${input.libraryId}-${input.root.id}-${input.key}`
  database
    .prepare(
      `INSERT INTO library_scan_runs (
         id, library_id, config_revision, trigger, status, started_at, finished_at
       ) VALUES (?, ?, 1, 'manual', 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    .run(scanRunId, input.libraryId)
  database
    .prepare(
      `INSERT INTO library_unrecognized_files (
         library_id, root_id, file_path, normalized_path, reason, scan_run_id, last_seen_at
       ) VALUES (?, ?, ?, ?, 'unsupported_extension', ?, CURRENT_TIMESTAMP)`
    )
    .run(
      input.libraryId,
      input.root.id,
      filePath,
      normalizeLocalPathIdentity(filePath),
      scanRunId
    )
}

function moveRootAside(rootPath: string, key: string, replace: boolean): void {
  fs.renameSync(rootPath, `${rootPath}-original-${key}`)
  if (replace) fs.mkdirSync(rootPath, { recursive: true })
}

afterEach(() => {
  closeDatabase()
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('mediaLibraryRepo', () => {
  it('creates a library, typed config, and canonical root projection atomically', () => {
    setupDb()
    const mediaRoot = makeDirectory('media')

    const detail = createMediaLibrary({
      name: '  Archive  ',
      icon: 'film',
      color: 'violet',
      config: {
        autoScanEnabled: true,
        autoScanIntervalMinutes: 60,
        minImportDurationMinutes: 12,
        autoMergeSameCodeResources: true,
        defaultVideoScraper: '  JavDB  ',
        defaultSortBy: 'rating',
        defaultSortDir: 'asc',
        includeInHomeDiscovery: false
      },
      roots: [{ path: `${mediaRoot}${path.sep}`, state: 'active' }]
    })

    assert.equal(detail.name, 'Archive')
    assert.equal(detail.icon, 'film')
    assert.equal(detail.color, 'violet')
    assert.equal(detail.position, 1)
    assert.equal(detail.revision, 1)
    assert.equal(detail.config.libraryId, detail.id)
    assert.equal(detail.config.revision, 1)
    assert.equal(detail.config.autoScanEnabled, true)
    assert.equal(detail.config.defaultVideoScraper, 'JavDB')
    assert.equal(detail.config.defaultSortBy, 'rating')
    assert.equal(detail.config.defaultSortDir, 'asc')
    assert.equal(detail.config.includeInHomeDiscovery, false)
    assert.equal(detail.rootCount, 1)
    assert.equal(detail.activeRootCount, 1)
    assert.equal(detail.roots[0].path, path.normalize(mediaRoot))
    assert.equal(detail.roots[0].normalizedPath, normalizeLocalPathIdentity(mediaRoot))
    assert.equal(
      detail.roots[0].normalizedRealPath,
      normalizeLocalPathIdentity(fs.realpathSync.native(mediaRoot))
    )
    assert.ok(detail.roots[0].deviceId)
    assert.ok(detail.roots[0].inode)

    const listed = listMediaLibraries()
    assert.deepEqual(
      listed.map((library) => [library.id, library.name]),
      [
        [DEFAULT_MEDIA_LIBRARY_ID, '默认媒体库'],
        [detail.id, 'Archive']
      ]
    )
    assert.equal(listed.find((library) => library.id === detail.id)?.pendingScanGroupCount, 0)
  })

  it('projects pending scan counts once per library without multiplying across roots', () => {
    setupDb()
    const library = createMediaLibrary({
      name: 'Pending projection',
      roots: [
        { path: makeDirectory('pending-a') },
        { path: makeDirectory('pending-b') }
      ]
    })
    const insert = getDb().prepare(
      `INSERT INTO pending_scan_groups (
         library_id, normalized_code, revision, created_at, updated_at
       ) VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    )
    insert.run(library.id, 'PENDING-A')
    insert.run(library.id, 'PENDING-B')
    insert.run(DEFAULT_MEDIA_LIBRARY_ID, 'PENDING-DEFAULT')

    const byId = new Map(listMediaLibraries().map((item) => [item.id, item]))
    assert.equal(byId.get(library.id)?.rootCount, 2)
    assert.equal(byId.get(library.id)?.pendingScanGroupCount, 2)
    assert.equal(byId.get(DEFAULT_MEDIA_LIBRARY_ID)?.pendingScanGroupCount, 1)
    assert.equal(getMediaLibraryDetail(library.id)?.pendingScanGroupCount, 2)
  })

  it('keeps library and config revisions independent and rejects stale writes', () => {
    setupDb()
    const created = createMediaLibrary({ name: 'Library' })
    assert.equal(created.config.minImportDurationMinutes, 30)
    assert.equal(created.config.autoMergeSameCodeResources, true)

    const config = updateMediaLibraryConfig({
      libraryId: created.id,
      expectedRevision: created.config.revision,
      patch: { autoScanEnabled: true, defaultSortBy: 'code' }
    })
    assert.equal(config.revision, 2)
    assert.equal(config.autoScanEnabled, true)
    assert.equal(config.defaultSortBy, 'code')
    assert.equal(getMediaLibrary(created.id)?.revision, 1)

    assert.throws(
      () =>
        updateMediaLibraryConfig({
          libraryId: created.id,
          expectedRevision: 1,
          patch: { defaultSortDir: 'asc' }
        }),
      hasCode('REVISION_CONFLICT')
    )

    const renamed = updateMediaLibrary({
      libraryId: created.id,
      expectedRevision: created.revision,
      patch: { name: '  Renamed  ', position: 8 }
    })
    assert.equal(renamed.name, 'Renamed')
    assert.equal(renamed.position, 8)
    assert.equal(renamed.revision, 2)
    assert.equal(renamed.config.revision, 2)

    assert.throws(
      () =>
        updateMediaLibrary({
          libraryId: created.id,
          expectedRevision: 1,
          patch: { color: 'amber' }
        }),
      hasCode('REVISION_CONFLICT')
    )
  })

  it('rejects same, parent, child, and realpath-alias roots across active libraries', () => {
    setupDb()
    const parent = makeDirectory('tree')
    const child = makeDirectory('tree', 'child')
    const alias = path.join(tempRoot!, 'tree-alias')
    fs.symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir')

    const first = createMediaLibrary({ name: 'First', roots: [{ path: parent }] })
    const second = createMediaLibrary({ name: 'Second' })

    for (const conflictPath of [parent, child, alias]) {
      assert.throws(
        () =>
          addMediaLibraryRoot({
            libraryId: second.id,
            expectedRevision: second.revision,
            root: { path: conflictPath }
          }),
        hasCode('ROOT_OVERLAP')
      )
    }
    assert.equal(getMediaLibrary(second.id)?.revision, second.revision)
    assert.equal(getMediaLibraryDetail(first.id)?.activeRootCount, 1)
  })

  it('lets disabled roots release paths and revalidates them before enabling', () => {
    setupDb()
    const sharedRoot = makeDirectory('shared')
    const first = createMediaLibrary({
      name: 'First',
      roots: [{ path: sharedRoot, state: 'disabled' }]
    })
    const second = createMediaLibrary({
      name: 'Second',
      roots: [{ path: sharedRoot, state: 'active' }]
    })

    assert.throws(
      () =>
        updateMediaLibraryRoot({
          libraryId: first.id,
          rootId: first.roots[0].id,
          expectedRevision: first.revision,
          patch: { state: 'active' }
        }),
      hasCode('ROOT_OVERLAP')
    )
    assert.equal(getMediaLibrary(first.id)?.revision, 1)

    const disabled = updateMediaLibraryRoot({
      libraryId: second.id,
      rootId: second.roots[0].id,
      expectedRevision: second.revision,
      patch: { state: 'disabled' }
    })
    assert.equal(disabled.state, 'disabled')

    const enabled = updateMediaLibraryRoot({
      libraryId: first.id,
      rootId: first.roots[0].id,
      expectedRevision: first.revision,
      patch: { state: 'active' }
    })
    assert.equal(enabled.state, 'active')
    assert.equal(getMediaLibrary(first.id)?.revision, 2)
  })

  it('preserves continuity-owned root identities while allowing empty roots to rebind', () => {
    setupDb()
    const library = createMediaLibrary({
      name: 'Continuity',
      roots: [
        { path: makeDirectory('continuity-resource-replaced') },
        { path: makeDirectory('continuity-resource-offline') },
        { path: makeDirectory('continuity-pending') },
        { path: makeDirectory('continuity-unrecognized') },
        { path: makeDirectory('continuity-empty') }
      ]
    })
    const [replacedResource, offlineResource, pending, unrecognized, empty] = library.roots
    seedContinuityOwnedData({
      libraryId: library.id,
      root: replacedResource,
      kind: 'resource',
      key: 'CONTINUITY-RESOURCE-REPLACED'
    })
    seedContinuityOwnedData({
      libraryId: library.id,
      root: offlineResource,
      kind: 'resource',
      key: 'CONTINUITY-RESOURCE-OFFLINE'
    })
    seedContinuityOwnedData({
      libraryId: library.id,
      root: pending,
      kind: 'pending',
      key: 'CONTINUITY-PENDING'
    })
    seedContinuityOwnedData({
      libraryId: library.id,
      root: unrecognized,
      kind: 'unrecognized',
      key: 'CONTINUITY-UNRECOGNIZED'
    })

    let revision = library.revision
    for (const root of library.roots) {
      updateMediaLibraryRoot({
        libraryId: library.id,
        rootId: root.id,
        expectedRevision: revision,
        patch: { state: 'disabled' }
      })
      revision += 1
    }
    const storedRoots = new Map(
      getMediaLibraryDetail(library.id)?.roots.map((root) => [root.id, root]) ?? []
    )

    moveRootAside(replacedResource.path, 'resource-replaced', true)
    moveRootAside(offlineResource.path, 'resource-offline', false)
    moveRootAside(pending.path, 'pending', true)
    moveRootAside(unrecognized.path, 'unrecognized', true)
    moveRootAside(empty.path, 'empty', true)

    for (const root of [replacedResource, offlineResource, pending, unrecognized]) {
      assert.throws(
        () =>
          updateMediaLibraryRoot({
            libraryId: library.id,
            rootId: root.id,
            expectedRevision: revision,
            patch: { state: 'active' }
          }),
        hasCode('VALIDATION_FAILED'),
        root.path
      )
      const unchanged = getMediaLibraryDetail(library.id)?.roots.find(
        (candidate) => candidate.id === root.id
      )
      const stored = storedRoots.get(root.id)
      assert.equal(unchanged?.state, 'disabled')
      assert.equal(unchanged?.normalizedRealPath, stored?.normalizedRealPath)
      assert.equal(unchanged?.deviceId, stored?.deviceId)
      assert.equal(unchanged?.inode, stored?.inode)
    }
    assert.equal(getMediaLibrary(library.id)?.revision, revision)

    const rebound = updateMediaLibraryRoot({
      libraryId: library.id,
      rootId: empty.id,
      expectedRevision: revision,
      patch: { state: 'active' }
    })
    const previousEmpty = storedRoots.get(empty.id)
    assert.equal(rebound.state, 'active')
    assert.notEqual(rebound.inode, previousEmpty?.inode)
    assert.equal(getMediaLibrary(library.id)?.revision, revision + 1)
  })

  it('rejects archived-library restore when any continuity-owned root changed identity', () => {
    setupDb()

    for (const kind of ['resource', 'pending', 'unrecognized'] as const) {
      const rootPath = makeDirectory(`archived-continuity-${kind}`)
      const library = createMediaLibrary({
        name: `Archived ${kind}`,
        roots: [{ path: rootPath }]
      })
      const root = library.roots[0]
      seedContinuityOwnedData({
        libraryId: library.id,
        root,
        kind,
        key: `ARCHIVED-${kind.toUpperCase()}`
      })
      const archived = archiveMediaLibrary({
        libraryId: library.id,
        expectedRevision: library.revision
      })
      const stored = archived.roots[0]
      // Exercise both unavailable roots and same-path replacements while restoring.
      moveRootAside(rootPath, `archived-${kind}`, kind !== 'resource')

      assert.throws(
        () =>
          restoreMediaLibrary({
            libraryId: library.id,
            expectedRevision: archived.revision
          }),
        hasCode('VALIDATION_FAILED'),
        kind
      )
      const unchanged = getMediaLibraryDetail(library.id)
      assert.equal(unchanged?.status, 'archived')
      assert.equal(unchanged?.revision, archived.revision)
      assert.equal(unchanged?.roots[0].state, 'archived')
      assert.equal(unchanged?.roots[0].normalizedRealPath, stored.normalizedRealPath)
      assert.equal(unchanged?.roots[0].deviceId, stored.deviceId)
      assert.equal(unchanged?.roots[0].inode, stored.inode)
    }

    const emptyPath = makeDirectory('archived-continuity-empty')
    const emptyLibrary = createMediaLibrary({
      name: 'Archived empty',
      roots: [{ path: emptyPath }]
    })
    const archivedEmpty = archiveMediaLibrary({
      libraryId: emptyLibrary.id,
      expectedRevision: emptyLibrary.revision
    })
    const previousIdentity = archivedEmpty.roots[0]
    moveRootAside(emptyPath, 'archived-empty', true)

    const restoredEmpty = restoreMediaLibrary({
      libraryId: emptyLibrary.id,
      expectedRevision: archivedEmpty.revision
    })
    assert.equal(restoredEmpty.status, 'active')
    assert.equal(restoredEmpty.roots[0].state, 'active')
    assert.notEqual(restoredEmpty.roots[0].inode, previousIdentity.inode)
  })

  it('rejects ordinary edits while a root is pending removal or archived', () => {
    setupDb()
    const library = createMediaLibrary({
      name: 'Protected root states',
      roots: [
        { path: makeDirectory('protected-pending') },
        { path: makeDirectory('protected-archived') }
      ]
    })
    const [pendingRoot, archivedRoot] = library.roots
    getDb()
      .prepare("UPDATE media_library_roots SET state = 'pending_removal' WHERE id = ?")
      .run(pendingRoot.id)
    getDb()
      .prepare("UPDATE media_library_roots SET state = 'archived' WHERE id = ?")
      .run(archivedRoot.id)

    const ordinaryRoot = addMediaLibraryRoot({
      libraryId: library.id,
      expectedRevision: library.revision,
      root: { path: makeDirectory('protected-ordinary') }
    })

    assert.throws(
      () =>
        updateMediaLibraryRoot({
          libraryId: library.id,
          rootId: pendingRoot.id,
          expectedRevision: library.revision + 1,
          patch: { position: 10 }
        }),
      hasCode('LIBRARY_BUSY')
    )
    assert.throws(
      () =>
        updateMediaLibraryRoot({
          libraryId: library.id,
          rootId: archivedRoot.id,
          expectedRevision: library.revision + 1,
          patch: { path: makeDirectory('archived-replacement') }
        }),
      hasCode('LIBRARY_ARCHIVED')
    )
    assert.throws(
      () =>
        updateMediaLibraryRoot({
          libraryId: library.id,
          rootId: ordinaryRoot.id,
          expectedRevision: library.revision + 1,
          patch: { state: 'pending_removal' }
        }),
      hasCode('VALIDATION_FAILED')
    )
    assert.equal(getMediaLibrary(library.id)?.revision, library.revision + 1)
  })

  it('requires explicit migration or cleanup before changing a root-owned path', () => {
    setupDb()
    const library = createMediaLibrary({
      name: 'Owned paths',
      roots: [
        { path: makeDirectory('owned-resource') },
        { path: makeDirectory('owned-pending') },
        { path: makeDirectory('owned-unrecognized') },
        { path: makeDirectory('owned-cleanup-history') },
        { path: makeDirectory('unowned') }
      ]
    })
    const [resourceRoot, pendingRoot, unrecognizedRoot, cleanupRoot, unownedRoot] =
      library.roots
    const resourcePath = path.join(resourceRoot.path, 'OWNED-001.mp4')
    fs.writeFileSync(resourcePath, 'owned')
    assert.ok(
      insertScannedVideo({
        libraryId: library.id,
        rootId: resourceRoot.id,
        code: 'OWNED-001',
        locator: resourcePath,
        size_bytes: 5
      })
    )

    const database = getDb()
    const groupId = Number(
      database
        .prepare(
          `INSERT INTO pending_scan_groups (library_id, normalized_code)
           VALUES (?, 'OWNED-PENDING')`
        )
        .run(library.id).lastInsertRowid
    )
    database
      .prepare(
        `INSERT INTO pending_scan_resources (
           library_id, group_id, root_id, file_path, normalized_path, source_kind
         ) VALUES (?, ?, ?, ?, ?, 'local')`
      )
      .run(
        library.id,
        groupId,
        pendingRoot.id,
        path.join(pendingRoot.path, 'pending.mp4'),
        path.join(pendingRoot.path, 'pending.mp4')
      )
    database
      .prepare(
        `INSERT INTO library_scan_runs (
           id, library_id, config_revision, trigger, status, started_at, finished_at
         ) VALUES ('owned-path-run', ?, 1, 'manual', 'completed', CURRENT_TIMESTAMP,
                   CURRENT_TIMESTAMP)`
      )
      .run(library.id)
    database
      .prepare(
        `INSERT INTO library_unrecognized_files (
           library_id, root_id, file_path, normalized_path, reason, scan_run_id, last_seen_at
         ) VALUES (?, ?, ?, ?, 'unsupported_extension', 'owned-path-run', CURRENT_TIMESTAMP)`
      )
      .run(
        library.id,
        unrecognizedRoot.id,
        path.join(unrecognizedRoot.path, 'unknown.bin'),
        path.join(unrecognizedRoot.path, 'unknown.bin')
      )
    database
      .prepare(
        `INSERT INTO library_root_cleanup_jobs (
           id, library_id, root_id, state, requested_at, completed_at, root_path,
           normalized_root_path, normalized_real_path, device_id, inode, config_revision
         ) VALUES ('owned-path-cleanup', ?, ?, 'completed', CURRENT_TIMESTAMP,
                   CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, 1)`
      )
      .run(
        library.id,
        cleanupRoot.id,
        cleanupRoot.path,
        cleanupRoot.normalizedPath,
        cleanupRoot.normalizedRealPath,
        cleanupRoot.deviceId,
        cleanupRoot.inode
      )

    for (const root of [resourceRoot, pendingRoot, unrecognizedRoot, cleanupRoot]) {
      assert.throws(
        () =>
          updateMediaLibraryRoot({
            libraryId: library.id,
            rootId: root.id,
            expectedRevision: library.revision,
            patch: { path: makeDirectory(`replacement-${root.id}`) }
          }),
        hasCode('LIBRARY_BUSY'),
        root.path
      )
    }

    const replacement = makeDirectory('unowned-replacement')
    const updated = updateMediaLibraryRoot({
      libraryId: library.id,
      rootId: unownedRoot.id,
      expectedRevision: library.revision,
      patch: { path: replacement }
    })
    assert.equal(updated.path, replacement)
    assert.equal(getMediaLibrary(library.id)?.revision, library.revision + 1)
  })

  it('archives roots atomically, releases their paths, and rechecks on restore', () => {
    setupDb()
    const sharedRoot = makeDirectory('archive-root')
    const disabledRoot = makeDirectory('disabled-root')
    const first = createMediaLibrary({
      name: 'First',
      roots: [
        { path: sharedRoot, state: 'active' },
        { path: disabledRoot, state: 'disabled' }
      ]
    })

    const archived = archiveMediaLibrary({
      libraryId: first.id,
      expectedRevision: first.revision
    })
    assert.equal(archived.status, 'archived')
    assert.equal(archived.revision, 2)
    assert.equal(archived.roots[0].state, 'archived')
    assert.equal(archived.roots[1].state, 'disabled')
    assert.deepEqual(listMediaLibraries().map((library) => library.id), [DEFAULT_MEDIA_LIBRARY_ID])

    const second = createMediaLibrary({
      name: 'Second',
      roots: [{ path: sharedRoot }]
    })
    assert.throws(
      () => restoreMediaLibrary({ libraryId: first.id, expectedRevision: archived.revision }),
      hasCode('ROOT_OVERLAP')
    )
    assert.equal(getMediaLibraryDetail(first.id)?.status, 'archived')
    assert.equal(getMediaLibraryDetail(first.id)?.roots[0].state, 'archived')

    updateMediaLibraryRoot({
      libraryId: second.id,
      rootId: second.roots[0].id,
      expectedRevision: second.revision,
      patch: { state: 'disabled' }
    })
    const restored = restoreMediaLibrary({
      libraryId: first.id,
      expectedRevision: archived.revision
    })
    assert.equal(restored.status, 'active')
    assert.equal(restored.revision, 3)
    assert.equal(restored.roots[0].state, 'active')
    assert.equal(restored.roots[1].state, 'disabled')
  })

  it('scopes local and STRM source identity while disabled and archived roots release paths', () => {
    setupDb()
    const sharedRoot = makeDirectory('shared-source-root')
    const localPath = path.join(sharedRoot, 'SHARED-001.mp4')
    const strmPath = path.join(sharedRoot, 'SHARED-STRM.strm')
    fs.writeFileSync(localPath, 'video')
    fs.writeFileSync(strmPath, 'https://example.test/shared')

    const first = createMediaLibrary({ name: 'First source', roots: [{ path: sharedRoot }] })
    assert.ok(
      insertScannedVideo({
        libraryId: first.id,
        rootId: first.roots[0].id,
        code: 'SHARED-001',
        locator: localPath,
        size_bytes: 5
      })
    )
    assert.ok(
      insertNewScannedStrmVideo({
        libraryId: first.id,
        rootId: first.roots[0].id,
        code: 'SHARED-STRM-A',
        sourcePath: strmPath,
        kind: 'web',
        locator: 'https://example.test/shared',
        displayName: 'Shared STRM A'
      })
    )

    assert.equal(localVideoResourceExistsByLocator(first.id, localPath), true)
    const disabledFirstRoot = updateMediaLibraryRoot({
      libraryId: first.id,
      rootId: first.roots[0].id,
      expectedRevision: first.revision,
      patch: { state: 'disabled' }
    })
    assert.equal(disabledFirstRoot.state, 'disabled')

    const second = createMediaLibrary({ name: 'Second source', roots: [{ path: sharedRoot }] })
    assert.equal(localVideoResourceExistsByLocator(second.id, localPath), false)
    assert.ok(
      insertScannedVideo({
        libraryId: second.id,
        rootId: second.roots[0].id,
        code: 'SHARED-001',
        locator: localPath,
        size_bytes: 5
      })
    )
    assert.ok(
      insertNewScannedStrmVideo({
        libraryId: second.id,
        rootId: second.roots[0].id,
        code: 'SHARED-STRM-B',
        sourcePath: strmPath,
        kind: 'web',
        locator: 'https://example.test/shared',
        displayName: 'Shared STRM B'
      })
    )
    assert.equal(getLocalVideoResourceByLocator(first.id, localPath)?.library_id, first.id)
    assert.equal(getLocalVideoResourceByLocator(second.id, localPath)?.library_id, second.id)
    assert.equal(getStrmVideoResourceBySourcePath(first.id, strmPath)?.library_id, first.id)
    assert.equal(getStrmVideoResourceBySourcePath(second.id, strmPath)?.library_id, second.id)
    assert.throws(
      () =>
        updateMediaLibraryRoot({
          libraryId: first.id,
          rootId: first.roots[0].id,
          expectedRevision: first.revision + 1,
          patch: { state: 'active' }
        }),
      hasCode('ROOT_OVERLAP')
    )

    updateMediaLibraryRoot({
      libraryId: second.id,
      rootId: second.roots[0].id,
      expectedRevision: second.revision,
      patch: { state: 'disabled' }
    })
    const reenabledFirstRoot = updateMediaLibraryRoot({
      libraryId: first.id,
      rootId: first.roots[0].id,
      expectedRevision: first.revision + 1,
      patch: { state: 'active' }
    })
    assert.equal(reenabledFirstRoot.state, 'active')
    const archivedFirst = archiveMediaLibrary({
      libraryId: first.id,
      expectedRevision: first.revision + 2
    })
    updateMediaLibraryRoot({
      libraryId: second.id,
      rootId: second.roots[0].id,
      expectedRevision: second.revision + 1,
      patch: { state: 'active' }
    })

    assert.throws(
      () =>
        restoreMediaLibrary({
          libraryId: first.id,
          expectedRevision: archivedFirst.revision
        }),
      hasCode('ROOT_OVERLAP')
    )
    assert.equal(getMediaLibraryDetail(first.id)?.status, 'archived')
  })

  it('protects the default library and refuses to archive pending root cleanup', () => {
    setupDb()
    const defaultLibrary = getMediaLibraryDetail(DEFAULT_MEDIA_LIBRARY_ID)
    assert.ok(defaultLibrary)
    assert.throws(
      () =>
        archiveMediaLibrary({
          libraryId: DEFAULT_MEDIA_LIBRARY_ID,
          expectedRevision: defaultLibrary.revision
        }),
      hasCode('DEFAULT_LIBRARY_PROTECTED')
    )
    assert.throws(
      () =>
        deleteMediaLibrary({
          libraryId: DEFAULT_MEDIA_LIBRARY_ID,
          expectedRevision: defaultLibrary.revision,
          expectedImpactRevision: 'a'.repeat(64)
        }),
      hasCode('DEFAULT_LIBRARY_PROTECTED')
    )
    assert.throws(
      () => previewMediaLibraryDeletion(DEFAULT_MEDIA_LIBRARY_ID),
      hasCode('DEFAULT_LIBRARY_PROTECTED')
    )

    const pendingRoot = makeDirectory('pending-root')
    const library = createMediaLibrary({
      name: 'Pending',
      roots: [{ path: pendingRoot, state: 'pending_removal' }]
    })
    assert.throws(
      () => archiveMediaLibrary({ libraryId: library.id, expectedRevision: library.revision }),
      hasCode('LIBRARY_BUSY')
    )
    assert.equal(getMediaLibrary(library.id)?.status, 'active')
  })

  it('requires a non-default library to be archived before preview or permanent deletion', () => {
    setupDb()
    const library = createMediaLibrary({ name: 'Lifecycle' })

    assert.throws(
      () => previewMediaLibraryDeletion(library.id),
      hasCode('VALIDATION_FAILED')
    )
    assert.throws(
      () =>
        deleteMediaLibrary({
          libraryId: library.id,
          expectedRevision: library.revision,
          expectedImpactRevision: 'a'.repeat(64)
        }),
      hasCode('VALIDATION_FAILED')
    )

    const archived = archiveMediaLibrary({
      libraryId: library.id,
      expectedRevision: library.revision
    })
    const preview = previewMediaLibraryDeletion(library.id)
    assert.match(preview.impactRevision, /^[a-f0-9]{64}$/)
    assert.deepEqual(preview, {
      libraryId: library.id,
      name: 'Lifecycle',
      revision: archived.revision,
      impactRevision: preview.impactRevision,
      status: 'archived',
      rootCount: 0,
      membershipCount: 0,
      resourceCount: 0,
      exclusiveVideoCount: 0,
      pendingScanGroupCount: 0,
      pendingScanResourceCount: 0,
      scanRunCount: 0,
      activeScanRunCount: 0,
      unrecognizedFileCount: 0,
      cleanupJobCount: 0,
      activeCleanupJobCount: 0
    })
    assert.throws(
      () =>
        deleteMediaLibrary({
          libraryId: library.id,
          expectedRevision: library.revision,
          expectedImpactRevision: preview.impactRevision
        }),
      hasCode('REVISION_CONFLICT')
    )
    const deleted = deleteMediaLibrary({
      libraryId: library.id,
      expectedRevision: archived.revision,
      expectedImpactRevision: preview.impactRevision
    })
    assert.equal(deleted.status, 'archived')
    assert.equal(getMediaLibraryDetail(library.id), null)
  })

  it('deletes roots and non-default libraries using the current library revision', () => {
    setupDb()
    const rootPath = makeDirectory('delete-root')
    const library = createMediaLibrary({ name: 'Temporary', roots: [{ path: rootPath }] })

    const deletedRoot = deleteMediaLibraryRoot({
      libraryId: library.id,
      rootId: library.roots[0].id,
      expectedRevision: library.revision
    })
    assert.equal(deletedRoot.path, rootPath)
    const afterRootDelete = getMediaLibraryDetail(library.id)
    assert.equal(afterRootDelete?.revision, 2)
    assert.equal(afterRootDelete?.rootCount, 0)

    const archived = archiveMediaLibrary({
      libraryId: library.id,
      expectedRevision: afterRootDelete!.revision
    })
    const deletedLibrary = deleteMediaLibrary({
      libraryId: library.id,
      expectedRevision: archived.revision,
      expectedImpactRevision: previewMediaLibraryDeletion(library.id).impactRevision
    })
    assert.equal(deletedLibrary.name, 'Temporary')
    assert.equal(getMediaLibraryDetail(library.id), null)
  })

  it('blocks archiving and deletion while root cleanup is active', () => {
    setupDb()
    const rootPath = makeDirectory('busy-root')
    const library = createMediaLibrary({ name: 'Busy', roots: [{ path: rootPath }] })
    getDb()
      .prepare(
        `INSERT INTO library_root_cleanup_jobs (
           id, library_id, root_id, state, requested_at, root_path,
           normalized_root_path, config_revision
         ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`
      )
      .run(
        'cleanup-test',
        library.id,
        library.roots[0].id,
        new Date().toISOString(),
        rootPath,
        normalizeLocalPathIdentity(rootPath),
        library.config.revision
      )

    assert.throws(
      () =>
        deleteMediaLibraryRoot({
          libraryId: library.id,
          rootId: library.roots[0].id,
          expectedRevision: library.revision
        }),
      hasCode('LIBRARY_BUSY')
    )
    assert.throws(
      () => archiveMediaLibrary({ libraryId: library.id, expectedRevision: library.revision }),
      hasCode('LIBRARY_BUSY')
    )
    assert.equal(getMediaLibrary(library.id)?.revision, library.revision)

    getDb()
      .prepare(
        "UPDATE library_root_cleanup_jobs SET state = 'completed', completed_at = ? WHERE id = ?"
      )
      .run(new Date().toISOString(), 'cleanup-test')
    const archived = archiveMediaLibrary({
      libraryId: library.id,
      expectedRevision: library.revision
    })
    getDb()
      .prepare(
        "UPDATE library_root_cleanup_jobs SET state = 'pending', completed_at = NULL WHERE id = ?"
      )
      .run('cleanup-test')

    assert.equal(previewMediaLibraryDeletion(library.id).activeCleanupJobCount, 1)
    assert.throws(
      () =>
        deleteMediaLibrary({
          libraryId: library.id,
          expectedRevision: archived.revision,
          expectedImpactRevision: 'a'.repeat(64)
        }),
      hasCode('LIBRARY_BUSY')
    )
    assert.equal(getMediaLibrary(library.id)?.revision, archived.revision)
  })

  it('blocks archiving and deletion while a scan run is active', () => {
    setupDb()
    const library = createMediaLibrary({ name: 'Scanning' })
    const database = getDb()
    const timestamp = new Date().toISOString()
    database
      .prepare(
        `INSERT INTO library_scan_runs (
           id, library_id, config_revision, trigger, status, started_at
         ) VALUES (?, ?, ?, 'automatic', 'queued', ?)`
      )
      .run('scan-active', library.id, library.config.revision, timestamp)

    assert.throws(
      () => archiveMediaLibrary({ libraryId: library.id, expectedRevision: library.revision }),
      hasCode('LIBRARY_BUSY')
    )
    database
      .prepare(
        "UPDATE library_scan_runs SET status = 'completed', finished_at = ? WHERE id = ?"
      )
      .run(timestamp, 'scan-active')
    const archived = archiveMediaLibrary({
      libraryId: library.id,
      expectedRevision: library.revision
    })

    database
      .prepare(
        "UPDATE library_scan_runs SET status = 'running', finished_at = NULL WHERE id = ?"
      )
      .run('scan-active')
    assert.equal(previewMediaLibraryDeletion(library.id).activeScanRunCount, 1)
    assert.throws(
      () =>
        deleteMediaLibrary({
          libraryId: library.id,
          expectedRevision: archived.revision,
          expectedImpactRevision: 'a'.repeat(64)
        }),
      hasCode('LIBRARY_BUSY')
    )
    assert.equal(getMediaLibrary(library.id)?.revision, archived.revision)
  })

  it('rejects a deletion preview made stale by global video lifecycle changes', () => {
    setupDb()
    const rootPath = makeDirectory('delete-stale-global')
    const library = createMediaLibrary({
      name: 'Stale global lifecycle',
      roots: [{ path: rootPath }]
    })
    const insertedVideoId = insertScannedVideo({
      libraryId: library.id,
      rootId: library.roots[0].id,
      code: 'STALE-GLOBAL-1',
      locator: path.join(rootPath, 'stale-global.mp4'),
      size_bytes: null
    })
    assert.ok(insertedVideoId)
    const archived = archiveMediaLibrary({
      libraryId: library.id,
      expectedRevision: library.revision
    })
    const stalePreview = previewMediaLibraryDeletion(library.id)

    const lifecycle = createVideoLifecycleRepo(getDb(), { isLocalAccessible: () => true })
    const videoPreview = lifecycle.previewDeleteGlobally(insertedVideoId)
    lifecycle.deleteGlobally({
      videoId: insertedVideoId,
      operationId: 'delete-stale-global-video',
      expectedRevision: videoPreview.revision
    })

    assert.equal(getMediaLibrary(library.id)?.revision, archived.revision)
    const refreshedPreview = previewMediaLibraryDeletion(library.id)
    assert.notEqual(refreshedPreview.impactRevision, stalePreview.impactRevision)
    assert.equal(refreshedPreview.membershipCount, 0)
    assert.equal(refreshedPreview.resourceCount, 0)
    assert.throws(
      () =>
        deleteMediaLibrary({
          libraryId: library.id,
          expectedRevision: stalePreview.revision,
          expectedImpactRevision: stalePreview.impactRevision
        }),
      hasCode('REVISION_CONFLICT')
    )
    assert.ok(getMediaLibraryDetail(library.id))
  })

  it('invalidates deletion impact when another library changes the exclusive-video count', () => {
    setupDb()
    const rootPath = makeDirectory('delete-stale-exclusive-count')
    const library = createMediaLibrary({
      name: 'Stale exclusive count',
      roots: [{ path: rootPath }]
    })
    const videoId = insertScannedVideo({
      libraryId: library.id,
      rootId: library.roots[0].id,
      code: 'STALE-COUNT-1',
      locator: path.join(rootPath, 'stale-count.mp4'),
      size_bytes: null
    })
    assert.ok(videoId)
    const archived = archiveMediaLibrary({
      libraryId: library.id,
      expectedRevision: library.revision
    })
    const stalePreview = previewMediaLibraryDeletion(library.id)
    assert.equal(stalePreview.exclusiveVideoCount, 1)

    ensureVideoMembership({
      libraryId: DEFAULT_MEDIA_LIBRARY_ID,
      videoId,
      addedVia: 'shared'
    })

    assert.equal(getMediaLibrary(library.id)?.revision, archived.revision)
    const refreshedPreview = previewMediaLibraryDeletion(library.id)
    assert.equal(refreshedPreview.exclusiveVideoCount, 0)
    assert.notEqual(refreshedPreview.impactRevision, stalePreview.impactRevision)
    assert.throws(
      () =>
        deleteMediaLibrary({
          libraryId: library.id,
          expectedRevision: stalePreview.revision,
          expectedImpactRevision: stalePreview.impactRevision
        }),
      hasCode('REVISION_CONFLICT')
    )
  })

  it('previews all owned data and permanently deletes only database ownership', () => {
    setupDb()
    const rootPath = makeDirectory('delete-impact')
    const exclusiveFile = path.join(rootPath, 'exclusive.mp4')
    const sharedFile = path.join(rootPath, 'shared.mp4')
    const pendingFile = path.join(rootPath, 'pending.mp4')
    fs.writeFileSync(exclusiveFile, 'exclusive')
    fs.writeFileSync(sharedFile, 'shared')
    fs.writeFileSync(pendingFile, 'pending')

    const library = createMediaLibrary({ name: 'Impact', roots: [{ path: rootPath }] })
    const rootId = library.roots[0].id
    const exclusiveVideoId = insertScannedVideo({
      libraryId: library.id,
      rootId,
      code: 'EXCLUSIVE-1',
      locator: exclusiveFile,
      size_bytes: 9
    })
    const sharedVideoId = insertScannedVideo({
      libraryId: library.id,
      rootId,
      code: 'SHARED-1',
      locator: sharedFile,
      size_bytes: 6
    })
    assert.ok(exclusiveVideoId)
    assert.ok(sharedVideoId)
    assert.equal(
      ensureVideoMembership({
        libraryId: DEFAULT_MEDIA_LIBRARY_ID,
        videoId: sharedVideoId,
        addedVia: 'shared'
      }),
      true
    )

    const database = getDb()
    const timestamp = new Date().toISOString()
    database
      .prepare(
        `INSERT INTO library_scan_runs (
           id, library_id, config_revision, trigger, status, started_at, finished_at
         ) VALUES (?, ?, ?, 'manual', 'completed', ?, ?)`
      )
      .run('scan-impact', library.id, library.config.revision, timestamp, timestamp)
    const pendingGroupId = Number(
      database
        .prepare(
          `INSERT INTO pending_scan_groups (
             library_id, normalized_code, created_at, updated_at
           ) VALUES (?, ?, ?, ?)`
        )
        .run(library.id, 'PENDING-1', timestamp, timestamp).lastInsertRowid
    )
    database
      .prepare(
        `INSERT INTO pending_scan_resources (
           library_id, group_id, root_id, file_path, normalized_path,
           source_kind, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'local', ?, ?)`
      )
      .run(
        library.id,
        pendingGroupId,
        rootId,
        pendingFile,
        normalizeLocalPathIdentity(pendingFile),
        timestamp,
        timestamp
      )
    database
      .prepare(
        `INSERT INTO library_unrecognized_files (
           library_id, root_id, file_path, normalized_path, reason, scan_run_id, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        library.id,
        rootId,
        pendingFile,
        normalizeLocalPathIdentity(pendingFile),
        'unrecognized',
        'scan-impact',
        timestamp
      )
    database
      .prepare(
        `INSERT INTO library_root_cleanup_jobs (
           id, library_id, root_id, state, requested_at, completed_at, root_path,
           normalized_root_path, config_revision
         ) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?)`
      )
      .run(
        'cleanup-impact',
        library.id,
        rootId,
        timestamp,
        timestamp,
        rootPath,
        normalizeLocalPathIdentity(rootPath),
        library.config.revision
      )

    const archived = archiveMediaLibrary({
      libraryId: library.id,
      expectedRevision: library.revision
    })
    const firstPreview = previewMediaLibraryDeletion(library.id)
    assert.match(firstPreview.impactRevision, /^[a-f0-9]{64}$/)
    assert.deepEqual(firstPreview, {
      libraryId: library.id,
      name: 'Impact',
      revision: archived.revision,
      impactRevision: firstPreview.impactRevision,
      status: 'archived',
      rootCount: 1,
      membershipCount: 2,
      resourceCount: 2,
      exclusiveVideoCount: 1,
      pendingScanGroupCount: 1,
      pendingScanResourceCount: 1,
      scanRunCount: 1,
      activeScanRunCount: 0,
      unrecognizedFileCount: 1,
      cleanupJobCount: 1,
      activeCleanupJobCount: 0
    })

    const restored = restoreMediaLibrary({
      libraryId: library.id,
      expectedRevision: firstPreview.revision
    })
    const reArchived = archiveMediaLibrary({
      libraryId: library.id,
      expectedRevision: restored.revision
    })
    assert.throws(
      () =>
        deleteMediaLibrary({
          libraryId: library.id,
          expectedRevision: firstPreview.revision,
          expectedImpactRevision: firstPreview.impactRevision
        }),
      hasCode('REVISION_CONFLICT')
    )
    assert.equal(getMediaLibraryDetail(library.id)?.status, 'archived')

    const confirmedPreview = previewMediaLibraryDeletion(library.id)
    assert.equal(confirmedPreview.revision, reArchived.revision)
    deleteMediaLibrary({
      libraryId: library.id,
      expectedRevision: confirmedPreview.revision,
      expectedImpactRevision: confirmedPreview.impactRevision
    })

    assert.equal(getMediaLibraryDetail(library.id), null)
    for (const table of [
      'media_library_roots',
      'media_library_configs',
      'library_video_memberships',
      'video_resources',
      'pending_scan_groups',
      'pending_scan_resources',
      'library_scan_runs',
      'media_library_scan_state',
      'library_unrecognized_files',
      'library_root_cleanup_jobs'
    ]) {
      const row = database
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE library_id = ?`)
        .get(library.id) as { count: number }
      assert.equal(row.count, 0, table)
    }
    assert.equal(
      (
        database
          .prepare('SELECT COUNT(*) AS count FROM videos WHERE id IN (?, ?)')
          .get(exclusiveVideoId, sharedVideoId) as { count: number }
      ).count,
      2
    )
    assert.equal(
      (
        database
          .prepare(
            'SELECT COUNT(*) AS count FROM library_video_memberships WHERE library_id = ? AND video_id = ?'
          )
          .get(DEFAULT_MEDIA_LIBRARY_ID, sharedVideoId) as { count: number }
      ).count,
      1
    )
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(fs.readFileSync(exclusiveFile, 'utf8'), 'exclusive')
    assert.equal(fs.readFileSync(sharedFile, 'utf8'), 'shared')
    assert.equal(fs.readFileSync(pendingFile, 'utf8'), 'pending')
  })

  it('returns a frozen scan snapshot containing only active roots', () => {
    setupDb()
    const activeRoot = makeDirectory('scan-active')
    const disabledRoot = makeDirectory('scan-disabled')
    const library = createMediaLibrary({
      name: 'Scan',
      config: { autoScanEnabled: true, autoScanIntervalMinutes: 30 },
      roots: [
        { path: activeRoot, state: 'active' },
        { path: disabledRoot, state: 'disabled' }
      ]
    })

    const snapshot = readMediaLibraryScanSnapshot(library.id)
    assert.equal(snapshot.libraryRevision, 1)
    assert.equal(snapshot.configRevision, 1)
    assert.equal(snapshot.config.autoScanIntervalMinutes, 30)
    assert.deepEqual(snapshot.roots.map((root) => root.path), [activeRoot])
    assert.equal(Object.isFrozen(snapshot), true)
    assert.equal(Object.isFrozen(snapshot.config), true)
    assert.equal(Object.isFrozen(snapshot.roots), true)
    assert.equal(Object.isFrozen(snapshot.roots[0]), true)

    updateMediaLibraryConfig({
      libraryId: library.id,
      expectedRevision: 1,
      patch: { autoScanIntervalMinutes: 60 }
    })
    updateMediaLibraryRoot({
      libraryId: library.id,
      rootId: library.roots[0].id,
      expectedRevision: 1,
      patch: { state: 'disabled' }
    })
    assert.equal(snapshot.config.autoScanIntervalMinutes, 30)
    assert.equal(snapshot.roots[0].state, 'active')
  })

  it('projects independently configured automatic scan state in stable library order', () => {
    setupDb()
    const defaultLibrary = getMediaLibraryDetail(DEFAULT_MEDIA_LIBRARY_ID)
    assert.ok(defaultLibrary)
    addMediaLibraryRoot({
      libraryId: defaultLibrary.id,
      expectedRevision: defaultLibrary.revision,
      root: { path: makeDirectory('default-active') }
    })
    updateMediaLibraryConfig({
      libraryId: defaultLibrary.id,
      expectedRevision: defaultLibrary.config.revision,
      patch: { autoScanEnabled: true, autoScanIntervalMinutes: 15 }
    })

    const firstAtSamePosition = createMediaLibrary({
      name: 'First at position',
      position: 10,
      config: { autoScanEnabled: false, autoScanIntervalMinutes: 30 },
      roots: [
        { path: makeDirectory('first-active') },
        { path: makeDirectory('first-disabled'), state: 'disabled' }
      ]
    })
    const secondAtSamePosition = createMediaLibrary({
      name: 'Second at position',
      position: 10,
      config: { autoScanEnabled: true, autoScanIntervalMinutes: 45 },
      roots: [
        { path: makeDirectory('second-active') },
        { path: makeDirectory('second-pending'), state: 'pending_removal' }
      ]
    })
    const removalPreview = previewLibraryPathRemoval({
      libraryId: firstAtSamePosition.id,
      rootId: firstAtSamePosition.roots[0].id
    })
    confirmLibraryPathRemoval({
      libraryId: firstAtSamePosition.id,
      rootId: firstAtSamePosition.roots[0].id,
      expectedRevision: firstAtSamePosition.revision,
      expectedImpactRevision: removalPreview.impactRevision
    })
    const archived = createMediaLibrary({
      name: 'Archived',
      position: 5,
      config: { autoScanEnabled: true },
      roots: [{ path: makeDirectory('archived-root') }]
    })
    archiveMediaLibrary({ libraryId: archived.id, expectedRevision: archived.revision })
    getDb()
      .prepare(
        `INSERT INTO media_library_scan_state (library_id, last_finished_at)
         VALUES (?, ?)`
      )
      .run(secondAtSamePosition.id, '2026-08-10T01:30:00.000Z')

    assert.deepEqual(listMediaLibraryAutomaticScanStates(), [
      {
        libraryId: defaultLibrary.id,
        position: 0,
        enabled: true,
        intervalMinutes: 15,
        activeRootCount: 1,
        pendingCleanupJobCount: 0,
        lastFinishedAt: null
      },
      {
        libraryId: firstAtSamePosition.id,
        position: 10,
        enabled: false,
        intervalMinutes: 30,
        activeRootCount: 0,
        pendingCleanupJobCount: 1,
        lastFinishedAt: null
      },
      {
        libraryId: secondAtSamePosition.id,
        position: 10,
        enabled: true,
        intervalMinutes: 45,
        activeRootCount: 1,
        pendingCleanupJobCount: 0,
        lastFinishedAt: '2026-08-10T01:30:00.000Z'
      }
    ])

    assert.equal(getMediaLibraryDetail(firstAtSamePosition.id)?.pendingCleanupJobCount, 1)
    assert.equal(getMediaLibraryDetail(secondAtSamePosition.id)?.pendingCleanupJobCount, 0)
  })

  it('accepts offline absolute roots but rejects relative paths and files', () => {
    setupDb()
    const library = createMediaLibrary({ name: 'Validation' })
    const missing = path.join(tempRoot!, 'offline', 'media')

    const offline = addMediaLibraryRoot({
      libraryId: library.id,
      expectedRevision: library.revision,
      root: { path: missing }
    })
    assert.equal(offline.realPath, null)
    assert.equal(offline.deviceId, null)

    assert.throws(
      () =>
        addMediaLibraryRoot({
          libraryId: library.id,
          expectedRevision: 2,
          root: { path: 'relative/media' }
        }),
      hasCode('VALIDATION_FAILED')
    )

    const filePath = path.join(tempRoot!, 'not-a-directory.txt')
    fs.writeFileSync(filePath, 'fixture')
    assert.throws(
      () =>
        addMediaLibraryRoot({
          libraryId: library.id,
          expectedRevision: 2,
          root: { path: filePath }
        }),
      hasCode('VALIDATION_FAILED')
    )
  })

  it('does not let direct disabled-root deletion cascade diagnostic records', () => {
    setupDb()
    const rootPath = makeDirectory('diagnostic-root')
    const library = createMediaLibrary({ name: 'Diagnostics', roots: [{ path: rootPath }] })
    const root = library.roots[0]
    updateMediaLibraryRoot({
      libraryId: library.id,
      rootId: root.id,
      expectedRevision: library.revision,
      patch: { state: 'disabled' }
    })
    getDb().exec(`
      INSERT INTO library_scan_runs (
        id, library_id, config_revision, trigger, status, started_at, finished_at
      ) VALUES ('diagnostic-run', ${library.id}, 1, 'manual', 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
      INSERT INTO library_unrecognized_files (
        library_id, root_id, file_path, normalized_path, reason, scan_run_id, last_seen_at
      ) VALUES (
        ${library.id}, ${root.id}, '${rootPath}/unknown.bin', '${rootPath}/unknown.bin',
        'unsupported_extension', 'diagnostic-run', CURRENT_TIMESTAMP
      );
    `)

    assert.throws(
      () =>
        deleteMediaLibraryRoot({
          libraryId: library.id,
          rootId: root.id,
          expectedRevision: library.revision + 1
        }),
      hasCode('LIBRARY_BUSY')
    )
    assert.equal(getMediaLibraryDetail(library.id)?.roots.length, 1)
    assert.equal(
      getDb()
        .prepare('SELECT COUNT(*) AS count FROM library_unrecognized_files WHERE root_id = ?')
        .pluck()
        .get(root.id),
      1
    )
  })

  it('atomically freezes the filesystem identity when an offline root first comes online', () => {
    setupDb()
    const library = createMediaLibrary({ name: 'Offline binding' })
    const rootPath = path.join(tempRoot!, 'offline-binding')
    const root = addMediaLibraryRoot({
      libraryId: library.id,
      expectedRevision: library.revision,
      root: { path: rootPath }
    })
    assert.equal(root.normalizedRealPath, null)
    fs.mkdirSync(rootPath, { recursive: true })

    const result = bindOnlineMediaLibraryRootIdentities({
      libraryId: library.id,
      rootIds: [root.id],
      expectedRevision: 2
    })
    const bound = getMediaLibraryDetail(library.id)?.roots[0]

    assert.deepEqual(result, { boundRootIds: [root.id], revision: 3 })
    assert.equal(bound?.normalizedRealPath, normalizeLocalPathIdentity(fs.realpathSync.native(rootPath)))
    assert.ok(bound?.deviceId)
    assert.ok(bound?.inode)
    assert.equal(getMediaLibraryDetail(library.id)?.revision, 3)
  })

  for (const kind of ['resource', 'pending', 'unrecognized'] as const) {
    it(`rejects scan-time identity binding for an identity-less root with ${kind} ownership`, () => {
      setupDb()
      const library = createMediaLibrary({ name: `Legacy ${kind}` })
      const rootPath = path.join(tempRoot!, `legacy-${kind}`)
      const root = addMediaLibraryRoot({
        libraryId: library.id,
        expectedRevision: library.revision,
        root: { path: rootPath }
      })
      assert.equal(root.normalizedRealPath, null)
      assert.equal(root.deviceId, null)
      assert.equal(root.inode, null)

      fs.mkdirSync(rootPath, { recursive: true })
      seedContinuityOwnedData({
        libraryId: library.id,
        root,
        kind,
        key: `LEGACY-${kind.toUpperCase()}`
      })
      moveRootAside(rootPath, `legacy-${kind}`, true)
      const revisionBeforeBinding = getMediaLibrary(library.id)?.revision

      assert.throws(
        () =>
          bindOnlineMediaLibraryRootIdentities({
            libraryId: library.id,
            rootIds: [root.id],
            expectedRevision: revisionBeforeBinding!
          }),
        hasCode('VALIDATION_FAILED')
      )
      const unchanged = getMediaLibraryDetail(library.id)
      assert.equal(unchanged?.revision, revisionBeforeBinding)
      assert.equal(unchanged?.roots[0].normalizedRealPath, null)
      assert.equal(unchanged?.roots[0].deviceId, null)
      assert.equal(unchanged?.roots[0].inode, null)
    })
  }

  it('rejects activation of an identity-less disabled root with owned resources', () => {
    setupDb()
    const library = createMediaLibrary({ name: 'Legacy disabled' })
    const rootPath = path.join(tempRoot!, 'legacy-disabled')
    const root = addMediaLibraryRoot({
      libraryId: library.id,
      expectedRevision: library.revision,
      root: { path: rootPath }
    })
    fs.mkdirSync(rootPath, { recursive: true })
    seedContinuityOwnedData({
      libraryId: library.id,
      root,
      kind: 'resource',
      key: 'LEGACY-DISABLED'
    })
    const disabled = updateMediaLibraryRoot({
      libraryId: library.id,
      rootId: root.id,
      expectedRevision: 2,
      patch: { state: 'disabled' }
    })
    moveRootAside(rootPath, 'legacy-disabled', true)
    const revisionBeforeActivation = getMediaLibrary(library.id)?.revision

    assert.throws(
      () =>
        updateMediaLibraryRoot({
          libraryId: library.id,
          rootId: root.id,
          expectedRevision: revisionBeforeActivation!,
          patch: { state: 'active' }
        }),
      hasCode('VALIDATION_FAILED')
    )
    const unchanged = getMediaLibraryDetail(library.id)
    assert.equal(unchanged?.revision, revisionBeforeActivation)
    assert.equal(unchanged?.roots[0].state, 'disabled')
    assert.equal(unchanged?.roots[0].normalizedRealPath, disabled.normalizedRealPath)
    assert.equal(unchanged?.roots[0].deviceId, disabled.deviceId)
    assert.equal(unchanged?.roots[0].inode, disabled.inode)
  })

  it('rejects restore of an identity-less archived root with owned resources', () => {
    setupDb()
    const library = createMediaLibrary({ name: 'Legacy archived' })
    const rootPath = path.join(tempRoot!, 'legacy-archived')
    const root = addMediaLibraryRoot({
      libraryId: library.id,
      expectedRevision: library.revision,
      root: { path: rootPath }
    })
    fs.mkdirSync(rootPath, { recursive: true })
    seedContinuityOwnedData({
      libraryId: library.id,
      root,
      kind: 'resource',
      key: 'LEGACY-ARCHIVED'
    })
    const archived = archiveMediaLibrary({
      libraryId: library.id,
      expectedRevision: 2
    })
    moveRootAside(rootPath, 'legacy-archived', true)

    assert.throws(
      () =>
        restoreMediaLibrary({
          libraryId: library.id,
          expectedRevision: archived.revision
        }),
      hasCode('VALIDATION_FAILED')
    )
    const unchanged = getMediaLibraryDetail(library.id)
    assert.equal(unchanged?.status, 'archived')
    assert.equal(unchanged?.revision, archived.revision)
    assert.equal(unchanged?.roots[0].state, 'archived')
    assert.equal(unchanged?.roots[0].normalizedRealPath, null)
    assert.equal(unchanged?.roots[0].deviceId, null)
    assert.equal(unchanged?.roots[0].inode, null)
  })

  it('rejects a newly-online alias of another active root without partially binding it', () => {
    setupDb()
    const managedPath = makeDirectory('managed-root')
    createMediaLibrary({ name: 'Managed', roots: [{ path: managedPath }] })
    const adopting = createMediaLibrary({ name: 'Adopting' })
    const aliasPath = path.join(tempRoot!, 'late-alias')
    const offline = addMediaLibraryRoot({
      libraryId: adopting.id,
      expectedRevision: adopting.revision,
      root: { path: aliasPath }
    })
    fs.symlinkSync(managedPath, aliasPath, 'dir')

    assert.throws(
      () =>
        bindOnlineMediaLibraryRootIdentities({
          libraryId: adopting.id,
          rootIds: [offline.id],
          expectedRevision: 2
        }),
      hasCode('ROOT_OVERLAP')
    )
    const unchanged = getMediaLibraryDetail(adopting.id)
    assert.equal(unchanged?.revision, 2)
    assert.equal(unchanged?.roots[0].normalizedRealPath, null)
    assert.equal(unchanged?.roots[0].deviceId, null)
    assert.equal(unchanged?.roots[0].inode, null)
  })
})
