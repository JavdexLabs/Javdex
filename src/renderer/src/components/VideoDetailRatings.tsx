import type { VideoDetail, VideoExternalStats } from '@shared/types'
import StarRating from './StarRating'

function formatExternalScore(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function formatRatingCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

function hasExternalRating(stat: VideoExternalStats): boolean {
  return stat.rating_average != null && Number.isFinite(stat.rating_average)
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
  const externalRatings = video.external_stats.filter(hasExternalRating)

  return (
    <div className="detail-ratings" aria-label="评分">
      <div className="detail-rating-group">
        <span className="detail-rating-label">自定义评分</span>
        <StarRating value={video.rating} onChange={onRatingChange} size={22} />
      </div>
      {externalRatings.length > 0 && (
        <>
          <span className="detail-ratings-divider" aria-hidden />
          <div className="detail-rating-group">
            <span className="detail-rating-label">外部评分</span>
            <div className="detail-external-ratings">
              {externalRatings.map((stat) => (
                <div key={stat.id} className="detail-external-rating" title={buildExternalRatingMeta(stat)}>
                  <span className="detail-external-rating-score">
                    {formatExternalScore(stat.rating_average!)}
                  </span>
                  <span className="detail-external-rating-meta">{buildExternalRatingMeta(stat)}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
