import type { ReactNode } from 'react'
import styles from './ClassificationDeleteNotice.module.css'

export function ClassificationDeleteError({ children }: { children: ReactNode }): JSX.Element {
  return <p className={styles.error}>{children}</p>
}

export default function ClassificationDeleteNotice({
  pending,
  error,
  children
}: {
  pending: boolean
  error: string | null
  children: ReactNode
}): JSX.Element {
  return (
    <div className={styles.root}>
      {pending && !error ? <p>正在检查影响范围…</p> : null}
      {children}
      {error ? <ClassificationDeleteError>{error}</ClassificationDeleteError> : null}
    </div>
  )
}
