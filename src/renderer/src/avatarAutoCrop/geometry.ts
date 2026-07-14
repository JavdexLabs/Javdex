import type { AvatarFaceCandidate, NormalizedPoint, NormalizedRect } from './types'

const MIN_DETECTION_CONFIDENCE = 0.65
const MAX_CANDIDATES = 5

export interface RawFaceCandidate {
  confidence: number
  box: NormalizedRect
  keypoints: NormalizedPoint[]
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function finitePoint(point: NormalizedPoint | undefined): point is NormalizedPoint {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y))
}

export function clampNormalizedPoint(point: NormalizedPoint): NormalizedPoint {
  return { x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1) }
}

export function normalizeDetectionBox(
  originX: number,
  originY: number,
  width: number,
  height: number,
  imageWidth: number,
  imageHeight: number
): NormalizedRect | null {
  if (
    ![originX, originY, width, height, imageWidth, imageHeight].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return null
  }

  const left = clamp(originX / imageWidth, 0, 1)
  const top = clamp(originY / imageHeight, 0, 1)
  const right = clamp((originX + width) / imageWidth, 0, 1)
  const bottom = clamp((originY + height) / imageHeight, 0, 1)
  if (right - left < 0.005 || bottom - top < 0.005) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function boxArea(box: NormalizedRect): number {
  return Math.max(0, box.width) * Math.max(0, box.height)
}

function centerScore(box: NormalizedRect): number {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const distance = Math.hypot(cx - 0.5, cy - 0.5) / Math.SQRT1_2
  return 1 - clamp(distance, 0, 1)
}

function intersectionOverUnion(a: NormalizedRect, b: NormalizedRect): number {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
  if (intersection <= 0) return 0
  return intersection / Math.max(1e-8, boxArea(a) + boxArea(b) - intersection)
}

export function mergeDuplicateCandidates(candidates: RawFaceCandidate[]): RawFaceCandidate[] {
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence)
  const merged: RawFaceCandidate[] = []
  for (const candidate of sorted) {
    if (merged.some((current) => intersectionOverUnion(current.box, candidate.box) >= 0.4)) {
      continue
    }
    merged.push(candidate)
  }
  return merged
}

export function rankFaceCandidates(candidates: RawFaceCandidate[]): AvatarFaceCandidate[] {
  const valid = candidates.filter(
    (candidate) =>
      Number.isFinite(candidate.confidence) &&
      candidate.confidence >= MIN_DETECTION_CONFIDENCE &&
      boxArea(candidate.box) >= 0.00004
  )
  const largestArea = Math.max(1e-8, ...valid.map((candidate) => boxArea(candidate.box)))

  return valid
    .map((candidate) => {
      const relativeArea = Math.sqrt(boxArea(candidate.box) / largestArea)
      const prominence =
        relativeArea * 0.58 + clamp(candidate.confidence, 0, 1) * 0.27 + centerScore(candidate.box) * 0.15
      const points = candidate.keypoints.map((point) =>
        finitePoint(point) ? clampNormalizedPoint(point) : null
      )
      // BlazeFace order: right eye, left eye, nose, mouth, right tragion, left tragion.
      const rightEye = points[0] ?? null
      const leftEye = points[1] ?? null
      return {
        id: '',
        confidence: clamp(candidate.confidence, 0, 1),
        prominence,
        box: candidate.box,
        leftEye,
        rightEye,
        ovalTop: null,
        chin: null,
        leftCheek: null,
        rightCheek: null,
        headBounds: null,
        geometrySource: 'detector' as const
      }
    })
    .sort((a, b) => b.prominence - a.prominence)
    .slice(0, MAX_CANDIDATES)
    .map((candidate, index) => ({ ...candidate, id: `face-${index + 1}` }))
}

export function isAmbiguousFaceSelection(candidates: AvatarFaceCandidate[]): boolean {
  if (candidates.length < 2) return false
  const first = candidates[0]
  const second = candidates[1]
  return second.prominence >= first.prominence * 0.72
}

