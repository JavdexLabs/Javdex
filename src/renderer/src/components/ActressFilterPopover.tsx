import { useEffect, useRef, type RefObject } from 'react'
import type { ActressAvatarFilter, ActressListStatusFilter } from '@shared/types'
import { isDismissExemptPortaledTarget } from '../lib/dismissLayerGuards'
import SelectControl from './SelectControl'

export interface ActressFilterState {
  status: ActressListStatusFilter
  avatar: ActressAvatarFilter
}

interface Props {
  open: boolean
  onClose: () => void
  state: ActressFilterState
  onChange: (patch: Partial<ActressFilterState>) => void
  onReset: () => void
  anchorRef: RefObject<HTMLElement | null>
}

function isActressStatus(value: string): value is ActressListStatusFilter {
  return value === 'all' || value === 'success' || value === 'unscraped' || value === 'failed'
}

function isActressAvatarFilter(value: string): value is ActressAvatarFilter {
  return value === 'all' || value === 'with' || value === 'without'
}

/** Media-library-style filter panel for actress status and saved avatars. */
export default function ActressFilterPopover({
  open,
  onClose,
  state,
  onChange,
  onReset,
  anchorRef
}: Props): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent): void => {
      const target = event.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      if (isDismissExemptPortaledTarget(target)) return
      onClose()
    }
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDoc), 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [open, onClose, anchorRef])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      ref={panelRef}
      className="library-filter-popover library-filter-popover--actress"
      role="dialog"
      aria-label="筛选"
    >
      <header className="library-filter-popover-head">
        <h3 className="library-filter-popover-title">筛选</h3>
      </header>

      <div className="library-filter-popover-body">
        <div className="library-filter-popover-grid">
          <label className="library-filter-field">
            <span className="library-filter-field-label">刮削状态</span>
            <SelectControl
              className="library-filter-input"
              value={state.status}
              onChange={(event) => {
                if (isActressStatus(event.target.value)) onChange({ status: event.target.value })
              }}
            >
              <option value="all">全部</option>
              <option value="success">刮削成功</option>
              <option value="unscraped">未刮削</option>
              <option value="failed">刮削失败</option>
            </SelectControl>
          </label>

          <label className="library-filter-field">
            <span className="library-filter-field-label">头像</span>
            <SelectControl
              className="library-filter-input"
              value={state.avatar}
              onChange={(event) => {
                if (isActressAvatarFilter(event.target.value)) onChange({ avatar: event.target.value })
              }}
            >
              <option value="all">全部</option>
              <option value="with">有头像</option>
              <option value="without">无头像</option>
            </SelectControl>
          </label>
        </div>
      </div>

      <footer className="library-filter-popover-footer">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onReset}>
          重置
        </button>
        <button type="button" className="btn btn-sm btn-primary" onClick={onClose}>
          完成
        </button>
      </footer>
    </div>
  )
}
