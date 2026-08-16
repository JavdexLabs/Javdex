import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Outlet, useLocation, useMatch, useNavigate, useParams } from 'react-router-dom'
import { Inbox, Pencil, SearchCheck, SearchX } from 'lucide-react'
import { navigateBackFromActressDetail } from '../listView/listNavigation'
import { invalidateActressLibraryQueries } from '../query/invalidateLibraryQueries'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import { ROUTE_MATCH } from '../listView/routePaths'
import { buildActressScrapeMatchNameOptions } from '@shared/actressProfileOptions'
import type { ActressDetail } from '@shared/actressTypes'
import type { ActressDeleteResult } from '@shared/actressIpcContract'
import { api, assetUrl } from '../api'
import { useToast } from '../components/Toast'
import Modal from '../components/Modal'
import PosterCard from '../components/PosterCard'
import EditActressModal from '../components/EditActressModal'
import MergeActressModal from '../components/MergeActressModal'
import ScrapeFieldsModal from '../components/ScrapeFieldsModal'
import ActressName from '../components/ActressName'
import ActressAvatar from '../components/ActressAvatar'
import ActressDeleteModal from '../components/ActressDeleteModal'
import ActressGalleryPanel from '../components/ActressGalleryPanel'
import ActressProfileMeta, {
  buildActressProfileStats,
  buildActressProfileSubtitle,
  canMarkActressScrapeSuccess
} from '../components/ActressProfileMeta'
import DetailScrollBody from '../components/DetailScrollBody'
import ImagePreviewLightbox from '../components/ImagePreviewLightbox'
import { useHistoryBackedImagePreviewState } from '../components/ImagePreviewOverlayContext'
import DetailActionBar from '../components/DetailActionBar'
import EmptyState from '../components/EmptyState'
import { UI_ICON } from '../components/iconDefaults'
import { useAppBackground } from '../components/AppBackgroundContext'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { useScraperPluginCatalog } from '../hooks/useScraperPluginCatalog'
import { onAvatarAutoCropSaved } from '../avatarAutoCrop/events'
import type { ActressEditInput } from '@shared/actressTypes'
import type { ActressScrapeField, ActressScrapeUpdateMode } from '@shared/actressScrapeTypes'
import { resolveActressDetailDisplayBackgroundPath } from '@shared/detailDisplayBackground'
import { ACTRESS_SCRAPE_FIELD_OPTIONS, ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS, ALL_ACTRESS_SCRAPE_FIELDS } from '@shared/actressScrapeTypes'

