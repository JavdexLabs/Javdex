import { useWindowedCatalog } from '../query/useWindowedCatalog'
import { toScopedVideoCardPage, type ScopedVideoCard, type ScopedVideoCardPage } from '@shared/cardProjection'
import {
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { LibraryBig, RefreshCw, SearchX } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import Button from '../components/Button'
import EmptyState from '../components/EmptyState'
import ListToolbar from '../components/ListToolbar'
import ListSurface from '../components/ListSurface'
import PosterCard from '../components/PosterCard'
import VirtualPosterGrid from '../components/VirtualPosterGrid'
import { NavIcon } from '../components/NavIcons'
import { UI_ICON_SM } from '../components/iconDefaults'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import { useDebounce } from '../hooks/useDebounce'
import { LIST_PARAM, patchSearchParams } from '../listView/listQueryParams'
import { mediaLibraryPath } from '../listView/mediaLibraryRoutes'
import styles from './HomePage.module.css'
import { homeKeys } from '../query/queryKeys'
import { HOME_GLOBAL_SEARCH_ID } from '../globalSearchShortcut'
import { mediaLibraryIdentityStyle } from '../components/mediaLibraryIdentity'
import type { HomeSnapshot } from '@shared/catalogTypes'

const HOME_SEARCH_PAGE_SIZE = 120

const HOME_SCAN_STATUS_LABEL = {
  queued: '等待扫描',
  running: '扫描中',
  completed: '扫描完成',
  failed: '扫描失败',
  cancelled: '扫描已取消',
  unavailable: '来源不可用'
} as const
const HOME_SCAN_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
})

function rootAvailabilityLabel(input: {
  activeRootCount: number
  lastScanOfflineRootCount: number | null
}): string {
  if (input.activeRootCount === 0) return '无已启用来源'
  if (input.lastScanOfflineRootCount === null) return '来源可用性未检测'
  if (input.lastScanOfflineRootCount > 0) {
    return `最近扫描离线 ${input.lastScanOfflineRootCount} 个`
  }
  return '最近扫描未发现离线来源'
}

function formatScanTime(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return HOME_SCAN_TIME_FORMATTER.format(date)
}

