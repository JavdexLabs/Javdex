import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMatch, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, CircleAlert, SearchCheck, SearchX, Trash2, Users } from 'lucide-react'
import { ACTRESS_LIST_DEFAULTS, type ActressAvatarFilter, type ActressListSortBy } from '@shared/actressTypes'
import type { ActressCard } from '@shared/cardProjection'
import { ACTRESS_SCRAPE_FIELD_OPTIONS, ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS, ALL_ACTRESS_SCRAPE_FIELDS, type ActressScrapeField, type ActressScrapeUpdateMode } from '@shared/actressScrapeTypes'
import { api } from '../api'
import { useDebounce } from '../hooks/useDebounce'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import { useRangeSelection } from '../hooks/useRangeSelection'
import { useToast } from '../components/Toast'
import ActressDeleteModal from '../components/ActressDeleteModal'
import AppliedFilterBar, { type AppliedFilterItem } from '../components/AppliedFilterBar'
import ListToolbar from '../components/ListToolbar'
import SelectionToolbar from '../components/SelectionToolbar'
import SortSwitch, { type SortSwitchOption } from '../components/SortSwitch'
import ScrapeFieldsModal from '../components/ScrapeFieldsModal'
import ActressFilterPopover, { type ActressFilterState } from '../components/ActressFilterPopover'
import ActressFaceScanModal from '../components/ActressFaceScanModal'
import { ACTRESS_STATUS_FILTER_LABELS } from '@shared/actressTypes'
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
import { navigateToActressDetail } from '../listView/listNavigation'
import { pendingCenterPath } from '../listView/pendingRoutes'
import { forgetPrimaryListLocation } from '../listView/primaryNavigationMemory'
import { ROUTE_MATCH, ROUTE_PATH } from '../listView/routePaths'
import { useLocation, useNavigate } from 'react-router-dom'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { invalidateActressLibraryQueries } from '../query/invalidateLibraryQueries'
import { actressKeys, overviewStatsKeys } from '../query/queryKeys'
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
  actressIdsWithoutFace,
  uncachedActressFaceScanIdentity
} from '../actressFaceFilter/cache'
import { useActressFaceScan, previousAvatarAfterFaceScan } from '../actressFaceFilter/useActressFaceScan'
import { isActressFaceScanFailed } from '../actressFaceFilter/scanQueue'
import { useAvatarAutoCropBatch } from '../contexts/AvatarAutoCropBatchContext'
import { useInfiniteActressList } from '../query/useInfiniteActressList'
import VirtualActressGrid from '../components/VirtualActressGrid'
import Button from '../components/Button'

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
  const detailOpen = Boolean(useMatch({ path: ROUTE_MATCH.actressDetailOpen, end: false }))

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

  const patchParams = useCallback(
    (patch: Record<string, string | null | undefined>): void => {
      setSearchParams((prev) => patchSearchParams(prev, patch), { replace: true })
    },
    [setSearchParams]
  )

  const [pendingDelete, setPendingDelete] = useState<ActressCard | null>(null)
  const [showBulkScrape, setShowBulkScrape] = useState(false)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
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

  const actressListQuery = useMemo(
    () => {
      const faceResultIds = avatarFilter === 'without-face'
        ? actressIdsWithoutFace(faceScan.manifest, faceScan.cache)
        : undefined
      return {
        search: debouncedQ.trim(),
        gender: genderFilter,
        status: statusFilter,
        avatar: avatarFilter === 'without-face' ? 'all' as const : avatarFilter,
        sortBy,
        sortDir,
        actressIds: faceResultIds
      }
    },
    [
      avatarFilter,
      debouncedQ,
      faceScan.cache,
      faceScan.manifest,
      genderFilter,
      sortBy,
      sortDir,
      statusFilter
    ]
  )
  const handleListError = useCallback(
    (error: unknown) => toast.show(String((error as Error).message ?? error), 'error'),
    [toast]
  )
  const listQuery = useInfiniteActressList(actressListQuery, queryHash, handleListError)
  const conflictSummaryQuery = useQuery({
    queryKey: actressKeys.conflictSummary(),
    queryFn: () => api.actressScrape.conflictSummary(),
    refetchInterval: detailOpen ? false : 3_000
  })
  const pendingConflictCount = conflictSummaryQuery.data?.groupCount ?? 0

  const { stats: overviewStats } = useLibraryOverviewStats()
  const refetchActressSurface = useCallback(() => {
    listQuery.refetchSilent()
    void queryClient.refetchQueries({ queryKey: overviewStatsKeys.all, type: 'active', stale: true })
  }, [listQuery, queryClient])

  useListSurfaceRefetch(detailOpen, refetchActressSurface)

  const items = listQuery.items
  const faceScanMissingIdentity = uncachedActressFaceScanIdentity(
    faceScan.manifest,
    faceScan.cache
  )
  const loading = listQuery.loading
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
    selectingRange,
    selectionError,
    toggleSelection: toggleActressSelection,
    clearSelection
  } = useRangeSelection(items, queryHash, { window: listQuery.window })

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
      faceScanAutoStartedKeyRef.current = faceScan.uncachedIdentity()

      if (summary.cancelled) {
        patchParams({
          [LIST_PARAM.avatar]: actressAvatarParam(previousAvatarAfterFaceScan(previousAvatar))
        })
        toast.show('已取消人脸筛选', 'info')
        return
      }

      if (isActressFaceScanFailed(summary)) {
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
      patchParams,
      toast
    ]
  )

  useEffect(() => {
    if (avatarFilter !== 'without-face') {
      faceScanAutoStartedKeyRef.current = null
      return
    }
    if (faceScan.manifestReady && !faceScan.needsScan && !faceScanMissingIdentity) return
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
    faceScan.manifestReady,
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
            countLabel={selectingRange ? `已选择 ${selectedCount} 位演员 · 正在读取范围…` : `已选择 ${selectedCount} 位演员 · Shift 连选`}
            onClear={clearSelection}
            actions={[
              {
                key: 'scrape',
                label: '刮削元数据',
                icon: <SearchCheck {...UI_ICON_SM} aria-hidden />,
                disabled: selectingRange || anyBatchActive || !defaultScraper,
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
                disabled: selectingRange || selectedCount === 0,
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
                  <Button
                    type="button"

                    size="sm"
                    className="actress-conflict-entry"
                    onClick={() => navigate(pendingCenterPath({ type: 'actress' }))}
                  >
                    <CircleAlert {...UI_ICON_SM} aria-hidden />
                    待确认 {pendingConflictCount}
                  </Button>
                ) : null}
                <div className="library-filter-anchor">
                  <Button
                    ref={filterBtnRef}
                    type="button"

                    size="sm"
                    className={`library-filter-btn${filterOpen ? ' library-filter-btn--open' : ''}${hasAppliedFilters ? ' library-filter-btn--active' : ''}`}
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
                  </Button>
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
                共 {listQuery.total} 位
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

      {selectionError && <div role="alert">{selectionError}</div>}
      <ListSurface variant="fill" withInner={false}>
          {loading ? (
            <EmptyState loading variant="page" />
          ) : listQuery.error && listQuery.total === 0 ? (
            <EmptyState title="演员列表加载失败">
              <Button onClick={listQuery.retry}>重试</Button>
            </EmptyState>
          ) : listQuery.total === 0 ? (
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
            <VirtualActressGrid catalogWindow={listQuery.window}
              actresses={items}
              selectedIds={selectedIds}
              selectionMode={selectionMode}
              hasMore={listQuery.hasMore}
              loadingMore={listQuery.loadingMore}
              loadMoreFailed={listQuery.nextPageError}
              onLoadMore={listQuery.loadMore}
              onRetryLoadMore={listQuery.retryLoadMore}
              onToggleSelect={toggleActressSelection}
              onOpen={(actress) => navigateToActressDetail(navigate, location, actress.id)}
              onDelete={setPendingDelete}
              scrollMemoryKey={scrollMemoryKey}
            />
          )}
      </ListSurface>

      {pendingDelete && (
        <ActressDeleteModal
          ids={[pendingDelete.id]}
          subjectLabel={`演员「${pendingDelete.main_name}」`}
          onCancel={() => setPendingDelete(null)}
          onDeleted={(result) => {
            const name = pendingDelete.main_name
            setPendingDelete(null)
            toast.show(`已删除「${name}」`, 'success')
            if (result.cleanupFailures.length > 0) {
              const first = result.cleanupFailures[0]
              toast.show(
                `${result.cleanupFailures.length} 个演员资源清理失败：${first.path}（${first.error}）`,
                'info'
              )
            }
            void invalidateActressLibraryQueries(queryClient)
            listQuery.refetchSilent()
          }}
        />
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
        <ActressDeleteModal
          ids={[...selectedIds]}
          subjectLabel={`已选择的 ${selectedCount} 位演员`}
          onCancel={() => setConfirmBulkDelete(false)}
          onDeleted={(result) => {
            setConfirmBulkDelete(false)
            clearSelection()
            toast.show(
              `已删除 ${result.deletedCount} 位演员${
                result.unlinkedVideoCount > 0
                  ? `，并解除 ${result.unlinkedVideoCount} 部影片的演员关联`
                  : ''
              }`,
              'success'
            )
            if (result.cleanupFailures.length > 0) {
              const first = result.cleanupFailures[0]
              toast.show(
                `${result.cleanupFailures.length} 个演员资源清理失败：${first.path}（${first.error}）`,
                'info'
              )
            }
            void invalidateActressLibraryQueries(queryClient)
            refetchActressSurface()
          }}
        />
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