export function mapRoiPointToImage(
  point: NormalizedPoint,
  roi: NormalizedRect
): NormalizedPoint {
  return {
    x: roi.x + point.x * roi.width,
    y: roi.y + point.y * roi.height
  }
}

export function hasUsableMeshGeometry(candidate: AvatarFaceCandidate): boolean {
  const points = [
    candidate.leftEye,
    candidate.rightEye,
    candidate.ovalTop,
    candidate.chin,
    candidate.leftCheek,
    candidate.rightCheek
  ]
  if (points.some((point) => !point || !finitePoint(point))) return false
  const leftEye = candidate.leftEye!
  const rightEye = candidate.rightEye!
  const top = candidate.ovalTop!
  const chin = candidate.chin!
  const eyeDistance = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y)
  const ovalHeight = Math.hypot(top.x - chin.x, top.y - chin.y)
  return eyeDistance >= 0.01 && ovalHeight >= 0.025
}

function clampIndex(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.floor(value)))
}

function maskQuantile(
  pixels: number[],
  maskWidth: number,
  maskHeight: number,
  axis: 'x' | 'y',
  fraction: number,
  fromEnd = false
): number {
  const size = axis === 'x' ? maskWidth : maskHeight
  const counts = new Uint32Array(size)
  for (const index of pixels) {
    const coordinate = axis === 'x' ? index % maskWidth : Math.floor(index / maskWidth)
    if (coordinate < counts.length) counts[coordinate] += 1
  }
  const threshold = Math.max(1, Math.ceil(pixels.length * fraction))
  let accumulated = 0
  if (fromEnd) {
    for (let index = counts.length - 1; index >= 0; index -= 1) {
      accumulated += counts[index]
      if (accumulated >= threshold) return index
    }
    return counts.length - 1
  }
  for (let index = 0; index < counts.length; index += 1) {
    accumulated += counts[index]
    if (accumulated >= threshold) return index
  }
  return 0
}

/**
 * Select the hair component attached to a detected face and merge it with the
 * face geometry. The result represents the visible head (hair crown to chin),
 * not long hair below the jaw or the rest of the person.
 */
