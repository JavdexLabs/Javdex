export const IMAGE_PREVIEW_SWIPE_THRESHOLD = 48

export type ImagePreviewSwipeDirection = 'prev' | 'next'

export function isImagePreviewDrag(
  deltaX: number,
  deltaY: number,
  threshold: number
): boolean {
  return Math.max(Math.abs(deltaX), Math.abs(deltaY)) > threshold
}

/** Resolve a horizontal preview swipe without treating clicks or vertical drags as navigation. */
export function getImagePreviewSwipeDirection(
  deltaX: number,
  deltaY: number,
  threshold = IMAGE_PREVIEW_SWIPE_THRESHOLD
): ImagePreviewSwipeDirection | null {
  const horizontalDistance = Math.abs(deltaX)
  const verticalDistance = Math.abs(deltaY)
  if (horizontalDistance <= threshold || horizontalDistance <= verticalDistance) return null
  return deltaX > 0 ? 'prev' : 'next'
}
