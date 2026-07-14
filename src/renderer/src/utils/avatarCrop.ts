import { AVATAR_OUTPUT_SIZE, AVATAR_VIEW_SIZE } from '@shared/avatarCropConstants'
import {
  DEFAULT_AVATAR_FACE_RATIO,
  getAvatarFaceScaleFactor
} from '@shared/avatarFaceScale'
import {
  DEFAULT_AVATAR_CENTERING_MODE,
  type AvatarCenteringMode
} from '@shared/avatarCentering'
import type { AvatarFaceCandidate, NormalizedPoint } from '../avatarAutoCrop/types'

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

export type SmartCropConstraint = 'source-too-tight' | 'source-edge' | 'zoom-limit'

export interface SmartAvatarCropTransform {
  baseScale: number
  zoom: number
  offsetX: number
  offsetY: number
  constrained: boolean
  constraint: SmartCropConstraint | null
  geometrySource: AvatarFaceCandidate['geometrySource']
}

const TARGET_EYE_CENTER_Y = 0.45
const TARGET_HEAD_CENTER_Y = 0.5
const ESTIMATED_CROWN_EXTENSION_RATIO = 0.35
const TARGET_EYE_DISTANCE_RATIO = 0.25
const TARGET_OVAL_HEIGHT_RATIO = 0.7
const TARGET_CHEEK_WIDTH_RATIO = 0.52
const TARGET_DETECTOR_BOX_HEIGHT_RATIO = 0.74
const MAX_HEAD_BOUNDS_RATIO = 0.94

function pointToPixels(point: NormalizedPoint, iw: number, ih: number): { x: number; y: number } {
  return { x: point.x * iw, y: point.y * ih }
}

function pointDistance(
  a: NormalizedPoint,
  b: NormalizedPoint,
  iw: number,
  ih: number
): number {
  return Math.hypot((a.x - b.x) * iw, (a.y - b.y) * ih)
}

function clampNear(value: number, reference: number, tolerance: number): number {
  return Math.min(reference * (1 + tolerance), Math.max(reference * (1 - tolerance), value))
}

function desiredCropSide(
  candidate: AvatarFaceCandidate,
  iw: number,
  ih: number,
  faceRatio: number,
  preserveFullHead: boolean
): number {
  const faceScale = getAvatarFaceScaleFactor(faceRatio)
  let faceSide: number
  if (
    candidate.geometrySource === 'mesh' &&
    candidate.leftEye &&
    candidate.rightEye &&
    candidate.ovalTop &&
    candidate.chin &&
    candidate.leftCheek &&
    candidate.rightCheek
  ) {
    const ovalSide =
      pointDistance(candidate.ovalTop, candidate.chin, iw, ih) /
      (TARGET_OVAL_HEIGHT_RATIO * faceScale)
    const eyeSide =
      pointDistance(candidate.leftEye, candidate.rightEye, iw, ih) /
      (TARGET_EYE_DISTANCE_RATIO * faceScale)
    const cheekSide =
      pointDistance(candidate.leftCheek, candidate.rightCheek, iw, ih) /
      (TARGET_CHEEK_WIDTH_RATIO * faceScale)
    // The face oval has the most stable semantics. Other measures correct mild
    // pose/landmark drift but cannot move the final size far away on their own.
    faceSide =
      ovalSide * 0.6 +
      clampNear(eyeSide, ovalSide, 0.18) * 0.22 +
      clampNear(cheekSide, ovalSide, 0.18) * 0.18
  } else {
    faceSide = (candidate.box.height * ih) / (TARGET_DETECTOR_BOX_HEIGHT_RATIO * faceScale)
  }
  if (preserveFullHead && candidate.headBounds) {
    const headSide =
      Math.max(candidate.headBounds.width * iw, candidate.headBounds.height * ih) /
      MAX_HEAD_BOUNDS_RATIO
    return Math.max(faceSide, headSide)
  }
  return faceSide
}

