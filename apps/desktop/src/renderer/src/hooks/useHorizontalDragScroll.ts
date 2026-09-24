import { useCallback, useRef, useState, type PointerEvent, type RefObject } from 'react'

const DRAG_THRESHOLD = 5

interface DragState {
  pointerId: number
  startX: number
  originScrollLeft: number
}

export interface HorizontalDragScroll {
  ref: RefObject<HTMLDivElement>
  isDragging: boolean
  onPointerDownCapture: (e: PointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: PointerEvent<HTMLDivElement>) => void
  onPointerUp: (e: PointerEvent<HTMLDivElement>) => void
  onPointerCancel: (e: PointerEvent<HTMLDivElement>) => void
  shouldSuppressClick: () => boolean
}

/** Pointer-drag horizontal scroll; suppresses child clicks after a drag gesture. */
export function useHorizontalDragScroll(): HorizontalDragScroll {
  const ref = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const draggedRef = useRef(false)
  const [isDragging, setIsDragging] = useState(false)

  const onPointerDownCapture = useCallback((e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = ref.current
    if (!el) return
    draggedRef.current = false
    setIsDragging(false)
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      originScrollLeft: el.scrollLeft
    }
  }, [])

  const onPointerMove = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    const el = ref.current
    if (!el) return
    const delta = e.clientX - drag.startX
    if (Math.abs(delta) <= DRAG_THRESHOLD) return
    if (!draggedRef.current) {
      draggedRef.current = true
      setIsDragging(true)
      el.setPointerCapture(e.pointerId)
    }
    el.scrollLeft = drag.originScrollLeft - delta
  }, [])

  const endDrag = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    setIsDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  const shouldSuppressClick = useCallback((): boolean => {
    if (!draggedRef.current) return false
    draggedRef.current = false
    return true
  }, [])

  return {
    ref,
    isDragging,
    onPointerDownCapture,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    shouldSuppressClick
  }
}
