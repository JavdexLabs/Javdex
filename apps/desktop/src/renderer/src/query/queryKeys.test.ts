import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { catalogScopeKey, videoKeys } from './queryKeys'

describe('scoped video query keys', () => {
  it('keeps media-library caches isolated', () => {
    const first = videoKeys.list({ kind: 'library', libraryId: 2 }, {}, 'q=')
    const second = videoKeys.list({ kind: 'library', libraryId: 3 }, {}, 'q=')
    assert.notDeepEqual(first, second)
  })

  it('canonicalizes filtered all-library scopes', () => {
    assert.equal(catalogScopeKey({ kind: 'all', libraryIds: [7, 2, 7] }), 'all:2,7')
    assert.equal(catalogScopeKey({ kind: 'all' }), 'all')
  })
})
