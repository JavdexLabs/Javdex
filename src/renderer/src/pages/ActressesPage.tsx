import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMatch, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ACTRESS_LIST_DEFAULTS, type ActressListItem, type ActressListSortBy } from '@shared/types'
import { api, assetUrl } from '../api'
import { useDebounce } from '../hooks/useDebounce'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import ScrollToTopButton from '../components/ScrollToTopButton'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import { useToast } from '../components/Toast'
import ConfirmModal from '../components/ConfirmModal'
import ActressName from '../components/ActressName'
import AppliedFilterBar, { type AppliedFilterItem } from '../components/AppliedFilterBar'
import ListToolbar from '../components/ListToolbar'
import SortSwitch, { type SortSwitchOption } from '../components/SortSwitch'
import {
  actressQueryHash,
  LIST_PARAM,
  parseActressSort,
  parseGender,
  patchSearchParams
} from '../listView/listQueryParams'
import { navigateToActressDetail } from '../listView/listNavigation'
import { ROUTE_MATCH } from '../listView/routePaths'
import { useLocation, useNavigate } from 'react-router-dom'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { invalidateActressLibraryQueries } from '../query/invalidateLibraryQueries'
import { actressKeys, overviewStatsKeys } from '../query/queryKeys'
import ActressAvatar from '../components/ActressAvatar'
import MediaTileDeleteButton from '../components/MediaTileDeleteButton'
import { useScraperPluginCatalog } from '../hooks/useScraperPluginCatalog'
import { useLibraryOverviewStats } from '../hooks/useLibraryOverviewStats'
import { useBatchScrapeActivity } from '../hooks/useBatchScrapeActivity'
import ListMaintenanceBanner from '../components/ListMaintenanceBanner'
import { startDefaultUnscrapedActressBatch } from '../utils/defaultBatchScrape'
import {
  dismissMaintenanceHint,
  isMaintenanceHintDismissed,
  MAINTENANCE_HINT_KEYS
} from '../utils/maintenanceHints'
import { settingsPath } from '../settings/settingsRoutes'

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

  const dismissOverlays = useCallback(() => {
    setPendingDelete(null)
  }, [])

  useDismissOverlaysOnNavigate(dismissOverlays, location.pathname)

  const listQuery = useQuery({
    queryKey: actressKeys.list(queryHash, debouncedQ.trim(), genderFilter, sortBy, sortDir),
    queryFn: () => api.actresses.list(debouncedQ.trim(), genderFilter, sortBy, sortDir),
    placeholderData: (prev) => prev
  })

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

  const items = listQuery.data ?? []
  const loading = listQuery.isLoading && items.length === 0
  const isFetching = listQuery.isFetching

  const { defaultScraper } = useScraperPluginCatalog('actress')
  const [unscrapedBannerHidden, setUnscrapedBannerHidden] = useState(() =>
    isMaintenanceHintDismissed(MAINTENANCE_HINT_KEYS.actressBanner)
  )
  const { actressBatchActive } = useBatchScrapeActivity()
  const unscrapedCount = overviewStats?.actresses.unscraped ?? 0
  const showUnscrapedBanner =
    !unscrapedBannerHidden && genderFilter === 'female' && unscrapedCount > 0

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

  const hasNonDefaultSort =
    sortBy !== ACTRESS_LIST_DEFAULTS.sortBy || sortDir !== ACTRESS_LIST_DEFAULTS.sortDir
  const hasAppliedFilters = genderFilter !== ACTRESS_LIST_DEFAULTS.gender || hasNonDefaultSort
  const resetFilters = (): void => {
    patchParams({
      [LIST_PARAM.gender]: null,
      [LIST_PARAM.sort]: null,
      [LIST_PARAM.dir]: null
    })
  }
  const appliedFilters: AppliedFilterItem[] = []
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

  return (
    <div className="list-page">
      <div className="topbar library-header">
        <ListToolbar
          search={{
            value: searchInput,
            placeholder: '搜索演员名或别名…',
            ariaLabel: '搜索演员',
            onChange: setSearchInput
          }}
          controls={
            <>
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
            <span className="count-badge count-badge--stable count-badge--people" aria-live="polite">
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

        {hasAppliedFilters && (
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
            secondaryLabel="前往设置"
            primaryLabel={actressBatchActive ? '刮削进行中…' : '一键刮削'}
            onSecondary={() => navigate(settingsPath('overview', 'status'))}
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

      <div className="list-scroll-region">
        <div ref={scrollRef} className="scroll-body scroll-body--scroll">
        <div className="scroll-body-inner">
          {loading ? (
            <div className="empty-state">
              <div className="spinner" />
            </div>
          ) : items.length === 0 ? (
            <div className="empty-state">
              <div className="big">☻</div>
              <div>暂无演员数据，刮削影片后将自动归纳演员。</div>
            </div>
          ) : (
            <div className="actress-grid">
              {items.map((a) => {
                const avatar = assetUrl(a.avatar_path)
                return (
                  <div key={a.id} className="actress-card-wrap">
                    <button
                      type="button"
                      className="actress-card card-interactive"
                      onClick={() => navigateToActressDetail(navigate, location, a.id)}
                    >
                      <ActressAvatar src={avatar} name={a.main_name} gender={a.gender} />
                      <ActressName name={a.main_name} gender={a.gender} className="actress-name" />
                      <div className="actress-count">{a.video_count} 部</div>
                    </button>
                    {a.video_count === 0 && (
                      <MediaTileDeleteButton
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
        </div>
        </div>
        <ScrollToTopButton visible={showScrollToTop} onClick={scrollToTop} />
      </div>

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
    </div>
  )
}
