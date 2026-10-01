import { useEffect, useRef, useState } from 'react'
import { Copy, Download, ExternalLink, Play, FileVideo, Link, X } from 'lucide-react'
import type { WebResource } from '../../../packages/contracts/src/webTypes'
import { WebButton } from './WebButton'
import WebTextInput from './WebTextInput'
import styles from './ResourceCard.module.css'

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
        field.className = styles.copyField
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
    <div className={styles.list} data-navigation-group>
      {resources.map(r => <ResourceCard key={r.id} resource={r} selected={r.id === selected}
        duplicate={resources.some(other => other.id !== r.id && other.name === r.name)} play={() => play(r.id)}
        copy={(resource, opener) => void copy(resource, opener)} explain={explain} />)}
    </div>
    {feedback && <div className={styles.feedback} role="status">
      <span>{feedback.message}</span>
      {feedback.link && <WebTextInput className={styles.copyFallback} readOnly value={feedback.link}
        aria-label="复制失败，请手动复制链接" onFocus={event => event.currentTarget.select()} />}
      <WebButton aria-label="关闭资源提示" onClick={close}><X aria-hidden="true" /></WebButton>
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
    <span className={styles.info}>
      <span className={styles.name} title={r.name}>{r.name}</span>
      <span className={styles.metadata}><small title={metadata}>{metadata}</small>
        {r.isPrimary && <span className={styles.primary} aria-label="主资源" title="主资源">主</span>}
        {!r.playable && r.kind === 'local' && <span className={styles.availability}>
          {r.downloadUrl ? '仅下载' : '不可用'}
        </span>}
      </span>
    </span>
  </>
  return <article className={styles.card} data-selected={selected} aria-label={r.name}>
    {r.playable ? <WebButton className={styles.heading} onClick={play} aria-pressed={selected} aria-label={`播放 ${r.name}`}>{heading}</WebButton>
      : <WebButton className={styles.heading} aria-label={`查看资源说明 ${r.name}`} onClick={event => explain(r, event.currentTarget)}>{heading}</WebButton>}
    <div className={styles.actions} data-navigation-group>
      {r.downloadUrl && <a href={r.downloadUrl} download aria-label="下载" title="下载"><Download aria-hidden="true" /></a>}
      {r.link && <><WebButton onClick={event => copy(r, event.currentTarget)} aria-label="复制链接" title="复制链接"><Copy aria-hidden="true" /></WebButton>
        <a href={r.link} target="_blank" rel="noopener noreferrer" aria-label="打开链接" title="打开链接"><ExternalLink aria-hidden="true" /></a></>}
    </div>
  </article>
}
