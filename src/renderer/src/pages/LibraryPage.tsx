import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMatch, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ChevronDown,
  Archive,
  Film,
  FolderMinus,
  Link2,
  ListPlus,
  SearchCheck,
  SearchX,
  Settings,
  Trash2
} from 'lucide-react'
import type {
  Video,
  VideoDetail,
  VideoEditInput,
  VideoQuery
} from '@shared/videoTypes'
import type { VideoLifecycleImpact } from '@shared/videoLifecycleTypes'
import type { LibraryListDefaults } from '../listView/listQueryParams'
import type {
  VideoDirectorChoiceRequired,
  VideoScrapeField,
  VideoScrapeUpdateMode
} from '@shared/videoScrapeTypes'
import { ALL_VIDEO_SCRAPE_FIELDS, VIDEO_SCRAPE_FIELD_OPTIONS, VIDEO_SCRAPE_UPDATE_MODE_OPTIONS } from '@shared/videoScrapeTypes'
import { api } from '../api'
import { useDebounce } from '../hooks/useDebounce'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import { useRangeSelection } from '../hooks/useRangeSelection'
import { useToast } from '../components/Toast'
import VirtualPosterGrid from '../components/VirtualPosterGrid'
import AppliedFilterBar, { type AppliedFilterItem } from '../components/AppliedFilterBar'
import LibraryFilterPopover, { type LibraryFilterState } from '../components/LibraryFilterPopover'
import ListToolbar from '../components/ListToolbar'
import AddToPlaylistModal from '../components/AddToPlaylistModal'
import AddVideosToPlaylistModal from '../components/AddVideosToPlaylistModal'
import EditMetadataModal from '../components/EditMetadataModal'
import Modal from '../components/Modal'
import VideoDeleteImpact from '../components/VideoDeleteImpact'
import ScrapeFieldsModal from '../components/ScrapeFieldsModal'
import SortSwitch, { type SortSwitchOption } from '../components/SortSwitch'
import {
  LIBRARY_DEFAULTS,
  LIST_PARAM,
  canonicalizeLibrarySearchParams,
  libraryQueryHash,
  libraryVideoQueryFromSearchParams,
  parseScrapedStatus,
  parseSort,
  parseTagIds,
  parseVideoPendingScrape,
  parseVideoResourceFilters,
  parseYear,
  patchSearchParams,
  videoResourceFiltersParam
} from '../listView/listQueryParams'
import { ROUTE_MATCH } from '../listView/routePaths'
import { mediaLibraryPath, mediaLibrarySettingsPath } from '../listView/mediaLibraryRoutes'
import { pendingCenterPath } from '../listView/pendingRoutes'
import { forgetPrimaryListLocation } from '../listView/primaryNavigationMemory'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { useScraperPluginCatalog } from '../hooks/useScraperPluginCatalog'
import { useInfiniteVideoList } from '../query/useInfiniteVideoList'
import { mediaLibraryCatalogScope } from '../query/catalogScopes'
import { mediaLibraryKeys, videoKeys } from '../query/queryKeys'
import { invalidateVideoLibraryQueries } from '../query/invalidateLibraryQueries'
import { useBatchScrapeActivity } from '../hooks/useBatchScrapeActivity'
import ListMaintenanceBanner from '../components/ListMaintenanceBanner'
import { mediaLibraryIdentityStyle } from '../components/mediaLibraryIdentity'
import EmptyState from '../components/EmptyState'
import ListSurface from '../components/ListSurface'
import SelectionToolbar from '../components/SelectionToolbar'
import { VIDEO_RESOURCE_FILTER_LABELS } from '../components/videoResourcePresentation'
import { UI_ICON_SM } from '../components/iconDefaults'
import { startDefaultUnscrapedVideoBatch } from '../utils/defaultBatchScrape'
import { withVideoBatchRequestScope } from '../utils/videoBatchScope'
import VideoResourceImportModal from '../components/VideoResourceImportModal'
import DirectorScrapeChoiceModal from '../components/DirectorScrapeChoiceModal'
import {
  dismissMaintenanceHint,
  isMaintenanceHintDismissed,
  MAINTENANCE_HINT_KEYS
} from '../utils/maintenanceHints'
import Button from '../components/Button'
import { NavIcon } from '../components/NavIcons'
import styles from './LibraryPage.module.css'
import { mediaLibrarySurfaceMode } from './mediaLibrarySurfaceState'
import { rememberRecentMediaLibraryId } from '../listView/recentMediaLibrary'

const STATUS_LABELS: Record<string, string> = {
  all: '全部',
  '0': '未刮削',
  '1': '已刮削',
  '2': '刮削失败'
}

const SORT_LABELS: Record<NonNullable<VideoQuery['sortBy']>, string> = {
  add_time: '添加时间',
  release_date: '发行日期',
  rating: '评分',
  code: '番号'
}

const SORT_SWITCH_OPTIONS: SortSwitchOption<NonNullable<VideoQuery['sortBy']>>[] = [
  { value: 'release_date', label: '发行', title: '发行日期' },
  { value: 'add_time', label: '添加', title: '添加时间' },
  { value: 'rating', label: '评分' },
  { value: 'code', label: '番号' }
]

interface SingleScrapeRequest {
  target: Pick<Video, 'id' | 'code'>
  fields: VideoScrapeField[]
  site: string
  mode?: VideoScrapeUpdateMode
}

interface PendingDirectorChoice extends SingleScrapeRequest {
  choice: VideoDirectorChoiceRequired
}

