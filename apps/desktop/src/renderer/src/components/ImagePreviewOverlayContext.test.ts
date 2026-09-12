import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  IMAGE_PREVIEW_HISTORY_KEY,
  readImagePreviewHistoryMarker,
  withImagePreviewHistoryMarker
} from './ImagePreviewOverlayContext'

describe('image preview history marker', () => {
  it('preserves router state when adding a unique preview marker', () => {
    const state = { key: 'router-key', idx: 4, usr: { from: 'library' } }
    const next = withImagePreviewHistoryMarker(state, 'preview-token')

    assert.equal(next.key, 'router-key')
    assert.equal(next.idx, 4)
    assert.deepEqual(next.usr, { from: 'library' })
    assert.deepEqual(next[IMAGE_PREVIEW_HISTORY_KEY], {
      kind: 'image-preview',
      token: 'preview-token'
    })
  })

  it('reads only valid image preview markers', () => {
    assert.deepEqual(
      readImagePreviewHistoryMarker({
        [IMAGE_PREVIEW_HISTORY_KEY]: { kind: 'image-preview', token: 'one' }
      }),
      { kind: 'image-preview', token: 'one' }
    )
    assert.equal(readImagePreviewHistoryMarker(null), null)
    assert.equal(
      readImagePreviewHistoryMarker({
        [IMAGE_PREVIEW_HISTORY_KEY]: { kind: 'other-overlay', token: 'one' }
      }),
      null
    )
    assert.equal(
      readImagePreviewHistoryMarker({
        [IMAGE_PREVIEW_HISTORY_KEY]: { kind: 'image-preview', token: 1 }
      }),
      null
    )
  })
})
