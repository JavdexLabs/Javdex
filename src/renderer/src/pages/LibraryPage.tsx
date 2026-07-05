import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMatch, useLocation, useSearchParams } from 'react-router-dom'
import type {
  Video,
  VideoDetail,
  VideoEditInput,
  VideoQuery,
  VideoScrapeField,
  VideoScrapeUpdateMode
} from '@shared/types'
import {
  ALL_VIDEO_SCRAPE_FIELDS,
  VIDEO_SCRAPE_FIELD_OPTIONS,
  VIDEO_SCRAPE_UPDATE_MODE_OPTIONS
} from '@shared/types'
import { api } from '../api'
import { useDebounce } from '../hooks/useDebounce'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import { useToast } from '../components/Toast'
import VirtualPosterGrid from '../components/VirtualPosterGrid'
import { useDisplayMode } from '../components/DisplayModeContext'
import AppliedFilterBar, { type AppliedFilterItem } from '../components/AppliedFilterBar'
import LibraryFilterPopover, { type LibraryFilterState } from '../components/LibraryFilterPopover'
import ListToolbar from '../components/ListToolbar'
import AddToPlaylistModal from '../components/AddToPlaylistModal'
import AddVideosToPlaylistModal from '../components/AddVideosToPlaylistModal'
import EditMetadataModal from '../components/EditMetadataModal'
import Modal from '../components/Modal'
import ScrapeFieldsModal from '../components/ScrapeFieldsModal'
import SortSwitch, { type SortSwitchOption } from '../components/SortSwitch'
import {
  LIBRARY_DEFAULTS,
  LIST_PARAM,
  libraryQueryHash,
  libraryVideoQueryFromSearchParams,
  parseScrapedStatus,
  parseSort,
  parseTagIds,
  parseYear,
  patchSearchParams
} from '../listView/listQueryParams'
import { ROUTE_MATCH } from '../listView/routePaths'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { useScraperPluginCatalog } from '../hooks/useScraperPluginCatalog'
import { useInfiniteVideoList } from '../query/useInfiniteVideoList'
import { invalidateVideoLibraryQueries } from '../query/invalidateLibraryQueries'
import { useLibraryOverviewStats } from '../hooks/useLibraryOverviewStats'
import { useBatchScrapeActivity } from '../hooks/useBatchScrapeActivity'
import ListMaintenanceBanner from '../components/ListMaintenanceBanner'
import { startDefaultUnscrapedVideoBatch } from '../utils/defaultBatchScrape'
import {
  dismissMaintenanceHint,
  isMaintenanceHintDismissed,
  MAINTENANCE_HINT_KEYS
} from '../utils/maintenanceHints'

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

