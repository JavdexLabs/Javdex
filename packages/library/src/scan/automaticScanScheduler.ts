import type { LibraryScanTrigger, ScanCompletionResult } from '@shared/libraryTypes'
import type { MediaLibraryAutomaticScanState } from '@shared/mediaLibraryTypes'
import { listMediaLibraryAutomaticScanStates } from '@library/db/mediaLibraryRepo'
import { scanCoordinator } from './scanCoordinator'
import { maintenanceTaskGate } from '@library/scan/maintenanceTaskGate'

export const AUTOMATIC_SCAN_STARTUP_DELAY_MS = 30_000
export const AUTOMATIC_SCAN_RESUME_DELAY_MS = 3_000
const AUTOMATIC_SCAN_POLL_INTERVAL_MS = 60_000

type TimerToken = unknown

export interface AutomaticScanSchedulerDependencies {
  listLibraries: () => MediaLibraryAutomaticScanState[]
  now: () => number
  setTimer: (callback: () => void | Promise<void>, delay: number) => TimerToken
  clearTimer: (timer: TimerToken) => void
  isMaintenanceBusy: () => boolean
  runScan: (libraryId: number, trigger: LibraryScanTrigger) => Promise<ScanCompletionResult>
}

function parsedTimestamp(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Calculates due scans per media library while preserving the process-wide maintenance lock.
 * Library configuration and scan state are read afresh on every tick; legacy settings are not
 * consulted after bootstrap.
 */
export class AutomaticScanScheduler {
  private started = false
  private startupTimer: TimerToken | null = null
  private pollTimer: TimerToken | null = null
  private resumeTimer: TimerToken | null = null
  private runInFlight = false
  private readonly enabledAt = new Map<number, number>()
  private readonly observedEnabled = new Map<number, boolean>()

  constructor(private readonly dependencies: AutomaticScanSchedulerDependencies) {}

  start(): void {
    if (this.started) return
    this.started = true
    for (const library of this.dependencies.listLibraries()) {
      this.observedEnabled.set(library.libraryId, library.enabled)
    }
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
    this.enabledAt.clear()
    this.observedEnabled.clear()
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

  private refreshEnabledTransitions(
    libraries: MediaLibraryAutomaticScanState[],
    now: number
  ): void {
    const present = new Set(libraries.map((library) => library.libraryId))
    for (const libraryId of this.enabledAt.keys()) {
      if (!present.has(libraryId)) this.enabledAt.delete(libraryId)
    }
    for (const libraryId of this.observedEnabled.keys()) {
      if (!present.has(libraryId)) this.observedEnabled.delete(libraryId)
    }
    for (const library of libraries) {
      const wasEnabled = this.observedEnabled.get(library.libraryId)
      if (!library.enabled) {
        this.enabledAt.delete(library.libraryId)
      } else if (wasEnabled !== true) {
        this.enabledAt.set(library.libraryId, now)
      }
      this.observedEnabled.set(library.libraryId, library.enabled)
    }
  }

  private async checkDue(trigger: LibraryScanTrigger): Promise<void> {
    if (!this.started || this.runInFlight || this.dependencies.isMaintenanceBusy()) return
    const now = this.dependencies.now()
    const libraries = [...this.dependencies.listLibraries()].sort(
      (left, right) => left.position - right.position || left.libraryId - right.libraryId
    )
    this.refreshEnabledTransitions(libraries, now)
    const due = libraries.filter((library) => {
      if (
        !library.enabled ||
        (library.activeRootCount === 0 && library.pendingCleanupJobCount === 0)
      ) {
        return false
      }
      const dueFrom =
        parsedTimestamp(library.lastFinishedAt) ?? this.enabledAt.get(library.libraryId)
      return dueFrom == null || now - dueFrom >= library.intervalMinutes * 60_000
    })
    if (due.length === 0) return

    this.runInFlight = true
    try {
      for (const library of due) {
        if (!this.started || this.dependencies.isMaintenanceBusy()) break
        try {
          await this.dependencies.runScan(library.libraryId, trigger)
        } catch {
          // Automatic scans are silent; each library coordinator state records the failure.
        }
      }
    } finally {
      this.runInFlight = false
    }
  }

  private clearTimer(key: 'startupTimer' | 'pollTimer' | 'resumeTimer'): void {
    const timer = this[key]
    if (timer === null) return
    this.dependencies.clearTimer(timer)
    this[key] = null
  }
}

export const automaticScanScheduler = new AutomaticScanScheduler({
  listLibraries: listMediaLibraryAutomaticScanStates,
  now: Date.now,
  setTimer: (callback, delay) => setTimeout(() => void callback(), delay),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  isMaintenanceBusy: () => maintenanceTaskGate.active !== null || scanCoordinator.running,
  runScan: (libraryId, trigger) => scanCoordinator.run({ libraryId, trigger })
})
