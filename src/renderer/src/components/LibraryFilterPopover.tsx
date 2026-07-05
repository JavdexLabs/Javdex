import { useEffect, useRef, type RefObject } from 'react'
import type { VideoQuery, ScrapedStatus } from '@shared/types'
import { isDismissExemptPortaledTarget } from '../lib/dismissLayerGuards'
import SelectControl from './SelectControl'
import TagFilter from './TagFilter'

export interface LibraryFilterState {
  status: ScrapedStatus | 'all'
  year: number | 'all'
  codePrefix: string
  sortBy: NonNullable<VideoQuery['sortBy']>
  sortDir: NonNullable<VideoQuery['sortDir']>
  tagIds: number[]
}

interface Props {
  open: boolean
  onClose: () => void
  years: number[]
  state: LibraryFilterState
  onChange: (patch: Partial<LibraryFilterState>) => void
  onReset: () => void
  anchorRef: RefObject<HTMLElement | null>
}

/** Popover panel for library filters (Radarr / Jellyfin-style). */
export default function LibraryFilterPopover({
  open,
  onClose,
  years,
  state,
  onChange,
  onReset,
  anchorRef
}: Props): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      if (isDismissExemptPortaledTarget(t)) return
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
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div ref={panelRef} className="library-filter-popover" role="dialog" aria-label="筛选">
      <header className="library-filter-popover-head">
        <h3 className="library-filter-popover-title">筛选</h3>
      </header>

      <div className="library-filter-popover-body">
      <div className="library-filter-popover-grid">
        <label className="library-filter-field">
          <span className="library-filter-field-label">刮削状态</span>
          <SelectControl
            className="library-filter-input"
            value={String(state.status)}
            onChange={(e) =>
              onChange({
                status:
                  e.target.value === 'all' ? 'all' : (Number(e.target.value) as ScrapedStatus)
              })
            }
          >
            <option value="all">全部</option>
            <option value="1">已刮削</option>
            <option value="0">未刮削</option>
            <option value="2">刮削失败</option>
          </SelectControl>
        </label>

        <label className="library-filter-field">
          <span className="library-filter-field-label">年份</span>
          <SelectControl
            className="library-filter-input"
            value={String(state.year)}
            onChange={(e) =>
              onChange({
                year: e.target.value === 'all' ? 'all' : Number(e.target.value)
              })
            }
          >
            <option value="all">全部</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </SelectControl>
        </label>

        <label className="library-filter-field library-filter-field--wide">
          <span className="library-filter-field-label">番号系列</span>
          <input
            className="text-input library-filter-input"
            placeholder="输入系列前缀"
            value={state.codePrefix}
            onChange={(e) => onChange({ codePrefix: e.target.value.toUpperCase() })}
          />
        </label>
      </div>

      <div className="library-filter-popover-tags">
        <div className="library-filter-tags-head">
          <span className="library-filter-field-label">标签</span>
          <span className="library-filter-tags-hint" title="所选标签须同时包含">
            须同时包含
          </span>
        </div>
        <TagFilter
          selected={state.tagIds}
          onChange={(tagIds) => onChange({ tagIds })}
          showInlineChips={false}
          variant="popover"
        />
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
