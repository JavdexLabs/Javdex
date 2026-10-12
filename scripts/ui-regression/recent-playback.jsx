import React from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { applyTheme } from '../../apps/desktop/src/renderer/src/theme'
import '../../apps/desktop/src/renderer/src/styles/global.css'

window.React = React
const listeners = new Set()
let entries = [1, 2, 3].map(id => ({ id, code: `DEMO-${id}`, title: `合成验收影片 ${id}`, cover_path: null, scraped_status: 1, resource_kinds: ['local'] }))
const metadata = () => ({ id: 0, name: '最近播放', description: '仅此设备 · 按最近一次播放倒序，保存播放时的影片资料',
  local_kind: 'recently_played', system_kind: null, cover_path: null, preview_cover_path: null, links: [], created_at: '', updated_at: null,
  video_count: entries.length, contains_video: false })
const changed = () => listeners.forEach(listener => listener())
const lists = [
  { id: 1, name: '我喜欢', system_kind: 'favorites', description: null, cover_path: null, preview_cover_path: null, video_count: 0, contains_video: false },
  { id: 2, name: '稍后观看', system_kind: 'watch_later', description: null, cover_path: null, preview_cover_path: null, video_count: 0, contains_video: false }
]
window.api = {
  recentPlayback: { metadata: async () => metadata(), onChanged: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    page: async ({ limit = 60, offset = 0, resourceKinds = [] }) => { const filtered = resourceKinds.length && !resourceKinds.includes('local') ? [] : entries
      return { videos: filtered.slice(offset, offset + limit), total: entries.length, filteredTotal: filtered.length, limit, offset } },
    clear: async () => { entries = []; changed() }, remove: async id => { entries = entries.filter(item => item.id !== id); changed() } },
  playlists: { listPage: async ({ search = '', offset = 0, limit = 60 }) => {
    const items = lists.filter(item => item.name.includes(search))
    return { items, total: items.length, limit, offset, hasExactName: false } } },
  playlistImport: { onSnapshotChanged: () => () => {} }, mediaLibraries: { list: async () => [] }
}
const [{ default: PlaylistShell }, { default: PlaylistDetailPage }, { PlaylistImportProvider }] = await Promise.all([
  import('../../apps/desktop/src/renderer/src/components/PlaylistShell'),
  import('../../apps/desktop/src/renderer/src/pages/PlaylistDetailPage'),
  import('../../apps/desktop/src/renderer/src/components/playlistImport/PlaylistImportContext')
])
applyTheme('graphite')
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const root = createRoot(document.getElementById('root'))
if (import.meta.hot) import.meta.hot.dispose(() => { root.unmount(); client.clear() })
root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/playlists/0']}><PlaylistImportProvider>
  <div style={{ display: 'flex', height: '100vh', minWidth: 0, flex: 1 }}><Routes>
    <Route path="/playlists" element={<PlaylistShell />}><Route path=":playlistId" element={<PlaylistDetailPage />} /></Route>
  </Routes></div>
</PlaylistImportProvider></MemoryRouter></QueryClientProvider>)
