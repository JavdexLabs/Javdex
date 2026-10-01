import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { VideoLifecycleImpact } from '@shared/videoLifecycleTypes'
import { api } from '../api'

type State =
  | { phase: 'closed' }
  | { phase: 'loading' }
  | { phase: 'ready' | 'committing'; impact: VideoLifecycleImpact; operationId: string }

interface Options {
  scopeKey: string
  videoId: number
  libraryId: number | null
  onCommitted(): void
  onSuccess(message: string): void
  onError(message: string): void
}

/** One preview/commit session owns its revision, operation ID and stale-response guard. */
function useLifecycleAction(options: Options) {
  const [state, setState] = useState<State>({ phase: 'closed' })
  const current = useRef(state)
  const generation = useRef(0)
  const operationSequence = useRef(0)
  const latest = useRef(options)
  latest.current = options
  const update = (next: State): void => { current.current = next; setState(next) }
  const reset = useCallback(() => {
    generation.current += 1
    current.current = { phase: 'closed' }
    setState(current.current)
  }, [])
  useLayoutEffect(() => {
    reset()
    return () => { generation.current += 1 }
  }, [options.scopeKey, options.videoId, options.libraryId, reset])

  const preview = (target: Options) => api.videos.previewDeleteGlobally(target.videoId)
  const operationId = (target: Options): string =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `delete-video-${target.videoId}-${Date.now()}-${++operationSequence.current}`

  const open = async (): Promise<void> => {
    if (current.current.phase === 'committing') return
    const target = latest.current
    const request = ++generation.current
    update({ phase: 'loading' })
    try {
      const impact = await preview(target)
      if (request === generation.current) update({ phase: 'ready', impact, operationId: operationId(target) })
    } catch (error) {
      if (request !== generation.current) return
      reset()
      target.onError(String((error as Error).message ?? error))
    }
  }
  const commit = async (): Promise<void> => {
    const ready = current.current
    if (ready.phase !== 'ready') return
    const target = latest.current
    const request = generation.current
    update({ ...ready, phase: 'committing' })
    try {
      const input = { videoId: target.videoId, operationId: ready.operationId, expectedRevision: ready.impact.revision }
      await api.videos.deleteGlobally(input)
      target.onCommitted()
      if (request !== generation.current) return
      reset()
      target.onSuccess('已删除影片')
    } catch (error) {
      if (request !== generation.current) return
      target.onError(String((error as Error).message ?? error))
      update({ phase: 'loading' })
      try {
        const impact = await preview(target)
        if (request === generation.current) update({ phase: 'ready', impact, operationId: operationId(target) })
      } catch {
        if (request === generation.current) reset()
      }
    }
  }
  return {
    isOpen: state.phase !== 'closed',
    loading: state.phase === 'loading',
    busy: state.phase === 'committing',
    impact: state.phase === 'ready' || state.phase === 'committing' ? state.impact : null,
    open, commit, reset,
    close: () => { if (current.current.phase !== 'committing') reset() }
  }
}

export function useVideoLifecycleController(options: Options) {
  const deletion = useLifecycleAction(options)
  return { deletion }
}
