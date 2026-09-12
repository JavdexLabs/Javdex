import type { ReactNode } from 'react'
import Modal, { type ModalSize } from './Modal'

interface ConfirmModalProps {
  title: string
  children: ReactNode
  confirmText?: string
  cancelText?: string
  size?: ModalSize
  className?: string
  bodyClassName?: string
  danger?: boolean
  confirmDisabled?: boolean
  busy?: boolean
  dismissible?: boolean
  closeDisabled?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmModal({
  title,
  children,
  confirmText = '确认',
  cancelText = '取消',
  size,
  className,
  bodyClassName,
  danger = false,
  confirmDisabled,
  busy,
  dismissible,
  closeDisabled,
  onConfirm,
  onCancel
}: ConfirmModalProps): JSX.Element {
  return (
    <Modal
      title={title}
      size={size}
      className={className}
      bodyClassName={bodyClassName}
      danger={danger}
      confirmText={confirmText}
      cancelText={cancelText}
      confirmDisabled={confirmDisabled}
      busy={busy}
      dismissible={dismissible}
      closeDisabled={closeDisabled}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {children}
    </Modal>
  )
}
