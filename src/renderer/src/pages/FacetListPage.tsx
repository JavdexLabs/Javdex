import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useMatch, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { FacetItem } from '@shared/types'
import { api, assetUrl } from '../api'
import { useDebounce } from '../hooks/useDebounce'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import ScrollToTopButton from '../components/ScrollToTopButton'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import { useToast } from '../components/Toast'
import ConfirmModal from '../components/ConfirmModal'
import ListToolbar from '../components/ListToolbar'
import { FACET_LABEL, isFacetType } from '../facet'
import { facetListQueryHash, LIST_PARAM, patchSearchParams } from '../listView/listQueryParams'
import { navigateToFacetDetail } from '../listView/listNavigation'
import { ROUTE_MATCH } from '../listView/routePaths'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { facetKeys } from '../query/queryKeys'
import MediaTileDeleteButton from '../components/MediaTileDeleteButton'

export default function FacetListPage(): JSX.Element {
  const { type } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const detailOpen = Boolean(useMatch({ path: ROUTE_MATCH.facetDetailOpen, end: false }))

  const facetType = isFacetType(type) ? type : null
  const label = facetType ? FACET_LABEL[facetType] : ''

  const urlQ = searchParams.get(LIST_PARAM.q) ?? ''
  const [searchInput, setSearchInput] = useState(urlQ)
  useEffect(() => {
    setSearchInput(urlQ)
  }, [urlQ])

  const debouncedQ = useDebounce(searchInput, 250)
  useEffect(() => {
    const trimmed = debouncedQ.trim()
    if (trimmed === urlQ.trim()) return
    setSearchParams(
      (prev) => patchSearchParams(prev, { [LIST_PARAM.q]: trimmed || null }),
      { replace: true }
    )
  }, [debouncedQ, urlQ, setSearchParams])

  const queryHash = useMemo(
    () => (facetType ? facetListQueryHash(facetType, searchParams) : ''),
    [facetType, searchParams]
  )
  const scrollMemoryKey = facetType ? `facet:${queryHash}` : ''
  const { ref: scrollRef, showScrollToTop, scrollToTop } = useScrollContainerMemory(scrollMemoryKey)

  const [pendingDelete, setPendingDelete] = useState<FacetItem | null>(null)

  const dismissOverlays = useCallback(() => {
    setPendingDelete(null)
  }, [])

  useDismissOverlaysOnNavigate(dismissOverlays, location.pathname)

  const listQuery = useQuery({
    queryKey: facetKeys.list(facetType ?? '', queryHash),
    queryFn: () => api.facets.list(facetType!),
    enabled: Boolean(facetType),
    placeholderData: (prev) => prev
  })

  useEffect(() => {
    if (listQuery.isError && listQuery.error) {
      toast.show(String((listQuery.error as Error).message ?? listQuery.error), 'error')
    }
  }, [listQuery.isError, listQuery.error, toast])

  const refetchSilent = useCallback(() => {
    void listQuery.refetch()
  }, [listQuery])

  useListSurfaceRefetch(detailOpen, refetchSilent)

  const items = listQuery.data ?? []
  const loading = listQuery.isLoading && items.length === 0
  const isFetching = listQuery.isFetching

  const filtered = useMemo(() => {
    const q = debouncedQ.trim().toLowerCase()
    return q ? items.filter((i) => i.value.toLowerCase().includes(q)) : items
  }, [items, debouncedQ])

  useEffect(() => {
    if (!facetType) return
    setSearchParams(new URLSearchParams(), { replace: true })
    setSearchInput('')
  }, [facetType])

  const doDelete = async (): Promise<void> => {
    if (!facetType || !pendingDelete) return
    try {
      await api.facets.remove(facetType, pendingDelete.value)
      setPendingDelete(null)
      toast.show(`已删除「${pendingDelete.value}」`, 'success')
      void listQuery.refetch()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  if (!facetType) {
    return (
      <div className="empty-state">
        <div>未知分类</div>
      </div>
    )
  }

  return (
    <div className="list-page">
      <div className="topbar">
        <ListToolbar
          search={{
            value: searchInput,
            placeholder: `搜索${label}…`,
            ariaLabel: `搜索${label}`,
            onChange: setSearchInput
          }}
          resultCount={
            <span
              className="count-badge count-badge--stable count-badge--facet"
              aria-live="polite"
            >
              共 {filtered.length} 个{label}
              {isFetching && !loading && filtered.length > 0 ? (
                <span className="library-fetch-hint" aria-hidden>
                  {' '}
                  ↻
                </span>
              ) : null}
            </span>
          }
        />
      </div>

      <div className="list-scroll-region">
        <div ref={scrollRef} className="scroll-body scroll-body--scroll">
        <div className="scroll-body-inner">
          {loading ? (
            <div className="empty-state">
              <div className="spinner" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty-state">
              <div className="big">▦</div>
              <div>
                {items.length === 0
                  ? `暂无${label}数据，刮削影片后将自动归纳。`
                  : `没有匹配的${label}。`}
              </div>
            </div>
          ) : (
            <div className="facet-grid">
              {filtered.map((it) => {
                const cover = assetUrl(it.cover_path)
                return (
                  <div key={it.value} className="facet-card-wrap">
                    <button
                      type="button"
                      className="facet-card card-interactive"
                      onClick={() => navigateToFacetDetail(navigate, facetType, it.value)}
                      title={it.value}
                    >
                      <div className="facet-thumb">
                        {cover ? <img src={cover} alt={it.value} loading="lazy" /> : <span>▦</span>}
                      </div>
                      <div className="facet-name">{it.value}</div>
                      <div className="facet-count">{it.video_count} 部</div>
                    </button>
                    {it.video_count === 0 && (
                      <MediaTileDeleteButton
                        label={`删除${label} ${it.value}`}
                        title="删除"
                        onClick={() => setPendingDelete(it)}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        </div>
        <ScrollToTopButton visible={showScrollToTop} onClick={scrollToTop} />
      </div>

      {pendingDelete && (
        <ConfirmModal
          title={`删除${label}`}
          danger
          confirmText="删除"
          onConfirm={() => void doDelete()}
          onCancel={() => setPendingDelete(null)}
        >
          <p>确定删除「{pendingDelete.value}」？</p>
        </ConfirmModal>
      )}
    </div>
  )
}
