import type { VideoLifecycleImpact } from '@shared/videoLifecycleTypes'

export interface BulkPreviewImpact {
  videoId: number
  revision: string
  sourcePathCount: number
  resourceCount: number
  /** Only single-item dialogs retain the full impact tree. */
  detail?: VideoLifecycleImpact
}

export function compactPreview(impact: VideoLifecycleImpact, detail: boolean): BulkPreviewImpact {
  return {
    videoId: impact.videoId,
    revision: impact.revision,
    sourcePathCount: impact.sourcePaths.length,
    resourceCount: impact.resourceIds.length,
    ...(detail ? { detail: impact } : {})
  }
}

/** One queue per surface, including both removal kinds. In-flight IPC cannot be aborted;
 * drain it before the next job so obsolete jobs cannot multiply concurrency. */
export function createBulkPreviewQueue(concurrency = 4): {
  run<T extends { id: number }, R>(
    targets: readonly T[], load: (target: T) => Promise<R>, signal: AbortSignal
  ): Promise<Map<number, R> | undefined>
} {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency')
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run(targets, load, signal) {
      const execute = async (): Promise<Map<number, Awaited<ReturnType<typeof load>>> | undefined> => {
        if (signal.aborted) return undefined
        const result = new Map<number, Awaited<ReturnType<typeof load>>>()
        let next = 0
        let failed = false
        let failure: unknown
        await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
          while (!signal.aborted && !failed && next < targets.length) {
            const target = targets[next++]!
            try {
              const value = await load(target)
              if (!signal.aborted && !failed) result.set(target.id, value)
            } catch (error) {
              failed = true
              failure = error
            }
          }
        }))
        if (signal.aborted) return undefined
        if (failed) throw failure
        return result
      }
      const job = tail.then(execute, execute)
      tail = job.catch(() => {})
      return job
    }
  }
}
