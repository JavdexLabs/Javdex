/** One pending value per task. Progress is lossy; final state must be flushed explicitly. */
export function createProgressPublisher<T>(
  publish: (value: T) => void,
  intervalMs = 100,
  now: () => number = () => performance.now()
): { update(value: T, immediate?: boolean): void; close(): void } {
  let lastPublished = -Infinity
  let pending: { value: T } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  function flush(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const next = pending
    pending = null
    if (!next) return
    lastPublished = now()
    publish(next.value)
  }

  return {
    update(value, immediate = false) {
      if (closed) return
      pending = { value }
      const delay = Math.max(0, intervalMs - (now() - lastPublished))
      if (immediate || delay === 0) flush()
      else if (timer === undefined) {
        timer = setTimeout(flush, delay)
        timer.unref?.()
      }
    },
    close() {
      if (closed) return
      closed = true
      flush()
    }
  }
}
