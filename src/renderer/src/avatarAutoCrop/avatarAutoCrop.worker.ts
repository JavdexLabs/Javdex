import {
  FaceDetector,
  FaceLandmarker,
  FilesetResolver,
  ImageSegmenter,
  type Detection,
  type FaceDetectorResult,
  type NormalizedLandmark
} from '@mediapipe/tasks-vision'
import {
  clampNormalizedPoint,
  hasUsableMeshGeometry,
  headBoundsFromHairMask,
  isAmbiguousFaceSelection,
  mapRoiPointToImage,
  mergeDuplicateCandidates,
  normalizeDetectionBox,
  rankFaceCandidates,
  type RawFaceCandidate
} from './geometry'
import type {
  AvatarAutoCropAnalyzeRequest,
  AvatarAutoCropResult,
  AvatarAutoCropWorkerConfig,
  AvatarAutoCropWorkerRequest,
  AvatarAutoCropWorkerResponse,
  AvatarFaceCandidate,
  NormalizedPoint,
  NormalizedRect
} from './types'

const MODEL_VERSION = 'mediapipe-blazeface-full-range-1+face-landmarker-1+hair-segmenter-1'
const ROI_OUTPUT_SIZE = 384
const MAX_REFINED_CANDIDATES = 5

interface WorkerScope {
  onmessage: ((event: MessageEvent<AvatarAutoCropWorkerRequest>) => void) | null
  postMessage(message: AvatarAutoCropWorkerResponse): void
  close(): void
}

const workerScope = globalThis as unknown as WorkerScope
let detector: FaceDetector | null = null
let landmarker: FaceLandmarker | null = null
let hairSegmenter: ImageSegmenter | null = null
let initializedFor: string | null = null
let loaderImportSequence = 0

function configKey(config: AvatarAutoCropWorkerConfig): string {
  return `${config.runtimeBaseUrl}|${config.detectorModelUrl}|${config.landmarkerModelUrl}|${config.hairSegmenterModelUrl}`
}

