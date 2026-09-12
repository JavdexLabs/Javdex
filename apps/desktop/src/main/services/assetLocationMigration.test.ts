import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { encryptPlain, resetAssetKeyCacheForTests } from './assetCrypto'
import { prepareMediaAssetsLocationMigration } from './assetLocationMigration'
import { ASSET_PATH_ALIAS_FILENAME } from './assetPathAliases'
import { mediaAssetStore } from './mediaAssetStore'
import { defaultMediaAssetsRoot, ensureMediaAssetDirsAt } from './assetStoragePaths'
import { resetSettingsCacheForTests, updateSettings } from '../settings/settingsStore'

let tempRoot: string | null = null
let oldRoot: string | null = null
let newRoot: string | null = null

const MIN_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9])

function removeTempPath(target: string): void {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })
}

function statIfAvailable(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath)
  } catch {
    return null
  }
}

beforeEach(() => {
  resetAssetKeyCacheForTests()
  resetSettingsCacheForTests()
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-asset-loc-'))
  oldRoot = path.join(tempRoot, 'old_assets')
  newRoot = path.join(tempRoot, 'new_assets')
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  updateSettings({ mediaAssetsPath: oldRoot! })
  mediaAssetStore.ensureReady()
})

afterEach(() => {
  resetAssetKeyCacheForTests()
  resetSettingsCacheForTests()
  closeDatabase()
  if (tempRoot) {
    try {
      removeTempPath(tempRoot)
    } catch {
      // Windows junctions that point at their parent can leave an unresolvable tree.
    }
    tempRoot = null
  }
  delete process.env.JAVDEX_TEST_USER_DATA
})

