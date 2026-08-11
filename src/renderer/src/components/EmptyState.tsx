import type { ReactNode } from 'react'
import Spinner from './Spinner'
import styles from './EmptyState.module.css'

export type EmptyStateVariant = 'page' | 'compact' | 'panel' | 'modal' | 'log' | 'fill'

interface EmptyStateProps {
  variant?: EmptyStateVariant
  icon?: ReactNode
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  loading?: boolean
  className?: string
}

export default function EmptyState({
  variant = 'page',
  icon,
  title,
  description,
  children,
  loading = false,
  className = ''
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={`${styles.root} ${styles[variant]} empty-state empty-state--${variant}${className ? ` ${className}` : ''}`}
      role={loading ? 'status' : undefined}
      aria-live={loading ? 'polite' : undefined}
    >
      {loading ? (
        <Spinner />
      ) : icon ? (
        <div className={`${styles.icon} empty-state-icon`}>{icon}</div>
      ) : null}
      {title ? <strong className={`${styles.title} empty-state-title`}>{title}</strong> : null}
      {description ? (
        <div className={`${styles.description} empty-state-description`}>{description}</div>
      ) : null}
      {children}
    </div>
  )
}
