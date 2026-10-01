import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { imageThumbnailUrl } from '../../../packages/contracts/src/imageVariants'
import type { WebDetail } from '../../../packages/contracts/src/webTypes'
import { api, ApiError } from './client'
import { navigate, route, spatialNavigation } from './navigation'
import { WebButton, WebChipLink } from './WebButton'
import WebChipRow from './WebChipRow'
import WebText from './WebText'
import CastMember from './WebCastMember'
import Status from './WebStatus'
import ResourceList from './ResourceCard'
import styles from './WebDetailPage.module.css'

const ImagePreview = lazy(() => import('./ImagePreview'))
const duration = (seconds: number | null): string =>
  seconds ? `${Math.round(seconds / 60)} 分钟` : ''

export default function WebDetailPage({
  id,
  query,
  onUnauthorized
}: {
  id: number
  query: URLSearchParams
  onUnauthorized: () => void
}): JSX.Element {
  const [video, setVideo] = useState<WebDetail | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [playError, setPlayError] = useState('')
  const [playRequested, setPlayRequested] = useState(false)
  const player = useRef<HTMLVideoElement>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  const [previewIndex, setPreviewIndex] = useState(-1)
  const [previewLoaded, setPreviewLoaded] = useState(false)
  const previewOpener = useRef<HTMLElement | null>(null)
  const previewHistoryId = useRef(`preview-${Date.now()}-${Math.random()}`)
  const previewClosing = useRef(false)
  useEffect(() => {
    const restorePreview = (): void => {
      const entry = window.history.state?.javdexImagePreview
      previewClosing.current = false
      setPreviewIndex(entry?.owner === previewHistoryId.current ? entry.index : -1)
    }
    window.addEventListener('popstate', restorePreview)
    return () => window.removeEventListener('popstate', restorePreview)
  }, [])
  const previewImages = useMemo(() => video ? [
    ...(video.cover ? [{ src: video.cover, alt: `${video.title} · 封面` }] : []),
    ...video.images.map((src, index) => ({ src, alt: `${video.title} · 剧照 ${index + 1}` }))
  ] : [], [video])
  const openPreview = (index: number, opener: HTMLElement): void => {
    if (previewClosing.current) return
    previewOpener.current = opener
    window.history.pushState({ ...window.history.state,
      javdexImagePreview: { owner: previewHistoryId.current, index }
    }, '', window.location.href)
    setPreviewLoaded(true)
    setPreviewIndex(index)
  }
  const closePreview = (): void => {
    if (previewClosing.current) return
    if (window.history.state?.javdexImagePreview?.owner === previewHistoryId.current) {
      previewClosing.current = true
      window.history.back()
    } else setPreviewIndex(-1)
  }
  const selected = query.has('play')
    ? Number(query.get('play'))
    : video?.resources.find((r) => r.isPrimary &&
      (!query.has('library') || r.libraryId === Number(query.get('library'))))?.id
  const base = new URLSearchParams(query)
  base.delete('play')
  const back = (): void => navigate('/browse', base)
  useEffect(() => {
    const abort = new AbortController()
    setVideo(null)
    setError('')
    setPlayError('')
    api<WebDetail>(`/api/videos/${id}`, { signal: abort.signal })
      .then((value) => {
        setVideo(value)
      })
      .catch((reason) => {
        if (abort.signal.aborted) return
        if (reason instanceof ApiError && reason.status === 401)
          onUnauthorized()
        else setError(reason.message)
      })
    return () => abort.abort()
  }, [id, attempt, onUnauthorized])
  useEffect(() => {
    backButton.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (video) {
      document.title = `${video.title} · Javdex`
    }
  }, [video])
  useEffect(() => {
    setPlayError('')
  }, [selected])
  useEffect(() => {
    if (error && (document.activeElement === backButton.current || document.activeElement === document.body)) {
      document.querySelector<HTMLElement>('[data-web-detail] [role="alert"] button')?.focus()
    }
  }, [error])
  const resource = video?.resources.find((r) => r.id === selected && r.playable)
  const select = (resourceId: number): void => {
    setPlayRequested(true)
    if (resourceId === selected) {
      if (playError) {
        setPlayError('')
        player.current?.load()
        return
      }
      void player.current?.play().catch(() => {
        setPlayError('播放未能开始，请使用播放器的播放按钮重试。')
      })
    }
    const next = new URLSearchParams(query)
    next.set('play', String(resourceId))
    navigate(`/browse/video/${id}`, next)
  }
  return (
    <section className={styles.root} data-web-detail aria-label="影片详情">
      <WebButton id="detail-back" ref={backButton} className={styles.back} onClick={back}>
        <ArrowLeft aria-hidden="true" />
        返回浏览
      </WebButton>
      {error ? (
        <Status error={error} retry={() => {
          backButton.current?.focus({ preventScroll: true })
          setAttempt((n) => n + 1)
        }} />
      ) : !video ? (
        <Status error="正在读取影片…" />
      ) : (
        <>
          <>
          {resource && (
            <div className={styles.playerShell} hidden={Boolean(playError)}>
              <video
                key={`${id}:${selected}`}
                ref={player}
                controls
                hidden={Boolean(playError)}
                onKeyDownCapture={(event) => {
                  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                    spatialNavigation(event.nativeEvent)
                    if (event.defaultPrevented) event.stopPropagation()
                  }
                }}
                data-keyboard-exit="detail-back"
                playsInline
                autoPlay={playRequested}
                preload="metadata"
                poster={video.cover ?? undefined}
                src={`/api/videos/${id}/media/${selected}`}
                onError={() =>
                  setPlayError(
                    '此浏览器无法播放该资源，可能是编码不支持、文件离线或链接不可用。请选择其他资源，或在桌面端使用播放器。'
                  )
                }
              />
              {!playError && <>
              <WebText tone="muted" className={styles.playerCaption}>
                {resource.name} · 原始画质 · 浏览器原生播放
              </WebText>
              </>}
            </div>
          )}
          {(!resource || playError) && <div className={styles.playerFallback} data-web-player-fallback>
            {video.cover && <WebButton className={styles.imageTrigger} data-web-image-trigger aria-label="预览影片封面"
              onClick={event => openPreview(0, event.currentTarget)}>
              <img className={styles.playerFallbackCover} data-web-player-fallback-cover src={video.cover} alt={`${video.title} · 封面`} />
            </WebButton>}
            <div className={styles.playerError} data-web-player-error role={playError ? 'alert' : 'status'}>
              <p>{playError || (video.resources.some((r) => r.playable)
                ? '当前未加载可播放的主资源，请在下方选择播放资源。'
                : '暂无可在浏览器中播放的资源。')}</p>
              {playError && resource && <WebButton onClick={() => {
                setPlayError('')
                player.current?.load()
                backButton.current?.focus({ preventScroll: true })
              }}>重试播放</WebButton>}
            </div>
          </div>}
          </>
          <div className={styles.layout}>
            <div className={styles.copy}>
              <WebText tone="eyebrow">{video.code}</WebText>
              <h1>
                {video.title}
              </h1>
              <div className={styles.metadata}>
                <span>{video.releaseDate || '发行日期未知'}</span>
                {video.duration && <span>{duration(video.duration)}</span>}
                {video.rating > 0 && <span>评分 {video.rating}</span>}
              </div>
              <section className={styles.resourceSection} aria-label="可用资源">
                <h2>选择播放资源</h2>
                {video.resources.length ? (
                  <ResourceList resources={video.resources} selected={selected} play={select} />
                ) : (
                  <WebText tone="muted" className={styles.resourceNote}>暂无可播放资源。</WebText>
                )}
                <WebText tone="muted" className={styles.resourceNote}>
                  播放能力取决于浏览器及视频编码；此 Web 端不进行转码。
                </WebText>
              </section>
              {video.summary && (
                <section>
                  <h2>影片简介</h2>
                  <p className={styles.summary}>{video.summary}</p>
                </section>
              )}
              <dl className={styles.facts}>
                {[
                  ['制作商', video.maker],
                  ['发行商', video.publisher],
                  ['系列', video.series],
                  ['导演', video.director]
                ]
                  .filter(([, value]) => value)
                  .map(([name, value]) => (
                    <div key={name}>
                      <dt>{name}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
              </dl>
              {video.actresses.length > 0 && (
                <section>
                  <h2>演员 · {video.actresses.length} 位</h2>
                  <div className={styles.castGrid} data-web-cast-grid data-navigation-group>
                    {video.actresses.map((a) => <CastMember key={`${a.id}:${a.avatar}`} actress={a} />)}
                  </div>
                </section>
              )}
              {video.tags.length > 0 && (
                <section>
                  <h2>标签</h2>
                  <WebChipRow data-navigation-group>
                    {video.tags.map((t) => {
                      const next = new URLSearchParams()
                      next.set('tag', String(t.id))
                      next.set('label', t.name)
                      return (
                        <WebChipLink
                          key={t.id}
                          href={route('/browse', next)}
                        >
                          {t.name}
                        </WebChipLink>
                      )
                    })}
                  </WebChipRow>
                </section>
              )}
            </div>
          </div>
          {video.images.length > 0 && (
            <section className={styles.gallerySection}>
              <h2>影片剧照</h2>
              <div className={styles.gallery} data-web-gallery data-navigation-group>
                {video.images.map((src, index) => (
                  <WebButton
                    key={src}
                    className={styles.imageTrigger} data-web-image-trigger
                    aria-label={`预览剧照 ${index + 1}`}
                    onClick={event => openPreview(index + (video.cover ? 1 : 0), event.currentTarget)}
                  >
                    <img src={imageThumbnailUrl(src, 640)} alt={`影片剧照 ${index + 1}`} loading="lazy" />
                  </WebButton>
                ))}
              </div>
            </section>
          )}
        </>
      )}
      {previewLoaded && <Suspense fallback={null}><ImagePreview images={previewImages} index={previewIndex}
        close={closePreview} exited={() => previewOpener.current?.focus({ preventScroll: true })} /></Suspense>}
    </section>
  )
}
