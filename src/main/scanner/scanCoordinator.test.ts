import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ScanResult } from '@shared/libraryTypes'
import type { VideoResource } from '@shared/videoTypes'
import { MaintenanceTaskGate } from '../services/maintenanceTaskGate'
import { createScanCoordinator } from './scanCoordinator'

function emptyScanResult(): ScanResult {
  return {
    scannedFiles: 0,
    imported: 0,
    skipped: 0,
    skippedShort: 0,
    failed: 0,
    relocated: 0,
    removed: 0,
    promoted: 0,
    offlineFolders: [],
    newCodes: [],
    unrecognizedFiles: []
  }
}

function resource(input: Partial<VideoResource> & Pick<VideoResource, 'id' | 'video_id' | 'kind' | 'locator'>): VideoResource {
  return {
    resource_key: `${input.kind}:${input.locator}`,
    size_bytes: null,
    duration_seconds: null,
    file_mtime_ms: null,
    display_name: null,
    is_primary: 0,
    add_time: '2026-01-01T00:00:00.000Z',
    ...input
  }
}

describe('ScanCoordinator', () => {
  it('preserves offline roots and removes only missing local resources under accessible roots', async () => {
    const offlineLocal = resource({
      id: 1,
      video_id: 1,
      kind: 'local',
      locator: '/offline/A-001.mp4',
      is_primary: 1
    })
    const onlineLocal = resource({
      id: 2,
      video_id: 2,
      kind: 'local',
      locator: '/online/B-001.mp4',
      is_primary: 1
    })
    const protectedLink = resource({
      id: 3,
      video_id: 2,
      kind: 'web',
      locator: 'https://example.test/watch/2'
    })
    const resources = new Map<number, VideoResource>([
      [1, offlineLocal],
      [2, onlineLocal],
      [3, protectedLink]
    ])
    const removed: number[] = []
    const promoted: number[] = []
    const scannedRoots: string[][] = []
    const coordinator = createScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online', '/offline'],
      inspectFolder: async (folder) => folder === '/online',
      scanFolders: async (folders, _progress, options) => {
        scannedRoots.push(folders)
        assert.ok(options?.signal)
        return emptyScanResult()
      },
      listLocalResources: () => [
        { video_id: 1, file_id: 1, file_path: offlineLocal.locator },
        { video_id: 2, file_id: 2, file_path: onlineLocal.locator }
      ],
      getResourceById: (id) => resources.get(id) ?? null,
      listResources: (videoId) =>
        [...resources.values()].filter((item) => item.video_id === videoId),
      removeResourceRecord: (id) => {
        removed.push(id)
        resources.delete(id)
      },
      setPrimaryResource: (_videoId, id) => promoted.push(id),
      pathExists: () => false
    })

    const result = await coordinator.run({ trigger: 'manual' })

    assert.deepEqual(scannedRoots, [['/online']])
    assert.deepEqual(result.offlineFolders, ['/offline'])
    assert.deepEqual(removed, [2])
    assert.deepEqual(promoted, [3])
    assert.equal(result.removed, 1)
    assert.equal(result.promoted, 1)
    assert.equal(resources.has(1), true)
    assert.equal(resources.has(3), true)
  })

  it('does not run cleanup after cancellation and releases the mutual-exclusion lease', async () => {
    const gate = new MaintenanceTaskGate()
    let cleanupReads = 0
    let scanningStarted: (() => void) | null = null
    const started = new Promise<void>((resolve) => {
      scanningStarted = resolve
    })
    const coordinator = createScanCoordinator({
      gate,
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async (_folders, _progress, options) => {
        scanningStarted?.()
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener('abort', () => resolve(), { once: true })
        )
        return { ...emptyScanResult(), cancelled: true }
      },
      listLocalResources: () => {
        cleanupReads += 1
        return []
      }
    })

    const running = coordinator.run()
    await started
    assert.equal(coordinator.cancel(), true)
    assert.equal((await running).cancelled, true)
    assert.equal(cleanupReads, 0)
    assert.equal(gate.active, null)
  })

  it('keeps resources after a coordinator-level failure', async () => {
    let cleanupReads = 0
    const coordinator = createScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async () => {
        throw new Error('adapter failed')
      },
      listLocalResources: () => {
        cleanupReads += 1
        return []
      }
    })

    await assert.rejects(() => coordinator.run(), /adapter failed/)
    assert.equal(cleanupReads, 0)
  })

  it('rejects duplicate scans and scans blocked by resource maintenance', async () => {
    const gate = new MaintenanceTaskGate()
    const resourceLease = gate.tryAcquire('resource-maintenance')
    assert.ok(resourceLease)
    const coordinator = createScanCoordinator({
      gate,
      getConfiguredFolders: () => ['/online']
    })

    await assert.rejects(() => coordinator.run(), /正在运行/)
    resourceLease.release()

    let releaseScan!: () => void
    const pendingScan = new Promise<void>((resolve) => {
      releaseScan = resolve
    })
    const coordinatorWithPendingScan = createScanCoordinator({
      gate,
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async () => {
        await pendingScan
        return emptyScanResult()
      },
      listLocalResources: () => []
    })
    const first = coordinatorWithPendingScan.run()
    await new Promise((resolve) => setImmediate(resolve))
    await assert.rejects(() => coordinatorWithPendingScan.run(), /正在运行/)
    assert.throws(
      () => gate.runSync('resource-maintenance', () => true),
      /正在运行/
    )
    releaseScan()
    await first
  })
})
