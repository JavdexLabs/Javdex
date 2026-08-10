import { useCallback, useMemo, useState } from 'react'
import { Clapperboard, ExternalLink, Pencil, SearchX } from 'lucide-react'
import { Outlet, useLocation, useMatch, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { DirectorUpdateInput } from '@shared/classificationTypes'
import type { VideoQuery } from '@shared/videoTypes'
import { api, assetUrl } from '../api'
import BackButton from '../components/BackButton'
import DirectorEditModal from '../components/DirectorEditModal'
import EmptyState from '../components/EmptyState'
import ListSurface from '../components/ListSurface'
import ListToolbar from '../components/ListToolbar'
import PosterCard from '../components/PosterCard'
import { useToast } from '../components/Toast'
import { UI_ICON_SM } from '../components/iconDefaults'
import { useInfiniteVideoList } from '../query/useInfiniteVideoList'
import { directorKeys } from '../query/queryKeys'
import { hashListQuery } from '../listView/listQueryParams'
import { navigateToFacetList } from '../listView/listNavigation'
import { ROUTE_MATCH } from '../listView/routePaths'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'

const STATUS = {
  unknown: '状态未知',
  active: '活跃',
  paused: '暂停',
  retired: '已退休',
  deceased: '已故',
} as const

export default function DirectorDetailPage(): JSX.Element {
  const id = Number(useParams().directorId)
  const valid = Number.isInteger(id) && id > 0
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const stacked = Boolean(useMatch({ path: ROUTE_MATCH.directorVideoStack, end: false }))
  const detailQuery = useQuery({
    queryKey: directorKeys.detail(id),
    queryFn: () => api.directors.get(id),
    enabled: valid,
  })
  const videoQuery = useMemo<VideoQuery>(
    () => ({ directorId: id, sortBy: 'release_date', sortDir: 'desc' }),
    [id],
  )
  const hash = useMemo(() => hashListQuery({ scope: 'director-detail', id }), [id])
  const onError = useCallback(
    (error: unknown) => toast.show(String((error as Error).message), 'error'),
    [toast],
  )
  const { videos, total, loading, loadingMore, hasMore, loadMore, refetchSilent } =
    useInfiniteVideoList(videoQuery, hash, onError, valid)
  useListSurfaceRefetch(stacked, refetchSilent)
  const scroll = useScrollContainerMemory(`director-detail:${hash}`)
  const save = async (input: DirectorUpdateInput): Promise<void> => {
    try {
      await api.directors.update(id, input)
      setEditing(false)
      await client.invalidateQueries({ queryKey: directorKeys.all })
      void refetchSilent()
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    }
  }
  const director = detailQuery.data
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
  if (detailQuery.isError)
    return state(
      <EmptyState
        icon={<SearchX {...UI_ICON_SM} />}
        title="导演资料加载失败"
        description={String(detailQuery.error)}
      />,
    )
  if (!director) return state(<EmptyState icon={<SearchX {...UI_ICON_SM} />} title="导演不存在" />)
  const image = assetUrl(director.imagePath ?? director.fallbackCoverPath)
  const career =
    director.careerStartYear || director.careerEndYear
      ? `${director.careerStartYear ?? '未知'} - ${director.careerEndYear ?? '至今'}`
      : null
  return (
    <div className={`detail-pane${stacked ? ' detail-pane--stacked' : ''}`}>
      <div className="list-page organization-detail-page">
        <div className="topbar">
          <ListToolbar
            leading={
              <BackButton
                variant="inline"
                onClick={() => navigateToFacetList(navigate, location, 'director')}
              />
            }
            title={director.mainName}
            controls={
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setEditing(true)}
              >
                <Pencil {...UI_ICON_SM} />
                编辑资料
              </button>
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
          <section className="organization-profile director-profile" aria-label="导演资料">
            <div className="organization-profile-image">
              {image ? <img src={image} alt="" /> : <Clapperboard {...UI_ICON_SM} />}
            </div>
            <div className="organization-profile-main">
              <div className="organization-profile-kicker">导演</div>
              <h1 className="selectable-text">{director.mainName}</h1>
              <div className="organization-profile-meta selectable-text">
                <span>{STATUS[director.status]}</span>
                {director.countryRegion && <span>{director.countryRegion}</span>}
                {director.birthDate && <span>出生：{director.birthDate}</span>}
                {director.deathDate && <span>去世：{director.deathDate}</span>}
                {director.birthPlace && <span>出生地：{director.birthPlace}</span>}
                {career && <span>从业：{career}</span>}
                {director.releaseYearStart && (
                  <span>
                    本地作品：{director.releaseYearStart}
                    {director.releaseYearEnd !== director.releaseYearStart
                      ? ` - ${director.releaseYearEnd}`
                      : ''}
                  </span>
                )}
              </div>
              {director.aliases.length > 0 && (
                <div className="organization-aliases selectable-text">
                  {director.aliases.map((alias) => (
                    <span key={alias}>{alias}</span>
                  ))}
                </div>
              )}
              <p
                className={`organization-summary selectable-text${director.summary ? '' : ' organization-summary--empty'}`}
              >
                {director.summary ?? '暂无简介'}
              </p>
              {director.links.length > 0 && (
                <div className="organization-links">
                  {director.links.map((link) => (
                    <a
                      key={`${link.position}:${link.url}`}
                      href={link.url}
                      onClick={(e) => {
                        e.preventDefault()
                        void api.externalLinks.open(link.url)
                      }}
                    >
                      {link.label}
                      <ExternalLink {...UI_ICON_SM} />
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
              icon={<Clapperboard {...UI_ICON_SM} />}
              title="暂无关联影片"
              description="导演资料仍会保留。"
            />
          ) : (
            <>
              <div className="poster-grid organization-video-grid">
                {videos.map((video) => (
                  <PosterCard key={video.id} video={video} />
                ))}
              </div>
              {hasMore && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm organization-load-more"
                  disabled={loadingMore}
                  onClick={loadMore}
                >
                  {loadingMore ? '加载中…' : '加载更多'}
                </button>
              )}
            </>
          )}
        </ListSurface>
        {editing && (
          <DirectorEditModal director={director} onCancel={() => setEditing(false)} onSave={save} />
        )}
      </div>
      {overlay}
    </div>
  )
}
