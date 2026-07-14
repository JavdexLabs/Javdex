import type {
  AvatarAutoCropResult,
  AvatarAutoCropWorkerConfig,
  AvatarAutoCropWorkerResponse
} from './types'
import type { AvatarCenteringMode } from '@shared/avatarCentering'

const REQUEST_TIMEOUT_MS = 30_000
const WORKER_IDLE_TIMEOUT_MS = 60_000

interface PendingRequest {
  resolve: (result: AvatarAutoCropResult) => void
  reject: (error: Error) => void
  timeoutId: ReturnType<typeof setTimeout>
}

let worker: Worker | null = null
let requestSequence = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null
const pending = new Map<number, PendingRequest>()

function publicAssetUrl(path: string): string {
  const current = new URL(window.location.href)
  current.hash = ''
  current.search = ''
  if (current.protocol === 'file:') {
    return new URL(path, current.href.replace(/[^/]*$/, '')).toString()
  }
  return new URL(`/${path.replace(/^\//, '')}`, current.origin).toString()
}

function workerConfig(): AvatarAutoCropWorkerConfig {
  return {
    runtimeBaseUrl: publicAssetUrl('mediapipe'),
    detectorModelUrl: publicAssetUrl('models/blaze_face_full_range.tflite'),
    landmarkerModelUrl: publicAssetUrl('models/face_landmarker.task'),
    hairSegmenterModelUrl: publicAssetUrl('models/hair_segmenter.tflite')
  }
}

function rejectAll(error: Error): void {
  for (const request of pending.values()) {
    clearTimeout(request.timeoutId)
    request.reject(error)
  }
  pending.clear()
}

function stopWorker(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (!worker) return
  worker.postMessage({ type: 'dispose' })
  worker.terminate()
  worker = null
}

function scheduleIdleStop(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (pending.size === 0) stopWorker()
  }, WORKER_IDLE_TIMEOUT_MS)
}

function ensureWorker(): Worker {
  if (worker) return worker
  const next = new Worker(new URL('./avatarAutoCrop.worker.ts', import.meta.url), {
    type: 'module',
    name: 'avatar-auto-crop'
  })
  next.onmessage = (event: MessageEvent<AvatarAutoCropWorkerResponse>): void => {
    const response = event.data
    const request = pending.get(response.requestId)
    if (!request) return
    pending.delete(response.requestId)
    clearTimeout(request.timeoutId)
    if (response.type === 'result') request.resolve(response.result)
    else request.reject(new Error(response.error))
    scheduleIdleStop()
  }
  next.onerror = (event): void => {
    rejectAll(new Error(event.message || '本地人脸检测工作线程异常'))
    next.terminate()
    if (worker === next) worker = null
  }
  worker = next
  return next
}

export function analyzeAvatarBitmap(
  bitmap: ImageBitmap,
  centeringMode: AvatarCenteringMode,
  preserveFullHead: boolean
): Promise<AvatarAutoCropResult> {
  const requestId = ++requestSequence
  const activeWorker = ensureWorker()
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('本地人脸检测超时，请重试或手动裁剪'))
      if (pending.size === 0) stopWorker()
    }, REQUEST_TIMEOUT_MS)
    pending.set(requestId, { resolve, reject, timeoutId })
    try {
      activeWorker.postMessage(
        {
          type: 'analyze',
          requestId,
          bitmap,
          config: workerConfig(),
          centeringMode,
          preserveFullHead
        },
        [bitmap]
      )
    } catch (error) {
      pending.delete(requestId)
      clearTimeout(timeoutId)
      bitmap.close()
      reject(error instanceof Error ? error : new Error('无法启动本地人脸检测'))
      scheduleIdleStop()
    }
  })
}

export function cancelPendingAvatarAutoCrop(): void {
  if (pending.size === 0) return
  rejectAll(new Error('本地人脸检测已取消'))
  stopWorker()
}

export function disposeAvatarAutoCropWorker(): void {
  rejectAll(new Error('本地人脸检测已取消'))
  stopWorker()
}
