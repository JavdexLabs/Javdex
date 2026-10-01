import { forwardRef, useState, type AnchorHTMLAttributes } from 'react'
import { Film, Play } from 'lucide-react'
import { imageThumbnailUrl } from '../../../packages/contracts/src/imageVariants'
import type { WebVideo } from '../../../packages/contracts/src/webTypes'
import styles from './WebVideoCard.module.css'

function Poster({ video }: { video: WebVideo }): JSX.Element {
  const [failed, setFailed] = useState(false)
  return <div className={styles.poster}>
    {video.cover && !failed ? <img src={imageThumbnailUrl(video.cover, 640)} alt=""
      loading="lazy" decoding="async" onError={() => setFailed(true)} />
      : <div className={styles.placeholder}><Film aria-hidden="true" /><span>{video.code}</span></div>}
    <span className={styles.play}><Play aria-hidden="true" /></span>
    <span className={styles.code}>{video.code}</span>
  </div>
}

export default forwardRef<HTMLAnchorElement, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> & {
  video: WebVideo
}>(function WebVideoCard({ video, className = '', ...props }, ref) {
  return <a {...props} ref={ref} className={`${styles.card} ${className}`} data-web-video-card={video.id}>
    <Poster video={video} />
    <h2>{video.title}</h2>
    <p>
      <span>{video.releaseDate?.slice(0, 4) || '年份未知'}</span>
      <span>{video.duration ? `${Math.round(video.duration / 60)} 分钟` : ''}</span>
      {video.rating > 0 && <span className={styles.rating}>★ {video.rating}</span>}
    </p>
  </a>
})
