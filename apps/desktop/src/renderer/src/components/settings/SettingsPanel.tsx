import type { ComponentPropsWithoutRef } from 'react'
import styles from './SettingsPanel.module.css'

export default function SettingsPanel({ className, ...props }: ComponentPropsWithoutRef<'section'>): JSX.Element {
  return <section {...props} className={`${styles.panel}${className ? ` ${className}` : ''}`} />
}

export function SettingsPanelHead({ className, topAligned = false, ...props }: ComponentPropsWithoutRef<'div'> & { topAligned?: boolean }): JSX.Element {
  return <div {...props} className={`${styles.head}${topAligned ? ` ${styles.headTopAligned}` : ''}${className ? ` ${className}` : ''}`} />
}

export function SettingsPanelTitle({ className, standalone = false, ...props }: ComponentPropsWithoutRef<'h3'> & { standalone?: boolean }): JSX.Element {
  return <h3 {...props} className={`${styles.title}${standalone ? ` ${styles.titleStandalone}` : ''}${className ? ` ${className}` : ''}`} />
}
