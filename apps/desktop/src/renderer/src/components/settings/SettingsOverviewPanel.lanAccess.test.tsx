import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SettingsSnapshot } from '@shared/settingsTypes'
import type { WebAccessStatus } from '@shared/webTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

function collectText(node: TestRenderer.ReactTestInstance | string): string {
  if (typeof node === 'string') return node
  return node.children.map((child) => collectText(child as TestRenderer.ReactTestInstance)).join('')
}

const settings = {
  defaultScraper: 'javlibrary',
  defaultActressScraper: 'gfriends',
  proxyUrlEnabled: false,
  proxyUrl: '',
  llmProxyUrlEnabled: false,
  llmProxyUrl: '',
  mediaAssetsPath: '',
  mediaAssetsResolvedPath: 'C:/assets',
  assetEncryption: false
} as SettingsSnapshot

const running: WebAccessStatus = {
  enabled: true,
  running: true,
  port: 8096,
  username: 'viewer',
  hasPassword: true,
  urls: ['http://127.0.0.1:8096', 'http://192.168.1.20:8096'],
  devices: [],
  pairingUntil: 0,
  pairingActivity: [],
  sessions: 1,
  error: null
}

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    api: {
      settings: {
        getModelManagement: async () => ({
          connections: [],
          models: [],
          validationErrors: [],
          assignments: []
        }),
        getOverviewStats: async () => ({
          videos: { total: 0, scraped: 0, unscraped: 0, failed: 0 },
          actresses: { total: 0, female: 0, male: 0, scraped: 0, failed: 0, unscraped: 0 },
          playlists: 0,
          tags: 0,
          galleryAssets: 0,
          facets: { directors: 0, makers: 0, publishers: 0, series: 0 }
        })
      },
      webAccess: {
        status: async () => running
      }
    }
  }
})

let renderer: TestRenderer.ReactTestRenderer | undefined
let client: QueryClient | undefined

afterEach(async () => {
  await act(async () => renderer?.unmount())
  client?.clear()
  renderer = undefined
})

it('places LAN access after the library card and jumps each status card to its settings tab', async () => {
  const { default: SettingsOverviewPanel } = await import('./SettingsOverviewPanel')
  const navigated: Array<[string, string?, string?]> = []
  const openedLibrary: number[] = []
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client!}>
        <SettingsOverviewPanel
          settings={settings}
          theme="graphite"
          themeLabel="石墨"
          notices={[]}
          videoPluginCount={1}
          actressPluginCount={1}
          videoBatch={null}
          actressBatch={null}
          anyBatchActive={false}
          videoBatchPct={0}
          actressPct={0}
          actressConflictGroupCount={0}
          mediaLibraryCount={1}
          mediaLibraryRootCount={1}
          mediaLibrariesLoading={false}
          mediaLibrariesError={false}
          onNavigate={(group, tab, hash) => navigated.push([group, tab, hash])}
          onOpenMediaLibrarySettings={() => openedLibrary.push(1)}
          onOpenAgentTool={() => {}}
          onStartVideoBatchDefault={() => {}}
          onStartActressBatchDefault={() => {}}
          onOpenVideoBatchAdvanced={() => {}}
          onOpenActressBatchAdvanced={() => {}}
          onOpenVideoBatchDetails={() => {}}
          onOpenActressBatchDetails={() => {}}
          onOpenActressConflicts={() => {}}
          onPauseVideoBatch={async () => {}}
          onPauseActressBatch={async () => {}}
          onResumeBatch={async () => {}}
          onDiscardVideoBatch={async () => {}}
          onDiscardActressBatch={async () => {}}
        />
      </QueryClientProvider>
    )
  })
  await act(async () => {
    await Promise.resolve()
  })
  const cards = renderer!.root
    .findByProps({ className: 'settings-overview-status-grid' })
    .findAllByType('button')
  const labels = cards.map((card) =>
    collectText(card.findByProps({ className: 'settings-overview-status-card-label' }))
  )
  assert.deepEqual(labels, [
    '媒体库',
    '网页服务',
    '影片刮削',
    '演员刮削',
    '刮削代理',
    '模型代理',
    '默认 LLM',
    '外观',
    '存储'
  ])
  const lan = cards[1]
  assert.ok(collectText(lan).includes('运行中'))
  assert.ok(collectText(lan).includes('192.168.1.20:8096'))
  assert.equal(lan.props.title, 'http://192.168.1.20:8096')
  for (const card of cards) act(() => card.props.onClick())
  assert.deepEqual(openedLibrary, [1])
  assert.deepEqual(navigated, [
    ['network', 'web', undefined],
    ['plugins', 'video', undefined],
    ['plugins', 'actress', undefined],
    ['network', 'proxy', 'settings-proxy-scrape'],
    ['network', 'proxy', 'settings-proxy-llm'],
    ['models', 'usage', undefined],
    ['appearance', 'theme', undefined],
    ['storage', 'assets', undefined]
  ])
})
