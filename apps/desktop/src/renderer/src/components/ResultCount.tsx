import type { HTMLAttributes } from 'react'
import styles from './ResultCount.module.css'

interface Props extends HTMLAttributes<HTMLSpanElement> {
  width?: 'content' | 'media' | 'facet'
  stable?: boolean
  fetching?: boolean
}

/** Stable, right-aligned result counts shared by list and detail toolbars. */
export default function ResultCount({ width = 'content', stable = true, fetching = false, className = '', children, ...props }: Props): JSX.Element {
  return <span {...props} className={`${styles.root} ${className}`} data-width={width} data-stable={stable || undefined}>
    {children}
    {fetching ? <span className={styles.fetchHint} aria-hidden="true"> ↻</span> : null}
  </span>
}
