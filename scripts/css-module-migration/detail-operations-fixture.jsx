import React from 'react'
import { Route, Routes } from 'react-router-dom'
import DetailPage from '../../apps/desktop/src/renderer/src/pages/DetailPage'
import { AppBackgroundProvider } from '../../apps/desktop/src/renderer/src/components/AppBackgroundContext'
import { ImagePreviewOverlayProvider } from '../../apps/desktop/src/renderer/src/components/ImagePreviewOverlayContext'
import { AgentMetadataCollectorProvider } from '../../apps/desktop/src/renderer/src/components/agentMetadata/AgentMetadataCollectorContext'
import { ToastProvider } from '../../apps/desktop/src/renderer/src/components/Toast'

const longPath = '/fixture/影片资料/很长的资源目录/用于检查路径换行和可复制内容/ABC-123-完整影片资源.mp4'

function resource(id, kind, primary, strm = false) {
  return { id, video_id: 1, library_id: 3, root_id: kind === 'local' || strm ? 1 : null,
    kind, display_name: `测试资源 ${id}`, display_locator: kind === 'local' ? longPath : 'https://cdn.example/ABC-123.mp4',
    locator: kind === 'local' ? longPath : 'https://cdn.example/ABC-123.mp4',
    strm_source_path: strm ? longPath.replace('.mp4', '.strm') : null,
    is_primary: primary ? 1 : 0, size_bytes: 2147483648, duration_seconds: 7200,
    file_mtime_ms: null, add_time: '2026-09-20T08:00:00Z' }
}

export default function DetailOperationsFixture({ variant }) {
  const last = variant !== 'videoDetailOperations'
  const strm = variant === 'videoDetailLastStrm'
  const resources = last ? [resource(11, strm ? 'direct' : 'local', true, strm)]
    : [resource(11, 'local', true), resource(12, 'local', false), resource(13, 'direct', false)]
  const video = {
    id: 1, generation: 1, revision: 1, code: 'ABC-123', title: '影片详情操作验收',
    activeLibraryId: 3, libraries: [{ libraryId: 3, name: '测试媒体库', color: 'blue' }],
    cover_path: null, poster_path: null, summary: null, release_date: '2026-09-20',
    scraped_status: 1, has_pending_scrape: last, rating: 3, external_stats: [],
    actresses: [], tags: [], links: [], assets: [], resources, resource_count: resources.length,
    primary_resource_kind: resources[0].kind, resolved_duration_seconds: 7200,
    maker: null, publisher: null, director: null, series: null,
    last_scraped_at: null, updated_at: null, add_time: '2026-09-20T08:00:00Z'
  }
  const deferredCommand = (name, input) => {
    window.lastDetailCommand = { name, input }
    return new Promise((resolve, reject) => {
      window.resolveDetailCommand = resolve
      window.rejectDetailCommand = reject
    })
  }
  Object.assign(window.api.videos, {
    get: async () => video,
    list: async () => ({ items: [{ id: 1, code: 'ABC-123', title: video.title },
      { id: 2, code: 'ABC-123', title: '待合并的另一个同番号影片' }], total: 2 }),
    getResource: async (_library, _video, id) => resources.find(r => r.id === id),
    correctImport: async (...input) => deferredCommand('correct', input),
    updateLocalResourceLabel: async (...input) => deferredCommand('label', input),
    merge: async input => deferredCommand('merge', input),
    splitResource: async (...input) => deferredCommand('split', input),
    removeResource: async (...input) => deferredCommand('remove', input)
  })
  window.api.mediaLibraries.get = async () => ({ id: 3, name: '测试媒体库', config: { defaultVideoScraper: '' } })
  window.api.scrape = { listPlugins: async () => [], listPluginDetails: async () => [] }
  window.api.agentMetadata = { onSnapshotChanged: () => () => {} }
  return <ToastProvider><AppBackgroundProvider><ImagePreviewOverlayProvider>
    <AgentMetadataCollectorProvider><Routes>
      <Route path="/libraries/:libraryId/video/:videoId" element={<DetailPage />} />
    </Routes></AgentMetadataCollectorProvider>
  </ImagePreviewOverlayProvider></AppBackgroundProvider></ToastProvider>
}
