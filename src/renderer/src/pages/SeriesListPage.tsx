import { useCallback, useEffect, useState } from 'react'
import { Layers3, Plus, SearchX } from 'lucide-react'
import { useLocation, useMatch, useNavigate } from 'react-router-dom'
import type { ClassificationListSortBy, SeriesUpdateInput } from '@shared/classificationTypes'
import { api, assetUrl } from '../api'
import AppliedFilterBar from '../components/AppliedFilterBar'
import EmptyState from '../components/EmptyState'
import ListSurface from '../components/ListSurface'
import ListToolbar from '../components/ListToolbar'
import SeriesEditModal from '../components/SeriesEditModal'
import SortSwitch, { type SortSwitchOption } from '../components/SortSwitch'
import { useClassificationPage } from '../hooks/useClassificationPage'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import { useToast } from '../components/Toast'
import { UI_ICON_SM } from '../components/iconDefaults'
import { CLASSIFICATION_PAGE_SIZE } from '../listView/listQueryParams'
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
  const [creating, setCreating] = useState(false)
  const detailOpen = Boolean(useMatch({ path: ROUTE_MATCH.seriesDetailOpen, end: false }))
  const {
    query, queryHash, searchInput, setSearchInput, sortBy, sortDir, patchSort,
    items, loading, total, offset, move, canNext
  } = useClassificationPage('series', seriesKeys.list, input => api.series.page(input))
  const refetchSilent = useCallback(() => void query.refetch(), [query])
  useListSurfaceRefetch(detailOpen, refetchSilent)
  const { ref, showScrollToTop, scrollToTop } = useScrollContainerMemory(`facet:${queryHash}`)

  useEffect(() => {
    if (query.isError) toast.show(String(query.error), 'error')
  }, [query.error, query.isError, toast])

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
  return (
    <div className="list-page">
      <div className="topbar">
        <ListToolbar
          search={{
            value: searchInput,
            placeholder: '搜索系列主名或别名…',
            ariaLabel: '搜索系列',
            onChange: setSearchInput
          }}
          controls={
            <>
              <Button size="sm" disabled={offset === 0} onClick={() => move(offset - CLASSIFICATION_PAGE_SIZE)}>上一页</Button>
              <span aria-live="polite">第 {offset / CLASSIFICATION_PAGE_SIZE + 1} 页</span>
              <Button size="sm" disabled={!canNext || loading} onClick={() => move(offset + CLASSIFICATION_PAGE_SIZE)}>下一页</Button>
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
              共 {total ?? '…'} 个系列
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
        {loading ? (
          <EmptyState loading />
        ) : query.isError ? (
          <EmptyState title="系列加载失败" description={String(query.error.message)}>
            <Button onClick={() => void query.refetch()} disabled={query.isFetching}>重试</Button>
          </EmptyState>
        ) : items.length === 0 ? (
          <EmptyState
            icon={searchInput ? <SearchX {...UI_ICON_SM} /> : <Layers3 {...UI_ICON_SM} />}
            title={searchInput ? '没有匹配的系列' : '暂无系列资料'}
            description="可手动新增，或在影片编辑时就地创建。"
          />
        ) : (
          <div className="facet-grid">
            {items.map((item) => {
              const cover = assetUrl(item.imagePath ?? item.fallbackCoverPath, 640)
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
