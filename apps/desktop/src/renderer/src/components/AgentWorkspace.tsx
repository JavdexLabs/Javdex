import type { ComponentProps, ReactNode } from 'react'
import Modal from './Modal'
import styles from './AgentWorkspace.module.css'

type AgentWorkspaceModalProps = Omit<
  ComponentProps<typeof Modal>,
  'bodyClassName' | 'bodyOverflow' | 'children' | 'className' | 'size'
> & {
  children: ReactNode
}

export function AgentWorkspaceModal({
  children,
  ...props
}: AgentWorkspaceModalProps): JSX.Element {
  return (
    <Modal
      {...props}
      size="xl"
      className={styles.modal}
      bodyClassName={styles.body}
      bodyOverflow="hidden"
    >
      <div className={styles.workspace}>{children}</div>
    </Modal>
  )
}

export function AgentWorkspacePane({
  label,
  children
}: {
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className={styles.pane} aria-label={label}>
      {children}
    </section>
  )
}

export function AgentWorkspacePaneHeader({
  icon,
  title,
  hint,
  hintTitle,
  status,
  ready = false
}: {
  icon: ReactNode
  title: string
  hint: ReactNode
  hintTitle?: string
  status: ReactNode
  ready?: boolean
}): JSX.Element {
  return (
    <header className={styles.paneHeader}>
      <span className={styles.paneIcon}>{icon}</span>
      <span className={styles.paneHeaderCopy}>
        <strong className={styles.paneTitle}>{title}</strong>
        <small className={styles.paneHint} title={hintTitle}>{hint}</small>
      </span>
      <span className={styles.paneStatus} data-ready={ready || undefined}>{status}</span>
    </header>
  )
}

export function AgentWorkspacePaneBody({
  variant,
  children
}: {
  variant: 'setup' | 'result'
  children: ReactNode
}): JSX.Element {
  return <div className={variant === 'setup' ? styles.setupBody : styles.resultBody}>{children}</div>
}
