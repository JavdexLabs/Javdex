import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mediaLibrarySurfaceMode } from './mediaLibrarySurfaceState'

describe('media-library list surface state', () => {
  it('keeps archived libraries out of the writable catalog surface', () => {
    assert.equal(mediaLibrarySurfaceMode({ status: 'active' }), 'active')
    assert.equal(mediaLibrarySurfaceMode({ status: 'archived' }), 'archived')
    assert.equal(mediaLibrarySurfaceMode(null), 'missing')
  })
})
