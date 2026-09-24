import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isLibraryListSurfacePath,
  shouldRefetchLibraryOnRouteChange
} from './librarySurfacePaths'

describe('isLibraryListSurfacePath', () => {
  it('matches list roots only', () => {
    assert.equal(isLibraryListSurfacePath('/'), true)
    assert.equal(isLibraryListSurfacePath('/actresses'), true)
    assert.equal(isLibraryListSurfacePath('/playlists'), true)
    assert.equal(isLibraryListSurfacePath('/facet/director'), true)
  })

  it('does not match detail or stack routes', () => {
    assert.equal(isLibraryListSurfacePath('/detail/42'), false)
    assert.equal(isLibraryListSurfacePath('/detail/42/actress/7'), false)
    assert.equal(isLibraryListSurfacePath('/actresses/42'), false)
    assert.equal(isLibraryListSurfacePath('/actresses/42/99'), false)
    assert.equal(isLibraryListSurfacePath('/actresses/42/99/actress/7'), false)
    assert.equal(isLibraryListSurfacePath('/playlists/3'), false)
    assert.equal(isLibraryListSurfacePath('/playlists/3/99'), false)
    assert.equal(isLibraryListSurfacePath('/facet/director/v/studio'), false)
    assert.equal(isLibraryListSurfacePath('/facet/director/v/studio/99'), false)
    assert.equal(isLibraryListSurfacePath('/settings/overview/status'), false)
  })
})

describe('shouldRefetchLibraryOnRouteChange', () => {
  it('refetches when entering a list root from outside', () => {
    assert.equal(
      shouldRefetchLibraryOnRouteChange('/settings/overview/status', '/'),
      true
    )
    assert.equal(shouldRefetchLibraryOnRouteChange('/detail/42', '/'), true)
    assert.equal(shouldRefetchLibraryOnRouteChange('/actresses/42', '/actresses'), true)
    assert.equal(
      shouldRefetchLibraryOnRouteChange('/facet/director/v/key', '/facet/director'),
      true
    )
  })

  it('does not refetch when opening detail stacks or hopping between list roots', () => {
    assert.equal(shouldRefetchLibraryOnRouteChange('/', '/detail/42'), false)
    assert.equal(shouldRefetchLibraryOnRouteChange('/actresses', '/actresses/42'), false)
    assert.equal(shouldRefetchLibraryOnRouteChange('/', '/actresses'), false)
    assert.equal(shouldRefetchLibraryOnRouteChange('/facet/director', '/facet/maker'), false)
    assert.equal(shouldRefetchLibraryOnRouteChange('/playlists', '/playlists/3'), false)
  })
})
