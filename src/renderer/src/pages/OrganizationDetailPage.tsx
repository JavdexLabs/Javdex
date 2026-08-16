import { useCallback, useMemo, useState } from 'react'
import { BadgeMinus, ExternalLink, GitMerge, ImagePlus, Inbox, Pencil, SearchX, Trash2 } from 'lucide-react'
import {
  Outlet,
  useLocation,
  useMatch,
  useNavigate,
  useParams
} from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  OrganizationDeleteResult,
  OrganizationMergeResult,
  OrganizationRole,
  OrganizationRoleRemovalResult,
  OrganizationUpdateInput
} from '@shared/classificationTypes'
import type { VideoQuery } from '@shared/videoTypes'
import { api, assetUrl } from '../api'
import { FACET_LABEL } from '../facet'
import BackButton from '../components/BackButton'
import ClassificationImageModal from '../components/ClassificationImageModal'
import EmptyState from '../components/EmptyState'
import ListSurface from '../components/ListSurface'
import ListToolbar from '../components/ListToolbar'
import OrganizationEditModal from '../components/OrganizationEditModal'
import OrganizationDeleteModal from '../components/OrganizationDeleteModal'
import OrganizationMergeModal from '../components/OrganizationMergeModal'
import { organizationMergeSuccessMessage } from '../components/organizationMergePresentation'
import PosterCard from '../components/PosterCard'
import { useToast } from '../components/Toast'
import { UI_ICON_SM } from '../components/iconDefaults'
import { useInfiniteVideoList } from '../query/useInfiniteVideoList'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { hashListQuery } from '../listView/listQueryParams'
import { navigateToFacetList } from '../listView/listNavigation'
import { ROUTE_MATCH } from '../listView/routePaths'
import { organizationKeys, seriesKeys, videoKeys } from '../query/queryKeys'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import Button from '../components/Button'

const STATUS_LABEL = {
  unknown: '状态未知',
  active: '运营中',
  inactive: '已停止'
} as const

function organizationRole(value: string | undefined): OrganizationRole | null {
  return value === 'maker' || value === 'publisher' ? value : null
}