export default function LibraryPage(): JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToast()
  const { mode, setMode } = useDisplayMode()
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const filterBtnRef = useRef<HTMLButtonElement>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const detailOpen = Boolean(useMatch({ path: ROUTE_MATCH.libraryDetailOpen, end: false }))
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const [playlistTarget, setPlaylistTarget] = useState<Video | null>(null)
  const [showBulkPlaylist, setShowBulkPlaylist] = useState(false)
  const [editingVideo, setEditingVideo] = useState<VideoDetail | null>(null)
  const [editLoadingId, setEditLoadingId] = useState<number | null>(null)
  const [scrapeTarget, setScrapeTarget] = useState<Video | null>(null)
  const [showBulkScrape, setShowBulkScrape] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Video | null>(null)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const { scrapers, pluginDetails, defaultScraper } = useScraperPluginCatalog('video')
  const [scraperName, setScraperName] = useState('')

  const dismissOverlays = useCallback(() => {
    setFilterOpen(false)
    setPlaylistTarget(null)
    setShowBulkPlaylist(false)
    setEditingVideo(null)
    setEditLoadingId(null)
    setScrapeTarget(null)
    setShowBulkScrape(false)
    setDeleteTarget(null)
    setConfirmBulkDelete(false)
  }, [])

  useDismissOverlaysOnNavigate(dismissOverlays, location.pathname)

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

  const queryHash = useMemo(() => libraryQueryHash(searchParams), [searchParams])
  const scrollMemoryKey = `library:${queryHash}`

  const query = useMemo<VideoQuery>(
    () => libraryVideoQueryFromSearchParams(searchParams),
    [searchParams]
  )

  const { sortBy, sortDir } = parseSort(
    searchParams.get(LIST_PARAM.sort),
    searchParams.get(LIST_PARAM.dir)
  )
  const status = parseScrapedStatus(searchParams.get(LIST_PARAM.status))
  const year = parseYear(searchParams.get(LIST_PARAM.year))
  const tagIds = useMemo(
    () => parseTagIds(searchParams.get(LIST_PARAM.tags)),
    [searchParams]
  )
  const codePrefix = (searchParams.get(LIST_PARAM.prefix) ?? '').trim().toUpperCase()

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
    api.videos.years().then(setYears).catch(() => {})
    refreshTagNames()
  }, [refreshTagNames])

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
    if (defaultScraper) {
      setScraperName((prev) => prev || defaultScraper)
    }
  }, [defaultScraper])

  const filterState: LibraryFilterState = {
    status,
    year,
    codePrefix,
    sortBy,
    sortDir,
    tagIds
  }

  const patchFilters = (patch: Partial<LibraryFilterState>): void => {
    const updates: Record<string, string | null | undefined> = {}
    if (patch.status !== undefined) {
      updates[LIST_PARAM.status] = patch.status === 'all' ? null : String(patch.status)
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
    patchParams(updates)
  }

  const resetFilters = (): void => {
    setSearchParams(
      (prev) =>
        patchSearchParams(prev, {
          [LIST_PARAM.status]: null,
          [LIST_PARAM.year]: null,
          [LIST_PARAM.prefix]: null,
          [LIST_PARAM.tags]: null,
          [LIST_PARAM.sort]: null,
          [LIST_PARAM.dir]: null
        }),
      { replace: true }
    )
  }

  const hasNonDefaultSort =
    sortBy !== LIBRARY_DEFAULTS.sortBy || sortDir !== LIBRARY_DEFAULTS.sortDir
  const hasAppliedFilters =
    status !== 'all' ||
    year !== 'all' ||
    !!codePrefix ||
    tagIds.length > 0 ||
    hasNonDefaultSort

  const handlePageError = useCallback(
    (e: unknown) => toast.show(String((e as Error).message ?? e), 'error'),
    [toast]
  )

  const { videos, total, loading, loadingMore, hasMore, loadMore, isFetching, refetchSilent } =
    useInfiniteVideoList(query, queryHash, handlePageError)

  const { stats: overviewStats, refetch: refetchOverviewStats } = useLibraryOverviewStats()
  const refetchLibrarySurface = useCallback(() => {
    refetchSilent()
    refetchOverviewStats()
  }, [refetchSilent, refetchOverviewStats])

  useListSurfaceRefetch(detailOpen, refetchLibrarySurface)

  useEffect(() => {
    setSelectedIds(new Set())
  }, [queryHash])

  const selectedVideos = useMemo(
    () => videos.filter((video) => selectedIds.has(video.id)),
    [videos, selectedIds]
  )
  const selectedCount = selectedIds.size
  const selectionMode = selectedCount > 0

  const [unscrapedBannerHidden, setUnscrapedBannerHidden] = useState(() =>
    isMaintenanceHintDismissed(MAINTENANCE_HINT_KEYS.videoBanner)
  )
  const { videoBatchActive } = useBatchScrapeActivity()
  const unscrapedCount = overviewStats?.videos.unscraped ?? 0
  const showUnscrapedBanner =
    !unscrapedBannerHidden && !selectionMode && status !== 0 && unscrapedCount > 0

  const dismissUnscrapedBanner = (): void => {
    dismissMaintenanceHint(MAINTENANCE_HINT_KEYS.videoBanner)
    setUnscrapedBannerHidden(true)
  }

  const startUnscrapedBatch = async (): Promise<void> => {
    if (!defaultScraper) {
      toast.show('请先在设置中配置默认影片刮削插件', 'error')
      return
    }
    try {
      await startDefaultUnscrapedVideoBatch(defaultScraper)
      toast.show('已开始批量刮削', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const toggleVideoSelection = useCallback((video: Video): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(video.id)) next.delete(video.id)
      else next.add(video.id)
      return next
    })
  }, [])

  const clearSelection = (): void => setSelectedIds(new Set())

  const openEdit = async (video: Video): Promise<void> => {
    if (editLoadingId !== null) return
    setEditLoadingId(video.id)
    try {
      const detail = await api.videos.get(video.id)
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

  const runSingleScrape = async (
    fields: VideoScrapeField[],
    site: string,
    mode?: VideoScrapeUpdateMode
  ): Promise<void> => {
    if (!scrapeTarget) return
    const target = scrapeTarget
    setScrapeTarget(null)
    setScraperName(site)
    try {
      const res = await api.scrape.one(target.id, site || undefined, fields, mode)
      toast.show(
        res.applied ? `已更新 ${target.code}` : '所选字段无需写入',
        res.applied ? 'success' : 'info'
      )
      if (res.applied) {
        invalidateVideoLibraryQueries(queryClient)
        refetchLibrarySurface()
      }
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
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
      await api.scrape.videoBatchStart({
        status: 'all',
        videoIds,
        fields,
        scraperName: site || undefined,
        mode
      })
      toast.show(`已开始批量刮削 ${videoIds.length} 部影片`, 'success')
      clearSelection()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const deleteVideos = async (targets: Video[]): Promise<void> => {
    if (deleting || targets.length === 0) return
    setDeleting(true)
    let deleted = 0
    let failed = 0
    for (const video of targets) {
      try {
        await api.videos.remove(video.id)
        deleted += 1
      } catch {
        failed += 1
      }
    }
    setDeleting(false)
    setDeleteTarget(null)
    setConfirmBulkDelete(false)
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

  const appliedFilters: AppliedFilterItem[] = []
  if (status !== 'all') {
    appliedFilters.push({
      key: 'status',
      label: STATUS_LABELS[String(status)],
      onRemove: () => patchFilters({ status: 'all' })
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
          [LIST_PARAM.sort]: LIBRARY_DEFAULTS.sortBy,
          [LIST_PARAM.dir]: LIBRARY_DEFAULTS.sortDir
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

  return (
    <div className="list-page">
      <div className="topbar library-header">
        {selectionMode ? (
          <div className="library-selection-toolbar" role="toolbar" aria-label="多选操作">
            <div className="library-selection-count">✓ 已选择 {selectedCount} 部影片</div>
            <div className="library-selection-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setShowBulkPlaylist(true)}
              >
                加入清单
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setShowBulkScrape(true)}
              >
                刮削元数据
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => setConfirmBulkDelete(true)}
              >
                删除影片
              </button>
            </div>
            <button type="button" className="library-selection-clear" onClick={clearSelection}>
              取消全选
            </button>
          </div>
        ) : (
          <ListToolbar
            search={{
              value: searchInput,
              placeholder: '搜索番号、标题或演员（含别名）…',
              ariaLabel: '搜索',
              onChange: setSearchInput
            }}
            controls={
              <>
                <div className="library-filter-anchor">
                  <button
                    ref={filterBtnRef}
                    type="button"
                    className={`btn btn-sm library-filter-btn${filterOpen ? ' library-filter-btn--open' : ''}${hasAppliedFilters ? ' library-filter-btn--active' : ''}`}
                    onClick={() => setFilterOpen((o) => !o)}
                    aria-expanded={filterOpen}
                    aria-haspopup="dialog"
                  >
                    <span className="library-filter-btn-label">筛选</span>
                    <span className={`library-filter-chevron${filterOpen ? ' is-open' : ''}`} aria-hidden>
                      ▾
                    </span>
                  </button>

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

                <div className="mode-toggle" title="封面显示方式" role="group" aria-label="封面显示方式">
                  <button
                    type="button"
                    className={mode === 'portrait' ? 'active' : ''}
                    onClick={() => setMode('portrait')}
                  >
                    竖版
                  </button>
                  <button
                    type="button"
                    className={mode === 'landscape' ? 'active' : ''}
                    onClick={() => setMode('landscape')}
                  >
                    横板
                  </button>
                </div>
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
                ? '批量刮削任务进行中，完成后将自动更新列表。'
                : '可筛选查看后批量补齐元数据与封面。'
            }
            secondaryLabel="查看未刮削"
            primaryLabel={videoBatchActive ? '刮削进行中…' : '一键刮削'}
            onSecondary={() => patchFilters({ status: 0 })}
            onPrimary={() => void startUnscrapedBatch()}
            onDismiss={dismissUnscrapedBanner}
            primaryDisabled={videoBatchActive || !defaultScraper}
            primaryDisabledReason={
              videoBatchActive
                ? '批量刮削任务进行中'
                : !defaultScraper
                  ? '请先在设置中配置默认影片刮削插件'
                  : undefined
            }
          />
        ) : null}
      </div>

      <div className="scroll-body scroll-body--fill">
        {loading ? (
          <div className="scroll-body-inner empty-state">
            <div className="spinner" />
            <div>加载中…</div>
          </div>
        ) : videos.length === 0 ? (
          <div className="scroll-body-inner empty-state">
            <div className="big">▦</div>
            <div>媒体库为空。请前往「设置」添加媒体库路径并扫描导入。</div>
          </div>
        ) : (
          <VirtualPosterGrid
            scrollMemoryKey={scrollMemoryKey}
            videos={videos}
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
            onDelete={setDeleteTarget}
          />
        )}
      </div>

      {playlistTarget && (
        <AddToPlaylistModal
          videoId={playlistTarget.id}
          videoCode={playlistTarget.code}
          onCancel={() => setPlaylistTarget(null)}
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
            void runSingleScrape(fields, site, mode as VideoScrapeUpdateMode | undefined)
          }}
        />
      )}

      {showBulkScrape && (
        <ScrapeFieldsModal
          title="批量刮削元数据"
          hint={`先确定站点与更新方式，再勾选要写入的字段。将只处理已选择的 ${selectedCount} 部影片。`}
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
          danger
          confirmText={deleting ? '删除中…' : '删除'}
          onConfirm={() => {
            if (!deleting) void deleteVideos([deleteTarget])
          }}
          onCancel={() => {
            if (!deleting) setDeleteTarget(null)
          }}
        >
          确定要永久删除「{deleteTarget.code}」吗？将同时删除磁盘上的视频文件、封面及所有元数据，此操作不可恢复。
          {deleteTarget.primary_file_path ? (
            <div className="modal-path-text">{deleteTarget.primary_file_path}</div>
          ) : null}
          {(deleteTarget.file_count ?? 0) > 1 ? (
            <div className="modal-path-hint">另有 {(deleteTarget.file_count ?? 0) - 1} 个关联文件将一并删除</div>
          ) : null}
        </Modal>
      )}

      {confirmBulkDelete && (
        <Modal
          title="批量删除影片"
          danger
          confirmText={deleting ? '删除中…' : '删除'}
          onConfirm={() => {
            if (!deleting) void deleteVideos(selectedVideos)
          }}
          onCancel={() => {
            if (!deleting) setConfirmBulkDelete(false)
          }}
        >
          确定要永久删除已选择的 {selectedCount} 部影片吗？将同时删除磁盘上的视频文件、封面及所有元数据，此操作不可恢复。
        </Modal>
      )}
    </div>
  )
}
