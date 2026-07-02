import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useMatch, useNavigate, useParams } from 'react-router-dom'
import { Ellipsis, Pencil } from 'lucide-react'
import type {
  PlaylistDetail,
  PlaylistUpdateInput,
  PlaylistVideoSortBy,
  PlaylistVideoSortDir,
  Video
} from '@shared/types'
import { api, assetUrl } from '../api'
import { navigateToPlaylistList } from '../listView/listNavigation'
import { ROUTE_MATCH } from '../listView/routePaths'
import { useToast } from '../components/Toast'
import Modal from '../components/Modal'
import PlaylistCreateModal from '../components/PlaylistCreateModal'
import PosterCard from '../components/PosterCard'
import DetailScrollBody from '../components/DetailScrollBody'
import SortSwitch, { type SortSwitchOption } from '../components/SortSwitch'
import IconButton from '../components/IconButton'
import { UI_ICON } from '../components/iconDefaults'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { useEscapeKey } from '../hooks/useEscapeKey'

const PLAYLIST_VIDEO_SORT_OPTIONS: SortSwitchOption<PlaylistVideoSortBy>[] = [
  { value: 'added_at', label: '加入', title: '加入时间' },
  { value: 'release_date', label: '发行', title: '发行日期' }
]

function playlistDetailCover(detail: PlaylistDetail): string | null {
  return assetUrl(
    detail.cover_path ?? detail.videos.find((video) => video.cover_path)?.cover_path ?? null
  )
}

