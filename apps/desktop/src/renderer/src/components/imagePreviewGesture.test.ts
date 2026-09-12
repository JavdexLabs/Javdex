import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getImagePreviewSwipeDirection,
  IMAGE_PREVIEW_SWIPE_THRESHOLD,
  isImagePreviewDrag
} from './imagePreviewGesture'

describe('image preview swipe gesture', () => {
  it('switches to the previous image when dragging right past the threshold', () => {
    assert.equal(
      getImagePreviewSwipeDirection(IMAGE_PREVIEW_SWIPE_THRESHOLD + 1, 0),
      'prev'
    )
  })

  it('switches to the next image when dragging left past the threshold', () => {
    assert.equal(
      getImagePreviewSwipeDirection(-(IMAGE_PREVIEW_SWIPE_THRESHOLD + 1), 0),
      'next'
    )
  })

  it('ignores clicks, short drags, and vertical drags', () => {
    assert.equal(getImagePreviewSwipeDirection(0, 0), null)
    assert.equal(getImagePreviewSwipeDirection(IMAGE_PREVIEW_SWIPE_THRESHOLD, 0), null)
    assert.equal(getImagePreviewSwipeDirection(90, 100), null)
  })

  it('distinguishes a drag from a click even when movement is vertical', () => {
    assert.equal(isImagePreviewDrag(0, 0, 6), false)
    assert.equal(isImagePreviewDrag(6, 0, 6), false)
    assert.equal(isImagePreviewDrag(0, 7, 6), true)
  })
})
