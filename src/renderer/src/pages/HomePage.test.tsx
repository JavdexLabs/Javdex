import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import TestRenderer, { act } from 'react-test-renderer'
import type { ElectronApi } from '../../../preload/index'
import type { GlobalSearchInput, HomeSnapshot, ScopedVideo } from '@shared/catalogTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null
let queryClient: QueryClient | null = null
let currentLocation = ''
let searchInputs: GlobalSearchInput[] = []
let homeLoadSeeds: string[] = []

function fakeScopedVideo(id: number): ScopedVideo {
  const addedAt = '2026-08-29T00:00:00.000Z'
  return {
    id,
    code: `DISC-${id}`,
    title: null,
    summary: null,
    cover_path: null,
    poster_path: null,
    original_title: null,
    rating: 0,
    release_date: null,
    maker: null,
    publisher: null,
    maker_organization_id: null,
    publisher_organization_id: null,
    series: null,
    director: null,
    series_id: null,
    director_id: null,
    duration_seconds: null,
    scraped_status: 0,
    last_scraped_at: null,
    updated_at: null,
    add_time: addedAt,
    preferredLibraryId: 1,
    membershipAddedAt: addedAt,
    libraries: [
      {
        libraryId: 1,
        name: '测试媒体库',
        icon: 'library',
        color: 'blue'
      }
    ]
  }
}

const fakeApi = {
  home: {
    load: async ({ seed }: { seed: string }) => {
      homeLoadSeeds.push(seed)
      return {
        seed,
        recent: [],
        discovery: [fakeScopedVideo(homeLoadSeeds.length)],
        libraries: []
      }
    },
    search: async (input: GlobalSearchInput) => {
      searchInputs.push(input)
      return { items: [], total: 0 }
    }
  }
} as unknown as ElectronApi

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    api: fakeApi,
  }
})

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { platform: 'Win32' }
})

function LocationProbe(): null {
  const location = useLocation()
  currentLocation = `${location.pathname}${location.search}`
  return null
}

function nodeText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('')
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  assert.fail('home search did not settle')
}

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
  queryClient?.clear()
  queryClient = null
  currentLocation = ''
  searchInputs = []
  homeLoadSeeds = []
})

describe('HomePage', () => {
  it('searches in place while typing and restores discovery when cleared', async () => {
    const HomePage = (await import('./HomePage')).default
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={queryClient!}>
          <MemoryRouter
            initialEntries={['/']}
            future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          >
            <LocationProbe />
            <HomePage />
          </MemoryRouter>
        </QueryClientProvider>
      )
      await Promise.resolve()
    })

    assert.ok(renderer)
    assert.equal(renderer.root.findAllByType('form').length, 0)
    assert.equal(
      renderer.root.findAllByType('button').some((candidate) => nodeText(candidate) === '搜索'),
      false
    )

    const input = renderer.root.findByProps({ 'aria-label': '跨媒体库搜索' })
    await act(async () => {
      input.props.onChange({ target: { value: 'ABC-123' } })
    })

    assert.equal(currentLocation, '/')
    assert.match(nodeText(renderer.root), /搜索中…/)

    await waitFor(() => searchInputs.length === 1 && currentLocation === '/?q=ABC-123')
    assert.deepEqual(searchInputs, [{ search: 'ABC-123', limit: 120, offset: 0 }])
    await waitFor(() => Boolean(renderer && nodeText(renderer.root).includes('没有匹配的影片')))

    await act(async () => {
      renderer?.root
        .findByProps({ 'aria-label': '跨媒体库搜索' })
        .props.onChange({ target: { value: '' } })
    })
    assert.match(nodeText(renderer.root), /随机发现/)
    await waitFor(() => currentLocation === '/')
  })

  it('keeps discovery stable through refreshes and remounts until replaced', async () => {
    const HomePage = (await import('./HomePage')).default
    const renderHome = async (): Promise<void> => {
      queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      await act(async () => {
        renderer = TestRenderer.create(
          <QueryClientProvider client={queryClient!}>
            <MemoryRouter
              initialEntries={['/']}
              future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
            >
              <HomePage />
            </MemoryRouter>
          </QueryClientProvider>
        )
        await Promise.resolve()
      })
    }

    await renderHome()
    await waitFor(
      () =>
        homeLoadSeeds.length === 1 &&
        Boolean(renderer && nodeText(renderer.root).includes('当前批次保持稳定'))
    )
    const initialSeed = homeLoadSeeds[0]
    const initialSnapshot = queryClient!.getQueryData<HomeSnapshot>([
      'home',
      'snapshot',
      initialSeed
    ])
    assert.ok(initialSnapshot)
    const initialDiscoveryCode = initialSnapshot.discovery[0]?.code
    assert.match(
      nodeText(renderer!.root),
      /当前批次保持稳定，仅在重启软件或换一批时更新。/
    )
    assert.doesNotMatch(nodeText(renderer!.root), /测试媒体库/)

    await act(async () => {
      await queryClient!.invalidateQueries({ queryKey: ['home'] })
    })
    await waitFor(() => homeLoadSeeds.length === 2)
    assert.equal(homeLoadSeeds[1], initialSeed)
    assert.equal(
      queryClient!.getQueryData<HomeSnapshot>(['home', 'snapshot', initialSeed])?.discovery[0]
        ?.code,
      initialDiscoveryCode
    )

    const replaceButton = renderer!.root
      .findAllByType('button')
      .find((candidate) => nodeText(candidate) === '换一批')
    assert.ok(replaceButton)
    await act(async () => {
      replaceButton.props.onClick()
      await Promise.resolve()
    })
    await waitFor(() => homeLoadSeeds.length === 3)
    const replacedSeed = homeLoadSeeds[2]
    assert.notEqual(replacedSeed, initialSeed)
    const replacedDiscoveryCode = queryClient!.getQueryData<HomeSnapshot>([
      'home',
      'snapshot',
      replacedSeed
    ])?.discovery[0]?.code
    assert.notEqual(replacedDiscoveryCode, initialDiscoveryCode)

    await act(async () => renderer?.unmount())
    renderer = null
    queryClient?.clear()
    queryClient = null

    await renderHome()
    await waitFor(() => homeLoadSeeds.length === 4)
    assert.equal(homeLoadSeeds[3], replacedSeed)
    assert.equal(
      queryClient!.getQueryData<HomeSnapshot>(['home', 'snapshot', replacedSeed])?.discovery[0]
        ?.code,
      replacedDiscoveryCode
    )
  })
})