describe('assetLocationMigration', () => {
  it('moves plain and encrypted files including alias store', async () => {
    const plainName = 'IPX-535_ab12cd34.jpg'
    const encName = 'a1b2c3d4e5f67890.enc'
    fs.writeFileSync(path.join(mediaAssetStore.subdirPath('covers'), plainName), MIN_JPEG)
    fs.writeFileSync(path.join(mediaAssetStore.subdirPath('covers'), encName), encryptPlain(MIN_JPEG, '.jpg'))
    fs.writeFileSync(
      path.join(oldRoot!, ASSET_PATH_ALIAS_FILENAME),
      encryptPlain(Buffer.from(JSON.stringify({ [`covers/${encName}`]: `covers/${plainName}` })), '.json')
    )

    const migration = await prepareMediaAssetsLocationMigration(oldRoot!, newRoot!, () => {})
    assert.equal(migration.storedPath, newRoot)
    migration.commit()

    assert.equal(fs.existsSync(path.join(oldRoot!, 'covers', plainName)), false)
    assert.equal(fs.existsSync(path.join(newRoot!, 'covers', plainName)), true)
    assert.equal(fs.existsSync(path.join(newRoot!, 'covers', encName)), true)
    assert.equal(fs.existsSync(path.join(newRoot!, ASSET_PATH_ALIAS_FILENAME)), true)
  })

  it('maps default path setting when relocating back to userData', async () => {
    fs.writeFileSync(path.join(mediaAssetStore.subdirPath('covers'), 'sample.jpg'), MIN_JPEG)
    const defaultRoot = defaultMediaAssetsRoot()
    const customRoot = path.join(tempRoot!, 'custom_assets')
    fs.mkdirSync(customRoot, { recursive: true })

    const first = await prepareMediaAssetsLocationMigration(oldRoot!, customRoot, () => {})
    first.commit()
    const second = await prepareMediaAssetsLocationMigration(customRoot, defaultRoot, () => {})
    assert.equal(second.storedPath, '')
    second.commit()
    assert.equal(fs.existsSync(path.join(defaultRoot, 'covers', 'sample.jpg')), true)
  })

  it('allows relocating back to default when only empty asset subfolders remain', async () => {
    fs.writeFileSync(path.join(mediaAssetStore.subdirPath('covers'), 'sample.jpg'), MIN_JPEG)
    const defaultRoot = defaultMediaAssetsRoot()
    const customRoot = path.join(tempRoot!, 'custom_assets')
    fs.mkdirSync(customRoot, { recursive: true })

    const first = await prepareMediaAssetsLocationMigration(oldRoot!, customRoot, () => {})
    first.commit()
    ensureMediaAssetDirsAt(defaultRoot)

    const second = await prepareMediaAssetsLocationMigration(customRoot, defaultRoot, () => {})
    assert.equal(second.storedPath, '')
    second.commit()
    assert.equal(fs.existsSync(path.join(defaultRoot, 'covers', 'sample.jpg')), true)
  })

  it('rolls back copied files without touching the active root', async () => {
    const assetPath = path.join(mediaAssetStore.subdirPath('covers'), 'rollback.jpg')
    fs.writeFileSync(assetPath, MIN_JPEG)

    const migration = await prepareMediaAssetsLocationMigration(oldRoot!, newRoot!, () => {})
    assert.equal(fs.existsSync(path.join(newRoot!, 'covers', 'rollback.jpg')), true)
    migration.rollback()

    assert.equal(fs.existsSync(assetPath), true)
    assert.equal(fs.existsSync(path.join(newRoot!, 'covers', 'rollback.jpg')), false)
  })

  it('rejects migration while the configured source root is unavailable', async () => {
    fs.rmSync(oldRoot!, { recursive: true, force: true })

    await assert.rejects(
      () => prepareMediaAssetsLocationMigration(oldRoot!, newRoot!, () => {}),
      /源媒体资源目录当前不可用/
    )
    assert.equal(fs.existsSync(newRoot!), false)
  })

  it('rejects targets nested inside the active media root', async () => {
    const source = path.join(mediaAssetStore.subdirPath('covers'), 'nested.jpg')
    fs.writeFileSync(source, 'source')
    const nestedTarget = path.join(oldRoot!, 'relocated')

    await assert.rejects(
      () => prepareMediaAssetsLocationMigration(oldRoot!, nestedTarget, () => {}),
      /不能相互嵌套/
    )
    assert.equal(fs.readFileSync(source, 'utf8'), 'source')
    assert.equal(fs.existsSync(nestedTarget), false)
  })

  it('rejects a target that resolves to the source through a symlinked parent', async () => {
    const source = path.join(mediaAssetStore.subdirPath('covers'), 'same-root.jpg')
    fs.writeFileSync(source, 'source')
    const aliasParent = path.join(tempRoot!, 'alias-parent')
    fs.symlinkSync(tempRoot!, aliasParent, process.platform === 'win32' ? 'junction' : 'dir')
    const aliasedTarget = path.join(aliasParent, path.basename(oldRoot!))

    try {
      await assert.rejects(
        () => prepareMediaAssetsLocationMigration(oldRoot!, aliasedTarget, () => {}),
        /实际指向同一位置/
      )
      assert.equal(fs.readFileSync(source, 'utf8'), 'source')
    } finally {
      try {
        fs.unlinkSync(aliasParent)
      } catch {
        removeTempPath(aliasParent)
      }
    }
  })

  it('rejects a differently-cased path that resolves to the same directory', async () => {
    const caseAlias = path.join(path.dirname(oldRoot!), path.basename(oldRoot!).toUpperCase())
    const aliasStat = statIfAvailable(caseAlias)
    const sourceStat = fs.statSync(oldRoot!)
    if (!aliasStat || aliasStat.dev !== sourceStat.dev || aliasStat.ino !== sourceStat.ino) return

    const source = path.join(mediaAssetStore.subdirPath('covers'), 'case-alias.jpg')
    fs.writeFileSync(source, 'source')
    await assert.rejects(
      () => prepareMediaAssetsLocationMigration(oldRoot!, caseAlias, () => {}),
      /实际指向同一位置/
    )
    assert.equal(fs.readFileSync(source, 'utf8'), 'source')
  })

  it('resumes when the target contains matching files from an interrupted copy', async () => {
    const firstSource = path.join(mediaAssetStore.subdirPath('covers'), 'first.jpg')
    const secondSource = path.join(mediaAssetStore.subdirPath('covers'), 'second.jpg')
    fs.writeFileSync(firstSource, Buffer.from('first'))
    fs.writeFileSync(secondSource, Buffer.from('second'))
    const resumedTarget = path.join(newRoot!, 'covers', 'first.jpg')
    fs.mkdirSync(path.dirname(resumedTarget), { recursive: true })
    fs.copyFileSync(firstSource, resumedTarget)

    const migration = await prepareMediaAssetsLocationMigration(oldRoot!, newRoot!, () => {})
    migration.commit()

    assert.equal(fs.readFileSync(resumedTarget, 'utf8'), 'first')
    assert.equal(fs.readFileSync(path.join(newRoot!, 'covers', 'second.jpg'), 'utf8'), 'second')
    assert.equal(fs.existsSync(firstSource), false)
    assert.equal(fs.existsSync(secondSource), false)
  })

  it('preserves pre-existing matching copies when a resumed migration rolls back', async () => {
    const firstSource = path.join(mediaAssetStore.subdirPath('covers'), 'first.jpg')
    const secondSource = path.join(mediaAssetStore.subdirPath('covers'), 'second.jpg')
    fs.writeFileSync(firstSource, Buffer.from('first'))
    fs.writeFileSync(secondSource, Buffer.from('second'))
    const existingTarget = path.join(newRoot!, 'covers', 'first.jpg')
    const newTarget = path.join(newRoot!, 'covers', 'second.jpg')
    fs.mkdirSync(path.dirname(existingTarget), { recursive: true })
    fs.copyFileSync(firstSource, existingTarget)

    const migration = await prepareMediaAssetsLocationMigration(oldRoot!, newRoot!, () => {})
    migration.rollback()

    assert.equal(fs.readFileSync(existingTarget, 'utf8'), 'first')
    assert.equal(fs.existsSync(newTarget), false)
    assert.equal(fs.readFileSync(firstSource, 'utf8'), 'first')
    assert.equal(fs.readFileSync(secondSource, 'utf8'), 'second')
  })

  it('keeps source files when the prepared target disappears before commit', async () => {
    const source = path.join(mediaAssetStore.subdirPath('covers'), 'offline-target.jpg')
    fs.writeFileSync(source, 'source')
    const migration = await prepareMediaAssetsLocationMigration(oldRoot!, newRoot!, () => {})
    fs.rmSync(newRoot!, { recursive: true, force: true })

    assert.throws(() => migration.commit(), /目标媒体资源目录当前不可用/)
    assert.equal(fs.readFileSync(source, 'utf8'), 'source')
    migration.rollback()
  })

  it('preserves a copied target that was replaced before a failed commit rolls back', async () => {
    const source = path.join(mediaAssetStore.subdirPath('covers'), 'replaced-target.jpg')
    const target = path.join(newRoot!, 'covers', 'replaced-target.jpg')
    fs.writeFileSync(source, 'source')
    const migration = await prepareMediaAssetsLocationMigration(oldRoot!, newRoot!, () => {})
    fs.writeFileSync(target, 'replacement')

    assert.throws(() => migration.commit(), /迁移期间发生变化/)
    migration.rollback()

    assert.equal(fs.readFileSync(source, 'utf8'), 'source')
    assert.equal(fs.readFileSync(target, 'utf8'), 'replacement')
  })

  it('rejects an interrupted target whose file contents do not match the source', async () => {
    const source = path.join(mediaAssetStore.subdirPath('covers'), 'conflict.jpg')
    const target = path.join(newRoot!, 'covers', 'conflict.jpg')
    fs.writeFileSync(source, 'source')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'other')

    await assert.rejects(
      () => prepareMediaAssetsLocationMigration(oldRoot!, newRoot!, () => {}),
      /包含其他媒体资源文件/
    )
    assert.equal(fs.readFileSync(source, 'utf8'), 'source')
    assert.equal(fs.readFileSync(target, 'utf8'), 'other')
  })

  it('rejects directory symlinks without reading or deleting files outside the asset root', async () => {
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-assets-external-'))
    const externalFile = path.join(externalRoot, 'outside.jpg')
    fs.writeFileSync(externalFile, 'outside')
    const linkPath = path.join(oldRoot!, 'covers', 'external-link')
    fs.symlinkSync(externalRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir')

    try {
      await assert.rejects(
        () => prepareMediaAssetsLocationMigration(oldRoot!, newRoot!, () => {}),
        /不能包含符号链接/
      )
      assert.equal(fs.readFileSync(externalFile, 'utf8'), 'outside')
      assert.equal(fs.existsSync(newRoot!), false)
    } finally {
      removeTempPath(linkPath)
      removeTempPath(externalRoot)
    }
  })

  it('rejects a symlinked asset root without touching its external target', async () => {
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-assets-root-link-'))
    const externalFile = path.join(externalRoot, 'outside.jpg')
    fs.writeFileSync(externalFile, 'outside')
    fs.rmSync(oldRoot!, { recursive: true, force: true })
    fs.symlinkSync(externalRoot, oldRoot!, process.platform === 'win32' ? 'junction' : 'dir')

    try {
      await assert.rejects(
        () => prepareMediaAssetsLocationMigration(oldRoot!, newRoot!, () => {}),
        /根目录不能是符号链接/
      )
      assert.equal(fs.readFileSync(externalFile, 'utf8'), 'outside')
      assert.equal(fs.existsSync(newRoot!), false)
    } finally {
      removeTempPath(oldRoot!)
      removeTempPath(externalRoot)
    }
  })
})
