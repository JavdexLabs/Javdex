import { useEffect, useMemo, useState } from 'react'
import { ListVideo, SearchX } from 'lucide-react'
import type { PlaylistVideoMembership } from '@shared/types'
import { api, assetUrl } from '../api'
import { useToast } from './Toast'
import Modal from './Modal'
import EmptyState from './EmptyState'
import { UI_ICON_SM } from './iconDefaults'

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
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | 'create' | null>(null)

  const queryText = query.trim()
  const queryLower = queryText.toLocaleLowerCase()
  const filteredItems = useMemo(() => {
    if (!queryLower) return items
    return items.filter((item) => {
      const name = item.name.toLocaleLowerCase()
      const description = item.description?.toLocaleLowerCase() ?? ''
      return name.includes(queryLower) || description.includes(queryLower)
    })
  }, [items, queryLower])
  const hasExactName = Boolean(
    queryLower && items.some((item) => item.name.trim().toLocaleLowerCase() === queryLower)
  )
  const canCreate = Boolean(queryText) && !hasExactName

  useEffect(() => {
    setLoading(true)
    api.playlists
      .listForVideo(videoId)
      .then(setItems)
      .catch((e) => toast.show(String((e as Error).message), 'error'))
      .finally(() => setLoading(false))
  }, [videoId, toast])

  const reloadPlaylists = async (): Promise<void> => {
    setItems(await api.playlists.listForVideo(videoId))
  }

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

  const removeFromPlaylist = async (playlistId: number): Promise<void> => {
    if (busyId !== null) return
    setBusyId(playlistId)
    try {
      const removed = await api.playlists.removeVideo(playlistId, videoId)
      setItems((prev) =>
        prev.map((item) =>
          item.id === playlistId
            ? {
                ...item,
                contains_video: false,
                video_count: removed ? Math.max(0, item.video_count - 1) : item.video_count
              }
            : item
        )
      )
      toast.show(removed ? '已从清单移出' : '影片不在该清单中', removed ? 'success' : 'info')
      onChanged?.()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setBusyId(null)
    }
  }

  const createAndAddToPlaylist = async (): Promise<void> => {
    if (busyId !== null || !canCreate) return
    setBusyId('create')
    try {
      const playlistId = await api.playlists.create({ name: queryText })
      const added = await api.playlists.addVideo(playlistId, videoId)
      await reloadPlaylists()
      setQuery('')
      toast.show(added ? '已创建清单并加入影片' : '清单已创建，影片已在该清单中', added ? 'success' : 'info')
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
      className="modal--playlist-picker"
      onCancel={onCancel}
      actions={
        <button type="button" className="btn" onClick={onCancel}>
          关闭
        </button>
      }
    >
      {loading ? (
        <EmptyState variant="modal" loading />
      ) : (
        <div className="playlist-pick-panel">
          <div className="playlist-pick-toolbar">
            <input
              className="text-input playlist-pick-search"
              value={query}
              placeholder="搜索或输入新清单名称"
              aria-label="搜索或输入新清单名称"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canCreate) {
                  event.preventDefault()
                  void createAndAddToPlaylist()
                }
              }}
              autoFocus
            />
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!canCreate || busyId !== null}
              title={hasExactName ? '已有同名清单，请直接加入' : undefined}
              onClick={() => void createAndAddToPlaylist()}
            >
              {busyId === 'create' ? '创建中…' : '创建并加入'}
            </button>
          </div>
          {items.length === 0 ? (
            <EmptyState
              variant="modal"
              icon={<ListVideo {...UI_ICON_SM} aria-hidden />}
              title="暂无播放清单"
              description="输入名称创建第一个播放清单。"
            />
          ) : filteredItems.length === 0 ? (
            <EmptyState
              variant="modal"
              icon={<SearchX {...UI_ICON_SM} aria-hidden />}
              title="没有匹配的清单"
              description="调整搜索关键词，或直接创建新清单。"
            />
          ) : (
            <div className="playlist-pick-list">
              {filteredItems.map((item) => {
                const cover = assetUrl(item.preview_cover_path)
                return (
                  <div key={item.id} className="playlist-pick-row">
                    <div className="playlist-pick-cover">
                      {cover ? (
                        <img src={cover} alt={item.name} />
                      ) : (
                        <span className="playlist-pick-cover-placeholder" aria-hidden="true">
                          <ListVideo {...UI_ICON_SM} />
                        </span>
                      )}
                    </div>
                    <div className="playlist-pick-main">
                      <div className="playlist-pick-name">{item.name}</div>
                      <div className="playlist-pick-meta">{item.video_count} 部影片</div>
                    </div>
                    <button
                      type="button"
                      className={`btn btn-sm${item.contains_video ? ' playlist-pick-remove-btn' : ''}`}
                      disabled={busyId !== null}
                      onClick={() =>
                        void (item.contains_video
                          ? removeFromPlaylist(item.id)
                          : addToPlaylist(item.id))
                      }
                    >
                      {busyId === item.id ? '处理中…' : item.contains_video ? '移出' : '加入'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
