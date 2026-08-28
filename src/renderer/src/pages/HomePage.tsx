import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { LibraryBig, RefreshCw, Search } from 'lucide-react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import Button from '../components/Button'
import EmptyState from '../components/EmptyState'
import ListSurface from '../components/ListSurface'
import ScopedPosterCard from '../components/ScopedPosterCard'
import { NavIcon } from '../components/NavIcons'
import { UI_ICON_SM } from '../components/iconDefaults'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import { useDebounce } from '../hooks/useDebounce'
import { navigateToVideoDetail } from '../listView/listNavigation'
import { mediaLibraryPath } from '../listView/mediaLibraryRoutes'
import { ROUTE_PATH } from '../listView/routePaths'
import styles from './HomePage.module.css'
import { homeKeys } from '../query/queryKeys'
import { HOME_GLOBAL_SEARCH_ID } from '../globalSearchShortcut'
import { mediaLibraryIdentityStyle } from '../components/mediaLibraryIdentity'

const HOME_DISCOVERY_SEED_KEY = 'javdex:home-discovery-seed'

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

function initialDiscoverySeed(): string {
  try {
    const stored = window.sessionStorage.getItem(HOME_DISCOVERY_SEED_KEY)?.trim()
    if (stored) return stored
  } catch {
    // Session storage may be unavailable in hardened renderer contexts.
  }
  return createDiscoverySeed()
}

