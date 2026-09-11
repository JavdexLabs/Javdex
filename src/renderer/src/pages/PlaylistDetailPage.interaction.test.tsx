import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlaylistPage, PlaylistMetadata, PlaylistVideosPage, PlaylistPageQuery } from '@shared/playlistTypes'
import type { Video } from '@shared/videoTypes'
import type { ElectronApi } from '../../../preload/index'
import { LIST_PARAM } from '../listView/listQueryParams'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const requests: Array<{ id: number; query: PlaylistPageQuery } & ReturnType<typeof deferred<PlaylistVideosPage | null>>> = []
const metadataRequests: number[] = []
let metadataResponse: ((id: number, sortBy?: string, sortDir?: string) => Promise<PlaylistMetadata | null>) | undefined
let removal = deferred<boolean>()
const fakeApi = {
  playlists: {
    metadata: async (id: number, sortBy?: string, sortDir?: string) => {
      metadataRequests.push(id)
      if (metadataResponse) return metadataResponse(id, sortBy, sortDir)
      const { videos: _videos, total: _total, filteredTotal: _filtered, limit: _limit, offset: _offset, ...metadata } = page(id)
      return metadata
    },
    videoPage: (id: number, query: PlaylistPageQuery) => {
      const request = { id, query, ...deferred<PlaylistVideosPage | null>() }
      requests.push(request)
      return request.promise
    },
    removeVideo: () => removal.promise
  },
  playlistImport: { onSnapshotChanged: () => () => {} }
} as unknown as ElectronApi
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: Object.assign(new EventTarget(), { api: fakeApi, requestAnimationFrame: (fn: () => void) => fn() })
})
Object.defineProperty(globalThis, 'document', {
  configurable: true, value: { body: { style: { overflow: '' } }, activeElement: null }
})

let renderer: TestRenderer.ReactTestRenderer | undefined
let client: QueryClient | undefined
let navigate: NavigateFunction
function NavigationProbe(): null { navigate = useNavigate(); return null }

function page(id: number, offset = 0, total = 120): PlaylistPage {
  return {
    id, name: `Playlist ${id}`, description: null, cover_path: null, preview_cover_path: null,
    created_at: '2026', updated_at: null, links: [], total, filteredTotal: total, offset, limit: 60,
    videos: offset < total ? [{
      id: id * 1000 + offset, code: `VIDEO-${id}-${offset}`, title: null, cover_path: null,
      scraped_status: 0, resource_kinds: []
    } as unknown as Video] : []
  }
}
async function mount(): Promise<void> {
  const PlaylistDetailPage = (await import('./PlaylistDetailPage')).default
  const { PlaylistImportProvider } = await import('../components/playlistImport/PlaylistImportContext')
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client!}>
        <MemoryRouter initialEntries={['/playlists/1']}>
          <PlaylistImportProvider>
            <NavigationProbe />
            <Routes>
              <Route path="/playlists/:playlistId" element={<PlaylistDetailPage />}>
                <Route path=":id" element={<div>Nested video</div>} />
              </Route>
            </Routes>
          </PlaylistImportProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
  })
}
function text(node: TestRenderer.ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : text(child)).join('')
}
async function resolveRequest(index: number, value: PlaylistPage): Promise<void> {
  await act(async () => { requests[index].resolve({videos: value.videos, total: value.total, filteredTotal: value.filteredTotal, limit: value.limit, offset: value.offset}); await Promise.resolve() })
}
async function click(label: string): Promise<void> {
  await act(async () => {
    const button = renderer!.root.findAllByType('button').find(node => text(node) === label)
    assert.ok(button, label)
    assert.equal(Boolean(button.props.disabled), false)
    button.props.onClick()
  })
}
async function startRemoval(): Promise<void> {
  const PosterCard = (await import('../components/PosterCard')).default
  const Modal = (await import('../components/Modal')).default
  await act(async () => renderer!.root.findByType(PosterCard).props.onRemove())
  await act(async () => renderer!.root.findByType(Modal).props.onConfirm())
}
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  client?.clear()
  requests.length = 0
  metadataRequests.length = 0
  metadataResponse = undefined
  removal = deferred<boolean>()
})

it('ignores an old playlist response arriving after navigation', async () => {
  await mount()
  assert.equal(requests[0].id, 1)
  await act(async () => navigate('/playlists/2'))
  assert.equal(requests[1].id, 2)
  await resolveRequest(1, page(2))
  await resolveRequest(0, page(1))
  assert.match(text(renderer!.root), /Playlist 2/)
  assert.doesNotMatch(text(renderer!.root), /Playlist 1/)
})

it('requests a bounded thumbnail for a playlist card', async () => {
  await mount()
  const result = page(1)
  result.videos[0].cover_path = 'covers/card.jpg'
  await resolveRequest(0, result)
  assert.ok(renderer!.root.findAllByType('img').some(image => image.props.src === 'media://covers/card.jpg?size=640'))
})

it('does not refresh an old playlist when its removal finishes after navigation', async () => {
  await mount()
  await resolveRequest(0, page(1))
  await startRemoval()
  await act(async () => navigate('/playlists/2'))
  await resolveRequest(1, page(2))
  await act(async () => { removal.resolve(true); await Promise.resolve() })
  assert.deepEqual(requests.map(request => request.id), [1, 2])
  assert.match(text(renderer!.root), /Playlist 2/)
})

