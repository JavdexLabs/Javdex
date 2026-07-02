import { useEffect, useState } from 'react'
import type { PlaylistListItem } from '@shared/types'
import { api, assetUrl } from '../api'
import { useToast } from './Toast'
import Modal from './Modal'

interface Props {
  videoIds: number[]
  onCancel: () => void
  onChanged?: () => void
}

export default function AddVideosToPlaylistModal({
  videoIds,
  onCancel,
  onChanged
}: Props): JSX.Element {
  const toast = useToast()
  const [items, setItems] = useState<PlaylistListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)

  useEffect(() => {
    setLoading(true)
    api.playlists
      .list()
      .then(setItems)
      .catch((e) => toast.show(String((e as Error).message), 'error'))
      .finally(() => setLoading(false))
  }, [toast])

  const addToPlaylist = async (playlistId: number): Promise<void> => {
    if (busyId !== null) return
    setBusyId(playlistId)
    let added = 0
    let failed = 0
    for (const videoId of videoIds) {
      try {
        if (await api.playlists.addVideo(playlistId, videoId)) added += 1
      } catch {
        failed += 1
      }
    }
    setItems((prev) =>
      prev.map((item) =>
        item.id === playlistId ? { ...item, video_count: item.video_count + added } : item
      )
    )
    if (failed > 0) {
      toast.show(`已加入 ${added} 部，${failed} 部失败`, 'error')
    } else if (added > 0) {
      toast.show(`已加入 ${added} 部影片`, 'success')
    } else {
      toast.show('所选影片已在该清单中', 'info')
    }
    setBusyId(null)
    onChanged?.()
  }

  return (
    <Modal
      title="批量加入播放清单"
      subtitle={`${videoIds.length} 部`}
      size="md"
      onCancel={onCancel}
      actions={
        <button type="button" className="btn" onClick={onCancel} disabled={busyId !== null}>
          关闭
        </button>
      }
    >
      {loading ? (
        <div className="empty-state empty-state--compact">
          <div className="spinner" />
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state empty-state--compact">
          <div>暂无播放清单，请先在「播放清单」页面创建。</div>
        </div>
      ) : (
        <div className="playlist-pick-list">
          {items.map((item) => {
            const cover = assetUrl(item.preview_cover_path)
            return (
              <div key={item.id} className="playlist-pick-row">
                <div className="playlist-pick-cover">
                  {cover ? <img src={cover} alt={item.name} /> : <span>▤</span>}
                </div>
                <div className="playlist-pick-main">
                  <div className="playlist-pick-name">{item.name}</div>
                  <div className="playlist-pick-meta">{item.video_count} 部影片</div>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busyId !== null}
                  onClick={() => void addToPlaylist(item.id)}
                >
                  {busyId === item.id ? '加入中…' : '加入'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
