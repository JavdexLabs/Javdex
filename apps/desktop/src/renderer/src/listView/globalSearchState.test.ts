import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  GLOBAL_SEARCH_LIBRARY_PARAM,
  canonicalizeGlobalSearchParams,
  globalSearchInputFromParams,
  globalSearchLibraryIdsParam,
  globalSearchQueryHash,
  parseGlobalSearchLibraryIds
} from './globalSearchState'

describe('global search URL state', () => {
  it('normalizes positive media-library ids in stable order', () => {
    assert.deepEqual(parseGlobalSearchLibraryIds('7,2,7,0,nope,3.5'), [2, 7])
    assert.equal(globalSearchLibraryIdsParam([7, 2, 7, -1]), '2,7')
  })

  it('canonicalizes owned state without stripping detail-only lib', () => {
    const next = canonicalizeGlobalSearchParams(
      new URLSearchParams('q=%20abc%20&libraries=7,bad,2,7&lib=7')
    )
    assert.equal(next.get('q'), 'abc')
    assert.equal(next.get(GLOBAL_SEARCH_LIBRARY_PARAM), '2,7')
    assert.equal(next.get('lib'), '7')
  })

  it('builds an explicit, paged cross-library search input and identity', () => {
    const params = new URLSearchParams('q=abc&libraries=8,3')
    assert.deepEqual(globalSearchInputFromParams(params, { limit: 80, offset: 160 }), {
      search: 'abc',
      libraryIds: [3, 8],
      sortBy: 'add_time',
      sortDir: 'desc',
      limit: 80,
      offset: 160
    })
    assert.equal(globalSearchQueryHash(params), 'libraries=3,8&q=abc')
  })
})
