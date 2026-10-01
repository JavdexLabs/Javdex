import type { ReactNode } from 'react'
import styles from './PlaylistCover.module.css'

export default function PlaylistCover({ variant, children }: {
  variant: 'card' | 'detail' | 'pick'
  children: ReactNode
}): JSX.Element {
  return <div className={styles.root} data-variant={variant}>{children}</div>
}
