import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AVATAR_VIEW_SIZE,
  getCropImageLayout,
  getDefaultCropTransform,
  getSavedAvatarCropTransform,
  isDefaultCropTransform
} from './avatarCrop'

describe('renderer avatarCrop', () => {
  it('keeps legacy near-square avatars aligned with cover preview layout', () => {
    const saved = getSavedAvatarCropTransform(512, 511, AVATAR_VIEW_SIZE)
    const preview = getDefaultCropTransform(512, 511, AVATAR_VIEW_SIZE)
    assert.deepEqual(saved, preview)

    const layout = getCropImageLayout(
      512,
      511,
      saved.baseScale,
      saved.zoom,
      saved.offsetX,
      saved.offsetY,
      AVATAR_VIEW_SIZE
    )
    assert.equal(layout.top, 0)
  })

  it('detects the native cover-compatible default transform', () => {
    assert.equal(isDefaultCropTransform(1, 0, 0), true)
    assert.equal(isDefaultCropTransform(1 + 1e-8, -1e-8, 1e-8), true)
    assert.equal(isDefaultCropTransform(1.01, 0, 0), false)
    assert.equal(isDefaultCropTransform(1, 0.5, 0), false)
  })
})
