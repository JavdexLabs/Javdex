import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, initDatabaseAtPath } from '../db/database'
import { encryptPlain, resetAssetKeyCacheForTests } from './assetCrypto'
import { migrateMediaAssetsLocation } from './assetLocationMigration'
import { ASSET_PATH_ALIAS_FILENAME } from './assetPathAliases'
import { coversDir, ensureAssetDirs } from './assetService'
import { defaultMediaAssetsRoot, ensureMediaAssetDirsAt } from './assetStoragePaths'
import { resetSettingsCacheForTests, updateSettings } from '../settings/settingsStore'

let tempRoot: string | null = null
let oldRoot: string | null = null
let newRoot: string | null = null

const MIN_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9])

beforeEach(() => {
  resetAssetKeyCacheForTests()
  resetSettingsCacheForTests()
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-asset-loc-'))
  oldRoot = path.join(tempRoot, 'old_assets')
  newRoot = path.join(tempRoot, 'new_assets')
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  updateSettings({ mediaAssetsPath: oldRoot! })
  ensureAssetDirs()
})

afterEach(() => {
  resetAssetKeyCacheForTests()
  resetSettingsCacheForTests()
  closeDatabase()
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
  delete process.env.JAVDEX_TEST_USER_DATA
})

describe('assetLocationMigration', () => {
  it('moves plain and encrypted files including alias store', async () => {
    const plainName = 'IPX-535_ab12cd34.jpg'
    const encName = 'a1b2c3d4e5f67890.enc'
    fs.writeFileSync(path.join(coversDir(), plainName), MIN_JPEG)
    fs.writeFileSync(path.join(coversDir(), encName), encryptPlain(MIN_JPEG, '.jpg'))
    fs.writeFileSync(
      path.join(oldRoot!, ASSET_PATH_ALIAS_FILENAME),
      encryptPlain(Buffer.from(JSON.stringify({ [`covers/${encName}`]: `covers/${plainName}` })), '.json')
    )

    const stored = await migrateMediaAssetsLocation(oldRoot!, newRoot!, () => {})
    assert.equal(stored, newRoot)

    assert.equal(fs.existsSync(path.join(oldRoot!, 'covers', plainName)), false)
    assert.equal(fs.existsSync(path.join(newRoot!, 'covers', plainName)), true)
    assert.equal(fs.existsSync(path.join(newRoot!, 'covers', encName)), true)
    assert.equal(fs.existsSync(path.join(newRoot!, ASSET_PATH_ALIAS_FILENAME)), true)
  })

  it('maps default path setting when relocating back to userData', async () => {
    fs.writeFileSync(path.join(coversDir(), 'sample.jpg'), MIN_JPEG)
    const defaultRoot = defaultMediaAssetsRoot()
    const customRoot = path.join(tempRoot!, 'custom_assets')
    fs.mkdirSync(customRoot, { recursive: true })

    await migrateMediaAssetsLocation(oldRoot!, customRoot, () => {})
    const stored = await migrateMediaAssetsLocation(customRoot, defaultRoot, () => {})
    assert.equal(stored, '')
    assert.equal(fs.existsSync(path.join(defaultRoot, 'covers', 'sample.jpg')), true)
  })

  it('allows relocating back to default when only empty asset subfolders remain', async () => {
    fs.writeFileSync(path.join(coversDir(), 'sample.jpg'), MIN_JPEG)
    const defaultRoot = defaultMediaAssetsRoot()
    const customRoot = path.join(tempRoot!, 'custom_assets')
    fs.mkdirSync(customRoot, { recursive: true })

    await migrateMediaAssetsLocation(oldRoot!, customRoot, () => {})
    ensureMediaAssetDirsAt(defaultRoot)

    const stored = await migrateMediaAssetsLocation(customRoot, defaultRoot, () => {})
    assert.equal(stored, '')
    assert.equal(fs.existsSync(path.join(defaultRoot, 'covers', 'sample.jpg')), true)
  })
})
