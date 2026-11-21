import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildPaginationItems } from './ListPagination'

describe('buildPaginationItems', () => {
  it('returns all pages when totalPages <= 7', () => {
    assert.deepEqual(buildPaginationItems(1, 1), [1])
    assert.deepEqual(buildPaginationItems(3, 5), [1, 2, 3, 4, 5])
    assert.deepEqual(buildPaginationItems(4, 7), [1, 2, 3, 4, 5, 6, 7])
  })

  it('keeps a constant 7-slot layout across every page when totalPages > 7', () => {
    for (const totalPages of [8, 9, 12, 50, 120]) {
      for (let page = 1; page <= totalPages; page += 1) {
        const items = buildPaginationItems(page, totalPages)
        assert.equal(items.length, 7, `expected 7 slots for page ${page}/${totalPages}`)
        assert.equal(items[0], 1)
        assert.equal(items[6], totalPages)
        assert.ok(items.includes(page), `active page ${page}/${totalPages} must be visible`)
      }
    }
  })
})
