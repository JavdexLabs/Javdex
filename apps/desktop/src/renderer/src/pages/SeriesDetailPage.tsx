import PageHeader from '../components/PageHeader'
import ListPage from '../components/ListPage'
import DetailPane, { DetailPaneOverlay } from '../components/DetailPane'
import ResultCount from '../components/ResultCount'
import ContinuousPosterGrid from '../components/ContinuousPosterGrid'
import { useCallback, useMemo, useState } from 'react'
import { GitMerge, ImagePlus, Layers3, Pencil, SearchX, Trash2 } from 'lucide-react'
import {
  Outlet,
  useLocation,
  useMatch,
  useNavigate,
  useParams,
  useSearchParams
} from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  SeriesDeleteResult,
  SeriesMergeResult,
  SeriesUpdateInput
} from '@shared/classificationTypes'
import type { VideoQuery } from '@shared/videoTypes'
import { api, assetUrl } from '../api'
import { expectedClassificationVersion } from '@shared/protocol/versions'
import BackButton from '../components/BackButton'
import ClassificationImageModal from '../components/ClassificationImageModal'
import ClassificationDeleteModal from '../components/ClassificationDeleteModal'
import EmptyState from '../components/EmptyState'
import ListSurface from '../components/ListSurface'
import ListToolbar from '../components/ListToolbar'
import SeriesEditModal from '../components/SeriesEditModal'
import SeriesMergeModal from '../components/SeriesMergeModal'
import SortSwitch from '../components/SortSwitch'
import { useToast } from '../components/Toast'
import { UI_ICON_SM } from '../components/iconDefaults'
import { useCatalogVideoPage } from '../query/useCatalogVideoPage'
import { ALL_CATALOG_SCOPE } from '../query/catalogScopes'
import { seriesKeys, videoKeys } from '../query/queryKeys'
import {
  hashListQuery,
  LIST_PARAM,
  parseSeriesReleaseDir,
  patchSearchParams,
  seriesReleaseDirParam
} from '../listView/listQueryParams'
import { navigateToFacetList } from '../listView/listNavigation'
import { ROUTE_MATCH } from '../listView/routePaths'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import Button from '../components/Button'
import ClassificationProfile from '../components/ClassificationProfile'
import ClassificationDetailSurface, { ClassificationVideoHeading } from '../components/ClassificationDetailSurface'

const STATUS = {
  unknown: '状态未知',
  ongoing: '连载中',
  completed: '已完结',
  discontinued: '已中止'
} as const

