import { useEffect, useRef, type RefObject } from 'react'
import type { ActressAvatarFilter, ActressListStatusFilter } from '@shared/actressTypes'
import { InteractionLayerOwner, useInteractionLayer } from '../interaction/useInteractionLayer'
import SelectControl from './SelectControl'
import FilterPanelContent, { FilterPanelShell, FilterFields, FilterField } from './FilterPanelContent'

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
  showFaceFilter?: boolean
}

function isActressStatus(value: string): value is ActressListStatusFilter {
  return value === 'all' || value === 'success' || value === 'unscraped' || value === 'failed'
}

function isActressAvatarFilter(value: string): value is ActressAvatarFilter {
  return value === 'all' || value === 'with' || value === 'without' || value === 'without-face'
}

/** Media-library-style filter panel for actress status and saved avatars. */
export default function ActressFilterPopover({
  open,
  onClose,
  state,
  onChange,
  onReset,
  anchorRef,
  showFaceFilter = true
}: Props): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null)
  const layer = useInteractionLayer({ enabled: open, rootRef: panelRef, anchorRef, onDismiss: onClose })

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!layer.isTop() || layer.contains(target)) return
      onClose()
    }
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDoc), 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [open, onClose, layer])

  if (!open) return null

  return (
    <InteractionLayerOwner.Provider value={layer.owner}>
    <FilterPanelShell
      ref={panelRef}
      role="dialog"
      aria-label="筛选"
    >
      <FilterPanelContent onReset={onReset} onClose={onClose} paddedEnd>
        <FilterFields>
          <FilterField label="刮削状态">
            <SelectControl
              variant="filter"
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
          </FilterField>

          <FilterField label="头像">
            <SelectControl
              variant="filter"
              value={state.avatar}
              onChange={(event) => {
                if (isActressAvatarFilter(event.target.value)) onChange({ avatar: event.target.value })
              }}
            >
              <option value="all">全部</option>
              <option value="with">有头像</option>
              <option value="without">无头像</option>
              {showFaceFilter ? <option value="without-face">无人脸</option> : null}
            </SelectControl>
          </FilterField>
        </FilterFields>
      </FilterPanelContent>
    </FilterPanelShell>
    </InteractionLayerOwner.Provider>
  )
}
