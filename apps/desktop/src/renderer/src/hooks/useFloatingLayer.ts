import { useCallback, useLayoutEffect, useState, type RefObject } from 'react'
import {
  computeFloatingPosition,
  type FloatingAlign,
  type FloatingCoords,
  type FloatingSide
} from '../lib/floatingPosition'

interface UseFloatingLayerOptions {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  floatingRef: RefObject<HTMLElement | null>
  side: FloatingSide
  align: FloatingAlign
  offset?: number
  enabled?: boolean
}

export function useFloatingLayer({
  open,
  anchorRef,
  floatingRef,
  side,
  align,
  offset = 8,
  enabled = true
}: UseFloatingLayerOptions): FloatingCoords | null {
  const [coords, setCoords] = useState<FloatingCoords | null>(null)

  const update = useCallback((): void => {
    const anchor = anchorRef.current
    const floating = floatingRef.current
    if (!anchor || !floating) return
    const anchorRect = anchor.getBoundingClientRect()
    const floatingRect = floating.getBoundingClientRect()
    if (floatingRect.width === 0 && floatingRect.height === 0) return
    setCoords(
      computeFloatingPosition({
        anchorRect,
        floatingWidth: floatingRect.width,
        floatingHeight: floatingRect.height,
        side,
        align,
        offset
      })
    )
  }, [align, anchorRef, floatingRef, offset, side])

  useLayoutEffect(() => {
    if (!open || !enabled) {
      setCoords(null)
      return
    }
    update()
    const floating = floatingRef.current
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && floating
        ? new ResizeObserver(() => update())
        : null
    if (floating) resizeObserver?.observe(floating)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [enabled, floatingRef, open, update])

  return coords
}
