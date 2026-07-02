import FilterChip from './FilterChip'

export interface AppliedFilterItem {
  key: string
  label: string
  onRemove: () => void
}

interface AppliedFilterBarProps {
  items: AppliedFilterItem[]
  onClear: () => void
}

export default function AppliedFilterBar({
  items,
  onClear
}: AppliedFilterBarProps): JSX.Element | null {
  if (items.length === 0) return null

  return (
    <div className="applied-filter-bar" role="status" aria-live="polite">
      <span className="applied-filter-bar__label">已筛选</span>
      <div className="applied-filter-bar__chips">
        {items.map((item) => (
          <FilterChip key={item.key} label={item.label} onRemove={item.onRemove} />
        ))}
      </div>
      <button type="button" className="applied-filter-bar__clear" onClick={onClear}>
        清除全部
      </button>
    </div>
  )
}
