import type { ScrapedStatus } from '@shared/types'
import { actressStatusFilterOf, ACTRESS_STATUS_FILTER_LABELS } from '@shared/types'

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
      className={`actress-status-badge actress-status-badge--${filter}`}
      role="img"
      aria-label={`刮削状态：${label}`}
    >
      {label}
    </span>
  )
}
