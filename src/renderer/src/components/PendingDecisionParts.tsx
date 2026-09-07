import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import Button from './Button'
import FloatingLayer from './FloatingLayer'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { UI_ICON_SM } from './iconDefaults'
import { WorkbenchStatusPill } from './workbench'
import styles from './PendingDecisionParts.module.css'

/**
 * Every pending domain answers the same shape of question, so the workspace
 * frame is shared: ask, let the user choose, preview the impact, then confirm.
 */
export function PendingWorkspace({
  eyebrow,
  title,
  description,
  status,
  statusTone = 'waiting',
  headerActions,
  alert,
  tabs,
  confirm,
  overlays,
  children
}: {
  eyebrow: ReactNode
  title: ReactNode
  description?: ReactNode
  status?: ReactNode
  statusTone?: 'waiting' | 'ok'
  headerActions?: ReactNode
  alert?: ReactNode
  tabs?: ReactNode
  confirm?: ReactNode
  overlays?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className={styles.workspace}>
      <header className={styles.question}>
        <div>
          <span>{eyebrow}</span>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {headerActions ? <div className={styles.actions}>{headerActions}</div> : null}
        {status ? <WorkbenchStatusPill tone={statusTone}>{status}</WorkbenchStatusPill> : null}
      </header>
      {alert}
      {tabs ? <div className={styles.tabs}>{tabs}</div> : null}
      <div className={styles.panels}>{children}</div>
      {confirm}
      {overlays}
    </section>
  )
}

export function PendingAlert({
  inline,
  children
}: {
  inline?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div className={inline ? `${styles.alert} ${styles.alertInline}` : styles.alert} role="status">
      {children}
    </div>
  )
}

export function PendingWorkspacePanel({
  id,
  labelledBy,
  hidden,
  children
}: {
  id?: string
  labelledBy?: string
  hidden?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div
      id={id}
      role={id ? 'tabpanel' : undefined}
      aria-labelledby={labelledBy}
      hidden={hidden}
      className={styles.panel}
    >
      {children}
    </div>
  )
}

export function PendingStep({
  step,
  title,
  hint,
  children
}: {
  step: number
  title: ReactNode
  hint?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section className={styles.step}>
      <div className={styles.stepTitle}>
        <div>
          <span>第 {step} 步</span>
          <h3>{title}</h3>
        </div>
        {hint ? <small>{hint}</small> : null}
      </div>
      {children}
    </section>
  )
}

export function PendingMeta({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.meta}>{children}</div>
}

export function PendingConfirmBar({
  summary,
  scope,
  secondary,
  children
}: {
  summary: ReactNode
  scope: ReactNode
  secondary?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <footer className={styles.confirm}>
      <div className={styles.confirmSummary}>
        <strong className={styles.confirmHeadline}>{summary}</strong>
        <span className={styles.confirmScope}>{scope}</span>
      </div>
      <div className={styles.confirmActions}>
        {secondary}
        {children}
      </div>
    </footer>
  )
}

export function PendingSecondaryActions({
  label = '更多处理',
  children
}: {
  label?: string
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = (): void => {
    setOpen(false)
    anchorRef.current?.focus()
  }
  useEscapeKey(close, open)
  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      contentRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open])
  return (
    <>
      <Button
        ref={anchorRef}
        variant="ghost"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {label}
        <ChevronDown {...UI_ICON_SM} aria-hidden />
      </Button>
      <FloatingLayer
        open={open}
        anchorRef={anchorRef}
        side="top"
        align="end"
        onClose={() => setOpen(false)}
        id={id}
        className={styles.secondary}
        role="group"
        ariaLabel={label}
      >
        <div
          ref={contentRef}
          onClick={(event) => {
            const button = (event.target as HTMLElement).closest('button')
            if (button && !button.disabled) close()
          }}
          onBlur={(event) => {
            if (
              event.relatedTarget &&
              !event.currentTarget.contains(event.relatedTarget as Node) &&
              event.relatedTarget !== anchorRef.current
            ) setOpen(false)
          }}
        >
          {children}
        </div>
      </FloatingLayer>
    </>
  )
}

export function PendingChoice({
  name, value, label, detail, checked, disabled, onChange
}: {
  name: string
  value: string
  label: string
  detail: string
  checked: boolean
  disabled?: boolean
  onChange: () => void
}): JSX.Element {
  return (
    <label className={styles.choice} data-selected={checked}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span>
        <span>{label}</span>
        <strong className="copyable-text">{detail}</strong>
      </span>
    </label>
  )
}

/** Flat impact card for domains with a single, always-visible preview. */
export function PendingImpactPanel({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.impactPanel}>{children}</div>
}

/** Collapsible impact group; one card per source so long previews stay scannable. */
export function PendingImpactCards({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.impactCardGroup}>{children}</div>
}

export function PendingImpactCard({
  title,
  note,
  open,
  children
}: {
  title: ReactNode
  note: ReactNode
  open?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <details className={styles.impactCard} open={open}>
      <summary>
        <span>{title}</span>
        <em>{note}</em>
      </summary>
      {children}
    </details>
  )
}

export function PendingImpactList({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.impactList}>{children}</div>
}

export function PendingImpactRow({
  label,
  current,
  next,
  action,
  clearing
}: {
  label: ReactNode
  current: ReactNode
  next: ReactNode
  action: ReactNode
  clearing?: boolean
}): JSX.Element {
  return (
    <div className={styles.impactRow} data-clearing={clearing ? 'true' : undefined}>
      <span>{label}</span>
      <span className="copyable-text">{current}</span>
      <span aria-hidden>→</span>
      <span className="copyable-text">{next}</span>
      <strong>{action}</strong>
    </div>
  )
}

/** Impact whose payload is a target rather than a value diff (scan, scrape). */
export function PendingImpactPair({
  label,
  value
}: {
  label: ReactNode
  value: ReactNode
}): JSX.Element {
  return (
    <div className={`${styles.impactRow} ${styles.impactPair}`}>
      <span>{label}</span>
      <span className="copyable-text">{value}</span>
    </div>
  )
}

export function PendingUnchangedImpacts({
  summary,
  open,
  children
}: {
  summary: ReactNode
  open?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <details className={styles.unchanged} open={open}>
      <summary>{summary}</summary>
      {children}
    </details>
  )
}

export function PendingUnchangedRow({
  label,
  value,
  reason
}: {
  label: ReactNode
  value: ReactNode
  reason: ReactNode
}): JSX.Element {
  return (
    <div className={styles.unchangedRow}>
      <span>{label}</span>
      <span className="copyable-text">{value}</span>
      <em className={styles.unchangedReason}>{reason}</em>
    </div>
  )
}

export function PendingImpactNote({ children }: { children: ReactNode }): JSX.Element {
  return <p className={styles.impactNote}>{children}</p>
}
