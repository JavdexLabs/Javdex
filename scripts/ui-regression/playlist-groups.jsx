import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { applyTheme } from '../../apps/desktop/src/renderer/src/theme'
import '../../apps/desktop/src/renderer/src/styles/global.css'
import AppBrand from '../../apps/desktop/src/renderer/src/components/AppBrand'
import { SidebarNavIcon, SidebarNavLabel, SidebarNavLink } from '../../apps/desktop/src/renderer/src/components/SidebarNav'
import { NavIcon } from '../../apps/desktop/src/renderer/src/components/NavIcons'

// Production pages and controls, synthetic metadata, no access to a personal catalog.
window.React = React
const recent = { id: 0, name: '最近播放', local_kind: 'recently_played', system_kind: null, description: '仅此设备',
  cover_path: null, preview_cover_path: null, links: [], created_at: '', updated_at: null, video_count: 0, contains_video: false }
const base = { generation: 1, revision: 1, remove_after_play: 0, description: null, cover_path: null, preview_cover_path: null, contains_video: false, links: [], created_at: '', updated_at: null }
let lists = [
  { ...base, id: 1, name: '收藏', system_kind: 'favorites', video_count: 1 },
  { ...base, id: 2, name: '稍后观看', system_kind: 'watch_later', video_count: 3 },
  ...['稍后观看', 'NTR系列', '剧情', '水中', '深喉', '可怜', '周末片单', '待整理', '旅行', '精选', '经典'].map((name, i) =>
    ({ ...base, id: i + 3, name, system_kind: null, video_count: [11, 7, 1, 3, 2, 10, 6, 4, 2, 9, 8][i] }))
]
window.api = {
  recentPlayback: { metadata: async () => recent, onChanged: () => () => {}, page: async ({ limit = 60, offset = 0 }) =>
    ({ videos: [], total: 0, filteredTotal: 0, limit, offset }) },
  playlists: { listPage: async ({ search = '', offset = 0, limit = 60, kind }) => {
    const filtered = lists.filter(item => item.name.includes(search) && (!kind || (kind === 'builtin' ? !!item.system_kind : !item.system_kind)))
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset, hasExactName: filtered.some(item => item.name === search) }
  }, metadata: async id => lists.find(item => item.id === id) ?? null,
    update: async (id, input) => { lists = lists.map(item => item.id === id ? { ...item, ...input, remove_after_play: Number(input.removeAfterPlay), revision: item.revision + 1 } : item) },
    videoPage: async (id, { limit = 60, offset = 0 }) => ({ videos: [], total: 0, filteredTotal: 0, limit, offset }),
    create: async input => { const id = Math.max(...lists.map(item => item.id)) + 1; lists = [...lists, { ...base, ...input, id, system_kind: null, video_count: 0 }]; return id } },
  playlistImport: { onSnapshotChanged: () => () => {} }, mediaLibraries: { list: async () => [] }
}
const [{ default: PlaylistShell }, { default: PlaylistDetailPage }, { PlaylistImportProvider }, { ToastProvider }] = await Promise.all([
  import('../../apps/desktop/src/renderer/src/components/PlaylistShell'),
  import('../../apps/desktop/src/renderer/src/pages/PlaylistDetailPage'),
  import('../../apps/desktop/src/renderer/src/components/playlistImport/PlaylistImportContext'),
  import('../../apps/desktop/src/renderer/src/components/Toast')
])
applyTheme(new URLSearchParams(location.search).get('theme') || 'slate')
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const root = createRoot(document.getElementById('root'))
if (import.meta.hot) import.meta.hot.dispose(() => { root.unmount(); client.clear() })
root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/playlists']}><ToastProvider><PlaylistImportProvider>
  <div style={{ display: 'flex', width: '100%', height: '100vh' }}>
    <aside style={{ width: 224, flex: 'none', padding: 12, background: 'var(--surface-panel)', borderRight: '1px solid var(--border-subtle)' }}>
      <div style={{ padding: '12px 16px 24px' }}><AppBrand /></div>
      {['首页', '清单', '演员'].map((label, i) => <SidebarNavLink key={label} to={['/home', '/playlists', '/actresses'][i]}>
        <SidebarNavIcon><NavIcon name={['home', 'playlist', 'actress'][i]} /></SidebarNavIcon><SidebarNavLabel>{label}</SidebarNavLabel>
      </SidebarNavLink>)}
    </aside>
    <div style={{ flex: 1, minWidth: 0 }}><Routes><Route path="/playlists" element={<PlaylistShell />}>
      <Route path=":playlistId" element={<PlaylistDetailPage />} />
    </Route></Routes></div>
  </div>
</PlaylistImportProvider></ToastProvider></MemoryRouter></QueryClientProvider>)
