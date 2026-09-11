import ContinuousGrid from './ContinuousGrid'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTagFilterOptions } from '../hooks/useTagFilterOptions'
import { useTagLabels } from '../hooks/useTagLabels'
import { useDebounce } from '../hooks/useDebounce'
import { isDismissExemptPortaledTarget } from '../lib/dismissLayerGuards'
import Button from './Button'
import Checkbox from './Checkbox'

interface TagItem {
  id: number
  label: string
  video_count: number
}

interface Props {
  selected: number[]
  onChange: (ids: number[]) => void
  /** When false, selected tags only appear in the parent applied-filters bar. */
  showInlineChips?: boolean
  /** Compact chip cloud inside library filter popover (always visible). */
  variant?: 'default' | 'popover'
}

function TagChipCloud({
  items,
  selected,
  disabled,
  loading,
  error,
  hasMore,
  onRetry,
  onToggle,
  onNeedRange
}: {
  items: TagItem[]
  selected: number[]
  disabled: (id: number) => boolean
  loading: boolean
  error: string | null
  hasMore: boolean
  onRetry: () => void
  onToggle: (id: number) => void
  onNeedRange: (start: number, end: number) => void
}): JSX.Element {
  const cloudRef = useRef<HTMLDivElement>(null)
  const onScroll = (event: { currentTarget: { scrollTop: number; clientHeight: number; scrollHeight: number } }): void => {
    const { scrollTop, clientHeight, scrollHeight } = event.currentTarget
    const overflow = scrollHeight > clientHeight + 8
    if (scrollTop <= 24) onNeedRange(0, 20)
    if (overflow && scrollTop + clientHeight >= scrollHeight - 32) {
      onNeedRange(Math.max(items.length, 1) - 1, items.length + 99)
    }
  }

  useLayoutEffect(() => {
    const cloud = cloudRef.current
    if (!cloud || loading || error || !hasMore || items.length === 0 || items.length >= 300) return
    if (cloud.scrollHeight <= cloud.clientHeight + 8) {
      onNeedRange(Math.max(items.length, 1) - 1, items.length + 99)
    }
  }, [items.length, hasMore, loading, error, onNeedRange])

  return (
    <>
      <div ref={cloudRef} className="tag-chip-cloud" role="listbox" aria-label="标签" aria-multiselectable onScroll={onScroll}>
        {items.length === 0 && !loading && !error ? (
          <div className="tag-chip-cloud-empty">无匹配标签</div>
        ) : (
          items.map((tag) => {
            const selectedTag = selected.includes(tag.id)
            return (
              <button
                key={tag.id}
                type="button"
                role="option"
                aria-selected={selectedTag}
                className={selectedTag ? 'tag-chip-cloud-item tag-chip-cloud-item--selected' : 'tag-chip-cloud-item'}
                disabled={disabled(tag.id)}
                onClick={() => onToggle(tag.id)}
              >
                <span className="tag-chip-cloud-name">{tag.label}</span>
                <span className="tag-chip-cloud-count">{tag.video_count}</span>
              </button>
            )
          })
        )}
        {loading ? <span role="status">读取中…</span> : null}
      </div>
      {error ? <div role="alert">{error}<Button size="sm" onClick={onRetry}>重试</Button></div> : null}
    </>
  )
}

/**
 * Multi-select tag filter. Selecting multiple tags filters videos that contain ALL selected tags.
 */
export default function TagFilter({
  selected,
  onChange,
  showInlineChips = true,
  variant = 'default'
}: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const addRef = useRef<HTMLDivElement>(null)

  const isCompact = variant === 'popover'

  const debouncedSearch = useDebounce(search.trim(), 250)
  const page = useTagFilterOptions(isCompact || open, debouncedSearch)
  const byId = useTagLabels(selected, showInlineChips)

  useEffect(() => {
    if (!open || isCompact) return
    const onDocClick = (e: MouseEvent): void => {
      const target = e.target as Node
      if (addRef.current?.contains(target)) return
      if (isDismissExemptPortaledTarget(target)) return
      setOpen(false)
    }
    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', onDocClick)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', onDocClick)
    }
  }, [open, isCompact])

  const toggle = (id: number): void => {
    if (!selected.includes(id) && selected.length >= 100) return
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  const chips =
    showInlineChips &&
    selected.map((id) => (
      <button
        key={id}
        type="button"
        className="tag-chip selected"
        onClick={() => toggle(id)}
      >
        {byId.get(id) ?? id} ×
      </button>
    ))

  const atLimit = (id: number): boolean => !selected.includes(id) && selected.length >= 100

  const searchField = (
    <input
      className={isCompact ? 'text-input library-filter-input tag-chip-cloud-search' : 'text-input tag-popover-search'}
      placeholder="搜索标签…"
      aria-label="搜索标签"
      maxLength={500}
      value={search}
      autoFocus={!isCompact}
      onChange={(e) => setSearch(e.target.value)}
    />
  )
  const hint = <div className="library-filter-tags-hint" aria-live="polite">按名称{selected.length >= 100 ? ' · 最多选择100个标签' : ''}</div>

  if (isCompact) {
    return (
      <div className="tag-filter tag-filter--compact">
        {searchField}
        {hint}
        <TagChipCloud
          items={page.items}
          selected={selected}
          disabled={atLimit}
          loading={page.loading}
          error={page.error}
          hasMore={page.hasMore}
          onRetry={page.reload}
          onToggle={toggle}
          onNeedRange={page.window.onVisibleRange}
        />
      </div>
    )
  }

  return (
    <div className="tag-filter">
      <div className="tag-filter-row">
        <div className="tag-filter-add" ref={addRef}>
          <Button type="button" size="sm" className="tag-filter-add-btn" onClick={() => setOpen(value => !value)}>
            添加标签{selected.length ? ` (${selected.length})` : ''}
          </Button>
          {open ? (
            <div className="tag-popover">
              {searchField}
              {hint}
              <div className="tag-picker-list">
                <ContinuousGrid contained fill window={page.window} scope={`tag-filter:${debouncedSearch}`}
                  label="标签候选" emptyLabel="无标签" itemHeight={36} itemKey={tag => tag.id}
                  renderItem={tag => {
                    const selectedTag = selected.includes(tag.id)
                    return (
                      <label className="tag-option">
                        <Checkbox checked={selectedTag} disabled={atLimit(tag.id)} onChange={() => toggle(tag.id)} />
                        <span className="tag-option-name">{tag.label}</span>
                        <span className="tag-option-count">{tag.video_count}</span>
                      </label>
                    )
                  }} />
              </div>
            </div>
          ) : null}
        </div>
        {chips}
      </div>
    </div>
  )
}
