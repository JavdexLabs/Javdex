import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
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
  onConfirm?: () => void
  onCancel: () => void
  actions?: ReactNode
}

function legacySizeClassName(size: ModalSize): string {
  return size === 'compact' ? 'modal--form-compact' : `modal--form-${size}`
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
  const reactId = useId()
  const modalId = `modal-${reactId.replace(/:/g, '')}`
  const titleId = `${modalId}-title`
  const descriptionId = `${modalId}-description`
  const shellless = chrome === 'shellless'
  const closeBlocked = busy || closeDisabled

  const requestClose = useCallback(() => {
    if (closeBlocked || !isTopModal(modalId)) return
    onCancel()
  }, [closeBlocked, modalId, onCancel])

  const requestDismiss = useCallback(() => {
    if (!dismissible) return
    requestClose()
  }, [dismissible, requestClose])

  useEscapeKey(requestDismiss, dismissible && !closeBlocked)

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
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
    'modal',
    shellless ? '' : styles.form,
    shellless ? '' : styles[size],
    shellless ? '' : 'modal--form',
    shellless ? '' : legacySizeClassName(size),
    className
  ]
    .filter(Boolean)
    .join(' ')

  const showDefaultActions = !hideActions && !actions && onConfirm
  const showCloseButton = Boolean(hideActions)

  return (
    <div
      className={`${styles.backdrop} modal-backdrop`}
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
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={trapFocus}
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className={[
            styles.head,
            shellless ? '' : styles.formHead,
            showCloseButton ? styles.headWithClose : '',
            'modal-head',
            showCloseButton ? 'modal-head--with-close' : ''
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <div className={`${styles.headMain} modal-head-main`}>
            <h3 id={titleId}>
              {title}
              {subtitle ? <span className={`${styles.subtitle} modal-subtitle`}>{subtitle}</span> : null}
            </h3>
            {hint ? (
              <p id={descriptionId} className={`${styles.lead} modal-lead hint`}>
                {hint}
              </p>
            ) : null}
          </div>
          {showCloseButton ? (
            <IconButton
              className={`${styles.closeButton} modal-close-btn`}
              label="关闭"
              icon={<X {...UI_ICON_MD} />}
              disabled={closeBlocked}
              onClick={requestClose}
            />
          ) : null}
        </header>
        <div
          className={[
            styles.body,
            shellless ? '' : styles.formBody,
            bodyOverflow === 'hidden' ? styles.bodyHidden : '',
            'modal-body',
            bodyClassName
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {children}
        </div>
        {!hideActions && (
          <div
            className={`${styles.actions}${shellless ? '' : ` ${styles.formActions}`} modal-actions`}
          >
            {actions ?? (
              showDefaultActions ? (
                <>
                  {!hideCancel && (
                    <Button type="button" disabled={closeBlocked} onClick={onCancel}>
                      {cancelText}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant={danger ? 'danger' : 'primary'}
                    disabled={confirmDisabled || busy}
                    onClick={onConfirm}
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
