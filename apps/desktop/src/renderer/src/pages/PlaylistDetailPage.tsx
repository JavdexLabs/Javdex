import ResultCount from '../components/ResultCount'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLocation, useMatch, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Filter, Import, Inbox, Pencil, SearchX, Trash2 } from 'lucide-react'
import { RECENT_PLAYBACK_LIST_ID } from '@shared/desktop/recentPlayback'
import { useDesktopSession } from '../desktop/DesktopSessionContext'
import type { SortDir } from '@shared/commonTypes'
import type { PlaylistMetadata, PlaylistUpdateInput, PlaylistVideoSortBy } from '@shared/playlistTypes'
import type { VideoCard } from '@shared/videoTypes'
import { api } from '../api'
import { expectedPlaylistVersion } from '@shared/protocol/versions'
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
import Switch from '../components/Switch'
import DetailActionBar from '../components/DetailActionBar'
import EmptyState from '../components/EmptyState'
import NoticeBanner, { NoticeBannerActions, NoticeBannerCopy } from '../components/NoticeBanner'
import { UI_ICON } from '../components/iconDefaults'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import RelatedLinksList from '../components/RelatedLinksList'
import Button from '../components/Button'
import PlaylistCover from '../components/PlaylistCover'
import { playlistCoverSource } from '../components/playlistCoverSource'
import DetailPane, { DetailPaneOverlay } from '../components/DetailPane'
import styles from './PlaylistDetailPage.module.css'
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

