import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getPathAlias } from './assetPathAliases'
import { isOpaqueEncFilename } from './assetPathNaming'
import { MediaAssetStore, mediaAssetStore } from './mediaAssetStore'
import { encryptPlain, resetAssetKeyCacheForTests } from './assetCrypto'

const JPEG_1X1 = Buffer.from(
  'ffd8ffe000104a4649460000010101004800480000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191082242b1c11552d1f0243362728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f007b941100ffd9',
  'hex'
)

let root: string | null = null

function setup(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-media-store-'))
  process.env.JAVDEX_TEST_USER_DATA = root
  return root
}

afterEach(() => {
  resetAssetKeyCacheForTests()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
  delete process.env.JAVDEX_TEST_USER_DATA
})

describe('MediaAssetStore', () => {
  it('reads plain and encrypted images and reports a stable plaintext fingerprint', () => {
    const testRoot = setup()
    const plainPath = mediaAssetStore.importAvatarDisplay('Plain', 1, JPEG_1X1)
    assert.deepEqual(mediaAssetStore.readBytes(plainPath), JPEG_1X1)
    const plainInspection = mediaAssetStore.inspectImage(plainPath)
    assert.equal(plainInspection.usable, true)
    assert.equal(plainInspection.fingerprint, mediaAssetStore.fingerprint(JPEG_1X1))

    const encryptedPath = 'avatars/encrypted-test.enc'
    const absolutePath = path.join(testRoot, 'media_assets', encryptedPath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, encryptPlain(JPEG_1X1, '.jpg'))
    assert.deepEqual(mediaAssetStore.readBytes(encryptedPath), JPEG_1X1)
    assert.equal(mediaAssetStore.inspectImage(encryptedPath).usable, true)
  })

  it('rejects stored paths that escape the media root', () => {
    setup()
    assert.throws(() => mediaAssetStore.resolve('../outside.jpg'), /escapes media root/)
    assert.throws(() => mediaAssetStore.resolve(path.resolve('outside.jpg')), /escapes media root/)
  })

  it('exposes bootstrap and layout paths under the media root', () => {
    const testRoot = setup()
    mediaAssetStore.ensureReady()
    const root = mediaAssetStore.rootPath()
    assert.equal(root, path.join(testRoot, 'media_assets'))
    assert.equal(mediaAssetStore.subdirPath('covers'), path.join(root, 'covers'))
    assert.equal(fs.existsSync(mediaAssetStore.subdirPath('playlist_covers')), true)
  })

  it('encrypts a stored plain asset and lists it under stable subdirectories', () => {
    setup()
    mediaAssetStore.ensureReady()
    const plainRel = 'covers/MIG-001_abcd1234.jpg'
    fs.writeFileSync(mediaAssetStore.resolve(plainRel), JPEG_1X1)

    assert.deepEqual(mediaAssetStore.listStoredImageAssetRels(), [plainRel])
    const rewrite = mediaAssetStore.encryptStoredAsset(plainRel)
    assert.ok(rewrite)
    assert.equal(rewrite.fromRel, plainRel)
    assert.equal(rewrite.toRel.startsWith('covers/'), true)
    assert.equal(rewrite.toRel.endsWith('.enc'), true)
    assert.equal(isOpaqueEncFilename(path.posix.basename(rewrite.toRel)), true)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(plainRel)), false)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(rewrite.toRel)), true)
    assert.equal(getPathAlias(rewrite.toRel), plainRel)
    assert.deepEqual(mediaAssetStore.listStoredImageAssetRels(), [rewrite.toRel])
  })

  it('decrypts a stored encrypted asset back to its plain relative path', () => {
    setup()
    mediaAssetStore.ensureReady()
    const plainRel = 'covers/MIG-002_abcd1234.jpg'
    fs.writeFileSync(mediaAssetStore.resolve(plainRel), JPEG_1X1)
    const encrypted = mediaAssetStore.encryptStoredAsset(plainRel)
    assert.ok(encrypted)

    const rewrite = mediaAssetStore.decryptStoredAsset(encrypted.toRel)
    assert.ok(rewrite)
    assert.equal(rewrite.fromRel, encrypted.toRel)
    assert.equal(rewrite.toRel, plainRel)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(encrypted.toRel)), false)
    assert.deepEqual(mediaAssetStore.readBytes(plainRel), JPEG_1X1)
    mediaAssetStore.clearPathAliases()
    assert.equal(getPathAlias(encrypted.toRel) ?? null, null)
  })

  it('compensates newly-created resources when the database operation fails', () => {
    setup()
    let createdPath = ''
    assert.throws(
      () =>
        mediaAssetStore.coordinateDatabaseChange(() => {
          createdPath = mediaAssetStore.importAvatarDisplay('测试演员', 7, JPEG_1X1)
          assert.equal(fs.existsSync(mediaAssetStore.resolve(createdPath)), true)
          throw new Error('database failed')
        }),
      /database failed/
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(createdPath)), false)
  })

  it('compensates newly imported cover and sample files when a database operation fails', () => {
    const testRoot = setup()
    const sourcePath = path.join(testRoot, 'source.jpg')
    fs.writeFileSync(sourcePath, JPEG_1X1)
    let coverPath = ''
    let samplePath = ''
    assert.throws(() => mediaAssetStore.coordinateDatabaseChange(() => {
      coverPath = mediaAssetStore.importCover('TEST-001', sourcePath)
      samplePath = mediaAssetStore.importSample('TEST-001', sourcePath)
      throw new Error('database failed')
    }), /database failed/)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(coverPath)), false)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(samplePath)), false)
  })

  it('compensates newly imported playlist covers when a database operation fails', () => {
    const testRoot = setup()
    const sourcePath = path.join(testRoot, 'playlist-cover.jpg')
    fs.writeFileSync(sourcePath, JPEG_1X1)
    let coverPath = ''
    assert.throws(() => mediaAssetStore.coordinateDatabaseChange(() => {
      coverPath = mediaAssetStore.importPlaylistCover('Watch Later', sourcePath)
      throw new Error('database failed')
    }), /database failed/)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(coverPath)), false)
  })

  it('compensates async downloads when the database operation fails', async () => {
    setup()
    let createdPath = ''
    await assert.rejects(
      () =>
        mediaAssetStore.coordinateDatabaseChange(async () => {
          createdPath = mediaAssetStore.importAvatarDisplay('测试演员', 9, JPEG_1X1)
          await Promise.resolve()
          throw new Error('async database failed')
        }),
      /async database failed/
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(createdPath)), false)
  })

  it('rejects unusable avatar downloads instead of storing them', async () => {
    setup()
    const storedPath = await mediaAssetStore.downloadAvatar(
      'Bad Avatar',
      'https://example.test/avatar.html',
      async () => Buffer.from('<html>not an image</html>')
    )
    assert.equal(storedPath, null)
    const avatarDir = mediaAssetStore.subdirPath('avatars')
    assert.equal(fs.existsSync(avatarDir) ? fs.readdirSync(avatarDir).length : 0, 0)
  })

  it('deletes obsolete resources only after the database operation succeeds', () => {
    setup()
    const storedPath = mediaAssetStore.importAvatarDisplay('测试演员', 8, JPEG_1X1)
    const absolutePath = mediaAssetStore.resolve(storedPath)
    mediaAssetStore.coordinateDatabaseChange(() => {
      mediaAssetStore.deleteBestEffort(storedPath)
      assert.equal(fs.existsSync(absolutePath), true)
    })
    assert.equal(fs.existsSync(absolutePath), false)
  })

  it('discards newly created resources marked obsolete in the same coordinated change', () => {
    setup()
    let createdPath = ''
    mediaAssetStore.coordinateDatabaseChange(() => {
      createdPath = mediaAssetStore.importAvatarDisplay('测试演员', 10, JPEG_1X1)
      mediaAssetStore.deleteBestEffort(createdPath)
      assert.equal(fs.existsSync(mediaAssetStore.resolve(createdPath)), true)
    })
    assert.equal(fs.existsSync(mediaAssetStore.resolve(createdPath)), false)
  })

  it('promotes nested created resources so a parent rollback can compensate them', () => {
    setup()
    let nestedPath = ''
    assert.throws(
      () =>
        mediaAssetStore.coordinateDatabaseChange(() => {
          mediaAssetStore.coordinateDatabaseChange(() => {
            nestedPath = mediaAssetStore.importAvatarDisplay('测试演员', 11, JPEG_1X1)
          })
          assert.equal(fs.existsSync(mediaAssetStore.resolve(nestedPath)), true)
          throw new Error('parent failed')
        }),
      /parent failed/
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(nestedPath)), false)
  })

  it('defers nested obsolete deletes of pre-existing files until the parent commits', () => {
    setup()
    const oldPath = mediaAssetStore.importAvatarDisplay('测试演员', 20, JPEG_1X1)
    let newPath = ''
    mediaAssetStore.coordinateDatabaseChange(() => {
      mediaAssetStore.coordinateDatabaseChange(() => {
        newPath = mediaAssetStore.importAvatarDisplay('测试演员', 20, JPEG_1X1)
        mediaAssetStore.deleteBestEffort(oldPath)
      })
      assert.equal(fs.existsSync(mediaAssetStore.resolve(oldPath)), true)
      assert.equal(fs.existsSync(mediaAssetStore.resolve(newPath)), true)
    })
    assert.equal(fs.existsSync(mediaAssetStore.resolve(oldPath)), false)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(newPath)), true)
  })

  it('keeps nested obsolete pre-existing files when the parent rolls back', () => {
    setup()
    const oldPath = mediaAssetStore.importAvatarDisplay('测试演员', 21, JPEG_1X1)
    let nestedPath = ''
    assert.throws(
      () =>
        mediaAssetStore.coordinateDatabaseChange(() => {
          mediaAssetStore.coordinateDatabaseChange(() => {
            nestedPath = mediaAssetStore.importAvatarDisplay('测试演员', 21, JPEG_1X1)
            mediaAssetStore.deleteBestEffort(oldPath)
          })
          throw new Error('parent failed')
        }),
      /parent failed/
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(oldPath)), true)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(nestedPath)), false)
  })

  it('does not leak nested create-then-obsolete files when the parent rolls back', () => {
    setup()
    let discardedPath = ''
    assert.throws(
      () =>
        mediaAssetStore.coordinateDatabaseChange(() => {
          mediaAssetStore.coordinateDatabaseChange(() => {
            discardedPath = mediaAssetStore.importAvatarDisplay('测试演员', 22, JPEG_1X1)
            mediaAssetStore.deleteBestEffort(discardedPath)
          })
          throw new Error('parent failed')
        }),
      /parent failed/
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(discardedPath)), false)
  })

  it('runInCoordinatedChange joins an active parent instead of nesting', () => {
    setup()
    let joinedPath = ''
    assert.throws(
      () =>
        mediaAssetStore.coordinateDatabaseChange(() => {
          mediaAssetStore.runInCoordinatedChange(() => {
            joinedPath = mediaAssetStore.importAvatarDisplay('测试演员', 23, JPEG_1X1)
          })
          throw new Error('parent failed')
        }),
      /parent failed/
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(joinedPath)), false)
  })

  it('keeps isolated coordinated creates when an outer parent later rolls back', () => {
    setup()
    let isolatedPath = ''
    assert.throws(
      () =>
        mediaAssetStore.coordinateDatabaseChange(() => {
          mediaAssetStore.coordinateDatabaseChangeIsolated(() => {
            isolatedPath = mediaAssetStore.importAvatarDisplay('Isolated', 40, JPEG_1X1)
          })
          throw new Error('parent failed')
        }),
      /parent failed/
    )
    assert.equal(fs.existsSync(mediaAssetStore.resolve(isolatedPath)), true)
  })

  it('keeps independent root work when an awaited outer coordinated change fails', async () => {
    setup()
    let outerPath = ''
    let siblingPath = ''
    let releaseOuter!: () => void
    const outerGate = new Promise<void>((resolve) => {
      releaseOuter = resolve
    })

    const outerPromise = mediaAssetStore.coordinateDatabaseChange(async () => {
      outerPath = mediaAssetStore.importAvatarDisplay('Outer', 12, JPEG_1X1)
      await outerGate
      throw new Error('outer failed')
    })

    await Promise.resolve()
    mediaAssetStore.coordinateDatabaseChange(() => {
      siblingPath = mediaAssetStore.importAvatarDisplay('Sibling', 13, JPEG_1X1)
    })
    releaseOuter()
    await assert.rejects(() => outerPromise, /outer failed/)

    assert.equal(fs.existsSync(mediaAssetStore.resolve(outerPath)), false)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(siblingPath)), true)
  })

  it('keeps caller registrations off an un-awaited nested async coordinated change', async () => {
    setup()
    let nestedPath = ''
    let callerPath = ''
    let releaseNested!: () => void
    const nestedGate = new Promise<void>((resolve) => {
      releaseNested = resolve
    })

    await mediaAssetStore.coordinateDatabaseChange(async () => {
      const nestedPromise = mediaAssetStore.coordinateDatabaseChange(async () => {
        await nestedGate
        nestedPath = mediaAssetStore.importAvatarDisplay('Nested', 30, JPEG_1X1)
        throw new Error('nested failed')
      })
      callerPath = mediaAssetStore.importAvatarDisplay('Caller', 31, JPEG_1X1)
      releaseNested()
      await assert.rejects(() => nestedPromise, /nested failed/)
      assert.equal(fs.existsSync(mediaAssetStore.resolve(callerPath)), true)
      assert.equal(fs.existsSync(mediaAssetStore.resolve(nestedPath)), false)
    })

    assert.equal(fs.existsSync(mediaAssetStore.resolve(callerPath)), true)
    assert.equal(fs.existsSync(mediaAssetStore.resolve(nestedPath)), false)
  })

  it('does not turn a post-commit cleanup failure into a database failure', () => {
    const testRoot = setup()
    const sourcePath = path.join(testRoot, 'source.jpg')
    fs.writeFileSync(sourcePath, JPEG_1X1)
    class FailingCleanupStore extends MediaAssetStore {
      override delete(): void {
        throw new Error('file is locked')
      }
    }
    const store = new FailingCleanupStore()
    const storedPath = store.importCover('TEST-002', sourcePath)
    assert.doesNotThrow(() => store.coordinateDatabaseChange(() => {
      store.deleteBestEffort(storedPath)
    }))
    assert.equal(fs.existsSync(store.resolve(storedPath)), true)
  })
})
