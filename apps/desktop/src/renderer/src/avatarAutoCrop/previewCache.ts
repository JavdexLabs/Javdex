import type { AvatarFaceCandidate, NormalizedPoint, NormalizedRect } from './types'

const AVATAR_COMPOSITION_PREVIEW_CACHE_KEY =
  'javdex.avatar-composition-preview-analysis.v1'

let volatileAnalysis: CachedAvatarCompositionAnalysis | null = null

export interface CachedAvatarCompositionAnalysis {
  imageWidth: number
  imageHeight: number
  candidate: AvatarFaceCandidate
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNormalizedPoint(value: unknown): value is NormalizedPoint {
  if (!value || typeof value !== 'object') return false
  const point = value as Partial<NormalizedPoint>
  return isFiniteNumber(point.x) && isFiniteNumber(point.y)
}

function isNullableNormalizedPoint(value: unknown): value is NormalizedPoint | null {
  return value === null || isNormalizedPoint(value)
}

function isNormalizedRect(value: unknown): value is NormalizedRect {
  if (!value || typeof value !== 'object') return false
  const rect = value as Partial<NormalizedRect>
  return (
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  )
}

function isAvatarFaceCandidate(value: unknown): value is AvatarFaceCandidate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<AvatarFaceCandidate>
  return (
    typeof candidate.id === 'string' &&
    isFiniteNumber(candidate.confidence) &&
    isFiniteNumber(candidate.prominence) &&
    isNormalizedRect(candidate.box) &&
    isNullableNormalizedPoint(candidate.leftEye) &&
    isNullableNormalizedPoint(candidate.rightEye) &&
    isNullableNormalizedPoint(candidate.ovalTop) &&
    isNullableNormalizedPoint(candidate.chin) &&
    isNullableNormalizedPoint(candidate.leftCheek) &&
    isNullableNormalizedPoint(candidate.rightCheek) &&
    (candidate.headBounds === null || isNormalizedRect(candidate.headBounds)) &&
    (candidate.geometrySource === 'mesh' || candidate.geometrySource === 'detector')
  )
}

function parseCachedAnalysis(value: unknown): CachedAvatarCompositionAnalysis | null {
  if (!value || typeof value !== 'object') return null
  const analysis = value as Partial<CachedAvatarCompositionAnalysis>
  if (
    !isFiniteNumber(analysis.imageWidth) ||
    analysis.imageWidth <= 0 ||
    !isFiniteNumber(analysis.imageHeight) ||
    analysis.imageHeight <= 0 ||
    !isAvatarFaceCandidate(analysis.candidate)
  ) {
    return null
  }
  return analysis as CachedAvatarCompositionAnalysis
}

export function readAvatarCompositionPreviewCache(): CachedAvatarCompositionAnalysis | null {
  if (volatileAnalysis) return volatileAnalysis
  try {
    const serialized = window.localStorage.getItem(AVATAR_COMPOSITION_PREVIEW_CACHE_KEY)
    if (!serialized) return null
    volatileAnalysis = parseCachedAnalysis(JSON.parse(serialized))
    return volatileAnalysis
  } catch {
    return null
  }
}

export function writeAvatarCompositionPreviewCache(
  analysis: CachedAvatarCompositionAnalysis
): void {
  volatileAnalysis = analysis
  try {
    window.localStorage.setItem(
      AVATAR_COMPOSITION_PREVIEW_CACHE_KEY,
      JSON.stringify(analysis)
    )
  } catch {
    // A blocked or full localStorage must not make the settings preview fail.
  }
}
