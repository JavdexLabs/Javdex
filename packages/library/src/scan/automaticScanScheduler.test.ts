import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LibraryScanTrigger, ScanCompletionResult } from '@shared/libraryTypes'
import type { MediaLibraryAutomaticScanState } from '@shared/mediaLibraryTypes'
import {
  AUTOMATIC_SCAN_RESUME_DELAY_MS,
  AUTOMATIC_SCAN_STARTUP_DELAY_MS,
  AutomaticScanScheduler
} from './automaticScanScheduler'

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
    const index =
      delay === undefined ? 0 : this.tasks.findIndex((task) => task.delay === delay)
    assert.notEqual(index, -1, `missing timer with delay ${delay}`)
    const [task] = this.tasks.splice(index, 1)
    await task.callback()
  }
}

function library(
  libraryId: number,
  patch: Partial<MediaLibraryAutomaticScanState> = {}
): MediaLibraryAutomaticScanState {
  return {
    libraryId,
    position: libraryId,
    enabled: true,
    intervalMinutes: 60,
    activeRootCount: 1,
    pendingCleanupJobCount: 0,
    lastFinishedAt: '2026-08-10T00:00:00.000Z',
    ...patch
  }
}

function result(libraryId: number): ScanCompletionResult {
  return {
    libraryId,
    runId: `run-${libraryId}`,
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
    unrecognizedCount: 0,
    strmFailures: [],
    omittedStrmFailures: 0
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return {
    promise: new Promise<void>((done) => {
      resolve = done
    }),
    resolve: () => resolve()
  }
}

function createHarness(
  initial: MediaLibraryAutomaticScanState[],
  onRun?: (libraryId: number, trigger: LibraryScanTrigger) => Promise<ScanCompletionResult>
) {
  const timers = new FakeTimers()
  let now = Date.parse('2026-08-10T02:00:00.000Z')
  let libraries = initial
  let busy = false
  const calls: Array<[number, LibraryScanTrigger]> = []
  const scheduler = new AutomaticScanScheduler({
    listLibraries: () => libraries,
    now: () => now,
    setTimer: timers.set,
    clearTimer: timers.clear,
    isMaintenanceBusy: () => busy,
    runScan: async (libraryId, trigger) => {
      calls.push([libraryId, trigger])
      return onRun ? onRun(libraryId, trigger) : result(libraryId)
    }
  })
  return {
    scheduler,
    timers,
    calls,
    setNow(value: number) {
      now = value
    },
    setLibraries(value: MediaLibraryAutomaticScanState[]) {
      libraries = value
    },
    setBusy(value: boolean) {
      busy = value
    }
  }
}

describe('AutomaticScanScheduler', () => {
  it('runs every due library in stable order from independent persisted state', async () => {
    const harness = createHarness([
      library(2, { position: 2 }),
      library(1, { position: 1 }),
      library(3, { position: 3, lastFinishedAt: '2026-08-10T01:30:00.000Z' })
    ])
    harness.scheduler.start()
    assert.equal(harness.timers.tasks[0]?.delay, AUTOMATIC_SCAN_STARTUP_DELAY_MS)
    await harness.timers.runNext(AUTOMATIC_SCAN_STARTUP_DELAY_MS)
    assert.deepEqual(harness.calls, [
      [1, 'startup'],
      [2, 'startup']
    ])
    harness.scheduler.stop()
  })

  it('runs an already-enabled library with no scan history after the startup delay', async () => {
    const harness = createHarness([library(1, { lastFinishedAt: null })])

    harness.scheduler.start()
    await harness.timers.runNext(AUTOMATIC_SCAN_STARTUP_DELAY_MS)

    assert.deepEqual(harness.calls, [[1, 'startup']])
    harness.scheduler.stop()
  })

  it('calculates each library due time from its own interval and last finished time', async () => {
    const harness = createHarness([
      library(1, {
        intervalMinutes: 60,
        lastFinishedAt: '2026-08-10T01:30:00.000Z'
      }),
      library(2, {
        intervalMinutes: 15,
        lastFinishedAt: '2026-08-10T01:30:00.000Z'
      })
    ])

    harness.scheduler.start()
    await harness.timers.runNext(AUTOMATIC_SCAN_STARTUP_DELAY_MS)

    assert.deepEqual(harness.calls, [[2, 'startup']])
    harness.scheduler.stop()
  })

  it('waits one full interval after a library is newly enabled', async () => {
    const start = Date.parse('2026-08-10T02:00:00.000Z')
    const harness = createHarness([library(1, { enabled: false, lastFinishedAt: null })])
    harness.scheduler.start()
    await harness.timers.runNext(AUTOMATIC_SCAN_STARTUP_DELAY_MS)
    harness.setLibraries([library(1, { enabled: true, lastFinishedAt: null })])
    await harness.timers.runNext()
    assert.deepEqual(harness.calls, [])
    harness.setNow(start + 61 * 60_000)
    await harness.timers.runNext()
    assert.deepEqual(harness.calls, [[1, 'interval']])
    harness.scheduler.stop()
  })

  it('skips disabled, rootless and not-yet-due libraries', async () => {
    const harness = createHarness([
      library(1, { enabled: false }),
      library(2, { activeRootCount: 0 }),
      library(3, { lastFinishedAt: '2026-08-10T01:30:00.000Z' })
    ])
    harness.scheduler.start()
    await harness.timers.runNext(AUTOMATIC_SCAN_STARTUP_DELAY_MS)
    assert.deepEqual(harness.calls, [])
    harness.scheduler.stop()
  })

  it('runs a due rootless library when it still has deferred cleanup work', async () => {
    const harness = createHarness([
      library(1, { activeRootCount: 0, pendingCleanupJobCount: 1 }),
      library(2, { activeRootCount: 0, pendingCleanupJobCount: 0 })
    ])

    harness.scheduler.start()
    await harness.timers.runNext(AUTOMATIC_SCAN_STARTUP_DELAY_MS)

    assert.deepEqual(harness.calls, [[1, 'startup']])
    harness.scheduler.stop()
  })

  it('defers while maintenance is busy and rechecks on the next poll', async () => {
    const harness = createHarness([library(1)])
    harness.setBusy(true)
    harness.scheduler.start()
    await harness.timers.runNext(AUTOMATIC_SCAN_STARTUP_DELAY_MS)
    assert.deepEqual(harness.calls, [])
    harness.setBusy(false)
    await harness.timers.runNext()
    assert.deepEqual(harness.calls, [[1, 'interval']])
    harness.scheduler.stop()
  })

  it('isolates one library failure and continues the serial due queue', async () => {
    const harness = createHarness([library(1), library(2)], async (libraryId) => {
      if (libraryId === 1) throw new Error('first library failed')
      return result(libraryId)
    })

    harness.scheduler.start()
    await harness.timers.runNext(AUTOMATIC_SCAN_STARTUP_DELAY_MS)

    assert.deepEqual(harness.calls, [
      [1, 'startup'],
      [2, 'startup']
    ])
    assert.ok(harness.timers.tasks.some((task) => task.delay === 60_000))
    harness.scheduler.stop()
  })

  it('keeps startup, resume, and every due library globally serial', async () => {
    const firstBlocked = deferred()
    const firstStarted = deferred()
    let activeRuns = 0
    let maximumActiveRuns = 0
    const harness = createHarness([library(1), library(2)], async (libraryId) => {
      activeRuns += 1
      maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns)
      if (libraryId === 1) {
        firstStarted.resolve()
        await firstBlocked.promise
      }
      activeRuns -= 1
      return result(libraryId)
    })

    harness.scheduler.start()
    const startupRun = harness.timers.runNext(AUTOMATIC_SCAN_STARTUP_DELAY_MS)
    await firstStarted.promise
    harness.scheduler.handleResume()
    await harness.timers.runNext(AUTOMATIC_SCAN_RESUME_DELAY_MS)
    assert.deepEqual(harness.calls, [[1, 'startup']])

    firstBlocked.resolve()
    await startupRun
    assert.deepEqual(harness.calls, [
      [1, 'startup'],
      [2, 'startup']
    ])
    assert.equal(maximumActiveRuns, 1)
    harness.scheduler.stop()
  })

  it('uses the resume delay and clears all scheduled work on stop', async () => {
    const harness = createHarness([library(1)])
    harness.scheduler.start()
    harness.scheduler.handleResume()
    assert.ok(
      harness.timers.tasks.some((task) => task.delay === AUTOMATIC_SCAN_RESUME_DELAY_MS)
    )
    await harness.timers.runNext(AUTOMATIC_SCAN_RESUME_DELAY_MS)
    assert.deepEqual(harness.calls, [[1, 'resume']])
    harness.scheduler.stop()
    assert.deepEqual(harness.timers.tasks, [])
  })
})
