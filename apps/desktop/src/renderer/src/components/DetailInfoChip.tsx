import type { ReactNode } from 'react'
import styles from './DetailInfoChip.module.css'

export default function DetailInfoChip({ variant, children }: {
  variant: 'stat' | 'alias'
  children: ReactNode
}): JSX.Element {
  return <span className={styles.root} data-variant={variant}>{children}</span>
}
