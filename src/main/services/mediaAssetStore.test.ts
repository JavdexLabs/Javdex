import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
