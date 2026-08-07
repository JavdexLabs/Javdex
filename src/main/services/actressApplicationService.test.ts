import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { findActressByNameOrAlias, getActressDetail } from '../db/actressRepo'
import { createActressApplicationService } from './actressApplicationService'

let tempRoot: string | null = null

function setupDb(): void {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-actress-application-'))
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
    fs.writeFileSync(absolutePath, 'asset')
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

describe('actressApplicationService.deleteUnlinkedActresses', () => {
  it('deletes the complete batch and cleans stored resources', () => {
    setupDb()
    const service = createActressApplicationService()

    const result = service.deleteUnlinkedActresses({ ids: [1, 2, 2] })

    assert.deepEqual(result, { deletedCount: 2, cleanupFailures: [] })
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
    const service = createActressApplicationService()

    assert.throws(
      () => service.deleteUnlinkedActresses({ ids: [1, 2] }),
      /1 位演员仍有关联影片，整批未删除/
    )
    assert.ok(getActressDetail(1))
    assert.ok(getActressDetail(2))
  })

  it('reports resource cleanup failures after the database transaction commits', () => {
    setupDb()
    const service = createActressApplicationService({
      deleteStoredAsset: (assetPath) => {
        if (assetPath === 'avatar_sources/alpha.jpg') throw new Error('file is locked')
      }
    })

    const result = service.deleteUnlinkedActresses({ ids: [1] })

    assert.equal(getActressDetail(1), null)
    assert.deepEqual(result, {
      deletedCount: 1,
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
    const service = createActressApplicationService()

    assert.throws(
      () => service.deleteUnlinkedActresses({ ids: [1, 2] }),
      /forced actress delete failure/
    )
    assert.ok(getActressDetail(1))
    assert.ok(getActressDetail(2))
    assert.ok(findActressByNameOrAlias('Alpha'))
    assert.ok(findActressByNameOrAlias('Beta'))
  })
})