async function ensureTasks(
  config: AvatarAutoCropWorkerConfig,
  needsHairSegmentation: boolean
): Promise<void> {
  const key = configKey(config)
  if (!detector || !landmarker || initializedFor !== key) {
    detector?.close()
    landmarker?.close()
    hairSegmenter?.close()
    detector = null
    landmarker = null
    hairSegmenter = null

    // MediaPipe clears its global ModuleFactory after creating a task. A module
    // import is cached, so tasks in one Worker need distinct loader URLs.
    // They still share the same WASM binary and add no packaged runtime copies.
    const detectorFileset = await FilesetResolver.forVisionTasks(config.runtimeBaseUrl, true)
    detectorFileset.wasmLoaderPath += `?task=detector-${++loaderImportSequence}`
    detector = await FaceDetector.createFromOptions(detectorFileset, {
      baseOptions: { modelAssetPath: config.detectorModelUrl, delegate: 'CPU' },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.65,
      minSuppressionThreshold: 0.3
    })
    const landmarkerFileset = await FilesetResolver.forVisionTasks(config.runtimeBaseUrl, true)
    landmarkerFileset.wasmLoaderPath += `?task=landmarker-${++loaderImportSequence}`
    landmarker = await FaceLandmarker.createFromOptions(landmarkerFileset, {
      baseOptions: { modelAssetPath: config.landmarkerModelUrl, delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 1,
      minFaceDetectionConfidence: 0.55,
      minFacePresenceConfidence: 0.55,
      minTrackingConfidence: 0.55,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false
    })
    initializedFor = key
  }
  if (needsHairSegmentation && !hairSegmenter) {
    const segmenterFileset = await FilesetResolver.forVisionTasks(config.runtimeBaseUrl, true)
    segmenterFileset.wasmLoaderPath += `?task=hair-segmenter-${++loaderImportSequence}`
    hairSegmenter = await ImageSegmenter.createFromOptions(segmenterFileset, {
      baseOptions: { modelAssetPath: config.hairSegmenterModelUrl, delegate: 'CPU' },
      runningMode: 'IMAGE',
      outputCategoryMask: true,
      outputConfidenceMasks: false
    })
  }
}

function detectionToRaw(
  detection: Detection,
  imageWidth: number,
  imageHeight: number
): RawFaceCandidate | null {
  const box = detection.boundingBox
  if (!box) return null
  const normalized = normalizeDetectionBox(
    box.originX,
    box.originY,
    box.width,
    box.height,
    imageWidth,
    imageHeight
  )
  if (!normalized) return null
  return {
    confidence: detection.categories[0]?.score ?? 0,
    box: normalized,
    keypoints: detection.keypoints.map((point) => ({ x: point.x, y: point.y }))
  }
}

function resultToRaw(
  result: FaceDetectorResult,
  imageWidth: number,
  imageHeight: number
): RawFaceCandidate[] {
  return result.detections
    .map((detection) => detectionToRaw(detection, imageWidth, imageHeight))
    .filter((candidate): candidate is RawFaceCandidate => Boolean(candidate))
}

function mapTileCandidate(
  candidate: RawFaceCandidate,
  tile: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number
): RawFaceCandidate {
  const mapPoint = (point: NormalizedPoint): NormalizedPoint => ({
    x: (tile.x + point.x * tile.width) / imageWidth,
    y: (tile.y + point.y * tile.height) / imageHeight
  })
  return {
    confidence: candidate.confidence,
    box: {
      x: (tile.x + candidate.box.x * tile.width) / imageWidth,
      y: (tile.y + candidate.box.y * tile.height) / imageHeight,
      width: (candidate.box.width * tile.width) / imageWidth,
      height: (candidate.box.height * tile.height) / imageHeight
    },
    keypoints: candidate.keypoints.map(mapPoint)
  }
}

function detectTiledFaces(bitmap: ImageBitmap): RawFaceCandidate[] {
  if (!detector) return []
  const width = bitmap.width
  const height = bitmap.height
  const tileWidth = Math.max(1, Math.round(width * 0.62))
  const tileHeight = Math.max(1, Math.round(height * 0.62))
  const positions = [
    { x: 0, y: 0 },
    { x: width - tileWidth, y: 0 },
    { x: 0, y: height - tileHeight },
    { x: width - tileWidth, y: height - tileHeight }
  ]
  const found: RawFaceCandidate[] = []

  for (const position of positions) {
    const canvas = new OffscreenCanvas(tileWidth, tileHeight)
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    ctx.drawImage(bitmap, -position.x, -position.y)
    const result = detector.detect(canvas)
    const tile = { ...position, width: tileWidth, height: tileHeight }
    found.push(
      ...resultToRaw(result, tileWidth, tileHeight).map((candidate) =>
        mapTileCandidate(candidate, tile, width, height)
      )
    )
  }
  return mergeDuplicateCandidates(found)
}

function expandedRoi(box: NormalizedRect, imageWidth: number, imageHeight: number): NormalizedRect {
  const boxWidth = box.width * imageWidth
  const boxHeight = box.height * imageHeight
  const side = Math.max(64, Math.max(boxWidth, boxHeight) * 1.75)
  const centerX = (box.x + box.width / 2) * imageWidth
  const centerY = (box.y + box.height / 2) * imageHeight
  return {
    x: (centerX - side / 2) / imageWidth,
    y: (centerY - side / 2) / imageHeight,
    width: side / imageWidth,
    height: side / imageHeight
  }
}

function expandedHeadRoi(
  box: NormalizedRect,
  imageWidth: number,
  imageHeight: number
): NormalizedRect {
  const boxWidth = box.width * imageWidth
  const boxHeight = box.height * imageHeight
  const side = Math.max(96, Math.max(boxWidth, boxHeight) * 2.6)
  const centerX = (box.x + box.width / 2) * imageWidth
  const centerY = (box.y + box.height / 2) * imageHeight
  return {
    x: (centerX - side / 2) / imageWidth,
    y: (centerY - side / 2) / imageHeight,
    width: side / imageWidth,
    height: side / imageHeight
  }
}

function drawRoi(bitmap: ImageBitmap, roi: NormalizedRect): OffscreenCanvas | null {
  const imageWidth = bitmap.width
  const imageHeight = bitmap.height
  const roiX = roi.x * imageWidth
  const roiY = roi.y * imageHeight
  const roiWidth = roi.width * imageWidth
  const roiHeight = roi.height * imageHeight
  const sourceLeft = Math.max(0, roiX)
  const sourceTop = Math.max(0, roiY)
  const sourceRight = Math.min(imageWidth, roiX + roiWidth)
  const sourceBottom = Math.min(imageHeight, roiY + roiHeight)
  const sourceWidth = sourceRight - sourceLeft
  const sourceHeight = sourceBottom - sourceTop
  if (sourceWidth <= 1 || sourceHeight <= 1) return null

  const canvas = new OffscreenCanvas(ROI_OUTPUT_SIZE, ROI_OUTPUT_SIZE)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = 'rgb(127, 127, 127)'
  ctx.fillRect(0, 0, ROI_OUTPUT_SIZE, ROI_OUTPUT_SIZE)
  const scaleX = ROI_OUTPUT_SIZE / roiWidth
  const scaleY = ROI_OUTPUT_SIZE / roiHeight
  ctx.drawImage(
    bitmap,
    sourceLeft,
    sourceTop,
    sourceWidth,
    sourceHeight,
    (sourceLeft - roiX) * scaleX,
    (sourceTop - roiY) * scaleY,
    sourceWidth * scaleX,
    sourceHeight * scaleY
  )
  return canvas
}

function averageLandmarks(
  landmarks: NormalizedLandmark[],
  indexes: number[]
): NormalizedPoint | null {
  const points = indexes
    .map((index) => landmarks[index])
    .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))
  if (points.length !== indexes.length) return null
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  }
}

