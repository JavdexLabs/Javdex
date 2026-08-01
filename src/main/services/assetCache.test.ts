import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getOrLoadImageInspection,
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