it('returns to the previous page when deleting the only item on the last page', async () => {
  await mount()
  await resolveRequest(0, page(1, 0, 61))
  await click('下一页')
  assert.equal(requests[1].query.offset, 60)
  await resolveRequest(1, page(1, 60, 61))
  await startRemoval()
  await act(async () => { removal.resolve(true); await Promise.resolve() })
  await resolveRequest(2, page(1, 60, 60))
  assert.equal(requests[3].query.offset, 0)
  await resolveRequest(3, page(1, 0, 60))
  assert.match(text(renderer!.root), /1 \/ 1/)
})

it('keeps the existing grid mounted during refresh after closing a nested video', async () => {
  await mount()
  await resolveRequest(0, page(1))
  const grid = renderer!.root.findByProps({ className: 'playlist-video-grid' })
  await act(async () => navigate('/playlists/1/1000'))
  await act(async () => navigate('/playlists/1'))
  assert.equal(requests.length, 2)
  assert.equal(renderer!.root.findByProps({ className: 'playlist-video-grid' }), grid)
  await resolveRequest(1, page(1))
  assert.equal(renderer!.root.findByProps({ className: 'playlist-video-grid' }), grid)
})

it('keeps the latest sort response when requests for the same playlist finish out of order', async () => {
  await mount()
  await resolveRequest(0, page(1))
  const SortSwitch = (await import('../components/SortSwitch')).default
  await act(async () => renderer!.root.findByType(SortSwitch).props.onChange('release_date', 'asc'))
  await act(async () => renderer!.root.findByType(SortSwitch).props.onChange('release_date', 'desc'))
  assert.equal(requests[1].query.sortDir, 'asc')
  assert.equal(requests[2].query.sortDir, 'desc')
  await resolveRequest(2, { ...page(1), videos: [{ ...page(1).videos[0], code: 'LATEST-SORT' }] })
  await resolveRequest(1, { ...page(1), videos: [{ ...page(1).videos[0], code: 'OBSOLETE-SORT' }] })
  assert.match(text(renderer!.root), /LATEST-SORT/)
  assert.doesNotMatch(text(renderer!.root), /OBSOLETE-SORT/)
})


it('reuses metadata while paging but refreshes it after a playlist mutation', async () => {
  await mount()
  await resolveRequest(0, page(1, 0, 61))
  assert.equal(metadataRequests.length, 1)
  await click('下一页')
  await resolveRequest(1, page(1, 60, 61))
  assert.equal(metadataRequests.length, 1)
  await startRemoval()
  await act(async () => { removal.resolve(true); await Promise.resolve() })
  assert.equal(metadataRequests.length, 2)
  await resolveRequest(2, page(1, 60, 60))
  await resolveRequest(3, page(1, 0, 60))
  assert.equal(metadataRequests.length, 2)
})


it('does not reuse stale metadata when filtering interrupts a forced refresh', async () => {
  await mount()
  await resolveRequest(0, page(1))
  const forced = deferred<PlaylistMetadata | null>()
  const filtered = deferred<PlaylistMetadata | null>()
  let calls = 0
  metadataResponse = () => (++calls === 1 ? forced.promise : filtered.promise)
  await act(async () => navigate('/playlists/1/1000'))
  await act(async () => navigate('/playlists/1'))
  await act(async () => navigate(`/playlists/1?${LIST_PARAM.resources}=none`))
  assert.equal(metadataRequests.length, 3, 'filtering must fetch fresh metadata after invalidation')
  await act(async () => {
    filtered.resolve({ ...page(1), name: 'Fresh metadata' })
    requests[2].resolve({ videos: page(1).videos, total: 120, filteredTotal: 120, limit: 60, offset: 0 })
  })
  await act(async () => {
    forced.resolve({ ...page(1), name: 'Obsolete metadata' })
    requests[1].resolve({ videos: page(1).videos, total: 120, filteredTotal: 120, limit: 60, offset: 0 })
  })
  assert.match(text(renderer!.root), /Fresh metadata/)
  assert.doesNotMatch(text(renderer!.root), /Obsolete metadata/)
})

it('shows not found when a refreshed metadata read reports a deleted playlist', async () => {
  metadataResponse = async () => null
  await mount()
  await resolveRequest(0, page(1))
  assert.match(text(renderer!.root), /未找到该清单/)
  assert.doesNotMatch(text(renderer!.root), /Playlist 1/)
  assert.equal(renderer!.root.findAllByProps({ className: 'playlist-video-grid' }).length, 0)
})


it('refreshes the fallback cover with the new sort instead of reusing the old metadata', async () => {
  metadataResponse = async (id, sortBy, sortDir) => ({
    ...page(id), preview_cover_path: `covers/${sortBy}-${sortDir}.jpg`
  })
  await mount()
  await resolveRequest(0, page(1))
  assert.ok(renderer!.root.findAllByType('img').some(node => node.props.src === 'media://covers/added_at-desc.jpg'))
  const SortSwitch = (await import('../components/SortSwitch')).default
  await act(async () => renderer!.root.findByType(SortSwitch).props.onChange('release_date', 'asc'))
  await resolveRequest(1, page(1))
  assert.ok(renderer!.root.findAllByType('img').some(node => node.props.src === 'media://covers/release_date-asc.jpg'))
})
