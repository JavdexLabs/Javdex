import FilterChip from './FilterChip'
import styles from './AppliedFilterBar.module.css'

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
    <div className={styles.root} role="status" aria-live="polite">
      <span className={styles.label}>已筛选</span>
      <div className={styles.chips}>
        {items.map((item) => (
          <FilterChip key={item.key} label={item.label} onRemove={item.onRemove} />
        ))}
      </div>
      <button type="button" className={styles.clear} onClick={onClear}>
        清除全部
      </button>
    </div>
  )
}
