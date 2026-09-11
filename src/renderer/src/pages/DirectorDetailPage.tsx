import RelatedVideoPager from '../components/RelatedVideoPager'
import { useCallback, useMemo, useState } from 'react'
import { Clapperboard, ExternalLink, GitMerge, ImagePlus, Pencil, SearchX, Trash2 } from 'lucide-react'
import { Outlet, useLocation, useMatch, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  DirectorDeleteResult,
  DirectorMergeResult,
  DirectorUpdateInput
} from '@shared/classificationTypes'
import type { VideoQuery } from '@shared/videoTypes'
import { api, assetUrl } from '../api'
import BackButton from '../components/BackButton'
import ClassificationImageModal from '../components/ClassificationImageModal'
import ClassificationDeleteModal from '../components/ClassificationDeleteModal'
import DirectorMergeModal from '../components/DirectorMergeModal'
import DirectorEditModal from '../components/DirectorEditModal'
import EmptyState from '../components/EmptyState'
import ListSurface from '../components/ListSurface'
import ListToolbar from '../components/ListToolbar'
import PosterCard from '../components/PosterCard'
import { useToast } from '../components/Toast'
import { UI_ICON_SM } from '../components/iconDefaults'
import { useCatalogVideoPage } from '../query/useCatalogVideoPage'
import { ALL_CATALOG_SCOPE } from '../query/catalogScopes'
import { directorKeys, videoKeys } from '../query/queryKeys'
import { hashListQuery } from '../listView/listQueryParams'
import { navigateToFacetList } from '../listView/listNavigation'
import { ROUTE_MATCH } from '../listView/routePaths'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import Button from '../components/Button'

export default function DirectorDetailPage(): JSX.Element {
  const id = Number(useParams().directorId)
  const valid = Number.isInteger(id) && id > 0
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [editingImage, setEditingImage] = useState(false)
  const [mergingDirector, setMergingDirector] = useState(false)
  const [deletingDirector, setDeletingDirector] = useState(false)
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
  const videoPage =
    useCatalogVideoPage(ALL_CATALOG_SCOPE, videoQuery, hash, onError, valid)
  const { videos, total, loading, refetchSilent } = videoPage
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
  const merged = async (result: DirectorMergeResult): Promise<void> => {
    setMergingDirector(false)
    await Promise.all([
      client.invalidateQueries({ queryKey: directorKeys.all }),
      client.invalidateQueries({ queryKey: videoKeys.all })
    ])
    void refetchSilent()
    toast.show(
      result.cleanupFailures.length > 0
        ? '导演已合并，但来源肖像清理失败，可稍后重试'
        : `导演已合并，转移 ${result.transferredVideoCount} 部影片`,
      result.cleanupFailures.length > 0 ? 'info' : 'success'
    )
  }
  const deleted = async (result: DirectorDeleteResult): Promise<void> => {
    setDeletingDirector(false)
    await Promise.all([
      client.invalidateQueries({ queryKey: directorKeys.all }),
      client.invalidateQueries({ queryKey: videoKeys.all })
    ])
    toast.show(
      result.cleanupFailures.length > 0
        ? '导演已删除，但正式肖像清理失败，可稍后重试'
        : `导演已删除，解除 ${result.unlinkedVideoCount} 部影片关联`,
      result.cleanupFailures.length > 0 ? 'info' : 'success'
    )
    navigateToFacetList(navigate, location, 'director')
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
              <>
                <Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setMergingDirector(true)}
                >
                  <GitMerge {...UI_ICON_SM} aria-hidden />
                  合并导演
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
                  <Pencil {...UI_ICON_SM} />
                  编辑资料
                </Button>
                <Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setDeletingDirector(true)}
                >
                  <Trash2 {...UI_ICON_SM} aria-hidden />
                  删除导演
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
          <section className="organization-profile director-profile" aria-label="导演资料">
            <div className="organization-profile-image">
              {image ? <img src={image} alt="" /> : <Clapperboard {...UI_ICON_SM} />}
            </div>
            <div className="organization-profile-main">
              <div className="organization-profile-kicker">导演</div>
              <h1 className="selectable-text">{director.mainName}</h1>
              {director.releaseYearStart ? (
                <div className="organization-profile-meta selectable-text">
                  <span>
                    本地作品：{director.releaseYearStart}
                    {director.releaseYearEnd !== director.releaseYearStart
                      ? ` - ${director.releaseYearEnd}`
                      : ''}
                  </span>
                </div>
              ) : null}
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
          ) : videoPage.error && total === 0 ? (
            <EmptyState variant="compact" title="关联影片加载失败">
              <Button size="sm" onClick={videoPage.retry}>重试</Button>
            </EmptyState>
          ) : total === 0 ? (
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
              <RelatedVideoPager {...videoPage} />
            </>
          )}
        </ListSurface>
        {editing && (
          <DirectorEditModal director={director} onCancel={() => setEditing(false)} onSave={save} />
        )}
        {editingImage && (
          <ClassificationImageModal
            entity={{ kind: 'director', id }}
            entityLabel="导演"
            imagePath={director.imagePath}
            fallbackCoverPath={director.fallbackCoverPath}
            onCancel={() => setEditingImage(false)}
            onChanged={() => client.invalidateQueries({ queryKey: directorKeys.all })}
          />
        )}
        {mergingDirector && (
          <DirectorMergeModal
            target={director}
            onCancel={() => setMergingDirector(false)}
            onMerged={merged}
          />
        )}
        {deletingDirector && (
          <ClassificationDeleteModal
            entityLabel="导演"
            entityName={director.mainName}
            loadImpact={() => api.directors.deletePreview(id)}
            remove={() => api.directors.remove(id)}
            onCancel={() => setDeletingDirector(false)}
            onDeleted={deleted}
          />
        )}
      </div>
      {overlay}
    </div>
  )
}