function createDiscoverySeed(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

// Keep the active discovery batch for the lifetime of this renderer process.
// Route remounts and query invalidations reuse it; an app restart recreates it.
let activeDiscovery = {
  seed: createDiscoverySeed(),
  videos: null as HomeSnapshot['discovery'] | null
}

async function loadHomeSnapshot(seed: string): Promise<HomeSnapshot> {
  const snapshot = await api.home.load({ seed, recentLimit: 12, discoveryLimit: 12 })
  if (seed !== activeDiscovery.seed) return snapshot

  activeDiscovery.videos ??= snapshot.discovery
  return snapshot.discovery === activeDiscovery.videos
    ? snapshot
    : { ...snapshot, discovery: activeDiscovery.videos }
}

export default function HomePage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams()
  const searchRef = useRef<HTMLInputElement>(null)
  const urlSearch = searchParams.get(LIST_PARAM.q) ?? ''
  const [search, setSearch] = useState(urlSearch)
  const debouncedSearch = useDebounce(search, 300)
  const [seed, setSeed] = useState(() => activeDiscovery.seed)
  const scroll = useScrollContainerMemory(`home:${seed}`)

  useEffect(() => {
    setSearch(urlSearch)
  }, [urlSearch])

  useEffect(() => {
    const normalized = debouncedSearch.trim()
    if (normalized === urlSearch.trim()) return
    setSearchParams(
      (current) => patchSearchParams(current, { [LIST_PARAM.q]: normalized || null }),
      { replace: true }
    )
  }, [debouncedSearch, setSearchParams, urlSearch])

  const homeQuery = useQuery({
    queryKey: homeKeys.snapshot(seed),
    queryFn: () => loadHomeSnapshot(seed),
    staleTime: 30_000,
    gcTime: 0
  })
  const normalizedSearch = search.trim()
  const settledSearch = debouncedSearch.trim()
  const searchSettled = normalizedSearch === settledSearch
  const searchQuery = useWindowedCatalog<ScopedVideoCard, ScopedVideoCardPage>(
    homeKeys.search(`home:${settledSearch}`), HOME_SEARCH_PAGE_SIZE,
    async offset => toScopedVideoCardPage(await api.home.search({ search: settledSearch, limit: HOME_SEARCH_PAGE_SIZE, offset })), settledSearch.length > 0
  )
  const searchVideos = searchQuery.items
  const searchTotal = searchQuery.total
  const detailLibraryIds = useMemo(
    () => new Map(searchVideos.map((video) => [video.id, video.preferredLibraryId])),
    [searchVideos]
  )
  const hasSearch = normalizedSearch.length > 0
  const searchLoading =
    hasSearch &&
    (!searchSettled ||
      searchQuery.loading ||
      (searchQuery.isFetching && searchTotal === 0))

  const refreshDiscovery = (): void => {
    activeDiscovery = { seed: createDiscoverySeed(), videos: null }
    setSeed(activeDiscovery.seed)
  }

  const snapshot = homeQuery.data

  return (
    <div className="list-page">
      <div className={`${styles.header} topbar`}>
        <ListToolbar
          leading={
            <div className={styles.heading}>
              <h1 className={styles.pageTitle}>首页</h1>
              <span className={styles.pageSubtitle}>跨媒体库发现与搜索</span>
            </div>
          }
          search={{
            id: HOME_GLOBAL_SEARCH_ID,
            inputRef: searchRef,
            value: search,
            placeholder: '搜索番号、标题或演员（含别名）…',
            ariaLabel: '跨媒体库搜索',
            onChange: setSearch,
            busy: searchLoading,
            endAdornment: (
              <span className={styles.shortcut} aria-hidden>
                {navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K'}
              </span>
            )
          }}
          resultCount={
            hasSearch ? (
              <span className="count-badge count-badge--stable count-badge--media" aria-live="polite">
                共 {searchSettled ? searchTotal : '…'} 部
              </span>
            ) : undefined
          }
        />
      </div>

      {hasSearch ? (
        <ListSurface variant="fill" withInner={false}>
          {searchLoading ? (
            <div className="scroll-body-inner">
              <EmptyState loading title="搜索中…" />
            </div>
          ) : Boolean(searchQuery.error) && searchTotal === 0 ? (
            <div className="scroll-body-inner">
              <EmptyState
                icon={<SearchX {...UI_ICON_SM} aria-hidden />}
                title="搜索失败"
                description="读取跨媒体库结果时发生错误。"
              >
                <Button size="sm" onClick={() => void searchQuery.retry()}>
                  重新搜索
                </Button>
              </EmptyState>
            </div>
          ) : searchTotal === 0 ? (
            <div className="scroll-body-inner">
              <EmptyState
                icon={<SearchX {...UI_ICON_SM} aria-hidden />}
                title="没有匹配的影片"
                description="尝试其它番号、标题或演员名称。"
              />
            </div>
          ) : (
            <VirtualPosterGrid
              videos={searchVideos}
              detailLibraryIds={detailLibraryIds}
              catalogWindow={searchQuery.window}
              scrollMemoryKey={`home-search:${settledSearch}`}
            />
          )}
        </ListSurface>
      ) : (
        <ListSurface
          variant="scroll"
          scrollRef={scroll.ref}
          innerClassName={styles.content}
          showScrollToTop={scroll.showScrollToTop}
          onScrollToTop={scroll.scrollToTop}
        >
          {homeQuery.isLoading ? (
            <EmptyState loading title="正在整理首页…" />
          ) : homeQuery.isError ? (
            <EmptyState
              icon={<LibraryBig {...UI_ICON_SM} aria-hidden />}
              title="首页暂时无法加载"
              description="请检查媒体库状态后重试。"
            >
              <Button size="sm" onClick={() => void homeQuery.refetch()}>
                重新加载
              </Button>
            </EmptyState>
          ) : snapshot ? (
            <div className={styles.sections}>
            <section className={styles.section} aria-labelledby="home-discovery-title">
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle} id="home-discovery-title">随机发现</h2>
                  <p className={styles.sectionDescription}>
                    当前批次保持稳定，仅在重启软件或换一批时更新。
                  </p>
                </div>
                <Button size="sm" disabled={homeQuery.isFetching} onClick={refreshDiscovery}>
                  <RefreshCw {...UI_ICON_SM} aria-hidden />
                  换一批
                </Button>
              </div>
              {snapshot.discovery.length > 0 ? (
                <div className={styles.posterGrid}>
                  {snapshot.discovery.map((video) => (
                    <PosterCard
                      key={video.id}
                      video={video}
                      detailLibraryId={video.preferredLibraryId}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState
                  variant="compact"
                  title="暂无可发现的影片"
                  description="启用媒体库的首页发现并导入影片后，这里会显示随机内容。"
                />
              )}
            </section>

            <section className={styles.section} aria-labelledby="home-recent-title">
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle} id="home-recent-title">近期添加</h2>
                  <p className={styles.sectionDescription}>按影片最近加入媒体库的时间去重展示。</p>
                </div>
              </div>
              {snapshot.recent.length > 0 ? (
                <div className={styles.posterGrid}>
                  {snapshot.recent.map((video) => (
                    <PosterCard
                      key={video.id}
                      video={video}
                      detailLibraryId={video.preferredLibraryId}
                    />
                  ))}
                </div>
              ) : (
                <EmptyState variant="compact" title="还没有近期添加" />
              )}
            </section>

            <section className={styles.section} aria-labelledby="home-libraries-title">
              <div className={styles.sectionHeader}>
                <div>
                  <h2 className={styles.sectionTitle} id="home-libraries-title">媒体库</h2>
                  <p className={styles.sectionDescription}>快速查看来源配置状态并进入独立媒体库。</p>
                </div>
              </div>
              {snapshot.libraries.length > 0 ? (
                <div className={styles.libraryGrid}>
                  {snapshot.libraries.map((library) => {
                    const lastScanTime = formatScanTime(
                      library.lastScanFinishedAt ?? library.lastScanStartedAt
                    )
                    return (
                      <Link
                        key={library.id}
                        className={styles.libraryCard}
                        to={mediaLibraryPath(library.id)}
                      >
                        <span
                          className={styles.libraryIcon}
                          style={mediaLibraryIdentityStyle(library.color)}
                          aria-hidden
                        >
                          <NavIcon name={library.icon} />
                        </span>
                        <span className={styles.libraryInfo}>
                          <strong className={styles.libraryName}>{library.name}</strong>
                          <span className={styles.libraryMeta}>
                            {library.membershipCount} 部影片 · {library.resourceCount} 个资源 ·{' '}
                            {library.activeRootCount}/{library.rootCount} 个来源启用
                            {library.pendingRemovalRootCount > 0
                              ? ` · ${library.pendingRemovalRootCount} 个待移除`
                              : ''}
                          </span>
                          <span className={styles.libraryActivity}>
                            {library.lastScanStatus ? (
                              <span
                                className={styles.scanStatus}
                                data-tone={
                                  library.lastScanStatus === 'failed' ||
                                  library.lastScanStatus === 'unavailable'
                                    ? 'danger'
                                    : library.lastScanStatus === 'running' ||
                                        library.lastScanStatus === 'queued'
                                      ? 'active'
                                      : 'neutral'
                                }
                              >
                                {HOME_SCAN_STATUS_LABEL[library.lastScanStatus]}
                                {lastScanTime ? ` · ${lastScanTime}` : ''}
                              </span>
                            ) : (
                              <span>尚未扫描</span>
                            )}
                            <span
                              className={styles.rootAvailability}
                              data-tone={
                                library.lastScanOfflineRootCount !== null &&
                                library.lastScanOfflineRootCount > 0
                                  ? 'warning'
                                  : 'neutral'
                              }
                              title="基于最近一次已保存的扫描结果，不会实时访问目录"
                            >
                              {rootAvailabilityLabel(library)}
                            </span>
                            {library.pendingScanResourceCount > 0 ? (
                              <span>{library.pendingScanResourceCount} 条待确认</span>
                            ) : null}
                            {library.pendingCleanupJobCount > 0 ? (
                              <span>{library.pendingCleanupJobCount} 项待清理</span>
                            ) : null}
                            {library.unrecognizedFileCount > 0 ? (
                              <span>{library.unrecognizedFileCount} 个未识别</span>
                            ) : null}
                          </span>
                        </span>
                        <span className={styles.libraryStatus}>进入</span>
                      </Link>
                    )
                  })}
                </div>
              ) : (
                <EmptyState
                  variant="compact"
                  title="尚未配置媒体库"
                  description="创建媒体库并添加来源目录后即可开始使用。"
                />
              )}
            </section>
            </div>
          ) : null}
        </ListSurface>
      )}
    </div>
  )
}
