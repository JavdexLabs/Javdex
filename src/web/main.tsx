import {
  StrictMode,
  Suspense,
  lazy,
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent
} from 'react'
import { createRoot } from 'react-dom/client'
const ImagePreview = lazy(() => import('./ImagePreview'))
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Film,
  Library,
  ListVideo,
  LogOut,
  Play,
  Search,
  ShieldCheck,
  UserRound,
  X
} from 'lucide-react'
import type {
  WebBrowse,
  WebCollection,
  WebDetail,
  WebVideo
} from '../shared/webTypes'
import { api, ApiError, post } from './client'
import {
  navigate,
  route,
  spatialNavigation,
  useWebLocation
} from './navigation'
import './styles.css'
import PairLogin from './PairLogin'
import appIcon from '../../build/icon-128.png'
import Checkbox from '../renderer/src/components/Checkbox'

type Session = { authenticated: boolean; username: string }
type Collections = { libraries: WebCollection[]; playlists: WebCollection[] }
const duration = (seconds: number | null): string =>
  seconds ? `${Math.round(seconds / 60)} 分钟` : ''

function Poster({
  video,
  large = false
}: {
  video: WebVideo
  large?: boolean
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  return (
    <div className={`poster${large ? ' poster-large' : ''}`}>
      {video.cover && !failed ? (
        <img
          src={video.cover}
          alt=""
          loading={large ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="poster-placeholder">
          <Film aria-hidden="true" />
          <span>{video.code}</span>
        </div>
      )}
      {!large && (
        <>
          <span className="poster-play">
            <Play aria-hidden="true" />
          </span>
          <span className="poster-code">{video.code}</span>
        </>
      )}
    </div>
  )
}
function Login({
  onLogin
}: {
  onLogin: (session: Session) => void
}): JSX.Element {
  const [mode, setMode] = useState<'pair' | 'password'>('pair')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      onLogin(
        await post<Session>('/api/login', {
          username: data.get('username'),
          password: data.get('password'),
          remember
        })
      )
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="login-page">
      <section className="login-card">
        <div className="brand">
          <img className="brand-mark" src={appIcon} alt="" />
          Javdex
        </div>
        <p className="eyebrow">YOUR LIBRARY, EVERY SCREEN</p>
        <h1>
          你的媒体库，
          <br />
          随处可看。
        </h1>
        <p className="muted">登录以浏览这台电脑的媒体库。</p>
        <div className="login-tabs">
          <button aria-pressed={mode === 'pair'} onClick={() => setMode('pair')}>与桌面配对</button>
          <button aria-pressed={mode === 'password'} onClick={() => setMode('password')}>密码登录</button>
        </div>
        {mode === 'pair' ? <PairLogin onLogin={onLogin} /> : <form onSubmit={(event) => void submit(event)}>
          <label>
            访问账号
            <input
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={64}
            />
          </label>
          <label>
            访问密码
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </label>
          <label className="remember-device"><Checkbox checked={remember} onChange={e => setRemember(e.target.checked)} />记住此设备（闲置 24 小时 / 最长 7 天）</label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? '正在登录…' : '进入媒体库'}
            <ChevronRight aria-hidden="true" />
          </button>
        </form>}
        <p className="login-foot">
          <ShieldCheck aria-hidden="true" />
          账号由桌面端设置 · 仅供浏览与播放
        </p>
      </section>
    </main>
  )
}
function Status({
  error,
  retry
}: {
  error: string
  retry?: () => void
}): JSX.Element {
  return (
    <div className="empty" role={retry ? 'alert' : 'status'}>
      <Film aria-hidden="true" />
      <p>{error}</p>
      {retry && <button onClick={retry}>重试</button>}
    </div>
  )
}
function CastMember({ actress }: { actress: WebDetail['actresses'][number] }): JSX.Element {
  const [failed, setFailed] = useState(false)
  const next = new URLSearchParams({ actress: String(actress.id), label: actress.name })
  return <a className="cast-member" href={route('/browse', next)}>
    <span className="cast-avatar" aria-hidden="true">
      {actress.avatar && !failed ? <img src={actress.avatar} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
        : <UserRound />}
    </span>
    <span className="cast-name">{actress.name}</span>
    <span className="cast-gender">{actress.gender === 'female' ? '♀ 女' : actress.gender === 'male' ? '♂ 男' : '性别未知'}</span>
  </a>
}
function Detail({
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
    : (video?.resources.find((r) => r.isPrimary && r.playable)?.id ??
      video?.resources.find((r) => r.playable)?.id)
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
      document.querySelector<HTMLElement>('.detail [role="alert"] button')?.focus()
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
    <section className="detail" aria-label="影片详情">
      <button id="detail-back" ref={backButton} className="back" onClick={back}>
        <ArrowLeft aria-hidden="true" />
        返回浏览
      </button>
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
            <div className="player-shell" hidden={Boolean(playError)}>
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
                aria-describedby="player-keyboard-help"
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
              <p className="muted player-caption">
                {resource.name} · 原始画质 · 浏览器原生播放
              </p>
              <p id="player-keyboard-help" className="keyboard-help">左右调整进度，上下移动页面焦点，Esc 返回页面控件；全屏时先退出全屏。</p>
              </>}
            </div>
          )}
          {(!resource || playError) && <div className="player-fallback">
            {video.cover && <button className="image-preview-trigger" aria-label="预览影片封面"
              onClick={event => openPreview(0, event.currentTarget)}>
              <img className="player-fallback-cover" src={video.cover} alt={`${video.title} · 封面`} />
            </button>}
            <div className="player-error" role={playError ? 'alert' : 'status'}>
              <p>{playError || '暂无可在浏览器中播放的资源。'}</p>
              {playError && resource && <button onClick={() => {
                setPlayError('')
                player.current?.load()
                backButton.current?.focus({ preventScroll: true })
              }}>重试播放</button>}
            </div>
          </div>}
          </>
          <div className="detail-layout">
            <div className="detail-copy">
              <p className="eyebrow">{video.code}</p>
              <h1>
                {video.title}
              </h1>
              <div className="metadata">
                <span>{video.releaseDate || '发行日期未知'}</span>
                {video.duration && <span>{duration(video.duration)}</span>}
                {video.rating > 0 && <span>评分 {video.rating}</span>}
              </div>
              <section className="resource-section" aria-label="可用资源">
                <h2>选择播放资源</h2>
                {video.resources.length ? (
                  <div className="resources" data-navigation-group>
                    {video.resources.map((r) => (
                      <button
                        key={r.id}
                        className={r.id === selected ? 'primary' : ''}
                        disabled={!r.playable}
                        title={r.reason ?? undefined}
                        onClick={() => select(r.id)}
                      >
                        <Play aria-hidden="true" />
                        <span>
                          {r.name}
                          <small>
                            {r.playable
                              ? r.kind === 'local'
                                ? '本地视频'
                                : '直连视频'
                              : r.reason}
                          </small>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="muted">暂无可播放资源。</p>
                )}
                <p className="muted">
                  播放能力取决于浏览器及视频编码；此 Web 端不进行转码。
                </p>
              </section>
              {video.summary && (
                <section>
                  <h2>影片简介</h2>
                  <p className="summary">{video.summary}</p>
                </section>
              )}
              <dl className="facts">
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
                  <div className="cast-grid" data-navigation-group>
                    {video.actresses.map((a) => <CastMember key={`${a.id}:${a.avatar}`} actress={a} />)}
                  </div>
                </section>
              )}
              {video.tags.length > 0 && (
                <section>
                  <h2>标签</h2>
                  <div className="chips" data-navigation-group>
                    {video.tags.map((t) => {
                      const next = new URLSearchParams()
                      next.set('tag', String(t.id))
                      next.set('label', t.name)
                      return (
                        <a
                          className="chip"
                          key={t.id}
                          href={route('/browse', next)}
                        >
                          {t.name}
                        </a>
                      )
                    })}
                  </div>
                </section>
              )}
            </div>
          </div>
          {video.images.length > 0 && (
            <section className="gallery-section">
              <h2>影片剧照</h2>
              <div className="gallery" data-navigation-group>
                {video.images.map((src, index) => (
                  <button
                    key={src}
                    className="image-preview-trigger"
                    aria-label={`预览剧照 ${index + 1}`}
                    onClick={event => openPreview(index + (video.cover ? 1 : 0), event.currentTarget)}
                  >
                    <img src={src} alt={`影片剧照 ${index + 1}`} loading="lazy" />
                  </button>
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
function VideoGrid({ videos, renderCard }: {
  videos: WebVideo[]
  renderCard: (video: WebVideo) => JSX.Element
}): JSX.Element {
  const [activeId, setActiveId] = useState<number | null>(null)
  const tabStop = videos.some(video => video.id === activeId) ? activeId : videos[0]?.id
  return <div className="video-grid" data-navigation-group aria-label="影片列表">
    {videos.map(video => cloneElement(renderCard(video), {
      tabIndex: video.id === tabStop ? 0 : -1,
      'data-navigation-item': true,
      onFocus: () => setActiveId(video.id)
    }))}
  </div>
}
function HomeDiscovery({ visible, renderCard, onUnauthorized }: {
  visible: boolean
  renderCard: (video: WebVideo) => JSX.Element
  onUnauthorized: () => void
}): JSX.Element {
  const [seed, setSeed] = useState(() => String(Math.random()))
  const [snapshot, setSnapshot] = useState<{ discovery: WebVideo[]; recent: WebVideo[] } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const homeRoot = useRef<HTMLDivElement>(null)
  const retryFocus = useRef(false)
  useEffect(() => {
    if (!retryFocus.current || busy) return
    retryFocus.current = false
    if (document.activeElement === document.querySelector('.logout')) {
      homeRoot.current?.querySelector<HTMLButtonElement>('button')?.focus()
    }
  }, [busy, snapshot, error])
  useEffect(() => {
    const abort = new AbortController()
    setBusy(true)
    setError('')
    api<{ discovery: WebVideo[]; recent: WebVideo[] }>(`/api/home?seed=${seed}`, { signal: abort.signal })
      .then(value => { if (!abort.signal.aborted) setSnapshot(value) })
      .catch(reason => {
        if (abort.signal.aborted) return
        if (reason instanceof ApiError && reason.status === 401) onUnauthorized()
        else setError(reason.message)
      })
      .finally(() => { if (!abort.signal.aborted) setBusy(false) })
    return () => abort.abort()
  }, [seed, onUnauthorized])
  return <div ref={homeRoot} hidden={!visible} className="home-sections" aria-busy={busy}>
    {error && <Status error={error} retry={() => {
      retryFocus.current = true
      document.querySelector<HTMLElement>('.logout')?.focus({ preventScroll: true })
      setSeed(String(Math.random()))
    }} />}
    {!snapshot && !error ? <Status error="正在加载首页…" /> : snapshot && <>
      <section aria-labelledby="discovery-heading">
        <div className="home-section-heading" data-navigation-group>
          <h2 id="discovery-heading">随机发现</h2>
          <button aria-disabled={busy} onClick={() => { if (!busy) setSeed(String(Math.random())) }}>换一批</button>
        </div>
        {snapshot.discovery.length ? <VideoGrid videos={snapshot.discovery} renderCard={renderCard} />
          : <p className="muted">暂无可发现的影片，请在桌面端启用媒体库的首页发现。</p>}
      </section>
      <section aria-labelledby="recent-heading">
        <div className="home-section-heading" data-navigation-group>
          <h2 id="recent-heading">近期添加</h2>
          <a className="chip" href={route('/browse', new URLSearchParams({ sort: 'recent' }))}>查看全部</a>
        </div>
        {snapshot.recent.length ? <VideoGrid videos={snapshot.recent} renderCard={renderCard} />
          : <p className="muted">还没有近期添加的影片。</p>}
      </section>
    </>}
  </div>
}
function focusBrowseControl(): void {
  const candidates = document.querySelectorAll<HTMLElement>(
    '#main-content .video-card, #main-content button:not(:disabled), #main-content a[href], #main-content input'
  )
  const target = Array.from(candidates).find(element =>
    !element.closest('[hidden], [inert]') && element.getClientRects().length > 0
  )
  ;(target ?? document.getElementById('web-search'))?.focus({ preventScroll: true })
}

function LibraryApp({
  session,
  onLogout
}: {
  session: Session
  onLogout: () => void
}): JSX.Element {
  const { pathname, query } = useWebLocation()
  const detailId = /^\/browse\/video\/([1-9]\d*)$/.exec(pathname)?.[1]
  const [collections, setCollections] = useState<Collections>({
    libraries: [],
    playlists: []
  })
  const [collectionError, setCollectionError] = useState('')
  const [result, setResult] = useState<WebBrowse | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [search, setSearch] = useState(query.get('q') ?? '')
  const [logoutError, setLogoutError] = useState('')
  const collectionDialog = useRef<HTMLDialogElement>(null)
  const previousQuery = useRef<string | null>(null)
  const pendingFocus = useRef(false)
  const pendingFocusTarget = useRef<HTMLElement | null>(null)
  const focusWhileLoading = (): void => {
    pendingFocusTarget.current = document.querySelector<HTMLElement>('.sort-tabs button')
    pendingFocusTarget.current?.focus({ preventScroll: true })
  }
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null)
  const lastScroll = useRef(0)
  const lastListQuery = useRef(query.toString())
  const previousDetail = useRef(false)
  const browseQuery = new URLSearchParams(query)
  browseQuery.delete('play')
  const queryKey = browseQuery.toString()
  const currentLibrary = collections.libraries.find(
    (l) => String(l.id) === query.get('library')
  )
  const currentPlaylist = collections.playlists.find(
    (p) => String(p.id) === query.get('playlist')
  )
  const title =
    currentLibrary?.name ||
    currentPlaylist?.name ||
    query.get('label') ||
    (query.get('q') ? '搜索结果' : '发现你的收藏')
  useEffect(() => {
    const abort = new AbortController()
    setCollectionError('')
    api<Collections>('/api/collections', { signal: abort.signal })
      .then(setCollections)
      .catch((reason) => {
        if (abort.signal.aborted) return
        if (reason instanceof ApiError && reason.status === 401) onLogout()
        else setCollectionError(reason.message)
      })
    return () => abort.abort()
  }, [onLogout, attempt])
  useEffect(() => {
    const abort = new AbortController()
    setError('')
    setResult(null)
    setLoadedQuery(null)
    api<WebBrowse>(`/api/videos?${queryKey}`, { signal: abort.signal })
      .then(value => {
        if (abort.signal.aborted) return
        setResult(value)
        setLoadedQuery(queryKey)
      })
      .catch((reason) => {
        if (abort.signal.aborted) return
        if (reason instanceof ApiError && reason.status === 401) onLogout()
        else {
          setError(reason.message)
          setLoadedQuery(queryKey)
        }
      })
    return () => abort.abort()
  }, [queryKey, attempt, onLogout])
  useLayoutEffect(() => {
    const changed = previousQuery.current !== null && previousQuery.current !== queryKey
    previousQuery.current = queryKey
    if (!changed || detailId) return
    pendingFocus.current = Boolean(queryKey)
    if (queryKey) focusWhileLoading()
    else focusBrowseControl()
    window.scrollTo(0, 0)
  }, [queryKey, detailId])
  useEffect(() => {
    if (detailId || !pendingFocus.current || loadedQuery !== queryKey) return
    pendingFocus.current = false
    // Do not steal focus if the user already moved elsewhere during the request.
    if (document.activeElement !== pendingFocusTarget.current && document.activeElement !== document.body) return
    const target = document.querySelector<HTMLElement>(error
      ? '[data-browse-results] [role="alert"] button'
      : '[data-browse-results] .video-card')
    ;(target ?? document.getElementById('web-search'))?.focus()
  }, [loadedQuery, queryKey, error, result, detailId])
  useEffect(() => {
    setSearch(new URLSearchParams(queryKey).get('q') ?? '')
  }, [queryKey])
  useEffect(() => {
    const previous = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'
    return () => {
      window.history.scrollRestoration = previous
    }
  }, [])
  useLayoutEffect(() => {
    if (detailId && !previousDetail.current) {
      window.scrollTo(0, 0)
    }
    if (!detailId && previousDetail.current) {
      const returningToList = lastListQuery.current === queryKey
      window.scrollTo(0, returningToList ? lastScroll.current : 0)
      if (returningToList) {
        const origin = document.querySelector<HTMLElement>('.video-card[data-last="true"]')
        if (origin && origin.getClientRects().length) origin.focus({ preventScroll: true })
        else focusBrowseControl()
      }
    }
    previousDetail.current = Boolean(detailId)
    if (detailId) return
    document.title = 'Javdex · 家庭媒体库'
    // Capture while the list is visible, before hiding it can clamp scrollY.
    const rememberScroll = (): void => {
      lastScroll.current = window.scrollY
      lastListQuery.current = queryKey
    }
    window.addEventListener('scroll', rememberScroll, { passive: true })
    return () => window.removeEventListener('scroll', rememberScroll)
  }, [detailId, queryKey])
  const renderCard = (video: WebVideo): JSX.Element => (
<a
                    className="video-card"
                    key={video.id}
                    href={route(`/browse/video/${video.id}`, browseQuery)}
                    onClick={(event) => {
                      lastScroll.current = window.scrollY
                      lastListQuery.current = queryKey
                      document
                        .querySelector('[data-last]')
                        ?.removeAttribute('data-last')
                      event.currentTarget.dataset.last = 'true'
                    }}
                  >
                    <Poster video={video} />
                    <h2>{video.title}</h2>
                    <p>
                      <span>
                        {video.releaseDate?.slice(0, 4) || '年份未知'}
                      </span>
                      <span>{duration(video.duration)}</span>
                      {video.rating > 0 && (
                        <span className="rating">★ {video.rating}</span>
                      )}
                    </p>
                  </a>
  )
  const change = (key: string, value: string): void => {
    const next = new URLSearchParams(browseQuery)
    next.delete('page')
    if (value) next.set(key, value)
    else next.delete(key)
    navigate('/browse', next, true)
  }
  const logout = async (): Promise<void> => {
    try {
      await post('/api/logout')
      onLogout()
    } catch (reason) {
      setLogoutError((reason as Error).message)
    }
  }
  return (
    <div className="app-shell">
      <a
        className="skip"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault()
          focusBrowseControl()
        }}
      >
        跳到内容
      </a>
      <header className="topbar" data-navigation-region="header">
        <a className="brand" href={route('/browse')}>
          <img className="brand-mark" src={appIcon} alt="" />
          Javdex<span className="brand-label">家庭媒体库</span>
        </a>
        <form
          className="search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            change('q', search.trim())
            if (window.matchMedia('(pointer: coarse)').matches) {
              event.currentTarget.querySelector('input')?.blur()
            }
          }}
        >
          <Search aria-hidden="true" />
          <input
            id="web-search"
            type="search"
            enterKeyHint="search"
            autoCapitalize="none"
            spellCheck={false}
            aria-label="搜索番号、片名或演员"
            placeholder="搜索番号、片名或演员"
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search && (
            <button
              type="button"
              aria-label="清除搜索"
              onClick={() => {
                setSearch('')
                change('q', '')
              }}
            >
              <X />
            </button>
          )}
          <button type="submit" className="search-submit" tabIndex={-1}>
            搜索
          </button>
        </form>
        <button
          className="logout"
          onClick={() => void logout()}
          aria-label={`${session.username}，退出登录`}
        >
          <LogOut aria-hidden="true" />
          <span>退出</span>
        </button>
      </header>
      <div className="mobile-collection" data-navigation-region="header">
        浏览范围
        <button
          type="button"
          aria-haspopup="dialog"
          aria-describedby="collection-keyboard-help"
          aria-label="选择媒体库或清单"
          onClick={() => {
            collectionDialog.current?.showModal()
            collectionDialog.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
          }}
        >
          <span>{currentLibrary?.name || currentPlaylist?.name || '全部影片'}</span>
          <ChevronRight aria-hidden="true" />
        </button>
        <span id="collection-keyboard-help" className="sr-only">按 Enter 或空格打开浏览范围，方向键移动，确认后切换，Esc 取消。</span>
      </div>
      <dialog ref={collectionDialog} className="collection-dialog" aria-labelledby="collection-title" data-navigation-region="collection">
        <div className="collection-dialog-heading">
          <h2 id="collection-title">浏览范围</h2>
          <button type="button" aria-label="关闭浏览范围" onClick={() => collectionDialog.current?.close()}><X aria-hidden="true" /></button>
        </div>
        <div className="collection-options" data-navigation-group>
          {[
            { label: '', entries: [{ value: 'all', name: '全部影片' }] },
            { label: '媒体库', entries: collections.libraries.map(l => ({ value: `library:${l.id}`, name: `${l.name}（${l.count}）` })) },
            { label: '我的清单', entries: collections.playlists.map(p => ({ value: `playlist:${p.id}`, name: `${p.name}（${p.count}）` })) }
          ].map(group => <section key={group.label}>
            {group.label && group.entries.length > 0 && <h3>{group.label}</h3>}
            {group.entries.map(entry => <button key={entry.value} type="button"
              data-scope={entry.value}
              aria-pressed={entry.value === (currentLibrary ? `library:${currentLibrary.id}` : currentPlaylist ? `playlist:${currentPlaylist.id}` : 'all')}
              onClick={() => {
                collectionDialog.current?.close()
                const [kind, value] = entry.value.split(':')
                const next = new URLSearchParams()
                if (kind !== 'all') next.set(kind, value)
                navigate('/browse', next)
                window.scrollTo(0, 0)
              }}>{entry.name}</button>)}
          </section>)}
        </div>
      </dialog>
      <nav className="sidebar" data-navigation-region="sidebar" aria-label="浏览导航">
        <a
          className={
            !query.get('library') && !query.get('playlist') ? 'nav-active' : ''
          }
          href={route('/browse')}
        >
          <Library aria-hidden="true" />
          全部影片
        </a>
        <p className="nav-label">媒体库</p>
        {collections.libraries.map((l) => (
          <a
            key={l.id}
            className={currentLibrary?.id === l.id ? 'nav-active' : ''}
            href={route(
              '/browse',
              new URLSearchParams({ library: String(l.id) })
            )}
          >
            <Film aria-hidden="true" />
            <span>{l.name}</span>
            <small>{l.count}</small>
          </a>
        ))}
        {collections.playlists.length > 0 && (
          <p className="nav-label">我的清单</p>
        )}
        {collections.playlists.map((p) => (
          <a
            key={p.id}
            className={currentPlaylist?.id === p.id ? 'nav-active' : ''}
            href={route(
              '/browse',
              new URLSearchParams({ playlist: String(p.id) })
            )}
          >
            <ListVideo aria-hidden="true" />
            <span>{p.name}</span>
            <small>{p.count}</small>
          </a>
        ))}
        <div className="sidebar-foot">
          <ShieldCheck aria-hidden="true" />
          <span>
            只读访问
            <br />
            <small>管理请使用桌面端</small>
          </span>
        </div>
      </nav>
      <main id="main-content" className="main-content" data-navigation-region="content">
        {logoutError && (
          <p role="alert" className="error">
            {logoutError}
          </p>
        )}
        {collectionError && (
          <p role="alert" className="error">
            导航加载失败：{collectionError}{' '}
            <button onClick={() => setAttempt((n) => n + 1)}>重试</button>
          </p>
        )}
        <div hidden={Boolean(detailId)}>
          <div className="browse-heading">
            <div>
              <p className="eyebrow">JAVDEX COLLECTION</p>
              <h1>{title}</h1>
              <p className="muted">
                {query.get('q')
                  ? `“${query.get('q')}” 的匹配影片`
                  : '从熟悉的收藏中，找到下一部想看的。'}
              </p>
            </div>
            <span className="count">
              {result ? result.total.toLocaleString() : '—'} 部影片
            </span>
          </div>
          <HomeDiscovery visible={!queryKey} renderCard={renderCard} onUnauthorized={onLogout} />
          <div hidden={!queryKey}>
          <div className="browse-tools">
            <div className="sort-tabs" data-navigation-group aria-label="排序">
              {[
                ['recent', '最近添加'],
                ['released', '最新发行'],
                ['rating', '高分影片'],
                ['code', '番号']
              ].map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={(query.get('sort') || 'recent') === value}
                  onClick={() => change('sort', value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="year-filter">
              年份
              <input
                aria-label="按发行年份筛选"
                inputMode="numeric"
                placeholder="全部"
                defaultValue={query.get('year') ?? ''}
                key={query.get('year')}
                maxLength={4}
                onBlur={(event) => {
                  const year = event.target.value.trim()
                  if (!year || /^\d{4}$/.test(year)) change('year', year)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                }}
              />
            </label>
          </div>
          <div className="chips filter-chips" data-navigation-group>
            {['library', 'playlist', 'actress', 'tag', 'year']
              .filter((key) => query.has(key))
              .map((key) => (
                <button
                  className="chip"
                  key={key}
                  onClick={() => {
                    const next = new URLSearchParams(browseQuery)
                    next.delete(key)
                    next.delete('label')
                    next.delete('page')
                    navigate('/browse', next, true)
                  }}
                >
                  {key === 'library'
                    ? (currentLibrary?.name ?? '媒体库')
                    : key === 'playlist'
                      ? (currentPlaylist?.name ?? '清单')
                      : key === 'year'
                        ? `${query.get(key)} 年`
                        : (query.get('label') ??
                          (key === 'actress' ? '演员' : '标签'))}
                  <X aria-hidden="true" />
                </button>
              ))}
          </div>
          <div data-browse-results>
          {error ? (
            <Status error={error} retry={() => {
              pendingFocus.current = true
              focusWhileLoading()
              setAttempt((n) => n + 1)
            }} />
          ) : !result ? (
            <Status error="正在加载媒体库…" />
          ) : result.items.length === 0 ? (
            <Status
              error={
                queryKey
                  ? '没有匹配的影片，请调整搜索或筛选。'
                  : '媒体库还是空的。在桌面端添加影片后，即可在这里浏览。'
              }
            />
          ) : (
            <>
              <VideoGrid videos={result.items} renderCard={renderCard} />
              <nav className="pagination" data-navigation-group aria-label="结果分页">
                <button
                  disabled={result.page <= 1}
                  onClick={() => {
                    const next = new URLSearchParams(browseQuery)
                    next.set('page', String(result.page - 1))
                    navigate('/browse', next)
                    window.scrollTo(0, 0)
                  }}
                >
                  <ChevronLeft aria-hidden="true" />
                  上一页
                </button>
                <span>
                  {result.page} /{' '}
                  {Math.max(1, Math.ceil(result.total / result.pageSize))}
                </span>
                <button
                  disabled={result.page * result.pageSize >= result.total}
                  onClick={() => {
                    const next = new URLSearchParams(browseQuery)
                    next.set('page', String(result.page + 1))
                    navigate('/browse', next)
                    window.scrollTo(0, 0)
                  }}
                >
                  下一页
                  <ChevronRight aria-hidden="true" />
                </button>
              </nav>
            </>
          )}
          </div>
        </div>
        </div>
        {detailId && (
          <Detail
            key={detailId}
            id={Number(detailId)}
            query={query}
            onUnauthorized={onLogout}
          />
        )}
        <footer className="footer">
          Javdex · 你的收藏，尽在此处。<span>局域网 · 只读</span>
        </footer>
      </main>
    </div>
  )
}
function App(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const logout = useCallback(() => {
    setSession(null)
  }, [])
  useEffect(() => {
    const abort = new AbortController()
    setChecking(true)
    setError('')
    api<Session>('/api/session', { signal: abort.signal })
      .then(setSession)
      .catch((reason) => {
        if (
          !abort.signal.aborted &&
          (!(reason instanceof ApiError) || reason.status !== 401)
        )
          setError(reason.message)
      })
      .finally(() => {
        if (!abort.signal.aborted) setChecking(false)
      })
    return () => abort.abort()
  }, [attempt])
  useEffect(() => {
    window.addEventListener('keydown', spatialNavigation)
    return () => window.removeEventListener('keydown', spatialNavigation)
  }, [])
  if (checking) return <Status error="正在连接媒体库…" />
  if (error)
    return <Status error={error} retry={() => setAttempt((n) => n + 1)} />
  return session ? (
    <LibraryApp session={session} onLogout={logout} />
  ) : (
    <Login onLogin={setSession} />
  )
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
