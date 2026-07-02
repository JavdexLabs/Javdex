import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Outlet, useLocation, useMatch, useNavigate, useParams } from 'react-router-dom'
import { Ellipsis, ListPlus, Pencil, SearchCheck } from 'lucide-react'
import type { VideoDetail } from '@shared/types'
import { api, assetUrl } from '../api'
import { useToast } from '../components/Toast'
import StarRating from '../components/StarRating'
import Modal from '../components/Modal'
import EditMetadataModal from '../components/EditMetadataModal'
import ScrapeFieldsModal from '../components/ScrapeFieldsModal'
import ActressName from '../components/ActressName'
import VideoSampleGallery from '../components/VideoSampleGallery'
import VideoTagPanel from '../components/VideoTagPanel'
import AddToPlaylistModal from '../components/AddToPlaylistModal'
import DetailScrollBody from '../components/DetailScrollBody'
import MetaLink from '../components/MetaLink'
import ImagePreviewLightbox from '../components/ImagePreviewLightbox'
import IconButton from '../components/IconButton'
import { UI_ICON } from '../components/iconDefaults'
import { useAppBackground } from '../components/AppBackgroundContext'
import ActressAvatar from '../components/ActressAvatar'
import type { FacetType, VideoEditInput, VideoScrapeField, VideoScrapeUpdateMode } from '@shared/types'
import {
  VIDEO_SCRAPE_FIELD_OPTIONS,
  VIDEO_SCRAPE_UPDATE_MODE_HINT,
  VIDEO_SCRAPE_UPDATE_MODE_OPTIONS,
  ALL_VIDEO_SCRAPE_FIELDS
} from '@shared/types'
import { splitVideoCode } from '@shared/codeUtils'
import { resolveVideoDetailDisplayBackgroundPath } from '@shared/detailDisplayBackground'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import {
  navigateBackFromVideoDetail,
  navigateToActressFromVideoDetail,
  navigateToFacetDetail,
  navigateToLibrary,
  navigateToVideoDetail
} from '../listView/listNavigation'
import { LIST_PARAM } from '../listView/listQueryParams'
import { ROUTE_MATCH } from '../listView/routePaths'
import { facetKeys, videoKeys } from '../query/queryKeys'

/** Renders a maker/publisher/series/director value as a link to its facet detail page. */
function FacetValue({ type, value }: { type: FacetType; value: string | null }): JSX.Element {
  const navigate = useNavigate()
  if (!value) return <span className="meta-val">—</span>
  return (
    <MetaLink onClick={() => navigateToFacetDetail(navigate, type, value)}>{value}</MetaLink>
  )
}