export default function PlaylistDetailPage(): JSX.Element {
  const { playlistId: playlistIdParam } = useParams()
  const playlistId = Number(playlistIdParam)
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const videoStackOpen = Boolean(useMatch({ path: ROUTE_MATCH.playlistVideoStack, end: false }))
  const [detail, setDetail] = useState<PlaylistDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [showEdit, setShowEdit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [videoRemoveTarget, setVideoRemoveTarget] = useState<Video | null>(null)
  const [removingVideoId, setRemovingVideoId] = useState<number | null>(null)
  const [videoSortBy, setVideoSortBy] = useState<PlaylistVideoSortBy>('added_at')
  const [videoSortDir, setVideoSortDir] = useState<PlaylistVideoSortDir>('desc')
  const [moreOpen, setMoreOpen] = useState(false)
  const moreActionsRef = useRef<HTMLDivElement>(null)

  const dismissOverlays = useCallback(() => {
    setShowEdit(false)
    setConfirmDelete(false)
    setVideoRemoveTarget(null)
    setMoreOpen(false)
  }, [])

  useDismissOverlaysOnNavigate(dismissOverlays, location.pathname)

  useEscapeKey(() => setMoreOpen(false), moreOpen)

  useEffect(() => {
    if (!moreOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!moreActionsRef.current?.contains(e.target as Node)) {
        setMoreOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [moreOpen])

  const loadDetail = useCallback(async (): Promise<void> => {
    if (Number.isNaN(playlistId)) return
    setLoading(true)
    try {
      setDetail(await api.playlists.get(playlistId, videoSortBy, videoSortDir))
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
      setDetail(null)
    } finally {
      setLoading(false)
    }
  }, [playlistId, toast, videoSortBy, videoSortDir])

  useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  const updatePlaylist = async (input: PlaylistUpdateInput): Promise<void> => {
    if (!detail) return
    try {
      await api.playlists.update(detail.id, input)
      setShowEdit(false)
      toast.show('播放清单已更新', 'success')
      await loadDetail()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const deletePlaylist = async (): Promise<void> => {
    if (!detail) return
    try {
      await api.playlists.remove(detail.id)
      setConfirmDelete(false)
      toast.show('播放清单已删除', 'success')
      navigateToPlaylistList(navigate, location)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const removeVideo = async (video: Video): Promise<void> => {
    if (!detail || removingVideoId !== null) return
    setRemovingVideoId(video.id)
    try {
      await api.playlists.removeVideo(detail.id, video.id)
      setDetail((prev) =>
        prev ? { ...prev, videos: prev.videos.filter((item) => item.id !== video.id) } : prev
      )
      setVideoRemoveTarget(null)
      toast.show(`已从清单移出 ${video.code}`, 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setRemovingVideoId(null)
    }
  }

  const renderCover = (cover: string | null, label: string): JSX.Element =>
    cover ? <img src={cover} alt={label} /> : <span>无封面</span>

  const videoOverlay =
    videoStackOpen ? (
      <div className="detail-pane-overlay">
        <Outlet />
      </div>
    ) : null

  if (loading && !detail) {
    return (
      <div className={`detail-pane${videoStackOpen ? ' detail-pane--stacked' : ''}`}>
        <div className="empty-state">
          <div className="spinner" />
        </div>
        {videoOverlay}
      </div>
    )
  }

  if (!detail) {
    return (
      <div className={`detail-pane${videoStackOpen ? ' detail-pane--stacked' : ''}`}>
        <DetailScrollBody onBack={() => navigateToPlaylistList(navigate, location)}>
          <div className="empty-state">
            <div>未找到该清单</div>
          </div>
        </DetailScrollBody>
        {videoOverlay}
      </div>
    )
  }

  const cover = playlistDetailCover(detail)

  return (
    <div className={`detail-pane${videoStackOpen ? ' detail-pane--stacked' : ''}`}>
      <DetailScrollBody onBack={() => navigateToPlaylistList(navigate, location)}>

          <div className="playlist-detail">
            <div className="playlist-detail-head">
              <div className="playlist-detail-cover">{renderCover(cover, detail.name)}</div>
              <div className="playlist-detail-main">
                <div className="playlist-detail-kicker">清单</div>
                <h2>{detail.name}</h2>
                <div className="playlist-detail-meta-row">
                  <span>{detail.videos.length} 部影片</span>
                  <span>{detail.cover_path ? '自定义封面' : '自动封面'}</span>
                </div>
                {detail.description ? (
                  <p>{detail.description}</p>
                ) : (
                  <p className="playlist-detail-empty-desc">暂无简介</p>
                )}
              </div>
              <div className="playlist-detail-actions">
                <div
                  className="detail-action-group detail-action-group--icons"
                  role="group"
                  aria-label="清单操作"
                >
                  <IconButton
                    className="detail-icon-action"
                    icon={<Pencil {...UI_ICON} />}
                    label="编辑"
                    onClick={() => setShowEdit(true)}
                  />
                </div>
                <div className="detail-more-actions" ref={moreActionsRef}>
                  <IconButton
                    className="detail-icon-action"
                    icon={<Ellipsis {...UI_ICON} />}
                    label="更多"
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                    onClick={() => setMoreOpen((open) => !open)}
                  />
                  {moreOpen && (
                    <div className="detail-more-menu" role="menu">
                      <button
                        type="button"
                        className="detail-menu-item detail-menu-item--danger"
                        role="menuitem"
                        onClick={() => {
                          setMoreOpen(false)
                          setConfirmDelete(true)
                        }}
                      >
                        删除播放清单
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="playlist-section-head">
              <div className="section-title">影片</div>
              <div className="playlist-section-controls">
                <SortSwitch
                  label="清单影片排序"
                  options={PLAYLIST_VIDEO_SORT_OPTIONS}
                  value={videoSortBy}
                  dir={videoSortDir}
                  compact
                  onChange={(nextSortBy, nextSortDir) => {
                    setVideoSortBy(nextSortBy)
                    setVideoSortDir(nextSortDir)
                  }}
                />
                <span className="count-badge">{detail.videos.length}</span>
              </div>
            </div>

            {detail.videos.length === 0 ? (
              <div className="empty-state empty-state--compact">
                <div>清单内暂无影片。可在影片详情页通过「加入清单」添加。</div>
              </div>
            ) : (
              <div className="playlist-video-grid">
                {detail.videos.map((video) => (
                  <PosterCard
                    key={video.id}
                    video={video}
                    onRemove={() => setVideoRemoveTarget(video)}
                    removeDisabled={removingVideoId !== null}
                  />
                ))}
              </div>
            )}
          </div>
      </DetailScrollBody>

      {showEdit && (
        <PlaylistCreateModal
          playlist={detail}
          currentCoverUrl={playlistDetailCover(detail)}
          onCancel={() => setShowEdit(false)}
          onUpdate={updatePlaylist}
        />
      )}

      {confirmDelete && (
        <Modal
          title="删除播放清单"
          danger
          confirmText="删除"
          onConfirm={() => void deletePlaylist()}
          onCancel={() => setConfirmDelete(false)}
        >
          确定删除「{detail.name}」？不会删除清单中的影片文件。
        </Modal>
      )}

      {videoRemoveTarget && (
        <Modal
          title="移出影片"
          danger
          confirmText={removingVideoId === videoRemoveTarget.id ? '移出中…' : '移出'}
          confirmDisabled={removingVideoId !== null}
          onConfirm={() => void removeVideo(videoRemoveTarget)}
          onCancel={() => setVideoRemoveTarget(null)}
        >
          确定将「{videoRemoveTarget.code}」从清单「{detail.name}」中移出？不会删除本地影片文件。
        </Modal>
      )}

      {videoOverlay}
    </div>
  )
}
