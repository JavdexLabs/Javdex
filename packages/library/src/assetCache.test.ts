import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getOrLoadImageInspection,
  getCachedAsset,
  setCachedAsset,
  invalidateAssetCache,
  type ImageAssetSignature
} from './assetCache'

const signature: ImageAssetSignature = {
  resolvedPath: 'C:/assets/avatars/a.jpg',
  mtimeMs: 100,
  ctimeMs: 90,
  size: 2048
}

afterEach(() => invalidateAssetCache())

const byteSignature = { ...signature, device: 1, inode: 2 }

describe('asset byte cache', () => {
  it('separates variants and invalidates all variants of only the changed asset', () => {
    for (const variant of ['original', 'thumbnail-v1-320', 'thumbnail-v1-640']) {
      setCachedAsset('image', byteSignature, Buffer.from(variant), 'image/webp', variant)
      assert.equal(getCachedAsset('image', byteSignature, variant)?.body.toString(), variant)
    }
    setCachedAsset('other', byteSignature, Buffer.from('other'), 'image/webp', 'thumbnail-v1-320')
    invalidateAssetCache('image')
    for (const variant of ['original', 'thumbnail-v1-320', 'thumbnail-v1-640']) assert.equal(getCachedAsset('image', byteSignature, variant), null)
    assert.equal(getCachedAsset('other', byteSignature, 'thumbnail-v1-320')?.body.toString(), 'other')
  })
  it('checks every file identity field and isolates callers from cached mutable buffers', () => {
    const body = Buffer.from('image')
    setCachedAsset('image', byteSignature, body, 'image/png')
    body.fill(0)
    const first = getCachedAsset('image', byteSignature)!
    assert.equal(first.body.toString(), 'image')
    first.body.fill(0)
    assert.equal(getCachedAsset('image', byteSignature)?.body.toString(), 'image')
    for (const changed of [
      { resolvedPath: 'another-root/image' }, { mtimeMs: 101 }, { ctimeMs: 91 },
      { size: 2049 }, { device: 2 }, { inode: 3 }
    ]) assert.equal(getCachedAsset('image', { ...byteSignature, ...changed }), null)
    invalidateAssetCache('image')
    assert.equal(getCachedAsset('image', byteSignature), null)
  })

  it('enforces the entry cap while retaining recently read and replaced entries', () => {
    for (let i = 0; i < 256; i++) setCachedAsset(String(i), byteSignature, Buffer.from('a'), 'image/png')
    getCachedAsset('0', byteSignature)
    setCachedAsset('1', byteSignature, Buffer.from('b'), 'image/png')
    setCachedAsset('new', byteSignature, Buffer.from('c'), 'image/png')
    assert.ok(getCachedAsset('0', byteSignature))
    assert.equal(getCachedAsset('1', byteSignature)?.body.toString(), 'b')
    assert.equal(getCachedAsset('2', byteSignature), null)
  })

  it('enforces the 96MiB byte cap and skips oversized entries without flushing other images', () => {
    const chunk = Buffer.alloc(32 * 1024 * 1024)
    for (let i = 0; i < 4; i++) setCachedAsset(String(i), byteSignature, chunk, 'image/png')
    assert.equal(getCachedAsset('0', byteSignature), null)
    assert.ok(getCachedAsset('1', byteSignature))
    setCachedAsset('huge', byteSignature, Buffer.alloc(96 * 1024 * 1024 + 1), 'image/png')
    assert.equal(getCachedAsset('huge', byteSignature), null)
    assert.ok(getCachedAsset('1', byteSignature))
    invalidateAssetCache()
    assert.equal(getCachedAsset('1', byteSignature), null)
  })
})

describe('image asset inspection cache', () => {
  it('loads an unchanged image once and reloads it when its file signature changes', () => {
    let loads = 0
    const load = () => {
      loads += 1
      return { usable: true, fingerprint: `fp-${loads}` }
    }

    assert.equal(getOrLoadImageInspection('avatars/a.jpg', signature, load).fingerprint, 'fp-1')
    assert.equal(getOrLoadImageInspection('avatars/a.jpg', signature, load).fingerprint, 'fp-1')
    assert.equal(loads, 1)

    assert.equal(
      getOrLoadImageInspection('avatars/a.jpg', { ...signature, mtimeMs: 101 }, load)
        .fingerprint,
      'fp-2'
    )
    assert.equal(loads, 2)
  })

  it('reloads an image after explicit asset invalidation', () => {
    let loads = 0
    const load = () => ({ usable: true, fingerprint: `fp-${++loads}` })

    getOrLoadImageInspection('avatars/a.jpg', signature, load)
    invalidateAssetCache('avatars/a.jpg')
    assert.equal(getOrLoadImageInspection('avatars/a.jpg', signature, load).fingerprint, 'fp-2')
  })

  it('evicts the least recently used inspection after reaching capacity', () => {
    let firstLoads = 0
    const firstSignature = { ...signature, resolvedPath: 'C:/assets/avatars/0.jpg' }

    getOrLoadImageInspection('avatars/0.jpg', firstSignature, () => ({
      usable: true,
      fingerprint: `first-${++firstLoads}`
    }))

    for (let index = 1; index <= 256; index += 1) {
      getOrLoadImageInspection(
        `avatars/${index}.jpg`,
        { ...signature, resolvedPath: `C:/assets/avatars/${index}.jpg` },
        () => ({ usable: true, fingerprint: `fp-${index}` })
      )
    }

    assert.equal(
      getOrLoadImageInspection('avatars/0.jpg', firstSignature, () => ({
        usable: true,
        fingerprint: `first-${++firstLoads}`
      })).fingerprint,
      'first-2'
    )
  })
})
