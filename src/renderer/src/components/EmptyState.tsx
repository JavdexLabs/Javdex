import type { ReactNode } from 'react'

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
      className={`empty-state empty-state--${variant}${className ? ` ${className}` : ''}`}
      role={loading ? 'status' : undefined}
      aria-live={loading ? 'polite' : undefined}
    >
      {loading ? <div className="spinner" /> : icon ? <div className="empty-state-icon">{icon}</div> : null}
      {title ? <strong className="empty-state-title">{title}</strong> : null}
      {description ? <div className="empty-state-description">{description}</div> : null}
      {children}
    </div>
  )
}
