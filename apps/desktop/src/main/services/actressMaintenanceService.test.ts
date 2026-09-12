import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { findActressByNameOrAlias, getActressDetail } from '@library/db/actressRepo'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { createActressMaintenanceService } from './actressMaintenanceService'

let tempRoot: string | null = null
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-actress-maintenance-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const db = getDb()
  const insertActress = db.prepare(
    'INSERT INTO actresses (main_name, avatar_path, avatar_source_path, gender) VALUES (?, ?, ?, ?)'
  )
  insertActress.run('Alpha', 'avatars/alpha.jpg', 'avatar_sources/alpha.jpg', 'female')
  insertActress.run('Beta', null, null, 'female')

  const insertName = db.prepare(
    "INSERT INTO actress_names (actress_id, name, type, is_primary) VALUES (?, ?, 'main', 1)"
  )
  const insertOwnership = db.prepare(
    'INSERT INTO actress_name_ownership (normalized_name, actress_id) VALUES (?, ?)'
  )
  insertName.run(1, 'Alpha')
  insertName.run(2, 'Beta')
  insertOwnership.run('alpha', 1)
  insertOwnership.run('beta', 2)

  db.prepare(
    `INSERT INTO actress_gallery_assets
      (actress_id, type, position, local_path, created_at)
     VALUES (1, 'gallery', 0, 'actress_gallery/alpha.jpg', 'now')`
  ).run()

  for (const relPath of [
    'avatars/alpha.jpg',
    'avatar_sources/alpha.jpg',
    'actress_gallery/alpha.jpg'
  ]) {
    const absolutePath = path.join(tempRoot, 'media_assets', relPath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, PNG_1X1)
  }
}

