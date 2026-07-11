import { useCallback, useMemo, useState } from 'react'
import { Outlet, useLocation, useMatch, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Inbox, SearchX } from 'lucide-react'
import type { VideoQuery } from '@shared/types'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { useToast } from '../components/Toast'
import BackButton from '../components/BackButton'
import Modal from '../components/Modal'
import ListToolbar from '../components/ListToolbar'
import SortSwitch, { type SortSwitchOption } from '../components/SortSwitch'
import VirtualPosterGrid from '../components/VirtualPosterGrid'
import EmptyState from '../components/EmptyState'
import ListSurface from '../components/ListSurface'
import { UI_ICON_SM } from '../components/iconDefaults'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import { FACET_LABEL, isFacetType } from '../facet'
import {
  facetDetailQueryHash,
  LIST_PARAM,
  parseSort,
  patchSearchParams
} from '../listView/listQueryParams'
import { decodeFacetValueKey } from '../listView/facetRoutes'
import { navigateToFacetList } from '../listView/listNavigation'
import { ROUTE_MATCH } from '../listView/routePaths'
import { useInfiniteVideoList } from '../query/useInfiniteVideoList'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { facetKeys, videoKeys } from '../query/queryKeys'

const SORT_SWITCH_OPTIONS: SortSwitchOption<NonNullable<VideoQuery['sortBy']>>[] = [
  { value: 'release_date', label: '发行', title: '发行日期' },
  { value: 'add_time', label: '添加', title: '添加时间' },
  { value: 'rating', label: '评分' },
  { value: 'code', label: '番号' }
]

export default function FacetDetailPage(): JSX.Element {
  const { type, valueKey } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const toast = useToast()
  const value = decodeFacetValueKey(valueKey)
  const videoStackOpen = Boolean(useMatch({ path: ROUTE_MATCH.facetVideoStack, end: false }))

  const [confirmDelete, setConfirmDelete] = useState(false)

  const dismissOverlays = useCallback(() => {
    setConfirmDelete(false)
  }, [])

  useDismissOverlaysOnNavigate(dismissOverlays, location.pathname)

  const facetType = isFacetType(type) ? type : null
  const label = facetType ? FACET_LABEL[facetType] : ''

  const { sortBy, sortDir } = parseSort(
    searchParams.get(LIST_PARAM.sort),
    searchParams.get(LIST_PARAM.dir)
  )

  const query = useMemo<VideoQuery>(() => {
    const q: VideoQuery = { sortBy, sortDir }
    if (facetType === 'maker') q.maker = value
    else if (facetType === 'publisher') q.publisher = value
    else if (facetType === 'series') q.series = value
    else if (facetType === 'director') q.director = value
    return q
  }, [facetType, value, sortBy, sortDir])

  const queryHash = useMemo(
    () =>
      facetType && value ? facetDetailQueryHash(facetType, value, searchParams) : '',
    [facetType, value, searchParams]
  )
  const scrollMemoryKey = queryHash ? `facet-detail:${queryHash}` : undefined

  const patchSort = useCallback(
    (nextSortBy: NonNullable<VideoQuery['sortBy']>, nextSortDir: NonNullable<VideoQuery['sortDir']>) => {
      setSearchParams(
        (prev) =>
          patchSearchParams(prev, {
            [LIST_PARAM.sort]: nextSortBy,
            [LIST_PARAM.dir]: nextSortDir
          }),
        { replace: true }
      )
    },
    [setSearchParams]
  )

  const handlePageError = useCallback(
    (e: unknown) => toast.show(String((e as Error).message ?? e), 'error'),
    [toast]
  )
  const { videos, total, loading, loadingMore, hasMore, loadMore, refetchSilent } =
    useInfiniteVideoList(query, queryHash, handlePageError, Boolean(facetType && value))

  useListSurfaceRefetch(videoStackOpen, refetchSilent)

  const doDelete = async (): Promise<void> => {
    if (!facetType) return
    try {
      await api.facets.remove(facetType, value)
      setConfirmDelete(false)
      toast.show(`已删除该${label}`, 'success')
      void queryClient.invalidateQueries({ queryKey: facetKeys.all })
      void queryClient.invalidateQueries({ queryKey: videoKeys.all })
      if (facetType) navigateToFacetList(navigate, location, facetType)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  if (!facetType || !value) {
    return (
      <EmptyState
        icon={<SearchX {...UI_ICON_SM} aria-hidden />}
        title="参数无效"
        description="当前分类详情参数无法识别。"
      />
    )
  }

  const canDelete = !loading && videos.length === 0

  return (
    <div className={`detail-pane${videoStackOpen ? ' detail-pane--stacked' : ''}`}>
      <div className="list-page">
      <div className="topbar">
        <ListToolbar
          leading={
            <BackButton
              variant="inline"
              onClick={() => navigateToFacetList(navigate, location, facetType)}
            />
          }
          title={
            <>
              <span className="topbar-toolbar-title-label">{label}：</span>
              {value}
            </>
          }
          controls={
            <SortSwitch
              label="排序"
              options={SORT_SWITCH_OPTIONS}
              value={sortBy}
              dir={sortDir}
              compact
              onChange={(nextSortBy, nextSortDir) => patchSort(nextSortBy, nextSortDir)}
            />
          }
          resultCount={
            <>
              <span className="count-badge count-badge--stable count-badge--media" aria-live="polite">
                共 {total} 部
              </span>
              {canDelete && (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={() => setConfirmDelete(true)}
                >
                  删除{label}
                </button>
              )}
            </>
          }
        />
      </div>

      <ListSurface variant="fill" withInner={false}>
        {loading ? (
          <div className="scroll-body-inner">
            <EmptyState loading />
          </div>
        ) : videos.length === 0 ? (
          <div className="scroll-body-inner">
            <EmptyState
              icon={<Inbox {...UI_ICON_SM} aria-hidden />}
              title="暂无关联影片"
              description={`该${label}当前没有关联影片。`}
            />
          </div>
        ) : (
          <VirtualPosterGrid
            scrollMemoryKey={scrollMemoryKey}
            videos={videos}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
          />
        )}
      </ListSurface>

      {confirmDelete && (
        <Modal
          title={`删除${label}`}
          danger
          confirmText="删除"
          onConfirm={() => {
            void doDelete()
          }}
          onCancel={() => setConfirmDelete(false)}
        >
          确定要删除「{value}」吗？该{label}没有关联影片，删除后不可恢复。
        </Modal>
      )}
      </div>
      {videoStackOpen && (
        <div className="detail-pane-overlay">
          <Outlet />
        </div>
      )}
    </div>
  )
}
