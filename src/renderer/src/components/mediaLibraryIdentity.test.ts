import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MEDIA_LIBRARY_COLORS } from '@shared/mediaLibraryTypes'
import { mediaLibraryIdentityStyle } from './mediaLibraryIdentity'

describe('mediaLibraryIdentityStyle', () => {
  it('maps every domain color to one semantic CSS custom property', () => {
    for (const color of MEDIA_LIBRARY_COLORS) {
      const style = mediaLibraryIdentityStyle(color)
      assert.deepEqual(Object.keys(style), ['--media-library-color'])
      assert.match(
        style['--media-library-color'],
        /var\(--(?:text-muted|accent|danger|warning|success)\)|color-mix/
      )
    }
  })

  it('keeps the established palette mapping stable', () => {
    assert.equal(
      mediaLibraryIdentityStyle('slate')['--media-library-color'],
      'var(--text-muted)'
    )
    assert.equal(
      mediaLibraryIdentityStyle('blue')['--media-library-color'],
      'var(--accent)'
    )
    assert.equal(
      mediaLibraryIdentityStyle('rose')['--media-library-color'],
      'var(--danger)'
    )
  })
})
