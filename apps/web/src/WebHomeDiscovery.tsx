import { useEffect, useRef, useState } from 'react'
import type { WebVideo } from '../../../packages/contracts/src/webTypes'
import { api, ApiError } from './client'
import { route } from './navigation'
import { WebButton, WebChipLink } from './WebButton'
import VideoGrid from './WebVideoGrid'
import Status from './WebStatus'
import WebText from './WebText'
import styles from './WebHomeDiscovery.module.css'

export default function WebHomeDiscovery({ visible, renderCard, onUnauthorized }: {
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
    if (document.activeElement === document.querySelector('[data-web-logout]')) {
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
  return <div ref={homeRoot} hidden={!visible} className={styles.root} data-web-home aria-busy={busy}>
    {error && <Status error={error} retry={() => {
      retryFocus.current = true
      document.querySelector<HTMLElement>('[data-web-logout]')?.focus({ preventScroll: true })
      setSeed(String(Math.random()))
    }} />}
    {!snapshot && !error ? <Status error="正在加载首页…" /> : snapshot && <>
      <section aria-labelledby="discovery-heading">
        <div className={styles.heading} data-web-home-heading data-navigation-group>
          <h2 id="discovery-heading">随机发现</h2>
          <WebButton aria-disabled={busy} onClick={() => { if (!busy) setSeed(String(Math.random())) }}>换一批</WebButton>
        </div>
        {snapshot.discovery.length ? <VideoGrid videos={snapshot.discovery} renderCard={renderCard} />
          : <WebText tone="muted">暂无可发现的影片，请在桌面端启用媒体库的首页发现。</WebText>}
      </section>
      <section aria-labelledby="recent-heading">
        <div className={styles.heading} data-web-home-heading data-navigation-group>
          <h2 id="recent-heading">近期添加</h2>
          <WebChipLink href={route('/browse', new URLSearchParams({ sort: 'recent' }))}>查看全部</WebChipLink>
        </div>
        {snapshot.recent.length ? <VideoGrid videos={snapshot.recent} renderCard={renderCard} />
          : <WebText tone="muted">还没有近期添加的影片。</WebText>}
      </section>
    </>}
  </div>
}
