export type FloatingSide = 'top' | 'bottom' | 'left' | 'right'
export type FloatingAlign = 'start' | 'center' | 'end'

export interface FloatingCoords {
  top: number
  left: number
  side: FloatingSide
}

export interface ComputeFloatingPositionInput {
  anchorRect: DOMRectReadOnly
  floatingWidth: number
  floatingHeight: number
  side: FloatingSide
  align: FloatingAlign
  offset?: number
  padding?: number
}

function alignOnAxis(
  anchorStart: number,
  anchorSize: number,
  floatingSize: number,
  align: FloatingAlign
): number {
  switch (align) {
    case 'start':
      return anchorStart
    case 'end':
      return anchorStart + anchorSize - floatingSize
    default:
      return anchorStart + (anchorSize - floatingSize) / 2
  }
}

function coordsForSide(
  side: FloatingSide,
  anchorRect: DOMRectReadOnly,
  floatingWidth: number,
  floatingHeight: number,
  align: FloatingAlign,
  offset: number
): Pick<FloatingCoords, 'top' | 'left'> {
  switch (side) {
    case 'top':
      return {
        top: anchorRect.top - floatingHeight - offset,
        left: alignOnAxis(anchorRect.left, anchorRect.width, floatingWidth, align)
      }
    case 'bottom':
      return {
        top: anchorRect.bottom + offset,
        left: alignOnAxis(anchorRect.left, anchorRect.width, floatingWidth, align)
      }
    case 'left':
      return {
        top: alignOnAxis(anchorRect.top, anchorRect.height, floatingHeight, align),
        left: anchorRect.left - floatingWidth - offset
      }
    case 'right':
      return {
        top: alignOnAxis(anchorRect.top, anchorRect.height, floatingHeight, align),
        left: anchorRect.right + offset
      }
  }
}

function fitsViewport(
  top: number,
  left: number,
  width: number,
  height: number,
  padding: number,
  viewportWidth: number,
  viewportHeight: number
): boolean {
  return (
    top >= padding &&
    left >= padding &&
    top + height <= viewportHeight - padding &&
    left + width <= viewportWidth - padding
  )
}

function shiftIntoViewport(
  top: number,
  left: number,
  width: number,
  height: number,
  padding: number,
  viewportWidth: number,
  viewportHeight: number
): Pick<FloatingCoords, 'top' | 'left'> {
  const maxLeft = Math.max(padding, viewportWidth - width - padding)
  const maxTop = Math.max(padding, viewportHeight - height - padding)
  return {
    top: Math.min(Math.max(top, padding), maxTop),
    left: Math.min(Math.max(left, padding), maxLeft)
  }
}

function flipSide(side: FloatingSide): FloatingSide {
  switch (side) {
    case 'top':
      return 'bottom'
    case 'bottom':
      return 'top'
    case 'left':
      return 'right'
    case 'right':
      return 'left'
  }
}

/** Compute viewport-fixed coordinates for a floating layer anchored to a rect. */
export function computeFloatingPosition(input: ComputeFloatingPositionInput): FloatingCoords {
  const {
    anchorRect,
    floatingWidth,
    floatingHeight,
    side,
    align,
    offset = 8,
    padding = 8
  } = input
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const candidates: FloatingSide[] = [side, flipSide(side)]

  for (const candidate of candidates) {
    const coords = coordsForSide(
      candidate,
      anchorRect,
      floatingWidth,
      floatingHeight,
      align,
      offset
    )
    if (
      fitsViewport(
        coords.top,
        coords.left,
        floatingWidth,
        floatingHeight,
        padding,
        viewportWidth,
        viewportHeight
      )
    ) {
      return { ...coords, side: candidate }
    }
  }

  const fallback = coordsForSide(side, anchorRect, floatingWidth, floatingHeight, align, offset)
  return {
    ...shiftIntoViewport(
      fallback.top,
      fallback.left,
      floatingWidth,
      floatingHeight,
      padding,
      viewportWidth,
      viewportHeight
    ),
    side
  }
}
