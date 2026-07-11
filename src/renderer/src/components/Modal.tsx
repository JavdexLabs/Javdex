import { useCallback, useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useEscapeKey } from '../hooks/useEscapeKey'
import IconButton from './IconButton'
import { UI_ICON_MD } from './iconDefaults'

export type ModalSize = 'compact' | 'sm' | 'md' | 'lg' | 'xl'

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

function sizeClassName(size: ModalSize): string {
  return size === 'compact' ? 'modal--form-compact' : `modal--form-${size}`
}

function isShelllessModal(className: string): boolean {
  return className.includes('modal--plugin-dev-code')
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
  const shellless = isShelllessModal(className)
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
    'modal',
    shellless ? '' : 'modal--form',
    shellless ? '' : sizeClassName(size),
    className
  ]
    .filter(Boolean)
    .join(' ')

  const showDefaultActions = !hideActions && !actions && onConfirm
  const showCloseButton = Boolean(hideActions)

  return (
    <div
      className="modal-backdrop"
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
        <header className={`modal-head${showCloseButton ? ' modal-head--with-close' : ''}`}>
          <div className="modal-head-main">
            <h3 id={titleId}>
              {title}
              {subtitle ? <span className="modal-subtitle">{subtitle}</span> : null}
            </h3>
            {hint ? (
              <p id={descriptionId} className="modal-lead hint">
                {hint}
              </p>
            ) : null}
          </div>
          {showCloseButton ? (
            <IconButton
              className="modal-close-btn"
              label="关闭"
              icon={<X {...UI_ICON_MD} />}
              disabled={closeBlocked}
              onClick={requestClose}
            />
          ) : null}
        </header>
        <div className={`modal-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>
        {!hideActions && (
          <div className="modal-actions">
            {actions ?? (
              showDefaultActions ? (
                <>
                  {!hideCancel && (
                    <button type="button" className="btn" disabled={closeBlocked} onClick={onCancel}>
                      {cancelText}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
                    disabled={confirmDisabled || busy}
                    onClick={onConfirm}
                  >
                    {confirmText}
                  </button>
                </>
              ) : null
            )}
          </div>
        )}
      </div>
    </div>
  )
}
