import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  LIST_PARAM,
  canonicalizeLibrarySearchParams,
  libraryQueryHash,
  libraryVideoQueryFromSearchParams,
  parseVideoResourceFilters,
  videoResourceFiltersParam
} from './listQueryParams'

describe('library resource filter URL contract', () => {
  it('parses valid unique values in canonical order and ignores invalid values', () => {
    assert.deepEqual(parseVideoResourceFilters('none,direct,bad,direct,local'), [
      'local',
      'direct',
      'none'
    ])
  })

  it('omits the default all-resources state and canonicalizes copied URLs', () => {
    assert.equal(videoResourceFiltersParam([]), null)
    const original = new URLSearchParams('q=test&resources=none,bad,direct,direct')
    const normalized = canonicalizeLibrarySearchParams(original)

    assert.equal(normalized.get(LIST_PARAM.q), 'test')
    assert.equal(normalized.get(LIST_PARAM.resources), 'direct,none')
    assert.deepEqual(libraryVideoQueryFromSearchParams(normalized).resourceKinds, [
      'direct',
      'none'
    ])
  })

  it('removes a resource parameter containing only invalid values', () => {
    const normalized = canonicalizeLibrarySearchParams(
      new URLSearchParams('resources=ftp,unknown')
    )
    assert.equal(normalized.has(LIST_PARAM.resources), false)
  })

  it('includes applied resource filters in the query and scroll-memory hash', () => {
    const unfiltered = new URLSearchParams()
    const filtered = new URLSearchParams('resources=magnet,web')

    assert.notEqual(libraryQueryHash(unfiltered), libraryQueryHash(filtered))
    assert.deepEqual(libraryVideoQueryFromSearchParams(filtered).resourceKinds, ['web', 'magnet'])
  })

  it('keeps pending scrape as an independent canonical filter dimension', () => {
    const pending = canonicalizeLibrarySearchParams(new URLSearchParams('pending=pending'))
    const invalid = canonicalizeLibrarySearchParams(new URLSearchParams('pending=maybe'))

    assert.equal(pending.get(LIST_PARAM.pending), 'pending')
    assert.equal(libraryVideoQueryFromSearchParams(pending).pendingScrape, 'pending')
    assert.equal(invalid.has(LIST_PARAM.pending), false)
    assert.notEqual(libraryQueryHash(pending), libraryQueryHash(new URLSearchParams()))
  })
})
