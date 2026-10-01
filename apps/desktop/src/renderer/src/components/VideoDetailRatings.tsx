import type { VideoDetail, VideoExternalStats } from '@shared/videoTypes'
import { selectDefaultExternalRating } from '@shared/externalRatings'
import StarRating from './StarRating'
import styles from './VideoDetailRatings.module.css'

function formatExternalScore(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function formatRatingCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

function buildExternalRatingMeta(stat: VideoExternalStats): string {
  const parts: string[] = [stat.source]
  if (stat.rating_count != null && stat.rating_count > 0) {
    parts.push(`${formatRatingCount(stat.rating_count)} 人`)
  }
  return parts.join(' · ')
}

interface Props {
  video: VideoDetail
  onRatingChange: (rating: number) => void
}

export default function VideoDetailRatings({ video, onRatingChange }: Props): JSX.Element {
  const selectedRating = selectDefaultExternalRating(video.external_stats)
  const externalRatings = selectedRating ? [selectedRating] : []

  return (
    <div className={styles.root} aria-label="评分">
      <div className={styles.group}>
        <span className={styles.label}>自定义评分</span>
        <StarRating value={video.rating} onChange={onRatingChange} size={22} />
      </div>
      {externalRatings.length > 0 && (
        <>
          <span className={styles.divider} aria-hidden />
          <div className={styles.group}>
            <span className={styles.label}>外部评分</span>
            <div className={styles.externalRatings}>
              {externalRatings.map((stat) => (
                <div key={stat.id} className={styles.externalRating} title={buildExternalRatingMeta(stat)}>
                  <span className={styles.score}>
                    {formatExternalScore(stat.rating_average!)}
                  </span>
                  <span className={styles.meta}>{buildExternalRatingMeta(stat)}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
