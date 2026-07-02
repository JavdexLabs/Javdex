import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Outlet, useLocation, useMatch, useNavigate, useParams } from 'react-router-dom'
import { Ellipsis, Pencil, SearchCheck } from 'lucide-react'
import {
  actressVideoDetailPath,
  parseActressVideoPath
} from '../listView/actressRoutes'
import { facetVideoDetailPath, parseFacetVideoPath } from '../listView/facetRoutes'
import { libraryVideoDetailPath } from '../listView/libraryRoutes'
import { playlistVideoDetailPath, parsePlaylistVideoPath } from '../listView/playlistRoutes'
import { navigateToActressList } from '../listView/listNavigation'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import { ROUTE_MATCH } from '../listView/routePaths'
import { buildActressScrapeMatchNameOptions } from '@shared/actressProfileOptions'
import type { ActressDetail } from '@shared/types'
import { api, assetUrl } from '../api'
import { useToast } from '../components/Toast'
import Modal from '../components/Modal'
import PosterCard from '../components/PosterCard'
import EditActressModal from '../components/EditActressModal'
import MergeActressModal from '../components/MergeActressModal'
import ScrapeFieldsModal from '../components/ScrapeFieldsModal'
import ActressName from '../components/ActressName'
import ActressAvatar from '../components/ActressAvatar'
import ActressGalleryPanel from '../components/ActressGalleryPanel'
import ActressProfileMeta, {
  buildActressProfileStats,
  buildActressProfileSubtitle
} from '../components/ActressProfileMeta'
import DetailScrollBody from '../components/DetailScrollBody'
import ImagePreviewLightbox from '../components/ImagePreviewLightbox'
import IconButton from '../components/IconButton'
import { UI_ICON } from '../components/iconDefaults'
import { useAppBackground } from '../components/AppBackgroundContext'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import type {
  ActressEditInput,
  ActressScrapeField,
  ActressScrapeUpdateMode
} from '@shared/types'
import { resolveActressDetailDisplayBackgroundPath } from '@shared/detailDisplayBackground'
import {
  ACTRESS_SCRAPE_FIELD_OPTIONS,
  ACTRESS_SCRAPE_UPDATE_MODE_HINT,
  ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS,
  ALL_ACTRESS_SCRAPE_FIELDS
} from '@shared/types'

