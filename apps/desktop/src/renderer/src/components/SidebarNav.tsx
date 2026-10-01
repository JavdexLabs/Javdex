import { forwardRef, type HTMLAttributes } from 'react'
import { NavLink, type NavLinkProps } from 'react-router-dom'
import styles from './SidebarNav.module.css'

/** Presentation only; route targets and navigation policy remain with the caller. */
export const SidebarNavLink = forwardRef<HTMLAnchorElement, Omit<NavLinkProps, 'className'> & {
  className?: string
  active?: boolean
  reserveBadgeSpace?: boolean
}>(function SidebarNavLink({ className = '', active = false, reserveBadgeSpace, ...props }, ref) {
  return <NavLink {...props} ref={ref}
    className={({ isActive }) => `${styles.link}${isActive || active ? ` ${styles.active}` : ''} ${className}`}
    data-with-badge={reserveBadgeSpace || undefined} />
})

export function SidebarNavRow({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div {...props} className={`${styles.row} ${className}`} />
}

export function SidebarNavIcon({ className = '', ...props }: HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return <span {...props} className={`${styles.icon} ${className}`} />
}

export function SidebarNavLabel({ className = '', ...props }: HTMLAttributes<HTMLSpanElement>): JSX.Element {
  return <span {...props} className={`${styles.label} ${className}`} />
}
