import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addMediaLibraryRoot,
  createMediaLibrary,
  updateMediaLibraryRoot
} from './mediaLibraryRepo'
import { closeDatabase, getDb, initDatabaseAtPath } from './database'
import { readStrmFile } from '@library/scan/strmParser'
import {
  PendingScanRepoError,
  getPendingScanGroup,
  listPendingScanGroups,
  pendingScanResourceExists,
  reconcilePendingScanResources,
  removePendingScanResource,
  resolvePendingScanGroup,
  upsertPendingScanResources,
  type PendingScanResourceInput
} from './pendingScanRepo'

let tempRoot: string | null = null

interface TestLibrary {
  id: number
  rootId: number
  rootPath: string
}

function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pending-scan-repo-'))
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
}

function createTestLibrary(name: string): TestLibrary {
  if (!tempRoot) throw new Error('test database is not initialized')
  const rootPath = path.join(tempRoot, name.toLowerCase())
  fs.mkdirSync(rootPath, { recursive: true })
  const library = createMediaLibrary({ name, roots: [{ path: rootPath }] })
  return { id: library.id, rootId: library.roots[0].id, rootPath }
}

function localInput(
  library: TestLibrary,
  fileName: string,
  overrides: Partial<PendingScanResourceInput> = {}
): PendingScanResourceInput {
  const filePath = path.join(library.rootPath, fileName)
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, fileName)
  return {
    rootId: library.rootId,
    filePath,
    sizeBytes: fs.statSync(filePath).size,
    durationSeconds: 1800,
    fileMtimeMs: fs.statSync(filePath).mtimeMs,
    ...overrides
  }
}

function hasCode(code: PendingScanRepoError['code']): (error: unknown) => boolean {
  return (error) => error instanceof PendingScanRepoError && error.code === code
}

