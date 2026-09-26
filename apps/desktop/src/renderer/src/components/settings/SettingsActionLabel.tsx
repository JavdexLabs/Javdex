import type { ReactNode } from 'react'
import styles from './SettingsActionLabel.module.css'

/** Reserve the longest label without duplicating accessible text. */
export default function SettingsActionLabel({ reserve, children }: { reserve: string; children: ReactNode }): JSX.Element {
  return <span className={styles.root} data-reserve={reserve}><span className={styles.text}>{children}</span></span>
}
