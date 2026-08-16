import type { ScrapedStatus } from '@shared/commonTypes'
import { actressStatusFilterOf, ACTRESS_STATUS_FILTER_LABELS } from '@shared/actressTypes'
import styles from './ActressStatusBadge.module.css'

/**
 * Corner badge for actresses that still need attention.
 * A successful cumulative scrape is the quiet default and stays unbadged.
 */
export default function ActressStatusBadge({
  status
}: {
  status: ScrapedStatus
}): JSX.Element | null {
  const filter = actressStatusFilterOf(status)
  if (filter === 'success') return null

  const label = ACTRESS_STATUS_FILTER_LABELS[filter]
  return (
    <span
      className={`${styles.root} ${styles[filter]} actress-status-badge actress-status-badge--${filter}`}
      role="img"
      aria-label={`刮削状态：${label}`}
    >
      {label}
    </span>
  )
}