export default function PlaylistDetailPage(): JSX.Element {
  const { playlistId: playlistIdParam } = useParams()
  const playlistId = Number(playlistIdParam)
  const recent = playlistId === RECENT_PLAYBACK_LIST_ID
  const { session } = useDesktopSession()
  const recentScope = recent ? JSON.stringify([session.mode, session.serverId, session.catalogId, session.generation]) : null
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const toast = useToast()
  const playlistImport = usePlaylistImport()
  const videoStackOpen = Boolean(useMatch({ path: ROUTE_MATCH.playlistVideoStack, end: false }))
  const [detail, setDetail] = useState<(PlaylistMetadata & { local_kind?: 'recently_played' }) | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [recentLoadedScope, setRecentLoadedScope] = useState<string | null>(null)
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const metadataCache = useRef<{ key: string; value: PlaylistMetadata | null } | null>(null)
  const displayedMetadataKey = useRef<string | null>(null)
  const [showEdit, setShowEdit] = useState(false)
  const [savingPlayback, setSavingPlayback] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [videoRemoveTarget, setVideoRemoveTarget] = useState<VideoCard | null>(null)
  const [removingVideoId, setRemovingVideoId] = useState<number | null>(null)
  const [videoSortBy, setVideoSortBy] = useState<PlaylistVideoSortBy>('added_at')
  const [videoSortDir, setVideoSortDir] = useState<SortDir>('desc')
  const [resourceFilterOpen, setResourceFilterOpen] = useState(false)
  const resourceFilterButtonRef = useRef<HTMLButtonElement>(null)
  const previousVideoStackOpenRef = useRef(videoStackOpen)
  const resourceFilteringAllowed = !recent && !(detail?.id === playlistId && detail.system_kind === 'watch_later')
  const rawResourceFilters = searchParams.get(LIST_PARAM.resources)
  const resourceFilters = useMemo(() => resourceFilteringAllowed ? parseVideoResourceFilters(rawResourceFilters) : [],
    [resourceFilteringAllowed, rawResourceFilters])
  const resourceFilterKey = videoResourceFiltersParam(resourceFilters)
  const metadataKey = JSON.stringify([playlistId, videoSortBy, videoSortDir, recentScope])
  const loadKey = JSON.stringify([playlistId, videoSortBy, videoSortDir, resourceFilterKey, recentScope])
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
    setLoadError(null)
    try {
      const cached = metadataCache.current
      const metadata = !refreshMetadata && cached?.key === metadataKey
        ? cached.value
        : recent ? await api.recentPlayback.metadata() : await api.playlists.metadata(playlistId, videoSortBy, videoSortDir)
      if (sequence !== requestSequence.current || activeLoadKey.current !== loadKey) return
      metadataCache.current = { key: metadataKey, value: metadata }
      displayedMetadataKey.current = metadataKey
      setDetail(metadata)
      setRecentLoadedScope(recentScope)
      if (refreshMetadata) refreshVideos.current()
      setLoadedKey(loadKey)
    } catch (e) {
      if (sequence !== requestSequence.current || activeLoadKey.current !== loadKey) return
      toast.show(String((e as Error).message), 'error')
      setLoadError((e as Error).message)
      setRecentLoadedScope(recentScope)
      if (!recent || displayedMetadataKey.current !== metadataKey) setDetail(null)
    } finally {
      if (sequence === requestSequence.current && activeLoadKey.current === loadKey) setLoading(false)
    }
  }, [playlistId, recent, recentScope, toast, videoSortBy, videoSortDir, loadKey, metadataKey])

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
  useEffect(() => recent ? api.recentPlayback.onChanged(() => { void loadDetail() }) : undefined, [recent, loadDetail])

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

  const videoSession = `${playlistId}:${videoSortBy}:${videoSortDir}:${resourceFilterKey}:${recentScope ?? ''}`
  const { offset: relatedOffset, move: moveRelated, align: alignRelated } = useRelatedVideoOffset(videoSession)
  const videos = useContinuousPage(JSON.stringify(['playlist-videos', playlistId, videoSortBy, videoSortDir, resourceFilterKey, recentScope]), 60, async offset => {
    const query = { resourceKinds: parseVideoResourceFilters(resourceFilterKey), limit: 60, offset }
    const result = recent ? await api.recentPlayback.page(query)
      : await api.playlists.videoPage(playlistId, { ...query, sortBy: videoSortBy, sortDir: videoSortDir })
    return result ? { ...result, unfilteredTotal: result.total, items: result.videos, total: result.filteredTotal } : null
  }, displayedMetadataKey.current === metadataKey, relatedOffset)
  const refreshVideos = useRef(videos.reload); refreshVideos.current = videos.reload
  useEffect(() => { alignRelated(videos.known, videos.total) }, [alignRelated, videos.known, videos.total])

  const updatePlaylist = async (input: PlaylistUpdateInput): Promise<void> => {
    if (!detail) return
    await api.playlists.update(detail.id, input, expectedPlaylistVersion(detail))
    setShowEdit(false)
    toast.show('播放清单已更新', 'success')
    await loadDetail()
  }

  const deletePlaylist = async (): Promise<void> => {
    if (!detail) return
    if (recent) {
      if (clearing) return
      setClearing(true)
      try {
        await api.recentPlayback.clear()
        await loadDetail()
        setConfirmDelete(false)
        toast.show('本机最近播放已清空', 'success')
      } catch (error) { toast.show((error as Error).message, 'error') }
      finally { setClearing(false) }
      return
    }
    try {
      await api.playlists.remove(detail.id, expectedPlaylistVersion(detail))
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
      if (recent) await api.recentPlayback.remove(video.id)
      else await api.playlists.removeVideo(detail.id, video.id, expectedPlaylistVersion(detail))
      await loadDetail()
      setVideoRemoveTarget(null)
      toast.show(`已从清单移出 ${video.code}`, 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setRemovingVideoId(null)
    }
  }

  const videoOverlay =
    videoStackOpen ? (
      <DetailPaneOverlay>
        <Outlet />
      </DetailPaneOverlay>
    ) : null

  if (recent && recentLoadedScope !== recentScope || loading && (!detail || detail.id !== playlistId)) {
    return (
      <DetailPane stacked={videoStackOpen}>
        <EmptyState loading />
        {videoOverlay}
      </DetailPane>
    )
  }

  if (!detail) {
    return (
      <DetailPane stacked={videoStackOpen}>
        <DetailScrollBody onBack={() => navigateToPlaylistList(navigate, location)}>
          <EmptyState
            icon={<SearchX {...UI_ICON} aria-hidden />}
            title={recent && loadError ? '本机最近播放加载失败' : '未找到该清单'}
            description={recent && loadError ? loadError : '该播放清单可能已被删除。'}
          >
            {recent && loadError && <Button onClick={() => void loadDetail()}>重试</Button>}
          </EmptyState>
        </DetailScrollBody>
        {videoOverlay}
      </DetailPane>
    )
  }

  const cover = playlistCoverSource(detail)

  return (
    <DetailPane stacked={videoStackOpen}>
      <DetailScrollBody onBack={() => navigateToPlaylistList(navigate, location)}>

          <div className={styles.root} data-playlist-detail>
            <div className={styles.head}>
              <PlaylistCover variant="detail" playlist={detail} />
              <div className={styles.main}>
                <div className={styles.kicker}>清单</div>
                <h2 className={styles.title}>{detail.name}</h2>
                <div className={styles.metaRow}>
                  <span className={styles.metaBadge}>{(videos.page?.unfilteredTotal ?? 0)} 部影片</span>
                  <span className={styles.metaBadge}>{cover.kind === 'custom' ? '自定义封面' : cover.kind === 'builtin' ? '默认封面' : '自动封面'}</span>
                </div>
                {detail.description ? (
                  <p className={styles.description}>{detail.description}</p>
                ) : (
                  <p className={styles.description}>暂无简介</p>
                )}
                <RelatedLinksList links={detail.links ?? []} />
              </div>
              <div className={styles.actions}>
                <DetailActionBar
                  ariaLabel="清单操作"
                  variant="inline"
                  actions={recent ? [{ key: 'clear', icon: <Trash2 {...UI_ICON} />, label: '清空历史', onClick: () => setConfirmDelete(true) }] : [
                    ...(!detail.system_kind ? [{
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
                    }] : []),
                    {
                      key: 'edit',
                      icon: <Pencil {...UI_ICON} />,
                      label: '编辑',
                      onClick: () => setShowEdit(true)
                    }
                  ]}
                  menuItems={recent || detail.system_kind ? [] : [
                    {
                      key: 'delete',
                      label: '删除播放清单',
                      danger: true,
                      onClick: () => setConfirmDelete(true)
                    }
                  ]}
                />
                {detail.system_kind === 'watch_later' && <label className={styles.playbackToggle}>
                  播放后移除
                  <Switch aria-label="播放后移除" checked={detail.remove_after_play === 1} disabled={savingPlayback}
                    onChange={async event => {
                      const removeAfterPlay = event.target.checked
                      setSavingPlayback(true)
                      try {
                        await api.playlists.update(detail.id, { name: detail.name, description: detail.description, removeAfterPlay }, expectedPlaylistVersion(detail))
                        const metadata = await api.playlists.metadata(detail.id, videoSortBy, videoSortDir)
                        if (activeLoadKey.current !== loadKey) return
                        metadataCache.current = { key: metadataKey, value: metadata }
                        setDetail(metadata)
                      } catch (error) { toast.show((error as Error).message, 'error') }
                      finally { setSavingPlayback(false) }
                    }} />
                </label>}
              </div>
            </div>

            <div className={styles.sectionHead}>
              <div className={styles.sectionTitle}>
                影片
                {resourceFilters.length > 0 && (videos.page?.unfilteredTotal ?? 0) > 0 ? (
                  <span>
                    匹配 {videos.total} / 共 {(videos.page?.unfilteredTotal ?? 0)} 部
                  </span>
                ) : null}
              </div>
              <div className={styles.sectionControls}>
                {resourceFilteringAllowed && <Button
                  ref={resourceFilterButtonRef}
                  type="button"
                  size="sm"
                  aria-expanded={resourceFilterOpen}
                  aria-controls={`playlist-resource-filter-${detail.id}`}
                  onClick={() => setResourceFilterOpen((open) => !open)}
                >
                  <Filter {...UI_ICON} aria-hidden />
                  资源筛选{resourceFilters.length > 0 ? ` · ${resourceFilters.length}` : ''}
                </Button>}
                {recent ? <span>按最近播放 · 最新在前</span> : detail.system_kind === 'watch_later' ? <span>按加入时间 · 最早在前</span> : <SortSwitch
                  label="清单影片排序"
                  options={PLAYLIST_VIDEO_SORT_OPTIONS}
                  value={videoSortBy}
                  dir={videoSortDir}
                  compact
                  onChange={(nextSortBy, nextSortDir) => {
                    setVideoSortBy(nextSortBy)
                    setVideoSortDir(nextSortDir)
                  }}
                />}
                <ResultCount stable={false}>{videos.total}</ResultCount>

              </div>
            </div>

            {(loading && loadedKey !== loadKey) || videos.loading ? <EmptyState loading variant="compact" /> : videos.error && videos.total === 0 ? <EmptyState variant="compact" title="清单影片加载失败" description={videos.error}><Button onClick={videos.reload}>重试</Button></EmptyState> : (videos.page?.unfilteredTotal ?? 0) === 0 ? (
              <EmptyState
                variant="compact"
                icon={<Inbox {...UI_ICON} aria-hidden />}
                title="清单内暂无影片"
                description={recent ? '在本机播放影片后会自动出现在这里。' : '可在影片详情页通过「加入清单」添加。'}
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
            {recent && loadError && <NoticeBanner tone="warning" role="alert">
              <NoticeBannerCopy title="最近播放更新失败" body={`正在显示上次读取的记录。${loadError}`} />
              <NoticeBannerActions><Button size="sm" onClick={() => void loadDetail()}>重试</Button></NoticeBannerActions>
            </NoticeBanner>}
          </div>
      </DetailScrollBody>

      {resourceFilteringAllowed && <PlaylistResourceFilterPopover
        id={`playlist-resource-filter-${detail.id}`}
        open={resourceFilterOpen}
        anchorRef={resourceFilterButtonRef}
        value={resourceFilters}
        onChange={setResourceFilters}
        onClose={() => setResourceFilterOpen(false)}
      />}

      {showEdit && (
        <PlaylistCreateModal
          playlist={detail}
          currentCoverUrl={cover.url}
          onCancel={() => setShowEdit(false)}
          onUpdate={updatePlaylist}
        />
      )}

      {confirmDelete && (
        <Modal
          title={recent ? '清空本机最近播放' : '删除播放清单'}
          danger
          confirmText={recent ? '清空' : '删除'}
          busy={clearing}
          onConfirm={() => void deletePlaylist()}
          onCancel={() => setConfirmDelete(false)}
        >
          {recent ? '仅清空此设备在当前资料库的播放历史，不删除影片、续播进度或其他设备记录。' : `确定删除「${detail.name}」？不会删除清单中的影片资源。`}
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
    </DetailPane>
  )
}
