import type { RefObject } from 'react'
import type { ActressListStatusCounts, ActressListStatusFilter } from '@shared/types'
import FloatingLayer from './FloatingLayer'
import { useEscapeKey } from '../hooks/useEscapeKey'

export const ACTRESS_STATUS_FILTER_LABELS: Record<ActressListStatusFilter, string> = {
  all: '全部状态',
  success: '刮削成功',
  unscraped: '未刮削',
  failed: '刮削失败'
}

const ACTRESS_STATUS_FILTER_ORDER: ActressListStatusFilter[] = [
  'all',
  'success',
  'unscraped',
  'failed'
]

interface Props {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  value: ActressListStatusFilter
  counts: ActressListStatusCounts
  onChange: (status: ActressListStatusFilter) => void
  onClose: () => void
}

/** Cumulative scrape status filter for the actress list toolbar. */
export default function ActressStatusFilterPopover({
  open,
  anchorRef,
  value,
  counts,
  onChange,
  onClose
}: Props): JSX.Element | null {
  useEscapeKey(onClose, open)

  return (
    <FloatingLayer
      open={open}
      anchorRef={anchorRef}
      side="bottom"
      align="end"
      offset={6}
      className="status-filter-popover"
      onClose={onClose}
    >
      <div className="status-filter-options" role="group" aria-label="刮削状态">
        {ACTRESS_STATUS_FILTER_ORDER.map((status) => (
          <button
            key={status}
            type="button"
            className={`status-filter-option${status === value ? ' is-active' : ''}`}
            aria-pressed={status === value}
            onClick={() => {
              onChange(status)
              onClose()
            }}
          >
            <span>{ACTRESS_STATUS_FILTER_LABELS[status]}</span>
            <span className="status-filter-option-count">{counts[status]}</span>
          </button>
        ))}
      </div>
    </FloatingLayer>
  )
}