afterEach(() => {
  closeDatabase()
  delete process.env.JAVDEX_TEST_USER_DATA
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('actressMaintenanceService.importGalleryImage', () => {
  it('runs legacy dimension repair as part of the explicit gallery write flow', async () => {
    const calls: Array<number | undefined> = []
    const asset = { id: 9, actress_id: 7 } as never
    const service = createActressMaintenanceService({
      importGalleryImage: async () => asset,
      repairGalleryDimensions: (_database, actressId) => {
        calls.push(actressId)
        return 1
      }
    })

    assert.equal(await service.importGalleryImage(7, { source: 'file', sourcePath: 'x.jpg' }), asset)
    assert.deepEqual(calls, [7])
  })
})

describe('actressMaintenanceService.deleteActresses', () => {
  it('deletes the complete batch and cleans stored resources', () => {
    setupDb()
    const service = createActressMaintenanceService()

    const result = service.deleteActresses({ ids: [1, 2, 2], mode: 'only-unlinked' })

    assert.deepEqual(result, { deletedCount: 2, unlinkedVideoCount: 0, cleanupFailures: [] })
    assert.equal(getActressDetail(1), null)
    assert.equal(getActressDetail(2), null)
    assert.equal(findActressByNameOrAlias('Alpha'), null)
    assert.equal(findActressByNameOrAlias('Beta'), null)
    for (const relPath of [
      'avatars/alpha.jpg',
      'avatar_sources/alpha.jpg',
      'actress_gallery/alpha.jpg'
    ]) {
      assert.equal(fs.existsSync(path.join(tempRoot!, 'media_assets', relPath)), false)
    }
  })

  it('rejects the whole batch when an actress is linked to a video', () => {
    setupDb()
    const db = getDb()
    db.prepare("INSERT INTO videos (code, title) VALUES ('SAFE-001', 'Linked')").run()
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (1, 1)').run()
    const service = createActressMaintenanceService()

    assert.throws(
      () => service.deleteActresses({ ids: [1, 2], mode: 'only-unlinked' }),
      /1 位演员仍有关联影片，整批未删除/
    )
    assert.ok(getActressDetail(1))
    assert.ok(getActressDetail(2))
  })

  it('reports resource cleanup failures after the database transaction commits', () => {
    setupDb()
    const service = createActressMaintenanceService({
      deleteStoredAsset: (assetPath) => {
        if (assetPath === 'avatar_sources/alpha.jpg') throw new Error('file is locked')
      }
    })

    const result = service.deleteActresses({ ids: [1], mode: 'only-unlinked' })

    assert.equal(getActressDetail(1), null)
    assert.deepEqual(result, {
      deletedCount: 1,
      unlinkedVideoCount: 0,
      cleanupFailures: [{ path: 'avatar_sources/alpha.jpg', error: 'file is locked' }]
    })
  })

  it('rolls back the complete batch when a later record fails to delete', () => {
    setupDb()
    const db = getDb()
    db.exec(`
      CREATE TRIGGER fail_beta_actress_delete
      BEFORE DELETE ON actresses
      WHEN OLD.id = 2
      BEGIN
        SELECT RAISE(ABORT, 'forced actress delete failure');
      END;
    `)
    const service = createActressMaintenanceService()

    assert.throws(
      () => service.deleteActresses({ ids: [1, 2], mode: 'only-unlinked' }),
      /forced actress delete failure/
    )
    assert.ok(getActressDetail(1))
    assert.ok(getActressDetail(2))
    assert.ok(findActressByNameOrAlias('Alpha'))
    assert.ok(findActressByNameOrAlias('Beta'))
  })

  it('previews current linked-actress and affected-video counts', () => {
    setupDb()
    const db = getDb()
    db.prepare("INSERT INTO videos (code, title) VALUES ('IMPACT-001', 'One')").run()
    db.prepare("INSERT INTO videos (code, title) VALUES ('IMPACT-002', 'Two')").run()
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (1, 1), (2, 1)').run()

    assert.deepEqual(createActressMaintenanceService().previewDelete({ ids: [1, 2, 2] }), {
      actressCount: 2,
      linkedActressCount: 1,
      affectedVideoCount: 2
    })
  })

  it('explicitly unlinks videos, deletes a mixed batch, and preserves video records and files', () => {
    setupDb()
    const db = getDb()
    const videoPath = path.join(tempRoot!, 'linked.mp4')
    fs.writeFileSync(videoPath, 'video')
    insertTestVideoWithFile(db, {
      code: 'UNLINK-001',
      filePath: videoPath,
      title: 'Linked',
      addTime: '2024-01-01'
    })
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (1, 1)').run()
    const service = createActressMaintenanceService()

    const result = service.deleteActresses({
      ids: [1, 2],
      mode: 'unlink-videos-and-delete'
    })

    assert.equal(result.deletedCount, 2)
    assert.equal(result.unlinkedVideoCount, 1)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM videos').get() as { n: number }).n, 1)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM video_actress').get() as { n: number }).n, 0)
    assert.equal(fs.existsSync(videoPath), true)
    assert.equal(getActressDetail(1), null)
    assert.equal(getActressDetail(2), null)
  })

  it('rolls back removed video links when a later actress delete fails', () => {
    setupDb()
    const db = getDb()
    db.prepare("INSERT INTO videos (code, title) VALUES ('ROLLBACK-001', 'Linked')").run()
    db.prepare('INSERT INTO video_actress (video_id, actress_id) VALUES (1, 1)').run()
    db.exec(`
      CREATE TRIGGER fail_linked_batch_delete
      BEFORE DELETE ON actresses
      WHEN OLD.id = 2
      BEGIN
        SELECT RAISE(ABORT, 'forced linked batch delete failure');
      END;
    `)

    assert.throws(
      () => createActressMaintenanceService().deleteActresses({
        ids: [1, 2],
        mode: 'unlink-videos-and-delete'
      }),
      /forced linked batch delete failure/
    )
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM video_actress').get() as { n: number }).n, 1)
    assert.ok(getActressDetail(1))
    assert.ok(getActressDetail(2))
  })

  it('removes only the deleted actress ownership and pending result', () => {
    setupDb()
    const db = getDb()
    const insertPending = db.prepare(
      `INSERT INTO pending_actress_scrapes
        (actress_id, target_actress_revision, plugin_name, plugin_source, query_name,
         selected_fields_json, applicable_fields_json, update_mode, result_json,
         warnings_json, created_at)
       VALUES (?, 0, 'test', 'builtin', ?, '[]', '[]', 'fillEmpty', '{}', '[]', 'now')`
    )
    insertPending.run(1, 'Alpha')
    insertPending.run(2, 'Beta')

    createActressMaintenanceService().deleteActresses({
      ids: [1],
      mode: 'only-unlinked'
    })

    assert.equal(findActressByNameOrAlias('Alpha'), null)
    assert.equal(findActressByNameOrAlias('Beta'), 2)
    assert.deepEqual(
      (
        db.prepare(
          'SELECT actress_id FROM pending_actress_scrapes ORDER BY actress_id'
        ).all() as Array<{ actress_id: number }>
      ).map((row) => row.actress_id),
      [2]
    )
  })

  it('rejects an unknown delete mode instead of falling through to a destructive path', () => {
    setupDb()
    assert.throws(
      () => createActressMaintenanceService().deleteActresses({
        ids: [1],
        mode: 'force' as never
      }),
      /不支持的演员删除模式/
    )
    assert.ok(getActressDetail(1))
  })
})
