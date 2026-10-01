import PageHeader from '../components/PageHeader'
import ListPage from '../components/ListPage'
import DetailPane, { DetailPaneOverlay } from '../components/DetailPane'
import ResultCount from '../components/ResultCount'
import ContinuousPosterGrid from '../components/ContinuousPosterGrid'
import { useCallback, useMemo, useState } from 'react'
import { Clapperboard, GitMerge, ImagePlus, Pencil, SearchX, Trash2 } from 'lucide-react'
import { Outlet, useLocation, useMatch, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  DirectorDeleteResult,
  DirectorMergeResult,
  DirectorUpdateInput
} from '@shared/classificationTypes'
import type { VideoQuery } from '@shared/videoTypes'
import { api, assetUrl } from '../api'
import { expectedClassificationVersion } from '@shared/protocol/versions'
import BackButton from '../components/BackButton'
import ClassificationImageModal from '../components/ClassificationImageModal'
import ClassificationDeleteModal from '../components/ClassificationDeleteModal'
import DirectorMergeModal from '../components/DirectorMergeModal'
import DirectorEditModal from '../components/DirectorEditModal'
import EmptyState from '../components/EmptyState'
import ListSurface from '../components/ListSurface'
import ListToolbar from '../components/ListToolbar'
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
import ClassificationProfile from '../components/ClassificationProfile'
import ClassificationDetailSurface, { ClassificationVideoHeading } from '../components/ClassificationDetailSurface'

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
    (message: string) => toast.show(message, 'error'),
    [toast],
  )
  const videoPage =
    useCatalogVideoPage(ALL_CATALOG_SCOPE, videoQuery, hash, onError, valid)
  const { total, loading, refetchSilent } = videoPage
  useListSurfaceRefetch(stacked, refetchSilent)
  const scroll = useScrollContainerMemory(`director-detail:${hash}`)
  const save = async (input: DirectorUpdateInput): Promise<void> => {
    await api.directors.update(id, input, expectedClassificationVersion(detailQuery.data ?? {}))
    setEditing(false)
    await client.invalidateQueries({ queryKey: directorKeys.all })
    void refetchSilent()
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
    <DetailPane stacked={stacked}>
      <ListPage>
        <PageHeader >
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
            kind="director"
            label="导演资料"
            kicker="导演"
            name={director.mainName}
            imageUrl={image}
            placeholder={<Clapperboard {...UI_ICON_SM} />}
            meta={director.releaseYearStart ? (
              <span>
                本地作品：{director.releaseYearStart}
                {director.releaseYearEnd !== director.releaseYearStart
                  ? ` - ${director.releaseYearEnd}`
                  : ''}
              </span>
            ) : undefined}
            aliases={director.aliases}
            summary={director.summary}
            links={director.links}
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
              icon={<Clapperboard {...UI_ICON_SM} />}
              title="暂无关联影片"
              description="导演资料仍会保留。"
            />
          ) : (
            <>
              <ContinuousPosterGrid window={videoPage.window} initialIndex={videoPage.offset} onAnchor={index => videoPage.move(Math.floor(index / 60) * 60)} scope={hash} />
            </>
          )}
        </ClassificationDetailSurface>
        {editing && (
          <DirectorEditModal director={director} onCancel={() => setEditing(false)} onSave={save} />
        )}
        {editingImage && (
          <ClassificationImageModal
            entity={{ kind: 'director', id }}
            expectedVersions={expectedClassificationVersion(director)}
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
            remove={(impact) => api.directors.remove(id, impact.planDigest, expectedClassificationVersion(director))}
            onCancel={() => setDeletingDirector(false)}
            onDeleted={deleted}
          />
        )}
      </ListPage>
      {overlay}
    </DetailPane>
  )
}
