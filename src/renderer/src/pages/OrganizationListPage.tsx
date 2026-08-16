import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Building2, Plus, SearchX } from 'lucide-react'
import type {
  ClassificationListSortBy,
  OrganizationRole,
  OrganizationUpdateInput
} from '@shared/classificationTypes'
import type { SortDir } from '@shared/commonTypes'
import { api, assetUrl } from '../api'
import { FACET_LABEL } from '../facet'
import { useDebounce } from '../hooks/useDebounce'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import { useToast } from '../components/Toast'
import ListToolbar from '../components/ListToolbar'
import ListSurface from '../components/ListSurface'
import EmptyState from '../components/EmptyState'
import SortSwitch, { type SortSwitchOption } from '../components/SortSwitch'
import AppliedFilterBar, { type AppliedFilterItem } from '../components/AppliedFilterBar'
import OrganizationEditModal from '../components/OrganizationEditModal'
import { UI_ICON_SM } from '../components/iconDefaults'
import {
  classificationListQueryHash,
  LIST_PARAM,
  parseClassificationSort,
  patchSearchParams
} from '../listView/listQueryParams'
import { navigateToOrganizationDetail } from '../listView/listNavigation'
import { ROUTE_MATCH } from '../listView/routePaths'
import { organizationKeys } from '../query/queryKeys'
import Button from '../components/Button'

const SORT_OPTIONS: SortSwitchOption<ClassificationListSortBy>[] = [
  { value: 'video_count', label: '影片', title: '关联影片数量' },
  { value: 'updated_at', label: '更新', title: '最近更新时间' }
]

interface Props {
  role: OrganizationRole
}

export default function OrganizationListPage({ role }: Props): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const detailOpen = Boolean(
    useMatch({ path: ROUTE_MATCH.organizationDetailOpen, end: false })
  )
  const label = FACET_LABEL[role]
  const urlQ = searchParams.get(LIST_PARAM.q) ?? ''
  const [searchInput, setSearchInput] = useState(urlQ)
  const [createOpen, setCreateOpen] = useState(false)
  const debouncedQ = useDebounce(searchInput, 250)
  const { sortBy, sortDir } = parseClassificationSort(
    searchParams.get(LIST_PARAM.sort),
    searchParams.get(LIST_PARAM.dir)
  )

  useEffect(() => setSearchInput(urlQ), [urlQ])
  useEffect(() => {
    const trimmed = debouncedQ.trim()
    if (trimmed === urlQ.trim()) return
    setSearchParams(
      (previous) => patchSearchParams(previous, { [LIST_PARAM.q]: trimmed || null }),
      { replace: true }
    )
  }, [debouncedQ, setSearchParams, urlQ])

  const queryHash = useMemo(
    () => classificationListQueryHash(role, searchParams),
    [role, searchParams]
  )
  const listQuery = useQuery({
    queryKey: organizationKeys.list(role, queryHash),
    queryFn: () => api.organizations.list({ role, search: urlQ, sortBy, sortDir }),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === role ? previous : undefined
  })
  const items = listQuery.data ?? []
  const loading = listQuery.isLoading && items.length === 0
  const { ref: scrollRef, showScrollToTop, scrollToTop } = useScrollContainerMemory(
    `facet:${queryHash}`
  )

  useEffect(() => {
    if (listQuery.isError && listQuery.error) {
      toast.show(String((listQuery.error as Error).message ?? listQuery.error), 'error')
    }
  }, [listQuery.error, listQuery.isError, toast])

  const refetchSilent = useCallback(() => void listQuery.refetch(), [listQuery])
  const dismissCreate = useCallback(() => setCreateOpen(false), [])
  useListSurfaceRefetch(detailOpen, refetchSilent)
  useDismissOverlaysOnNavigate(dismissCreate, location.pathname)

  const patchSort = (nextSortBy: ClassificationListSortBy, nextSortDir: SortDir): void => {
    setSearchParams(
      (previous) =>
        patchSearchParams(previous, {
          [LIST_PARAM.sort]: nextSortBy,
          [LIST_PARAM.dir]: nextSortDir
        }),
      { replace: true }
    )
  }
  const sortIsDefault = sortBy === 'video_count' && sortDir === 'desc'
  const appliedFilters: AppliedFilterItem[] = sortIsDefault
    ? []
    : [
        {
          key: 'sort',
          label: `排序：${sortBy === 'video_count' ? '影片数量' : '最近更新'}${sortDir === 'asc' ? '正序' : '倒序'}`,
          onRemove: () => patchSort('video_count', 'desc')
        }
      ]

  const createOrganization = async (input: OrganizationUpdateInput): Promise<void> => {
    try {
      const id = await api.organizations.create({ ...input, role })
      setCreateOpen(false)
      toast.show(`已新增${label}`, 'success')
      void listQuery.refetch()
      navigateToOrganizationDetail(navigate, location, role, id)
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
            placeholder: `搜索${label}主名或别名…`,
            ariaLabel: `搜索${label}`,
            onChange: setSearchInput
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
              <Button type="button" variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus {...UI_ICON_SM} aria-hidden />
                新增
              </Button>
            </>
          }
          resultCount={
            <span className="count-badge count-badge--stable count-badge--facet" aria-live="polite">
              共 {items.length} 个{label}
            </span>
          }
        />
        <AppliedFilterBar
          items={appliedFilters}
          onClear={() => patchSort('video_count', 'desc')}
        />
      </div>

      <ListSurface
        variant="scroll"
        scrollRef={scrollRef}
        showScrollToTop={showScrollToTop}
        onScrollToTop={scrollToTop}
      >
        {loading ? (
          <EmptyState loading />
        ) : items.length === 0 ? (
          <EmptyState
            icon={urlQ ? <SearchX {...UI_ICON_SM} aria-hidden /> : <Building2 {...UI_ICON_SM} aria-hidden />}
            title={urlQ ? `没有匹配的${label}` : `暂无${label}资料`}
            description={urlQ ? '调整搜索关键词后再试。' : '可手动新增，或在影片编辑时就地创建。'}
          />
        ) : (
          <div className="facet-grid">
            {items.map((item) => {
              const cover = assetUrl(item.imagePath ?? item.fallbackCoverPath)
              return (
                <div key={item.id} className="facet-card-wrap">
                  <button
                    type="button"
                    className="facet-card card-interactive"
                    title={item.mainName}
                    onClick={() => navigateToOrganizationDetail(navigate, location, role, item.id)}
                  >
                    <div className="facet-thumb facet-thumb--contain">
                      {cover ? (
                        <img src={cover} alt="" loading="lazy" />
                      ) : (
                        <span className="facet-thumb-placeholder" aria-hidden>
                          <Building2 {...UI_ICON_SM} />
                        </span>
                      )}
                    </div>
                    <div className="facet-name">{item.mainName}</div>
                    <div className="facet-count">{item.videoCount} 部</div>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </ListSurface>

      {createOpen ? (
        <OrganizationEditModal
          role={role}
          onCancel={() => setCreateOpen(false)}
          onSave={createOrganization}
        />
      ) : null}
    </div>
  )
}
