import { setTimeout as delay } from 'node:timers/promises'
import type { NativePlayback, NativePlaybackState } from './nativePlayback'
import type { PlaybackControl } from '@shared/desktop/playback'

export type LinuxPlaybackMode = 'auto' | 'gpu' | 'cpu'
/** A single bounded retry, within the same source/session. Native errors are
 * recoverable; media/format errors are not evidence of GPU failure. */
export function createLinuxPlaybackFallback(gpu: NativePlayback, cpu: NativePlayback, preference: () => LinuxPlaybackMode): NativePlayback {
  let current = gpu, mode: LinuxPlaybackMode = 'auto', retried = false, active = false
  let pauseIntent: boolean | undefined
  let source: { locator: string; paused: boolean } | null = null
  let last: NativePlaybackState = { alive: false }
  let restore: NativePlaybackState | null = null
  let viewport: Parameters<NativePlayback['viewport']> | null = null
  const controls = new Map<string, PlaybackControl>()
  const subtitles: string[] = []
  let generated: Parameters<NonNullable<NativePlayback['updateGeneratedSubtitle']>> | null = null
  let restoring = false, epoch = 0
  let restoreFailure: unknown

  const fallback = (error: unknown = new Error('播放内核不可用')): void => {
    if (!active || mode !== 'auto' || current !== gpu || retried) throw error
    retried = true
    const saved = { ...last, pause: pauseIntent ?? last.pause ?? source?.paused ?? false }
    gpu.destroy(); current = cpu
    console.info('[playback] switching to CPU compatibility mode after GPU failure')
    cpu.create()
    if (source) {
      restore = saved
      cpu.load(source.locator, { paused: true })
    }
    if (viewport) cpu.viewport(...viewport)
  }
  const attempt = <T>(operation: () => T): T => {
    try { return operation() }
    catch (error) { fallback(error); return operation() }
  }
  return {
    create() {
      mode = preference(); current = mode === 'cpu' ? cpu : gpu; retried = false; active = true
      pauseIntent = undefined
      epoch++; generated = null; restoring = false; restoreFailure = undefined
      source = null; restore = null; last = { alive: false }; viewport = null; controls.clear(); subtitles.length = 0
      try { current.create() } catch (error) { fallback(error) }
    },
    load(locator, options) {
      source = { locator, paused: options?.paused ?? false }
      pauseIntent = source.paused; last.pause = source.paused
      attempt(() => current.load(locator, options))
    },
    command(control) {
      // Preserve intent newer than the last asynchronous native observation.
      if (control.kind === 'pause') { pauseIntent = control.paused; last.pause = control.paused; if (restore) restore.pause = control.paused; if (source) source.paused = control.paused }
      if (control.kind === 'seek') {
        last['time-pos'] = control.relative ? (last['time-pos'] ?? 0) + control.seconds : control.seconds
        if (restore) restore['time-pos'] = last['time-pos']
      }
      if (!['pause', 'seek'].includes(control.kind)) controls.set(control.kind === 'track' ? `track:${control.type}` : control.kind, control)
      attempt(() => current.command(control))
    },
    read() {
      if (restoreFailure) throw restoreFailure
      let value = attempt(() => current.read())
      if (current === gpu && (!value.alive || value.error && ['native', 'video'].includes(value.errorKind ?? ''))) {
        fallback(new Error(value.error || '播放内核不可用')); value = cpu.read()
      }
      if (restore && !restoring && value.loadedFiles && typeof value.seekable === 'boolean') {
        const saved = restore, revision = epoch
        restoring = true
        void (async () => {
          for (const file of subtitles) cpu.addSubtitle(file)
          if (generated) {
            try { await cpu.updateGeneratedSubtitle?.(generated[0], generated[1], undefined, generated[3]) }
            catch { generated = null; console.warn('[playback] generated subtitle restore failed after CPU recovery') }
          }
          if (revision !== epoch) return
          for (const control of controls.values()) cpu.command(control)
          const position = saved['time-pos'] ?? 0
          if (value.seekable && position > 0) {
            cpu.command({ kind: 'seek', seconds: position })
            const deadline = Date.now() + 10000
            for (;;) {
              await delay(20)
              if (revision !== epoch) return
              const next = cpu.read()
              if (!next.alive || next.error) throw new Error('CPU 回退恢复失败')
              if (!next.seeking && Math.abs((next['time-pos'] ?? -100) - (saved['time-pos'] ?? 0)) < 2) break
              if (Date.now() >= deadline) throw new Error('CPU 回退跳转超时')
            }
          }
          if (revision !== epoch) return
          cpu.command({ kind: 'pause', paused: saved.pause ?? source?.paused ?? false })
          restore = null; restoring = false
        })().catch(error => { if (revision === epoch) restoreFailure = error })
      }
      last = restore ? { ...value, pause: restore.pause, 'time-pos': restore['time-pos'] } : value
      return { ...last, playbackMode: current === cpu ? 'cpu' : 'gpu', playbackFallback: retried }
    },
    viewport(...args) { viewport = args; attempt(() => current.viewport(...args)) },
    render() { if (active) attempt(() => current.render()) },
    addSubtitle(file) { attempt(() => current.addSubtitle(file)); if (!subtitles.includes(file)) subtitles.push(file) },
    updateGeneratedSubtitle(...args) { generated = args; return current.updateGeneratedSubtitle?.(...args) },
    removeGeneratedSubtitle(...args) { generated = null; return current.removeGeneratedSubtitle?.(...args) },
    generatedSubtitleSelected: file => current.generatedSubtitleSelected?.(file) ?? false,
    selectedAudioStream: () => current.selectedAudioStream?.() ?? null,
    subtitleCommandErrors: () => current.subtitleCommandErrors?.() ?? 0,
    generatedSubtitleCommandErrors: () => current.generatedSubtitleCommandErrors?.() ?? 0,
    destroy() { epoch++; generated = null; restoring = false; restoreFailure = undefined; active = false; source = null; restore = null; viewport = null; gpu.destroy(); cpu.destroy() }
  }
}
