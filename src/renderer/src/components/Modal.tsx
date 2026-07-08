import { useEffect, useRef, type ReactNode } from 'react'
import { useEscapeKey } from '../hooks/useEscapeKey'

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
  hideCancel,
  hideActions,
  onConfirm,
  onCancel,
  actions
}: Props): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const shellless = isShelllessModal(className)

  useEscapeKey(onCancel)

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => {
      prev?.focus()
    }
  }, [])

  const modalClass = [
    'modal',
    shellless ? '' : 'modal--form',
    shellless ? '' : sizeClassName(size),
    className
  ]
    .filter(Boolean)
    .join(' ')

  const showDefaultActions = !hideActions && !actions && onConfirm

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        ref={dialogRef}
        className={modalClass}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h3 id="modal-title">
            {title}
            {subtitle ? <span className="modal-subtitle">{subtitle}</span> : null}
          </h3>
          {hint ? <p className="modal-lead hint">{hint}</p> : null}
        </header>
        <div className={`modal-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>{children}</div>
        {!hideActions && (
          <div className="modal-actions">
            {actions ?? (
              showDefaultActions ? (
                <>
                  {!hideCancel && (
                    <button type="button" className="btn" onClick={onCancel}>
                      {cancelText}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
                    disabled={confirmDisabled}
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
