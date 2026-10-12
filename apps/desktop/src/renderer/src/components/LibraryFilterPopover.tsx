import { useEffect, useRef, type RefObject } from 'react'
import type { VideoPendingScrapeFilter, VideoQuery, VideoResourceFilter } from '@shared/videoTypes'
import type { ScrapedStatus } from '@shared/commonTypes'
import { InteractionLayerOwner, useInteractionLayer } from '../interaction/useInteractionLayer'
import SelectControl from './SelectControl'
import TextInput from './TextInput'
import TagFilter from './TagFilter'
import FilterPanelContent, { FilterPanelShell, FilterFields, FilterField, FilterFieldLabel } from './FilterPanelContent'
import VideoResourceFilterFieldset from './VideoResourceFilterFieldset'
import styles from './LibraryFilterPopover.module.css'

export interface LibraryFilterState {
  status: ScrapedStatus | 'all'
  pendingScrape: VideoPendingScrapeFilter
  year: number | 'all'
  codePrefix: string
  sortBy: NonNullable<VideoQuery['sortBy']>
  sortDir: NonNullable<VideoQuery['sortDir']>
  tagIds: number[]
  resourceKinds: VideoResourceFilter[]
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
  const layer = useInteractionLayer({ enabled: open, rootRef: panelRef, anchorRef, onDismiss: onClose })

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!layer.isTop() || layer.contains(t)) return
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
    <FilterPanelShell ref={panelRef} role="dialog" aria-label="筛选">
      <FilterPanelContent onReset={onReset} onClose={onClose}>
      <FilterFields>
        <FilterField label="刮削状态">
          <SelectControl
            variant="filter"
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
        </FilterField>

        <FilterField label="待确认刮削">
          <SelectControl
            variant="filter"
            value={state.pendingScrape}
            onChange={(event) =>
              onChange({ pendingScrape: event.target.value as VideoPendingScrapeFilter })
            }
          >
            <option value="all">全部</option>
            <option value="pending">仅待确认</option>
            <option value="none">排除待确认</option>
          </SelectControl>
        </FilterField>

        <FilterField label="年份">
          <SelectControl
            variant="filter"
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
        </FilterField>

        <FilterField label="番号系列" wide>
          <TextInput
            variant="filter"
            placeholder="输入系列前缀"
            value={state.codePrefix}
            onChange={(e) => onChange({ codePrefix: e.target.value.toUpperCase() })}
          />
        </FilterField>
      </FilterFields>

      <VideoResourceFilterFieldset
        value={state.resourceKinds}
        onChange={(resourceKinds) => onChange({ resourceKinds })}
      />

      <div className={styles.tags}>
        <div className={styles.tagsHeader}>
          <FilterFieldLabel>标签</FilterFieldLabel>
          <span className={styles.tagsHint} title="所选标签须同时包含">
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
      </FilterPanelContent>
    </FilterPanelShell>
    </InteractionLayerOwner.Provider>
  )
}
