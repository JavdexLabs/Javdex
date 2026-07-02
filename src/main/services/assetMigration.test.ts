import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { resetAssetKeyCacheForTests } from './assetCrypto'
import { migrateAssetStorage } from './assetMigration'
import { getPathAlias } from './assetPathAliases'
import { coversDir, ensureAssetDirs } from './assetService'
import { isOpaqueEncFilename } from './assetPathNaming'

let tempRoot: string | null = null

const MIN_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9
])

beforeEach(() => {
  resetAssetKeyCacheForTests()
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-asset-mig-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  ensureAssetDirs()
})

afterEach(() => {
  resetAssetKeyCacheForTests()
  closeDatabase()
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
  delete process.env.JAVDEX_TEST_USER_DATA
})

describe('assetMigration opaque paths', () => {
  it('encrypts to opaque paths and restores readable paths on decrypt', async () => {
    const plainName = 'IPX-535_ab12cd34.jpg'
    const plainRel = `covers/${plainName}`
    const plainAbs = path.join(coversDir(), plainName)
    fs.writeFileSync(plainAbs, MIN_JPEG)

    const db = getDb()
    db.prepare(
      `INSERT INTO videos (code, title, file_path, cover_path, scraped_status, add_time)
       VALUES ('IPX-535', 't', 'a.mp4', ?, 1, '2024-01-01')`
    ).run(plainRel)

    await migrateAssetStorage(true, () => {})

    assert.equal(fs.existsSync(plainAbs), false)
    const encFiles = fs.readdirSync(coversDir()).filter((name) => name.endsWith('.enc'))
    assert.equal(encFiles.length, 1)
    assert.equal(isOpaqueEncFilename(encFiles[0]), true)
    assert.equal(encFiles[0].includes('IPX'), false)

    const encRel = `covers/${encFiles[0]}`
    const row = db.prepare('SELECT cover_path FROM videos WHERE code = ?').get('IPX-535') as {
      cover_path: string
    }
    assert.equal(row.cover_path, encRel)
    assert.equal(getPathAlias(encRel), plainRel)

    await migrateAssetStorage(false, () => {})

    assert.equal(fs.existsSync(plainAbs), true)
    assert.equal(fs.readdirSync(coversDir()).some((name) => name.endsWith('.enc')), false)
    const restored = db.prepare('SELECT cover_path FROM videos WHERE code = ?').get('IPX-535') as {
      cover_path: string
    }
    assert.equal(restored.cover_path, plainRel)
  })
})