export default function DetailPage(): JSX.Element {
  const { id, videoId: videoIdParam } = useParams()
  const videoId = Number(videoIdParam ?? id)
  const navigate = useNavigate()
  const location = useLocation()
  const libraryActressStack = useMatch(ROUTE_MATCH.libraryActressStack)
  const facetActressStack = useMatch(ROUTE_MATCH.facetActressStack)
  const playlistActressStack = useMatch(ROUTE_MATCH.playlistActressStack)
  const actressVideoActressStack = useMatch(ROUTE_MATCH.actressActressStack)
  const actressStackOpen = Boolean(
    libraryActressStack ?? facetActressStack ?? playlistActressStack ?? actressVideoActressStack
  )
  const queryClient = useQueryClient()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const { setBackground, clearBackground } = useAppBackground()

  const invalidateVideos = (): void => {
    void queryClient.invalidateQueries({ queryKey: videoKeys.all })
    void queryClient.invalidateQueries({ queryKey: facetKeys.all })
  }

  const [video, setVideo] = useState<VideoDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [scraping, setScraping] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [missingPrompt, setMissingPrompt] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [scrapers, setScrapers] = useState<string[]>([])
  const [videoDetailUseFirstSampleBackground, setVideoDetailUseFirstSampleBackground] =
    useState(false)
  const [scraperName, setScraperName] = useState<string>('')
  const [showScrapeFields, setShowScrapeFields] = useState(false)
  const [showCorrectImport, setShowCorrectImport] = useState(false)
  const [showAddToPlaylist, setShowAddToPlaylist] = useState(false)
  const [correctCode, setCorrectCode] = useState('')
  const [correcting, setCorrecting] = useState(false)
  const [tallCover, setTallCover] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [coverPreviewOpen, setCoverPreviewOpen] = useState(false)
  const moreActionsRef = useRef<HTMLDivElement>(null)

  const dismissOverlays = useCallback(() => {
    setConfirmDelete(false)
    setMissingPrompt(false)
    setShowEdit(false)
    setConfirmClear(false)
    setShowScrapeFields(false)
    setShowCorrectImport(false)
    setShowAddToPlaylist(false)
    setCoverPreviewOpen(false)
    setMoreOpen(false)
  }, [])

  useDismissOverlaysOnNavigate(dismissOverlays, location.pathname)

  useEscapeKey(() => setMoreOpen(false), moreOpen)

  useEffect(() => {
    Promise.all([api.scrape.listPlugins(), api.settings.get()])
      .then(([list, settings]) => {
        setScrapers(list)
        setScraperName(settings.defaultScraper || list[0] || '')
        setVideoDetailUseFirstSampleBackground(settings.videoDetailUseFirstSampleBackground)
      })
      .catch(() => {})
  }, [])

  const load = useCallback(
    (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false
      if (!silent) setLoading(true)
      return api.videos
        .get(videoId)
        .then(setVideo)
        .catch((e) => toastRef.current.show(String(e.message ?? e), 'error'))
        .finally(() => {
          if (!silent) setLoading(false)
        })
    },
    [videoId]
  )

  useListSurfaceRefetch(actressStackOpen, () => {
    void load({ silent: true })
  })

  useEffect(() => {
    void load()
  }, [videoId, load])

  useLayoutEffect(() => {
    const scope = `video:${videoId}`
    return () => clearBackground(scope)
  }, [clearBackground, videoId])

  useEffect(() => {
    const scope = `video:${videoId}`
    if (!video) return
    const path = resolveVideoDetailDisplayBackgroundPath(
      video,
      videoDetailUseFirstSampleBackground
    )
    if (path) setBackground(scope, { path, label: video.code })
    else clearBackground(scope)
  }, [video, videoId, videoDetailUseFirstSampleBackground, clearBackground, setBackground])

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

  const cover = assetUrl(video?.cover_path ?? null)

  useEffect(() => {
    setTallCover(false)
  }, [cover])

  const onCoverLoad = (e: React.SyntheticEvent<HTMLImageElement>): void => {
    const img = e.currentTarget
    setTallCover(img.naturalHeight > img.naturalWidth)
  }

  const onCoverKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!cover || e.defaultPrevented) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setCoverPreviewOpen(true)
    }
  }

  const handlePlay = async (): Promise<void> => {
    try {
      const res = await api.player.play(videoId)
      if (res.ok) {
        toast.show('已唤起系统播放器', 'success')
        void load({ silent: true })
      } else if (res.fileMissing) {
        setMissingPrompt(true)
      } else {
        toast.show(res.error ?? '播放失败', 'error')
      }
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const handleReveal = async (): Promise<void> => {
    setMoreOpen(false)
    try {
      const res = await api.player.reveal(videoId)
      if (!res.ok) toast.show(res.error ?? '打开文件夹失败', 'error')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const handleRescrape = async (
    fields: VideoScrapeField[],
    site: string,
    mode?: VideoScrapeUpdateMode
  ): Promise<void> => {
    setShowScrapeFields(false)
    setScraperName(site)
    setScraping(true)
    try {
      const res = await api.scrape.one(videoId, site || undefined, fields, mode)
      toast.show(
        res.applied ? '匹配完成' : '无可补齐的空字段，未写入变更',
        res.applied ? 'success' : 'info'
      )
      if (res.applied) {
        invalidateVideos()
        void load({ silent: true })
      }
    } catch (e) {
      toast.show(`匹配失败：${(e as Error).message}`, 'error')
    } finally {
      setScraping(false)
    }
  }

  const handleRating = async (rating: number): Promise<void> => {
    try {
      await api.videos.setRating(videoId, rating)
      setVideo((v) => (v ? { ...v, rating } : v))
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const handleEditSave = async (input: VideoEditInput): Promise<void> => {
    try {
      await api.videos.edit(videoId, input)
      setShowEdit(false)
      toast.show('元数据已保存', 'success')
      invalidateVideos()
      void load({ silent: true })
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const doClearMeta = async (): Promise<void> => {
    try {
      await api.videos.clearMeta(videoId)
      setConfirmClear(false)
      toast.show('已清除元数据', 'success')
      invalidateVideos()
      void load({ silent: true })
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const doDelete = async (): Promise<void> => {
    try {
      await api.videos.remove(videoId)
      toast.show('已删除影片', 'success')
      invalidateVideos()
      navigateBackFromVideoDetail(navigate, location)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const openCorrectImport = (): void => {
    setCorrectCode(video?.code ?? '')
    setShowCorrectImport(true)
  }

  const doCorrectImport = async (): Promise<void> => {
    const trimmed = correctCode.trim()
    if (!trimmed) {
      toast.show('番号不能为空', 'error')
      return
    }
    setCorrecting(true)
    try {
      const res = await api.videos.correctImport(videoId, trimmed)
      setShowCorrectImport(false)
      if (res.mergedIntoId) {
        toast.show(`番号已修正为 ${res.code}（已合并到已有记录）`, 'success')
        navigateToVideoDetail(navigate, location, res.mergedIntoId, { replace: true })
        return
      }
      if (res.code === res.previousCode) {
        toast.show('番号未变更', 'info')
        return
      }
      toast.show(`番号已修正：${res.previousCode} → ${res.code}`, 'success')
      invalidateVideos()
      void load({ silent: true })
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setCorrecting(false)
    }
  }

  if (loading) {
    return (
      <div className={`detail-pane${actressStackOpen ? ' detail-pane--stacked' : ''}`}>
        <DetailScrollBody onBack={() => navigateBackFromVideoDetail(navigate, location)}>
          <div className="empty-state">
            <div className="spinner" />
          </div>
        </DetailScrollBody>
      </div>
    )
  }
  if (!video) {
    return (
      <div className={`detail-pane${actressStackOpen ? ' detail-pane--stacked' : ''}`}>
        <DetailScrollBody onBack={() => navigateBackFromVideoDetail(navigate, location)}>
          <div className="empty-state">
            <div>未找到该影片</div>
          </div>
        </DetailScrollBody>
      </div>
    )
  }

  const codeParts = splitVideoCode(video.code)

  return (
    <div className={`detail-pane${actressStackOpen ? ' detail-pane--stacked' : ''}`}>
      <DetailScrollBody onBack={() => navigateBackFromVideoDetail(navigate, location)}>
      <div className="detail-top">
        <div
          className={`detail-cover landscape${cover ? ' detail-cover--preview' : ''}`}
          role={cover ? 'button' : undefined}
          aria-label={cover ? `查看封面：${video.code}` : undefined}
          tabIndex={cover ? 0 : undefined}
          title={cover ? '查看封面' : undefined}
          onClick={() => {
            if (cover) setCoverPreviewOpen(true)
          }}
          onKeyDown={onCoverKeyDown}
        >
          {cover ? (
            <img
              src={cover}
              alt={video.code}
              className={tallCover ? 'cover-tall' : undefined}
              onLoad={onCoverLoad}
            />
          ) : (
            <div className="poster-placeholder">{video.code}</div>
          )}
        </div>

        <div className="detail-info">
          <h1 className="detail-title">
            {codeParts ? (
              <>
                <MetaLink
                  className="detail-code"
                  onClick={() =>
                    navigateToLibrary(navigate, location, {
                      [LIST_PARAM.prefix]: codeParts.prefix
                    })
                  }
                  title={`筛选 ${codeParts.prefix} 系列`}
                >
                  {codeParts.prefix}
                </MetaLink>
                <span className="detail-code">{codeParts.suffix}</span>
              </>
            ) : (
              <span className="detail-code">{video.code}</span>
            )}
            {video.title ? `  ${video.title}` : ''}
          </h1>

          <StarRating value={video.rating} onChange={handleRating} size={22} />

          <div className="meta-grid">
            <span className="meta-key">发行日期</span>
            <span className="meta-val">{video.release_date || '—'}</span>
            <span className="meta-key">制作商</span>
            <FacetValue type="maker" value={video.maker} />
            <span className="meta-key">发行商</span>
            <FacetValue type="publisher" value={video.publisher} />
            <span className="meta-key">系列</span>
            <FacetValue type="series" value={video.series} />
            <span className="meta-key">导演</span>
            <FacetValue type="director" value={video.director} />
            <span className="meta-key">文件路径</span>
            <span className="meta-val meta-val--path">{video.file_path}</span>
          </div>

          <div className="detail-actions">
            <button className="btn btn-primary detail-play-btn" onClick={handlePlay}>
              ▶ 播放
            </button>
            <div className="detail-action-group detail-action-group--icons" role="group" aria-label="影片操作">
              <IconButton
                className="detail-icon-action"
                icon={<ListPlus {...UI_ICON} />}
                label="加入清单"
                onClick={() => setShowAddToPlaylist(true)}
              />
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
                      openCorrectImport()
                    }}
                  >
                    修正番号
                  </button>
                  <button
                    type="button"
                    className="detail-menu-item"
                    role="menuitem"
                    onClick={() => {
                      void handleReveal()
                    }}
                  >
                    打开所在文件夹
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
                  <button
                    type="button"
                    className="detail-menu-item detail-menu-item--danger"
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false)
                      setConfirmDelete(true)
                    }}
                  >
                    删除影片
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {video.actresses.length > 0 && (
        <>
          <div className="section-title">演员</div>
          <div className="actress-row-avatars">
            {video.actresses.map((a) => {
              const avatar = assetUrl(a.avatar_path)
              return (
                <button
                  key={a.id}
                  type="button"
                  className="actress-mini"
                  onClick={() =>
                    navigateToActressFromVideoDetail(navigate, location, videoId, a.id)
                  }
                >
                  <ActressAvatar src={avatar} name={a.main_name} gender={a.gender} />
                  <ActressName name={a.main_name} gender={a.gender} className="actress-name" />
                </button>
              )
            })}
          </div>
        </>
      )}

      {video.summary && (
        <>
          <div className="section-title">剧情简介</div>
          <div className="summary-text">{video.summary}</div>
        </>
      )}

      <VideoTagPanel
        videoId={video.id}
        tags={video.tags}
        onFilterTag={(tag) =>
          navigateToLibrary(
            navigate,
            location,
            { [LIST_PARAM.tags]: String(tag.id) },
            { tagLabel: { id: tag.id, name: tag.name } }
          )
        }
        onChanged={() => {
          void load({ silent: true })
          invalidateVideos()
        }}
      />

      <VideoSampleGallery
        videoId={video.id}
        assets={video.assets}
        posterPath={video.poster_path}
        onChanged={() => {
          void load({ silent: true })
          invalidateVideos()
        }}
      />
      </DetailScrollBody>

      {coverPreviewOpen && cover && (
        <ImagePreviewLightbox
          items={[{ id: video.id, src: cover }]}
          index={0}
          onClose={() => setCoverPreviewOpen(false)}
          onIndexChange={() => {}}
          labels={{
            dialog: '查看影片封面',
            filmstrip: '影片封面',
            thumb: () => `封面：${video.code}`
          }}
        />
      )}

      {showCorrectImport && (
        <Modal
          title="修正导入"
          confirmText={correcting ? '处理中…' : '保存'}
          onConfirm={() => {
            if (!correcting) void doCorrectImport()
          }}
          onCancel={() => {
            if (!correcting) setShowCorrectImport(false)
          }}
        >
          <p className="modal-field-hint">
            修改该影片的番号（不修改磁盘文件名）。番号格式不限。
          </p>
          <input
            className="text-input form-control-full"
            value={correctCode}
            onChange={(e) => setCorrectCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !correcting) void doCorrectImport()
            }}
            placeholder="输入番号"
            aria-label="番号"
            autoFocus
            disabled={correcting}
          />
        </Modal>
      )}

      {showScrapeFields && (
        <ScrapeFieldsModal
          title="修正匹配"
          hint={VIDEO_SCRAPE_UPDATE_MODE_HINT}
          options={VIDEO_SCRAPE_FIELD_OPTIONS}
          scrapers={scrapers}
          initialScraperName={scraperName}
          initialSelected={ALL_VIDEO_SCRAPE_FIELDS}
          updateModeOptions={VIDEO_SCRAPE_UPDATE_MODE_OPTIONS}
          initialUpdateMode="fillEmpty"
          onCancel={() => setShowScrapeFields(false)}
          onConfirm={(fields, site, _scope, mode) => {
            void handleRescrape(fields, site, mode as VideoScrapeUpdateMode | undefined)
          }}
        />
      )}

      {showEdit && (
        <EditMetadataModal
          video={video}
          onCancel={() => setShowEdit(false)}
          onSave={handleEditSave}
        />
      )}

      {showAddToPlaylist && (
        <AddToPlaylistModal
          videoId={videoId}
          videoCode={video.code}
          onCancel={() => setShowAddToPlaylist(false)}
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
          确定要清除「{video.code}」的所有刮削元数据吗？将清空标题、简介、封面、演员、标签等并恢复为「未刮削」状态（不影响视频文件与评分）。
        </Modal>
      )}

      {confirmDelete && (
        <Modal
          title="删除影片"
          danger
          confirmText="删除"
          onConfirm={() => {
            setConfirmDelete(false)
            void doDelete()
          }}
          onCancel={() => setConfirmDelete(false)}
        >
          确定要永久删除「{video.code}」吗？将同时删除磁盘上的视频文件、封面及所有元数据，此操作不可恢复。
          <div className="modal-path-text">{video.file_path}</div>
        </Modal>
      )}

      {missingPrompt && (
        <Modal
          title="文件不存在"
          danger
          confirmText="删除记录"
          cancelText="保留"
          onConfirm={() => {
            setMissingPrompt(false)
            void doDelete()
          }}
          onCancel={() => setMissingPrompt(false)}
        >
          该视频文件在磁盘上不存在（可能已被移动或删除）。是否删除该影片的元数据与封面？
        </Modal>
      )}
      {actressStackOpen && (
        <div className="detail-pane-overlay">
          <Outlet />
        </div>
      )}
    </div>
  )
}