afterEach(() => {
  closeDatabase()
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('pendingScanRepo media-library scope', () => {
  it('keeps same-code groups and resource lookups isolated between libraries', () => {
    setupDb()
    const first = createTestLibrary('First')
    const second = createTestLibrary('Second')
    const firstInput = localInput(first, 'SAME-001-a.mp4')
    const secondInput = localInput(second, 'SAME-001-b.mp4')

    const firstUpsert = upsertPendingScanResources(first.id, 'same-001', [firstInput])
    const secondUpsert = upsertPendingScanResources(second.id, 'same-001', [secondInput])

    assert.notEqual(firstUpsert.groupId, secondUpsert.groupId)
    assert.equal(firstUpsert.revision, 1)
    assert.equal(secondUpsert.revision, 1)
    const firstGroup = listPendingScanGroups(first.id)[0]
    const secondGroup = listPendingScanGroups(second.id)[0]
    assert.equal(firstGroup.libraryId, first.id)
    assert.equal(secondGroup.libraryId, second.id)
    assert.equal(firstGroup.normalizedCode, 'SAME-001')
    assert.equal(secondGroup.normalizedCode, 'SAME-001')
    assert.equal(firstGroup.resources[0].rootId, first.rootId)
    assert.equal(secondGroup.resources[0].rootId, second.rootId)
    assert.equal('scanRoot' in firstGroup.resources[0], false)
    assert.equal(pendingScanResourceExists(first.id, firstInput.filePath), true)
    assert.equal(pendingScanResourceExists(second.id, firstInput.filePath), false)
    assert.equal(getPendingScanGroup(first.id, secondGroup.id), null)
    assert.equal(removePendingScanResource(second.id, firstInput.filePath), false)
    assert.equal(listPendingScanGroups(first.id).length, 1)
  })

  it('allows the same normalized path in different libraries while deduplicating inside each library', () => {
    setupDb()
    const first = createTestLibrary('First')
    const sharedInput = localInput(first, 'TAKEOVER-001.mp4')
    const firstUpsert = upsertPendingScanResources(first.id, 'TAKEOVER-001', [sharedInput])
    updateMediaLibraryRoot({
      libraryId: first.id,
      rootId: first.rootId,
      expectedRevision: 1,
      patch: { state: 'disabled' }
    })

    const secondLibrary = createMediaLibrary({ name: 'Second' })
    const secondRoot = addMediaLibraryRoot({
      libraryId: secondLibrary.id,
      expectedRevision: secondLibrary.revision,
      root: { path: first.rootPath }
    })
    const second: TestLibrary = {
      id: secondLibrary.id,
      rootId: secondRoot.id,
      rootPath: first.rootPath
    }
    const secondUpsert = upsertPendingScanResources(second.id, 'TAKEOVER-001', [
      localInput(second, 'TAKEOVER-001.mp4')
    ])
    const secondRepeat = upsertPendingScanResources(second.id, 'TAKEOVER-001', [
      localInput(second, 'TAKEOVER-001.mp4')
    ])

    assert.notEqual(firstUpsert.groupId, secondUpsert.groupId)
    assert.equal(secondUpsert.addedResources, 1)
    assert.equal(secondRepeat.addedResources, 0)
    assert.equal(pendingScanResourceExists(first.id, sharedInput.filePath), true)
    assert.equal(pendingScanResourceExists(second.id, sharedInput.filePath), true)
    assert.equal(
      (
        getDb()
          .prepare(
            `SELECT COUNT(*) AS count
               FROM pending_scan_resources`
          )
          .get() as { count: number }
      ).count,
      2
    )
  })

  it('rejects a root or group that belongs to another library', () => {
    setupDb()
    const first = createTestLibrary('First')
    const second = createTestLibrary('Second')
    const secondInput = localInput(second, 'CROSS-001.mp4')

    assert.throws(
      () =>
        upsertPendingScanResources(first.id, 'CROSS-001', [
          { ...secondInput, rootId: second.rootId }
        ]),
      hasCode('ROOT_NOT_FOUND')
    )
    assert.throws(
      () =>
        upsertPendingScanResources(first.id, 'CROSS-001', [
          { ...secondInput, rootId: first.rootId }
        ]),
      hasCode('ROOT_NOT_FOUND')
    )
    assert.throws(
      () => reconcilePendingScanResources(first.id, [second.rootId], () => 'missing'),
      hasCode('ROOT_NOT_FOUND')
    )

    const secondGroup = upsertPendingScanResources(second.id, 'CROSS-001', [secondInput])
    assert.throws(
      () =>
        resolvePendingScanGroup(first.id, secondGroup.groupId, {
          expectedRevision: secondGroup.revision,
          assignments: []
        }),
      hasCode('GROUP_NOT_FOUND')
    )
    assert.equal(listPendingScanGroups(first.id).length, 0)
    assert.equal(listPendingScanGroups(second.id).length, 1)
  })

  it('increments revision on upsert and rejects a stale resolution atomically', () => {
    setupDb()
    const library = createTestLibrary('Revision')
    const firstInput = localInput(library, 'REV-001-a.mp4')
    const secondInput = localInput(library, 'REV-001-b.mp4')
    const first = upsertPendingScanResources(library.id, 'REV-001', [firstInput])
    const initial = getPendingScanGroup(library.id, first.groupId)!
    const second = upsertPendingScanResources(library.id, 'REV-001', [secondInput])
    const current = getPendingScanGroup(library.id, first.groupId)!

    assert.equal(initial.revision, 1)
    assert.equal(second.revision, 2)
    assert.equal(current.revision, 2)
    assert.equal(current.resources.length, 2)
    assert.throws(
      () =>
        resolvePendingScanGroup(library.id, current.id, {
          expectedRevision: initial.revision,
          assignments: current.resources.map((resource) => ({
            resourceId: resource.id,
            target: { kind: 'new' as const, groupKey: 'one' }
          }))
        }),
      hasCode('REVISION_CONFLICT')
    )
    assert.equal(getPendingScanGroup(library.id, current.id)?.resources.length, 2)
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS count FROM videos').get() as { count: number }).count,
      0
    )

    const resolved = resolvePendingScanGroup(library.id, current.id, {
      expectedRevision: current.revision,
      assignments: current.resources.map((resource) => ({
        resourceId: resource.id,
        target: { kind: 'new' as const, groupKey: 'one' }
      }))
    })
    assert.equal(resolved.createdVideoIds.length, 1)
    assert.equal(getPendingScanGroup(library.id, current.id), null)
    const resourceRows = getDb()
      .prepare(
        `SELECT library_id, root_id, is_primary FROM video_resources
          WHERE video_id = ? ORDER BY id`
      )
      .all(resolved.createdVideoIds[0]) as Array<{
      library_id: number
      root_id: number
      is_primary: number
    }>
    assert.deepEqual(resourceRows.map((row) => row.library_id), [library.id, library.id])
    assert.deepEqual(resourceRows.map((row) => row.root_id), [library.rootId, library.rootId])
    assert.equal(resourceRows.filter((row) => row.is_primary === 1).length, 1)
  })

  it('can assign the same global video in two libraries without crossing resources', () => {
    setupDb()
    const first = createTestLibrary('First')
    const second = createTestLibrary('Second')
    const videoId = Number(
      getDb()
        .prepare("INSERT INTO videos (code, scraped_status) VALUES ('SHARED-001', 0)")
        .run().lastInsertRowid
    )
    const firstUpsert = upsertPendingScanResources(first.id, 'SHARED-001', [
      localInput(first, 'SHARED-001-a.mp4')
    ])
    const secondUpsert = upsertPendingScanResources(second.id, 'SHARED-001', [
      localInput(second, 'SHARED-001-b.mp4')
    ])

    for (const [library, upsert] of [
      [first, firstUpsert],
      [second, secondUpsert]
    ] as const) {
      const group = getPendingScanGroup(library.id, upsert.groupId)!
      resolvePendingScanGroup(library.id, group.id, {
        expectedRevision: group.revision,
        assignments: [
          {
            resourceId: group.resources[0].id,
            target: { kind: 'existing', videoId }
          }
        ]
      })
    }

    const memberships = getDb()
      .prepare(
        `SELECT library_id, video_id FROM library_video_memberships
          WHERE video_id = ? ORDER BY library_id`
      )
      .all(videoId) as Array<{ library_id: number; video_id: number }>
    assert.deepEqual(memberships.map((row) => row.library_id), [first.id, second.id])
    const resources = getDb()
      .prepare(
        `SELECT library_id, root_id, is_primary FROM video_resources
          WHERE video_id = ? ORDER BY library_id`
      )
      .all(videoId) as Array<{ library_id: number; root_id: number; is_primary: number }>
    assert.deepEqual(
      resources,
      [
        { library_id: first.id, root_id: first.rootId, is_primary: 1 },
        { library_id: second.id, root_id: second.rootId, is_primary: 1 }
      ]
    )
  })

  it('reconciles only selected roots in the selected library and bumps surviving groups', () => {
    setupDb()
    const first = createTestLibrary('First')
    const second = createTestLibrary('Second')
    const extraRootPath = path.join(tempRoot!, 'first-extra')
    fs.mkdirSync(extraRootPath, { recursive: true })
    const extraRoot = addMediaLibraryRoot({
      libraryId: first.id,
      expectedRevision: 1,
      root: { path: extraRootPath }
    })
    const extra: TestLibrary = {
      id: first.id,
      rootId: extraRoot.id,
      rootPath: extraRootPath
    }
    const firstGroup = upsertPendingScanResources(first.id, 'KEEP-001', [
      localInput(first, 'KEEP-001-a.mp4'),
      localInput(extra, 'KEEP-001-b.mp4')
    ])
    const secondGroup = upsertPendingScanResources(second.id, 'KEEP-001', [
      localInput(second, 'KEEP-001.mp4')
    ])

    assert.deepEqual(reconcilePendingScanResources(first.id, [first.rootId], () => 'missing'), {
      removedResources: 1,
      removedGroups: 0
    })
    const surviving = getPendingScanGroup(first.id, firstGroup.groupId)
    assert.equal(surviving?.revision, firstGroup.revision + 1)
    assert.deepEqual(surviving?.resources.map((resource) => resource.rootId), [extra.rootId])
    assert.ok(getPendingScanGroup(second.id, secondGroup.groupId))
  })

  it('refreshes a changed STRM snapshot and forces the caller to review the new revision', () => {
    setupDb()
    const library = createTestLibrary('Strm')
    const sourcePath = path.join(library.rootPath, 'STRM-001.strm')
    const infoHash = '1234567890abcdef1234567890abcdef12345678'
    fs.writeFileSync(sourcePath, `magnet:?xt=urn:btih:${infoHash}&dn=Old`)
    const originalTarget = readStrmFile(sourcePath)
    const upsert = upsertPendingScanResources(library.id, 'STRM-001', [
      {
        rootId: library.rootId,
        filePath: sourcePath,
        sourceKind: 'strm',
        targetKind: originalTarget.kind,
        targetLocator: originalTarget.locator,
        targetKey: originalTarget.targetKey,
        sizeBytes: null,
        durationSeconds: null,
        fileMtimeMs: fs.statSync(sourcePath).mtimeMs
      }
    ])
    const initial = getPendingScanGroup(library.id, upsert.groupId)!
    fs.writeFileSync(sourcePath, `magnet:?xt=urn:btih:${infoHash}&dn=New`)
    const assignments = [
      {
        resourceId: initial.resources[0].id,
        target: { kind: 'new' as const, groupKey: 'one' }
      }
    ]

    assert.throws(
      () =>
        resolvePendingScanGroup(library.id, initial.id, {
          expectedRevision: initial.revision,
          assignments
        }),
      (error) =>
        error instanceof PendingScanRepoError &&
        error.code === 'REVISION_CONFLICT' &&
        /已变化.*已刷新/.test(error.message)
    )
    const refreshed = getPendingScanGroup(library.id, initial.id)!
    assert.equal(refreshed.revision, initial.revision + 1)
    assert.equal(refreshed.resources[0].targetDisplay, 'Magnet · New')
    assert.doesNotMatch(JSON.stringify(refreshed), /btih|1234567890abcdef/i)

    const resolved = resolvePendingScanGroup(library.id, refreshed.id, {
      expectedRevision: refreshed.revision,
      assignments
    })
    const stored = getDb()
      .prepare(
        `SELECT library_id, root_id, locator, strm_source_path
           FROM video_resources WHERE video_id = ?`
      )
      .get(resolved.createdVideoIds[0]) as {
      library_id: number
      root_id: number
      locator: string
      strm_source_path: string
    }
    assert.equal(stored.library_id, library.id)
    assert.equal(stored.root_id, library.rootId)
    assert.equal(stored.locator, `magnet:?xt=urn:btih:${infoHash}&dn=New`)
    assert.equal(stored.strm_source_path, sourcePath)
  })

  it('moves an already-pending path to the new same-library code without leaving an empty group', () => {
    setupDb()
    const library = createTestLibrary('Move')
    const input = localInput(library, 'MOVE-001.mp4')
    const first = upsertPendingScanResources(library.id, 'MOVE-001', [input])

    const second = upsertPendingScanResources(library.id, 'MOVE-002', [input])

    assert.equal(second.addedResources, 0)
    assert.equal(getPendingScanGroup(library.id, first.groupId), null)
    assert.equal(getPendingScanGroup(library.id, second.groupId)?.normalizedCode, 'MOVE-002')
    assert.equal(listPendingScanGroups(library.id).length, 1)
  })

  it('rolls back resources, memberships, and videos if final group deletion fails', () => {
    setupDb()
    const library = createTestLibrary('Rollback')
    const upsert = upsertPendingScanResources(library.id, 'ROLL-001', [
      localInput(library, 'ROLL-001.mp4')
    ])
    const group = getPendingScanGroup(library.id, upsert.groupId)!
    getDb().exec(`
      CREATE TRIGGER fail_pending_scan_group_delete
      BEFORE DELETE ON pending_scan_groups
      BEGIN
        SELECT RAISE(ABORT, 'forced pending scan delete failure');
      END;
    `)

    assert.throws(
      () =>
        resolvePendingScanGroup(library.id, group.id, {
          expectedRevision: group.revision,
          assignments: [
            {
              resourceId: group.resources[0].id,
              target: { kind: 'new', groupKey: 'one' }
            }
          ]
        }),
      /forced pending scan delete failure/
    )
    const counts = getDb()
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM videos) AS videos,
           (SELECT COUNT(*) FROM video_resources) AS resources,
           (SELECT COUNT(*) FROM library_video_memberships) AS memberships`
      )
      .get() as { videos: number; resources: number; memberships: number }
    assert.deepEqual(counts, { videos: 0, resources: 0, memberships: 0 })
    assert.equal(getPendingScanGroup(library.id, group.id)?.resources.length, 1)
  })
})
