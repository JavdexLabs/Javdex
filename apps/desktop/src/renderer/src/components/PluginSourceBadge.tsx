import type { ReactNode } from 'react'
import type { ScraperPluginSource } from '@shared/scraperPluginTypes'
import styles from './PluginSourceBadge.module.css'

export default function PluginSourceBadge({
  source,
  children
}: {
  source: ScraperPluginSource
  children: ReactNode
}): JSX.Element {
  return <span className={`${styles.badge} ${styles[source]}`}>{children}</span>
}
