import type { ReactNode } from 'react'
import type { FrozenTargetSlot } from '../query/resolveFrozenTargetSlots'
import styles from './FrozenTargetSlotCell.module.css'

/** Occupies a frozen target-list index. Deleted ids stay visible instead of stitching the next row into the hole. */
export default function FrozenTargetSlotCell<T extends { id: number }>({
  slot,
  children
}: {
  slot: FrozenTargetSlot<T>
  children?: ReactNode
}): JSX.Element {
  if (slot.status === 'ready') {
    return <div className={styles.ready}>{children}</div>
  }
  if (slot.status === 'missing') {
    return (
      <div className={styles.missing} aria-label="已删除">
        <span className={styles.label}>已删除</span>
      </div>
    )
  }
  return (
    <div className={styles.failed} role="alert">
      <span className={styles.label}>{slot.message}</span>
    </div>
  )
}
