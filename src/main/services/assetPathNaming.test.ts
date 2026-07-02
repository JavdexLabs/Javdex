import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildOpaqueAssetBase,
  buildOpaqueAssetBaseFromPlainRel,
  buildReadableAssetBase,
  isOpaqueEncFilename,
  sanitizeAssetSeed
} from './assetPathNaming'

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
