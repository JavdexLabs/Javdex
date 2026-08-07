import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ActressListItem, ActressListPage } from '@shared/types'
import { flattenActressListPages, nextActressPageOffset } from './actressListPages'

const counts = { all: 3, success: 0, unscraped: 3, failed: 0 }
const actress = (id: number): ActressListItem =>
  ({ id, main_name: `Actress ${id}` } as ActressListItem)
const page = (ids: number[]): ActressListPage => ({
  items: ids.map(actress),
  total: 3,
  statusCounts: counts
})

describe('actress infinite list pages', () => {
  it('keeps loaded pages while requesting the next offset', () => {
    const pages = [page([1, 2])]

    assert.deepEqual(flattenActressListPages(pages).map((item) => item.id), [1, 2])
    assert.equal(nextActressPageOffset(pages), 2)
  })

  it('stops after every matching actress has loaded', () => {
    const pages = [page([1, 2]), page([3])]

    assert.deepEqual(flattenActressListPages(pages).map((item) => item.id), [1, 2, 3])
    assert.equal(nextActressPageOffset(pages), undefined)
  })
})
