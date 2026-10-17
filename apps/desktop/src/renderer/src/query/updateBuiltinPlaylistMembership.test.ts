import assert from 'node:assert/strict'
import { it } from 'node:test'
import { QueryClient } from '@tanstack/react-query'
import { updateBuiltinPlaylistMembership } from './updateBuiltinPlaylistMembership'

it('patches only matching card flags and cancels an older read without changing rows or counts', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const key = ['videos', 'list', 'library:1', 'test', {}, 'window-page', 0]
  const page = { items: [{ id: 7, is_favorite: 0, is_watch_later: 1 }, { id: 8, is_favorite: 0 }], total: 40, readRevision: 'snapshot' }
  const otherPage = { items: [{ id: 99, is_favorite: 0 }], total: 1 }
  const home = { seed: 'test', recent: [page.items[0]], discovery: [page.items[1]], libraries: [] }
  client.setQueryData(key, page)
  client.setQueryData(['videos', 'list', 'other'], otherPage)
  client.setQueryData(['videos', 'list', 'count-only'], { total: 40 })
  client.setQueryData(['home', 'search', 'test'], page)
  client.setQueryData(['home', 'snapshot', 'test'], home)
  client.setQueryData(['media-libraries', 'detail', 1], { id: 1 })
  let resolve!: (value: typeof page) => void
  const oldRead = client.fetchQuery({ queryKey: key, queryFn: () => new Promise<typeof page>(done => { resolve = done }) })
  const canceled = oldRead.catch(() => undefined)
  try {
    await updateBuiltinPlaylistMembership(client, 7, 'favorites', true)
    await canceled
    resolve(page)
    await Promise.resolve()
    const updated = client.getQueryData<typeof page>(key)!
    assert.equal(updated.items[0].is_favorite, 1, 'a late pre-write read must not restore the old membership')
    assert.equal(updated.items[0].is_watch_later, 1)
    assert.equal(updated.items[1], page.items[1])
    assert.equal(updated.total, page.total)
    assert.equal(updated.readRevision, page.readRevision)
    assert.equal(page.items[0].is_favorite, 0, 'do not mutate shared source DTOs')
    assert.equal(client.getQueryData<typeof page>(['home', 'search', 'test'])!.items[0].is_favorite, 1)
    assert.equal(client.getQueryData<typeof home>(['home', 'snapshot', 'test'])!.recent[0].is_favorite, 1)
    assert.equal(client.getQueryData(['videos', 'list', 'other']), otherPage)
    assert.equal(client.getQueryState(['media-libraries', 'detail', 1])!.isInvalidated, false)
    assert.equal(client.isFetching(), 0)
  } finally { client.clear() }
})
