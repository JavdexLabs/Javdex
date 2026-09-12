import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useMatch, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Filter, Import, Inbox, Pencil, SearchX } from 'lucide-react'
import type { SortDir } from '@shared/commonTypes'
import type { PlaylistMetadata, PlaylistUpdateInput, PlaylistVideoSortBy } from '@shared/playlistTypes'
import type { VideoCard } from '@shared/videoTypes'
import { api, assetUrl } from '../api'
import { navigateToPlaylistList } from '../listView/listNavigation'
import { ROUTE_MATCH } from '../listView/routePaths'
import { useToast } from '../components/Toast'
import Modal from '../components/Modal'
import PlaylistCreateModal from '../components/PlaylistCreateModal'
import ContinuousPosterGrid from '../components/ContinuousPosterGrid'
import { useContinuousPage } from '../hooks/useContinuousPage'
import { useRelatedVideoOffset } from '../hooks/useRelatedVideoOffset'
import DetailScrollBody from '../components/DetailScrollBody'
import SortSwitch, { type SortSwitchOption } from '../components/SortSwitch'
import DetailActionBar from '../components/DetailActionBar'
import EmptyState from '../components/EmptyState'
import { UI_ICON } from '../components/iconDefaults'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import RelatedLinksList from '../components/RelatedLinksList'
import Button from '../components/Button'
import PlaylistResourceFilterPopover from '../components/PlaylistResourceFilterPopover'
import {
  LIST_PARAM,
  parseVideoResourceFilters,
  patchSearchParams,
  videoResourceFiltersParam
} from '../listView/listQueryParams'
import { usePlaylistImport } from '../components/playlistImport/PlaylistImportContext'
import { onPlaylistImportCompleted } from '../components/playlistImport/events'

const PLAYLIST_VIDEO_SORT_OPTIONS: SortSwitchOption<PlaylistVideoSortBy>[] = [
  { value: 'added_at', label: '加入', title: '加入时间' },
  { value: 'release_date', label: '发行', title: '发行日期' }
]

function playlistDetailCover(detail: PlaylistMetadata): string | null {
  return assetUrl(
    detail.cover_path ?? detail.preview_cover_path ?? null
  )
}

