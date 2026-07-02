import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useFloatingLayer } from '../hooks/useFloatingLayer'
import type { FloatingAlign, FloatingSide } from '../lib/floatingPosition'

interface FloatingLayerProps {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  side: FloatingSide
  align: FloatingAlign
  offset?: number
  className?: string
  role?: string
  id?: string
  onClose?: () => void
  ignoreCloseRefs?: Array<RefObject<HTMLElement | null>>
  children: ReactNode
}

export default function FloatingLayer({
  open,
  anchorRef,
  side,
  align,
  offset,
  className,
  role,
  id,
  onClose,
  ignoreCloseRefs = [],
  children
}: FloatingLayerProps): JSX.Element | null {
  const floatingRef = useRef<HTMLDivElement>(null)
  const coords = useFloatingLayer({
    open,
    anchorRef,
    floatingRef,
    side,
    align,
    offset
  })

  useEffect(() => {
    if (!open || !onClose) return
    const onDoc = (event: MouseEvent): void => {
      const target = event.target as Node
      if (floatingRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      if (ignoreCloseRefs.some((ref) => ref.current?.contains(target))) return
      onClose()
    }
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDoc), 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [anchorRef, ignoreCloseRefs, onClose, open])

  if (!open) return null

  return createPortal(
    <div
      ref={floatingRef}
      id={id}
      className={className}
      role={role}
      style={{
        position: 'fixed',
        top: coords?.top ?? -10000,
        left: coords?.left ?? -10000,
        visibility: coords ? 'visible' : 'hidden',
        zIndex: 1200
      }}
    >
      {children}
    </div>,
    document.body
  )
}