function compositionAnchor(
  candidate: AvatarFaceCandidate,
  iw: number,
  ih: number,
  centeringMode: AvatarCenteringMode
): { x: number; y: number; targetY: number } {
  if (centeringMode === 'head') {
    if (candidate.headBounds) {
      return {
        x: (candidate.headBounds.x + candidate.headBounds.width / 2) * iw,
        y: (candidate.headBounds.y + candidate.headBounds.height / 2) * ih,
        targetY: TARGET_HEAD_CENTER_Y
      }
    }
    if (candidate.ovalTop && candidate.chin) {
      const ovalTop = pointToPixels(candidate.ovalTop, iw, ih)
      const chin = pointToPixels(candidate.chin, iw, ih)
      // Face Mesh does not include the hair crown. Extend the stable face-oval
      // axis upward by a conservative amount, then center crown-to-chin.
      const crown = {
        x: ovalTop.x - (chin.x - ovalTop.x) * ESTIMATED_CROWN_EXTENSION_RATIO,
        y: ovalTop.y - (chin.y - ovalTop.y) * ESTIMATED_CROWN_EXTENSION_RATIO
      }
      return {
        x: (crown.x + chin.x) / 2,
        y: (crown.y + chin.y) / 2,
        targetY: TARGET_HEAD_CENTER_Y
      }
    }
    return {
      x: (candidate.box.x + candidate.box.width / 2) * iw,
      y:
        (candidate.box.y +
          candidate.box.height * (0.5 - ESTIMATED_CROWN_EXTENSION_RATIO / 2)) *
        ih,
      targetY: TARGET_HEAD_CENTER_Y
    }
  }
  if (candidate.leftEye && candidate.rightEye) {
    const left = pointToPixels(candidate.leftEye, iw, ih)
    const right = pointToPixels(candidate.rightEye, iw, ih)
    return {
      x: (left.x + right.x) / 2,
      y: (left.y + right.y) / 2,
      targetY: TARGET_EYE_CENTER_Y
    }
  }
  return {
    x: (candidate.box.x + candidate.box.width / 2) * iw,
    y: (candidate.box.y + candidate.box.height * 0.42) * ih,
    targetY: TARGET_EYE_CENTER_Y
  }
}

/** Deterministic face composition using validated local detector/landmark geometry. */
export function getSmartAvatarCropTransform(
  iw: number,
  ih: number,
  candidate: AvatarFaceCandidate,
  viewSize = AVATAR_VIEW_SIZE,
  faceRatio: number = DEFAULT_AVATAR_FACE_RATIO,
  centeringMode: AvatarCenteringMode = DEFAULT_AVATAR_CENTERING_MODE,
  preserveFullHead = false
): SmartAvatarCropTransform {
  const baseScale = getBaseScale(iw, ih, viewSize)
  const requestedSide = Math.max(
    1,
    desiredCropSide(candidate, iw, ih, faceRatio, preserveFullHead)
  )
  const requestedZoom = viewSize / requestedSide / baseScale
  const zoom = Math.min(4, Math.max(1, requestedZoom))
  const scale = baseScale * zoom
  const anchor = compositionAnchor(candidate, iw, ih, centeringMode)
  const requestedOffset = {
    x: (iw / 2 - anchor.x) * scale,
    y: (anchor.targetY - 0.5) * viewSize + (ih / 2 - anchor.y) * scale
  }
  const offset = clampCropOffset(
    requestedOffset.x,
    requestedOffset.y,
    iw,
    ih,
    baseScale,
    zoom,
    viewSize
  )
  let constraint: SmartCropConstraint | null = null
  if (requestedZoom < 1 - 1e-6) constraint = 'source-too-tight'
  else if (requestedZoom > 4 + 1e-6) constraint = 'zoom-limit'
  else if (
    Math.abs(offset.x - requestedOffset.x) > 0.5 ||
    Math.abs(offset.y - requestedOffset.y) > 0.5
  ) {
    constraint = 'source-edge'
  }
  return {
    baseScale,
    zoom,
    offsetX: offset.x,
    offsetY: offset.y,
    constrained: constraint !== null,
    constraint,
    geometrySource: candidate.geometrySource
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
