import type { LocalExecutionStatus, LocalModelValidation } from '@shared/desktop/localModels'

/** Serial, preemptible checks. A cancelled generation can never publish a result. */
export function createModelValidation<T extends { variant: string }>(options: {
  targets: () => T[]
  available: () => boolean
  validate: (target: T, signal: AbortSignal) => Promise<LocalExecutionStatus>
  changed: () => void
  debounceMs?: number
}) {
  const results = new Map<string, LocalModelValidation>()
  let generation = 0, closed = false, requested = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let pending: Promise<void> | undefined
  function schedule(): void {
    if (closed) return
    requested = true
    if (timer || pending) return
    timer = setTimeout(() => {
      timer = undefined
      if (!options.available()) return
      requested = false
      const targets = options.targets().filter(target => !results.has(target.variant) || results.get(target.variant)?.state === 'waiting')
      if (!targets.length) return
      const epoch = generation, abort = new AbortController()
      controller = abort
      pending = (async () => {
        for (const target of targets) {
          if (abort.signal.aborted || epoch !== generation || !options.available()) break
          results.set(target.variant, { state: 'checking' }); options.changed()
          try {
            const execution = await options.validate(target, abort.signal)
            if (abort.signal.aborted || epoch !== generation) break
            if (execution.backend === 'idle') throw new Error('引擎未报告运行设备，请重新验证')
            results.set(target.variant, { state: 'passed', execution, checkedAt: new Date().toISOString() })
          } catch (cause) {
            if (abort.signal.aborted || epoch !== generation) break
            results.set(target.variant, { state: 'failed', checkedAt: new Date().toISOString(),
              message: cause instanceof Error ? cause.message : '模型试运行失败，请校验与修复' })
          }
          options.changed()
        }
      })().finally(() => {
        pending = undefined; controller = undefined
        if (requested) schedule()
      })
    }, options.debounceMs ?? 250)
    timer.unref?.()
  }
  function cancel(): void {
    requested = false; generation++
    if (timer) clearTimeout(timer)
    timer = undefined; controller?.abort()
    for (const [variant, result] of results) if (result.state === 'checking') results.set(variant, { state: 'waiting' })
  }
  return {
    get: (variant: string): LocalModelValidation | undefined => results.get(variant),
    schedule,
    invalidate(): void { cancel(); results.clear(); schedule(); options.changed() },
    async pause(): Promise<void> { cancel(); await pending; schedule() },
    async close(): Promise<void> { closed = true; cancel(); await pending }
  }
}