export default function OrganizationDetailPage(): JSX.Element {
  const { type, organizationId: rawOrganizationId } = useParams()
  const role = organizationRole(type)
  const organizationId = Number(rawOrganizationId)
  const validId = Number.isInteger(organizationId) && organizationId > 0
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const videoStackOpen = Boolean(
    useMatch({ path: ROUTE_MATCH.organizationVideoStack, end: false })
  )
  const [editing, setEditing] = useState(false)
  const [editingImage, setEditingImage] = useState(false)
  const [mergingOrganization, setMergingOrganization] = useState(false)
  const [deleteAction, setDeleteAction] = useState<'role' | 'organization' | null>(null)
  const detailQuery = useQuery({
    queryKey: organizationKeys.detail(role, organizationId),
    queryFn: () => api.organizations.get(organizationId, role!),
    enabled: Boolean(role && validId)
  })
  const organization = detailQuery.data ?? null
  const videoQuery = useMemo<VideoQuery>(() => {
    if (role === 'maker') {
      return { makerOrganizationId: organizationId, sortBy: 'release_date', sortDir: 'desc' }
    }
    return { publisherOrganizationId: organizationId, sortBy: 'release_date', sortDir: 'desc' }
  }, [organizationId, role])
  const videoQueryHash = useMemo(
    () =>
      hashListQuery({
        scope: 'organization-detail',
        role: role ?? '',
        organizationId,
        sort: 'release_date',
        dir: 'desc'
      }),
    [organizationId, role]
  )
  const {
    ref: scrollRef,
    showScrollToTop,
    scrollToTop
  } = useScrollContainerMemory(`organization-detail:${videoQueryHash}`)
  const handlePageError = useCallback(
    (error: unknown) => toast.show(String((error as Error).message ?? error), 'error'),
    [toast]
  )
  const { videos, total, loading, loadingMore, hasMore, loadMore, refetchSilent } =
    useInfiniteVideoList(videoQuery, videoQueryHash, handlePageError, Boolean(role && validId))

  useListSurfaceRefetch(videoStackOpen, refetchSilent)
  const dismissEditing = useCallback(() => {
    setEditing(false)
    setEditingImage(false)
    setMergingOrganization(false)
    setDeleteAction(null)
  }, [])
  useDismissOverlaysOnNavigate(dismissEditing, location.pathname)

  const save = async (input: OrganizationUpdateInput): Promise<void> => {
    try {
      await api.organizations.update(organizationId, input)
      setEditing(false)
      toast.show('机构资料已更新', 'success')
      await queryClient.invalidateQueries({ queryKey: organizationKeys.all })
      void refetchSilent()
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    }
  }

  const merged = async (result: OrganizationMergeResult): Promise<void> => {
    setMergingOrganization(false)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: organizationKeys.all }),
      queryClient.invalidateQueries({ queryKey: seriesKeys.all }),
      queryClient.invalidateQueries({ queryKey: videoKeys.all })
    ])
    void refetchSilent()
    toast.show(
      result.cleanupFailures.length > 0
        ? '机构已合并，但来源品牌图清理失败，可稍后重试'
        : organizationMergeSuccessMessage(result),
      result.cleanupFailures.length > 0 ? 'info' : 'success'
    )
  }

  const roleRemoved = async (result: OrganizationRoleRemovalResult): Promise<void> => {
    setDeleteAction(null)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: organizationKeys.all }),
      queryClient.invalidateQueries({ queryKey: videoKeys.all })
    ])
    toast.show(`已移除${FACET_LABEL[result.role]}角色并解除 ${result.unlinkedVideoCount} 部影片关联`, 'success')
    navigateToFacetList(navigate, location, result.role)
  }

  const organizationDeleted = async (result: OrganizationDeleteResult): Promise<void> => {
    setDeleteAction(null)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: organizationKeys.all }),
      queryClient.invalidateQueries({ queryKey: seriesKeys.all }),
      queryClient.invalidateQueries({ queryKey: videoKeys.all })
    ])
    toast.show(
      result.cleanupFailures.length > 0
        ? '机构已删除，但品牌图清理失败，可稍后手动清理'
        : '机构已完整删除，相关影片和系列资料已保留',
      result.cleanupFailures.length > 0 ? 'info' : 'success'
    )
    if (role) navigateToFacetList(navigate, location, role)
  }

  const videoOverlay = videoStackOpen ? (
    <div className="detail-pane-overlay">
      <Outlet />
    </div>
  ) : null
  const renderState = (state: JSX.Element): JSX.Element => (
    <div className={`detail-pane${videoStackOpen ? ' detail-pane--stacked' : ''}`}>
      <div className="list-page">
        <ListSurface variant="scroll">{state}</ListSurface>
      </div>
      {videoOverlay}
    </div>
  )

  if (!role || !validId) {
    return renderState(
      <EmptyState icon={<SearchX {...UI_ICON_SM} aria-hidden />} title="参数无效" description="当前机构详情参数无法识别。" />
    )
  }
  if (detailQuery.isLoading) return renderState(<EmptyState loading />)
  if (detailQuery.isError) {
    return renderState(
      <EmptyState
        icon={<SearchX {...UI_ICON_SM} aria-hidden />}
        title="机构资料加载失败"
        description={String((detailQuery.error as Error).message ?? detailQuery.error)}
      />
    )
  }
  if (!organization) {
    return renderState(
      <EmptyState icon={<SearchX {...UI_ICON_SM} aria-hidden />} title="机构不存在" description="该机构可能已删除，或不属于当前入口。" />
    )
  }

  const image = assetUrl(organization.imagePath ?? organization.fallbackCoverPath)
  const label = FACET_LABEL[role]
  const years =
    organization.foundedYear || organization.endedYear
      ? `${organization.foundedYear ?? '未知'} - ${organization.endedYear ?? '至今'}`
      : null

  return (
    <div className={`detail-pane${videoStackOpen ? ' detail-pane--stacked' : ''}`}>
      <div className="list-page organization-detail-page">
        <div className="topbar">
          <ListToolbar
            leading={<BackButton variant="inline" onClick={() => navigateToFacetList(navigate, location, role)} />}
            title={organization.mainName}
            controls={
              <>
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
                  onClick={() => setMergingOrganization(true)}
                >
                  <GitMerge {...UI_ICON_SM} aria-hidden />
                  合并机构
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
                  <Pencil {...UI_ICON_SM} aria-hidden />
                  编辑资料
                </Button>
                <Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setDeleteAction('role')}
                >
                  <BadgeMinus {...UI_ICON_SM} aria-hidden />
                  移除{FACET_LABEL[role]}角色
                </Button>
                <Button
                  type="button"
                  variant="ghost"

                  size="sm"
                  onClick={() => setDeleteAction('organization')}
                >
                  <Trash2 {...UI_ICON_SM} aria-hidden />
                  完整删除机构
                </Button>
              </>
            }
            resultCount={
              <span className="count-badge count-badge--stable count-badge--media" aria-live="polite">
                共 {total} 部
              </span>
            }
          />
        </div>

        <ListSurface
          variant="scroll"
          scrollRef={scrollRef}
          innerClassName="organization-detail-scroll-inner"
          showScrollToTop={showScrollToTop}
          onScrollToTop={scrollToTop}
        >
          <section className="organization-profile" aria-label="机构资料">
            <div className="organization-profile-image">
              {image ? <img src={image} alt="" /> : <Inbox {...UI_ICON_SM} aria-hidden />}
            </div>
            <div className="organization-profile-main">
              <div className="organization-profile-kicker">{label}机构</div>
              <h1 className="selectable-text">{organization.mainName}</h1>
              <div className="organization-profile-meta selectable-text">
                <span>{STATUS_LABEL[organization.status]}</span>
                {organization.countryRegion ? <span>{organization.countryRegion}</span> : null}
                {years ? <span>{years}</span> : null}
                {organization.releaseYearStart ? (
                  <span>
                    本地发行：{organization.releaseYearStart}
                    {organization.releaseYearEnd !== organization.releaseYearStart
                      ? ` - ${organization.releaseYearEnd}`
                      : ''}
                  </span>
                ) : null}
              </div>
              {organization.aliases.length > 0 ? (
                <div className="organization-aliases selectable-text">
                  {organization.aliases.map((alias) => (
                    <span key={alias}>{alias}</span>
                  ))}
                </div>
              ) : null}
              {organization.summary ? (
                <p className="organization-summary selectable-text">{organization.summary}</p>
              ) : (
                <p className="organization-summary organization-summary--empty">暂无简介</p>
              )}
              {organization.links.length > 0 ? (
                <div className="organization-links">
                  {organization.links.map((link) => (
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
              ) : null}
            </div>
          </section>

          <div className="organization-video-heading">关联影片</div>
          {loading ? (
            <EmptyState loading variant="compact" />
          ) : videos.length === 0 ? (
            <EmptyState
              variant="compact"
              icon={<Inbox {...UI_ICON_SM} aria-hidden />}
              title="暂无关联影片"
              description={`该${label}角色当前没有关联影片，资料和角色仍会保留。`}
            />
          ) : (
            <>
              <div className="poster-grid organization-video-grid">
                {videos.map((video) => (
                  <PosterCard key={video.id} video={video} />
                ))}
              </div>
              {hasMore ? (
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
              ) : null}
            </>
          )}
        </ListSurface>

        {editing ? (
          <OrganizationEditModal
            role={role}
            organization={organization}
            onCancel={() => setEditing(false)}
            onSave={save}
          />
        ) : null}
        {editingImage ? (
          <ClassificationImageModal
            entity={{ kind: 'organization', id: organizationId }}
            entityLabel="机构"
            imagePath={organization.imagePath}
            fallbackCoverPath={organization.fallbackCoverPath}
            onCancel={() => setEditingImage(false)}
            onChanged={() => queryClient.invalidateQueries({ queryKey: organizationKeys.all })}
          />
        ) : null}
        {mergingOrganization ? (
          <OrganizationMergeModal
            target={organization}
            onCancel={() => setMergingOrganization(false)}
            onMerged={merged}
          />
        ) : null}
        {deleteAction === 'role' ? (
          <OrganizationDeleteModal
            mode="role"
            role={role}
            organizationName={organization.mainName}
            loadImpact={() => api.organizations.roleRemovalPreview(organizationId, role)}
            remove={() => api.organizations.removeRole(organizationId, role)}
            onCancel={() => setDeleteAction(null)}
            onCompleted={roleRemoved}
          />
        ) : null}
        {deleteAction === 'organization' ? (
          <OrganizationDeleteModal
            mode="organization"
            organizationName={organization.mainName}
            loadImpact={() => api.organizations.deletePreview(organizationId)}
            remove={() => api.organizations.remove(organizationId)}
            onCancel={() => setDeleteAction(null)}
            onCompleted={organizationDeleted}
          />
        ) : null}
      </div>
      {videoOverlay}
    </div>
  )
}