export default function PlaylistDetailPage(): JSX.Element {
  const { playlistId: playlistIdParam } = useParams()
  const playlistId = Number(playlistIdParam)
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const toast = useToast()
  const playlistImport = usePlaylistImport()
  const videoStackOpen = Boolean(useMatch({ path: ROUTE_MATCH.playlistVideoStack, end: false }))
  const [detail, setDetail] = useState<PlaylistMetadata | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const metadataCache = useRef<{ key: string; value: PlaylistMetadata | null } | null>(null)
  const [showEdit, setShowEdit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [videoRemoveTarget, setVideoRemoveTarget] = useState<VideoCard | null>(null)
  const [removingVideoId, setRemovingVideoId] = useState<number | null>(null)
  const [videoSortBy, setVideoSortBy] = useState<PlaylistVideoSortBy>('added_at')
  const [videoSortDir, setVideoSortDir] = useState<SortDir>('desc')
  const [resourceFilterOpen, setResourceFilterOpen] = useState(false)
  const resourceFilterButtonRef = useRef<HTMLButtonElement>(null)
  const previousVideoStackOpenRef = useRef(videoStackOpen)
  const resourceFilters = parseVideoResourceFilters(searchParams.get(LIST_PARAM.resources))
  const resourceFilterKey = videoResourceFiltersParam(resourceFilters)
  const metadataKey = JSON.stringify([playlistId, videoSortBy, videoSortDir])
  const loadKey = JSON.stringify([playlistId, videoSortBy, videoSortDir, resourceFilterKey])
  const activeLoadKey = useRef(loadKey)
  activeLoadKey.current = loadKey


  const dismissOverlays = useCallback(() => {
    setShowEdit(false)
    setConfirmDelete(false)
    setVideoRemoveTarget(null)
    setResourceFilterOpen(false)
  }, [])

  useDismissOverlaysOnNavigate(dismissOverlays, location.pathname)

  const loadDetail = useCallback(async (refreshMetadata = true): Promise<void> => {
    if (Number.isNaN(playlistId) || activeLoadKey.current !== loadKey) return
    const sequence = ++requestSequence.current
    if (refreshMetadata) metadataCache.current = null
    setLoading(true)
    try {
      const cached = metadataCache.current
      const metadata = !refreshMetadata && cached?.key === metadataKey
        ? cached.value
        : await api.playlists.metadata(playlistId, videoSortBy, videoSortDir)
      if (sequence !== requestSequence.current || activeLoadKey.current !== loadKey) return
      metadataCache.current = { key: metadataKey, value: metadata }
      setDetail(metadata)
      if (refreshMetadata) refreshVideos.current()
      setLoadedKey(loadKey)
    } catch (e) {
      if (sequence !== requestSequence.current || activeLoadKey.current !== loadKey) return
      toast.show(String((e as Error).message), 'error')
      setDetail(null)
    } finally {
      if (sequence === requestSequence.current && activeLoadKey.current === loadKey) setLoading(false)
    }
  }, [playlistId, toast, videoSortBy, videoSortDir, loadKey, metadataKey])

  const invalidatePendingRequest = useCallback(() => {
    requestSequence.current++
  }, [])

  useEffect(() => {
    void loadDetail(false)
    return invalidatePendingRequest
  }, [loadDetail, invalidatePendingRequest])

  useEffect(() => onPlaylistImportCompleted((completedPlaylistId) => {
    if (completedPlaylistId === playlistId) void loadDetail()
  }), [loadDetail, playlistId])

  useEffect(() => {
    const raw = searchParams.get(LIST_PARAM.resources)
    const canonical = videoResourceFiltersParam(resourceFilters)
    if (raw === canonical) return
    setSearchParams(
      (current) => patchSearchParams(current, { [LIST_PARAM.resources]: canonical }),
      { replace: true }
    )
  }, [resourceFilters, searchParams, setSearchParams])

  useEffect(() => {
    const wasOpen = previousVideoStackOpenRef.current
    previousVideoStackOpenRef.current = videoStackOpen
    if (wasOpen && !videoStackOpen) void loadDetail()
  }, [loadDetail, videoStackOpen])

  const setResourceFilters = useCallback((filters: typeof resourceFilters): void => {
    setSearchParams(
      (current) => patchSearchParams(current, {
        [LIST_PARAM.resources]: videoResourceFiltersParam(filters)
      }),
      { replace: true }
    )
  }, [setSearchParams])

  const videoSession = `${playlistId}:${videoSortBy}:${videoSortDir}:${resourceFilterKey}`
  const { offset: relatedOffset, move: moveRelated, align: alignRelated } = useRelatedVideoOffset(videoSession)
  const videos = useContinuousPage(JSON.stringify(['playlist-videos', playlistId, videoSortBy, videoSortDir, resourceFilterKey]), 60, async offset => {
    const result = await api.playlists.videoPage(playlistId, { sortBy: videoSortBy, sortDir: videoSortDir, resourceKinds: parseVideoResourceFilters(resourceFilterKey), limit: 60, offset })
    return result ? { ...result, unfilteredTotal: result.total, items: result.videos, total: result.filteredTotal } : null
  }, true, relatedOffset)
  const refreshVideos = useRef(videos.reload); refreshVideos.current = videos.reload
  useEffect(() => { alignRelated(videos.known, videos.total) }, [alignRelated, videos.known, videos.total])

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

  const removeVideo = async (video: VideoCard): Promise<void> => {
    if (!detail || removingVideoId !== null) return
    setRemovingVideoId(video.id)
    try {
      await api.playlists.removeVideo(detail.id, video.id)
      await loadDetail()
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

  if (loading && (!detail || detail.id !== playlistId)) {
    return (
      <div className={`detail-pane${videoStackOpen ? ' detail-pane--stacked' : ''}`}>
        <EmptyState loading />
        {videoOverlay}
      </div>
    )
  }

  if (!detail) {
    return (
      <div className={`detail-pane${videoStackOpen ? ' detail-pane--stacked' : ''}`}>
        <DetailScrollBody onBack={() => navigateToPlaylistList(navigate, location)}>
          <EmptyState
            icon={<SearchX {...UI_ICON} aria-hidden />}
            title="未找到该清单"
            description="该播放清单可能已被删除。"
          />
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
                  <span>{(videos.page?.unfilteredTotal ?? 0)} 部影片</span>
                  <span>{detail.cover_path ? '自定义封面' : '自动封面'}</span>
                </div>
                {detail.description ? (
                  <p>{detail.description}</p>
                ) : (
                  <p className="playlist-detail-empty-desc">暂无简介</p>
                )}
                <RelatedLinksList links={detail.links ?? []} />
              </div>
              <div className="playlist-detail-actions">
                <DetailActionBar
                  ariaLabel="清单操作"
                  variant="inline"
                  actions={[
                    {
                      key: 'import',
                      icon: <Import {...UI_ICON} />,
                      label: '从网页导入',
                      onClick: () => playlistImport.open({
                        destination: {
                          kind: 'append',
                          playlistId: detail.id,
                          playlistName: detail.name
                        }
                      })
                    },
                    {
                      key: 'edit',
                      icon: <Pencil {...UI_ICON} />,
                      label: '编辑',
                      onClick: () => setShowEdit(true)
                    }
                  ]}
                  menuItems={[
                    {
                      key: 'delete',
                      label: '删除播放清单',
                      danger: true,
                      onClick: () => setConfirmDelete(true)
                    }
                  ]}
                />
              </div>
            </div>

            <div className="playlist-section-head">
              <div className="section-title">
                影片
                {resourceFilters.length > 0 && (videos.page?.unfilteredTotal ?? 0) > 0 ? (
                  <span className="section-title-detail">
                    匹配 {videos.total} / 共 {(videos.page?.unfilteredTotal ?? 0)} 部
                  </span>
                ) : null}
              </div>
              <div className="playlist-section-controls">
                <Button
                  ref={resourceFilterButtonRef}
                  type="button"
                  size="sm"
                  aria-expanded={resourceFilterOpen}
                  aria-controls={`playlist-resource-filter-${detail.id}`}
                  onClick={() => setResourceFilterOpen((open) => !open)}
                >
                  <Filter {...UI_ICON} aria-hidden />
                  资源筛选{resourceFilters.length > 0 ? ` · ${resourceFilters.length}` : ''}
                </Button>
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
                <span className="count-badge">{videos.total}</span>

              </div>
            </div>

            {(loading && loadedKey !== loadKey) || videos.loading ? <EmptyState loading variant="compact" /> : videos.error && videos.total === 0 ? <EmptyState variant="compact" title="清单影片加载失败" description={videos.error}><Button onClick={videos.reload}>重试</Button></EmptyState> : (videos.page?.unfilteredTotal ?? 0) === 0 ? (
              <EmptyState
                variant="compact"
                icon={<Inbox {...UI_ICON} aria-hidden />}
                title="清单内暂无影片"
                description="可在影片详情页通过「加入清单」添加。"
              />
            ) : videos.total === 0 ? (
              <EmptyState
                variant="compact"
                icon={<SearchX {...UI_ICON} aria-hidden />}
                title="没有符合资源筛选的影片"
                description="清除筛选后可查看清单中的全部影片。"
              >
                <Button size="sm" onClick={() => setResourceFilters([])}>清除筛选</Button>
              </EmptyState>
            ) : (
              <ContinuousPosterGrid window={videos.window} initialIndex={relatedOffset} onAnchor={index => moveRelated(Math.floor(index / 60) * 60)} scope={`playlist-videos:${playlistId}:${videoSortBy}:${videoSortDir}:${resourceFilterKey}`} onRemove={setVideoRemoveTarget} removeDisabled={removingVideoId !== null} />
            )}
          </div>
      </DetailScrollBody>

      <PlaylistResourceFilterPopover
        id={`playlist-resource-filter-${detail.id}`}
        open={resourceFilterOpen}
        anchorRef={resourceFilterButtonRef}
        value={resourceFilters}
        onChange={setResourceFilters}
        onClose={() => setResourceFilterOpen(false)}
      />

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
          确定删除「{detail.name}」？不会删除清单中的影片资源。
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
          确定将「{videoRemoveTarget.code}」从清单「{detail.name}」中移出？不会删除影片资源。
        </Modal>
      )}

      {videoOverlay}
    </div>
  )
}