function pointNearCandidate(point: NormalizedPoint, box: NormalizedRect): boolean {
  const marginX = box.width * 0.45
  const marginY = box.height * 0.45
  return (
    point.x >= box.x - marginX &&
    point.x <= box.x + box.width + marginX &&
    point.y >= box.y - marginY &&
    point.y <= box.y + box.height + marginY
  )
}

function refineCandidate(bitmap: ImageBitmap, candidate: AvatarFaceCandidate): AvatarFaceCandidate {
  if (!landmarker) return candidate
  const roi = expandedRoi(candidate.box, bitmap.width, bitmap.height)
  const canvas = drawRoi(bitmap, roi)
  if (!canvas) return candidate
  const result = landmarker.detect(canvas)
  const landmarks = result.faceLandmarks[0]
  if (!landmarks || landmarks.length < 455) return candidate

  // MediaPipe Face Mesh canonical indexes.
  const leftEyeInRoi = averageLandmarks(landmarks, landmarks.length >= 478 ? [468] : [33, 133])
  const rightEyeInRoi = averageLandmarks(landmarks, landmarks.length >= 478 ? [473] : [362, 263])
  const ovalTopInRoi = averageLandmarks(landmarks, [10])
  const chinInRoi = averageLandmarks(landmarks, [152])
  const leftCheekInRoi = averageLandmarks(landmarks, [234])
  const rightCheekInRoi = averageLandmarks(landmarks, [454])
  if (
    !leftEyeInRoi ||
    !rightEyeInRoi ||
    !ovalTopInRoi ||
    !chinInRoi ||
    !leftCheekInRoi ||
    !rightCheekInRoi
  ) {
    return candidate
  }

  const refined: AvatarFaceCandidate = {
    ...candidate,
    leftEye: clampNormalizedPoint(mapRoiPointToImage(leftEyeInRoi, roi)),
    rightEye: clampNormalizedPoint(mapRoiPointToImage(rightEyeInRoi, roi)),
    ovalTop: clampNormalizedPoint(mapRoiPointToImage(ovalTopInRoi, roi)),
    chin: clampNormalizedPoint(mapRoiPointToImage(chinInRoi, roi)),
    leftCheek: clampNormalizedPoint(mapRoiPointToImage(leftCheekInRoi, roi)),
    rightCheek: clampNormalizedPoint(mapRoiPointToImage(rightCheekInRoi, roi)),
    geometrySource: 'mesh'
  }
  const eyeCenter = {
    x: (refined.leftEye!.x + refined.rightEye!.x) / 2,
    y: (refined.leftEye!.y + refined.rightEye!.y) / 2
  }
  if (!pointNearCandidate(eyeCenter, candidate.box) || !hasUsableMeshGeometry(refined)) {
    return candidate
  }
  return refined
}

