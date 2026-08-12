import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { resetSettingsCacheForTests } from '../settings/settingsStore'
import { listLocalVideoResources, listVideoResources, listVideos } from '../db/videoRepo'
import { importManual, renameAndImport, scanFolders } from './scanner'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import {
  listPendingScanGroups,
  resolvePendingScanGroup,
  upsertPendingScanResources
} from '../db/pendingScanRepo'
import { selectPrimaryVideoResourceCandidate } from '../services/videoResourcePromotion'

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
    const targetDir = path.join(root, 'targets')
    fs.mkdirSync(library, { recursive: true })
    fs.mkdirSync(targetDir, { recursive: true })
    const targetPath = path.join(targetDir, 'source.mp4')
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
    const targetPath = path.join(root, 'target.mp4')
    const linkPath = path.join(library, 'IPX-780.mp4')
    fs.mkdirSync(library, { recursive: true })
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
    const targetPath = path.join(root, 'target.mp4')
    fs.mkdirSync(firstDir, { recursive: true })
    fs.mkdirSync(secondDir, { recursive: true })
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

  it('renames and imports only after an explicit target is supplied', async () => {
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

    const result = await renameAndImport(
      oldPath,
      'IPX-900-extra',
      ' ipx-900 ',
      { kind: 'existing', videoId: existing.videoId }
    )

    const renamedPath = path.join(library, 'IPX-900-extra.mp4')
    assert.deepEqual(result, {
      newPath: renamedPath,
      newName: 'IPX-900-extra.mp4',
      imported: true,
      code: 'IPX-900'
    })
    assert.equal(fs.existsSync(oldPath), false)
    assert.equal(fs.existsSync(renamedPath), true)
    assert.equal(
      listLocalVideoResources(existing.videoId).some((resource) => resource.locator === renamedPath),
      true
    )
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
    assert.equal(result.skipped, 1)
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
})