export default function LibraryPage({ libraryId }: { libraryId: number }): JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const filterBtnRef = useRef<HTMLButtonElement>(null)
  const removalPreviewRequestRef = useRef(0)
  const [filterOpen, setFilterOpen] = useState(false)
  const detailOpen = Boolean(useMatch({ path: ROUTE_MATCH.mediaLibraryVideoOpen, end: false }))
  const [playlistTarget, setPlaylistTarget] = useState<Video | null>(null)
  const [showBulkPlaylist, setShowBulkPlaylist] = useState(false)
  const [editingVideo, setEditingVideo] = useState<VideoDetail | null>(null)
  const [editLoadingId, setEditLoadingId] = useState<number | null>(null)
  const [scrapeTarget, setScrapeTarget] = useState<Video | null>(null)
  const [pendingDirectorChoice, setPendingDirectorChoice] =
    useState<PendingDirectorChoice | null>(null)
  const [directorChoiceBusy, setDirectorChoiceBusy] = useState(false)
  const [showBulkScrape, setShowBulkScrape] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Video | null>(null)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [removalPreviewLoading, setRemovalPreviewLoading] = useState(false)
  const [removalImpacts, setRemovalImpacts] = useState<Map<number, VideoLifecycleImpact>>(
    new Map()
  )
  const membershipPreviewRequestRef = useRef(0)
  const [membershipTarget, setMembershipTarget] = useState<Video | null>(null)
  const [confirmBulkRemove, setConfirmBulkRemove] = useState(false)
  const [removingMembership, setRemovingMembership] = useState(false)
  const [membershipPreviewLoading, setMembershipPreviewLoading] = useState(false)
  const [membershipImpacts, setMembershipImpacts] = useState<Map<number, VideoLifecycleImpact>>(
    new Map()
  )
  const [showResourceImport, setShowResourceImport] = useState(false)
  const { scrapers, pluginDetails, defaultScraper } = useScraperPluginCatalog('video')
  const [scraperName, setScraperName] = useState('')
  const scope = useMemo(() => mediaLibraryCatalogScope(libraryId), [libraryId])
  const libraryQuery = useQuery({
    queryKey: mediaLibraryKeys.detail(libraryId),
    queryFn: () => api.mediaLibraries.get(libraryId)
  })
  const library = libraryQuery.data ?? null
  const surfaceMode = mediaLibrarySurfaceMode(library)
  useEffect(() => {
    if (library?.status === 'active') rememberRecentMediaLibraryId(library.id)
  }, [library?.id, library?.status])
  const libraryDefaults = useMemo<LibraryListDefaults>(
    () => ({
      status: 'all',
      year: 'all',
      sortBy: library?.config.defaultSortBy ?? LIBRARY_DEFAULTS.sortBy,
      sortDir: library?.config.defaultSortDir ?? LIBRARY_DEFAULTS.sortDir
    }),
    [library?.config.defaultSortBy, library?.config.defaultSortDir]
  )
  const effectiveDefaultScraper = library?.config.defaultVideoScraper || defaultScraper

  const dismissOverlays = useCallback(() => {
    setFilterOpen(false)
    setPlaylistTarget(null)
    setShowBulkPlaylist(false)
    setEditingVideo(null)
    setEditLoadingId(null)
    setScrapeTarget(null)
    setPendingDirectorChoice(null)
    setDirectorChoiceBusy(false)
    setShowBulkScrape(false)
    setDeleteTarget(null)
    setConfirmBulkDelete(false)
    removalPreviewRequestRef.current += 1
    setRemovalPreviewLoading(false)
    setRemovalImpacts(new Map())
    setMembershipTarget(null)
    setConfirmBulkRemove(false)
    membershipPreviewRequestRef.current += 1
    setMembershipPreviewLoading(false)
    setMembershipImpacts(new Map())
    setShowResourceImport(false)
  }, [])

  useDismissOverlaysOnNavigate(dismissOverlays, location.pathname)

  useEffect(() => {
    const canonical = canonicalizeLibrarySearchParams(searchParams)
    if (canonical.toString() !== searchParams.toString()) {
      setSearchParams(canonical, { replace: true })
    }
  }, [searchParams, setSearchParams])

  const urlQ = searchParams.get(LIST_PARAM.q) ?? ''
  const [searchInput, setSearchInput] = useState(urlQ)
  useEffect(() => {
    setSearchInput(urlQ)
  }, [urlQ])

  const debouncedQ = useDebounce(searchInput, 300)
  useEffect(() => {
    const trimmed = debouncedQ.trim()
    if (trimmed === urlQ.trim()) return
    setSearchParams(
      (prev) => patchSearchParams(prev, { [LIST_PARAM.q]: trimmed || null }),
      { replace: true }
    )
  }, [debouncedQ, urlQ, setSearchParams])

  const queryHash = useMemo(
    () => libraryQueryHash(searchParams, libraryDefaults),
    [searchParams, libraryDefaults]
  )
  const scopedQueryHash = `${libraryId}:${queryHash}`
  const scrollMemoryKey = `library:${libraryId}:${queryHash}`

  const query = useMemo<VideoQuery>(
    () => libraryVideoQueryFromSearchParams(searchParams, libraryDefaults),
    [searchParams, libraryDefaults]
  )

  const { sortBy, sortDir } = parseSort(
    searchParams.get(LIST_PARAM.sort),
    searchParams.get(LIST_PARAM.dir),
    libraryDefaults
  )
  const status = parseScrapedStatus(searchParams.get(LIST_PARAM.status))
  const pendingScrape = parseVideoPendingScrape(searchParams.get(LIST_PARAM.pending))
  const year = parseYear(searchParams.get(LIST_PARAM.year))
  const tagIds = useMemo(
    () => parseTagIds(searchParams.get(LIST_PARAM.tags)),
    [searchParams]
  )
  const codePrefix = (searchParams.get(LIST_PARAM.prefix) ?? '').trim().toUpperCase()
  const resourceKinds = useMemo(
    () => parseVideoResourceFilters(searchParams.get(LIST_PARAM.resources)),
    [searchParams]
  )

  const patchParams = useCallback(
    (patch: Record<string, string | null | undefined>): void => {
      setSearchParams((prev) => patchSearchParams(prev, patch), { replace: true })
    },
    [setSearchParams]
  )

  const [tagNames, setTagNames] = useState<Map<number, string>>(new Map())
  const [years, setYears] = useState<number[]>([])

  const refreshTagNames = useCallback(() => {
    api.tags
      .list()
      .then((tags) => setTagNames(new Map(tags.map((t) => [t.id, t.name]))))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (surfaceMode !== 'active') return
    api.videos.years(scope).then(setYears).catch(() => {})
    refreshTagNames()
  }, [refreshTagNames, scope, surfaceMode])

  useEffect(() => {
    const tagLabels = (location.state as { tagLabels?: Record<number, string> } | null)?.tagLabels
    if (!tagLabels) return
    setTagNames((prev) => {
      const next = new Map(prev)
      for (const [id, name] of Object.entries(tagLabels)) {
        next.set(Number(id), name)
      }
      return next
    })
  }, [location.state])

  useEffect(() => {
    if (tagIds.some((id) => !tagNames.has(id))) {
      refreshTagNames()
    }
  }, [tagIds, tagNames, refreshTagNames])

  useEffect(() => {
    if (!detailOpen) refreshTagNames()
  }, [detailOpen, refreshTagNames])

  useEffect(() => {
    if (effectiveDefaultScraper) {
      setScraperName((prev) => prev || effectiveDefaultScraper)
    }
  }, [effectiveDefaultScraper])

  const filterState: LibraryFilterState = {
    status,
    pendingScrape,
    year,
    codePrefix,
    sortBy,
    sortDir,
    tagIds,
    resourceKinds
  }

  const patchFilters = (patch: Partial<LibraryFilterState>): void => {
    const updates: Record<string, string | null | undefined> = {}
    if (patch.status !== undefined) {
      updates[LIST_PARAM.status] = patch.status === 'all' ? null : String(patch.status)
    }
    if (patch.pendingScrape !== undefined) {
      updates[LIST_PARAM.pending] = patch.pendingScrape === 'all' ? null : patch.pendingScrape
    }
    if (patch.year !== undefined) {
      updates[LIST_PARAM.year] = patch.year === 'all' ? null : String(patch.year)
    }
    if (patch.sortBy !== undefined) updates[LIST_PARAM.sort] = patch.sortBy
    if (patch.sortDir !== undefined) updates[LIST_PARAM.dir] = patch.sortDir
    if (patch.codePrefix !== undefined) {
      updates[LIST_PARAM.prefix] = patch.codePrefix.trim() || null
    }
    if (patch.tagIds !== undefined) {
      updates[LIST_PARAM.tags] = patch.tagIds.length ? patch.tagIds.join(',') : null
    }
    if (patch.resourceKinds !== undefined) {
      updates[LIST_PARAM.resources] = videoResourceFiltersParam(patch.resourceKinds)
    }
    patchParams(updates)
  }

  const resetFilters = (): void => {
    forgetPrimaryListLocation(mediaLibraryPath(libraryId))
    setSearchParams(
      (prev) =>
        patchSearchParams(prev, {
          [LIST_PARAM.status]: null,
          [LIST_PARAM.pending]: null,
          [LIST_PARAM.year]: null,
          [LIST_PARAM.prefix]: null,
          [LIST_PARAM.tags]: null,
          [LIST_PARAM.resources]: null,
          [LIST_PARAM.sort]: null,
          [LIST_PARAM.dir]: null
        }),
      { replace: true }
    )
  }

  const hasNonDefaultSort =
    sortBy !== libraryDefaults.sortBy || sortDir !== libraryDefaults.sortDir
  const hasAppliedFilters =
    status !== 'all' ||
    pendingScrape !== 'all' ||
    year !== 'all' ||
    !!codePrefix ||
    tagIds.length > 0 ||
    resourceKinds.length > 0 ||
    hasNonDefaultSort

  const handlePageError = useCallback(
    (e: unknown) => toast.show(String((e as Error).message ?? e), 'error'),
    [toast]
  )

  const { videos, total, loading, loadingMore, hasMore, loadMore, isFetching, refetchSilent } =
    useInfiniteVideoList(scope, query, scopedQueryHash, handlePageError, surfaceMode === 'active')

  const unscrapedQuery = useQuery({
    queryKey: videoKeys.list(scope, { scrapedStatus: 0, limit: 1 }, 'unscraped-count'),
    queryFn: () => api.videos.list(scope, { scrapedStatus: 0, limit: 1, offset: 0 }),
    enabled: surfaceMode === 'active',
    staleTime: 5_000
  })
  const refetchUnscraped = unscrapedQuery.refetch
  const refetchLibrarySurface = useCallback(() => {
    refetchSilent()
    void refetchUnscraped()
  }, [refetchSilent, refetchUnscraped])

  useListSurfaceRefetch(detailOpen, refetchLibrarySurface)

  const {
    selectedIds,
    selectedCount,
    selectionMode,
    toggleSelection: toggleVideoSelection,
    clearSelection
  } = useRangeSelection(videos, scopedQueryHash)

  const selectedVideos = useMemo(
    () => videos.filter((video) => selectedIds.has(video.id)),
    [videos, selectedIds]
  )

  const [unscrapedBannerHidden, setUnscrapedBannerHidden] = useState(() =>
    isMaintenanceHintDismissed(MAINTENANCE_HINT_KEYS.videoBanner)
  )
  const { videoBatchActive } = useBatchScrapeActivity()
  const unscrapedCount = unscrapedQuery.data?.total ?? 0
  const showUnscrapedBanner =
    !unscrapedBannerHidden && !selectionMode && status !== 0 && unscrapedCount > 0

  const dismissUnscrapedBanner = (): void => {
    dismissMaintenanceHint(MAINTENANCE_HINT_KEYS.videoBanner)
    setUnscrapedBannerHidden(true)
  }

  const startUnscrapedBatch = async (): Promise<void> => {
    if (!effectiveDefaultScraper) {
      toast.show('请先在设置中配置默认影片刮削插件', 'error')
      return
    }
    try {
      await startDefaultUnscrapedVideoBatch(effectiveDefaultScraper, libraryId)
      toast.show(`已开始“${library?.name ?? `媒体库 #${libraryId}`}”批量刮削`, 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const openEdit = async (video: Video): Promise<void> => {
    if (editLoadingId !== null) return
    setEditLoadingId(video.id)
    try {
      const detail = await api.videos.get(scope, video.id)
      if (!detail) {
        toast.show('未找到该影片', 'error')
        return
      }
      setEditingVideo(detail)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setEditLoadingId(null)
    }
  }

  const saveEdit = async (input: VideoEditInput): Promise<void> => {
    if (!editingVideo) return
    try {
      await api.videos.edit(editingVideo.id, input)
      setEditingVideo(null)
      toast.show('元数据已保存', 'success')
      invalidateVideoLibraryQueries(queryClient)
      refetchLibrarySurface()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const executeSingleScrape = async (
    request: SingleScrapeRequest,
    directorSelectionId?: number
  ): Promise<void> => {
    setScraperName(request.site)
    if (directorSelectionId != null) setDirectorChoiceBusy(true)
    try {
      const res = await api.scrape.one(
        request.target.id,
        request.site || undefined,
        request.fields,
        request.mode,
        directorSelectionId,
        libraryId
      )
      if (res.directorChoice) {
        setPendingDirectorChoice({ ...request, choice: res.directorChoice })
        return
      }
      if (res.pending) {
        setScrapeTarget(null)
        toast.show('发现多个候选，已保存到待确认中心', 'info')
        navigate(pendingCenterPath({ type: 'scrape', videoId: request.target.id }))
        return
      }
      setPendingDirectorChoice(null)
      const hasWarnings = res.warnings.length > 0
      toast.show(
        res.applied
          ? hasWarnings
            ? `已更新 ${request.target.code}，部分字段未应用：${res.warnings.join('；')}`
            : `已更新 ${request.target.code}`
          : hasWarnings
            ? `所选字段未应用：${res.warnings.join('；')}`
            : '所选字段无可写入内容',
        res.applied && !hasWarnings ? 'success' : 'info'
      )
      if (res.applied) {
        invalidateVideoLibraryQueries(queryClient)
        refetchLibrarySurface()
      }
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setDirectorChoiceBusy(false)
    }
  }

  const runSingleScrape = (
    fields: VideoScrapeField[],
    site: string,
    mode?: VideoScrapeUpdateMode
  ): void => {
    if (!scrapeTarget) return
    const request: SingleScrapeRequest = {
      target: { id: scrapeTarget.id, code: scrapeTarget.code },
      fields,
      site,
      mode
    }
    setScrapeTarget(null)
    void executeSingleScrape(request)
  }

  const markScrapeSuccess = async (video: Video): Promise<void> => {
    try {
      await api.videos.markScrapeSuccess(video.id)
      toast.show('已标记为刮削成功', 'success')
      invalidateVideoLibraryQueries(queryClient)
      refetchLibrarySurface()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const runBulkScrape = async (
    fields: VideoScrapeField[],
    site: string,
    mode?: VideoScrapeUpdateMode
  ): Promise<void> => {
    const videoIds = [...selectedIds]
    if (videoIds.length === 0) return
    setShowBulkScrape(false)
    setScraperName(site)
    try {
      await api.scrape.videoBatchStart(
        withVideoBatchRequestScope(
          { kind: 'library', libraryId },
          {
            status: 'all',
            videoIds,
            fields,
            scraperName: site || undefined,
            mode
          }
        )
      )
      toast.show(
        `已开始“${library?.name ?? `媒体库 #${libraryId}`}”批量刮削 ${videoIds.length} 部影片`,
        'success'
      )
      clearSelection()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const loadDeletePreviews = async (targets: Video[]): Promise<void> => {
    const requestId = ++removalPreviewRequestRef.current
    setRemovalPreviewLoading(true)
    setRemovalImpacts(new Map())
    try {
      const impacts = await Promise.all(
        targets.map((video) => api.videos.previewDeleteGlobally(video.id))
      )
      if (requestId !== removalPreviewRequestRef.current) return
      setRemovalImpacts(new Map(impacts.map((impact) => [impact.videoId, impact])))
    } catch (error) {
      if (requestId !== removalPreviewRequestRef.current) return
      setDeleteTarget(null)
      setConfirmBulkDelete(false)
      toast.show(String((error as Error).message ?? error), 'error')
    } finally {
      if (requestId === removalPreviewRequestRef.current) setRemovalPreviewLoading(false)
    }
  }

  const openSingleRemoval = (video: Video): void => {
    setDeleteTarget(video)
    void loadDeletePreviews([video])
  }

  const openBulkRemoval = (): void => {
    setConfirmBulkDelete(true)
    void loadDeletePreviews(selectedVideos)
  }

  const deleteVideos = async (targets: Video[]): Promise<void> => {
    if (deleting || targets.length === 0) return
    if (targets.some((video) => !removalImpacts.has(video.id))) {
      toast.show('删除影响预览尚未就绪，请稍后重试', 'error')
      return
    }
    setDeleting(true)
    let deleted = 0
    let failed = 0
    for (const video of targets) {
      try {
        const impact = removalImpacts.get(video.id)
        if (!impact) throw new Error('缺少删除影响预览')
        await api.videos.deleteGlobally({
          videoId: video.id,
          operationId:
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `delete-${video.id}-${Date.now()}`,
          expectedRevision: impact.revision
        })
        deleted += 1
      } catch {
        failed += 1
      }
    }
    setDeleting(false)
    setDeleteTarget(null)
    setConfirmBulkDelete(false)
    setRemovalImpacts(new Map())
    if (targets.length > 1) clearSelection()
    if (deleted > 0) {
      invalidateVideoLibraryQueries(queryClient)
      refetchLibrarySurface()
    } else {
      refetchSilent()
    }
    if (failed > 0) {
      toast.show(`已删除 ${deleted} 部，${failed} 部失败`, 'error')
    } else {
      toast.show(targets.length > 1 ? `已删除 ${deleted} 部影片` : '已删除影片', 'success')
    }
  }

  const loadMembershipPreviews = async (targets: Video[]): Promise<void> => {
    const requestId = ++membershipPreviewRequestRef.current
    setMembershipPreviewLoading(true)
    setMembershipImpacts(new Map())
    try {
      const impacts = await Promise.all(
        targets.map((video) => api.videos.previewRemoveFromLibrary(libraryId, video.id))
      )
      if (requestId !== membershipPreviewRequestRef.current) return
      setMembershipImpacts(new Map(impacts.map((impact) => [impact.videoId, impact])))
    } catch (error) {
      if (requestId !== membershipPreviewRequestRef.current) return
      setMembershipTarget(null)
      setConfirmBulkRemove(false)
      toast.show(String((error as Error).message ?? error), 'error')
    } finally {
      if (requestId === membershipPreviewRequestRef.current) setMembershipPreviewLoading(false)
    }
  }

  const openSingleMembershipRemoval = (video: Video): void => {
    setMembershipTarget(video)
    void loadMembershipPreviews([video])
  }

  const openBulkMembershipRemoval = (): void => {
    setConfirmBulkRemove(true)
    void loadMembershipPreviews(selectedVideos)
  }

  const removeVideosFromLibrary = async (targets: Video[]): Promise<void> => {
    if (removingMembership || targets.length === 0) return
    if (targets.some((video) => !membershipImpacts.has(video.id))) {
      toast.show('移出影响预览尚未就绪，请稍后重试', 'error')
      return
    }
    setRemovingMembership(true)
    let removed = 0
    let failed = 0
    for (const video of targets) {
      try {
        const impact = membershipImpacts.get(video.id)
        if (!impact) throw new Error('缺少移出影响预览')
        await api.videos.removeFromLibrary({
          libraryId,
          videoId: video.id,
          operationId:
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `remove-${libraryId}-${video.id}-${Date.now()}`,
          expectedRevision: impact.revision
        })
        removed += 1
      } catch {
        failed += 1
      }
    }
    setRemovingMembership(false)
    setMembershipTarget(null)
    setConfirmBulkRemove(false)
    setMembershipImpacts(new Map())
    if (targets.length > 1) clearSelection()
    if (removed > 0) {
      invalidateVideoLibraryQueries(queryClient)
      refetchLibrarySurface()
    } else {
      refetchSilent()
    }
    if (failed > 0) {
      toast.show(`已移出 ${removed} 部，${failed} 部失败`, 'error')
    } else {
      toast.show(targets.length > 1 ? `已移出 ${removed} 部影片` : '已移出媒体库', 'success')
    }
  }

  const appliedFilters: AppliedFilterItem[] = []
  if (status !== 'all') {
    appliedFilters.push({
      key: 'status',
      label: STATUS_LABELS[String(status)],
      onRemove: () => patchFilters({ status: 'all' })
    })
  }
  if (pendingScrape !== 'all') {
    appliedFilters.push({
      key: 'pending',
      label: pendingScrape === 'pending' ? '仅待确认刮削' : '排除待确认刮削',
      onRemove: () => patchFilters({ pendingScrape: 'all' })
    })
  }
  if (year !== 'all') {
    appliedFilters.push({
      key: 'year',
      label: String(year),
      onRemove: () => patchFilters({ year: 'all' })
    })
  }
  if (codePrefix) {
    appliedFilters.push({
      key: 'prefix',
      label: `系列 ${codePrefix}`,
      onRemove: () => patchFilters({ codePrefix: '' })
    })
  }
  if (hasNonDefaultSort) {
    appliedFilters.push({
      key: 'sort',
      label: `${SORT_LABELS[sortBy]}${sortDir === 'asc' ? ' ↑' : ' ↓'}`,
      onRemove: () =>
        patchParams({
          [LIST_PARAM.sort]: libraryDefaults.sortBy,
          [LIST_PARAM.dir]: libraryDefaults.sortDir
        })
    })
  }
  for (const id of tagIds) {
    appliedFilters.push({
      key: `tag:${id}`,
      label: tagNames.get(id) ?? String(id),
      onRemove: () => patchFilters({ tagIds: tagIds.filter((x) => x !== id) })
    })
  }
  for (const kind of resourceKinds) {
    appliedFilters.push({
      key: `resource:${kind}`,
      label: VIDEO_RESOURCE_FILTER_LABELS[kind],
      onRemove: () =>
        patchFilters({ resourceKinds: resourceKinds.filter((item) => item !== kind) })
    })
  }
  const emptyDueToFilter = Boolean(debouncedQ.trim()) || hasAppliedFilters

  if (surfaceMode === 'archived' && library) {
    return (
      <div className="list-page">
        <div className="topbar library-header">
          <ListToolbar
            leading={
              <div
                className={styles.identity}
                style={mediaLibraryIdentityStyle(library.color)}
                title={library.name}
              >
                <span className={styles.identityIcon} aria-hidden>
                  <NavIcon name={library.icon} />
                </span>
                <span className={styles.identityName}>{library.name}</span>
              </div>
            }
            title="已归档媒体库"
            controls={
              <Button
                type="button"
                size="sm"
                onClick={() => navigate(mediaLibrarySettingsPath(libraryId, 'danger'))}
              >
                <Settings {...UI_ICON_SM} aria-hidden />
                恢复设置
              </Button>
            }
          />
        </div>
        <ListSurface variant="fill" withInner={false}>
          <div className="scroll-body-inner">
            <EmptyState
              icon={<Archive {...UI_ICON_SM} aria-hidden />}
              title="该媒体库已归档"
              description="归档期间不会扫描、导入或刮削，也不会显示可写的影片列表。恢复后原有目录、成员和资源会重新可用。"
            >
              <Button
                size="sm"
                onClick={() => navigate(mediaLibrarySettingsPath(libraryId, 'danger'))}
              >
                前往恢复媒体库
              </Button>
            </EmptyState>
          </div>
        </ListSurface>
      </div>
    )
  }

  return (
    <div className="list-page">
      <div className="topbar library-header">
        {selectionMode ? (
          <SelectionToolbar
            countLabel={`已选择 ${selectedCount} 部影片 · Shift 连选`}
            onClear={clearSelection}
            actions={[
              {
                key: 'playlist',
                label: '加入清单',
                icon: <ListPlus {...UI_ICON_SM} aria-hidden />,
                onClick: () => setShowBulkPlaylist(true)
              },
              {
                key: 'scrape',
                label: '刮削元数据',
                icon: <SearchCheck {...UI_ICON_SM} aria-hidden />,
                onClick: () => setShowBulkScrape(true)
              },
              {
                key: 'remove',
                label: '移出媒体库',
                icon: <FolderMinus {...UI_ICON_SM} aria-hidden />,
                onClick: openBulkMembershipRemoval
              },
              {
                key: 'delete',
                label: '删除影片',
                icon: <Trash2 {...UI_ICON_SM} aria-hidden />,
                danger: true,
                onClick: openBulkRemoval
              }
            ]}
          />
        ) : (
          <ListToolbar
            leading={
              library ? (
                <div
                  className={styles.identity}
                  style={mediaLibraryIdentityStyle(library.color)}
                  title={library.name}
                >
                  <span className={styles.identityIcon} aria-hidden>
                    <NavIcon name={library.icon} />
                  </span>
                  <span className={styles.identityName}>{library.name}</span>
                </div>
              ) : undefined
            }
            search={{
              value: searchInput,
              placeholder: '搜索番号、标题或演员（含别名）…',
              ariaLabel: '搜索',
              onChange: setSearchInput
            }}
            controls={
              <>
                <div className="library-filter-anchor">
                  <Button
                    ref={filterBtnRef}
                    type="button"

                    size="sm"
                    className={`library-filter-btn${filterOpen ? ' library-filter-btn--open' : ''}${hasAppliedFilters ? ' library-filter-btn--active' : ''}`}
                    onClick={() => setFilterOpen((o) => !o)}
                    aria-expanded={filterOpen}
                    aria-haspopup="dialog"
                  >
                    <span className="library-filter-btn-label">筛选</span>
                    <ChevronDown
                      {...UI_ICON_SM}
                      className={`library-filter-chevron${filterOpen ? ' is-open' : ''}`}
                      aria-hidden
                    />
                  </Button>

                  <LibraryFilterPopover
                    open={filterOpen}
                    onClose={() => setFilterOpen(false)}
                    years={years}
                    state={filterState}
                    onChange={patchFilters}
                    onReset={resetFilters}
                    anchorRef={filterBtnRef}
                  />
                </div>

                <SortSwitch
                  label="排序"
                  options={SORT_SWITCH_OPTIONS}
                  value={sortBy}
                  dir={sortDir}
                  onChange={(nextSortBy, nextSortDir) =>
                    patchParams({
                      [LIST_PARAM.sort]: nextSortBy,
                      [LIST_PARAM.dir]: nextSortDir
                    })
                  }
                />

                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => setShowResourceImport(true)}
                >
                  <Link2 {...UI_ICON_SM} aria-hidden />
                  导入链接
                </Button>

                <Button
                  type="button"
                  size="sm"
                  onClick={() => navigate(mediaLibrarySettingsPath(libraryId, 'sources'))}
                >
                  <Settings {...UI_ICON_SM} aria-hidden />
                  设置
                </Button>
              </>
            }
            resultCount={
              <span className="count-badge count-badge--stable count-badge--media" aria-live="polite">
                共 {total} 部
                {isFetching && !loading && videos.length > 0 ? (
                  <span className="library-fetch-hint" aria-hidden>
                    {' '}
                    ↻
                  </span>
                ) : null}
              </span>
            }
          />
        )}

        {!selectionMode && hasAppliedFilters && (
          <AppliedFilterBar items={appliedFilters} onClear={resetFilters} />
        )}

        {showUnscrapedBanner ? (
          <ListMaintenanceBanner
            title={`${unscrapedCount} 部影片未刮削`}
            detail={
              videoBatchActive
                ? '影片批量刮削任务进行中，任务范围可在设置的任务详情中查看。'
                : '可筛选查看后，为当前媒体库批量补齐元数据与封面。'
            }
            secondaryLabel="查看未刮削"
            primaryLabel={videoBatchActive ? '刮削进行中…' : '一键刮削'}
            onSecondary={() => patchFilters({ status: 0 })}
            onPrimary={() => void startUnscrapedBatch()}
            onDismiss={dismissUnscrapedBanner}
            primaryDisabled={videoBatchActive || !effectiveDefaultScraper}
            primaryDisabledReason={
              videoBatchActive
                ? '批量刮削任务进行中'
                : !effectiveDefaultScraper
                  ? '请先在设置中配置默认影片刮削插件'
                  : undefined
            }
          />
        ) : null}
      </div>

      <ListSurface variant="fill" withInner={false}>
        {libraryQuery.isLoading || loading ? (
          <div className="scroll-body-inner">
            <EmptyState loading title="加载中…" />
          </div>
        ) : libraryQuery.isError || !library ? (
          <div className="scroll-body-inner">
            <EmptyState
              icon={<Film {...UI_ICON_SM} aria-hidden />}
              title="无法打开媒体库"
              description={
                libraryQuery.isError ? '读取媒体库配置失败，请稍后重试。' : '该媒体库不存在或已被归档。'
              }
            >
              {libraryQuery.isError ? (
                <Button size="sm" onClick={() => void libraryQuery.refetch()}>
                  重新加载
                </Button>
              ) : null}
            </EmptyState>
          </div>
        ) : videos.length === 0 ? (
          <div className="scroll-body-inner">
            <EmptyState
              icon={
                emptyDueToFilter ? (
                  <SearchX {...UI_ICON_SM} aria-hidden />
                ) : (
                  <Film {...UI_ICON_SM} aria-hidden />
                )
              }
              title={emptyDueToFilter ? '没有匹配的影片' : '媒体库为空'}
              description={
                emptyDueToFilter
                  ? '调整搜索或筛选条件后再试。'
                  : library.rootCount > 0
                    ? '扫描媒体库来源后，影片会显示在这里。'
                    : '请先在媒体库设置中添加来源目录。'
              }
            />
          </div>
        ) : (
          <VirtualPosterGrid
            scrollMemoryKey={scrollMemoryKey}
            videos={videos}
            detailLibraryId={libraryId}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
            selectedIds={selectedIds}
            selectionMode={selectionMode}
            onToggleSelect={toggleVideoSelection}
            onEdit={(video) => {
              void openEdit(video)
            }}
            onAddToPlaylist={setPlaylistTarget}
            onScrape={setScrapeTarget}
            onMarkScrapeSuccess={(video) => {
              void markScrapeSuccess(video)
            }}
            onDelete={openSingleRemoval}
            deleteLabel="删除影片"
            onRemoveFromLibrary={openSingleMembershipRemoval}
          />
        )}
      </ListSurface>

      {playlistTarget && (
        <AddToPlaylistModal
          videoId={playlistTarget.id}
          videoCode={playlistTarget.code}
          onCancel={() => setPlaylistTarget(null)}
        />
      )}

      {showResourceImport && (
        <VideoResourceImportModal
          libraryId={libraryId}
          onCancel={() => setShowResourceImport(false)}
          onImported={(result) => {
            setShowResourceImport(false)
            toast.show(result.createdVideo ? '影片已导入' : '资源已添加', 'success')
            invalidateVideoLibraryQueries(queryClient)
          }}
        />
      )}

      {showBulkPlaylist && (
        <AddVideosToPlaylistModal
          videoIds={[...selectedIds]}
          onCancel={() => setShowBulkPlaylist(false)}
          onChanged={() => {
            setShowBulkPlaylist(false)
            clearSelection()
          }}
        />
      )}

      {editingVideo && (
        <EditMetadataModal
          video={editingVideo}
          onCancel={() => setEditingVideo(null)}
          onSave={saveEdit}
        />
      )}

      {scrapeTarget && (
        <ScrapeFieldsModal
          title={`刮削元数据 · ${scrapeTarget.code}`}
          hint="先确定站点与更新方式，再勾选要写入的字段。"
          options={VIDEO_SCRAPE_FIELD_OPTIONS}
          scrapers={scrapers}
          pluginDetails={pluginDetails}
          initialScraperName={scraperName}
          scraperTitle="刮削站点"
          initialSelected={ALL_VIDEO_SCRAPE_FIELDS}
          updateModeOptions={VIDEO_SCRAPE_UPDATE_MODE_OPTIONS}
          initialUpdateMode="replace"
          confirmText="开始刮削"
          onCancel={() => setScrapeTarget(null)}
          onConfirm={(fields, site, _scope, mode) => {
            runSingleScrape(fields, site, mode as VideoScrapeUpdateMode | undefined)
          }}
        />
      )}

      {pendingDirectorChoice && (
        <DirectorScrapeChoiceModal
          choice={pendingDirectorChoice.choice}
          busy={directorChoiceBusy}
          onCancel={() => setPendingDirectorChoice(null)}
          onChoose={(directorId) => {
            void executeSingleScrape(pendingDirectorChoice, directorId)
          }}
        />
      )}

      {showBulkScrape && (
        <ScrapeFieldsModal
          title="批量刮削元数据"
          hint={`先确定站点与更新方式，再勾选要写入的字段。只处理当前媒体库中已选择的 ${selectedCount} 部影片。`}
          options={VIDEO_SCRAPE_FIELD_OPTIONS}
          scrapers={scrapers}
          pluginDetails={pluginDetails}
          initialScraperName={scraperName}
          scraperTitle="刮削站点"
          initialSelected={ALL_VIDEO_SCRAPE_FIELDS}
          updateModeOptions={VIDEO_SCRAPE_UPDATE_MODE_OPTIONS}
          confirmText="开始批量刮削"
          onCancel={() => setShowBulkScrape(false)}
          onConfirm={(fields, site, _scope, mode) => {
            void runBulkScrape(fields, site, mode as VideoScrapeUpdateMode | undefined)
          }}
        />
      )}

      {deleteTarget && (
        <Modal
          title="删除影片"
          size="lg"
          danger
          confirmText={deleting ? '删除中…' : removalPreviewLoading ? '读取影响…' : '永久删除'}
          confirmDisabled={removalPreviewLoading || !removalImpacts.has(deleteTarget.id)}
          busy={deleting}
          onConfirm={() => {
            if (!deleting) void deleteVideos([deleteTarget])
          }}
          onCancel={() => {
            if (!deleting) {
              removalPreviewRequestRef.current += 1
              setDeleteTarget(null)
              setRemovalImpacts(new Map())
            }
          }}
        >
          {removalPreviewLoading && !removalImpacts.get(deleteTarget.id) ? (
            <p>正在读取完整影响范围…</p>
          ) : null}
          {removalImpacts.get(deleteTarget.id) ? (
            <VideoDeleteImpact impact={removalImpacts.get(deleteTarget.id)!} />
          ) : null}
        </Modal>
      )}

      {membershipTarget && (
        <Modal
          title="移出媒体库"
          size="lg"
          confirmText={
            removingMembership ? '移出中…' : membershipPreviewLoading ? '读取影响…' : '移出媒体库'
          }
          confirmDisabled={
            membershipPreviewLoading || !membershipImpacts.has(membershipTarget.id)
          }
          busy={removingMembership}
          onConfirm={() => {
            if (!removingMembership) void removeVideosFromLibrary([membershipTarget])
          }}
          onCancel={() => {
            if (!removingMembership) {
              membershipPreviewRequestRef.current += 1
              setMembershipTarget(null)
              setMembershipImpacts(new Map())
            }
          }}
        >
          {membershipPreviewLoading && !membershipImpacts.get(membershipTarget.id) ? (
            <p>正在读取完整影响范围…</p>
          ) : null}
          {membershipImpacts.get(membershipTarget.id) ? (
            <VideoDeleteImpact impact={membershipImpacts.get(membershipTarget.id)!} />
          ) : null}
        </Modal>
      )}

      {confirmBulkRemove && (
        <Modal
          title="批量移出媒体库"
          confirmText={
            removingMembership ? '移出中…' : membershipPreviewLoading ? '读取影响…' : '移出媒体库'
          }
          confirmDisabled={
            membershipPreviewLoading ||
            selectedVideos.some((video) => !membershipImpacts.has(video.id))
          }
          busy={removingMembership}
          onConfirm={() => {
            if (!removingMembership) void removeVideosFromLibrary(selectedVideos)
          }}
          onCancel={() => {
            if (!removingMembership) {
              membershipPreviewRequestRef.current += 1
              setConfirmBulkRemove(false)
              setMembershipImpacts(new Map())
            }
          }}
        >
          确定要从当前媒体库移出已选择的 {selectedCount} 部影片吗？只会移除本库成员和本库资源，不会删除全局影片或磁盘文件。
        </Modal>
      )}

      {confirmBulkDelete && (
        <Modal
          title="批量删除影片"
          danger
          confirmText={deleting ? '删除中…' : removalPreviewLoading ? '读取影响…' : '永久删除'}
          confirmDisabled={
            removalPreviewLoading || selectedVideos.some((video) => !removalImpacts.has(video.id))
          }
          busy={deleting}
          onConfirm={() => {
            if (!deleting) void deleteVideos(selectedVideos)
          }}
          onCancel={() => {
            if (!deleting) {
              removalPreviewRequestRef.current += 1
              setConfirmBulkDelete(false)
              setRemovalImpacts(new Map())
            }
          }}
        >
          确定要永久删除已选择的 {selectedCount} 部影片吗？会删除全局影片资料、各媒体库中的成员关系，以及本地视频 / STRM 源文件。
          {removalImpacts.size > 0 ? (
            <div className="modal-path-hint">
              将删除{' '}
              {[...removalImpacts.values()].reduce(
                (totalResources, impact) => totalResources + impact.sourcePaths.length,
                0
              )}{' '}
              个本地或 STRM 源文件，并移除{' '}
              {[...removalImpacts.values()].reduce(
                (totalResources, impact) => totalResources + impact.resourceIds.length,
                0
              )}{' '}
              条资源记录
            </div>
          ) : null}
        </Modal>
      )}
    </div>
  )
}
