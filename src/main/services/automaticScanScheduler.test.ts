import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settingsTypes'
import type { LibraryScanSummary, LibraryScanTrigger, ScanResult } from '@shared/libraryTypes'
import { AutomaticScanScheduler } from './automaticScanScheduler'

interface ScheduledTask {
  id: number
  delay: number
  callback: () => void | Promise<void>
}

class FakeTimers {
  private nextId = 1
  readonly tasks: ScheduledTask[] = []

  set = (callback: () => void | Promise<void>, delay: number): number => {
    const id = this.nextId++
    this.tasks.push({ id, delay, callback })
    return id
  }

  clear = (id: unknown): void => {
    const index = this.tasks.findIndex((task) => task.id === id)
    if (index >= 0) this.tasks.splice(index, 1)
  }

  async runNext(delay?: number): Promise<void> {
    const index = delay === undefined ? 0 : this.tasks.findIndex((task) => task.delay === delay)
    assert.notEqual(index, -1, `missing timer with delay ${delay}`)
    const [task] = this.tasks.splice(index, 1)
    await task.callback()
  }
}

function scanResult(): ScanResult {
  return {
    scannedFiles: 0,
    imported: 0,
    skipped: 0,
    skippedShort: 0,
    failed: 0,
    pendingGroups: 0,
    pendingResources: 0,
    relocated: 0,
    refreshed: 0,
    removed: 0,
    promoted: 0,
    deletedVideos: 0,
    offlineFolders: [],
    newCodes: [],
    unrecognizedFiles: []
  }
}

function summary(finishedAt: string): LibraryScanSummary {
  return {
    trigger: 'manual',
    startedAt: finishedAt,
    finishedAt,
    status: 'success',
    scannedFiles: 0,
    resourcesAdded: 0,
    resourcesUpdated: 0,
    resourcesRemoved: 0,
    primaryResourcesPromoted: 0,
    videosDeleted: 0,
    skippedFiles: 0,
    failedFiles: 0,
    pendingScanGroups: 0,
    pendingScanResources: 0,
    offlineFolders: [],
    errorSummary: null
  }
}

function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    libraryPaths: ['/library'],
    ...patch
  }
}

describe('AutomaticScanScheduler', () => {
  it('checks about 30 seconds after startup and runs a due full scan with startup source', async () => {
    const timers = new FakeTimers()
    const now = Date.parse('2026-08-10T02:00:00.000Z')
    let current = settings({
      autoScanEnabled: true,
      autoScanIntervalMinutes: 60,
      lastLibraryScanSummary: summary('2026-08-10T00:59:00.000Z')
    })
    const triggers: LibraryScanTrigger[] = []
    const scheduler = new AutomaticScanScheduler({
      getSettings: () => current,
      now: () => now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      isMaintenanceBusy: () => false,
      runScan: async (trigger) => {
        triggers.push(trigger)
        current = { ...current, lastLibraryScanSummary: summary(new Date(now).toISOString()) }
        return scanResult()
      }
    })

    scheduler.start()
    assert.equal(timers.tasks[0]?.delay, 30_000)
    assert.deepEqual(triggers, [])
    await timers.runNext(30_000)

    assert.deepEqual(triggers, ['startup'])
    scheduler.stop()
  })

  it('does not scan immediately when enabled and waits for the selected interval', async () => {
    const timers = new FakeTimers()
    let now = Date.parse('2026-08-10T02:00:00.000Z')
    let current = settings({ autoScanEnabled: false, autoScanIntervalMinutes: 60 })
    const triggers: LibraryScanTrigger[] = []
    const scheduler = new AutomaticScanScheduler({
      getSettings: () => current,
      now: () => now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      isMaintenanceBusy: () => false,
      runScan: async (trigger) => {
        triggers.push(trigger)
        current = { ...current, lastLibraryScanSummary: summary(new Date(now).toISOString()) }
        return scanResult()
      }
    })

    scheduler.start()
    await timers.runNext(30_000)
    current = { ...current, autoScanEnabled: true }
    await timers.runNext()
    assert.deepEqual(triggers, [])

    now += 59 * 60_000
    await timers.runNext()
    assert.deepEqual(triggers, [])

    now += 2 * 60_000
    await timers.runNext()
    assert.deepEqual(triggers, ['interval'])
    scheduler.stop()
  })

  it('waits briefly after resume and uses the resume source only when due', async () => {
    const timers = new FakeTimers()
    const now = Date.parse('2026-08-10T02:00:00.000Z')
    let current = settings({
      autoScanEnabled: true,
      autoScanIntervalMinutes: 30,
      lastLibraryScanSummary: summary('2026-08-10T01:00:00.000Z')
    })
    const triggers: LibraryScanTrigger[] = []
    const scheduler = new AutomaticScanScheduler({
      getSettings: () => current,
      now: () => now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      isMaintenanceBusy: () => false,
      runScan: async (trigger) => {
        triggers.push(trigger)
        current = { ...current, lastLibraryScanSummary: summary(new Date(now).toISOString()) }
        return scanResult()
      }
    })

    scheduler.start()
    scheduler.handleResume()
    assert.equal(timers.tasks.some((task) => task.delay === 3_000), true)
    await timers.runNext(3_000)

    assert.deepEqual(triggers, ['resume'])
    scheduler.stop()
  })

  it('does not scan after resume when the selected interval is not due', async () => {
    const timers = new FakeTimers()
    const now = Date.parse('2026-08-10T02:00:00.000Z')
    const current = settings({
      autoScanEnabled: true,
      autoScanIntervalMinutes: 60,
      lastLibraryScanSummary: summary('2026-08-10T01:30:00.000Z')
    })
    const triggers: LibraryScanTrigger[] = []
    const scheduler = new AutomaticScanScheduler({
      getSettings: () => current,
      now: () => now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      isMaintenanceBusy: () => false,
      runScan: async (trigger) => {
        triggers.push(trigger)
        return scanResult()
      }
    })

    scheduler.start()
    scheduler.handleResume()
    await timers.runNext(3_000)

    assert.deepEqual(triggers, [])
    scheduler.stop()
  })

  it('skips a busy due trigger without queueing and retries on the next check', async () => {
    const timers = new FakeTimers()
    const now = Date.parse('2026-08-10T02:00:00.000Z')
    const current = settings({
      autoScanEnabled: true,
      autoScanIntervalMinutes: 15,
      lastLibraryScanSummary: summary('2026-08-10T01:00:00.000Z')
    })
    let busy = true
    const triggers: LibraryScanTrigger[] = []
    const scheduler = new AutomaticScanScheduler({
      getSettings: () => current,
      now: () => now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      isMaintenanceBusy: () => busy,
      runScan: async (trigger) => {
        triggers.push(trigger)
        return scanResult()
      }
    })

    scheduler.start()
    await timers.runNext(30_000)
    assert.deepEqual(triggers, [])

    busy = false
    await timers.runNext()
    assert.deepEqual(triggers, ['interval'])
    scheduler.stop()
  })

  it('clears startup, interval, and resume checks when stopped', async () => {
    const timers = new FakeTimers()
    const scheduler = new AutomaticScanScheduler({
      getSettings: () => settings({ autoScanEnabled: false }),
      now: Date.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
      isMaintenanceBusy: () => false,
      runScan: async () => scanResult()
    })

    scheduler.start()
    scheduler.handleResume()
    assert.equal(timers.tasks.length, 2)
    scheduler.stop()

    assert.equal(timers.tasks.length, 0)
  })
})
