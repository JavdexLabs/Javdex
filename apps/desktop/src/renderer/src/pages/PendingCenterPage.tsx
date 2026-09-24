import type { PendingScanQueueItem, PendingScanQueueQuery } from '@shared/libraryTypes'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, ListChecks, ScanSearch, UsersRound } from 'lucide-react'
import { useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import { api, resolveMediaSrc } from '../api'
import EmptyState from '../components/EmptyState'
import Button from '../components/Button'
import SelectControl from '../components/SelectControl'
import { UI_ICON_SM } from '../components/iconDefaults'
import {
  WorkbenchMain,
  WorkbenchRail,
  WorkbenchShell,
  WorkbenchTabs
} from '../components/workbench'
import {
  formatPendingItemKey,
  parsePendingCenterSearch,
  pendingCenterPath,
  pendingItemKey,
  samePendingItemKey,
  type PendingDomain,
  type PendingItemKey,
  type PendingTypeFilter
} from '../listView/pendingRoutes'
import { ROUTE_MATCH } from '../listView/routePaths'
import { invalidateVideoLibraryQueries } from '../query/invalidateLibraryQueries'
import { actressKeys, mediaLibraryKeys } from '../query/queryKeys'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import PendingActressConflictPane from './PendingActressConflictPane'
import PendingScanPane from './PendingScanPane'
import PendingResourceIdentityPane from './PendingResourceIdentityPane'
import PendingScrapePane from './PendingScrapePane'
import styles from './PendingCenterPage.module.css'
import {
  PENDING_DOMAIN_LABEL,
  buildPendingQueueSections,
  resolvePendingSelection
} from './pendingCenterState'
import { useConflictReviewController } from './useConflictReviewController'

const DOMAIN_ICON: Record<PendingDomain, JSX.Element> = {
  scan: <ScanSearch {...UI_ICON_SM} aria-hidden />,
  scrape: <CircleAlert {...UI_ICON_SM} aria-hidden />,
  actress: <UsersRound {...UI_ICON_SM} aria-hidden />
}

const FILTER_ORDER: PendingTypeFilter[] = ['all', 'scan', 'scrape', 'actress']

export default function PendingCenterPage(): JSX.Element {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const videoDetailOpen = Boolean(useMatch({ path: ROUTE_MATCH.pendingVideoStack, end: false }))
  const actressDetailOpen = Boolean(useMatch({ path: ROUTE_MATCH.pendingActressDetail, end: true }))
  const detailOpen = videoDetailOpen || actressDetailOpen
  const [params] = useSearchParams()
  const {
    type,
    item: urlItem,
    videoId: videoFromUrl,
    scrapeOffset,
    scanOffset,
    actressOffset,
    queueDomain,
    libraryId: requestedLibraryId
  } = parsePendingCenterSearch(params)

  const librariesQuery = useQuery({
    queryKey: mediaLibraryKeys.activeList(),
    queryFn: () => api.mediaLibraries.list()
  })
  const libraryIds = (librariesQuery.data ?? []).map((library) => library.id)
  const selectedLibraryId =
    type === 'scan' && requestedLibraryId != null && libraryIds.includes(requestedLibraryId)
      ? requestedLibraryId
      : null
  const libraryNames = new Map(
    (librariesQuery.data ?? []).map((library) => [library.id, library.name])
  )

  const scanEnabled = (type === 'all' || type === 'scan') && !detailOpen
  const scanAnchorId = urlItem?.domain === 'scan'
    ? Number(urlItem.id.replace(/^identity-/, '')) : NaN
  const scanPageQuery: PendingScanQueueQuery = {
    limit: 50, offset: scanOffset, libraryId: selectedLibraryId ?? undefined,
    anchor: Number.isSafeInteger(scanAnchorId) && scanAnchorId > 0
      ? { kind: urlItem!.id.startsWith('identity-') ? 'identity' : 'group', id: scanAnchorId }
      : undefined
  }
  const scanQuery = useQuery({
    queryKey: ['pending-scan-groups', 'page', scanPageQuery],
    queryFn: () => api.scan.pagePendingQueue(scanPageQuery),
    enabled: librariesQuery.isSuccess && scanEnabled, gcTime: 0
  })
  const scanCountQuery = useQuery({
    queryKey: ['pending-scan-groups', 'count'],
    queryFn: () => api.scan.countPendingQueue(),
    enabled: !scanEnabled && !detailOpen
  })
  const scrapeEnabled = (type === 'all' || type === 'scrape') && !detailOpen
  const scrapeAnchor = urlItem?.domain === 'scrape' && Number.isSafeInteger(Number(urlItem.id)) && Number(urlItem.id) > 0
    ? Number(urlItem.id) : undefined
  const scrapePageQuery = {
    limit: 50, offset: scrapeOffset,
    ...(videoFromUrl != null ? { videoId: videoFromUrl } : { anchorId: scrapeAnchor })
  }
  const scrapeQuery = useQuery({
    queryKey: ['pending-video-scrapes', 'page', scrapePageQuery],
    queryFn: () => api.scrape.pagePending(scrapePageQuery),
    enabled: scrapeEnabled,
    gcTime: 0
  })
  const scrapeCountQuery = useQuery({
    queryKey: ['pending-video-scrape-count'],
    queryFn: () => api.scrape.countPending(),
    enabled: !scrapeEnabled && !detailOpen
  })
  const actressEnabled = (type === 'all' || type === 'actress') && !detailOpen
  const actressPageQuery = {
    limit: 50, offset: actressOffset,
    anchorName: urlItem?.domain === 'actress' ? urlItem.id : undefined
  }
  const actressQuery = useQuery({
    queryKey: [...actressKeys.conflicts(), 'page', actressPageQuery],
    queryFn: () => api.actressScrape.pageConflicts(actressPageQuery),
    enabled: actressEnabled, gcTime: 0
  })
  const actressSummaryQuery = useQuery({
    queryKey: actressKeys.conflictSummary(),
    queryFn: () => api.actressScrape.conflictSummary(),
    enabled: !actressEnabled && !detailOpen
  })

  const scanItems = scanQuery.data?.items ?? []
  const scanTotal = scanEnabled ? scanQuery.data?.total ?? 0 : scanCountQuery.data ?? 0
  const scrapeItems = scrapeQuery.data?.items ?? []
  const scrapeTotal = scrapeEnabled ? scrapeQuery.data?.total ?? 0 : scrapeCountQuery.data ?? 0
  const conflictItems = actressQuery.data?.items ?? []
  const actressTotal = actressEnabled ? actressQuery.data?.total ?? 0 : actressSummaryQuery.data?.groupCount ?? 0
  const queueInput = {
    scanItems,
    scrapeItems,
    conflictItems,
    libraryNames
  }
  const sections = buildPendingQueueSections(queueInput, type)
  const counts: Record<PendingTypeFilter, number> = {
    all:
      scanTotal + scrapeTotal + actressTotal,
    scan: scanTotal,
    scrape: scrapeTotal,
    actress: actressTotal
  }

  // A video deep link wins over the stored item so "查看待确认候选" always lands right.
  const deepLinked = videoFromUrl == null
    ? null
    : scrapeItems.find((entry) => entry.videoId === videoFromUrl)
  const requested = deepLinked ? pendingItemKey('scrape', deepLinked.id) : urlItem
  const selected = resolvePendingSelection(sections, requested, queueDomain ?? requested?.domain)

  const loading =
    (scanEnabled && librariesQuery.isLoading) ||
    (scanEnabled && scanQuery.isLoading) ||
    (scrapeEnabled && scrapeQuery.isLoading) ||
    (actressEnabled && actressQuery.isLoading)
  const total = counts[type]
  const scanError = scanEnabled && (librariesQuery.isError || scanQuery.isError)
  const actressError = actressEnabled && actressQuery.isError
  const scrapeError = scrapeEnabled && scrapeQuery.isError

  const selectItem = useCallback(
    (key: PendingItemKey, replace = false) => {
      navigate(
        pendingCenterPath({
          type,
          item: key,
          libraryId: selectedLibraryId ?? undefined,
          actressOffset: actressQuery.data?.offset ?? actressOffset,
          scanOffset: scanQuery.data?.offset ?? scanOffset,
          scrapeOffset: scrapeQuery.data?.offset ?? scrapeOffset
        }),
        { replace }
      )
    },
    [navigate, selectedLibraryId, type, actressQuery.data?.offset, actressOffset, scanQuery.data?.offset, scanOffset, scrapeQuery.data?.offset, scrapeOffset]
  )

  const canonicalOffsets = (!scanEnabled || (scanQuery.data?.offset ?? scanOffset) === scanOffset) &&
    (!scrapeEnabled || (scrapeQuery.data?.offset ?? scrapeOffset) === scrapeOffset) &&
    (!actressEnabled || (actressQuery.data?.offset ?? actressOffset) === actressOffset)

  // Canonicalize deep links and actual page offsets before requesting selected details.
  useEffect(() => {
    if (loading || actressError || scanError || scrapeError || detailOpen || !selected) return
    if (videoFromUrl == null && samePendingItemKey(selected, urlItem) && canonicalOffsets) return
    selectItem(selected, true)
  }, [loading, actressError, scanError, scrapeError, detailOpen, selected, urlItem, videoFromUrl, canonicalOffsets, selectItem])

  const actorIntent = useRef(false)
  actorIntent.current = actressEnabled && (urlItem?.domain === 'actress' ||
    (!urlItem && (queueDomain === 'actress' || type === 'actress')))
  const actorPageEnabled = useRef(actressEnabled)
  actorPageEnabled.current = actressEnabled
  const [actorFocusRequest, setActorFocusRequest] = useState(0)
  const actorFocusHandled = useRef(0)
  const actorPageRefetch = useRef(actressQuery.refetch)
  actorPageRefetch.current = actressQuery.refetch
  const onActorResolved = useCallback(async (): Promise<void> => {
    if (!actorPageEnabled.current) return
    await actorPageRefetch.current()
    // Refetch may resolve before React removes the old confirmation control.
    // Decide whether focus was lost after the canonical page has committed.
    if (actorIntent.current) {
      setActorFocusRequest(request => request + 1)
    }
  }, [])
  const conflict = useConflictReviewController({
    enabled: actressEnabled, summaryEnabled: false,
    paged: {
      sessionKey: JSON.stringify([type, urlItem?.domain, urlItem?.id]),
      selectedName: selected?.domain === 'actress' && samePendingItemKey(selected, urlItem) && videoFromUrl == null && canonicalOffsets
        ? selected.id : null,
      onResolved: onActorResolved
    }
  })

  const railButtons = useRef(new Map<string, HTMLButtonElement>())
  const { focusAfterRefresh } = conflict.queue
  const focusHandledRef = useRef(conflict.queue.focusHandled)
  focusHandledRef.current = conflict.queue.focusHandled
  useEffect(() => {
    if (focusAfterRefresh === undefined) return
    if (focusAfterRefresh && document.activeElement === document.body) {
      railButtons.current
        .get(formatPendingItemKey(pendingItemKey('actress', focusAfterRefresh)))
        ?.focus()
    }
    focusHandledRef.current()
  }, [focusAfterRefresh])

  useEffect(() => {
    if (actorFocusRequest === actorFocusHandled.current) return
    if (!actorIntent.current) { actorFocusHandled.current = actorFocusRequest; return }
    if (loading || actressError || detailOpen || selected?.domain !== 'actress' ||
        !samePendingItemKey(selected, urlItem) || !canonicalOffsets) return
    const button = railButtons.current.get(formatPendingItemKey(selected))
    if (button) {
      if (document.activeElement === document.body) button.focus()
      actorFocusHandled.current = actorFocusRequest
    }
  }, [actorFocusRequest, loading, actressError, detailOpen, selected, urlItem, canonicalOffsets])

  const refetchPendingSurface = useCallback((): void => {
    void Promise.all([
      queryClient.refetchQueries({ queryKey: ['pending-scan-groups'], type: 'active', exact: false }),
      queryClient.refetchQueries({ queryKey: ['pending-video-scrapes'], type: 'active', exact: false }),
      queryClient.refetchQueries({ queryKey: ['pending-video-scrape-count'], exact: true }),
      queryClient.refetchQueries({ queryKey: actressKeys.conflicts(), type: 'active', exact: false }),
      queryClient.refetchQueries({ queryKey: actressKeys.conflictSummary(), exact: true })
    ])
  }, [queryClient])

  useListSurfaceRefetch(detailOpen, refetchPendingSurface)

  const refresh = (): void => {
    invalidateVideoLibraryQueries(queryClient)
    refetchPendingSurface()
  }

  const selectedScan = selected?.domain === 'scan'
    ? scanItems.find((entry) => (entry.kind === 'group' ? String(entry.id) : `identity-${entry.id}`) === selected.id) ?? null
    : null
  const selectedScrape =
    selected?.domain === 'scrape'
      ? scrapeItems.find((entry) => String(entry.id) === selected.id) ?? null
      : null

  return (
    <div className={`list-page ${styles.page}`}>
      <header className={styles.topbar}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>待确认</h1>
          <span className={styles.count}>{loading ? '读取中…' : `${total} 项待处理`}</span>
        </div>
        <div className={styles.filterRow}>
          <WorkbenchTabs
            id="pending-types"
            label="待确认分类"
            value={type}
            className={styles.typeFilter}
            items={FILTER_ORDER.map((option) => ({
              id: option,
              panelId: 'pending-results',
              label: (
                <span className={styles.tabLabel}>
                  {option === 'all' ? <ListChecks {...UI_ICON_SM} aria-hidden /> : DOMAIN_ICON[option]}
                  {option === 'all' ? '全部' : PENDING_DOMAIN_LABEL[option]}
                  {option === 'scan' && !scanEnabled && (scanCountQuery.isError || scanCountQuery.data === undefined) ? (
                    <em className={styles.tabCount} title={scanCountQuery.isError ? '扫描数量读取失败' : '正在读取扫描数量'}>{scanCountQuery.isError ? '?' : '…'}</em>
                  ) : option === 'scrape' && !scrapeEnabled && (scrapeCountQuery.isError || scrapeCountQuery.data === undefined) ? (
                    <em className={styles.tabCount} title={scrapeCountQuery.isError ? '刮削数量读取失败' : '正在读取刮削数量'}>{scrapeCountQuery.isError ? '?' : '…'}</em>
                  ) : option === 'actress' && !actressEnabled && (actressSummaryQuery.isError || actressSummaryQuery.data === undefined) ? (
                    <em className={styles.tabCount} title={actressSummaryQuery.isError ? '演员冲突数量读取失败' : '正在读取演员冲突数量'}>{actressSummaryQuery.isError ? '?' : '…'}</em>
                  ) : !loading && counts[option] > 0 ? <em className={styles.tabCount}>{counts[option]}</em> : null}
                </span>
              )
            }))}
            onChange={(option) => navigate(pendingCenterPath({
              type: option,
              libraryId: option === 'scan' ? selectedLibraryId ?? undefined : undefined
            }))}
          />
          {type === 'scan' ? (
            <div className={styles.libraryFilter}>
              <SelectControl
                aria-label="按媒体库筛选扫描待确认项"
                value={selectedLibraryId ?? ''}
                onChange={(event) => {
                  const nextLibraryId = event.target.value ? Number(event.target.value) : undefined
                  navigate(pendingCenterPath({ type, libraryId: nextLibraryId }))
                }}
              >
                <option value="">所有媒体库</option>
                {(librariesQuery.data ?? []).map((library) => (
                  <option key={library.id} value={library.id}>{library.name}</option>
                ))}
              </SelectControl>
            </div>
          ) : null}
        </div>
      </header>
      <div
        className="scroll-body scroll-body--fill"
        id="pending-results"
        role="tabpanel"
        aria-labelledby={`pending-types-${type}`}
        tabIndex={0}
      >
        <WorkbenchShell className={styles.shell}>
          {loading ? (
            <EmptyState variant="fill" loading title="正在读取待确认项…" />
          ) : scanError ? (
            <EmptyState variant="fill" title="待确认扫描读取失败">
              <Button onClick={() => { void (librariesQuery.isError ? librariesQuery.refetch() : scanQuery.refetch()) }}>重试</Button>
            </EmptyState>
          ) : scrapeError ? (
            <EmptyState variant="fill" title="待确认刮削读取失败">
              <Button onClick={() => { void scrapeQuery.refetch() }}>重试</Button>
            </EmptyState>
          ) : actressError ? (
            <EmptyState variant="fill" title="演员冲突队列读取失败">
              <Button onClick={() => { void actressQuery.refetch() }}>重试</Button>
            </EmptyState>
          ) : total === 0 ? (
            <div className={styles.complete}>
              <EmptyState
                variant="fill"
                title={type === 'scan' && selectedLibraryId != null
                  ? '此媒体库没有扫描待确认项'
                  : type === 'all' ? '没有待确认项' : `没有${PENDING_DOMAIN_LABEL[type]}待确认项`}
                description={type === 'scan'
                  ? '扫描中需要确认的番号或资源归属会显示在这里。'
                  : type === 'scrape'
                    ? '刮削中需要你选择的影片候选会显示在这里。'
                    : type === 'actress'
                      ? '需要核对的演员名称冲突会显示在这里。'
                      : '扫描和刮削中需要你确认的结果会自动出现在这里。'}
              >
                {type === 'scan' && selectedLibraryId != null ? (
                  <Button size="sm" onClick={() => navigate(pendingCenterPath({ type: 'scan' }))}>
                    查看所有媒体库
                  </Button>
                ) : null}
              </EmptyState>
            </div>
          ) : (
            <WorkbenchMain className={styles.main}>
              <WorkbenchRail aria-label="待确认队列">
                <div className={styles.railList}>
                  {sections.map((section) => (
                    <section className={styles.railSection} key={section.domain}>
                      <h2>
                        {section.label}
                        <span className={styles.railCount}>{section.domain === 'scrape' ? scrapeTotal : section.domain === 'scan' ? scanTotal : actressTotal}</span>
                      </h2>
                      {section.items.map((queueItem) => {
                        const keyText = formatPendingItemKey(queueItem.key)
                        const thumb = resolveMediaSrc(queueItem.coverPath)
                        return (
                          <button
                            key={keyText}
                            ref={(button) => {
                              if (button) railButtons.current.set(keyText, button)
                              else railButtons.current.delete(keyText)
                            }}
                            type="button"
                            className={styles.railItem}
                            aria-current={samePendingItemKey(queueItem.key, selected)}
                            data-thumb={thumb ? 'true' : undefined}
                            onClick={() => selectItem(queueItem.key)}
                          >
                            {thumb ? (
                              <img
                                className={styles.railThumb}
                                data-avatar={section.domain === 'actress' ? 'true' : undefined}
                                src={thumb}
                                alt=""
                                draggable={false}
                              />
                            ) : null}
                            <strong
                              className={styles.railTitle}
                              data-ready={queueItem.ready ? 'true' : undefined}
                            >
                              {queueItem.title}
                            </strong>
                            <span className={styles.railMeta}>{queueItem.meta}</span>
                          </button>
                        )
                      })}
                      {section.domain === 'scan' && scanTotal > 50 ? (
                        <div className={styles.queuePager} aria-label="扫描队列分页">
                          <Button size="sm" disabled={!scanQuery.data?.offset} onClick={() => navigate(pendingCenterPath({
                            type, queueDomain: 'scan', libraryId: selectedLibraryId ?? undefined, scrapeOffset, actressOffset,
                            scanOffset: Math.max(0, (scanQuery.data?.offset ?? 0) - 50)
                          }))}>上一页</Button>
                          <span>{Math.floor((scanQuery.data?.offset ?? 0) / 50) + 1} / {Math.ceil(scanTotal / 50)}</span>
                          <Button size="sm" disabled={(scanQuery.data?.offset ?? 0) + 50 >= scanTotal} onClick={() => navigate(pendingCenterPath({
                            type, queueDomain: 'scan', libraryId: selectedLibraryId ?? undefined, scrapeOffset, actressOffset,
                            scanOffset: (scanQuery.data?.offset ?? 0) + 50
                          }))}>下一页</Button>
                        </div>
                      ) : null}
                      {section.domain === 'actress' && actressTotal > 50 ? (
                        <div className={styles.queuePager} aria-label="演员冲突队列分页">
                          <Button size="sm" disabled={!actressQuery.data?.offset} onClick={() => navigate(pendingCenterPath({
                            type, queueDomain: 'actress', scanOffset, scrapeOffset,
                            actressOffset: Math.max(0, (actressQuery.data?.offset ?? 0) - 50)
                          }))}>上一页</Button>
                          <span>{Math.floor((actressQuery.data?.offset ?? 0) / 50) + 1} / {Math.ceil(actressTotal / 50)}</span>
                          <Button size="sm" disabled={(actressQuery.data?.offset ?? 0) + 50 >= actressTotal} onClick={() => navigate(pendingCenterPath({
                            type, queueDomain: 'actress', scanOffset, scrapeOffset, actressOffset: (actressQuery.data?.offset ?? 0) + 50
                          }))}>下一页</Button>
                        </div>
                      ) : null}
                      {section.domain === 'scrape' && scrapeTotal > 50 ? (
                        <div className={styles.queuePager} aria-label="刮削队列分页">
                          <Button size="sm" disabled={!scrapeQuery.data?.offset} onClick={() => navigate(pendingCenterPath({
                            type, queueDomain: 'scrape', scanOffset, actressOffset, scrapeOffset: Math.max(0, (scrapeQuery.data?.offset ?? 0) - 50)
                          }))}>上一页</Button>
                          <span>{Math.floor((scrapeQuery.data?.offset ?? 0) / 50) + 1} / {Math.ceil(scrapeTotal / 50)}</span>
                          <Button size="sm" disabled={(scrapeQuery.data?.offset ?? 0) + 50 >= scrapeTotal} onClick={() => navigate(pendingCenterPath({
                            type, queueDomain: 'scrape', scanOffset, actressOffset, scrapeOffset: (scrapeQuery.data?.offset ?? 0) + 50
                          }))}>下一页</Button>
                        </div>
                      ) : null}
                    </section>
                  ))}
                </div>
              </WorkbenchRail>
              {selectedScan && samePendingItemKey(selected, urlItem) && canonicalOffsets ? (
                <PendingScanDetail key={`${selectedScan.kind}:${selectedScan.libraryId}:${selectedScan.id}:${selectedScan.revision}`}
                  item={selectedScan} libraryName={libraryNames.get(selectedScan.libraryId)} enabled={!detailOpen} onResolved={refresh} />
              ) : selectedScrape && videoFromUrl == null && samePendingItemKey(selected, urlItem) && canonicalOffsets ? (
                <PendingScrapeDetail key={`${selectedScrape.id}:${selectedScrape.revision}`} id={selectedScrape.id} revision={selectedScrape.revision} enabled={!detailOpen} onResolved={refresh} />
              ) : selected?.domain === 'actress' && samePendingItemKey(selected, urlItem) ? (
                conflict.queue.error ? <EmptyState variant="fill" title="演员冲突详情读取失败"><Button onClick={conflict.queue.retry}>重试</Button></EmptyState>
                  : conflict.queue.loading ? <EmptyState variant="fill" loading title="正在读取演员冲突详情…" />
                  : conflict.queue.selectedGroup?.normalizedName !== selected.id ? <EmptyState variant="fill" title="此待确认项已不存在"><Button onClick={refresh}>刷新队列</Button></EmptyState>
                  : <PendingActressConflictPane vm={conflict} />
              ) : (
                <EmptyState variant="fill" title="请选择一项待确认" />
              )}
            </WorkbenchMain>
          )}
        </WorkbenchShell>
      </div>
    </div>
  )
}


function PendingScrapeDetail({ id, revision, enabled, onResolved }: {
  id: number; revision: number; enabled: boolean; onResolved: () => void
}): JSX.Element {
  const query = useQuery({
    queryKey: ['pending-video-scrapes', 'detail', id, revision],
    queryFn: () => api.scrape.getPending(id), enabled, gcTime: 0
  })
  if (query.isError) return <EmptyState variant="fill" title="候选读取失败"><Button onClick={() => { void query.refetch() }}>重试</Button></EmptyState>
  if (!query.data) return <EmptyState variant="fill" loading={query.isLoading} title={query.isLoading ? '正在读取候选…' : '此待确认项已不存在'}>
    {!query.isLoading ? <Button onClick={onResolved}>刷新队列</Button> : null}
  </EmptyState>
  return <PendingScrapePane pending={query.data} onResolved={onResolved} />
}

function PendingScanDetail({ item, libraryName, enabled, onResolved }: {
  item: PendingScanQueueItem; libraryName?: string; enabled: boolean; onResolved: () => void
}): JSX.Element {
  const query = useQuery({
    queryKey: ['pending-scan-groups', 'detail', item.kind, item.libraryId, item.id, item.revision],
    queryFn: async () => item.kind === 'group'
      ? { kind: 'group' as const, value: await api.scan.getPendingGroup(item.libraryId, item.id) }
      : { kind: 'identity' as const, value: await api.scan.getPendingIdentity(item.libraryId, item.id) },
    enabled, gcTime: 0
  })
  if (query.isError) return <EmptyState variant="fill" title="扫描详情读取失败"><Button onClick={() => { void query.refetch() }}>重试</Button></EmptyState>
  if (!query.data?.value) return <EmptyState variant="fill" loading={query.isLoading} title={query.isLoading ? '正在读取扫描详情…' : '此待确认项已不存在'}>
    {!query.isLoading ? <Button onClick={onResolved}>刷新队列</Button> : null}
  </EmptyState>
  return query.data.kind === 'group'
    ? <PendingScanPane group={query.data.value} libraryName={libraryName} onResolved={onResolved} />
    : <PendingResourceIdentityPane identity={query.data.value} libraryName={libraryName} onResolved={onResolved} />
}