export default function ActressDetailPage(): JSX.Element {
  const { id, actressId: actressIdParam } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const libraryActressStack = useMatch(ROUTE_MATCH.libraryActressStack)
  const organizationActressStack = useMatch(ROUTE_MATCH.organizationActressStack)
  const directorActressStack = useMatch(ROUTE_MATCH.directorActressStack)
  const seriesActressStack = useMatch(ROUTE_MATCH.seriesActressStack)
  const playlistActressStack = useMatch(ROUTE_MATCH.playlistActressStack)
  const actressActressStack = useMatch(ROUTE_MATCH.actressActressStack)
  const pendingActressStack = useMatch(ROUTE_MATCH.pendingActressStack)
  const actressVideoStack = useMatch({ path: ROUTE_MATCH.actressVideoStack, end: false })
  const fromVideo =
    libraryActressStack ??
    organizationActressStack ??
    directorActressStack ??
    seriesActressStack ??
    playlistActressStack ??
    actressActressStack ??
    pendingActressStack
  const videoStackOpen = !fromVideo && Boolean(actressVideoStack)
  const actressId = Number(actressIdParam ?? id)

  const toast = useToast()
  const queryClient = useQueryClient()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const { setBackground, clearBackground } = useAppBackground()
  const [actress, setActress] = useState<ActressDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showMerge, setShowMerge] = useState(false)
  const [scraping, setScraping] = useState(false)
  const { scrapers, pluginDetails, defaultScraper } = useScraperPluginCatalog('actress')
  const [scraperName, setScraperName] = useState('')
  const [actressDetailUseFirstGalleryBackground, setActressDetailUseFirstGalleryBackground] =
    useState(true)
  const [showScrapeFields, setShowScrapeFields] = useState(false)
  const [activeTab, setActiveTab] = useState<'gallery' | 'videos'>('videos')
  const {
    isOpen: avatarPreviewOpen,
    isEnabled: avatarPreviewEnabled,
    open: openAvatarPreview,
    close: closeAvatarPreview
  } = useHistoryBackedImagePreviewState()

  const dismissOverlays = useCallback(() => {
    setConfirmDelete(false)
    setConfirmClear(false)
    setShowEdit(false)
    setShowMerge(false)
    setShowScrapeFields(false)
    closeAvatarPreview()
  }, [closeAvatarPreview])

  useDismissOverlaysOnNavigate(dismissOverlays, location.pathname)

  const load = useCallback(
    (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false
      if (!silent) setLoading(true)
      return api.actresses
        .get(actressId)
        .then(setActress)
        .catch((e) => toastRef.current.show(String(e.message ?? e), 'error'))
        .finally(() => {
          if (!silent) setLoading(false)
        })
    },
    [actressId]
  )

  useEffect(() => {
    void load()
  }, [actressId, load])

  useEffect(
    () =>
      onAvatarAutoCropSaved((updatedActressId) => {
        if (updatedActressId === actressId) void load({ silent: true })
      }),
    [actressId, load]
  )

  const scrollMemoryKey = `actress-detail:${actressId}`
  const { ref: scrollRef } = useScrollContainerMemory(scrollMemoryKey)

  useListSurfaceRefetch(videoStackOpen, () => {
    void load({ silent: true })
  })

  useLayoutEffect(() => {
    const scope = `actress:${actressId}`
    return () => clearBackground(scope)
  }, [actressId, clearBackground])

  useEffect(() => {
    const scope = `actress:${actressId}`
    if (!actress) return
    const path = resolveActressDetailDisplayBackgroundPath(
      actress,
      actressDetailUseFirstGalleryBackground
    )
    if (path) setBackground(scope, { path, label: actress.main_name })
    else clearBackground(scope)
  }, [actress, actressId, actressDetailUseFirstGalleryBackground, clearBackground, setBackground])

  useEffect(() => {
    if (defaultScraper) {
      setScraperName((prev) => prev || defaultScraper)
    }
  }, [defaultScraper])

  useEffect(() => {
    api.settings
      .get()
      .then((settings) => {
        setActressDetailUseFirstGalleryBackground(settings.actressDetailUseFirstGalleryBackground)
      })
      .catch(() => {})
  }, [])

  const handleScrape = async (
    fields: ActressScrapeField[],
    site: string,
    mode?: ActressScrapeUpdateMode,
    queryName?: string,
    _missingFields?: ActressScrapeField[],
    useAliases?: boolean,
    autoCropAvatar = false
  ): Promise<void> => {
    setShowScrapeFields(false)
    setScraperName(site)
    setScraping(true)
    try {
      const outcome = await api.actressScrape.one(
        actressId,
        site || undefined,
        fields,
        mode,
        queryName,
        useAliases,
        autoCropAvatar
      )
      if (outcome.status === 'pending') {
        toast.show('发现名称冲突，结果已保存到待确认', 'info')
      } else if (outcome.status === 'failure') {
        toast.show(`匹配失败：${outcome.error}`, 'error')
      } else if (outcome.skipped) {
        toast.show('没有可补齐的字段', 'info')
      } else {
        toast.show('匹配完成', 'success')
      }
    } catch (e) {
      toast.show(`匹配失败：${(e as Error).message}`, 'error')
    } finally {
      void invalidateActressLibraryQueries(queryClient)
      await load({ silent: true })
      setScraping(false)
    }
  }

  const handleDeleted = (result: ActressDeleteResult): void => {
    toast.show('已删除该演员', 'success')
    if (result.cleanupFailures.length > 0) {
      const first = result.cleanupFailures[0]
      toast.show(
        `${result.cleanupFailures.length} 个演员资源清理失败：${first.path}（${first.error}）`,
        'info'
      )
    }
    void invalidateActressLibraryQueries(queryClient)
    navigateBackFromActressDetail(navigate, location)
  }

  const handleEditSave = async (input: ActressEditInput): Promise<void> => {
    try {
      await api.actresses.edit(actressId, input)
      toast.show('演员资料已保存', 'success')
      setShowEdit(false)
      void load({ silent: true })
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const handleMarkScrapeSuccess = async (): Promise<void> => {
    try {
      await api.actresses.markScrapeSuccess(actressId)
      toast.show('已标记为刮削成功', 'success')
      void invalidateActressLibraryQueries(queryClient)
      await load({ silent: true })
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const doClearMeta = async (): Promise<void> => {
    try {
      await api.actresses.clearMeta(actressId)
      setConfirmClear(false)
      toast.show('已清除元数据', 'success')
      void invalidateActressLibraryQueries(queryClient)
      void load({ silent: true })
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const scrapeMatchNameOptions = useMemo(
    () => (actress ? buildActressScrapeMatchNameOptions(actress) : []),
    [actress]
  )

  const handleBack = useCallback((): void => {
    navigateBackFromActressDetail(navigate, location)
  }, [location, navigate])

  const videoOverlay = videoStackOpen ? (
    <div className="detail-pane-overlay">
      <Outlet />
    </div>
  ) : null

  if (loading) {
    return (
      <div className={`detail-pane${videoStackOpen ? ' detail-pane--stacked' : ''}`}>
        <DetailScrollBody scrollRef={scrollRef} onBack={handleBack}>
          <EmptyState loading />
        </DetailScrollBody>
        {videoOverlay}
      </div>
    )
  }
  if (!actress) {
    return (
      <div className={`detail-pane${videoStackOpen ? ' detail-pane--stacked' : ''}`}>
        <DetailScrollBody scrollRef={scrollRef} onBack={handleBack}>
          <EmptyState
            icon={<SearchX {...UI_ICON} aria-hidden />}
            title="未找到该演员"
            description="该演员可能已被删除或合并。"
          />
        </DetailScrollBody>
        {videoOverlay}
      </div>
    )
  }

  const avatar = assetUrl(actress.avatar_path)
  const avatarPreview = assetUrl(actress.avatar_source_path) ?? avatar
  const profileSubtitle = buildActressProfileSubtitle(actress)
  const profileStats = buildActressProfileStats(actress)

  const onAvatarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!avatarPreview || !avatarPreviewEnabled || e.defaultPrevented) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openAvatarPreview()
    }
  }

  const profileActions = (
    <DetailActionBar
      ariaLabel="演员操作"
      variant="inline"
      actions={[
        {
          key: 'edit',
          icon: <Pencil {...UI_ICON} />,
          label: '编辑',
          onClick: () => setShowEdit(true)
        },
        {
          key: 'scrape',
          icon: <SearchCheck {...UI_ICON} />,
          label: '修正匹配',
          title: scraping ? '匹配中…' : '修正匹配',
          busy: scraping,
          disabled: scraping,
          onClick: () => setShowScrapeFields(true)
        }
      ]}
      menuItems={[
        {
          key: 'merge',
          label: '合并演员',
          onClick: () => setShowMerge(true)
        },
        {
          key: 'mark-success',
          label: '标记为刮削成功',
          hidden: !canMarkActressScrapeSuccess(actress.scraped_status),
          onClick: () => {
            void handleMarkScrapeSuccess()
          }
        },
        { key: 'danger-separator', type: 'separator' },
        {
          key: 'clear-meta',
          label: '清除元数据',
          danger: true,
          onClick: () => setConfirmClear(true)
        },
        {
          key: 'delete',
          label: '删除演员',
          danger: true,
          onClick: () => setConfirmDelete(true)
        }
      ]}
    />
  )

  return (
    <div className={`detail-pane${videoStackOpen ? ' detail-pane--stacked' : ''}`}>
      <DetailScrollBody scrollRef={scrollRef} onBack={handleBack}>
      <div className="actress-profile-layout">
        <div className="actress-profile-header">
          <div
            className={`detail-avatar-frame${
              avatarPreview && avatarPreviewEnabled ? ' detail-avatar-frame--preview' : ''
            }`}
            role={avatarPreview && avatarPreviewEnabled ? 'button' : undefined}
            aria-label={
              avatarPreview && avatarPreviewEnabled
                ? `查看原图：${actress.main_name}`
                : undefined
            }
            tabIndex={avatarPreview && avatarPreviewEnabled ? 0 : undefined}
            title={avatarPreview && avatarPreviewEnabled ? '查看原图' : undefined}
            onClick={() => {
              if (avatarPreview && avatarPreviewEnabled) openAvatarPreview()
            }}
            onKeyDown={onAvatarKeyDown}
          >
            <ActressAvatar
              src={avatar}
              name={actress.main_name}
              gender={actress.gender}
              className="detail-avatar-lg"
            />
          </div>
          <div className="actress-profile-head">
            <h1 className="detail-title actress-profile-title">
              <ActressName name={actress.main_name} gender={actress.gender} />
            </h1>
            {profileSubtitle && <p className="actress-profile-subtitle">{profileSubtitle}</p>}
            {profileStats.length > 0 && (
              <div className="actress-profile-stats" aria-label="概要">
                {profileStats.map((stat) => (
                  <span key={stat} className="actress-profile-stat">
                    {stat}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="actress-profile-actions">{profileActions}</div>
        </div>

        <ActressProfileMeta actress={actress} />
      </div>

      <div className="actress-detail-tabs" role="tablist" aria-label="演员详情内容">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'videos'}
          className={activeTab === 'videos' ? 'active' : ''}
          onClick={() => setActiveTab('videos')}
        >
          出演作品
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'gallery'}
          className={activeTab === 'gallery' ? 'active' : ''}
          onClick={() => setActiveTab('gallery')}
        >
          写真
        </button>
      </div>

      {activeTab === 'videos' ? (
        actress.videos.length === 0 ? (
          <EmptyState
            variant="compact"
            icon={<Inbox {...UI_ICON} aria-hidden />}
            title="暂无关联影片"
            description="影片刮削后会自动建立关联。"
          />
        ) : (
          <div className="poster-grid">
            {actress.videos.map((v) => (
              <PosterCard key={v.id} video={v} />
            ))}
          </div>
        )
      ) : (
        <ActressGalleryPanel
          actressId={actress.id}
          gallery={actress.gallery}
          posterPath={actress.poster_path}
          onChanged={() => {
            void load({ silent: true })
          }}
        />
      )}
      </DetailScrollBody>

      {avatarPreviewOpen && avatarPreview && (
        <ImagePreviewLightbox
          items={[{ id: actress.id, src: avatarPreview }]}
          index={0}
          onClose={closeAvatarPreview}
          onIndexChange={() => {}}
          labels={{
            dialog: '查看演员原图',
            filmstrip: '演员原图',
            thumb: () => `原图：${actress.main_name}`
          }}
        />
      )}

      {videoOverlay}

      {showScrapeFields && (
        <ScrapeFieldsModal
          title="修正匹配"
          hint="先确定站点与更新方式，再勾选要写入的字段。"
          options={ACTRESS_SCRAPE_FIELD_OPTIONS}
          scrapers={scrapers}
          pluginDetails={pluginDetails}
          initialScraperName={scraperName}
          initialSelected={ALL_ACTRESS_SCRAPE_FIELDS}
          scraperTitle="演员刮削站点"
          updateModeOptions={ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS}
          initialUpdateMode="fillEmpty"
          matchNameOptions={
            scrapeMatchNameOptions.length > 1 ? scrapeMatchNameOptions : undefined
          }
          initialMatchName={actress.main_name}
          matchNameHint="默认使用主名在站点搜索资料，也可改用别名尝试匹配。"
          showUseAliasesToggle
          useAliasesHint="开启后，主名未匹配时会依次尝试中文名、英文名及已存别名。"
          showAutoCropAvatarToggle
          autoCropAvatarHint="头像保存后立即按“外观”中的智能构图设置完成裁切。"
          onCancel={() => setShowScrapeFields(false)}
          onConfirm={(
            fields,
            site,
            _scope,
            mode,
            _missing,
            queryName,
            useAliases,
            _auxScope,
            autoCropAvatar
          ) => {
            void handleScrape(
              fields,
              site,
              mode as ActressScrapeUpdateMode | undefined,
              queryName,
              undefined,
              useAliases,
              autoCropAvatar
            )
          }}
        />
      )}

      {showEdit && (
        <EditActressModal
          actress={actress}
          onCancel={() => setShowEdit(false)}
          onSave={handleEditSave}
        />
      )}

      {showMerge && (
        <MergeActressModal
          keepActress={actress}
          onCancel={() => setShowMerge(false)}
          onMerged={() => {
            setShowMerge(false)
            toast.show('演员已合并', 'success')
            void invalidateActressLibraryQueries(queryClient)
            void load({ silent: true })
          }}
        />
      )}

      {confirmClear && (
        <Modal
          title="清除元数据"
          danger
          confirmText="清除"
          onConfirm={() => {
            void doClearMeta()
          }}
          onCancel={() => setConfirmClear(false)}
        >
          确定要清除「{actress.main_name}」的所有刮削元数据吗？将清空头像、写真、简介、三围、别名等资料（不影响主名、性别、影片关联与相关链接）。
        </Modal>
      )}

      {confirmDelete && (
        <ActressDeleteModal
          ids={[actress.id]}
          subjectLabel={`演员「${actress.main_name}」`}
          onCancel={() => setConfirmDelete(false)}
          onDeleted={(result) => {
            setConfirmDelete(false)
            handleDeleted(result)
          }}
        />
      )}
    </div>
  )
}
