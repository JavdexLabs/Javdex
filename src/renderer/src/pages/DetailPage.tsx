import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Outlet, useLocation, useMatch, useNavigate, useParams } from 'react-router-dom'
import { Bot, ListPlus, Pencil, Play, SearchCheck, SearchX } from 'lucide-react'
import type {
  LastVideoResourceRemovalMode,
  Video,
  VideoResource,
  VideoResourceDetail
} from '@shared/videoTypes'
import type { ScopedVideoDetail } from '@shared/catalogTypes'
import type { VideoLifecycleImpact } from '@shared/videoLifecycleTypes'
import { normalizeVideoCode } from '@shared/videoCode'
import { api, assetUrl } from '../api'
import { useToast } from '../components/Toast'
import Modal from '../components/Modal'
import { AppFormField } from '../components/FormPrimitives'
import SelectControl from '../components/SelectControl'
import EditMetadataModal from '../components/EditMetadataModal'
import ScrapeFieldsModal from '../components/ScrapeFieldsModal'
import ActressName from '../components/ActressName'
import VideoSampleGallery from '../components/VideoSampleGallery'
import VideoTagPanel from '../components/VideoTagPanel'
import RelatedLinksList from '../components/RelatedLinksList'
import AddToPlaylistModal from '../components/AddToPlaylistModal'
import DetailScrollBody from '../components/DetailScrollBody'
import MetaLink from '../components/MetaLink'
import {
  VideoDetailPrimaryMeta,
  VideoDetailSecondaryMeta,
  VideoMaintenanceInfo,
  getVideoScrapeStatusLabel
} from '../components/VideoDetailMeta'
import VideoDetailRatings from '../components/VideoDetailRatings'
import ImagePreviewLightbox from '../components/ImagePreviewLightbox'
import { useHistoryBackedImagePreviewState } from '../components/ImagePreviewOverlayContext'
import DetailActionBar from '../components/DetailActionBar'
import EmptyState from '../components/EmptyState'
import { UI_ICON } from '../components/iconDefaults'
import { useAppBackground } from '../components/AppBackgroundContext'
import ActressAvatar from '../components/ActressAvatar'
import type { VideoEditInput } from '@shared/videoTypes'
import type {
  VideoDirectorChoiceRequired,
  VideoScrapeField,
  VideoScrapeUpdateMode
} from '@shared/videoScrapeTypes'
import { VIDEO_SCRAPE_FIELD_OPTIONS, VIDEO_SCRAPE_UPDATE_MODE_OPTIONS, ALL_VIDEO_SCRAPE_FIELDS } from '@shared/videoScrapeTypes'
import { splitVideoCode } from '@shared/codeUtils'
import { resolveVideoDetailDisplayBackgroundPath } from '@shared/detailDisplayBackground'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import {
  navigateBackFromVideoDetail,
  navigateToActressFromVideoDetail,
  navigateToVideoListSurface,
  navigateToVideoDetail
} from '../listView/listNavigation'
import { LIST_PARAM } from '../listView/listQueryParams'
import { ROUTE_MATCH } from '../listView/routePaths'
import { pendingCenterPath } from '../listView/pendingRoutes'
import { useScraperPluginCatalog } from '../hooks/useScraperPluginCatalog'
import { invalidateVideoLibraryQueries } from '../query/invalidateLibraryQueries'
import { settingsPath } from '../settings/settingsRoutes'
import VideoResourceImportModal from '../components/VideoResourceImportModal'
import VideoResourceMoveModal from '../components/VideoResourceMoveModal'
import DirectorScrapeChoiceModal from '../components/DirectorScrapeChoiceModal'
import Button from '../components/Button'
import VideoLibraryMembershipBadges from '../components/VideoLibraryMembershipBadges'
import VideoDeleteImpact from '../components/VideoDeleteImpact'
import { isVideoBusinessIdentityConflictError } from './videoBusinessIdentityConflict'
import { useAgentMetadataCollector } from '../components/agentMetadata/AgentMetadataCollectorContext'
import { ALL_CATALOG_SCOPE, mediaLibraryCatalogScope } from '../query/catalogScopes'
import {
  canonicalizeVideoDetailLocationSearch,
  loadDetailWithLibraryFallback,
  parseVideoDetailRouteContext,
  setVideoDetailLibraryId
} from '../listView/videoDetailContext'
import {
  readRecentMediaLibraryId,
  rememberRecentMediaLibraryId
} from '../listView/recentMediaLibrary'
import { resolveVideoDetailDefaultScraper } from './videoDetailScraperState'

interface PendingDirectorChoice {
  fields: VideoScrapeField[]
  site: string
  mode?: VideoScrapeUpdateMode
  choice: VideoDirectorChoiceRequired
}