export default function SeriesDetailPage(): JSX.Element {
  const id = Number(useParams().seriesId)
  const valid = Number.isInteger(id) && id > 0
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const toast = useToast()
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [editingImage, setEditingImage] = useState(false)
  const [mergingSeries, setMergingSeries] = useState(false)
  const [deletingSeries, setDeletingSeries] = useState(false)
  const stacked = Boolean(useMatch({ path: ROUTE_MATCH.seriesVideoStack, end: false }))
  const releaseDir = parseSeriesReleaseDir(params.get(LIST_PARAM.releaseDir))
  const detailQuery = useQuery({
    queryKey: seriesKeys.detail(id),
    queryFn: () => api.series.get(id),
    enabled: valid
  })
  const videoQuery = useMemo<VideoQuery>(
    () => ({ seriesId: id, sortBy: 'release_date', sortDir: releaseDir }),
    [id, releaseDir]
  )
  const hash = useMemo(
    () => hashListQuery({ scope: 'series-detail', id, releaseDir }),
    [id, releaseDir]
  )
  const onError = useCallback(
    (message: string) => toast.show(message, 'error'),
    [toast]
  )
  const videoPage =
    useCatalogVideoPage(ALL_CATALOG_SCOPE, videoQuery, hash, onError, valid)
  const { total, loading, refetchSilent } = videoPage
  useListSurfaceRefetch(stacked, refetchSilent)
  const scroll = useScrollContainerMemory(`series-detail:${hash}`)
  const save = async (input: SeriesUpdateInput): Promise<void> => {
    await api.series.update(id, input, expectedClassificationVersion(detailQuery.data ?? {}))
    setEditing(false)
    await client.invalidateQueries({ queryKey: seriesKeys.all })
    void refetchSilent()
  }
  const merged = async (result: SeriesMergeResult): Promise<void> => {
    setMergingSeries(false)
    await Promise.all([
      client.invalidateQueries({ queryKey: seriesKeys.all }),
      client.invalidateQueries({ queryKey: videoKeys.all })
    ])
    void refetchSilent()
    toast.show(
      result.cleanupFailures.length > 0
        ? '系列已合并，但来源封面清理失败，可稍后重试'
        : `系列已合并，转移 ${result.transferredVideoCount} 部影片和 ${result.transferredChildCount} 个直接子系列`,
      result.cleanupFailures.length > 0 ? 'info' : 'success'
    )
  }
  const deleted = async (result: SeriesDeleteResult): Promise<void> => {
    setDeletingSeries(false)
    await Promise.all([
      client.invalidateQueries({ queryKey: seriesKeys.all }),
      client.invalidateQueries({ queryKey: videoKeys.all })
    ])
    toast.show(
      result.cleanupFailures.length > 0
        ? '系列已删除，但正式封面清理失败，可稍后重试'
        : `系列已删除，解除 ${result.unlinkedVideoCount} 部影片关联，${result.detachedChildCount} 个直接子系列已变为无上级`,
      result.cleanupFailures.length > 0 ? 'info' : 'success'
    )
    navigateToFacetList(navigate, location, 'series', {
      [LIST_PARAM.releaseDir]: null
    })
  }
  const series = detailQuery.data
  const overlay = stacked ? (
    <DetailPaneOverlay>
      <Outlet />
    </DetailPaneOverlay>
  ) : null
  const state = (content: JSX.Element): JSX.Element => (
    <DetailPane stacked={stacked}>
      <ListPage >
        <ListSurface variant="scroll">{content}</ListSurface>
      </ListPage>
      {overlay}
    </DetailPane>
  )
  if (!valid) return state(<EmptyState icon={<SearchX {...UI_ICON_SM} />} title="参数无效" />)
  if (detailQuery.isLoading) return state(<EmptyState loading />)
  if (detailQuery.isError) {
    return state(
      <EmptyState
        icon={<SearchX {...UI_ICON_SM} />}
        title="系列资料加载失败"
        description={String(detailQuery.error)}
      />
    )
  }
  if (!series) return state(<EmptyState icon={<SearchX {...UI_ICON_SM} />} title="系列不存在" />)
  const image = assetUrl(series.imagePath ?? series.fallbackCoverPath)
  const lifetime =
    series.startYear || series.endYear
      ? `${series.startYear ?? '未知'} - ${series.endYear ?? '至今'}`
      : null
  return (
    <DetailPane stacked={stacked}>
      <ListPage>
        <PageHeader >
          <ListToolbar
            leading={
              <BackButton
                variant="inline"
                onClick={() =>
                  navigateToFacetList(navigate, location, 'series', {
                    [LIST_PARAM.releaseDir]: null
                  })
                }
              />
            }
            title={series.mainName}
            controls={
              <>
                <SortSwitch
                  label="影片发布时间"
                  options={[{ value: 'release_date', label: '发布时间' }]}
                  value="release_date"
                  dir={releaseDir}
                  compact
                  onChange={(_, direction) =>
                    setParams(
                      (previous) =>
                        patchSearchParams(previous, {
                          [LIST_PARAM.releaseDir]: seriesReleaseDirParam(direction)
                        }),
                      { replace: true }
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setMergingSeries(true)}
                >
                  <GitMerge {...UI_ICON_SM} aria-hidden />
                  合并系列
                </Button>
                <Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setEditingImage(true)}
                >
                  <ImagePlus {...UI_ICON_SM} aria-hidden />
                  管理主图
                </Button>
                <Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  <Pencil {...UI_ICON_SM} aria-hidden />
                  编辑资料
                </Button>
                <Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setDeletingSeries(true)}
                >
                  <Trash2 {...UI_ICON_SM} aria-hidden />
                  删除系列
                </Button>
              </>
            }
            resultCount={
              <ResultCount width="media">
                共 {total} 部
              </ResultCount>
            }
          />
        </PageHeader>
        <ClassificationDetailSurface
          scrollRef={scroll.ref}
          showScrollToTop={scroll.showScrollToTop}
          onScrollToTop={scroll.scrollToTop}
        >
          <ClassificationProfile
            kind="series"
            label="系列资料"
            kicker="系列"
            name={series.mainName}
            imageUrl={image}
            placeholder={<Layers3 {...UI_ICON_SM} aria-hidden />}
            meta={<>
                <span>{STATUS[series.status]}</span>
                <span>所属：{series.ownerOrganization?.mainName ?? '未归属'}</span>
                {lifetime && <span>生命周期：{lifetime}</span>}
                {series.releaseYearStart && (
                  <span>
                    本地发行：{series.releaseYearStart}
                    {series.releaseYearEnd !== series.releaseYearStart
                      ? ` - ${series.releaseYearEnd}`
                      : ''}
                  </span>
                )}
              </>}
            aliases={series.aliases}
            summary={series.summary}
            links={series.links}
          />
          <ClassificationVideoHeading />
          {loading ? (
            <EmptyState loading variant="compact" />
          ) : videoPage.error && total === 0 ? (
            <EmptyState variant="compact" title="关联影片加载失败">
              <Button size="sm" onClick={videoPage.retry}>重试</Button>
            </EmptyState>
          ) : total === 0 ? (
            <EmptyState
              variant="compact"
              icon={<Layers3 {...UI_ICON_SM} />}
              title="暂无关联影片"
              description="系列资料仍会保留。"
            />
          ) : (
            <>
              <ContinuousPosterGrid window={videoPage.window} initialIndex={videoPage.offset} onAnchor={index => videoPage.move(Math.floor(index / 60) * 60)} scope={hash} />
            </>
          )}
        </ClassificationDetailSurface>
        {editing && (
          <SeriesEditModal series={series} onCancel={() => setEditing(false)} onSave={save} />
        )}
        {mergingSeries && (
          <SeriesMergeModal
            target={series}
            onCancel={() => setMergingSeries(false)}
            onMerged={merged}
          />
        )}
        {editingImage && (
          <ClassificationImageModal
            entity={{ kind: 'series', id }}
            expectedVersions={expectedClassificationVersion(series)}
            entityLabel="系列"
            imagePath={series.imagePath}
            fallbackCoverPath={series.fallbackCoverPath}
            onCancel={() => setEditingImage(false)}
            onChanged={() => client.invalidateQueries({ queryKey: seriesKeys.all })}
          />
        )}
        {deletingSeries && (
          <ClassificationDeleteModal
            entityLabel="系列"
            entityName={series.mainName}
            loadImpact={() => api.series.deletePreview(id)}
            remove={(impact) => api.series.remove(id, impact.planDigest, expectedClassificationVersion(series))}
            onCancel={() => setDeletingSeries(false)}
            onDeleted={deleted}
          />
        )}
      </ListPage>
      {overlay}
    </DetailPane>
  )
}