export default function ActressDetailPage(): JSX.Element {
  const { id, actressId: actressIdParam } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const libraryActressStack = useMatch(ROUTE_MATCH.libraryActressStack)
  const facetActressStack = useMatch(ROUTE_MATCH.facetActressStack)
  const playlistActressStack = useMatch(ROUTE_MATCH.playlistActressStack)
  const actressActressStack = useMatch(ROUTE_MATCH.actressActressStack)
  const actressVideoStack = useMatch({ path: ROUTE_MATCH.actressVideoStack, end: false })
  const fromVideo =
    libraryActressStack ?? facetActressStack ?? playlistActressStack ?? actressActressStack
  const actressVideoPath = parseActressVideoPath(location.pathname)
  const fromVideoId = fromVideo
    ? Number(actressVideoPath?.videoId ?? fromVideo.params.id)
    : undefined
  const videoStackOpen = !fromVideo && Boolean(actressVideoStack)
  const actressId = Number(actressIdParam ?? id)

  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const { setBackground, clearBackground } = useAppBackground()
  const [actress, setActress] = useState<ActressDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showMerge, setShowMerge] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreActionsRef = useRef<HTMLDivElement>(null)
  const [scraping, setScraping] = useState(false)
  const [scrapers, setScrapers] = useState<string[]>([])
  const [scraperName, setScraperName] = useState('')
  const [actressDetailUseFirstGalleryBackground, setActressDetailUseFirstGalleryBackground] =
    useState(true)
  const [showScrapeFields, setShowScrapeFields] = useState(false)
  const [activeTab, setActiveTab] = useState<'gallery' | 'videos'>('videos')
  const [avatarPreviewOpen, setAvatarPreviewOpen] = useState(false)

  const dismissOverlays = useCallback(() => {
    setConfirmDelete(false)
    setConfirmClear(false)
    setShowEdit(false)
    setShowMerge(false)
    setMoreOpen(false)
    setShowScrapeFields(false)
    setAvatarPreviewOpen(false)
  }, [])

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
    Promise.all([api.actressScrape.listPlugins(), api.settings.get()])
      .then(([list, settings]) => {
        setScrapers(list)
        setScraperName(settings.defaultActressScraper || list[0] || '')
        setActressDetailUseFirstGalleryBackground(settings.actressDetailUseFirstGalleryBackground)
      })
      .catch(() => {})
  }, [])

  useEscapeKey(() => setMoreOpen(false), moreOpen)

  useEffect(() => {
    if (!moreOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!moreActionsRef.current?.contains(e.target as Node)) {
        setMoreOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [moreOpen])

  const handleScrape = async (
    fields: ActressScrapeField[],
    site: string,
    mode?: ActressScrapeUpdateMode,
    queryName?: string,
    _missingFields?: ActressScrapeField[],
    useAliases?: boolean
  ): Promise<void> => {
    setShowScrapeFields(false)
    setScraperName(site)
    setScraping(true)
    try {
      await api.actressScrape.one(
        actressId,
        site || undefined,
        fields,
        mode,
        queryName,
        useAliases
      )
      toast.show('匹配完成', 'success')
      void load({ silent: true })
    } catch (e) {
      toast.show(`匹配失败：${(e as Error).message}`, 'error')
    } finally {
      setScraping(false)
    }
  }

  const doDelete = async (): Promise<void> => {
    try {
      await api.actresses.remove(actressId)
      toast.show('已删除该演员', 'success')
      if (fromVideoId != null && !Number.isNaN(fromVideoId)) {
        const facet = parseFacetVideoPath(location.pathname)
        const playlist = parsePlaylistVideoPath(location.pathname)
        const actress = parseActressVideoPath(location.pathname)
        const pathname =
          facet?.videoId != null
            ? facetVideoDetailPath(
                facet.facetType,
                decodeURIComponent(facet.valueKey),
                fromVideoId
              )
            : playlist?.videoId != null
              ? playlistVideoDetailPath(playlist.playlistId, fromVideoId)
              : actress?.videoId != null
                ? actressVideoDetailPath(actress.actressId, fromVideoId)
              : libraryVideoDetailPath(fromVideoId)
        navigate({ pathname, search: location.search })
      } else {
        navigateToActressList(navigate, location)
      }
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
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

  const doClearMeta = async (): Promise<void> => {
    try {
      await api.actresses.clearMeta(actressId)
      setConfirmClear(false)
      toast.show('已清除元数据', 'success')
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
    if (fromVideoId != null && !Number.isNaN(fromVideoId)) {
      const facet = parseFacetVideoPath(location.pathname)
      const playlist = parsePlaylistVideoPath(location.pathname)
      const actressRoute = parseActressVideoPath(location.pathname)
      const pathname =
        facet?.videoId != null
          ? facetVideoDetailPath(
              facet.facetType,
              decodeURIComponent(facet.valueKey),
              fromVideoId
            )
          : playlist?.videoId != null
            ? playlistVideoDetailPath(playlist.playlistId, fromVideoId)
            : actressRoute?.videoId != null
              ? actressVideoDetailPath(actressRoute.actressId, fromVideoId)
              : libraryVideoDetailPath(fromVideoId)
      navigate({ pathname, search: location.search })
      return
    }
    navigateToActressList(navigate, location)
  }, [fromVideoId, location, navigate])

  const videoOverlay = videoStackOpen ? (
    <div className="detail-pane-overlay">
      <Outlet />
    </div>
  ) : null

  if (loading) {
    return (
      <div className={`detail-pane${videoStackOpen ? ' detail-pane--stacked' : ''}`}>
        <DetailScrollBody scrollRef={scrollRef} onBack={handleBack}>
          <div className="empty-state">
            <div className="spinner" />
          </div>
        </DetailScrollBody>
        {videoOverlay}
      </div>
    )
  }
  if (!actress) {
    return (
      <div className={`detail-pane${videoStackOpen ? ' detail-pane--stacked' : ''}`}>
        <DetailScrollBody scrollRef={scrollRef} onBack={handleBack}>
          <div className="empty-state">
            <div>未找到该演员</div>
          </div>
        </DetailScrollBody>
        {videoOverlay}
      </div>
    )
  }

  const avatar = assetUrl(actress.avatar_path)
  const canDelete = actress.videos.length === 0
  const profileSubtitle = buildActressProfileSubtitle(actress)
  const profileStats = buildActressProfileStats(actress)

  const onAvatarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!avatar || e.defaultPrevented) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setAvatarPreviewOpen(true)
    }
  }

  const profileActions = (
    <>
      <div className="detail-action-group detail-action-group--icons" role="group" aria-label="演员操作">
        <IconButton
          className="detail-icon-action"
          icon={<Pencil {...UI_ICON} />}
          label="编辑"
          onClick={() => setShowEdit(true)}
        />
        <IconButton
          className="detail-icon-action"
          icon={<SearchCheck {...UI_ICON} />}
          label="修正匹配"
          title={scraping ? '匹配中…' : '修正匹配'}
          aria-busy={scraping || undefined}
          disabled={scraping}
          onClick={() => setShowScrapeFields(true)}
        />
      </div>
      <div className="detail-more-actions" ref={moreActionsRef}>
        <IconButton
          className="detail-icon-action"
          icon={<Ellipsis {...UI_ICON} />}
          label="更多"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        />
        {moreOpen && (
          <div className="detail-more-menu" role="menu">
            <button
              type="button"
              className="detail-menu-item"
              role="menuitem"
              onClick={() => {
                setMoreOpen(false)
                setShowMerge(true)
              }}
            >
              合并演员
            </button>
            <div className="detail-menu-separator" />
            <button
              type="button"
              className="detail-menu-item detail-menu-item--danger"
              role="menuitem"
              onClick={() => {
                setMoreOpen(false)
                setConfirmClear(true)
              }}
            >
              清除元数据
            </button>
            {canDelete && (
              <button
                type="button"
                className="detail-menu-item detail-menu-item--danger"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false)
                  setConfirmDelete(true)
                }}
              >
                删除演员
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )

  return (
    <div className={`detail-pane${videoStackOpen ? ' detail-pane--stacked' : ''}`}>
      <DetailScrollBody scrollRef={scrollRef} onBack={handleBack}>
      <div className="actress-profile-layout">
        <div className="actress-profile-header">
          <div
            className={`detail-avatar-frame${avatar ? ' detail-avatar-frame--preview' : ''}`}
            role={avatar ? 'button' : undefined}
            aria-label={avatar ? `查看头像：${actress.main_name}` : undefined}
            tabIndex={avatar ? 0 : undefined}
            title={avatar ? '查看头像' : undefined}
            onClick={() => {
              if (avatar) setAvatarPreviewOpen(true)
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
            <div className="actress-profile-title-row">
              <h1 className="detail-title actress-profile-title">
                <ActressName name={actress.main_name} gender={actress.gender} />
              </h1>
              <div className="actress-profile-actions">{profileActions}</div>
            </div>
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
          <div className="empty-state empty-state--compact">
            <div>暂无关联影片</div>
          </div>
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

      {avatarPreviewOpen && avatar && (
        <ImagePreviewLightbox
          items={[{ id: actress.id, src: avatar }]}
          index={0}
          onClose={() => setAvatarPreviewOpen(false)}
          onIndexChange={() => {}}
          labels={{
            dialog: '查看演员头像',
            filmstrip: '演员头像',
            thumb: () => `头像：${actress.main_name}`
          }}
        />
      )}

      {videoOverlay}

      {showScrapeFields && (
        <ScrapeFieldsModal
          title="修正匹配"
          options={ACTRESS_SCRAPE_FIELD_OPTIONS}
          scrapers={scrapers}
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
          onCancel={() => setShowScrapeFields(false)}
          onConfirm={(fields, site, _scope, mode, _missing, queryName, useAliases) => {
            void handleScrape(
              fields,
              site,
              mode as ActressScrapeUpdateMode | undefined,
              queryName,
              undefined,
              useAliases
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
          确定要清除「{actress.main_name}」的所有刮削元数据吗？将清空头像、写真、简介、三围、别名等资料（不影响主名、性别与影片关联）。
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          title="删除演员"
          danger
          confirmText="删除"
          onConfirm={() => {
            setConfirmDelete(false)
            void doDelete()
          }}
          onCancel={() => setConfirmDelete(false)}
        >
          确定要删除「{actress.main_name}」吗？该演员没有关联影片，删除后不可恢复。
        </Modal>
      )}
    </div>
  )
}