export function headBoundsFromHairMask(input: {
  mask: Uint8Array
  maskWidth: number
  maskHeight: number
  hairCategory: number
  roi: NormalizedRect
  candidate: AvatarFaceCandidate
}): NormalizedRect | null {
  const { mask, maskWidth, maskHeight, hairCategory, roi, candidate } = input
  if (
    maskWidth <= 0 ||
    maskHeight <= 0 ||
    mask.length < maskWidth * maskHeight ||
    roi.width <= 0 ||
    roi.height <= 0
  ) {
    return null
  }

  const toMaskPoint = (point: NormalizedPoint): NormalizedPoint => ({
    x: ((point.x - roi.x) / roi.width) * maskWidth,
    y: ((point.y - roi.y) / roi.height) * maskHeight
  })
  const faceBox = {
    left: ((candidate.box.x - roi.x) / roi.width) * maskWidth,
    top: ((candidate.box.y - roi.y) / roi.height) * maskHeight,
    right: ((candidate.box.x + candidate.box.width - roi.x) / roi.width) * maskWidth,
    bottom: ((candidate.box.y + candidate.box.height - roi.y) / roi.height) * maskHeight
  }
  const ovalTop = candidate.ovalTop ? toMaskPoint(candidate.ovalTop) : null
  const chin = candidate.chin ? toMaskPoint(candidate.chin) : null
  const faceCenterX =
    candidate.leftCheek && candidate.rightCheek
      ? (toMaskPoint(candidate.leftCheek).x + toMaskPoint(candidate.rightCheek).x) / 2
      : (faceBox.left + faceBox.right) / 2
  const faceHeight = Math.max(
    4,
    ovalTop && chin
      ? Math.hypot(chin.x - ovalTop.x, chin.y - ovalTop.y)
      : faceBox.bottom - faceBox.top
  )
  const topReference = ovalTop?.y ?? faceBox.top
  const chinReference = chin?.y ?? faceBox.bottom
  const gate = {
    left: clampIndex(faceCenterX - faceHeight * 0.9, maskWidth - 1),
    top: clampIndex(topReference - faceHeight * 0.7, maskHeight - 1),
    right: clampIndex(faceCenterX + faceHeight * 0.9, maskWidth - 1),
    bottom: clampIndex(chinReference + faceHeight * 0.14, maskHeight - 1)
  }
  if (gate.left >= gate.right || gate.top >= gate.bottom) return null

  const visited = new Uint8Array(maskWidth * maskHeight)
  const stack = new Int32Array((gate.right - gate.left + 1) * (gate.bottom - gate.top + 1))
  const minimumPixels = Math.max(24, Math.round(maskWidth * maskHeight * 0.0004))
  const faceMargin = faceHeight * 0.18
  let bestPixels: number[] | null = null

  for (let y = gate.top; y <= gate.bottom; y += 1) {
    for (let x = gate.left; x <= gate.right; x += 1) {
      const start = y * maskWidth + x
      if (visited[start] || mask[start] !== hairCategory) continue
      visited[start] = 1
      let stackSize = 1
      stack[0] = start
      const pixels: number[] = []
      let minX = x
      let maxX = x
      let minY = y
      let maxY = y
      while (stackSize > 0) {
        const current = stack[--stackSize]
        pixels.push(current)
        const currentX = current % maskWidth
        const currentY = Math.floor(current / maskWidth)
        minX = Math.min(minX, currentX)
        maxX = Math.max(maxX, currentX)
        minY = Math.min(minY, currentY)
        maxY = Math.max(maxY, currentY)
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue
            const nextX = currentX + dx
            const nextY = currentY + dy
            if (
              nextX < gate.left ||
              nextX > gate.right ||
              nextY < gate.top ||
              nextY > gate.bottom
            ) {
              continue
            }
            const next = nextY * maskWidth + nextX
            if (visited[next] || mask[next] !== hairCategory) continue
            visited[next] = 1
            stack[stackSize++] = next
          }
        }
      }
      const nearFace =
        maxX >= faceBox.left - faceMargin &&
        minX <= faceBox.right + faceMargin &&
        maxY >= faceBox.top - faceMargin &&
        minY <= faceBox.bottom + faceMargin
      if (
        nearFace &&
        pixels.length >= minimumPixels &&
        (!bestPixels || pixels.length > bestPixels.length)
      ) {
        bestPixels = pixels
      }
    }
  }

  if (!bestPixels) return null
  const lowerX = maskQuantile(bestPixels, maskWidth, maskHeight, 'x', 0.003)
  const upperX = maskQuantile(bestPixels, maskWidth, maskHeight, 'x', 0.003, true)
  const upperY = maskQuantile(bestPixels, maskWidth, maskHeight, 'y', 0.003)
  const lowerY = maskQuantile(bestPixels, maskWidth, maskHeight, 'y', 0.003, true)
  const hairBounds = {
    left: roi.x + (lowerX / maskWidth) * roi.width,
    top: roi.y + (upperY / maskHeight) * roi.height,
    right: roi.x + ((upperX + 1) / maskWidth) * roi.width,
    bottom: roi.y + ((lowerY + 1) / maskHeight) * roi.height
  }
  const faceLeft = Math.min(
    candidate.box.x,
    candidate.leftCheek?.x ?? candidate.box.x,
    candidate.rightCheek?.x ?? candidate.box.x
  )
  const faceRight = Math.max(
    candidate.box.x + candidate.box.width,
    candidate.leftCheek?.x ?? candidate.box.x + candidate.box.width,
    candidate.rightCheek?.x ?? candidate.box.x + candidate.box.width
  )
  const faceBottom = Math.max(
    candidate.box.y + candidate.box.height,
    candidate.chin?.y ?? candidate.box.y + candidate.box.height
  )
  const left = clamp(Math.min(hairBounds.left, faceLeft), 0, 1)
  const top = clamp(hairBounds.top, 0, 1)
  const right = clamp(Math.max(hairBounds.right, faceRight), 0, 1)
  const bottom = clamp(Math.max(hairBounds.bottom, faceBottom), 0, 1)
  if (right - left < 0.01 || bottom - top < 0.02) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}
