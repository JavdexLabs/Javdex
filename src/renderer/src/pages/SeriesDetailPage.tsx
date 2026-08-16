import { useCallback, useMemo, useState } from 'react'
import { ExternalLink, GitMerge, ImagePlus, Layers3, Pencil, SearchX, Trash2 } from 'lucide-react'
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
import BackButton from '../components/BackButton'
import ClassificationImageModal from '../components/ClassificationImageModal'
import ClassificationDeleteModal from '../components/ClassificationDeleteModal'
import EmptyState from '../components/EmptyState'
import ListSurface from '../components/ListSurface'
import ListToolbar from '../components/ListToolbar'
import PosterCard from '../components/PosterCard'
import SeriesEditModal from '../components/SeriesEditModal'
import SeriesMergeModal from '../components/SeriesMergeModal'
import SortSwitch from '../components/SortSwitch'
import { useToast } from '../components/Toast'
import { UI_ICON_SM } from '../components/iconDefaults'
import { useInfiniteVideoList } from '../query/useInfiniteVideoList'
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
    (error: unknown) => toast.show(String((error as Error).message), 'error'),
    [toast]
  )
  const { videos, total, loading, loadingMore, hasMore, loadMore, refetchSilent } =
    useInfiniteVideoList(videoQuery, hash, onError, valid)
  useListSurfaceRefetch(stacked, refetchSilent)
  const scroll = useScrollContainerMemory(`series-detail:${hash}`)
  const save = async (input: SeriesUpdateInput): Promise<void> => {
    try {
      await api.series.update(id, input)
      setEditing(false)
      await client.invalidateQueries({ queryKey: seriesKeys.all })
      void refetchSilent()
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    }
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
    <div className="detail-pane-overlay">
      <Outlet />
    </div>
  ) : null
  const state = (content: JSX.Element): JSX.Element => (
    <div className={`detail-pane${stacked ? ' detail-pane--stacked' : ''}`}>
      <div className="list-page">
        <ListSurface variant="scroll">{content}</ListSurface>
      </div>
      {overlay}
    </div>
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
    <div className={`detail-pane${stacked ? ' detail-pane--stacked' : ''}`}>
      <div className="list-page organization-detail-page">
        <div className="topbar">
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
              <span className="count-badge count-badge--stable count-badge--media">
                共 {total} 部
              </span>
            }
          />
        </div>
        <ListSurface
          variant="scroll"
          scrollRef={scroll.ref}
          innerClassName="organization-detail-scroll-inner"
          showScrollToTop={scroll.showScrollToTop}
          onScrollToTop={scroll.scrollToTop}
        >
          <section className="organization-profile series-profile" aria-label="系列资料">
            <div className="organization-profile-image">
              {image ? <img src={image} alt="" /> : <Layers3 {...UI_ICON_SM} aria-hidden />}
            </div>
            <div className="organization-profile-main">
              <div className="organization-profile-kicker">系列</div>
              <h1 className="selectable-text">{series.mainName}</h1>
              <div className="organization-profile-meta selectable-text">
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
              </div>
              {series.aliases.length > 0 && (
                <div className="organization-aliases selectable-text">
                  {series.aliases.map((alias) => (
                    <span key={alias}>{alias}</span>
                  ))}
                </div>
              )}
              <p
                className={`organization-summary selectable-text${series.summary ? '' : ' organization-summary--empty'}`}
              >
                {series.summary ?? '暂无简介'}
              </p>
              {series.links.length > 0 && (
                <div className="organization-links">
                  {series.links.map((link) => (
                    <a
                      key={`${link.position}:${link.url}`}
                      href={link.url}
                      onClick={(event) => {
                        event.preventDefault()
                        void api.externalLinks.open(link.url)
                      }}
                    >
                      {link.label}
                      <ExternalLink {...UI_ICON_SM} aria-hidden />
                    </a>
                  ))}
                </div>
              )}
            </div>
          </section>
          <div className="organization-video-heading">关联影片</div>
          {loading ? (
            <EmptyState loading variant="compact" />
          ) : videos.length === 0 ? (
            <EmptyState
              variant="compact"
              icon={<Layers3 {...UI_ICON_SM} />}
              title="暂无关联影片"
              description="系列资料仍会保留。"
            />
          ) : (
            <>
              <div className="poster-grid organization-video-grid">
                {videos.map((video) => (
                  <PosterCard key={video.id} video={video} />
                ))}
              </div>
              {hasMore && (
                <Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  className="organization-load-more"
                  disabled={loadingMore}
                  onClick={loadMore}
                >
                  {loadingMore ? '加载中…' : '加载更多'}
                </Button>
              )}
            </>
          )}
        </ListSurface>
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
            remove={() => api.series.remove(id)}
            onCancel={() => setDeletingSeries(false)}
            onDeleted={deleted}
          />
        )}
      </div>
      {overlay}
    </div>
  )
}
