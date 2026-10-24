export const SOFTWARE_STARTUP_FLAG = '--javdex-software'
const RETRY_FLAG = '--javdex-startup-recovery'
const graphicsReasons = new Set(['crashed', 'abnormal-exit', 'launch-failed', 'integrity-failure'])
export interface StartupGpuExit { type: string; reason: string; exitCode?: number }
export interface StartupDiagnostic { code: string; software: boolean; retried: boolean; reason?: string; exitCode?: number; error?: string }
export interface StartupRecoveryPorts {
  disableHardwareAcceleration(): void
  relaunch(args: string[]): void
  quit(): void
  record(value: StartupDiagnostic): void
  failed(code: string): void
  recovered(retryGpu: () => void): void
}

/** Parse only Chromium switches, never paths/arguments after its separator. */
export function startupSwitches(argv: string[]): string[] {
  const end = argv.indexOf('--', 1)
  return argv.slice(1, end < 0 ? undefined : end)
}
export function softwareStartupRequested(argv: string[]): boolean {
  return startupSwitches(argv).some(value => value === SOFTWARE_STARTUP_FLAG || value.startsWith(RETRY_FLAG + '='))
}
function relaunchArguments(argv: string[], software: boolean): string[] {
  const end = argv.indexOf('--', 1)
  const switches = startupSwitches(argv).filter(value => value !== SOFTWARE_STARTUP_FLAG && !value.startsWith(RETRY_FLAG + '='))
  return [...switches, ...(software ? [SOFTWARE_STARTUP_FLAG, RETRY_FLAG + '=1'] : []), ...(end < 0 ? [] : argv.slice(end))]
}

/** Shared policy only. It does not inspect media, databases, drivers or a slow
 * startup, and never installs a process-wide crash/exception retry handler. */
export function createStartupGraphicsRecovery(ports: StartupRecoveryPorts, argv: string[]) {
  const retried = startupSwitches(argv).some(value => value.startsWith(RETRY_FLAG + '='))
  const software = softwareStartupRequested(argv) || startupSwitches(argv).includes('--disable-gpu')
  let phase: 'starting' | 'healthy' | 'restarting' | 'failed' | 'stopped' = 'starting'
  let primary: boolean | undefined
  let pending: StartupGpuExit | undefined
  const record = (code: string, details: Partial<StartupDiagnostic> = {}): void => {
    try { ports.record({ code, software, retried, ...details }) } catch { /* Diagnostics must never prevent recovery. */ }
  }
  const terminal = (code: string): void => {
    phase = 'failed'; record(code)
    try { ports.failed(code) } catch { record('FAILURE_DIALOG_UNAVAILABLE') } finally { ports.quit() }
  }
  const gpuExited = (details: StartupGpuExit): void => {
    if (phase !== 'starting' || details.type !== 'GPU' || !graphicsReasons.has(details.reason)) return
    if (primary === undefined) { pending ??= { ...details }; return }
    if (!primary) return
    record('GPU_STARTUP_FAILED', { reason: details.reason,
      ...(Number.isInteger(details.exitCode) ? { exitCode: details.exitCode } : {}) })
    if (retried || software) { terminal('SOFTWARE_STARTUP_FAILED'); return }
    phase = 'restarting'
    record('SOFTWARE_RELAUNCH')
    try { ports.relaunch(relaunchArguments(argv, true)) }
    catch { terminal('RELAUNCH_FAILED'); return }
    ports.quit()
  }
  return {
    configure(): void { if (software) ports.disableHardwareAcceleration(); record('STARTUP') },
    claimPrimary(value: boolean): void {
      primary = value
      if (!value) { phase = 'stopped'; pending = undefined; return }
      if (pending) { const details = pending; pending = undefined; gpuExited(details) }
    },
    gpuExited,
    isStarting: (): boolean => phase === 'starting',
    canContinue: (): boolean => phase === 'starting' || phase === 'healthy',
    windowReady(): void {
      if (phase !== 'starting' || primary !== true) return
      phase = 'healthy'; record('WINDOW_READY')
      if (retried) {
        try { ports.recovered(() => {
          if (phase !== 'healthy') return
          phase = 'restarting'; record('USER_GPU_RETRY')
          try { ports.relaunch(relaunchArguments(argv, false)) }
          catch { terminal('RELAUNCH_FAILED'); return }
          ports.quit()
        }) } catch { record('RECOVERY_DIALOG_UNAVAILABLE') }
      }
    },
    startupFailed(error: unknown): void {
      if (phase !== 'starting' && phase !== 'healthy') return
      // Native/DB/load errors are terminal, even when their text mentions GPU.
      record('APP_STARTUP_ERROR', { error: error instanceof Error ? error.message.slice(0, 4096) : 'Unknown startup error' })
      terminal('APP_STARTUP_FAILED')
    },
    stop(): void { if (phase === 'starting' || phase === 'healthy') phase = 'stopped' }
  }
}
