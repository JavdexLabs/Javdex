import { setTimeout as delay } from 'node:timers/promises'
import type { PlaybackControl } from '@shared/desktop/playback'
import type { NativePlayback, NativePlaybackState } from './nativePlayback'

/** Retry the same authorized source once in the independent SW renderer. After
 * a graphics failure, stay on CPU until app restart; never reuse uncertain GL or
 * consumer-held D3D resources. Media/auth/audio failures are not GPU failures. */
export function createWindowsPlaybackFallback(gpu: NativePlayback, cpu: NativePlayback,
  options: { forceCpu(): boolean; gpuAvailable(): boolean }): NativePlayback {
  let current = gpu, active = false, gpuFailed = false, reason: string | undefined
  let epoch = 0, restoring = false, restoreFailure: unknown
  let pauseIntent: boolean | undefined, seekIntent: number | undefined
  let source: { locator: string; paused: boolean } | null = null
  let last: NativePlaybackState = { alive: false }
  let recovery: { position: number; paused: boolean; started: number; seekRevision: number } | null = null
  let viewport: Parameters<NativePlayback['viewport']> | null = null
  const controls = new Map<string, PlaybackControl>(), subtitles: string[] = []
  let generated: Parameters<NonNullable<NativePlayback['updateGeneratedSubtitle']>> | null = null
  const graphicsError = (error: unknown): boolean => error instanceof Error
    && !/页面已关闭|page.*closed|运行库.*缺少|运行库需更新|播放运行库缺少/i.test(error.message)
    && /OpenGL|\bWGL\b|\bGL\b|D3D|DXGI|GPU|共享.*[纹帧]|shared.texture|native.*(context|drawable|pixel format|frame rendering|swap)/i.test(error.message)
  const hideGpu = (): void => {
    if (viewport) { try { gpu.viewport(viewport[0], false, viewport[2], viewport[3]) } catch { /* Lost contexts can reject viewport work. */ } }
    // A failed graphics cleanup must not prevent independent CPU playback. The
    // native implementations retain uncertain resources; never force-free them.
    try { gpu.destroy() } catch { console.warn('[playback] failed graphics resources retained until exit') }
  }
  const fallback = (error: unknown, kind: 'initialization' | 'runtime'): void => {
    if (!active || current !== gpu || gpuFailed) throw error
    gpuFailed = true; reason = kind === 'initialization' ? 'GPU_INITIALIZATION_FAILED' : 'GPU_RUNTIME_FAILED'
    const saved = { position: seekIntent ?? last['time-pos'] ?? 0, paused: pauseIntent ?? last.pause ?? source?.paused ?? false, started: Date.now(), seekRevision: 0 }
    hideGpu(); current = cpu
    console.info('[playback] Windows CPU recovery reason=' + reason)
    cpu.create()
    if (source) { recovery = saved; cpu.load(source.locator, { paused: true }) }
    if (viewport) cpu.viewport(viewport[0], recovery ? false : viewport[1], viewport[2], viewport[3])
  }
  const attempt = <T>(operation: () => T): T => {
    try { return operation() }
    catch (error) {
      if (!graphicsError(error)) throw error
      fallback(error, source ? 'runtime' : 'initialization')
      return operation()
    }
  }
  const perform = (operation: () => void): void => {
    try { operation() }
    catch (error) {
      if (!graphicsError(error)) throw error
      fallback(error, source ? 'runtime' : 'initialization')
      // fallback already loaded the source paused and retained command intent.
      // Reissuing load/pause here would race restoration or load the file twice.
    }
  }
  const restore = (value: NativePlaybackState): void => {
    if (!recovery || restoring || !value.loadedFiles || typeof value.seekable !== 'boolean') return
    const saved = recovery, revision = epoch
    restoring = true
    const valid = (): boolean => active && epoch === revision && recovery === saved
    void (async () => {
      for (const file of subtitles) cpu.addSubtitle(file)
      if (generated) {
        const savedGenerated = generated
        try { await cpu.updateGeneratedSubtitle?.(savedGenerated[0], savedGenerated[1], undefined, savedGenerated[3]) }
        catch { if (valid() && generated === savedGenerated) { generated = null; console.warn('[playback] generated subtitles could not be restored after CPU recovery') } }
      }
      if (!valid()) return
      for (const control of controls.values()) cpu.command(control)
      if (value.seekable && saved.position > 0) {
        for (;;) {
          const seekingRevision = saved.seekRevision, position = saved.position
          cpu.command({ kind: 'seek', seconds: position })
          for (;;) {
            await delay(20)
            if (!valid()) return
            const next = cpu.read()
            if (!next.alive || next.error) throw new Error('CPU 回退恢复失败')
            if (seekingRevision !== saved.seekRevision) break
            if (!next.seeking && Math.abs((next['time-pos'] ?? -100) - position) < 1.5) break
            if (Date.now() - saved.started > 15000) throw new Error('CPU 回退跳转超时')
          }
          if (seekingRevision === saved.seekRevision) break
        }
      }
      if (!valid()) return
      // Commands can arrive while generated subtitles or seek were pending.
      for (const control of controls.values()) cpu.command(control)
      cpu.command({ kind: 'pause', paused: saved.paused })
      recovery = null; restoring = false
      if (viewport) cpu.viewport(...viewport)
    })().catch(error => { if (valid()) restoreFailure = error })
  }
  return {
    renderPolling: gpu.renderPolling === false && cpu.renderPolling === false ? false : undefined,
    create(): void {
      epoch++; active = true; source = null; last = { alive: false }; recovery = null
      pauseIntent = undefined; seekIntent = undefined
      viewport = null; generated = null; restoring = false; restoreFailure = undefined
      controls.clear(); subtitles.length = 0
      const forced = options.forceCpu()
      if (!forced && !options.gpuAvailable()) { gpuFailed = true; reason = 'GPU_DISABLED' }
      current = forced || gpuFailed ? cpu : gpu
      try { current.create() }
      catch (error) { if (current !== gpu || !graphicsError(error)) throw error; fallback(error, 'initialization') }
    },
    load(locator, options): void {
      epoch++; recovery = null; restoring = false; restoreFailure = undefined; generated = null
      controls.clear(); subtitles.length = 0
      source = { locator, paused: options?.paused ?? false }; last = { alive: true, pause: source.paused }
      pauseIntent = source.paused; seekIntent = undefined
      perform(() => current.load(locator, options))
    },
    command(control): void {
      if (control.kind === 'pause') {
        pauseIntent = control.paused
        last.pause = control.paused
        if (source) source.paused = control.paused
        if (recovery) recovery.paused = control.paused
      } else if (control.kind === 'seek') {
        last['time-pos'] = Math.max(0, control.relative ? (last['time-pos'] ?? 0) + control.seconds : control.seconds)
        seekIntent = last['time-pos']
        if (recovery) { recovery.position = last['time-pos']; recovery.seekRevision++ }
      } else controls.set(control.kind === 'track' ? `track:${control.type}` : control.kind, control)
      if (!recovery) perform(() => current.command(control))
    },
    read(): NativePlaybackState {
      if (restoreFailure) throw restoreFailure
      if (recovery && Date.now() - recovery.started > 15000) throw new Error('CPU 回退恢复超时')
      let value = attempt(() => current.read())
      if (seekIntent !== undefined && !value.seeking && Math.abs((value['time-pos'] ?? -100) - seekIntent) < 1.5) seekIntent = undefined
      if (active && current === gpu && value.error && ['native', 'video'].includes(value.errorKind ?? '')) {
        last = { ...last, ...value }; fallback(new Error(value.error), 'runtime'); value = cpu.read()
      }
      restore(value)
      last = recovery ? { ...value, pause: recovery.paused, 'time-pos': recovery.position } : value
      return { ...last, playbackMode: current === cpu ? 'cpu' : 'gpu', playbackFallback: current === cpu && gpuFailed,
        playbackFallbackReason: current === cpu && gpuFailed ? reason : undefined }
    },
    viewport(...args): void {
      viewport = args
      if (recovery) cpu.viewport(args[0], false, args[2], args[3])
      else perform(() => current.viewport(...args))
    },
    render(): void { if (active) attempt(() => current.render()) },
    addSubtitle(file): void {
      if (!subtitles.includes(file)) subtitles.push(file)
      controls.delete('track:sub')
      // Once restoration starts, the queued subtitles have already been sent.
      // A newly selected sidecar must reach CPU even while its seek is pending.
      if (!recovery || restoring) perform(() => current.addSubtitle(file))
    },
    updateGeneratedSubtitle(...args) { generated = args; if (args[1]) controls.delete('track:sub'); return current.updateGeneratedSubtitle?.(...args) },
    removeGeneratedSubtitle(...args) { generated = null; return current.removeGeneratedSubtitle?.(...args) },
    generatedSubtitleSelected: file => current.generatedSubtitleSelected?.(file) ?? false,
    selectedAudioStream: () => current.selectedAudioStream?.() ?? null,
    subtitleCommandErrors: () => current.subtitleCommandErrors?.() ?? 0,
    generatedSubtitleCommandErrors: () => current.generatedSubtitleCommandErrors?.() ?? 0,
    destroy(): void {
      epoch++; active = false; recovery = null; generated = null; restoring = false; restoreFailure = undefined
      source = null; viewport = null; current.destroy()
    }
  }
}
