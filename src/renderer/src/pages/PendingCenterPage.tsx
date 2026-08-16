import { useCallback, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, ListChecks, ScanSearch, UsersRound } from 'lucide-react'
import { useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import { api, resolveMediaSrc } from '../api'
import EmptyState from '../components/EmptyState'
import ListToolbar from '../components/ListToolbar'
import { UI_ICON_SM } from '../components/iconDefaults'
import {
  WorkbenchMain,
  WorkbenchRail,
  WorkbenchRailHeader,
  WorkbenchShell
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
import { actressKeys } from '../query/queryKeys'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import PendingActressConflictPane from './PendingActressConflictPane'
import PendingScanPane from './PendingScanPane'
import PendingScrapePane from './PendingScrapePane'
import styles from './PendingCenterPage.module.css'
import {
  PENDING_DOMAIN_LABEL,
  buildPendingQueueSections,
  pendingQueueTotal,
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
  const detailOpen = Boolean(useMatch({ path: ROUTE_MATCH.pendingVideoStack, end: false }))
  const [params] = useSearchParams()
  const { type, item: urlItem, videoId: videoFromUrl } = parsePendingCenterSearch(params)

  const scanQuery = useQuery({
    queryKey: ['pending-scan-groups'],
    queryFn: () => api.scan.listPending()
  })
  const scrapeQuery = useQuery({
    queryKey: ['pending-video-scrapes'],
    queryFn: () => api.scrape.listPending()
  })
  const conflict = useConflictReviewController()

  const scanGroups = scanQuery.data ?? []
  const scrapeItems = scrapeQuery.data ?? []
  const conflictGroups = conflict.queue.groups
  const queueInput = { scanGroups, scrapeItems, conflictGroups }
  const sections = buildPendingQueueSections(queueInput, type)
  const counts: Record<PendingTypeFilter, number> = {
    all: scanGroups.length + scrapeItems.length + conflictGroups.length,
    scan: scanGroups.length,
    scrape: scrapeItems.length,
    actress: conflictGroups.length
  }

  // A video deep link wins over the stored item so "查看待确认候选" always lands right.
  const deepLinked = videoFromUrl == null
    ? null
    : scrapeItems.find((entry) => entry.videoId === videoFromUrl)
  const requested = deepLinked ? pendingItemKey('scrape', deepLinked.id) : urlItem
  const selected = resolvePendingSelection(sections, requested)

  const loading = scanQuery.isLoading || scrapeQuery.isLoading || conflict.queue.loading
  const total = pendingQueueTotal(sections)

  const selectItem = useCallback(
    (key: PendingItemKey, replace = false) => {
      navigate(pendingCenterPath({ type, item: key }), { replace })
    },
    [navigate, type]
  )

  // Canonicalize the URL: resolve deep links and drop selections that no longer exist.
  useEffect(() => {
    if (loading || !selected) return
    if (videoFromUrl == null && samePendingItemKey(selected, urlItem)) return
    selectItem(selected, true)
  }, [loading, selected, urlItem, videoFromUrl, selectItem])

  // Actress conflicts keep their own session state; feed it the queue selection.
  const chooseConflictGroupRef = useRef(conflict.queue.chooseGroup)
  chooseConflictGroupRef.current = conflict.queue.chooseGroup
  const conflictSelectedName = conflict.queue.selectedGroup?.normalizedName ?? null
  useEffect(() => {
    if (selected?.domain !== 'actress' || conflictSelectedName === selected.id) return
    const group = conflictGroups.find((entry) => entry.normalizedName === selected.id)
    if (group) chooseConflictGroupRef.current(group)
  }, [selected?.domain, selected?.id, conflictSelectedName, conflictGroups])

  const railButtons = useRef(new Map<string, HTMLButtonElement>())
  const { focusAfterRefresh } = conflict.queue
  const focusHandledRef = useRef(conflict.queue.focusHandled)
  focusHandledRef.current = conflict.queue.focusHandled
  useEffect(() => {
    if (focusAfterRefresh === undefined) return
    if (focusAfterRefresh) {
      railButtons.current
        .get(formatPendingItemKey(pendingItemKey('actress', focusAfterRefresh)))
        ?.focus()
    }
    focusHandledRef.current()
  }, [focusAfterRefresh])

  const refetchPendingSurface = useCallback((): void => {
    void Promise.all([
      queryClient.refetchQueries({ queryKey: ['pending-scan-groups'], exact: true }),
      queryClient.refetchQueries({ queryKey: ['pending-video-scrapes'], exact: true }),
      queryClient.refetchQueries({ queryKey: actressKeys.conflicts(), exact: true }),
      queryClient.refetchQueries({ queryKey: actressKeys.conflictSummary(), exact: true })
    ])
  }, [queryClient])

  useListSurfaceRefetch(detailOpen, refetchPendingSurface)

  const refresh = (): void => {
    invalidateVideoLibraryQueries(queryClient)
    refetchPendingSurface()
  }

  const selectedScan =
    selected?.domain === 'scan'
      ? scanGroups.find((entry) => String(entry.id) === selected.id) ?? null
      : null
  const selectedScrape =
    selected?.domain === 'scrape'
      ? scrapeItems.find((entry) => String(entry.id) === selected.id) ?? null
      : null

  return (
    <div className={`list-page ${styles.page}`}>
      <header className={`topbar ${styles.topbar}`}>
        <ListToolbar
          title="待确认"
          controls={
            <div className={styles.typeFilter} role="group" aria-label="待确认类型">
              {FILTER_ORDER.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={type === option}
                  onClick={() => navigate(pendingCenterPath({ type: option }))}
                >
                  {option === 'all' ? (
                    <ListChecks {...UI_ICON_SM} aria-hidden />
                  ) : (
                    DOMAIN_ICON[option]
                  )}
                  {option === 'all' ? '全部' : PENDING_DOMAIN_LABEL[option]}
                  <em>{counts[option]}</em>
                </button>
              ))}
            </div>
          }
          resultCount={<span className={styles.count}>{total} 项待处理</span>}
        />
      </header>
      <div className="scroll-body scroll-body--fill">
        <WorkbenchShell className={styles.shell}>
          {loading ? (
            <EmptyState variant="fill" loading title="正在读取待确认项…" />
          ) : total === 0 ? (
            <div className={styles.complete}>
              <EmptyState
                variant="fill"
                title={type === 'all' ? '没有待确认项' : `没有${PENDING_DOMAIN_LABEL[type]}待确认项`}
                description="新的扫描歧义、刮削候选或演员名称冲突会自动出现在这里。"
              />
            </div>
          ) : (
            <WorkbenchMain className={styles.main}>
              <WorkbenchRail aria-label="待确认队列">
                <WorkbenchRailHeader>
                  <span>待处理</span>
                  <span>{total} 项</span>
                </WorkbenchRailHeader>
                <div className={styles.railList}>
                  {sections.map((section) => (
                    <section className={styles.railSection} key={section.domain}>
                      <h2>
                        {section.label}
                        <span className={styles.railCount}>{section.items.length}</span>
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
                    </section>
                  ))}
                </div>
              </WorkbenchRail>
              {selectedScan ? (
                <PendingScanPane group={selectedScan} onResolved={refresh} />
              ) : selectedScrape ? (
                <PendingScrapePane pending={selectedScrape} onResolved={refresh} />
              ) : selected?.domain === 'actress' ? (
                <PendingActressConflictPane vm={conflict} />
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
