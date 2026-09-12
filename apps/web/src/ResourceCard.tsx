import { useEffect, useRef, useState } from 'react'
import { Copy, Download, ExternalLink, Play, FileVideo, Link, X } from 'lucide-react'
import type { WebResource } from '../../../packages/contracts/src/webTypes'

type Feedback = { message: string; link?: string; transient?: boolean; opener: HTMLElement }
export default function ResourceList({ resources, selected, play }: {
  resources: WebResource[]; selected: number | null | undefined; play: (id: number) => void
}): JSX.Element {
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const revision = useRef(0)
  useEffect(() => () => { revision.current++ }, [])
  useEffect(() => {
    if (!feedback?.transient) return
    const timer = window.setTimeout(() => setFeedback(null), 2500)
    return () => window.clearTimeout(timer)
  }, [feedback])
  const copy = async (r: WebResource, opener: HTMLElement): Promise<void> => {
    if (!r.link) return
    const current = ++revision.current
    setFeedback(null)
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(r.link)
      else {
        const field = document.createElement('textarea')
        field.value = r.link
        field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
        document.body.append(field)
        try { field.select(); if (!document.execCommand('copy')) throw new Error('copy failed') }
        finally { field.remove(); opener.focus({ preventScroll: true }) }
      }
      if (revision.current === current) setFeedback({ message: '链接已复制', transient: true, opener })
    } catch {
      if (revision.current === current) setFeedback({ message: '复制失败，请手动复制', link: r.link, opener })
    }
  }
  const explain = (r: WebResource, opener: HTMLElement): void => {
    revision.current++
    setFeedback({ message: r.reason || '此资源暂不可用，请在桌面端检查资源。', opener })
  }
  const close = (): void => {
    revision.current++
    if (feedback?.opener.isConnected) feedback.opener.focus({ preventScroll: true })
    setFeedback(null)
  }
  return <>
    <div className="resources" data-navigation-group>
      {resources.map(r => <ResourceCard key={r.id} resource={r} selected={r.id === selected}
        duplicate={resources.some(other => other.id !== r.id && other.name === r.name)} play={() => play(r.id)}
        copy={(resource, opener) => void copy(resource, opener)} explain={explain} />)}
    </div>
    {feedback && <div className="resource-toast" role="status">
      <span>{feedback.message}</span>
      {feedback.link && <input className="resource-copy-fallback" readOnly value={feedback.link}
        aria-label="复制失败，请手动复制链接" onFocus={event => event.currentTarget.select()} />}
      <button aria-label="关闭资源提示" onClick={close}><X aria-hidden="true" /></button>
    </div>}
  </>
}
function ResourceCard({ resource: r, selected, duplicate, play, copy, explain }: {
  resource: WebResource; selected: boolean; duplicate: boolean; play: () => void;
  copy: (resource: WebResource, opener: HTMLElement) => void;
  explain: (resource: WebResource, opener: HTMLElement) => void
}): JSX.Element {
  const kind = { local: '本地视频', direct: '直连视频', web: '网页链接', magnet: '磁力链接', ed2k: '电驴链接' }[r.kind] || '链接资源'
  const metadata = [r.format || kind,
    r.sizeBytes && r.sizeBytes > 0 ? `${(r.sizeBytes / (r.sizeBytes >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2)).toFixed(1)} ${r.sizeBytes >= 1024 ** 3 ? 'GB' : 'MB'}` : null,
    r.durationSeconds && r.durationSeconds > 0 ? `${Math.round(r.durationSeconds / 60)} 分钟` : null,
    duplicate ? r.libraryName : null].filter(Boolean).join(' · ')
  const heading = <>
    {r.playable ? <Play aria-hidden="true" /> : r.kind === 'local' ? <FileVideo aria-hidden="true" /> : <Link aria-hidden="true" />}
    <span className="resource-info">
      <span className="resource-name" title={r.name}>{r.name}</span>
      <span className="resource-meta"><small title={metadata}>{metadata}</small>
        {r.isPrimary && <span className="resource-primary" aria-label="主资源" title="主资源">主</span>}
        {!r.playable && r.kind === 'local' && <span className="resource-availability">
          {r.downloadUrl ? '仅下载' : '不可用'}
        </span>}
      </span>
    </span>
  </>
  return <article className={`resource-card${selected ? ' resource-selected' : ''}`} aria-label={r.name}>
    {r.playable ? <button className="resource-heading" onClick={play} aria-pressed={selected} aria-label={`播放 ${r.name}`}>{heading}</button>
      : <button className="resource-heading" aria-label={`查看资源说明 ${r.name}`} onClick={event => explain(r, event.currentTarget)}>{heading}</button>}
    <div className="resource-actions" data-navigation-group>
      {r.downloadUrl && <a href={r.downloadUrl} download aria-label="下载" title="下载"><Download aria-hidden="true" /></a>}
      {r.link && <><button onClick={event => copy(r, event.currentTarget)} aria-label="复制链接" title="复制链接"><Copy aria-hidden="true" /></button>
        <a href={r.link} target="_blank" rel="noopener noreferrer" aria-label="打开链接" title="打开链接"><ExternalLink aria-hidden="true" /></a></>}
    </div>
  </article>
}

