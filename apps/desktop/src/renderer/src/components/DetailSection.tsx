import type { ComponentProps } from 'react'
import styles from './DetailSection.module.css'

export function DetailSection({ className = '', ...props }: ComponentProps<'section'>): JSX.Element {
  return <section {...props} className={`${styles.root}${className ? ` ${className}` : ''}`} />
}

export function DetailSectionHead({ className = '', ...props }: ComponentProps<'div'>): JSX.Element {
  return <div {...props} className={`${styles.head}${className ? ` ${className}` : ''}`} />
}

export function DetailSectionCount({ className = '', ...props }: ComponentProps<'span'>): JSX.Element {
  return <span {...props} className={`${styles.count}${className ? ` ${className}` : ''}`} />
}

export function DetailSectionActions({ className = '', ...props }: ComponentProps<'div'>): JSX.Element {
  return <div {...props} className={`${styles.actions}${className ? ` ${className}` : ''}`} />
}
