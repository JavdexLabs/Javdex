import type { LibraryScanTrigger, ScanResult } from '@shared/libraryTypes'
import type { AppSettings } from '@shared/settingsTypes'
import { scanCoordinator } from '../scanner/scanCoordinator'
import { getSettings } from '../settings/settingsStore'
import { maintenanceTaskGate } from './maintenanceTaskGate'

export const AUTOMATIC_SCAN_STARTUP_DELAY_MS = 30_000
export const AUTOMATIC_SCAN_RESUME_DELAY_MS = 3_000
const AUTOMATIC_SCAN_POLL_INTERVAL_MS = 60_000

type TimerToken = unknown

export interface AutomaticScanSchedulerDependencies {
  getSettings: () => AppSettings
  now: () => number
  setTimer: (callback: () => void | Promise<void>, delay: number) => TimerToken
  clearTimer: (timer: TimerToken) => void
  isMaintenanceBusy: () => boolean
  runScan: (trigger: LibraryScanTrigger) => Promise<ScanResult>
}

function validFinishedAt(settings: AppSettings): number | null {
  const value = settings.lastLibraryScanSummary?.finishedAt
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export class AutomaticScanScheduler {
  private started = false
  private observedEnabled = false
  private enabledAt: number | null = null
  private startupTimer: TimerToken | null = null
  private pollTimer: TimerToken | null = null
  private resumeTimer: TimerToken | null = null
  private runInFlight = false

  constructor(private readonly dependencies: AutomaticScanSchedulerDependencies) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.observedEnabled = this.dependencies.getSettings().autoScanEnabled
    this.enabledAt = null
    this.startupTimer = this.dependencies.setTimer(async () => {
      this.startupTimer = null
      await this.checkDue('startup')
      this.schedulePoll()
    }, AUTOMATIC_SCAN_STARTUP_DELAY_MS)
  }

  stop(): void {
    this.started = false
    this.clearTimer('startupTimer')
    this.clearTimer('pollTimer')
    this.clearTimer('resumeTimer')
  }

  handleResume(): void {
    if (!this.started) return
    this.clearTimer('resumeTimer')
    this.resumeTimer = this.dependencies.setTimer(async () => {
      this.resumeTimer = null
      await this.checkDue('resume')
    }, AUTOMATIC_SCAN_RESUME_DELAY_MS)
  }

  private schedulePoll(): void {
    if (!this.started || this.pollTimer !== null) return
    this.pollTimer = this.dependencies.setTimer(async () => {
      this.pollTimer = null
      await this.checkDue('interval')
      this.schedulePoll()
    }, AUTOMATIC_SCAN_POLL_INTERVAL_MS)
  }

  private async checkDue(trigger: LibraryScanTrigger): Promise<void> {
    if (!this.started) return
    const settings = this.dependencies.getSettings()
    const now = this.dependencies.now()

    if (!settings.autoScanEnabled) {
      this.observedEnabled = false
      this.enabledAt = null
      return
    }
    if (!this.observedEnabled) {
      this.observedEnabled = true
      this.enabledAt = now
      return
    }
    if (settings.libraryPaths.length === 0 && settings.pendingLibraryPathCleanups.length === 0) {
      return
    }

    const lastFinishedAt = validFinishedAt(settings)
    const dueFrom = lastFinishedAt ?? this.enabledAt
    const intervalMs = settings.autoScanIntervalMinutes * 60_000
    if (dueFrom !== null && now - dueFrom < intervalMs) return
    if (this.runInFlight || this.dependencies.isMaintenanceBusy()) return

    this.runInFlight = true
    try {
      await this.dependencies.runScan(trigger)
    } catch {
      // Automatic scans are intentionally silent; the coordinator persists their outcome.
    } finally {
      this.runInFlight = false
    }
  }

  private clearTimer(
    key: 'startupTimer' | 'pollTimer' | 'resumeTimer'
  ): void {
    const timer = this[key]
    if (timer === null) return
    this.dependencies.clearTimer(timer)
    this[key] = null
  }
}

export const automaticScanScheduler = new AutomaticScanScheduler({
  getSettings,
  now: Date.now,
  setTimer: (callback, delay) => setTimeout(() => void callback(), delay),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  isMaintenanceBusy: () => maintenanceTaskGate.active !== null || scanCoordinator.running,
  runScan: (trigger) => scanCoordinator.run({ trigger })
})
