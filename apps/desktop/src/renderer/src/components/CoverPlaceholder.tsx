import type { ReactNode } from 'react'
import styles from './CoverPlaceholder.module.css'

export default function CoverPlaceholder({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.root}>{children}</div>
}
