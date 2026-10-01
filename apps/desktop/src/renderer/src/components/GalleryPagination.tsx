import Button from './Button'
import styles from './GalleryPagination.module.css'

interface Props {
  label: string
  offset: number
  total: number
  loadedCount: number
  compact?: boolean
  hideTotal?: boolean
  onMove: (offset: number) => void
}

/** Gallery queries keep the existing 60-item page contract. */
export default function GalleryPagination({
  label, offset, total, loadedCount, compact = false, hideTotal = false, onMove
}: Props): JSX.Element | null {
  if (total <= 60) return null
  return (
    <nav className={styles.root} aria-label={label}>
      <Button size={compact ? 'sm' : undefined} disabled={offset === 0} onClick={() => onMove(offset - 60)}>上一页</Button>
      <span>第 {Math.floor(offset / 60) + 1} 页{hideTotal ? '' : ` · 共 ${total} 张`}</span>
      <Button size={compact ? 'sm' : undefined} disabled={offset + loadedCount >= total} onClick={() => onMove(offset + 60)}>下一页</Button>
    </nav>
  )
}
