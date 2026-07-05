import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { isDismissExemptPortaledTarget } from '../lib/dismissLayerGuards'

interface TagItem {
  id: number
  name: string
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
            <input
              type="checkbox"
              checked={selected.includes(t.id)}
              onChange={() => onToggle(t.id)}
            />
            <span className="tag-option-name">{t.name}</span>
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
            className={`tag-chip-cloud-item${isSelected ? ' tag-chip-cloud-item--selected' : ''}`}
            onClick={() => onToggle(t.id)}
          >
            <span className="tag-chip-cloud-name">{t.name}</span>
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
  const [tags, setTags] = useState<TagItem[]>([])
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const addRef = useRef<HTMLDivElement>(null)

  const isCompact = variant === 'popover'

  useEffect(() => {
    api.tags
      .list()
      .then(setTags)
      .catch(() => {})
  }, [])

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

  const byId = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = q ? tags.filter((t) => t.name.toLowerCase().includes(q)) : [...tags]
    if (isCompact) {
      list.sort((a, b) => b.video_count - a.video_count)
    }
    return list.slice(0, 200)
  }, [tags, search, isCompact])

  const toggle = (id: number): void => {
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
        {byId.get(id)?.name ?? id} ×
      </button>
    ))

  if (isCompact) {
    return (
      <div className="tag-filter tag-filter--compact">
        <input
          className="text-input library-filter-input tag-chip-cloud-search"
          placeholder="搜索标签…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="搜索标签"
        />
        <TagChipCloud filtered={filtered} selected={selected} onToggle={toggle} />
      </div>
    )
  }

  return (
    <div className="tag-filter">
      <div className="tag-filter-row">
        <div className="tag-filter-add" ref={addRef}>
          <button type="button" className="btn btn-sm tag-filter-add-btn" onClick={() => setOpen((o) => !o)}>
            添加标签{selected.length ? ` (${selected.length})` : ''}
          </button>

          {open ? (
            <div className="tag-popover">
              <input
                className="text-input tag-popover-search"
                autoFocus
                placeholder="搜索标签…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <TagOptionList filtered={filtered} selected={selected} onToggle={toggle} />
            </div>
          ) : null}
        </div>

        {chips}
      </div>
    </div>
  )
}
