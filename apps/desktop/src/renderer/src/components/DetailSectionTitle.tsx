import type { ReactNode } from 'react'
import styles from './DetailSectionTitle.module.css'

export default function DetailSectionTitle({ children, grow = false }: {
  children: ReactNode
  grow?: boolean
}): JSX.Element {
  return <h2 className={styles.root} data-grow={grow || undefined}>{children}</h2>
}
