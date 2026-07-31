import {
  cacheActressFaceStatus,
  getCachedActressFaceStatus,
  type ActressFaceScanCache,
  type ActressFaceScanStatus
} from './cache'

export interface ActressFaceScanTarget {
  actressId: number
  mainName: string
  avatarUrl: string
  fingerprint: string
}

export interface ActressFaceScanProgress {
  total: number
  current: number
  hasFace: number
  withoutFace: number
  failed: number
  currentName: string | null
  reused: number
  status: 'running' | 'cancelling' | 'done'
}

export interface ActressFaceScanFailure {
  actressId: number
  mainName: string
  message: string
}

export interface ActressFaceScanSummary {
  cancelled: boolean
  total: number
  current: number
  hasFace: number
  withoutFace: number
  failed: number
  reused: number
  withoutFaceIds: number[]
  failures: ActressFaceScanFailure[]
}

export type ActressFaceDetector = (
  target: ActressFaceScanTarget
) => Promise<ActressFaceScanStatus>

export async function scanActressFaceTargets(
  targets: ActressFaceScanTarget[],
  cache: ActressFaceScanCache,
  detect: ActressFaceDetector,
  isCancellationRequested: () => boolean,
  onProgress: (progress: ActressFaceScanProgress) => void
): Promise<ActressFaceScanSummary> {
  const summary: ActressFaceScanSummary = {
    cancelled: false,
    total: targets.length,
    current: 0,
    hasFace: 0,
    withoutFace: 0,
    failed: 0,
    reused: 0,
    withoutFaceIds: [],
    failures: []
  }

  const report = (currentName: string | null, status: ActressFaceScanProgress['status']): void => {
    onProgress({
      total: summary.total,
      current: summary.current,
      hasFace: summary.hasFace,
      withoutFace: summary.withoutFace,
      failed: summary.failed,
      currentName,
      reused: summary.reused,
      status
    })
  }

  report(null, 'running')

  for (const target of targets) {
    if (isCancellationRequested()) {
      summary.cancelled = true
      break
    }

    const cached = getCachedActressFaceStatus(cache, target.actressId, target.fingerprint)
    const currentStatus = cached
    report(target.mainName, isCancellationRequested() ? 'cancelling' : 'running')

    try {
      const status = currentStatus ?? (await detect(target))
      if (currentStatus) summary.reused += 1
      else cacheActressFaceStatus(cache, target.actressId, target.fingerprint, status)
      if (status === 'without-face') {
        summary.withoutFace += 1
        summary.withoutFaceIds.push(target.actressId)
      } else {
        summary.hasFace += 1
      }
    } catch (error) {
      summary.failed += 1
      summary.failures.push({
        actressId: target.actressId,
        mainName: target.mainName,
        message: error instanceof Error ? error.message : String(error)
      })
    }

    summary.current += 1
    if (isCancellationRequested()) {
      report(null, 'cancelling')
      summary.cancelled = true
      break
    }
    report(null, 'running')
  }

  if (isCancellationRequested()) summary.cancelled = true
  report(null, summary.cancelled ? 'cancelling' : 'done')
  return summary
}
