import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useEscapeKey } from '../hooks/useEscapeKey'
import IconButton from './IconButton'
import { UI_ICON_MD } from './iconDefaults'
import Button from './Button'
import styles from './Modal.module.css'

export type ModalSize = 'compact' | 'sm' | 'md' | 'lg' | 'xl'
export type ModalChrome = 'form' | 'shellless'
export type ModalBodyOverflow = 'auto' | 'hidden'

interface Props {
  title: string
  subtitle?: ReactNode
  hint?: ReactNode
  children: ReactNode
  confirmText?: string
  cancelText?: string
  className?: string
  bodyClassName?: string
  size?: ModalSize
  chrome?: ModalChrome
  bodyOverflow?: ModalBodyOverflow
  danger?: boolean
  confirmDisabled?: boolean
  busy?: boolean
  dismissible?: boolean
  closeDisabled?: boolean
  hideCancel?: boolean
  hideActions?: boolean
  onConfirm?: () => void | Promise<unknown>
  onCancel: () => void
  actions?: ReactNode
}

const modalStack: string[] = []
let previousBodyOverflow = ''

function registerModal(id: string): void {
  if (modalStack.length === 0) {
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  modalStack.push(id)
}

function unregisterModal(id: string): void {
  const index = modalStack.lastIndexOf(id)
  if (index >= 0) modalStack.splice(index, 1)
  if (modalStack.length === 0) document.body.style.overflow = previousBodyOverflow
}

function isTopModal(id: string): boolean {
  return modalStack.at(-1) === id
}

const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  '[href]',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'summary',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

export default function Modal({
  title,
  subtitle,
  hint,
  children,
  confirmText = '确认',
  cancelText = '取消',
  className = '',
  bodyClassName = '',
  size = 'compact',
  chrome = 'form',
  bodyOverflow = 'auto',
  danger,
  confirmDisabled,
  busy = false,
  dismissible = true,
  closeDisabled = false,
  hideCancel,
  hideActions,
  onConfirm,
  onCancel,
  actions
}: Props): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  // Capture before child autoFocus runs during commit, not after mounting.
  const returnFocusRef = useRef(document.activeElement as HTMLElement | null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const submissionLock = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const reactId = useId()
  const modalId = `modal-${reactId.replace(/:/g, '')}`
  const titleId = `${modalId}-title`
  const descriptionId = `${modalId}-description`
  const shellless = chrome === 'shellless'
  const effectiveBusy = busy || submitting
  const closeBlocked = effectiveBusy || closeDisabled
  const submit = async (): Promise<void> => {
    if (!onConfirm || confirmDisabled || effectiveBusy || submissionLock.current) return
    submissionLock.current = true
    try {
      const result = onConfirm()
      if (result && typeof result.then === 'function') {
        setSubmitting(true)
        await result
      }
      if (mounted.current) setSubmitError(null)
    } catch (error) {
      if (mounted.current) setSubmitError(error instanceof Error ? error.message : String(error))
    } finally {
      submissionLock.current = false
      if (mounted.current) setSubmitting(false)
    }
  }

  const requestClose = useCallback(() => {
    if (closeBlocked || submissionLock.current || !isTopModal(modalId)) return
    onCancel()
  }, [closeBlocked, modalId, onCancel])

  const requestDismiss = useCallback(() => {
    if (!dismissible) return
    requestClose()
  }, [dismissible, requestClose])

  useEscapeKey(requestDismiss, dismissible && !closeBlocked)

  useEffect(() => {
    const prev = returnFocusRef.current
    registerModal(modalId)
    dialogRef.current?.focus()
    return () => {
      unregisterModal(modalId)
      prev?.focus()
    }
  }, [modalId])

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab' || !isTopModal(modalId)) return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (element) =>
        !element.hidden &&
        !element.closest('[hidden]') &&
        element.getAttribute('aria-hidden') !== 'true'
    )
    if (focusable.length === 0) {
      event.preventDefault()
      dialog.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  const modalClass = [
    styles.root,
    shellless ? '' : styles.form,
    shellless ? '' : styles[size],
    className
  ]
    .filter(Boolean)
    .join(' ')

  const showDefaultActions = !hideActions && !actions && onConfirm
  const showCloseButton = Boolean(hideActions)

  return (
    <div
      className={styles.backdrop}
      data-modal-id={modalId}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestDismiss()
      }}
    >
      <div
        ref={dialogRef}
        className={modalClass}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hint ? descriptionId : undefined}
        aria-busy={effectiveBusy || undefined}
        tabIndex={-1}
        onKeyDown={trapFocus}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          data-modal-part="head"
          className={[
            styles.head,
            shellless ? '' : styles.formHead,
            showCloseButton ? styles.headWithClose : ''
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <div className={styles.headMain}>
            <h3 id={titleId}>
              {title}
              {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
            </h3>
            {hint ? (
              <p id={descriptionId} className={styles.lead}>
                {hint}
              </p>
            ) : null}
          </div>
          {showCloseButton ? (
            <IconButton
              className={styles.closeButton}
              label="关闭"
              icon={<X {...UI_ICON_MD} />}
              disabled={closeBlocked}
              onClick={requestClose}
            />
          ) : null}
        </header>
        <div
          data-modal-part="body"
          className={[
            styles.body,
            shellless ? '' : styles.formBody,
            // A retained error adds content beyond fixed-height editors; keep it scrollable.
            bodyOverflow === 'hidden' && !submitError ? styles.bodyHidden : '',
            bodyClassName
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {children}
          {submitError && <div className={styles.error} role="alert">
            <details>
              <summary className={styles.errorSummary}>{effectiveBusy ? '正在重试，上次操作未完成' : '操作未完成，可重试或查看错误详情'}</summary>
              <p className={styles.errorDetails}>{submitError}</p>
            </details>
          </div>}
        </div>
        {!hideActions && (
          <div
            data-modal-part="actions"
            className={`${styles.actions}${shellless ? '' : ` ${styles.formActions}`}`}
          >
            {actions ?? (
              showDefaultActions ? (
                <>
                  {!hideCancel && (
                    <Button type="button" disabled={closeBlocked} onClick={requestClose}>
                      {cancelText}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant={danger ? 'danger' : 'primary'}
                    disabled={confirmDisabled || effectiveBusy}
                    busy={effectiveBusy}
                    onClick={() => void submit()}
                  >
                    {confirmText}
                  </Button>
                </>
              ) : null
            )}
          </div>
        )}
      </div>
    </div>
  )
}
