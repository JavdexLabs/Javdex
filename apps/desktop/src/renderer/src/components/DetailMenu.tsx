import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import styles from './DetailMenu.module.css'

export const DetailMenuAnchor = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function DetailMenuAnchor({ className = '', ...props }, ref) {
    return <div {...props} ref={ref} className={`${styles.anchor}${className ? ` ${className}` : ''}`} />
  }
)

export function DetailMenuPanel({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.panel} role="menu">{children}</div>
}

export function DetailMenuItem({
  danger = false,
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }): JSX.Element {
  return (
    <button
      {...props}
      type={type}
      role="menuitem"
      className={`${styles.item}${danger ? ` ${styles.danger}` : ''}${className ? ` ${className}` : ''}`}
    />
  )
}

export function DetailMenuSeparator(): JSX.Element {
  return <div className={styles.separator} />
}
