import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Layers3, Plus, SearchX } from 'lucide-react'
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { ClassificationListSortBy, SeriesUpdateInput } from '@shared/classificationTypes'
import type { SortDir } from '@shared/commonTypes'
import { api, assetUrl } from '../api'
import AppliedFilterBar from '../components/AppliedFilterBar'
import EmptyState from '../components/EmptyState'
import ListSurface from '../components/ListSurface'
import ListToolbar from '../components/ListToolbar'
import SeriesEditModal from '../components/SeriesEditModal'
import SortSwitch, { type SortSwitchOption } from '../components/SortSwitch'
import { useDebounce } from '../hooks/useDebounce'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import { useToast } from '../components/Toast'
import { UI_ICON_SM } from '../components/iconDefaults'
import {
  classificationListQueryHash,
  LIST_PARAM,
  parseClassificationSort,
  patchSearchParams
} from '../listView/listQueryParams'
import { navigateToSeriesDetail } from '../listView/listNavigation'
import { ROUTE_MATCH } from '../listView/routePaths'
import { seriesKeys } from '../query/queryKeys'
import Button from '../components/Button'

const SORT_OPTIONS: SortSwitchOption<ClassificationListSortBy>[] = [
  { value: 'video_count', label: '影片', title: '关联影片数量' },
  { value: 'updated_at', label: '更新', title: '最近更新时间' }
]

export default function SeriesListPage(): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const [params, setParams] = useSearchParams()
  const urlQ = params.get(LIST_PARAM.q) ?? ''
  const [searchInput, setSearchInput] = useState(urlQ)
  const syncingSearchFromUrl = useRef(false)
  const [creating, setCreating] = useState(false)
  const detailOpen = Boolean(useMatch({ path: ROUTE_MATCH.seriesDetailOpen, end: false }))
  const debounced = useDebounce(searchInput, 250)
  const { sortBy, sortDir } = parseClassificationSort(
    params.get(LIST_PARAM.sort),
    params.get(LIST_PARAM.dir)
  )
  const queryHash = useMemo(() => classificationListQueryHash('series', params), [params])
  const query = useQuery({
    queryKey: seriesKeys.list(queryHash),
    queryFn: () => api.series.list({ search: urlQ, sortBy, sortDir }),
    placeholderData: (previous) => previous
  })
  const refetchSilent = useCallback(() => void query.refetch(), [query])
  useListSurfaceRefetch(detailOpen, refetchSilent)
  const { ref, showScrollToTop, scrollToTop } = useScrollContainerMemory(`facet:${queryHash}`)

  useEffect(() => {
    if (searchInput === urlQ) return
    syncingSearchFromUrl.current = true
    setSearchInput(urlQ)
  }, [searchInput, urlQ])
  useEffect(() => {
    const value = debounced.trim()
    if (syncingSearchFromUrl.current) {
      if (value === urlQ.trim()) syncingSearchFromUrl.current = false
      return
    }
    if (value === urlQ.trim()) return
    setParams((previous) => patchSearchParams(previous, { [LIST_PARAM.q]: value || null }), {
      replace: true
    })
  }, [debounced, setParams, urlQ])
  useEffect(() => {
    if (query.isError) toast.show(String(query.error), 'error')
  }, [query.error, query.isError, toast])

  const patchSort = (next: ClassificationListSortBy, dir: SortDir): void =>
    setParams(
      (previous) =>
        patchSearchParams(previous, {
          [LIST_PARAM.sort]: next,
          [LIST_PARAM.dir]: dir
        }),
      { replace: true }
    )
  const create = async (input: SeriesUpdateInput): Promise<void> => {
    try {
      const id = await api.series.create(input)
      setCreating(false)
      await query.refetch()
      navigateToSeriesDetail(navigate, location, id)
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    }
  }
  const items = query.data ?? []
  return (
    <div className="list-page">
      <div className="topbar">
        <ListToolbar
          search={{
            value: searchInput,
            placeholder: '搜索系列主名或别名…',
            ariaLabel: '搜索系列',
            onChange: (value) => {
              syncingSearchFromUrl.current = false
              setSearchInput(value)
            }
          }}
          controls={
            <>
              <SortSwitch
                label="排序"
                options={SORT_OPTIONS}
                value={sortBy}
                dir={sortDir}
                compact
                onChange={patchSort}
              />
              <Button type="button" variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus {...UI_ICON_SM} aria-hidden />
                新增
              </Button>
            </>
          }
          resultCount={
            <span className="count-badge count-badge--stable count-badge--facet">
              共 {items.length} 个系列
            </span>
          }
        />
        <AppliedFilterBar
          items={
            sortBy === 'video_count' && sortDir === 'desc'
              ? []
              : [
                  {
                    key: 'sort',
                    label: `排序：${sortBy === 'video_count' ? '影片数量' : '最近更新'}${sortDir === 'asc' ? '正序' : '倒序'}`,
                    onRemove: () => patchSort('video_count', 'desc')
                  }
                ]
          }
          onClear={() => patchSort('video_count', 'desc')}
        />
      </div>
      <ListSurface
        variant="scroll"
        scrollRef={ref}
        showScrollToTop={showScrollToTop}
        onScrollToTop={scrollToTop}
      >
        {query.isLoading ? (
          <EmptyState loading />
        ) : items.length === 0 ? (
          <EmptyState
            icon={searchInput ? <SearchX {...UI_ICON_SM} /> : <Layers3 {...UI_ICON_SM} />}
            title={searchInput ? '没有匹配的系列' : '暂无系列资料'}
            description="可手动新增，或在影片编辑时就地创建。"
          />
        ) : (
          <div className="facet-grid">
            {items.map((item) => {
              const cover = assetUrl(item.imagePath ?? item.fallbackCoverPath)
              return (
                <div className="facet-card-wrap" key={item.id}>
                  <button
                    type="button"
                    className="facet-card card-interactive"
                    onClick={() => navigateToSeriesDetail(navigate, location, item.id)}
                  >
                    <div className="facet-thumb">
                      {cover ? (
                        <img src={cover} alt="" loading="lazy" />
                      ) : (
                        <span className="facet-thumb-placeholder">
                          <Layers3 {...UI_ICON_SM} aria-hidden />
                        </span>
                      )}
                    </div>
                    <div className="facet-name">{item.mainName}</div>
                    <div className="facet-card-subtitle">
                      {item.ownerOrganization?.mainName ?? '未归属'}
                    </div>
                    <div className="facet-count">{item.videoCount} 部</div>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </ListSurface>
      {creating && !detailOpen ? (
        <SeriesEditModal onCancel={() => setCreating(false)} onSave={create} />
      ) : null}
    </div>
  )
}