export default function HomePage(): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const searchRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(-1)
  const debouncedSearch = useDebounce(search.trim(), 180)
  const [seed, setSeed] = useState(initialDiscoverySeed)
  const scroll = useScrollContainerMemory(`home:${seed}`)
  const homeQuery = useQuery({
    queryKey: homeKeys.snapshot(seed),
    queryFn: () => api.home.load({ seed, recentLimit: 12, discoveryLimit: 12 }),
    staleTime: 30_000
  })
  const suggestionsQuery = useQuery({
    queryKey: homeKeys.search(`suggestions:${debouncedSearch}`),
    queryFn: () => api.home.search({ search: debouncedSearch, limit: 6, offset: 0 }),
    enabled: debouncedSearch.length > 0,
    staleTime: 15_000
  })
  const suggestions = useMemo(
    () =>
      debouncedSearch === search.trim() ? (suggestionsQuery.data?.items ?? []) : [],
    [debouncedSearch, search, suggestionsQuery.data]
  )
  const suggestionsVisible = searchFocused && search.trim().length > 0

  useEffect(() => {
    setActiveSuggestion(-1)
  }, [debouncedSearch])

  useEffect(() => {
    if (activeSuggestion < suggestions.length) return
    setActiveSuggestion(suggestions.length > 0 ? suggestions.length - 1 : -1)
  }, [activeSuggestion, suggestions.length])

  const openSuggestion = (index: number): void => {
    const suggestion = suggestions[index]
    if (!suggestion) return
    setSearchFocused(false)
    navigateToVideoDetail(navigate, location, suggestion.id, {
      libraryId: suggestion.preferredLibraryId
    })
  }

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      setSearchFocused(false)
      setActiveSuggestion(-1)
      searchRef.current?.blur()
      return
    }
    if (!suggestionsVisible || suggestions.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveSuggestion((current) => (current + 1) % suggestions.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveSuggestion((current) =>
        current <= 0 ? suggestions.length - 1 : current - 1
      )
      return
    }
    if (event.key === 'Enter' && activeSuggestion >= 0) {
      event.preventDefault()
      openSuggestion(activeSuggestion)
    }
  }

  const submitSearch = (event: FormEvent): void => {
    event.preventDefault()
    const q = search.trim()
    if (!q) {
      searchRef.current?.focus()
      return
    }
    const params = new URLSearchParams({ q })
    navigate({ pathname: ROUTE_PATH.search, search: params.toString() })
  }

  const refreshDiscovery = (): void => {
    const nextSeed = createDiscoverySeed()
    setSeed(nextSeed)
    try {
      window.sessionStorage.setItem(HOME_DISCOVERY_SEED_KEY, nextSeed)
    } catch {
      // In-memory state still keeps this batch stable for the current mount.
    }
  }

  const snapshot = homeQuery.data

  return (
    <div className="list-page">
      <div className={`${styles.header} topbar`}>
        <div className={styles.heading}>
          <h1 className={styles.pageTitle}>首页</h1>
          <span className={styles.pageSubtitle}>跨媒体库发现与搜索</span>
        </div>
        <form className={styles.searchForm} role="search" onSubmit={submitSearch}>
          <div className={styles.searchControl}>
            <Search {...UI_ICON_SM} className={styles.searchIcon} aria-hidden />
            <input
              id={HOME_GLOBAL_SEARCH_ID}
              className={styles.searchInput}
              ref={searchRef}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setActiveSuggestion(-1)
              }}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              onKeyDown={onSearchKeyDown}
              type="search"
              role="combobox"
              placeholder="搜索番号、标题或演员（含别名）…"
              aria-label="跨媒体库搜索"
              aria-autocomplete="list"
              aria-expanded={suggestionsVisible}
              aria-controls="home-search-suggestions"
              aria-activedescendant={
                activeSuggestion >= 0 ? `home-search-suggestion-${activeSuggestion}` : undefined
              }
            />
            <span className={styles.shortcut} aria-hidden>
              {navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K'}
            </span>
            {suggestionsVisible ? (
              <div
                className={styles.suggestions}
                id="home-search-suggestions"
                role="listbox"
                aria-label="搜索建议"
                aria-busy={suggestionsQuery.isFetching || undefined}
              >
                {suggestionsQuery.isFetching && suggestions.length === 0 ? (
                  <div className={styles.suggestionState}>正在搜索…</div>
                ) : suggestions.length > 0 ? (
                  suggestions.map((suggestion, index) => (
                    <button
                      className={`${styles.suggestion}${index === activeSuggestion ? ` ${styles.suggestionActive}` : ''}`}
                      id={`home-search-suggestion-${index}`}
                      key={suggestion.id}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === activeSuggestion}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveSuggestion(index)}
                      onClick={() => openSuggestion(index)}
                    >
                      <span className={styles.suggestionText}>
                        <strong className={styles.suggestionCode}>{suggestion.code}</strong>
                        <span className={styles.suggestionTitle}>
                          {suggestion.title || '— 待刮削 —'}
                        </span>
                      </span>
                      <span className={styles.suggestionLibraries}>
                        {suggestion.libraries.map((library) => library.name).join(' · ')}
                      </span>
                    </button>
                  ))
                ) : debouncedSearch === search.trim() ? (
                  <div className={styles.suggestionState}>没有匹配的影片，按 Enter 查看完整搜索</div>
                ) : (
                  <div className={styles.suggestionState}>正在搜索…</div>
                )}
              </div>
            ) : null}
          </div>
          <Button type="submit" variant="primary" size="sm">
            搜索
          </Button>
        </form>
      </div>

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
                  <p className={styles.sectionDescription}>当前批次保持稳定，仅在换一批时更新。</p>
                </div>
                <Button size="sm" disabled={homeQuery.isFetching} onClick={refreshDiscovery}>
                  <RefreshCw {...UI_ICON_SM} aria-hidden />
                  换一批
                </Button>
              </div>
              {snapshot.discovery.length > 0 ? (
                <div className={styles.posterGrid}>
                  {snapshot.discovery.map((video) => (
                    <ScopedPosterCard key={video.id} video={video} />
                  ))}
                </div>
              ) : (
                <EmptyState
                  variant="panel"
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
                    <ScopedPosterCard key={video.id} video={video} />
                  ))}
                </div>
              ) : (
                <EmptyState variant="panel" title="还没有近期添加" />
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
                  variant="panel"
                  title="尚未配置媒体库"
                  description="创建媒体库并添加来源目录后即可开始使用。"
                />
              )}
            </section>
          </div>
        ) : null}
      </ListSurface>
    </div>
  )
}
