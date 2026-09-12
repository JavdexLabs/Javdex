import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createAvatarCropV1,
  parseAvatarCrop,
  scaleAvatarCropToViewSize
} from './avatarCrop'

describe('avatarCrop', () => {
  it('round-trips a valid v1 crop', () => {
    const crop = createAvatarCropV1({
      sourceFingerprint: 'abcdef0123456789',
      zoom: 1.5,
      offsetX: 12,
      offsetY: -8
    })
    const parsed = parseAvatarCrop(JSON.stringify(crop), 'abcdef0123456789')
    assert.deepEqual(parsed, crop)
  })

  it('rejects crop when fingerprint mismatches', () => {
    const crop = createAvatarCropV1({
      sourceFingerprint: 'abcdef0123456789',
      zoom: 1,
      offsetX: 0,
      offsetY: 0
    })
    assert.equal(parseAvatarCrop(JSON.stringify(crop), '0000000000000000'), null)
  })

  it('scales offsets when viewSize changes', () => {
    const crop = createAvatarCropV1({
      sourceFingerprint: 'abcdef0123456789',
      zoom: 2,
      offsetX: 18,
      offsetY: -9,
      viewSize: 180
    })
    const scaled = scaleAvatarCropToViewSize(crop, 90)
    assert.equal(scaled.viewSize, 90)
    assert.equal(scaled.offsetX, 9)
    assert.equal(scaled.offsetY, -4.5)
    assert.equal(scaled.zoom, 2)
  })
})
