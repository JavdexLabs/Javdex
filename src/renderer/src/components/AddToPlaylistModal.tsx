import { useEffect, useState } from 'react'
import type { PlaylistVideoMembership } from '@shared/types'
import { api, assetUrl } from '../api'
import { useToast } from './Toast'
import Modal from './Modal'

interface Props {
  videoId: number
  videoCode: string
  onCancel: () => void
  onChanged?: () => void
}

export default function AddToPlaylistModal({
  videoId,
  videoCode,
  onCancel,
  onChanged
}: Props): JSX.Element {
  const toast = useToast()
  const [items, setItems] = useState<PlaylistVideoMembership[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)

  useEffect(() => {
    setLoading(true)
    api.playlists
      .listForVideo(videoId)
      .then(setItems)
      .catch((e) => toast.show(String((e as Error).message), 'error'))
      .finally(() => setLoading(false))
  }, [videoId, toast])

  const addToPlaylist = async (playlistId: number): Promise<void> => {
    if (busyId !== null) return
    setBusyId(playlistId)
    try {
      const added = await api.playlists.addVideo(playlistId, videoId)
      setItems((prev) =>
        prev.map((item) =>
          item.id === playlistId
            ? {
                ...item,
                contains_video: true,
                video_count: added ? item.video_count + 1 : item.video_count
              }
            : item
        )
      )
      toast.show(added ? '已加入清单' : '影片已在该清单中', added ? 'success' : 'info')
      onChanged?.()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Modal
      title="加入播放清单"
      subtitle={videoCode}
      size="md"
      onCancel={onCancel}
      actions={
        <button type="button" className="btn" onClick={onCancel}>
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
            const cover = assetUrl(item.cover_path)
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
                  disabled={busyId !== null || item.contains_video}
                  onClick={() => void addToPlaylist(item.id)}
                >
                  {item.contains_video ? '已加入' : busyId === item.id ? '加入中…' : '加入'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
