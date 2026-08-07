import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { addSelectedRange, toggleSelectedId } from '../hooks/rangeSelectionState'
import {
  clearAllListViewMemory,
  resolveScrollTopForKey,
  setListScroll
} from '../listView/listViewMemory'
import { actressKeys } from './queryKeys'
import type { ActressListPage } from '@shared/types'
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query'
import { actressInfiniteQueryOptions } from './actressInfiniteQueryOptions'

afterEach(clearAllListViewMemory)

describe('actress list renderer behavior', () => {
  it('isolates cached pages when any query condition changes', () => {
    const base = actressKeys.list({ gender: 'female', status: 'all' }, 'gender=female')
    const filtered = actressKeys.list(
      { gender: 'female', status: 'failed' },
      'gender=female&status=failed'
    )

    assert.notDeepEqual(base, filtered)
  })

  it('keeps loaded pages after a failure and retries the same next-page offset', async () => {
    const offsets: number[] = []
    let nextAttempts = 0
    const fetchPage = async (query: { offset?: number }): Promise<ActressListPage> => {
      const offset = query.offset ?? 0
      offsets.push(offset)
      if (offset === 2) {
        nextAttempts += 1
        if (nextAttempts === 1) throw new Error('temporary failure')
      }
      const ids = offset === 0 ? [1, 2] : [3]
      return {
        items: ids.map((id) => ({ id } as ActressListPage['items'][number])),
        total: 3,
        statusCounts: { all: 3, success: 0, unscraped: 3, failed: 0 }
      }
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const observer = new InfiniteQueryObserver(
      client,
      actressInfiniteQueryOptions({}, 'all', fetchPage)
    )
    const unsubscribe = observer.subscribe(() => undefined)

    await observer.refetch()
    await observer.fetchNextPage()
    const failed = observer.getCurrentResult()
    assert.equal(failed.isFetchNextPageError, true)
    assert.deepEqual(failed.data?.pages.flatMap((page) => page.items.map((item) => item.id)), [1, 2])

    await observer.fetchNextPage()
    const retried = observer.getCurrentResult()
    assert.deepEqual(offsets, [0, 2, 2])
    assert.deepEqual(retried.data?.pages.flatMap((page) => page.items.map((item) => item.id)), [1, 2, 3])
    unsubscribe()
    client.clear()
  })

  it('keeps selected ids when later pages append more actresses', () => {
    const firstPage = [{ id: 1 }, { id: 2 }]
    const loadedPages = [...firstPage, { id: 3 }, { id: 4 }]
    const selected = toggleSelectedId(new Set<number>(), 1)

    assert.deepEqual([...addSelectedRange(selected, loadedPages, 1, 3)], [1, 2, 3, 4])
  })

  it('restores scroll after detail return and resets it for a changed query', () => {
    setListScroll('actresses:all', { scrollTop: 640, visibleRowIndex: 4 })

    assert.equal(resolveScrollTopForKey(undefined, 'actresses:all'), 640)
    assert.equal(resolveScrollTopForKey('actresses:all', 'actresses:failed'), 0)
  })
})
