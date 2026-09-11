import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
const metadata = 'unused metadata'.repeat(100_000)
let actorFails = true
const errors: unknown[] = []
const onError = (error: unknown) => { errors.push(error) }
Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: {
  videos: { list: async () => ({ total: 1, readRevision: 'video-revision', items: [{
    id: 71, code: 'AB-71', title: 'title', cover_path: '/cover.jpg', scraped_status: 1,
    preferredLibraryId: 9, membershipAddedAt: 'now', libraries: [{ libraryId: 9, name: 'Library', icon: 'library', color: 'slate' }],
    summary: metadata, original_title: metadata
  }] }) },
  actresses: { listPage: async () => {
    if (actorFails) throw new Error('initial actress failure')
    return { total: 1, readRevision: 'actor-revision', statusCounts: { all: 1, success: 1, failed: 0, unscraped: 0 }, items: [{
      id: 32, main_name: 'Full name', avatar_path: '/avatar.jpg', gender: 'female', scraped_status: 1,
      video_count: 5, avatar_fingerprint: 'fp', revision: 7,
      profile_summary: metadata, avatar_crop_json: metadata
    }] }
  } }
} } })

it('real wrappers cache narrow runtime pages with revision and preserve actress initial-error retry', async () => {
  const { useInfiniteVideoList } = await import('./useInfiniteVideoList')
  const { useInfiniteActressList } = await import('./useInfiniteActressList')
  let videos!: ReturnType<typeof useInfiniteVideoList>
  let actresses!: ReturnType<typeof useInfiniteActressList>
  function Harness() {
    videos = useInfiniteVideoList({ kind: 'library', libraryId: 9 }, {}, 'card-wrapper', onError)
    actresses = useInfiniteActressList({}, 'card-wrapper', onError)
    return null
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let renderer: TestRenderer.ReactTestRenderer | undefined
  async function settle(predicate: () => boolean) {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (predicate()) return
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)) })
    }
    assert.fail('card wrapper did not settle')
  }
  try {
    await act(async () => { renderer = TestRenderer.create(<QueryClientProvider client={client}><Harness /></QueryClientProvider>) })
    await settle(() => videos.videos.length === 1 && Boolean(actresses.error))
    assert.equal(videos.window.getItem(0)?.preferredLibraryId, 9)
    assert.equal('summary' in videos.videos[0], false)
    assert.equal(actresses.total, 0)
    actorFails = false
    act(() => actresses.retry())
    await settle(() => actresses.items.length === 1 && !actresses.error)
    assert.equal(actresses.items[0].id, 32)
    assert.equal(actresses.items[0].avatar_fingerprint, 'fp')
    assert.equal(actresses.statusCounts.success, 1)
    assert.equal('avatar_crop_json' in actresses.items[0], false)
    const pages = client.getQueryCache().getAll().map(query => query.state.data)
    const serialized = JSON.stringify(pages)
    assert.ok(Buffer.byteLength(serialized) < 4096)
    assert.match(serialized, /video-revision/)
    assert.match(serialized, /actor-revision/)
    assert.doesNotMatch(serialized, /profile_summary|original_title|avatar_crop_json/)
    assert.deepEqual(await videos.window.readRange(0, 1), [{ id: 71 }])
    assert.deepEqual(await actresses.window.readRange(0, 1), [{ id: 32 }])
  } finally {
    await act(async () => renderer?.unmount())
    client.clear()
  }
})
