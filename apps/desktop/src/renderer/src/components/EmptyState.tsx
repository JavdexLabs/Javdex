import type { ReactNode } from 'react'
import Spinner from './Spinner'
import styles from './EmptyState.module.css'

export type EmptyStateVariant = 'page' | 'compact' | 'gallery' | 'panel' | 'modal' | 'log' | 'fill'

interface EmptyStateProps {
  variant?: EmptyStateVariant
  icon?: ReactNode
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  loading?: boolean
  className?: string
  descriptionClassName?: string
}

export default function EmptyState({
  variant = 'page',
  icon,
  title,
  description,
  children,
  loading = false,
  className = '',
  descriptionClassName = ''
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={`${styles.root} ${styles[variant]}${className ? ` ${className}` : ''}`}
      data-empty-variant={variant}
      role={loading ? 'status' : undefined}
      aria-live={loading ? 'polite' : undefined}
    >
      {loading ? (
        <Spinner />
      ) : icon ? (
        <div className={styles.icon}>{icon}</div>
      ) : null}
      {title ? <strong className={styles.title}>{title}</strong> : null}
      {description ? (
        <div
          data-empty-part="description"
          className={`${styles.description}${descriptionClassName ? ` ${descriptionClassName}` : ''}`}
        >
          {description}
        </div>
      ) : null}
      {children}
    </div>
  )
}
