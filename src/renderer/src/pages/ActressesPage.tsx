import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMatch, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, CircleAlert, SearchCheck, SearchX, Trash2, Users } from 'lucide-react'
import {
  ACTRESS_LIST_DEFAULTS,
  ACTRESS_SCRAPE_FIELD_OPTIONS,
  ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS,
  ALL_ACTRESS_SCRAPE_FIELDS,
  type ActressAvatarFilter,
  type ActressListItem,
  type ActressListSortBy,
  type ActressScrapeField,
  type ActressScrapeUpdateMode
} from '@shared/types'
import { api, assetUrl } from '../api'
import { useDebounce } from '../hooks/useDebounce'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import { useRangeSelection } from '../hooks/useRangeSelection'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import { useToast } from '../components/Toast'
import ConfirmModal from '../components/ConfirmModal'
import ActressName from '../components/ActressName'
import AppliedFilterBar, { type AppliedFilterItem } from '../components/AppliedFilterBar'
import ListToolbar from '../components/ListToolbar'
import SelectionToolbar from '../components/SelectionToolbar'
import SortSwitch, { type SortSwitchOption } from '../components/SortSwitch'
import ScrapeFieldsModal from '../components/ScrapeFieldsModal'
import ActressStatusBadge from '../components/ActressStatusBadge'
import ActressFilterPopover, { type ActressFilterState } from '../components/ActressFilterPopover'
import ActressFaceScanModal from '../components/ActressFaceScanModal'
import { ACTRESS_STATUS_FILTER_LABELS } from '@shared/types'
import {
  actressQueryHash,
  actressAvatarParam,
  actressStatusParam,
  ACTRESS_DEFAULT_AVATAR,
  ACTRESS_DEFAULT_STATUS,
  LIST_PARAM,
  parseActressAvatar,
  parseActressSort,
  parseActressStatus,
  parseGender,
  patchSearchParams
} from '../listView/listQueryParams'
import { navigateToActressConflicts, navigateToActressDetail } from '../listView/listNavigation'
import { forgetPrimaryListLocation } from '../listView/primaryNavigationMemory'
import { ROUTE_MATCH, ROUTE_PATH } from '../listView/routePaths'
import { useLocation, useNavigate } from 'react-router-dom'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { invalidateActressLibraryQueries } from '../query/invalidateLibraryQueries'
import { actressKeys, overviewStatsKeys } from '../query/queryKeys'
import ActressAvatar from '../components/ActressAvatar'
import MediaTileActionButton from '../components/MediaTileActionButton'
import { useScraperPluginCatalog } from '../hooks/useScraperPluginCatalog'
import { useLibraryOverviewStats } from '../hooks/useLibraryOverviewStats'
import { useBatchScrapeActivity } from '../hooks/useBatchScrapeActivity'
import ListMaintenanceBanner from '../components/ListMaintenanceBanner'
import EmptyState from '../components/EmptyState'
import ListSurface from '../components/ListSurface'
import { UI_ICON_SM } from '../components/iconDefaults'
import { startDefaultUnscrapedActressBatch } from '../utils/defaultBatchScrape'
import {
  dismissMaintenanceHint,
  isMaintenanceHintDismissed,
  MAINTENANCE_HINT_KEYS
} from '../utils/maintenanceHints'
import {
  actressesWithoutFace,
  uncachedActressFaceScanIdentity
} from '../actressFaceFilter/cache'
import { useActressFaceScan, previousAvatarAfterFaceScan } from '../actressFaceFilter/useActressFaceScan'
import { useAvatarAutoCropBatch } from '../contexts/AvatarAutoCropBatchContext'

const ACTRESS_SORT_OPTIONS: SortSwitchOption<ActressListSortBy>[] = [
  { value: 'video_count', label: '影片', title: '本地影片数' },
  { value: 'gallery', label: '写真', title: '写真数量' },
  { value: 'age', label: '年龄', title: '出生日期' },
  { value: 'cup_size', label: '罩杯', title: '罩杯' }
]

