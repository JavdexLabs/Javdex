import {
  StrictMode,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent
} from 'react'
import { createRoot } from 'react-dom/client'
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
          <span className="brand-mark">
            <Play fill="currentColor" aria-hidden="true" />
          </span>
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
              autoFocus
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
  const player = useRef<HTMLVideoElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const selected = Number(query.get('play'))
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
    if (video) {
      heading.current?.focus()
      document.title = `${video.title} · Javdex`
    }
  }, [video])
  useEffect(() => {
    setPlayError('')
  }, [selected])
  const resource = video?.resources.find((r) => r.id === selected && r.playable)
  const select = (resourceId: number): void => {
    const next = new URLSearchParams(query)
    next.set('play', String(resourceId))
    navigate(`/browse/video/${id}`, next)
  }
  return (
    <section className="detail" aria-label="影片详情">
      <button className="back" onClick={back}>
        <ArrowLeft aria-hidden="true" />
        返回浏览
      </button>
      {error ? (
        <Status error={error} retry={() => setAttempt((n) => n + 1)} />
      ) : !video ? (
        <Status error="正在读取影片…" />
      ) : (
        <>
          {resource && (
            <div className="player-shell">
              <video
                key={`${id}:${selected}`}
                ref={player}
                controls
                playsInline
                autoPlay
                preload="metadata"
                poster={video.cover ?? undefined}
                src={`/api/videos/${id}/media/${selected}`}
                onError={() =>
                  setPlayError(
                    '此浏览器无法播放该资源，可能是编码不支持、文件离线或链接不可用。请选择其他资源，或在桌面端使用播放器。'
                  )
                }
              />
              {playError && (
                <div className="player-error" role="alert">
                  <p>{playError}</p>
                  <button
                    onClick={() => {
                      setPlayError('')
                      player.current?.load()
                    }}
                  >
                    重试播放
                  </button>
                </div>
              )}
              <p className="muted player-caption">
                {resource.name} · 原始画质 · 浏览器原生播放
              </p>
            </div>
          )}
          <div className="detail-layout">
            <div className="detail-poster">
              <Poster video={video} large />
            </div>
            <div className="detail-copy">
              <p className="eyebrow">{video.code}</p>
              <h1 ref={heading} tabIndex={-1}>
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
                  <div className="resources">
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
                  <h2>出演</h2>
                  <div className="chips">
                    {video.actresses.map((a) => {
                      const next = new URLSearchParams()
                      next.set('actress', String(a.id))
                      next.set('label', a.name)
                      return (
                        <a
                          className="chip"
                          key={a.id}
                          href={route('/browse', next)}
                        >
                          {a.name}
                        </a>
                      )
                    })}
                  </div>
                </section>
              )}
              {video.tags.length > 0 && (
                <section>
                  <h2>标签</h2>
                  <div className="chips">
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
              <div className="gallery">
                {video.images.map((src) => (
                  <a
                    key={src}
                    href={src}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="查看原图"
                  >
                    <img src={src} alt="影片剧照" loading="lazy" />
                  </a>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </section>
  )
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
  const lastScroll = useRef(0)
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
    api<WebBrowse>(`/api/videos?${queryKey}`, { signal: abort.signal })
      .then(setResult)
      .catch((reason) => {
        if (abort.signal.aborted) return
        if (reason instanceof ApiError && reason.status === 401) onLogout()
        else setError(reason.message)
      })
    return () => abort.abort()
  }, [queryKey, attempt, onLogout])
  useEffect(() => {
    setSearch(new URLSearchParams(queryKey).get('q') ?? '')
  }, [queryKey])
  useEffect(() => {
    if (detailId && !previousDetail.current) {
      lastScroll.current = window.scrollY
      window.scrollTo(0, 0)
    }
    if (!detailId && previousDetail.current) {
      window.scrollTo(0, lastScroll.current)
      document
        .querySelector<HTMLElement>('.video-card[data-last="true"]')
        ?.focus({ preventScroll: true })
    }
    previousDetail.current = Boolean(detailId)
    if (!detailId) document.title = 'Javdex · 家庭媒体库'
  }, [detailId])
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
          document.getElementById('main-content')?.focus()
        }}
      >
        跳到内容
      </a>
      <header className="topbar">
        <a className="brand" href={route('/browse')}>
          <span className="brand-mark">
            <Play fill="currentColor" aria-hidden="true" />
          </span>
          Javdex<span className="brand-label">家庭媒体库</span>
        </a>
        <form
          className="search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            change('q', search.trim())
          }}
        >
          <Search aria-hidden="true" />
          <input
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
          <button type="submit" className="search-submit">
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
      <nav className="sidebar" aria-label="浏览导航">
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
      <main id="main-content" tabIndex={-1} className="main-content">
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
          <div className="browse-tools">
            <div className="sort-tabs" aria-label="排序">
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
          <div className="chips filter-chips">
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
          {error ? (
            <Status error={error} retry={() => setAttempt((n) => n + 1)} />
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
              <div className="video-grid">
                {result.items.map((video) => (
                  <a
                    className="video-card"
                    key={video.id}
                    href={route(`/browse/video/${video.id}`, browseQuery)}
                    onClick={(event) => {
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
                ))}
              </div>
              <nav className="pagination" aria-label="结果分页">
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
