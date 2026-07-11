import { AVATAR_OUTPUT_SIZE, AVATAR_VIEW_SIZE } from '@shared/avatarCropConstants'

export { AVATAR_OUTPUT_SIZE, AVATAR_VIEW_SIZE }

/** Scale image to cover a square viewport (matches object-fit: cover in the crop UI). */
export function getBaseScale(iw: number, ih: number, viewSize: number): number {
  return Math.max(viewSize / iw, viewSize / ih)
}

/** Restore a previously exported square avatar without shifting from preview cover layout. */
export function getSavedAvatarCropTransform(
  iw: number,
  ih: number,
  viewSize = AVATAR_VIEW_SIZE
): { baseScale: number; zoom: number; offsetX: number; offsetY: number } {
  return getDefaultCropTransform(iw, ih, viewSize)
}

/** Default pan/zoom so the image covers the square viewport (matches preview object-fit: cover). */
export function getDefaultCropTransform(
  iw: number,
  ih: number,
  viewSize = AVATAR_VIEW_SIZE
): { baseScale: number; zoom: number; offsetX: number; offsetY: number } {
  return {
    baseScale: getBaseScale(iw, ih, viewSize),
    zoom: 1,
    offsetX: 0,
    offsetY: 0
  }
}

export function isDefaultCropTransform(
  zoom: number,
  offsetX: number,
  offsetY: number
): boolean {
  const epsilon = 0.000001
  return (
    Math.abs(zoom - 1) < epsilon &&
    Math.abs(offsetX) < epsilon &&
    Math.abs(offsetY) < epsilon
  )
}

/** Keep pan within bounds so the scaled image always covers the square viewport. */
export function clampCropOffset(
  offsetX: number,
  offsetY: number,
  iw: number,
  ih: number,
  baseScale: number,
  zoom: number,
  viewSize = AVATAR_VIEW_SIZE
): { x: number; y: number } {
  const scale = baseScale * zoom
  const scaledW = iw * scale
  const scaledH = ih * scale
  const maxX = Math.max(0, (scaledW - viewSize) / 2)
  const maxY = Math.max(0, (scaledH - viewSize) / 2)
  return {
    x: Math.min(maxX, Math.max(-maxX, offsetX)),
    y: Math.min(maxY, Math.max(-maxY, offsetY))
  }
}

/** Pixel layout for the crop image; matches exportAvatarCrop math. */
export function getCropImageLayout(
  iw: number,
  ih: number,
  baseScale: number,
  zoom: number,
  offsetX: number,
  offsetY: number,
  viewSize = AVATAR_VIEW_SIZE
): { left: number; top: number; width: number; height: number } {
  const scale = baseScale * zoom
  const width = iw * scale
  const height = ih * scale
  return {
    left: (viewSize - width) / 2 + offsetX,
    top: (viewSize - height) / 2 + offsetY,
    width,
    height
  }
}

/** Render a square JPEG crop; UI preview uses a circular mask over the same square bounds. */
export function exportAvatarCrop(
  img: HTMLImageElement,
  offsetX: number,
  offsetY: number,
  zoom: number,
  baseScale?: number,
  viewSize = AVATAR_VIEW_SIZE,
  outSize = AVATAR_OUTPUT_SIZE
): string {
  const canvas = document.createElement('canvas')
  canvas.width = outSize
  canvas.height = outSize
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''

  const iw = img.naturalWidth
  const ih = img.naturalHeight
  const scale = (baseScale ?? getBaseScale(iw, ih, viewSize)) * zoom
  const ratio = outSize / viewSize
  const clamped = clampCropOffset(offsetX, offsetY, iw, ih, baseScale ?? getBaseScale(iw, ih, viewSize), zoom, viewSize)

  ctx.save()
  ctx.scale(ratio, ratio)
  ctx.translate(viewSize / 2 + clamped.x, viewSize / 2 + clamped.y)
  ctx.scale(scale, scale)
  ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih)
  ctx.restore()

  return canvas.toDataURL('image/jpeg', 0.92).split(',')[1] ?? ''
}
