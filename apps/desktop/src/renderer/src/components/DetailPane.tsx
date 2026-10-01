import type { ReactNode } from 'react'
import styles from './DetailPane.module.css'

export default function DetailPane({ stacked = false, children }: {
  stacked?: boolean
  children: ReactNode
}): JSX.Element {
  return <div className={styles.root} data-detail-pane data-stacked={stacked || undefined}>{children}</div>
}

export function DetailPaneOverlay({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.overlay} data-detail-pane-overlay>{children}</div>
}
