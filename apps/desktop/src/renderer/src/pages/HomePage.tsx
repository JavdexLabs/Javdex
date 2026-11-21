import PageHeader from '../components/PageHeader'
import ListPage from '../components/ListPage'
import PageContent from '../components/PageContent'
import ResultCount from '../components/ResultCount'
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
import { useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import Button from '../components/Button'
import EmptyState from '../components/EmptyState'
import ListToolbar from '../components/ListToolbar'
import ListSurface from '../components/ListSurface'
import PosterCard from '../components/PosterCard'
import VirtualPosterGrid from '../components/VirtualPosterGrid'
import { useDisplayMode } from '../components/DisplayModeContext'
import BuiltinPlaylistSection from '../components/BuiltinPlaylistSection'
import { UI_ICON_SM } from '../components/iconDefaults'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import { useDebounce } from '../hooks/useDebounce'
import { LIST_PARAM, patchSearchParams } from '../listView/listQueryParams'
import { playlistDetailPath } from '../listView/playlistRoutes'
import { ROUTE_MATCH } from '../listView/routePaths'
import { useBuiltinPlaylists } from '../hooks/usePlaylistBrowsePage'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import styles from './HomePage.module.css'
import { homeKeys } from '../query/queryKeys'
import { HOME_GLOBAL_SEARCH_ID } from '../globalSearchShortcut'
import type { HomeSnapshot } from '@shared/catalogTypes'

const HOME_SEARCH_PAGE_SIZE = 120

function HomeBuiltinPlaylists(): JSX.Element {
  const lists = useBuiltinPlaylists()
  const navigate = useNavigate()
  const detailOpen = Boolean(useMatch(ROUTE_MATCH.homeVideoOpen))
  useListSurfaceRefetch(detailOpen, lists.reload)
  return <BuiltinPlaylistSection lists={lists} onOpen={id => navigate(playlistDetailPath(id))} />
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
  const { mode, coverSize } = useDisplayMode()
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
    <ListPage >
      <PageHeader className={styles.header}>
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
              <ResultCount width="media" aria-live="polite">
                共 {searchSettled ? searchTotal : '…'} 部
              </ResultCount>
            ) : undefined
          }
        />
      </PageHeader>

      {hasSearch ? (
        <ListSurface variant="fill" withInner={false}>
          {searchLoading ? (
            <PageContent >
              <EmptyState loading title="搜索中…" />
            </PageContent>
          ) : Boolean(searchQuery.error) && searchTotal === 0 ? (
            <PageContent >
              <EmptyState
                icon={<SearchX {...UI_ICON_SM} aria-hidden />}
                title="搜索失败"
                description="读取跨媒体库结果时发生错误。"
              >
                <Button size="sm" onClick={() => void searchQuery.retry()}>
                  重新搜索
                </Button>
              </EmptyState>
            </PageContent>
          ) : searchTotal === 0 ? (
            <PageContent >
              <EmptyState
                icon={<SearchX {...UI_ICON_SM} aria-hidden />}
                title="没有匹配的影片"
                description="尝试其它番号、标题或演员名称。"
              />
            </PageContent>
          ) : (
            <VirtualPosterGrid
              builtinActions="watch"
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
            <>
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
                <div
                  className={styles.posterGrid}
                  data-cover-mode={mode}
                  data-cover-size={coverSize}
                >
                  {snapshot.discovery.map((video) => (
                    <PosterCard
                      builtinActions="watch"
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
                <div
                  className={styles.posterGrid}
                  data-cover-mode={mode}
                  data-cover-size={coverSize}
                >
                  {snapshot.recent.map((video) => (
                    <PosterCard
                      builtinActions="watch"
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

            </>
          ) : null}
          <HomeBuiltinPlaylists />
        </ListSurface>
      )}
    </ListPage>
  )
}
