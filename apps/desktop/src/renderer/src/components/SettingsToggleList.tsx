import type { HTMLAttributes } from 'react'
import styles from './SettingsToggleList.module.css'

/** Shared enclosure for settings switch rows; feature layout stays at the caller. */
export default function SettingsToggleList({
  compact = false,
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement> & { compact?: boolean }): JSX.Element {
  return (
    <div
      className={`${styles.root}${compact ? ` ${styles.compact}` : ''}${className ? ` ${className}` : ''}`}
      {...props}
    />
  )
}
