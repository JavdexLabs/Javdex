import type { ReactNode } from 'react'
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
  secondary,
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
  secondary?: ReactNode
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
      {secondary}
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
  children
}: {
  summary: ReactNode
  scope: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <footer className={styles.confirm}>
      <div className={styles.confirmSummary}>
        <strong className={styles.confirmHeadline}>{summary}</strong>
        <span className={styles.confirmScope}>作用范围：{scope}</span>
      </div>
      <div>{children}</div>
    </footer>
  )
}

export function PendingSecondaryActions({
  label = '其他处理',
  children
}: {
  label?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className={styles.secondary} aria-label="其他处理方式">
      <span className={styles.secondaryLabel}>{label}</span>
      {children}
    </div>
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
