import {
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { createRoot } from 'react-dom/client'
import { X } from 'lucide-react'
import type {
  WebBrowse,
  WebCollection,
  WebVideo
} from '../../../packages/contracts/src/webTypes'
import { api, ApiError, post } from './client'
import {
  navigate,
  route,
  spatialNavigation,
  useWebLocation
} from './navigation'
import Login from './Login'
import { WebButton } from './WebButton'
import WebVideoCard from './WebVideoCard'
import VideoGrid from './WebVideoGrid'
import WebSearch from './WebSearch'
import WebSidebar from './WebSidebar'
import WebCollectionPicker from './WebCollectionPicker'
import WebLibraryShell from './WebLibraryShell'
import Status from './WebStatus'
import HomeDiscovery from './WebHomeDiscovery'
import WebBrowseHeading from './WebBrowseHeading'
import WebBrowseSort from './WebBrowseSort'
import WebChipRow from './WebChipRow'
import WebPagination from './WebPagination'
import Detail from './WebDetailPage'
import WebText from './WebText'
import './styles.css'

type Session = { authenticated: boolean; username: string }
type Collections = { libraries: WebCollection[]; playlists: WebCollection[] }
function focusBrowseControl(): void {
  const candidates = document.querySelectorAll<HTMLElement>(
    '#main-content [data-web-video-card], #main-content button:not(:disabled), #main-content a[href], #main-content input'
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
  const previousQuery = useRef<string | null>(null)
  const pointerScopeChange = useRef(false)
  const pendingFocus = useRef(false)
  const pendingFocusTarget = useRef<HTMLElement | null>(null)
  const focusWhileLoading = (): void => {
    pendingFocusTarget.current = document.querySelector<HTMLElement>('[data-web-sort] button')
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
    if (pointerScopeChange.current) {
      pointerScopeChange.current = false
      pendingFocus.current = false
      document.querySelector<HTMLElement>('[data-web-collection-trigger]')?.focus({ preventScroll: true })
      window.scrollTo(0, 0)
      return
    }
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
      : '[data-browse-results] [data-web-video-card]')
    ;(target ?? document.getElementById('web-search'))?.focus({ preventScroll: true })
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
        const origin = document.querySelector<HTMLElement>('[data-web-video-card][data-last="true"]')
        if (origin && origin.getClientRects().length) origin.focus({ preventScroll: true })
        else focusBrowseControl()
      }
    }
    previousDetail.current = Boolean(detailId)
    if (detailId) return
    document.title = 'Javdex · 本地媒体库'
    // Capture while the list is visible, before hiding it can clamp scrollY.
    const rememberScroll = (): void => {
      lastScroll.current = window.scrollY
      lastListQuery.current = queryKey
    }
    window.addEventListener('scroll', rememberScroll, { passive: true })
    return () => window.removeEventListener('scroll', rememberScroll)
  }, [detailId, queryKey])
  const renderCard = (video: WebVideo): JSX.Element => (
    <WebVideoCard key={video.id} video={video} href={route(`/browse/video/${video.id}`, browseQuery)}
      onClick={event => {
        lastScroll.current = window.scrollY
        lastListQuery.current = queryKey
        document.querySelector('[data-last]')?.removeAttribute('data-last')
        event.currentTarget.dataset.last = 'true'
      }} />
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
    <WebLibraryShell username={session.username} onLogout={() => void logout()} onSkip={focusBrowseControl}
      search={<WebSearch value={search} onChange={setSearch} onSearch={value => change('q', value)} />}
      collection={<WebCollectionPicker libraries={collections.libraries} playlists={collections.playlists}
        currentLibrary={currentLibrary} currentPlaylist={currentPlaylist} onSelect={(scope, pointer) => {
          pointerScopeChange.current = pointer
          const [kind, value] = scope.split(':')
          const next = new URLSearchParams()
          if (kind !== 'all') next.set(kind, value)
          navigate('/browse', next)
        }} />}
      navigation={<WebSidebar libraries={collections.libraries} playlists={collections.playlists}
        library={query.get('library')} playlist={query.get('playlist')} />}
    >
        {logoutError && (
          <WebText role="alert" tone="danger">
            {logoutError}
          </WebText>
        )}
        {collectionError && (
          <WebText role="alert" tone="danger">
            导航加载失败：{collectionError}{' '}
            <WebButton onClick={() => setAttempt((n) => n + 1)}>重试</WebButton>
          </WebText>
        )}
        <div hidden={Boolean(detailId)}>
          <WebBrowseHeading title={title} search={query.get('q')} total={result?.total ?? null} />
          <HomeDiscovery visible={!queryKey} renderCard={renderCard} onUnauthorized={onLogout} />
          <div hidden={!queryKey}>
          <WebBrowseSort value={query.get('sort')} onChange={value => change('sort', value)} />
          <WebChipRow applied data-navigation-group>
            {['library', 'playlist', 'actress', 'tag', 'year']
              .filter((key) => query.has(key))
              .map((key) => (
                <WebButton
                  variant="chip"
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
                </WebButton>
              ))}
          </WebChipRow>
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
              <WebPagination page={result.page} total={result.total} pageSize={result.pageSize}
                onPageChange={page => {
                  const next = new URLSearchParams(browseQuery)
                  next.set('page', String(page))
                  navigate('/browse', next)
                  window.scrollTo(0, 0)
                }} />
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
    </WebLibraryShell>
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
