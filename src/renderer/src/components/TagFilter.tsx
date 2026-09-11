import Checkbox from './Checkbox'
import { useEffect, useRef, useState } from 'react'
import { useTagFilterOptions } from '../hooks/useTagFilterOptions'
import { useTagLabels } from '../hooks/useTagLabels'
import { useDebounce } from '../hooks/useDebounce'
import { isDismissExemptPortaledTarget } from '../lib/dismissLayerGuards'
import Button from './Button'

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

function TagOptionList({
  filtered,
  selected,
  onToggle
}: {
  filtered: TagItem[]
  selected: number[]
  onToggle: (id: number) => void
}): JSX.Element {
  return (
    <div className="tag-picker-list">
      {filtered.length === 0 ? (
        <div className="tag-picker-empty">无标签</div>
      ) : (
        filtered.map((t) => (
          <label key={t.id} className="tag-option">
            <Checkbox
              checked={selected.includes(t.id)}
              disabled={!selected.includes(t.id) && selected.length >= 100}
              onChange={() => onToggle(t.id)}
            />
            <span className="tag-option-name">{t.label}</span>
            <span className="tag-option-count">{t.video_count}</span>
          </label>
        ))
      )}
    </div>
  )
}

function TagChipCloud({
  filtered,
  selected,
  onToggle
}: {
  filtered: TagItem[]
  selected: number[]
  onToggle: (id: number) => void
}): JSX.Element {
  if (filtered.length === 0) {
    return <div className="tag-chip-cloud-empty">无匹配标签</div>
  }

  return (
    <div className="tag-chip-cloud" role="listbox" aria-label="标签" aria-multiselectable>
      {filtered.map((t) => {
        const isSelected = selected.includes(t.id)
        return (
          <button
            key={t.id}
            type="button"
            role="option"
            aria-selected={isSelected}
            disabled={!isSelected && selected.length >= 100}
            className={`tag-chip-cloud-item${isSelected ? ' tag-chip-cloud-item--selected' : ''}`}
            onClick={() => onToggle(t.id)}
          >
            <span className="tag-chip-cloud-name">{t.label}</span>
            <span className="tag-chip-cloud-count">{t.video_count}</span>
          </button>
        )
      })}
    </div>
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

  const [offset, setOffset] = useState(0)
  const [retry, setRetry] = useState(0)
  const debouncedSearch = useDebounce(search.trim(), 250)
  const searchPending = search.trim() !== debouncedSearch
  const page = useTagFilterOptions((isCompact || open) && !searchPending, debouncedSearch, offset, retry)
  const byId = useTagLabels(selected, showInlineChips)
  const changeSearch = (value: string): void => { setSearch(value); setOffset(0) }

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

  const content = (
    <>
      <input
        className={isCompact ? 'text-input library-filter-input tag-chip-cloud-search' : 'text-input tag-popover-search'}
        placeholder="搜索标签…"
        aria-label="搜索标签"
        maxLength={500}
        value={search}
        onChange={(e) => changeSearch(e.target.value)}
      />
      <div className="library-filter-tags-hint" aria-live="polite">按名称 · 第 {offset / 100 + 1} 页{selected.length >= 100 ? ' · 最多选择100个标签' : ''}</div>
      {page.loading || searchPending ? <div role="status">正在加载标签…</div> : page.error ? (
        <div role="alert">{page.error} <Button size="sm" onClick={() => setRetry(value => value + 1)}>重试</Button></div>
      ) : isCompact ? <TagChipCloud filtered={page.items} selected={selected} onToggle={toggle} />
        : <TagOptionList filtered={page.items} selected={selected} onToggle={toggle} />}
      <nav className="tag-filter-pagination" aria-label="标签筛选分页">
        <Button size="sm" disabled={offset === 0 || page.loading || searchPending} onClick={() => setOffset(value => Math.max(0, value - 100))}>上一页</Button>
        <Button size="sm" disabled={!page.hasMore || page.loading || searchPending} onClick={() => setOffset(value => value + 100)}>下一页</Button>
      </nav>
    </>
  )
  if (isCompact) return <div className="tag-filter tag-filter--compact">{content}</div>
  return (
    <div className="tag-filter">
      <div className="tag-filter-row">
        <div className="tag-filter-add" ref={addRef}>
          <Button type="button" size="sm" className="tag-filter-add-btn" onClick={() => setOpen(value => !value)}>
            添加标签{selected.length ? ` (${selected.length})` : ''}
          </Button>
          {open ? <div className="tag-popover">{content}</div> : null}
        </div>
        {chips}
      </div>
    </div>
  )
}
