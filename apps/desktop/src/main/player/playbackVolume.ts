import type { DesktopSettingsStore } from '../application/desktopPorts'

/** Device-only preference. No source identity or viewing position is stored here. */
export function createPlaybackVolume(settings: DesktopSettingsStore) {
  let value: number | null = null
  let pending: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let writing = Promise.resolve()
  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = null
    if (pending == null) return writing
    const next = pending
    pending = null
    writing = writing.then(async () => {
      try { await settings.write({ playbackVolume: next }) }
      catch {
        // Retain the newest preference for a later stop/change retry, without interrupting playback.
        if (pending == null && value === next) pending = next
        console.warn('[playback] unable to save device volume')
      }
    })
    return writing
  }
  return {
    async read(): Promise<number> {
      if (value == null) {
        let saved = 50
        try { saved = (await settings.read()).playbackVolume }
        catch { console.warn('[playback] unable to read device volume') }
        value ??= Number.isFinite(saved) ? Math.max(0, Math.min(100, saved)) : 50
      }
      return value
    },
    remember(next: number): void {
      if (!Number.isFinite(next)) return
      next = Math.max(0, Math.min(100, next))
      if (next === value) return
      value = next
      pending = next
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void flush() }, 300)
      timer.unref()
    },
    flush
  }
}
