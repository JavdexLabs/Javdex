import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import Button from './Button'
import styles from './FilterPanelContent.module.css'

export function FilterPanelAnchor({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.anchor}>{children}</div>
}

export const FilterPanelShell = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function FilterPanelShell({ className, children, ...props }, ref) {
    return <div ref={ref} className={`${styles.shell}${className ? ` ${className}` : ''}`} {...props}>
      {children}
    </div>
  }
)

export function FilterFields({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.fields}>{children}</div>
}

export function FilterFieldLabel({ children }: { children: ReactNode }): JSX.Element {
  return <span className={styles.label}>{children}</span>
}

export function FilterField({ label, wide = false, children }: {
  label: string
  wide?: boolean
  children: ReactNode
}): JSX.Element {
  return <label className={styles.field} data-wide={wide || undefined}>
    <FilterFieldLabel>{label}</FilterFieldLabel>
    {children}
  </label>
}

/** Shared filter-panel chrome; callers retain field state and dismissal policy. */
export default function FilterPanelContent({ children, paddedEnd = false, onReset, onClose }: {
  children: ReactNode
  paddedEnd?: boolean
  onReset: () => void
  onClose: () => void
}): JSX.Element {
  return <>
    <header className={styles.header}><h3 className={styles.title}>筛选</h3></header>
    <div className={styles.body} data-padded-end={paddedEnd || undefined}>{children}</div>
    <footer className={styles.footer}>
      <Button type="button" variant="ghost" size="sm" onClick={onReset}>重置</Button>
      <Button type="button" variant="primary" size="sm" onClick={onClose}>完成</Button>
    </footer>
  </>
}
