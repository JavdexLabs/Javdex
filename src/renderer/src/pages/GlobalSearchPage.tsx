import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { LibraryBig, SearchX } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import Button from '../components/Button'
import EmptyState from '../components/EmptyState'
import ListSurface from '../components/ListSurface'
import ListToolbar from '../components/ListToolbar'
import VirtualPosterGrid from '../components/VirtualPosterGrid'
import { UI_ICON_SM } from '../components/iconDefaults'
import { useDebounce } from '../hooks/useDebounce'
import {
  GLOBAL_SEARCH_LIBRARY_PARAM,
  canonicalizeGlobalSearchParams,
  globalSearchInputFromParams,
  globalSearchLibraryIdsParam,
  globalSearchQueryHash,
  parseGlobalSearchLibraryIds
} from '../listView/globalSearchState'
import { LIST_PARAM, patchSearchParams } from '../listView/listQueryParams'
import styles from './GlobalSearchPage.module.css'
import { homeKeys, mediaLibraryKeys } from '../query/queryKeys'
import { mediaLibraryIdentityStyle } from '../components/mediaLibraryIdentity'

const PAGE_SIZE = 120

export default function GlobalSearchPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams()
  const urlQ = searchParams.get(LIST_PARAM.q) ?? ''
  const [searchInput, setSearchInput] = useState(urlQ)
  const debouncedSearch = useDebounce(searchInput, 250)
  const selectedLibraryIds = useMemo(
    () => parseGlobalSearchLibraryIds(searchParams.get(GLOBAL_SEARCH_LIBRARY_PARAM)),
    [searchParams]
  )
  const queryHash = useMemo(() => globalSearchQueryHash(searchParams), [searchParams])

  useEffect(() => {
    const canonical = canonicalizeGlobalSearchParams(searchParams)
    if (canonical.toString() !== searchParams.toString()) {
      setSearchParams(canonical, { replace: true })
    }
  }, [searchParams, setSearchParams])

  useEffect(() => setSearchInput(urlQ), [urlQ])

  useEffect(() => {
    const q = debouncedSearch.trim()
    if (q === urlQ.trim()) return
    setSearchParams(
      (current) => patchSearchParams(current, { [LIST_PARAM.q]: q || null }),
      { replace: true }
    )
  }, [debouncedSearch, setSearchParams, urlQ])

  const librariesQuery = useQuery({
    queryKey: mediaLibraryKeys.activeList(),
    queryFn: () => api.mediaLibraries.list()
  })
  const resultsQuery = useInfiniteQuery({
    queryKey: homeKeys.search(queryHash),
    enabled: Boolean(urlQ.trim()),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.home.search(
        globalSearchInputFromParams(searchParams, {
          limit: PAGE_SIZE,
          offset: typeof pageParam === 'number' ? pageParam : 0
        })
      ),
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((total, page) => total + page.items.length, 0)
      return loaded < lastPage.total ? loaded : undefined
    },
    placeholderData: (previous) => previous
  })

  const videos = useMemo(
    () => resultsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [resultsQuery.data]
  )
  const total = resultsQuery.data?.pages[0]?.total ?? 0
  const detailLibraryIds = useMemo(
    () => new Map(videos.map((video) => [video.id, video.preferredLibraryId])),
    [videos]
  )

  const toggleLibrary = (libraryId: number): void => {
    const next = selectedLibraryIds.includes(libraryId)
      ? selectedLibraryIds.filter((id) => id !== libraryId)
      : [...selectedLibraryIds, libraryId]
    setSearchParams(
      (current) =>
        patchSearchParams(current, {
          [GLOBAL_SEARCH_LIBRARY_PARAM]: globalSearchLibraryIdsParam(next)
        }),
      { replace: true }
    )
  }

  const searching = resultsQuery.isLoading || (resultsQuery.isFetching && videos.length === 0)
  const hasQuery = Boolean(urlQ.trim())

  return (
    <div className="list-page">
      <div className={`${styles.header} topbar`}>
        <ListToolbar
          search={{
            value: searchInput,
            placeholder: '跨媒体库搜索番号、标题或演员（含别名）…',
            ariaLabel: '跨媒体库搜索',
            onChange: setSearchInput
          }}
          resultCount={
            hasQuery ? (
              <span className="count-badge count-badge--stable count-badge--media" aria-live="polite">
                共 {total} 部
              </span>
            ) : null
          }
        />
        <div className={styles.filters} role="group" aria-label="按媒体库筛选">
          <span className={styles.filterLabel}>媒体库</span>
          <Button
            className={styles.libraryFilter}
            size="sm"
            variant="ghost"
            aria-pressed={selectedLibraryIds.length === 0}
            onClick={() =>
              setSearchParams(
                (current) =>
                  patchSearchParams(current, { [GLOBAL_SEARCH_LIBRARY_PARAM]: null }),
                { replace: true }
              )
            }
          >
            全部
          </Button>
          <div className={styles.libraryFilters}>
            {(librariesQuery.data ?? []).map((library) => {
              const selected = selectedLibraryIds.includes(library.id)
              return (
                <Button
                  key={library.id}
                  className={styles.libraryFilter}
                  size="sm"
                  variant="ghost"
                  aria-pressed={selected}
                  onClick={() => toggleLibrary(library.id)}
                >
                  <span
                    className={styles.libraryDot}
                    style={mediaLibraryIdentityStyle(library.color)}
                    aria-hidden
                  />
                  {library.name}
                </Button>
              )
            })}
          </div>
        </div>
      </div>

      <ListSurface variant="fill" withInner={false}>
        {!hasQuery ? (
          <div className="scroll-body-inner">
            <EmptyState
              icon={<LibraryBig {...UI_ICON_SM} aria-hidden />}
              title="搜索全部媒体库"
              description="输入番号、标题或演员名称开始搜索。"
            />
          </div>
        ) : searching ? (
          <div className="scroll-body-inner">
            <EmptyState loading title="搜索中…" />
          </div>
        ) : resultsQuery.isError ? (
          <div className="scroll-body-inner">
            <EmptyState
              icon={<SearchX {...UI_ICON_SM} aria-hidden />}
              title="搜索失败"
              description="读取跨媒体库结果时发生错误。"
            >
              <Button size="sm" onClick={() => void resultsQuery.refetch()}>
                重新搜索
              </Button>
            </EmptyState>
          </div>
        ) : videos.length === 0 ? (
          <div className="scroll-body-inner">
            <EmptyState
              icon={<SearchX {...UI_ICON_SM} aria-hidden />}
              title="没有匹配的影片"
              description="尝试其它关键词或放宽媒体库筛选。"
            />
          </div>
        ) : (
          <VirtualPosterGrid
            videos={videos}
            detailLibraryIds={detailLibraryIds}
            hasMore={Boolean(resultsQuery.hasNextPage)}
            loadingMore={resultsQuery.isFetchingNextPage}
            onLoadMore={() => {
              if (!resultsQuery.isFetchingNextPage) void resultsQuery.fetchNextPage()
            }}
            showLibraryBadges
            scrollMemoryKey={`global-search:${queryHash}`}
          />
        )}
      </ListSurface>
    </div>
  )
}