const ACTRESS_GENDER_LABELS = {
  female: '女演员',
  male: '男演员',
  all: '全部演员'
}

const ACTRESS_SORT_LABELS: Record<ActressListSortBy, string> = {
  video_count: '影片数',
  gallery: '写真数',
  age: '年龄',
  cup_size: '罩杯'
}

export default function ActressesPage(): JSX.Element {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const actressDetailOpen = useMatch({ path: ROUTE_MATCH.actressDetailOpen, end: false })
  const conflictReviewOpen = useMatch({ path: ROUTE_MATCH.actressConflicts, end: false })
  const detailOpen = Boolean(actressDetailOpen || conflictReviewOpen)

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

  const genderFilter = parseGender(searchParams.get(LIST_PARAM.gender))
  const statusFilter = parseActressStatus(searchParams.get(LIST_PARAM.status))
  const avatarFilter = parseActressAvatar(searchParams.get(LIST_PARAM.avatar))
  const { sortBy, sortDir } = parseActressSort(
    searchParams.get(LIST_PARAM.sort),
    searchParams.get(LIST_PARAM.dir)
  )
  const queryHash = useMemo(() => actressQueryHash(searchParams), [searchParams])
  const scrollMemoryKey = `actresses:${queryHash}`
  const { ref: scrollRef, showScrollToTop, scrollToTop } = useScrollContainerMemory(scrollMemoryKey)

  const patchParams = useCallback(
    (patch: Record<string, string | null | undefined>): void => {
      setSearchParams((prev) => patchSearchParams(prev, patch), { replace: true })
    },
    [setSearchParams]
  )

  const [pendingDelete, setPendingDelete] = useState<ActressListItem | null>(null)
  const [showBulkScrape, setShowBulkScrape] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const filterBtnRef = useRef<HTMLButtonElement>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const faceScan = useActressFaceScan()
  const avatarAutoCropBatch = useAvatarAutoCropBatch()

  const dismissOverlays = useCallback(() => {
    setPendingDelete(null)
    setShowBulkScrape(false)
    setConfirmBulkDelete(false)
    setFilterOpen(false)
  }, [])

  useDismissOverlaysOnNavigate(dismissOverlays, location.pathname)

  const listQuery = useQuery({
    queryKey: actressKeys.list(queryHash, debouncedQ.trim(), genderFilter, sortBy, sortDir),
    queryFn: () =>
      api.actresses.listPage({
        search: debouncedQ.trim(),
        gender: genderFilter,
        status: statusFilter,
        avatar: avatarFilter === 'without-face' ? 'with' : avatarFilter,
        sortBy,
        sortDir
      }),
    placeholderData: (prev) => prev
  })
  const conflictSummaryQuery = useQuery({
    queryKey: actressKeys.conflictSummary(),
    queryFn: () => api.actressScrape.conflictSummary(),
    refetchInterval: detailOpen ? false : 3_000
  })
  const pendingConflictCount = conflictSummaryQuery.data?.groupCount ?? 0

  useEffect(() => {
    if (listQuery.isError && listQuery.error) {
      toast.show(String((listQuery.error as Error).message ?? listQuery.error), 'error')
    }
  }, [listQuery.isError, listQuery.error, toast])

  const { stats: overviewStats } = useLibraryOverviewStats()
  const refetchActressSurface = useCallback(() => {
    void listQuery.refetch()
    void queryClient.refetchQueries({ queryKey: overviewStatsKeys.all, type: 'all', stale: true })
  }, [listQuery, queryClient])

  useListSurfaceRefetch(detailOpen, refetchActressSurface)

  const fetchedItems = listQuery.data?.items ?? []
  const items =
    avatarFilter === 'without-face'
      ? actressesWithoutFace(fetchedItems, faceScan.cache)
      : fetchedItems
  const faceScanMissingIdentity = uncachedActressFaceScanIdentity(fetchedItems, faceScan.cache)
  const loading = listQuery.isLoading && items.length === 0
  const isFetching = listQuery.isFetching

  const { scrapers, pluginDetails, defaultScraper } = useScraperPluginCatalog('actress')
  const [scraperName, setScraperName] = useState('')
  useEffect(() => {
    if (defaultScraper) setScraperName((current) => current || defaultScraper)
  }, [defaultScraper])

  const {
    selectedIds,
    selectedCount,
    selectionMode,
    toggleSelection: toggleActressSelection,
    clearSelection
  } = useRangeSelection(items, queryHash)

  const selectedItems = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds]
  )
  const unavailableDeleteCount =
    selectedItems.filter((item) => item.video_count > 0).length +
    Math.max(0, selectedCount - selectedItems.length)
  const canDeleteSelection =
    selectedCount > 0 &&
    selectedItems.length === selectedCount &&
    selectedItems.every((item) => item.video_count === 0)

  const [unscrapedBannerHidden, setUnscrapedBannerHidden] = useState(() =>
    isMaintenanceHintDismissed(MAINTENANCE_HINT_KEYS.actressBanner)
  )
  const { actressBatchActive, anyBatchActive } = useBatchScrapeActivity()
  const avatarBatchActive =
    avatarAutoCropBatch.state.status === 'running' ||
    avatarAutoCropBatch.state.status === 'cancelling'
  const faceScanAutoStartKey = faceScanMissingIdentity
  const faceScanAutoStartedKeyRef = useRef<string | null>(null)

  const startFaceScan = useCallback(
    async (previousAvatar: ActressAvatarFilter, silentBlocked = false): Promise<void> => {
      if (actressBatchActive || avatarBatchActive) {
        if (!silentBlocked) {
          toast.show(
            actressBatchActive
              ? '演员批量刮削进行中，请先完成或终止任务'
              : '头像智能构图进行中，请先完成或终止任务',
            'info'
          )
        }
        return
      }

      faceScanAutoStartedKeyRef.current = faceScanAutoStartKey
      const summary = await faceScan.start()
      if (!summary) return

      // Record only the identities that remain unresolved after this attempt.
      // Search/sort changes keep the same key and therefore only recombine the
      // cache; a changed or newly added avatar produces a new key and rescans.
      faceScanAutoStartedKeyRef.current = uncachedActressFaceScanIdentity(
        fetchedItems,
        faceScan.cache
      )

      if (summary.cancelled) {
        patchParams({
          [LIST_PARAM.avatar]: actressAvatarParam(previousAvatarAfterFaceScan(previousAvatar))
        })
        toast.show('已取消人脸筛选', 'info')
        return
      }

      if (summary.total === 0 && summary.failed > 0) {
        patchParams({ [LIST_PARAM.avatar]: actressAvatarParam(previousAvatar) })
        toast.show(`人脸识别失败：${summary.failures[0]?.message ?? '无法读取头像'}`, 'error')
        return
      }

      patchParams({ [LIST_PARAM.avatar]: actressAvatarParam('without-face') })
      toast.show(
        `找到 ${summary.withoutFace} 位头像未识别到人脸的演员${
          summary.failed > 0 ? `，另有 ${summary.failed} 位识别失败` : ''
        }`,
        summary.failed > 0 ? 'info' : 'success'
      )
    },
    [
      actressBatchActive,
      avatarBatchActive,
      faceScan,
      faceScanAutoStartKey,
      fetchedItems,
      patchParams,
      toast
    ]
  )

  useEffect(() => {
    if (avatarFilter !== 'without-face') {
      faceScanAutoStartedKeyRef.current = null
      return
    }
    if (!faceScan.needsScan && !faceScanMissingIdentity) return
    if (faceScan.running) return
    if (faceScanAutoStartedKeyRef.current === faceScanAutoStartKey) return
    if (actressBatchActive || avatarBatchActive) return
    faceScanAutoStartedKeyRef.current = faceScanAutoStartKey
    void startFaceScan('all', true)
  }, [
    actressBatchActive,
    avatarBatchActive,
    avatarFilter,
    faceScanAutoStartKey,
    faceScanMissingIdentity,
    faceScan.needsScan,
    faceScan.running,
    startFaceScan
  ])

  const unscrapedCount = overviewStats?.actresses.unscraped ?? 0
  const showUnscrapedBanner =
    !unscrapedBannerHidden &&
    !selectionMode &&
    genderFilter === 'female' &&
    unscrapedCount > 0

  const dismissUnscrapedBanner = (): void => {
    dismissMaintenanceHint(MAINTENANCE_HINT_KEYS.actressBanner)
    setUnscrapedBannerHidden(true)
  }

  const startUnscrapedBatch = async (): Promise<void> => {
    if (!defaultScraper) {
      toast.show('请先在设置中配置默认演员刮削插件', 'error')
      return
    }
    try {
      await startDefaultUnscrapedActressBatch(defaultScraper)
      toast.show('已开始演员批量刮削', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const doDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    try {
      await api.actresses.remove(pendingDelete.id)
      setPendingDelete(null)
      toast.show(`已删除「${pendingDelete.main_name}」`, 'success')
      invalidateActressLibraryQueries(queryClient)
      void listQuery.refetch()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const startSelectedBatch = async (
    fields: ActressScrapeField[],
    site: string,
    mode?: ActressScrapeUpdateMode,
    useAliases?: boolean,
    autoCropAvatar?: boolean
  ): Promise<void> => {
    const actressIds = [...selectedIds]
    if (actressIds.length === 0) return
    setShowBulkScrape(false)
    setScraperName(site)
    try {
      await api.actressScrape.batchStart({
        actressIds,
        scope: 'all',
        scrapeStatus: 'all',
        fields,
        scraperName: site || undefined,
        mode,
        useAliases,
        autoCropAvatar
      })
      toast.show(`已开始批量刮削 ${actressIds.length} 位演员`, 'success')
      clearSelection()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const deleteSelectedActresses = async (): Promise<void> => {
    if (deleting || selectedIds.size === 0) return
    setDeleting(true)
    try {
      const result = await api.actresses.removeBatch([...selectedIds])
      setConfirmBulkDelete(false)
      clearSelection()
      toast.show(`已删除 ${result.deletedCount} 位无关联演员`, 'success')
      invalidateActressLibraryQueries(queryClient)
      refetchActressSurface()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
      void listQuery.refetch()
    } finally {
      setDeleting(false)
    }
  }

  const hasNonDefaultSort =
    sortBy !== ACTRESS_LIST_DEFAULTS.sortBy || sortDir !== ACTRESS_LIST_DEFAULTS.sortDir
  const hasStatusFilter = statusFilter !== ACTRESS_DEFAULT_STATUS
  const hasAvatarFilter = avatarFilter !== ACTRESS_DEFAULT_AVATAR
  const hasAppliedFilters =
    genderFilter !== ACTRESS_LIST_DEFAULTS.gender ||
    hasStatusFilter ||
    hasAvatarFilter ||
    hasNonDefaultSort
  const resetFilters = (): void => {
    forgetPrimaryListLocation(ROUTE_PATH.actresses)
    patchParams({
      [LIST_PARAM.gender]: null,
      [LIST_PARAM.status]: null,
      [LIST_PARAM.avatar]: null,
      [LIST_PARAM.sort]: null,
      [LIST_PARAM.dir]: null
    })
  }
  const appliedFilters: AppliedFilterItem[] = []
  if (hasStatusFilter) {
    appliedFilters.push({
      key: 'status',
      label: ACTRESS_STATUS_FILTER_LABELS[statusFilter],
      onRemove: () => patchParams({ [LIST_PARAM.status]: null })
    })
  }
  if (hasAvatarFilter) {
    appliedFilters.push({
      key: 'avatar',
      label:
        avatarFilter === 'with'
          ? '有头像'
          : avatarFilter === 'without'
            ? '无头像'
            : '无人脸',
      onRemove: () => patchParams({ [LIST_PARAM.avatar]: null })
    })
  }
  if (genderFilter !== ACTRESS_LIST_DEFAULTS.gender) {
    appliedFilters.push({
      key: 'gender',
      label: ACTRESS_GENDER_LABELS[genderFilter],
      onRemove: () => patchParams({ [LIST_PARAM.gender]: null })
    })
  }
  if (hasNonDefaultSort) {
    appliedFilters.push({
      key: 'sort',
      label: `${ACTRESS_SORT_LABELS[sortBy]}${sortDir === 'asc' ? ' ↑' : ' ↓'}`,
      onRemove: () =>
        patchParams({
          [LIST_PARAM.sort]: null,
          [LIST_PARAM.dir]: null
        })
    })
  }
  const emptyDueToFilter = Boolean(debouncedQ.trim()) || hasAppliedFilters

  return (
    <div className="list-page">
      <div className="topbar library-header">
        {selectionMode ? (
          <SelectionToolbar
            countLabel={`已选择 ${selectedCount} 位演员 · Shift 连选`}
            onClear={clearSelection}
            actions={[
              {
                key: 'scrape',
                label: '刮削元数据',
                icon: <SearchCheck {...UI_ICON_SM} aria-hidden />,
                disabled: anyBatchActive || !defaultScraper,
                title: anyBatchActive
                  ? '请先完成或终止当前批量刮削任务'
                  : !defaultScraper
                    ? '请先在设置中配置默认演员刮削插件'
                    : undefined,
                onClick: () => setShowBulkScrape(true)
              },
              {
                key: 'delete',
                label: '删除演员',
                icon: <Trash2 {...UI_ICON_SM} aria-hidden />,
                danger: true,
                disabled: !canDeleteSelection,
                title: canDeleteSelection
                  ? undefined
                  : `只能批量删除无关联演员；当前有 ${unavailableDeleteCount} 位仍关联影片`,
                onClick: () => setConfirmBulkDelete(true)
              }
            ]}
          />
        ) : (
          <ListToolbar
            search={{
              value: searchInput,
              placeholder: '搜索演员名或别名…',
              ariaLabel: '搜索演员',
              onChange: setSearchInput
            }}
            controls={
              <>
                {pendingConflictCount > 0 ? (
                  <button
                    type="button"
                    className="btn btn-sm actress-conflict-entry"
                    onClick={() => navigateToActressConflicts(navigate, location)}
                  >
                    <CircleAlert {...UI_ICON_SM} aria-hidden />
                    待确认 {pendingConflictCount}
                  </button>
                ) : null}
                <div className="library-filter-anchor">
                  <button
                    ref={filterBtnRef}
                    type="button"
                    className={`btn btn-sm library-filter-btn${filterOpen ? ' library-filter-btn--open' : ''}${hasAppliedFilters ? ' library-filter-btn--active' : ''}`}
                    onClick={() => setFilterOpen((open) => !open)}
                    aria-expanded={filterOpen}
                    aria-haspopup="dialog"
                  >
                    <span className="library-filter-btn-label">筛选</span>
                    <ChevronDown
                      {...UI_ICON_SM}
                      className={`library-filter-chevron${filterOpen ? ' is-open' : ''}`}
                      aria-hidden
                    />
                  </button>
                  <ActressFilterPopover
                    open={filterOpen}
                    anchorRef={filterBtnRef}
                    state={{ status: statusFilter, avatar: avatarFilter }}
                    onChange={(patch: Partial<ActressFilterState>) => {
                      const updates: Record<string, string | null | undefined> = {}
                      if (patch.status !== undefined) {
                        updates[LIST_PARAM.status] = actressStatusParam(patch.status)
                      }
                      if (patch.avatar !== undefined) {
                        if (patch.avatar === 'without-face') {
                          setFilterOpen(false)
                          void startFaceScan(avatarFilter)
                        } else {
                          updates[LIST_PARAM.avatar] = actressAvatarParam(patch.avatar)
                        }
                      }
                      if (Object.keys(updates).length > 0) patchParams(updates)
                    }}
                    onReset={resetFilters}
                    onClose={() => setFilterOpen(false)}
                  />
                </div>
                <div className="mode-toggle" role="group" aria-label="性别筛选">
                  <button
                    type="button"
                    className={genderFilter === 'female' ? 'active' : ''}
                    onClick={() => patchParams({ [LIST_PARAM.gender]: null })}
                  >
                    女
                  </button>
                  <button
                    type="button"
                    className={genderFilter === 'male' ? 'active' : ''}
                    onClick={() => patchParams({ [LIST_PARAM.gender]: 'male' })}
                  >
                    男
                  </button>
                  <button
                    type="button"
                    className={genderFilter === 'all' ? 'active' : ''}
                    onClick={() => patchParams({ [LIST_PARAM.gender]: 'all' })}
                  >
                    全部
                  </button>
                </div>
                <SortSwitch
                  label="排序"
                  options={ACTRESS_SORT_OPTIONS}
                  value={sortBy}
                  dir={sortDir}
                  onChange={(nextSortBy, nextSortDir) =>
                    patchParams({
                      [LIST_PARAM.sort]: nextSortBy,
                      [LIST_PARAM.dir]: nextSortDir
                    })
                  }
                />
              </>
            }
            resultCount={
              <span
                className="count-badge count-badge--stable count-badge--people"
                aria-live="polite"
              >
                共 {items.length} 位
                {isFetching && !loading && items.length > 0 ? (
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
            title={`${unscrapedCount} 位女优资料未完善`}
            detail={
              actressBatchActive
                ? '批量刮削任务进行中，完成后将自动更新列表。'
                : '可批量补全头像、简介与身体数据。'
            }
            secondaryLabel="查看未刮削"
            primaryLabel={actressBatchActive ? '刮削进行中…' : '一键刮削'}
            onSecondary={() => patchParams({ [LIST_PARAM.status]: actressStatusParam('unscraped') })}
            onPrimary={() => void startUnscrapedBatch()}
            onDismiss={dismissUnscrapedBanner}
            primaryDisabled={actressBatchActive || !defaultScraper}
            primaryDisabledReason={
              actressBatchActive
                ? '批量刮削任务进行中'
                : !defaultScraper
                  ? '请先在设置中配置默认演员刮削插件'
                  : undefined
            }
          />
        ) : null}
      </div>

      <ListSurface
        variant="scroll"
        scrollRef={scrollRef}
        showScrollToTop={showScrollToTop}
        onScrollToTop={scrollToTop}
      >
          {loading ? (
            <EmptyState loading variant="page" />
          ) : items.length === 0 ? (
            <EmptyState
              icon={
                emptyDueToFilter ? (
                  <SearchX {...UI_ICON_SM} aria-hidden />
                ) : (
                  <Users {...UI_ICON_SM} aria-hidden />
                )
              }
              title={emptyDueToFilter ? '没有匹配的演员' : '暂无演员数据'}
              description={
                emptyDueToFilter
                  ? '调整搜索、筛选、性别或排序条件后再试。'
                  : '刮削影片后将自动归纳演员。'
              }
            />
          ) : (
            <div className="actress-grid">
              {items.map((a, index) => {
                const avatar = assetUrl(a.avatar_path)
                const selected = selectedIds.has(a.id)
                return (
                  <div
                    key={a.id}
                    className={`actress-card-wrap${selected ? ' is-selected' : ''}${selectionMode ? ' is-selection-mode' : ''}`}
                  >
                    <button
                      type="button"
                      className={`poster-select-toggle poster-hover-control${selected || selectionMode ? ' is-visible' : ''}${selected ? ' is-checked' : ''}`}
                      aria-label={selected ? `取消选择 ${a.main_name}` : `选择 ${a.main_name}`}
                      aria-pressed={selected}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleActressSelection(a, index, event)
                      }}
                    />
                    <button
                      type="button"
                      className="actress-card card-interactive"
                      aria-pressed={selectionMode ? selected : undefined}
                      onClick={(event) => {
                        if (selectionMode) {
                          toggleActressSelection(a, index, event)
                          return
                        }
                        navigateToActressDetail(navigate, location, a.id)
                      }}
                    >
                      <span className="actress-card-avatar">
                        <ActressAvatar src={avatar} name={a.main_name} gender={a.gender} />
                        <ActressStatusBadge status={a.scraped_status} />
                      </span>
                      <ActressName name={a.main_name} gender={a.gender} className="actress-name" />
                      <div className="actress-count">{a.video_count} 部</div>
                    </button>
                    {!selectionMode && a.video_count === 0 && (
                      <MediaTileActionButton
                        label={`删除演员 ${a.main_name}`}
                        title="删除"
                        onClick={() => setPendingDelete(a)}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
      </ListSurface>

      {pendingDelete && (
        <ConfirmModal
          title="删除演员"
          danger
          confirmText="删除"
          onConfirm={() => void doDelete()}
          onCancel={() => setPendingDelete(null)}
        >
          <p>
            确定删除「{pendingDelete.main_name}」？仅删除演员档案，不影响已关联影片文件。
          </p>
        </ConfirmModal>
      )}

      {showBulkScrape && (
        <ScrapeFieldsModal
          title="批量刮削元数据"
          hint={`先确定站点与更新方式，再勾选要写入的字段。将只处理已选择的 ${selectedCount} 位演员。`}
          options={ACTRESS_SCRAPE_FIELD_OPTIONS}
          scrapers={scrapers}
          pluginDetails={pluginDetails}
          initialScraperName={scraperName || defaultScraper}
          scraperTitle="演员刮削站点"
          initialSelected={ALL_ACTRESS_SCRAPE_FIELDS}
          updateModeOptions={ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS}
          initialUpdateMode="fillEmpty"
          showUseAliasesToggle
          useAliasesHint="开启后，主名未匹配时会依次尝试中文名、英文名及已存别名。"
          showAutoCropAvatarToggle
          autoCropAvatarHint="头像保存后立即按“外观”设置构图，完成后再继续下一位演员。"
          confirmText="开始批量刮削"
          onCancel={() => setShowBulkScrape(false)}
          onConfirm={(
            fields,
            site,
            _scope,
            mode,
            _missing,
            _matchName,
            useAliases,
            _auxScope,
            autoCropAvatar
          ) => {
            void startSelectedBatch(
              fields,
              site,
              mode as ActressScrapeUpdateMode | undefined,
              useAliases,
              autoCropAvatar
            )
          }}
        />
      )}

      {confirmBulkDelete && (
        <ConfirmModal
          title="批量删除演员"
          danger
          confirmText={deleting ? '删除中…' : '删除'}
          busy={deleting}
          closeDisabled={deleting}
          onConfirm={() => {
            if (!deleting) void deleteSelectedActresses()
          }}
          onCancel={() => {
            if (!deleting) setConfirmBulkDelete(false)
          }}
        >
          <p>
            确定删除已选择的 {selectedCount} 位无关联演员吗？将删除演员档案、头像与写真，不会删除任何影片文件。
          </p>
        </ConfirmModal>
      )}

      {faceScan.state && (
        <ActressFaceScanModal
          progress={faceScan.state.progress}
          summary={faceScan.state.summary}
          onCancel={faceScan.cancel}
          onDone={faceScan.close}
        />
      )}
    </div>
  )
}
