import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
const theme = new URLSearchParams(location.search).get('theme')
const libraries = Array.from({ length: 12 }, (_, index) => ({
  id: index + 3, name: index === 0 ? '当前媒体库：用于检查长名称截断' : `媒体库 ${index + 1}`,
  status: 'active', icon: index % 2 ? 'folder' : 'film', color: '#7c82bf',
  pendingRemovalRootCount: index === 0 ? 2 : 0, pendingScanGroupCount: index === 0 ? 3 : 0
}))
window.fixtureShellState = 'ready'
window.api = {
  mediaLibraries: { list: async () => {
    if (window.fixtureShellState === 'loading') return new Promise(() => {})
    if (window.fixtureShellState === 'error') throw new Error('Synthetic library failure')
    return window.fixtureShellState === 'empty' ? [] : [...libraries, { ...libraries[0], id: 99, name: '已归档', status: 'archived', pendingScanGroupCount: 0 }]
  } },
  actressScrape: { conflictSummary: async () => ({ groupCount: 2 }) },
  scrape: { countPending: async () => 4, listPlugins: async () => [], listPluginDetails: async () => [] },
  settings: { get: async () => ({ theme, privacyModeEnabled: false, privacyModeScopes: ['globalBackground'] }) },
  assetCrypto: { onProgress: () => () => {} }
}
const { default: Layout } = await import('../../apps/desktop/src/renderer/src/components/Layout')
const { AppBackgroundProvider, useAppBackground } = await import('../../apps/desktop/src/renderer/src/components/AppBackgroundContext')
const { ImagePreviewOverlayProvider, useImagePreviewOverlay } = await import('../../apps/desktop/src/renderer/src/components/ImagePreviewOverlayContext')
const { ThemeProvider, useTheme } = await import('../../apps/desktop/src/renderer/src/components/ThemeProvider')
const { ToastProvider } = await import('../../apps/desktop/src/renderer/src/components/Toast')
const query = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })

function Shell() {
  const route = useLocation()
  const navigate = useNavigate()
  const background = useAppBackground()
  const preview = useImagePreviewOverlay()
  const { syncPrivacyMode } = useTheme()
  useEffect(() => {
    window.fixtureShell = {
      navigate, background, preview,
      privacy: enabled => syncPrivacyMode({ privacyModeEnabled: enabled, privacyModeScopes: ['globalBackground'] }),
      state: async state => {
        window.fixtureShellState = state
        await query.resetQueries({ queryKey: ['media-libraries'] })
      }
    }
  }, [navigate, background, preview, syncPrivacyMode])
  return <Layout><div data-fixture-content style={{ padding: 24, overflow: 'auto', flex: 1 }}>
    <h1>应用壳回检</h1><p data-fixture-route>{route.pathname}{route.search}</p>
    <p>保留侧栏导航、媒体库滚动区域、底部徽标、背景层和内容区域。</p>
    <div style={{ height: 1100 }}>内容滚动边界</div>
  </div></Layout>
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={query}><MemoryRouter initialEntries={['/libraries/3/video/1?q=ABC']}>
    <ThemeProvider><ToastProvider><AppBackgroundProvider><ImagePreviewOverlayProvider><Shell /></ImagePreviewOverlayProvider></AppBackgroundProvider></ToastProvider></ThemeProvider>
  </MemoryRouter></QueryClientProvider>
)
