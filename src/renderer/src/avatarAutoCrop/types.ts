import type { AvatarCenteringMode } from '@shared/avatarCentering'

export interface NormalizedPoint {
  x: number
  y: number
}

export interface NormalizedRect {
  x: number
  y: number
  width: number
  height: number
}

export type FaceGeometrySource = 'mesh' | 'detector'

export interface AvatarFaceCandidate {
  id: string
  confidence: number
  prominence: number
  box: NormalizedRect
  leftEye: NormalizedPoint | null
  rightEye: NormalizedPoint | null
  ovalTop: NormalizedPoint | null
  chin: NormalizedPoint | null
  leftCheek: NormalizedPoint | null
  rightCheek: NormalizedPoint | null
  headBounds: NormalizedRect | null
  geometrySource: FaceGeometrySource
}

export interface AvatarAutoCropResult {
  candidates: AvatarFaceCandidate[]
  ambiguous: boolean
  usedTiledFallback: boolean
  elapsedMs: number
  modelVersion: string
}

export interface AvatarAutoCropWorkerConfig {
  runtimeBaseUrl: string
  detectorModelUrl: string
  landmarkerModelUrl: string
  hairSegmenterModelUrl: string
}

export interface AvatarAutoCropAnalyzeRequest {
  type: 'analyze'
  requestId: number
  bitmap: ImageBitmap
  config: AvatarAutoCropWorkerConfig
  centeringMode: AvatarCenteringMode
  preserveFullHead: boolean
}

export interface AvatarAutoCropDisposeRequest {
  type: 'dispose'
}

export type AvatarAutoCropWorkerRequest =
  | AvatarAutoCropAnalyzeRequest
  | AvatarAutoCropDisposeRequest

export interface AvatarAutoCropSuccessResponse {
  type: 'result'
  requestId: number
  result: AvatarAutoCropResult
}

export interface AvatarAutoCropErrorResponse {
  type: 'error'
  requestId: number
  error: string
}

export type AvatarAutoCropWorkerResponse =
  | AvatarAutoCropSuccessResponse
  | AvatarAutoCropErrorResponse
