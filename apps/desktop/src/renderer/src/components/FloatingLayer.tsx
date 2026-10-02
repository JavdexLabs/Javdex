import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useFloatingLayer } from '../hooks/useFloatingLayer'
import { InteractionLayerOwner, useInteractionLayer } from '../interaction/useInteractionLayer'
import type { FloatingAlign, FloatingSide } from '../lib/floatingPosition'
import styles from './FloatingLayer.module.css'

interface FloatingLayerProps {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  side: FloatingSide
  align: FloatingAlign
  offset?: number
  className?: string
  role?: string
  ariaLabel?: string
  id?: string
  style?: CSSProperties
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
  ariaLabel,
  id,
  style,
  onClose,
  ignoreCloseRefs = [],
  children
}: FloatingLayerProps): JSX.Element | null {
  const floatingRef = useRef<HTMLDivElement>(null)
  const layer = useInteractionLayer({ enabled: open, rootRef: floatingRef, anchorRef, onDismiss: onClose })
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
      if (!layer.isTop() || layer.contains(target)) return
      if (ignoreCloseRefs.some((ref) => ref.current?.contains(target))) return
      onClose()
    }
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onDoc), 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [ignoreCloseRefs, layer, onClose, open])

  if (!open) return null

  return createPortal(
    <InteractionLayerOwner.Provider value={layer.owner}>
    <div
      ref={floatingRef}
      id={id}
      className={[styles.root, className].filter(Boolean).join(' ')}
      role={role}
      aria-label={ariaLabel}
      style={{
        ...style,
        // These properties belong to the layer, not the caller's inline style.
        position: undefined,
        zIndex: layer.style.zIndex,
        top: coords?.top ?? -10000,
        left: coords?.left ?? -10000,
        visibility: coords ? 'visible' : 'hidden'
      }}
    >
      {children}
    </div>
    </InteractionLayerOwner.Provider>,
    document.body
  )
}
