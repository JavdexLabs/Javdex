import React, { useState } from 'react'
import DirectorEditModal from '../../apps/desktop/src/renderer/src/components/DirectorEditModal'
import SeriesEditModal from '../../apps/desktop/src/renderer/src/components/SeriesEditModal'
import OrganizationEditModal from '../../apps/desktop/src/renderer/src/components/OrganizationEditModal'
import PlaylistCreateModal from '../../apps/desktop/src/renderer/src/components/PlaylistCreateModal'
import EditMetadataModal from '../../apps/desktop/src/renderer/src/components/EditMetadataModal'
import EditActressModal from '../../apps/desktop/src/renderer/src/components/EditActressModal'
import { ToastProvider } from '../../apps/desktop/src/renderer/src/components/Toast'
import workspaceStyles from '../../apps/desktop/src/renderer/src/components/settings/SettingsWorkspaceShell.module.css'

export default function NativeEditorsFixture({ variant }) {
  const [open, setOpen] = useState(true)
  window.api.organizations = { options: async () => [] }
  window.api.directors = { options: async () => [] }
  window.api.series = { options: async () => [] }
  const save = async input => {
    window.nativeEditorInput = input
    window.nativeEditorSaveCount = (window.nativeEditorSaveCount ?? 0) + 1
    await new Promise((resolve, reject) => {
      window.resolveNativeEditor = resolve
      window.rejectNativeEditor = reject
    })
    setOpen(false)
  }
  const common = { onSave: save, onCancel: () => setOpen(false) }
  const kind = variant.replace('nativeEditor', '').replace('Workspace', '')
  const editor = kind === 'Director' ? <DirectorEditModal {...common} />
    : kind === 'Series' ? <SeriesEditModal {...common} />
    : kind === 'Organization' ? <OrganizationEditModal role="maker" {...common} />
    : kind === 'Playlist' ? <PlaylistCreateModal onCreate={save} onCancel={common.onCancel} />
    : kind === 'Video' ? <EditMetadataModal video={{ id: 1, code: 'ABC-123', title: '',
      external_stats: [
        { id: 1, video_id: 1, source: '来源甲', rating_average: 4, rating_count: 100, fetched_at: '2026-09-20', is_default: 1 },
        { id: 2, video_id: 1, source: '来源乙', rating_average: 4.5, rating_count: 200, fetched_at: '2026-09-21', is_default: 0 }
      ],
      actresses: [], tags: [], links: [], cover_path: null, has_pending_scrape: false }} {...common} />
    : <EditActressModal actress={{ id: 1, main_name: '', gender: 'female', aliases: [], links: [],
      avatar_path: null, avatar_source_path: null, avatar_crop_json: null }} {...common} />
  return <ToastProvider><main className={variant.endsWith('Workspace') ? workspaceStyles.root : undefined}>
    {open ? editor : <p>已保存</p>}
  </main></ToastProvider>
}