function segmentCandidateHead(
  bitmap: ImageBitmap,
  candidate: AvatarFaceCandidate
): AvatarFaceCandidate {
  if (!hairSegmenter) return candidate
  const roi = expandedHeadRoi(candidate.box, bitmap.width, bitmap.height)
  const canvas = drawRoi(bitmap, roi)
  if (!canvas) return candidate
  const result = hairSegmenter.segment(canvas)
  try {
    const categoryMask = result.categoryMask
    if (!categoryMask) return candidate
    const labels = hairSegmenter.getLabels()
    const labeledHairIndex = labels.findIndex((label) => label.trim().toLowerCase() === 'hair')
    const headBounds = headBoundsFromHairMask({
      mask: categoryMask.getAsUint8Array(),
      maskWidth: categoryMask.width,
      maskHeight: categoryMask.height,
      hairCategory: labeledHairIndex >= 0 ? labeledHairIndex : 1,
      roi,
      candidate
    })
    return headBounds ? { ...candidate, headBounds } : candidate
  } finally {
    result.close()
  }
}

async function analyze(request: AvatarAutoCropAnalyzeRequest): Promise<AvatarAutoCropResult> {
  const startedAt = performance.now()
  const needsHeadBounds = request.centeringMode === 'head' || request.preserveFullHead
  await ensureTasks(request.config, needsHeadBounds)
  if (!detector || !landmarker) throw new Error('本地人脸检测组件初始化失败')

  let raw = resultToRaw(detector.detect(request.bitmap), request.bitmap.width, request.bitmap.height)
  let usedTiledFallback = false
  if (raw.length === 0) {
    raw = detectTiledFaces(request.bitmap)
    usedTiledFallback = true
  }
  const ranked = rankFaceCandidates(mergeDuplicateCandidates(raw))
  if (ranked.length === 0) {
    throw new Error('未检测到清晰人脸，请选择更清晰的原图或手动裁剪')
  }
  let candidates = ranked
    .slice(0, MAX_REFINED_CANDIDATES)
    .map((candidate) => refineCandidate(request.bitmap, candidate))
  if (needsHeadBounds) {
    candidates = candidates.map((candidate) => segmentCandidateHead(request.bitmap, candidate))
  }
  return {
    candidates,
    ambiguous: isAmbiguousFaceSelection(candidates),
    usedTiledFallback,
    elapsedMs: Math.round(performance.now() - startedAt),
    modelVersion: MODEL_VERSION
  }
}

function dispose(): void {
  detector?.close()
  landmarker?.close()
  hairSegmenter?.close()
  detector = null
  landmarker = null
  hairSegmenter = null
  initializedFor = null
}

workerScope.onmessage = (event): void => {
  const request = event.data
  if (request.type === 'dispose') {
    dispose()
    workerScope.close()
    return
  }
  void analyze(request)
    .then((result) => {
      workerScope.postMessage({ type: 'result', requestId: request.requestId, result })
    })
    .catch((error) => {
      workerScope.postMessage({
        type: 'error',
        requestId: request.requestId,
        error: String((error as Error)?.message || '智能构图失败')
      })
    })
    .finally(() => request.bitmap.close())
}
