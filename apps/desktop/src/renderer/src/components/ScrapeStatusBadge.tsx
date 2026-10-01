import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { ScrapedStatus } from '@shared/commonTypes'
import styles from './ScrapeStatusBadge.module.css'

export default function ScrapeStatusBadge({
  status,
  as = 'span',
  className = '',
  children
}: {
  status: ScrapedStatus
  as?: 'span' | 'dd'
  className?: string
  children: ReactNode
}): JSX.Element {
  const badgeClass = `${styles.root}${className ? ` ${className}` : ''}`
  if (as === 'dd') {
    return <dd className={badgeClass} data-status={status}>{children}</dd>
  }
  return <span className={badgeClass} data-status={status}>{children}</span>
}

export function PendingScrapeBadge({
  className = '',
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      type={type}
      className={`${styles.root}${className ? ` ${className}` : ''}`}
      data-pending="true"
      {...rest}
    />
  )
}
