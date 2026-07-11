import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildActressAssetSeed,
  buildOpaqueAssetBase,
  buildOpaqueAssetBaseFromPlainRel,
  buildReadableAssetBase,
  isOpaqueEncFilename,
  sanitizeAssetSeed
} from './assetPathNaming'
import { createHash } from 'node:crypto'

describe('assetPathNaming', () => {
  it('builds readable bases with seed and url hash', () => {
    const base = buildReadableAssetBase('IPX-535', 'https://example.com/a.jpg')
    assert.match(base, /^IPX-535_[a-f0-9]{8}$/)
  })

  it('sanitizes non-ascii seeds and truncates overly long values', () => {
    const base = buildReadableAssetBase('波多野结衣', 'https://example.com/a.jpg')
    assert.match(base, /^[_a-zA-Z0-9-]+_[a-f0-9]{8}$/)
    assert.equal(base.includes('波'), false)
    assert.equal(sanitizeAssetSeed('A'.repeat(80)).length, 40)
  })

  it('keeps equal-length Chinese actress names on distinct asset seeds', () => {
    const a = buildActressAssetSeed('三上悠亚')
    const b = buildActressAssetSeed('桥本有菜')
    assert.notEqual(a, b)
    const hashA = createHash('md5').update('三上悠亚').digest('hex').slice(0, 8)
    assert.equal(a, `n${hashA}_actress`)
    assert.match(b, /^n[a-f0-9]{8}_actress$/)
  })

  it('scopes asset seeds by actress id when provided', () => {
    const sharedName = '波多野结衣'
    const a = buildActressAssetSeed(sharedName, 1)
    const b = buildActressAssetSeed(sharedName, 2)
    assert.notEqual(a, b)
    assert.match(a, /^a1_[a-f0-9]{8}_actress$/)
    assert.match(b, /^a2_[a-f0-9]{8}_actress$/)
  })

  it('keeps actress id prefix when the readable label is long', () => {
    const longName = 'A'.repeat(80)
    const seed = buildActressAssetSeed(longName, 99)
    assert.match(seed, /^a99_[a-f0-9]{8}_/)
    assert.equal(seed.length <= 40, true)
    assert.equal(sanitizeAssetSeed(seed), seed)
  })

  it('builds distinct gallery paths for equal-length Chinese names and the same url', () => {
    const url = 'https://example.com/gallery.jpg'
    const a = buildReadableAssetBase(buildActressAssetSeed('三上悠亚', 1), url)
    const b = buildReadableAssetBase(buildActressAssetSeed('桥本有菜', 2), url)
    assert.notEqual(a, b)
    assert.match(a, /^a1_[a-f0-9]{8}_actress_[a-f0-9]{8}$/)
    assert.match(b, /^a2_[a-f0-9]{8}_actress_[a-f0-9]{8}$/)
  })

  it('builds opaque bases without embedding seed text', () => {
    const base = buildOpaqueAssetBase('IPX-535', 'https://example.com/a.jpg')
    assert.match(base, /^[a-f0-9]{16}$/)
    assert.equal(base.includes('IPX'), false)
  })

  it('detects opaque encrypted filenames', () => {
    assert.equal(isOpaqueEncFilename('a1b2c3d4e5f67890.enc'), true)
    assert.equal(isOpaqueEncFilename('IPX-535_ab12cd34.enc'), false)
  })

  it('derives stable opaque names from plaintext relative paths', () => {
    const a = buildOpaqueAssetBaseFromPlainRel('covers/IPX-535_ab12cd34.jpg')
    const b = buildOpaqueAssetBaseFromPlainRel('covers/IPX-535_ab12cd34.jpg')
    assert.equal(a, b)
    assert.match(a, /^[a-f0-9]{16}$/)
  })
})