export default function DetailPage(): JSX.Element {
  const { id, videoId: videoIdParam } = useParams()
  const videoId = Number(videoIdParam ?? id)
  const navigate = useNavigate()
  const location = useLocation()
  const libraryActressStack = useMatch(ROUTE_MATCH.libraryActressStack)
  const organizationActressStack = useMatch(ROUTE_MATCH.organizationActressStack)
  const directorActressStack = useMatch(ROUTE_MATCH.directorActressStack)
  const seriesActressStack = useMatch(ROUTE_MATCH.seriesActressStack)
  const playlistActressStack = useMatch(ROUTE_MATCH.playlistActressStack)
  const actressVideoActressStack = useMatch(ROUTE_MATCH.actressActressStack)
  const pendingActressStack = useMatch(ROUTE_MATCH.pendingActressStack)
  const homeActressStack = useMatch(ROUTE_MATCH.homeActressStack)
  const searchActressStack = useMatch(ROUTE_MATCH.searchActressStack)
  const mediaLibraryActressStack = useMatch(ROUTE_MATCH.mediaLibraryActressStack)
  const actressStackOpen = Boolean(
    libraryActressStack ??
      organizationActressStack ??
      directorActressStack ??
      seriesActressStack ??
      playlistActressStack ??
      actressVideoActressStack ??
      pendingActressStack ??
      homeActressStack ??
      searchActressStack ??
      mediaLibraryActressStack
  )
  const queryClient = useQueryClient()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const deletePreviewRequestRef = useRef(0)
  const { setBackground, clearBackground } = useAppBackground()

  const invalidateVideos = (): void => {
    invalidateVideoLibraryQueries(queryClient)
  }

  const detailRouteContext = parseVideoDetailRouteContext(
    location.pathname,
    new URLSearchParams(location.search)
  )
  const requestedLibraryId = detailRouteContext?.libraryId ?? null
  const detailRouteSource = detailRouteContext?.source ?? null
  const requestedScope = useMemo(
    () =>
      requestedLibraryId == null
        ? ALL_CATALOG_SCOPE
        : mediaLibraryCatalogScope(requestedLibraryId),
    [requestedLibraryId]
  )
  const [video, setVideo] = useState<ScopedVideoDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [scraping, setScraping] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deletePreview, setDeletePreview] = useState<VideoLifecycleImpact | null>(null)
  const [deletePreviewLoading, setDeletePreviewLoading] = useState(false)
  const [deletingVideo, setDeletingVideo] = useState(false)
  const [deleteOperationId, setDeleteOperationId] = useState<string | null>(null)
  const removePreviewRequestRef = useRef(0)
  const [confirmRemoveFromLibrary, setConfirmRemoveFromLibrary] = useState(false)
  const [removePreview, setRemovePreview] = useState<VideoLifecycleImpact | null>(null)
  const [removePreviewLoading, setRemovePreviewLoading] = useState(false)
  const [removingFromLibrary, setRemovingFromLibrary] = useState(false)
  const [removeOperationId, setRemoveOperationId] = useState<string | null>(null)
  const [showEdit, setShowEdit] = useState(false)
  const [editIdentityConflict, setEditIdentityConflict] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const { scrapers, pluginDetails, defaultScraper } = useScraperPluginCatalog('video')
  const [scraperSelection, setScraperSelection] = useState<{
    libraryId: number | null
    name: string
  }>({ libraryId: null, name: '' })
  const [videoDetailUseFirstSampleBackground, setVideoDetailUseFirstSampleBackground] =
    useState(false)
  const [showScrapeFields, setShowScrapeFields] = useState(false)
  const [pendingDirectorChoice, setPendingDirectorChoice] =
    useState<PendingDirectorChoice | null>(null)
  const [directorChoiceBusy, setDirectorChoiceBusy] = useState(false)
  const [showCorrectImport, setShowCorrectImport] = useState(false)
  const [confirmDiscardForCorrect, setConfirmDiscardForCorrect] = useState(false)
  const [showAddToPlaylist, setShowAddToPlaylist] = useState(false)
  const [showMaintenanceInfo, setShowMaintenanceInfo] = useState(false)
  const [showResourceImport, setShowResourceImport] = useState(false)
  const [editResourceTarget, setEditResourceTarget] = useState<VideoResource | null>(null)
  const [moveResourceTarget, setMoveResourceTarget] =
    useState<VideoResourceDetail | null>(null)
  const [correctCode, setCorrectCode] = useState('')
  const [correcting, setCorrecting] = useState(false)
  const [tallCover, setTallCover] = useState(false)
  const {
    isOpen: coverPreviewOpen,
    isEnabled: coverPreviewEnabled,
    open: openCoverPreview,
    close: closeCoverPreview
  } = useHistoryBackedImagePreviewState()
  const [removeResourceTarget, setRemoveResourceTarget] = useState<VideoResourceDetail | null>(null)
  const [removingResource, setRemovingResource] = useState(false)
  const [localResourceLabel, setLocalResourceLabel] = useState('')
  const [mergeCandidates, setMergeCandidates] = useState<Array<Pick<Video, 'id' | 'code' | 'title'>>>([])
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(null)
  const [mergeRetainedId, setMergeRetainedId] = useState<number | null>(null)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [splitTarget, setSplitTarget] = useState<VideoResourceDetail | null>(null)
  const [splitBusy, setSplitBusy] = useState(false)

  const dismissOverlays = useCallback(() => {
    setConfirmDelete(false)
    deletePreviewRequestRef.current += 1
    setDeletePreview(null)
    setDeletePreviewLoading(false)
    setDeletingVideo(false)
    setDeleteOperationId(null)
    setShowEdit(false)
    setEditIdentityConflict(null)
    setConfirmClear(false)
    setShowScrapeFields(false)
    setPendingDirectorChoice(null)
    setDirectorChoiceBusy(false)
    setShowCorrectImport(false)
    setShowAddToPlaylist(false)
    setShowMaintenanceInfo(false)
    setShowResourceImport(false)
    setEditResourceTarget(null)
    setMoveResourceTarget(null)
    closeCoverPreview()
    setRemoveResourceTarget(null)
  }, [closeCoverPreview])

  useDismissOverlaysOnNavigate(dismissOverlays, location.pathname)

  const activeLibraryQuery = useQuery({
    queryKey: ['media-libraries', 'detail', video?.activeLibraryId ?? null],
    queryFn: () => api.mediaLibraries.get(video!.activeLibraryId),
    enabled: video?.activeLibraryId != null
  })
  const detailDefaultScraper = resolveVideoDetailDefaultScraper(
    video?.activeLibraryId ?? null,
    activeLibraryQuery.data,
    defaultScraper
  )
  const scraperName =
    scraperSelection.libraryId === (video?.activeLibraryId ?? null) && scraperSelection.name
      ? scraperSelection.name
      : detailDefaultScraper

  useEffect(() => {
    api.settings
      .get()
      .then((settings) => {
        setVideoDetailUseFirstSampleBackground(settings.videoDetailUseFirstSampleBackground)
      })
      .catch(() => {})
  }, [])

  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false
      if (!silent) setLoading(true)
      try {
        const queryOwnedDetail =
          detailRouteSource != null && detailRouteSource !== 'media-library'
        const detail = queryOwnedDetail
          ? await loadDetailWithLibraryFallback(
              videoId,
              requestedLibraryId,
              readRecentMediaLibraryId(),
              (scope, id) => api.videos.get(scope, id)
            )
          : await api.videos.get(requestedScope, videoId)
        if (detail) rememberRecentMediaLibraryId(detail.activeLibraryId)
        setVideo(detail)
      } catch (error) {
        toastRef.current.show(String((error as Error).message ?? error), 'error')
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [detailRouteSource, requestedLibraryId, requestedScope, videoId]
  )
  const agentMetadata = useAgentMetadataCollector()

  useListSurfaceRefetch(actressStackOpen, () => {
    void load({ silent: true })
  })

  useEffect(() => {
    void load()
  }, [videoId, load])

  useEffect(() => {
    if (!detailRouteContext) return
    const currentSearch = new URLSearchParams(location.search)
    let nextSearch = canonicalizeVideoDetailLocationSearch(location.pathname, currentSearch)
    if (
      video &&
      (detailRouteContext.source === 'home' || detailRouteContext.source === 'search') &&
      detailRouteContext.libraryId !== video.activeLibraryId
    ) {
      nextSearch = setVideoDetailLibraryId(nextSearch, video.activeLibraryId)
    }
    if (nextSearch.toString() === currentSearch.toString()) return
    navigate(
      { pathname: location.pathname, search: nextSearch.toString() },
      { replace: true, state: location.state }
    )
  }, [detailRouteContext, location.pathname, location.search, location.state, navigate, video])

  useLayoutEffect(() => {
    const scope = `video:${videoId}`
    return () => clearBackground(scope)
  }, [clearBackground, videoId])

  useEffect(() => {
    const scope = `video:${videoId}`
    if (!video) return
    const path = resolveVideoDetailDisplayBackgroundPath(
      video,
      videoDetailUseFirstSampleBackground
    )
    if (path) setBackground(scope, { path, label: video.code })
    else clearBackground(scope)
  }, [video, videoId, videoDetailUseFirstSampleBackground, clearBackground, setBackground])

  const cover = assetUrl(video?.cover_path ?? null)

  useEffect(() => {
    setTallCover(false)
  }, [cover])

  const onCoverLoad = (e: React.SyntheticEvent<HTMLImageElement>): void => {
    const img = e.currentTarget
    setTallCover(img.naturalHeight > img.naturalWidth)
  }

  const onCoverKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!cover || !coverPreviewEnabled || e.defaultPrevented) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openCoverPreview()
    }
  }

  const handlePlay = async (): Promise<void> => {
    if (!video) return
    try {
      const res = await api.player.play(video.activeLibraryId, videoId)
      if (res.ok) {
        toast.show('已交给系统打开', 'success')
        void load({ silent: true })
      } else if (res.fileMissing) {
        const primary = video?.resources.find((resource) => resource.is_primary === 1)
        if (primary?.kind === 'local') setRemoveResourceTarget(primary)
        else toast.show(res.error ?? '本地主资源不存在', 'error')
      } else {
        toast.show(res.error ?? '播放失败', 'error')
      }
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const handleOpenResource = async (resourceId: number): Promise<void> => {
    if (!video) return
    try {
      const result = await api.player.openResource(video.activeLibraryId, resourceId)
      if (result.ok) {
        toast.show('已交给系统打开', 'success')
      } else if (result.fileMissing) {
        const resource = video?.resources.find((item) => item.id === resourceId)
        if (resource?.kind === 'local') setRemoveResourceTarget(resource)
        else toast.show(result.error ?? '本地资源不存在', 'error')
      } else {
        toast.show(result.error ?? '打开资源失败', 'error')
      }
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    }
  }

  const handleReveal = async (): Promise<void> => {
    if (!video) return
    try {
      const res = await api.player.reveal(video.activeLibraryId, videoId)
      if (!res.ok) toast.show(res.error ?? '打开文件夹失败', 'error')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const handleRevealResource = async (resourceId: number): Promise<void> => {
    if (!video) return
    try {
      const res = await api.player.revealResource(video.activeLibraryId, resourceId)
      if (res.fileMissing) {
        const resource = video?.resources.find((item) => item.id === resourceId)
        if (resource?.kind === 'local' || resource?.strm_source_path) {
          setRemoveResourceTarget(resource)
        }
        return
      }
      if (!res.ok) toast.show(res.error ?? '打开文件夹失败', 'error')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const handleSetPrimaryResource = async (resourceId: number): Promise<void> => {
    if (!video) return
    try {
      await api.videos.setPrimaryResource(video.activeLibraryId, videoId, resourceId)
      toast.show('已设为主资源', 'success')
      invalidateVideos()
      void load({ silent: true })
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const doRemoveResource = async (
    lastResourceMode?: LastVideoResourceRemovalMode
  ): Promise<void> => {
    if (!video || !removeResourceTarget || removingResource) return
    setRemovingResource(true)
    try {
      const result = await api.videos.removeResource(
        video.activeLibraryId,
        videoId,
        removeResourceTarget.id,
        lastResourceMode
      )
      const removedSourceFile =
        removeResourceTarget.kind === 'local' || Boolean(removeResourceTarget.strm_source_path)
      const removedStrm = Boolean(removeResourceTarget.strm_source_path)
      setRemoveResourceTarget(null)
      invalidateVideos()
      if (result.videoDeleted) {
        toast.show('影片及全部数据已删除', 'success')
        navigateBackFromVideoDetail(navigate, location)
      } else {
        toast.show(
          removedSourceFile
            ? removedStrm
              ? 'STRM 源文件已删除'
              : '本地文件已删除'
            : '链接资源已移除',
          'success'
        )
        void load({ silent: true })
      }
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setRemovingResource(false)
    }
  }

  const readFullResource = async (resourceId: number): Promise<VideoResource | null> => {
    if (!video) return null
    try {
      const resource = await api.videos.getResource(video.activeLibraryId, videoId, resourceId)
      if (!resource) toast.show('资源记录不存在', 'error')
      return resource
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
      return null
    }
  }

  const readResourceLocator = async (resourceId: number): Promise<string | null> => {
    return (await readFullResource(resourceId))?.locator ?? null
  }

  const openResourceEditor = async (resource: VideoResourceDetail): Promise<void> => {
    const fullResource = await readFullResource(resource.id)
    if (!fullResource) return
    setEditResourceTarget(fullResource)
    setLocalResourceLabel(fullResource.display_name ?? '')
  }

  const openResourceMove = (resource: VideoResourceDetail): void => {
    if (resource.kind === 'local' || resource.strm_source_path) {
      toast.show(
        '本地与 STRM 资源按来源目录管理，请到当前媒体库设置的“来源”页迁移整个根目录',
        'info'
      )
      return
    }
    setMoveResourceTarget(resource)
  }

  const saveLocalResourceLabel = async (): Promise<void> => {
    if (!video || !editResourceTarget || editResourceTarget.kind !== 'local') return
    try {
      await api.videos.updateLocalResourceLabel(
        video.activeLibraryId,
        videoId,
        editResourceTarget.id,
        localResourceLabel
      )
      setEditResourceTarget(null)
      toast.show('本地资源标签已更新', 'success')
      void load({ silent: true })
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    }
  }

  const openMergeVideos = async (): Promise<void> => {
    if (!video) return
    try {
      const normalizedCode = normalizeVideoCode(video.code)
      const result = await api.videos.list(ALL_CATALOG_SCOPE, {
        search: normalizedCode,
        limit: 100,
        offset: 0
      })
      const candidates = result.items.filter(
        (candidate) =>
          candidate.id !== video.id && normalizeVideoCode(candidate.code) === normalizedCode
      )
      if (candidates.length === 0) {
        toast.show('没有可合并的同番号影片', 'info')
        return
      }
      setMergeCandidates(candidates)
      setMergeTargetId(null)
      setMergeRetainedId(null)
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    }
  }

  const doMergeVideos = async (): Promise<void> => {
    if (!video || mergeTargetId == null || mergeRetainedId == null || mergeBusy) return
    setMergeBusy(true)
    try {
      const sourceVideoId = mergeRetainedId === video.id ? mergeTargetId : video.id
      const result = await api.videos.merge({
        retainedVideoId: mergeRetainedId,
        sourceVideoId
      })
      setMergeCandidates([])
      toast.show(`影片已合并，保留 ID ${result.retainedVideoId}`, 'success')
      invalidateVideos()
      if (result.retainedVideoId === video.id) void load({ silent: true })
      else {
        navigateToVideoDetail(navigate, location, result.retainedVideoId, {
          replace: true,
          libraryId: video.activeLibraryId
        })
      }
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    } finally {
      setMergeBusy(false)
    }
  }

  const doSplitResource = async (): Promise<void> => {
    if (!video || !splitTarget || splitBusy) return
    setSplitBusy(true)
    try {
      const result = await api.videos.splitResource(
        video.activeLibraryId,
        videoId,
        splitTarget.id
      )
      setSplitTarget(null)
      toast.show(`资源已拆分到新影片 ID ${result.videoId}`, 'success')
      invalidateVideos()
      navigateToVideoDetail(navigate, location, result.videoId, {
        libraryId: video.activeLibraryId
      })
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    } finally {
      setSplitBusy(false)
    }
  }

  const executeRescrape = async (
    fields: VideoScrapeField[],
    site: string,
    mode?: VideoScrapeUpdateMode,
    directorSelectionId?: number
  ): Promise<void> => {
    if (!video) return
    setScraperSelection({ libraryId: video.activeLibraryId, name: site })
    setScraping(true)
    if (directorSelectionId != null) setDirectorChoiceBusy(true)
    try {
      const res = await api.scrape.one(
        videoId,
        site || undefined,
        fields,
        mode,
        directorSelectionId,
        video.activeLibraryId
      )
      if (res.directorChoice) {
        setPendingDirectorChoice({ fields, site, mode, choice: res.directorChoice })
        return
      }
      if (res.pending) {
        toast.show('发现多个候选，已保存到待确认中心', 'info')
        navigate(pendingCenterPath({ type: 'scrape', videoId }))
        return
      }
      setPendingDirectorChoice(null)
      const hasWarnings = res.warnings.length > 0
      toast.show(
        res.applied
          ? hasWarnings
            ? `已更新，部分字段未应用：${res.warnings.join('；')}`
            : '匹配完成'
          : hasWarnings
            ? `所选字段未应用：${res.warnings.join('；')}`
            : '所选字段无可写入内容',
        res.applied && !hasWarnings ? 'success' : 'info'
      )
      if (res.applied) {
        invalidateVideos()
        void load({ silent: true })
      }
    } catch (e) {
      toast.show(`匹配失败：${(e as Error).message}`, 'error')
    } finally {
      setScraping(false)
      setDirectorChoiceBusy(false)
    }
  }

  const handleRescrape = (
    fields: VideoScrapeField[],
    site: string,
    mode?: VideoScrapeUpdateMode
  ): void => {
    setShowScrapeFields(false)
    void executeRescrape(fields, site, mode)
  }

  const handleRating = async (rating: number): Promise<void> => {
    try {
      await api.videos.setRating(videoId, rating)
      setVideo((v) => (v ? { ...v, rating } : v))
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const handleEditSave = async (input: VideoEditInput): Promise<void> => {
    try {
      await api.videos.edit(videoId, input)
      setShowEdit(false)
      toast.show('元数据已保存', 'success')
      invalidateVideos()
      void load({ silent: true })
    } catch (e) {
      if (isVideoBusinessIdentityConflictError(e)) {
        setEditIdentityConflict((e as Error).message)
        return
      }
      toast.show(String((e as Error).message), 'error')
    }
  }

  const doClearMeta = async (): Promise<void> => {
    try {
      await api.videos.clearMeta(videoId)
      setConfirmClear(false)
      toast.show('已清除元数据', 'success')
      invalidateVideos()
      void load({ silent: true })
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const handleMarkScrapeSuccess = async (): Promise<void> => {
    try {
      await api.videos.markScrapeSuccess(videoId)
      toast.show('已标记为刮削成功', 'success')
      invalidateVideos()
      void load({ silent: true })
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const createDeleteOperationId = (): string =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `delete-video-${videoId}-${Date.now()}`

  const closeDeletePreview = (): void => {
    deletePreviewRequestRef.current += 1
    setConfirmDelete(false)
    setDeletePreview(null)
    setDeletePreviewLoading(false)
    setDeleteOperationId(null)
  }

  const openDeletePreview = async (): Promise<void> => {
    const requestId = ++deletePreviewRequestRef.current
    setConfirmDelete(true)
    setDeletePreview(null)
    setDeletePreviewLoading(true)
    setDeleteOperationId(createDeleteOperationId())
    try {
      const impact = await api.videos.previewDeleteGlobally(videoId)
      if (requestId !== deletePreviewRequestRef.current) return
      setDeletePreview(impact)
    } catch (error) {
      if (requestId !== deletePreviewRequestRef.current) return
      closeDeletePreview()
      toast.show(String((error as Error).message ?? error), 'error')
    } finally {
      if (requestId === deletePreviewRequestRef.current) setDeletePreviewLoading(false)
    }
  }

  const doDelete = async (): Promise<void> => {
    if (!deletePreview || !deleteOperationId || deletingVideo) return
    setDeletingVideo(true)
    try {
      await api.videos.deleteGlobally({
        videoId,
        operationId: deleteOperationId,
        expectedRevision: deletePreview.revision
      })
      toast.show('已删除影片', 'success')
      invalidateVideos()
      navigateBackFromVideoDetail(navigate, location)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
      const requestId = ++deletePreviewRequestRef.current
      setDeletePreview(null)
      setDeletePreviewLoading(true)
      try {
        const refreshed = await api.videos.previewDeleteGlobally(videoId)
        if (requestId === deletePreviewRequestRef.current) {
          setDeletePreview(refreshed)
          setDeleteOperationId(createDeleteOperationId())
        }
      } catch {
        if (requestId === deletePreviewRequestRef.current) closeDeletePreview()
      } finally {
        if (requestId === deletePreviewRequestRef.current) setDeletePreviewLoading(false)
      }
    } finally {
      setDeletingVideo(false)
    }
  }

  const createRemoveOperationId = (): string =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `remove-video-${videoId}-${Date.now()}`

  const closeRemovePreview = (): void => {
    removePreviewRequestRef.current += 1
    setConfirmRemoveFromLibrary(false)
    setRemovePreview(null)
    setRemovePreviewLoading(false)
    setRemoveOperationId(null)
  }

  const openRemovePreview = async (): Promise<void> => {
    const libraryId = video?.activeLibraryId
    if (libraryId == null) return
    const requestId = ++removePreviewRequestRef.current
    setConfirmRemoveFromLibrary(true)
    setRemovePreview(null)
    setRemovePreviewLoading(true)
    setRemoveOperationId(createRemoveOperationId())
    try {
      const impact = await api.videos.previewRemoveFromLibrary(libraryId, videoId)
      if (requestId !== removePreviewRequestRef.current) return
      setRemovePreview(impact)
    } catch (error) {
      if (requestId !== removePreviewRequestRef.current) return
      closeRemovePreview()
      toast.show(String((error as Error).message ?? error), 'error')
    } finally {
      if (requestId === removePreviewRequestRef.current) setRemovePreviewLoading(false)
    }
  }

  const doRemoveFromLibrary = async (): Promise<void> => {
    const libraryId = video?.activeLibraryId
    if (!removePreview || !removeOperationId || removingFromLibrary || libraryId == null) return
    setRemovingFromLibrary(true)
    try {
      await api.videos.removeFromLibrary({
        libraryId,
        videoId,
        operationId: removeOperationId,
        expectedRevision: removePreview.revision
      })
      toast.show('已移出媒体库', 'success')
      invalidateVideos()
      navigateBackFromVideoDetail(navigate, location)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
      const requestId = ++removePreviewRequestRef.current
      setRemovePreview(null)
      setRemovePreviewLoading(true)
      try {
        const refreshed = await api.videos.previewRemoveFromLibrary(libraryId, videoId)
        if (requestId === removePreviewRequestRef.current) {
          setRemovePreview(refreshed)
          setRemoveOperationId(createRemoveOperationId())
        }
      } catch {
        if (requestId === removePreviewRequestRef.current) closeRemovePreview()
      } finally {
        if (requestId === removePreviewRequestRef.current) setRemovePreviewLoading(false)
      }
    } finally {
      setRemovingFromLibrary(false)
    }
  }

  const openCorrectImport = (): void => {
    setCorrectCode(video?.code ?? '')
    setShowCorrectImport(true)
  }

  const doCorrectImport = async (discardPendingScrape = false): Promise<void> => {
    const trimmed = correctCode.trim()
    if (!trimmed) {
      toast.show('番号不能为空', 'error')
      return
    }
    setCorrecting(true)
    try {
      const res = await api.videos.correctImport(videoId, trimmed, discardPendingScrape)
      if (res.pendingDiscardRequired) {
        setConfirmDiscardForCorrect(true)
        return
      }
      setShowCorrectImport(false)
      setConfirmDiscardForCorrect(false)
      if (res.mergedIntoId) {
        toast.show(`番号已修正为 ${res.code}（已合并到已有记录）`, 'success')
        navigateToVideoDetail(navigate, location, res.mergedIntoId, {
          replace: true,
          libraryId: video?.activeLibraryId
        })
        return
      }
      if (res.code === res.previousCode) {
        toast.show('番号未变更', 'info')
        return
      }
      toast.show(`番号已修正：${res.previousCode} → ${res.code}`, 'success')
      invalidateVideos()
      void load({ silent: true })
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setCorrecting(false)
    }
  }

  if (loading) {
    return (
      <div className={`detail-pane${actressStackOpen ? ' detail-pane--stacked' : ''}`}>
        <DetailScrollBody onBack={() => navigateBackFromVideoDetail(navigate, location)}>
          <EmptyState loading />
        </DetailScrollBody>
      </div>
    )
  }
  if (!video) {
    return (
      <div className={`detail-pane${actressStackOpen ? ' detail-pane--stacked' : ''}`}>
        <DetailScrollBody onBack={() => navigateBackFromVideoDetail(navigate, location)}>
          <EmptyState
            icon={<SearchX {...UI_ICON} aria-hidden />}
            title="未找到该影片"
            description="该影片可能已被删除或移动。"
          />
        </DetailScrollBody>
      </div>
    )
  }

  const codeParts = splitVideoCode(video.code)
  const hasPrimaryResource = video.resources.some((resource) => Boolean(resource.is_primary))
  const removeResourceIsStrm = Boolean(removeResourceTarget?.strm_source_path)
  const removeResourceDeletesSource =
    removeResourceTarget?.kind === 'local' || removeResourceIsStrm
  return (
    <div className={`detail-pane${actressStackOpen ? ' detail-pane--stacked' : ''}`}>
      <DetailScrollBody
        onBack={() => navigateBackFromVideoDetail(navigate, location)}
        headerContext={
          <VideoLibraryMembershipBadges
            activeLibraryId={video.activeLibraryId}
            libraries={video.libraries}
          />
        }
      >
        <article className="detail-hero">
          <div className="detail-title-block">
            <h1 className="detail-title">
              {codeParts ? (
                <>
                  <MetaLink
                    className="detail-code"
                    onClick={() =>
                      navigateToVideoListSurface(
                        navigate,
                        location,
                        { [LIST_PARAM.prefix]: codeParts.prefix },
                        { libraryId: video.activeLibraryId }
                      )
                    }
                    title={`筛选 ${codeParts.prefix} 系列`}
                  >
                    {codeParts.prefix}
                  </MetaLink>
                  <span className="detail-code">{codeParts.suffix}</span>
                </>
              ) : (
                <span className="detail-code">{video.code}</span>
              )}
              {video.title ? `  ${video.title}` : ''}
            </h1>
            {video.scraped_status !== 1 || video.has_pending_scrape ? (
              <div className="detail-title-badges">
                {video.scraped_status !== 1 ? (
                  <span
                    className={`detail-meta-status detail-meta-status--${video.scraped_status === 2 ? 'failed' : 'unscraped'}`}
                  >
                    {getVideoScrapeStatusLabel(video.scraped_status)}
                  </span>
                ) : null}
                {video.has_pending_scrape ? (
                  <button
                    type="button"
                    className="detail-meta-status"
                    data-pending="true"
                    onClick={() => navigate(pendingCenterPath({ type: 'scrape', videoId: video.id }))}
                  >
                    查看待确认候选
                  </button>
                ) : null}
                {video.scraped_status === 0 ? (
                  <span className="detail-scrape-hint">
                    可在
                    <button
                      type="button"
                      className="meta-link detail-scrape-hint-link"
                      onClick={() => navigate(settingsPath('overview', 'status'))}
                    >
                      设置 · 概览
                    </button>
                    一键刮削全局目录中的未刮削影片。
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="detail-hero-body">
            <div
              className={`detail-cover landscape${
                cover && coverPreviewEnabled ? ' detail-cover--preview' : ''
              }`}
              role={cover && coverPreviewEnabled ? 'button' : undefined}
              aria-label={
                cover && coverPreviewEnabled ? `查看封面：${video.code}` : undefined
              }
              tabIndex={cover && coverPreviewEnabled ? 0 : undefined}
              title={cover && coverPreviewEnabled ? '查看封面' : undefined}
              onClick={() => {
                if (cover && coverPreviewEnabled) openCoverPreview()
              }}
              onKeyDown={onCoverKeyDown}
            >
              {cover ? (
                <img
                  src={cover}
                  alt={video.code}
                  className={tallCover ? 'cover-tall' : undefined}
                  onLoad={onCoverLoad}
                />
              ) : (
                <div className="poster-placeholder">{video.code}</div>
              )}
            </div>

            <div className="detail-info">
              <VideoDetailRatings video={video} onRatingChange={handleRating} />

              <VideoDetailPrimaryMeta video={video} />

              <DetailActionBar
                ariaLabel="影片操作"
                primary={{
                  label: hasPrimaryResource ? '播放' : '无可用资源',
                  icon: <Play {...UI_ICON} aria-hidden />,
                  disabled: !hasPrimaryResource,
                  onClick: () => {
                    void handlePlay()
                  }
                }}
                actions={[
                  {
                    key: 'playlist',
                    icon: <ListPlus {...UI_ICON} />,
                    label: '加入清单',
                    onClick: () => setShowAddToPlaylist(true)
                  },
                  {
                    key: 'edit',
                    icon: <Pencil {...UI_ICON} />,
                    label: '编辑',
                    onClick: () => setShowEdit(true)
                  },
                  {
                    key: 'agent-scrape',
                    icon: <Bot {...UI_ICON} />,
                    label: 'Agent 刮削',
                    onClick: () => agentMetadata.open(
                      { kind: 'video', id: videoId, label: video.code },
                      () => { void load({ silent: true }) }
                    )
                  },
                  {
                    key: 'scrape',
                    icon: <SearchCheck {...UI_ICON} />,
                    label: '修正匹配',
                    title: scraping ? '匹配中…' : '修正匹配',
                    busy: scraping,
                    disabled: scraping,
                    onClick: () => setShowScrapeFields(true)
                  }
                ]}
                menuItems={[
                  {
                    key: 'correct-code',
                    label: '修正番号',
                    onClick: openCorrectImport
                  },
                  {
                    key: 'reveal',
                    label: '打开所在文件夹',
                    hidden: video.primary_resource_kind !== 'local',
                    onClick: () => {
                      void handleReveal()
                    }
                  },
                  {
                    key: 'maintenance',
                    label: '维护信息',
                    onClick: () => setShowMaintenanceInfo(true)
                  },
                  {
                    key: 'merge-video',
                    label: '合并同番号影片',
                    onClick: () => {
                      void openMergeVideos()
                    }
                  },
                  {
                    key: 'mark-success',
                    label: '标记为刮削成功',
                    hidden: video.scraped_status === 1,
                    onClick: () => {
                      void handleMarkScrapeSuccess()
                    }
                  },
                  { key: 'danger-separator', type: 'separator' },
                  {
                    key: 'clear-meta',
                    label: '清除元数据',
                    danger: true,
                    onClick: () => setConfirmClear(true)
                  },
                  {
                    key: 'remove-from-library',
                    label: '移出媒体库',
                    hidden: video.activeLibraryId == null,
                    onClick: () => {
                      void openRemovePreview()
                    }
                  },
                  {
                    key: 'delete-video',
                    label: '删除影片',
                    danger: true,
                    onClick: () => {
                      void openDeletePreview()
                    }
                  }
                ]}
              />
          </div>
        </div>
        </article>

      {video.actresses.length > 0 && (
        <section className="detail-section detail-section--actresses">
          <div className="detail-section-head">
            <h2 className="section-title">演员</h2>
            <span className="detail-section-count">{video.actresses.length} 位</span>
          </div>
          <div className="actress-row-avatars">
            {video.actresses.map((a) => {
              const avatar = assetUrl(a.avatar_path)
              return (
                <button
                  key={a.id}
                  type="button"
                  className="actress-mini"
                  onClick={() =>
                    navigateToActressFromVideoDetail(navigate, location, videoId, a.id)
                  }
                >
                  <ActressAvatar src={avatar} name={a.main_name} gender={a.gender} />
                  <ActressName name={a.main_name} gender={a.gender} className="actress-name" />
                </button>
              )
            })}
          </div>
        </section>
      )}

      {video.summary && (
        <section className="detail-section detail-section--summary">
          <div className="detail-section-head">
            <h2 className="section-title">剧情简介</h2>
          </div>
          <div className="summary-text">{video.summary}</div>
        </section>
      )}

      <VideoTagPanel
        videoId={video.id}
        tags={video.tags}
        onFilterTag={(tag) =>
          navigateToVideoListSurface(
            navigate,
            location,
            { [LIST_PARAM.tags]: String(tag.id) },
            {
              libraryId: video.activeLibraryId,
              tagLabel: { id: tag.id, name: tag.name }
            }
          )
        }
        onChanged={() => {
          void load({ silent: true })
          invalidateVideos()
        }}
      />

      <VideoDetailSecondaryMeta
        video={video}
        onOpenResource={(resourceId) => {
          void handleOpenResource(resourceId)
        }}
        onRevealResource={(resourceId) => {
          void handleRevealResource(resourceId)
        }}
        onReadResourceLocator={readResourceLocator}
        onEditResource={(resource) => {
          void openResourceEditor(resource)
        }}
        onSetPrimaryResource={(resourceId) => {
          void handleSetPrimaryResource(resourceId)
        }}
        onSplitResource={setSplitTarget}
        onMoveResource={openResourceMove}
        onRemoveResource={setRemoveResourceTarget}
        onAddResource={() => setShowResourceImport(true)}
      />

      {(video.links?.length ?? 0) > 0 && (
        <section className="detail-section detail-section--links">
          <div className="detail-section-head">
            <h2 className="section-title">相关链接</h2>
          </div>
          <RelatedLinksList links={video.links ?? []} />
        </section>
      )}

      <VideoSampleGallery
        videoId={video.id}
        assets={video.assets}
        posterPath={video.poster_path}
        onChanged={() => {
          void load({ silent: true })
          invalidateVideos()
        }}
      />
      </DetailScrollBody>

      {coverPreviewOpen && cover && (
        <ImagePreviewLightbox
          items={[{ id: video.id, src: cover }]}
          index={0}
          onClose={closeCoverPreview}
          onIndexChange={() => {}}
          labels={{
            dialog: '查看影片封面',
            filmstrip: '影片封面',
            thumb: () => `封面：${video.code}`
          }}
        />
      )}

      {showCorrectImport && (
        <Modal
          title="修正导入"
          confirmText={correcting ? '处理中…' : '保存'}
          onConfirm={() => {
            if (!correcting) void doCorrectImport()
          }}
          onCancel={() => {
            if (!correcting) setShowCorrectImport(false)
          }}
        >
          <p className="modal-field-hint">
            修改该影片的番号（不修改磁盘文件名）。番号格式不限。
          </p>
          <input
            className="text-input form-control-full"
            value={correctCode}
            onChange={(e) => setCorrectCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !correcting) void doCorrectImport()
            }}
            placeholder="输入番号"
            aria-label="番号"
            autoFocus
            disabled={correcting}
          />
        </Modal>
      )}

      {confirmDiscardForCorrect && (
        <Modal
          title="丢弃待确认结果并修改番号"
          danger
          confirmText={correcting ? '处理中…' : '丢弃并修改'}
          onConfirm={() => {
            if (!correcting) void doCorrectImport(true)
          }}
          onCancel={() => {
            if (!correcting) setConfirmDiscardForCorrect(false)
          }}
        >
          这部影片有尚未确认的刮削候选。修改番号会原子地丢弃这些候选和暂存图片；关闭此窗口不会产生任何修改。
        </Modal>
      )}

      {showScrapeFields && (
        <ScrapeFieldsModal
          title="修正匹配"
          hint="先确定站点与更新方式，再勾选要写入的字段。"
          options={VIDEO_SCRAPE_FIELD_OPTIONS}
          scrapers={scrapers}
          pluginDetails={pluginDetails}
          initialScraperName={scraperName}
          scraperTitle="刮削站点"
          initialSelected={ALL_VIDEO_SCRAPE_FIELDS}
          updateModeOptions={VIDEO_SCRAPE_UPDATE_MODE_OPTIONS}
          initialUpdateMode="fillEmpty"
          onCancel={() => setShowScrapeFields(false)}
          onConfirm={(fields, site, _scope, mode) => {
            handleRescrape(fields, site, mode as VideoScrapeUpdateMode | undefined)
          }}
        />
      )}

      {pendingDirectorChoice && (
        <DirectorScrapeChoiceModal
          choice={pendingDirectorChoice.choice}
          busy={directorChoiceBusy}
          onCancel={() => setPendingDirectorChoice(null)}
          onChoose={(directorId) => {
            void executeRescrape(
              pendingDirectorChoice.fields,
              pendingDirectorChoice.site,
              pendingDirectorChoice.mode,
              directorId
            )
          }}
        />
      )}

      {showEdit && (
        <EditMetadataModal
          video={video}
          onCancel={() => {
            setEditIdentityConflict(null)
            setShowEdit(false)
          }}
          onSave={handleEditSave}
        />
      )}

      {editIdentityConflict && (
        <Modal
          title="影片业务身份冲突"
          hint="发行商、番号和发行日期与另一部影片完全相同，当前编辑尚未保存。"
          confirmText="丢弃编辑并进入合并"
          onCancel={() => setEditIdentityConflict(null)}
          onConfirm={() => {
            setEditIdentityConflict(null)
            setShowEdit(false)
            void openMergeVideos()
          }}
        >
          <p className="copyable-text">{editIdentityConflict}</p>
          <p>进入合并后，请选择另一部同番号影片，并明确选择要保留的内部 ID。</p>
        </Modal>
      )}

      {showResourceImport && (
        <VideoResourceImportModal
          libraryId={video.activeLibraryId}
          fixedCode={video.code}
          fixedVideoId={video.id}
          onCancel={() => setShowResourceImport(false)}
          onImported={() => {
            setShowResourceImport(false)
            toast.show('资源已添加', 'success')
            invalidateVideos()
            void load({ silent: true })
          }}
        />
      )}

      {moveResourceTarget ? (
        <VideoResourceMoveModal
          sourceLibraryId={moveResourceTarget.library_id}
          resource={moveResourceTarget}
          onCancel={() => setMoveResourceTarget(null)}
          onMoved={() => {
            setMoveResourceTarget(null)
            toast.show('资源已移动到目标媒体库', 'success')
            invalidateVideos()
            void load({ silent: true })
          }}
        />
      ) : null}

      {mergeCandidates.length > 0 && (
        <Modal
          title="合并同番号影片"
          danger
          subtitle="先选择另一部影片，再明确选择要保留的内部 ID。"
          confirmText={mergeBusy ? '合并中…' : '合并'}
          confirmDisabled={mergeTargetId == null || mergeRetainedId == null || mergeBusy}
          busy={mergeBusy}
          onConfirm={() => void doMergeVideos()}
          onCancel={() => {
            if (!mergeBusy) setMergeCandidates([])
          }}
        >
          <div className="entity-edit-fields">
            <label className="form-field">
              <span className="form-field-label">合并对象</span>
              <SelectControl
                className="form-control-full"
                value={mergeTargetId ?? ''}
                disabled={mergeBusy}
                onChange={(event) => {
                  setMergeTargetId(event.target.value ? Number(event.target.value) : null)
                  setMergeRetainedId(null)
                }}
              >
                <option value="">请选择同番号影片</option>
                {mergeCandidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    ID {candidate.id} · {candidate.code}{candidate.title ? ` · ${candidate.title}` : ''}
                  </option>
                ))}
              </SelectControl>
            </label>
            {mergeTargetId != null ? (
              <fieldset className="form-field">
                <legend className="form-field-label">保留影片</legend>
                <label className="choice-row">
                  <input
                    type="radio"
                    name="merge-retained-video"
                    checked={mergeRetainedId === video.id}
                    onChange={() => setMergeRetainedId(video.id)}
                  />
                  保留当前影片 ID {video.id}
                </label>
                <label className="choice-row">
                  <input
                    type="radio"
                    name="merge-retained-video"
                    checked={mergeRetainedId === mergeTargetId}
                    onChange={() => setMergeRetainedId(mergeTargetId)}
                  />
                  保留另一部影片 ID {mergeTargetId}
                </label>
              </fieldset>
            ) : null}
          </div>
          <p className="modal-field-hint">保留影片的单值资料和主资源优先；来源影片会在合并成功后删除。</p>
        </Modal>
      )}

      {splitTarget && (
        <Modal
          title="拆分影片资源"
          confirmText={splitBusy ? '拆分中…' : '拆分'}
          busy={splitBusy}
          onConfirm={() => void doSplitResource()}
          onCancel={() => {
            if (!splitBusy) setSplitTarget(null)
          }}
        >
          这条非主资源将移动到一部新的身份待定影片，并成为新影片的主资源。不会复制元数据，也不会移动或重命名本地文件。
          <div className="modal-path-text">{splitTarget.display_name || splitTarget.display_locator}</div>
        </Modal>
      )}

      {editResourceTarget && editResourceTarget.kind !== 'local' && (
        <VideoResourceImportModal
          libraryId={video.activeLibraryId}
          fixedCode={video.code}
          resource={editResourceTarget}
          onCancel={() => setEditResourceTarget(null)}
          onUpdated={() => {
            setEditResourceTarget(null)
            toast.show('资源已更新', 'success')
            invalidateVideos()
            void load({ silent: true })
          }}
        />
      )}

      {editResourceTarget?.kind === 'local' && (
        <Modal
          title="编辑本地资源"
          subtitle="本地路径与文件大小由扫描器维护"
          confirmText="保存"
          onConfirm={() => void saveLocalResourceLabel()}
          onCancel={() => setEditResourceTarget(null)}
        >
          <AppFormField label="资源标签" hint="留空时显示文件名。">
            <input
              className="text-input form-control-full"
              value={localResourceLabel}
              onChange={(event) => setLocalResourceLabel(event.target.value)}
              placeholder="可选"
              autoFocus
            />
          </AppFormField>
          <div className="modal-path-text">{editResourceTarget.locator}</div>
        </Modal>
      )}

      {showAddToPlaylist && (
        <AddToPlaylistModal
          videoId={videoId}
          videoCode={video.code}
          onCancel={() => setShowAddToPlaylist(false)}
        />
      )}

      {showMaintenanceInfo && (
        <Modal
          title="维护信息"

          size="sm"
          confirmText="关闭"
          hideCancel
          onConfirm={() => setShowMaintenanceInfo(false)}
          onCancel={() => setShowMaintenanceInfo(false)}
        >
          <VideoMaintenanceInfo video={video} />
        </Modal>
      )}

      {confirmClear && (
        <Modal
          title="清除元数据"
          danger
          confirmText="清除"
          onConfirm={() => {
            void doClearMeta()
          }}
          onCancel={() => setConfirmClear(false)}
        >
          确定要清除「{video.code}」的所有刮削元数据吗？将清空标题、简介、封面、演员、标签、外部评分等并恢复为「未刮削」状态（不影响影片资源、自定义评分与相关链接）。
        </Modal>
      )}

      {confirmRemoveFromLibrary && (
        <Modal
          title="移出媒体库"
          size="lg"
          busy={removingFromLibrary}
          confirmText={
            removingFromLibrary ? '移出中…' : removePreviewLoading ? '读取影响…' : '移出媒体库'
          }
          confirmDisabled={removePreviewLoading || !removePreview}
          onConfirm={() => {
            void doRemoveFromLibrary()
          }}
          onCancel={() => {
            if (!removingFromLibrary) closeRemovePreview()
          }}
        >
          {removePreviewLoading && !removePreview ? <p>正在读取完整影响范围…</p> : null}
          {removePreview ? <VideoDeleteImpact impact={removePreview} /> : null}
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          title="删除影片"
          size="lg"
          danger
          busy={deletingVideo}
          confirmText={
            deletingVideo ? '删除中…' : deletePreviewLoading ? '读取影响…' : '永久删除'
          }
          confirmDisabled={deletePreviewLoading || !deletePreview}
          onConfirm={() => {
            void doDelete()
          }}
          onCancel={() => {
            if (!deletingVideo) closeDeletePreview()
          }}
        >
          {deletePreviewLoading && !deletePreview ? <p>正在读取完整影响范围…</p> : null}
          {deletePreview ? <VideoDeleteImpact impact={deletePreview} /> : null}
        </Modal>
      )}

      {removeResourceTarget && (
        <Modal
          title={
            removeResourceIsStrm
              ? '删除 STRM 源文件'
              : removeResourceTarget.kind === 'local'
                ? '删除本地文件'
                : '移除链接资源'
          }
          danger
          confirmText={
            removingResource
              ? '处理中…'
              : removeResourceIsStrm
                ? '删除源文件'
                : removeResourceTarget.kind === 'local'
                  ? '删除文件'
                  : '移除资源'
          }
          onConfirm={() => void doRemoveResource()}
          onCancel={() => {
            if (!removingResource) setRemoveResourceTarget(null)
          }}
          actions={
            video.resources.length === 1 ? (
              <>
                <Button
                  type="button"

                  disabled={removingResource}
                  onClick={() => setRemoveResourceTarget(null)}
                >
                  取消
                </Button>
                <Button
                  type="button"

                  disabled={removingResource}
                  onClick={() => void doRemoveResource('retain-video')}
                >
                  保留影片元数据
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  disabled={removingResource}
                  onClick={() => {
                    setRemoveResourceTarget(null)
                    void openDeletePreview()
                  }}
                >
                  永久删除影片
                </Button>
              </>
            ) : undefined
          }
        >
          {video.resources.length === 1
            ? '这是当前媒体库中的最后一个资源。可仅移除该资源并保留影片元数据，或先查看完整影响再永久删除全局影片资料。'
            : removeResourceDeletesSource
              ? removeResourceIsStrm
                ? '将删除磁盘上的 STRM 源文件及资源记录；不会访问或删除远程内容，影片与其它资源会保留。'
                : '将删除磁盘上的本地文件及资源记录；影片与其它资源会保留。'
              : '将只移除这条链接资源记录，不会访问或删除远程内容。'}
          {video.resources.length === 1 && removeResourceDeletesSource ? (
            <div className="modal-path-hint">
              {removeResourceIsStrm
                ? '选择“保留影片元数据”会删除 STRM 源文件并保留影片资料；选择“永久删除影片”会删除影片资料和该源文件。'
                : '选择“保留影片元数据”会删除本地视频文件并保留影片资料；选择“永久删除影片”会删除影片资料和该文件。'}
            </div>
          ) : null}
          {video.resources.length === 1 && video.has_pending_scrape ? (
            <div className="modal-path-hint">
              选择“永久删除影片”还会在确认后删除待确认刮削候选与暂存图片。
            </div>
          ) : null}
          <div className="modal-path-text">
            {removeResourceDeletesSource
              ? removeResourceTarget.strm_source_path ?? removeResourceTarget.display_locator
              : removeResourceTarget.display_name || '链接资源'}
          </div>
        </Modal>
      )}

      {actressStackOpen && (
        <div className="detail-pane-overlay">
          <Outlet />
        </div>
      )}
    </div>
  )
}
