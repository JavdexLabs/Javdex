import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type {
  LibraryScanAudit,
  LibraryScanEvent,
  LibraryScanSummary,
  PendingScanGroup,
  ScanProgress,
  ScanResult
} from '@shared/libraryTypes'
import type { Video, VideoResource } from '@shared/videoTypes'
import { DEFAULT_MEDIA_LIBRARY_CONFIG } from '@shared/mediaLibraryTypes'
import { MaintenanceTaskGate } from '../services/maintenanceTaskGate'
import { createScanCoordinator } from './scanCoordinator'
import type { ScanOptions, ScanProgressFn } from './scanner'

interface LegacyCoordinatorDependencies {
  gate?: MaintenanceTaskGate
  getConfiguredFolders?: () => string[]
  inspectFolder?: (folder: string) => Promise<boolean>
  authorizeRoot?: (folder: string) => void
  scanFolders?: (
    folders: string[],
    onProgress?: ScanProgressFn,
    options?: ScanOptions & { unavailableRoots?: string[] }
  ) => Promise<ScanResult>
  listLocalResources?: () => Array<{ video_id: number; resource_id: number; locator: string }>
  getResourceById?: (resourceId: number) => VideoResource | null
  getVideoById?: (videoId: number) => Video | null
  listResources?: (videoId: number) => VideoResource[]
  removeResourceRecord?: (resourceId: number) => void
  setPrimaryResource?: (videoId: number, resourceId: number) => void
  inspectPath?: (filePath: string) => 'present' | 'missing' | 'unknown'
  reconcilePendingScanResources?: (
    roots: string[],
    inspectPath: (filePath: string) => 'present' | 'missing' | 'unknown'
  ) => { removedResources: number; removedGroups: number }
  recoverPendingPathCleanups?: () => { recovered: number; waiting: number }
  getPendingPathCleanupRoots?: () => string[]
  applyPendingPathCleanups?: (roots: string[]) => {
    removed: number
    promoted: number
    consumedRoots: string[]
  }
  clearPendingPathCleanups?: (roots: string[]) => void
  runCleanupTransaction?: <T>(operation: () => T) => T
  getMinImportDurationMinutes?: () => number
  getAutoMergeSameCodeResources?: () => boolean
  shouldAutoDeleteResourceLessVideos?: () => boolean
  deleteResourceLessVideos?: () => number
  listResourceLessVideos?: () => Array<Pick<Video, 'id' | 'code' | 'title'>>
  listPendingScanGroups?: () => PendingScanGroup[]
  recordScanSummary?: (
    summary: LibraryScanSummary,
    unrecognizedFiles: string[] | undefined,
    audit: LibraryScanAudit
  ) => void
  now?: () => string
  initiallyOfflineIdentity?: boolean
  bindRootIdentities?: () => void
}

interface TestScanCoordinatorRequest {
  libraryId?: number
  folders?: string[]
  trigger?: LibraryScanSummary['trigger']
  onProgress?: (progress: ScanProgress) => void
}

type TestCoordinator = Omit<ReturnType<typeof createScanCoordinator>, 'run'> & {
  run: (request?: TestScanCoordinatorRequest) => Promise<ScanResult>
}

function createTestScanCoordinator(
  dependencies: LegacyCoordinatorDependencies
): TestCoordinator {
  let rootsBound = !dependencies.initiallyOfflineIdentity
  const configuredFolders = (): string[] => dependencies.getConfiguredFolders?.() ?? ['/online']
  const roots = () =>
    configuredFolders().map((rootPath, index) => ({
      id: index + 1,
      libraryId: 1,
      path: rootPath,
      normalizedPath: rootPath,
      realPath: rootsBound ? rootPath : null,
      normalizedRealPath: rootsBound ? rootPath : null,
      deviceId: rootsBound ? `device-${index + 1}` : null,
      inode: rootsBound ? `inode-${index + 1}` : null,
      position: index,
      state: 'active' as const,
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z'
    }))
  const rootPathById = (rootId: number): string | undefined =>
    roots().find((root) => root.id === rootId)?.path
  const legacyScanFolders = dependencies.scanFolders ?? (async () => emptyScanResult())
  const coordinator = createScanCoordinator({
    readScanSnapshot: () => ({
      libraryId: 1,
      libraryRevision: rootsBound ? 2 : 1,
      configRevision: 7,
      capturedAt: '2026-08-10T00:00:00.000Z',
      config: {
        libraryId: 1,
        revision: 7,
        ...DEFAULT_MEDIA_LIBRARY_CONFIG,
        minImportDurationMinutes: dependencies.getMinImportDurationMinutes?.() ?? 0,
        autoMergeSameCodeResources: dependencies.getAutoMergeSameCodeResources?.() ?? false,
        removeResourceLessMemberships: Boolean(
          dependencies.shouldAutoDeleteResourceLessVideos?.()
        )
      },
      roots: roots()
    }),
    bindRootIdentities: ({ rootIds }) => {
      dependencies.bindRootIdentities?.()
      rootsBound = true
      return { boundRootIds: [...rootIds], revision: 2 }
    },
    inspectRoot: async (root) => dependencies.inspectFolder?.(root.path) ?? true,
    authorizeRoot: (_libraryId, rootId, expectedRoot) => {
      const root = expectedRoot ?? roots().find((candidate) => candidate.id === rootId)
      assert.ok(root)
      dependencies.authorizeRoot?.(root.path)
      return root
    },
    authorizeRootFile: (_libraryId, rootId, _filePath, expectedRoot) => {
      const root = expectedRoot ?? roots().find((candidate) => candidate.id === rootId)
      assert.ok(root)
      return root
    },
    authorizeRootDeletionTarget: (_libraryId, rootId, _filePath, expectedRoot) => {
      const root = expectedRoot ?? roots().find((candidate) => candidate.id === rootId)
      assert.ok(root)
      return root
    },
    scanFolders: async (request, onProgress, options) => ({
      ...(await legacyScanFolders(
        request.roots.map((root) => root.path),
        onProgress,
        {
          ...options,
          unavailableRoots: (options?.unavailableRootIds ?? []).flatMap((rootId) => {
            const rootPath = rootPathById(rootId)
            return rootPath ? [rootPath] : []
          })
        }
      )),
      libraryId: request.libraryId,
      runId: request.runId
    }),
    listLocalResources: () =>
      (dependencies.listLocalResources?.() ?? []).map((resource) => ({
        library_id: 1,
        ...resource
      })),
    getResourceById: (_libraryId, resourceId) =>
      dependencies.getResourceById?.(resourceId) ?? null,
    getVideoById: (videoId) => dependencies.getVideoById?.(videoId) ?? null,
    listResources: (_libraryId, videoId) => dependencies.listResources?.(videoId) ?? [],
    removeResourceRecord: (_libraryId, resourceId) =>
      dependencies.removeResourceRecord?.(resourceId),
    setPrimaryResource: (_libraryId, videoId, resourceId) =>
      dependencies.setPrimaryResource?.(videoId, resourceId),
    inspectPath: dependencies.inspectPath ?? (() => 'present'),
    runCleanupTransaction: (operation) => operation(),
    reconcilePendingScanResources: (_libraryId, rootIds, inspectPath) =>
      dependencies.reconcilePendingScanResources?.(
        rootIds.flatMap((rootId: number) => {
          const rootPath = rootPathById(rootId)
          return rootPath ? [rootPath] : []
        }),
        inspectPath
      ) ?? { removedResources: 0, removedGroups: 0 },
    recoverPendingPathCleanups: () =>
      dependencies.recoverPendingPathCleanups?.() ?? { recovered: 0, waiting: 0 },
    listPendingPathCleanups: () =>
      (dependencies.getPendingPathCleanupRoots?.() ?? []).map(
        (rootPath: string, index: number) => ({
          jobId: rootPath,
          libraryId: 1,
          rootId: 10_000 + index
        })
      ),
    applyPendingPathCleanups: (cleanups) => {
      const legacyRoots = cleanups.map((cleanup) => cleanup.jobId)
      const result = dependencies.applyPendingPathCleanups?.(legacyRoots) ?? {
        removed: 0,
        promoted: 0,
        consumedRoots: legacyRoots
      }
      return { ...result, consumedRoots: cleanups }
    },
    removeResourceLessMemberships: () => {
      if (!dependencies.shouldAutoDeleteResourceLessVideos?.()) return []
      const candidates = dependencies.listResourceLessVideos?.() ?? []
      const removed = dependencies.deleteResourceLessVideos?.() ?? 0
      return Array.from({ length: removed }, (_, index) => {
        const video = candidates[index]
        return {
          videoId: video?.id ?? index + 1,
          videoCode: video?.code ?? `REMOVED-${index + 1}`,
          videoTitle: video?.title ?? null
        }
      })
    },
    listPendingScanGroups: () => dependencies.listPendingScanGroups?.() ?? [],
    beginRun: () => undefined,
    finishRun: (input) =>
      dependencies.recordScanSummary?.(
        input.summary,
        input.replaceUnrecognizedRootIds ? input.unrecognizedFiles?.map((file) => file.filePath) ?? [] : undefined,
        input.audit
      ),
    now: dependencies.now ?? (() => '2026-08-10T00:00:00.000Z'),
    createRunId: () => 'test-run',
    gate: dependencies.gate ?? new MaintenanceTaskGate(),
    ...(dependencies.runCleanupTransaction
      ? { runCleanupTransaction: dependencies.runCleanupTransaction }
      : {})
  })
  const scopedRun = coordinator.run.bind(coordinator)
  coordinator.run = ((request: TestScanCoordinatorRequest = {}) => {
    const requestedFolders = request.folders
    const rootIds = requestedFolders?.map((folder) => {
      const root = roots().find((candidate) => candidate.path === folder)
      if (!root) throw new Error('测试根目录不存在')
      return root.id
    })
    return scopedRun({
      libraryId: request.libraryId ?? 1,
      ...(rootIds ? { rootIds } : {}),
      ...(request.trigger ? { trigger: request.trigger } : {}),
      ...(request.onProgress ? { onProgress: request.onProgress } : {})
    })
  }) as typeof coordinator.run
  return coordinator as TestCoordinator
}

function emptyScanResult(): ScanResult {
  return {
    libraryId: 1,
    runId: 'test-run',
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
    unrecognizedFiles: [],
    strmFailures: [],
    omittedStrmFailures: 0
  }
}

function resource(input: Partial<VideoResource> & Pick<VideoResource, 'id' | 'video_id' | 'kind' | 'locator'>): VideoResource {
  return {
    library_id: 1,
    root_id: input.locator.startsWith('/offline/') ? 2 : 1,
    resource_key: `${input.kind}:${input.locator}`,
    source_identity:
      input.kind === 'local' || input.strm_source_path
        ? `${input.kind}:${input.strm_source_path ?? input.locator}`
        : null,
    strm_source_path: null,
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
  it('binds an offline-created root identity and refreshes the frozen snapshot before scanning', async () => {
    let bindings = 0
    let scanned = 0
    const coordinator = createTestScanCoordinator({
      initiallyOfflineIdentity: true,
      bindRootIdentities: () => {
        bindings += 1
      },
      inspectFolder: async () => true,
      scanFolders: async (folders) => {
        scanned += 1
        assert.deepEqual(folders, ['/online'])
        return emptyScanResult()
      }
    })

    await coordinator.run()

    assert.equal(bindings, 1)
    assert.equal(scanned, 1)
  })

  it('persists matching complete audit details with the latest summary', async () => {
    const persisted: LibraryScanAudit[] = []
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async (_folders, _onProgress, options) => {
        options?.onFileResult?.({
          rootId: 1,
          filePath: '/online/AUDIT-001.mp4',
          sourceKind: 'local',
          outcome: 'unrecognized'
        })
        return {
          ...emptyScanResult(),
          scannedFiles: 1,
          failed: 1,
          unrecognizedFiles: ['/online/AUDIT-001.mp4']
        }
      },
      listLocalResources: () => [],
      recordScanSummary: (_summary, _unrecognized, audit) => {
        persisted.push(audit)
      }
    })

    await coordinator.run()

    assert.equal(persisted.length, 1)
    assert.equal(persisted[0].files.length, 1)
    assert.equal(persisted[0].status, 'success')
  })

  it('publishes scan lifecycle events for every trigger', async () => {
    const events: LibraryScanEvent[] = []
    const progress = { scanned: 1, imported: 1, currentFile: '/online/A-001.mp4' }
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async (_folders, onProgress) => {
        onProgress?.(progress)
        return { ...emptyScanResult(), scannedFiles: 1, imported: 1 }
      },
      listLocalResources: () => []
    })
    const unsubscribe = coordinator.subscribe((event) => events.push(event))

    const result = await coordinator.run({ trigger: 'startup' })
    unsubscribe()

    assert.deepEqual(events.slice(0, 2), [
      { phase: 'started', libraryId: 1, runId: 'test-run', trigger: 'startup' },
      {
        phase: 'progress',
        libraryId: 1,
        runId: 'test-run',
        trigger: 'startup',
        progress
      }
    ])
    assert.deepEqual(events[2], {
      phase: 'completed',
      libraryId: 1,
      runId: 'test-run',
      trigger: 'startup',
      result
    })
  })

  it('uses one frozen configuration snapshot for the complete run', async () => {
    let minImportDurationMinutes = 30
    let autoMergeSameCodeResources = true
    const coordinator = createTestScanCoordinator({
      getConfiguredFolders: () => ['/online'],
      getMinImportDurationMinutes: () => minImportDurationMinutes,
      getAutoMergeSameCodeResources: () => autoMergeSameCodeResources,
      inspectFolder: async () => {
        minImportDurationMinutes = 90
        autoMergeSameCodeResources = false
        return true
      },
      scanFolders: async (_folders, _progress, options) => {
        assert.equal(options?.minImportDurationSeconds, 30 * 60)
        assert.equal(options?.autoMergeSameCodeResources, true)
        return emptyScanResult()
      }
    })

    await coordinator.run()
  })

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
    const summaries: LibraryScanSummary[] = []
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online', '/offline'],
      inspectFolder: async (folder) => folder === '/online',
      scanFolders: async (folders, _progress, options) => {
        scannedRoots.push(folders)
        assert.ok(options?.signal)
        assert.deepEqual(options?.unavailableRoots, ['/offline'])
        return emptyScanResult()
      },
      listLocalResources: () => [
        { video_id: 1, resource_id: 1, locator: offlineLocal.locator },
        { video_id: 2, resource_id: 2, locator: onlineLocal.locator }
      ],
      getResourceById: (id) => resources.get(id) ?? null,
      listResources: (videoId) =>
        [...resources.values()].filter((item) => item.video_id === videoId),
      removeResourceRecord: (id) => {
        removed.push(id)
        resources.delete(id)
      },
      setPrimaryResource: (_videoId, id) => promoted.push(id),
      inspectPath: () => 'missing',
      shouldAutoDeleteResourceLessVideos: () => true,
      deleteResourceLessVideos: () => {
        throw new Error('offline scans must not auto-delete videos')
      },
      recordScanSummary: (summary) => summaries.push(summary)
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
    assert.equal(summaries[0].status, 'success')
    assert.deepEqual(summaries[0].offlineFolders, ['/offline'])
  })

  it('aborts cleanup when a local path cannot be audited', async () => {
    const local = resource({
      id: 1,
      video_id: 1,
      kind: 'local',
      locator: '/online/LOCKED-001.mp4',
      is_primary: 1
    })
    const removed: number[] = []
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async () => emptyScanResult(),
      listLocalResources: () => [
        { video_id: 1, resource_id: 1, locator: local.locator }
      ],
      getResourceById: () => local,
      listResources: () => [local],
      removeResourceRecord: (id) => removed.push(id),
      inspectPath: () => 'unknown'
    })

    await assert.rejects(() => coordinator.run(), /无法确认本地资源是否存在/)
    assert.deepEqual(removed, [])
  })

  it('treats a root that becomes unreadable after traversal as offline', async () => {
    let inspections = 0
    let cleanupReads = 0
    let autoDeleteRuns = 0
    const reconciledRoots: string[][] = []
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => {
        inspections += 1
        return inspections === 1
      },
      scanFolders: async () => emptyScanResult(),
      reconcilePendingScanResources: (roots) => {
        reconciledRoots.push([...roots])
        return { removedResources: 0, removedGroups: 0 }
      },
      listLocalResources: () => {
        cleanupReads += 1
        return [{ video_id: 1, resource_id: 1, locator: '/online/A-001.mp4' }]
      },
      shouldAutoDeleteResourceLessVideos: () => true,
      deleteResourceLessVideos: () => {
        autoDeleteRuns += 1
        return 0
      }
    })

    const result = await coordinator.run()

    assert.deepEqual(result.offlineFolders, ['/online'])
    assert.equal(cleanupReads, 1)
    assert.equal(result.removed, 0)
    assert.equal(autoDeleteRuns, 0)
    assert.deepEqual(reconciledRoots, [[]])
  })

  it('rechecks the frozen root identity immediately before cleanup writes', async () => {
    let scanFinished = false
    let cleanupReads = 0
    let reconcileRuns = 0
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async () => {
        scanFinished = true
        return emptyScanResult()
      },
      authorizeRoot: () => {
        if (scanFinished) throw new Error('root identity changed')
      },
      reconcilePendingScanResources: () => {
        reconcileRuns += 1
        return { removedResources: 0, removedGroups: 0 }
      },
      listLocalResources: () => {
        cleanupReads += 1
        return []
      }
    })

    await assert.rejects(() => coordinator.run(), /root identity changed/)
    assert.equal(reconcileRuns, 0)
    assert.equal(cleanupReads, 0)
  })

  it('does not run cleanup after cancellation and releases the mutual-exclusion lease', async () => {
    const gate = new MaintenanceTaskGate()
    let cleanupReads = 0
    let scanningStarted: (() => void) | null = null
    const started = new Promise<void>((resolve) => {
      scanningStarted = resolve
    })
    const summaries: LibraryScanSummary[] = []
    const snapshots: Array<string[] | undefined> = []
    const coordinator = createTestScanCoordinator({
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
      },
      shouldAutoDeleteResourceLessVideos: () => true,
      deleteResourceLessVideos: () => {
        throw new Error('cancelled scans must not auto-delete videos')
      },
      recordScanSummary: (summary, unrecognizedFiles) => {
        summaries.push(summary)
        snapshots.push(unrecognizedFiles)
      }
    })

    const running = coordinator.run()
    await started
    assert.equal(coordinator.activeRunId, 'test-run')
    assert.equal(coordinator.cancel('another-run'), false)
    assert.equal(coordinator.cancel('test-run'), true)
    assert.equal((await running).cancelled, true)
    assert.equal(cleanupReads, 0)
    assert.equal(gate.active, null)
    assert.equal(summaries[0].status, 'cancelled')
    assert.deepEqual(snapshots, [undefined])
  })

  it('keeps resources after a coordinator-level failure', async () => {
    let cleanupReads = 0
    let deferredCleanupRuns = 0
    const events: LibraryScanEvent[] = []
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async () => {
        throw new Error('adapter failed')
      },
      listLocalResources: () => {
        cleanupReads += 1
        return []
      },
      getPendingPathCleanupRoots: () => ['/removed'],
      applyPendingPathCleanups: () => {
        deferredCleanupRuns += 1
        return { removed: 0, promoted: 0, consumedRoots: [] }
      }
    })
    coordinator.subscribe((event) => events.push(event))

    await assert.rejects(() => coordinator.run(), /adapter failed/)
    assert.equal(cleanupReads, 0)
    assert.equal(deferredCleanupRuns, 0)
    assert.deepEqual(events, [
      { phase: 'started', libraryId: 1, runId: 'test-run', trigger: 'manual' },
      {
        phase: 'failed',
        libraryId: 1,
        runId: 'test-run',
        trigger: 'manual',
        error: 'adapter failed'
      }
    ])
  })

  it('skips every destructive cleanup after a file processing failure', async () => {
    let missingCleanupReads = 0
    let deferredCleanupRuns = 0
    let autoDeleteRuns = 0
    const summaries: LibraryScanSummary[] = []
    const snapshots: Array<string[] | undefined> = []
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async () => ({ ...emptyScanResult(), failed: 1 }),
      listLocalResources: () => {
        missingCleanupReads += 1
        return []
      },
      getPendingPathCleanupRoots: () => ['/removed'],
      applyPendingPathCleanups: () => {
        deferredCleanupRuns += 1
        return { removed: 1, promoted: 0, consumedRoots: ['/removed'] }
      },
      shouldAutoDeleteResourceLessVideos: () => true,
      deleteResourceLessVideos: () => {
        autoDeleteRuns += 1
        return 1
      },
      recordScanSummary: (summary, unrecognizedFiles) => {
        summaries.push(summary)
        snapshots.push(unrecognizedFiles)
      }
    })

    const result = await coordinator.run()

    assert.equal(result.failed, 1)
    assert.equal(result.removed, 0)
    assert.equal(result.deletedVideos, 0)
    assert.equal(missingCleanupReads, 0)
    assert.equal(deferredCleanupRuns, 0)
    assert.equal(autoDeleteRuns, 0)
    assert.equal(summaries[0].status, 'failed')
    assert.deepEqual(snapshots, [undefined])
  })

  it('replaces the unrecognized-file snapshot after every safe completed scan', async () => {
    const pendingResults: ScanResult[] = [
      {
        ...emptyScanResult(),
        failed: 1,
        unrecognizedFiles: ['/online/UNKNOWN.mp4']
      },
      emptyScanResult()
    ]
    const snapshots: Array<string[] | undefined> = []
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async () => pendingResults.shift() ?? emptyScanResult(),
      listLocalResources: () => [],
      recordScanSummary: (_summary, unrecognizedFiles) => {
        snapshots.push(unrecognizedFiles)
      }
    })

    await coordinator.run()
    await coordinator.run()

    assert.deepEqual(snapshots, [['/online/UNKNOWN.mp4'], []])
  })

  it('completes safe cleanup with errors when failures are isolated to STRM files', async () => {
    const sourcePath = '/online/BAD-001.strm'
    const managed = resource({
      id: 9,
      video_id: 4,
      kind: 'direct',
      locator: 'https://example.test/last-good.mp4',
      strm_source_path: sourcePath,
      is_primary: 1
    })
    const removed: number[] = []
    const summaries: LibraryScanSummary[] = []
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async () => ({
        ...emptyScanResult(),
        failed: 1,
        strmFailures: [
          {
            sourcePath: '/online/INVALID-001.strm',
            code: 'multiple_targets',
            message: 'STRM 文件包含多个目标'
          }
        ]
      }),
      listLocalResources: () => [
        { video_id: 4, resource_id: managed.id, locator: sourcePath }
      ],
      getResourceById: () => managed,
      listResources: () => [managed],
      inspectPath: () => 'missing',
      removeResourceRecord: (id) => removed.push(id),
      recordScanSummary: (summary) => summaries.push(summary)
    })

    const result = await coordinator.run()

    assert.deepEqual(removed, [managed.id])
    assert.equal(result.removed, 1)
    assert.equal(summaries[0].status, 'completed_with_errors')
    assert.deepEqual(summaries[0].strmFailures, result.strmFailures)
    assert.equal(summaries[0].omittedStrmFailures, 0)
    assert.equal(summaries[0].errorSummary, null)
  })

  it('consumes deferred path cleanup only after a successful uncancelled scan', async () => {
    let deferredCleanupRuns = 0
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async () => emptyScanResult(),
      listLocalResources: () => [],
      getPendingPathCleanupRoots: () => ['/removed'],
      applyPendingPathCleanups: () => {
        deferredCleanupRuns += 1
        return { removed: 4, promoted: 2, consumedRoots: ['/removed'] }
      }
    })

    const result = await coordinator.run()

    assert.equal(deferredCleanupRuns, 1)
    assert.equal(result.removed, 4)
    assert.equal(result.promoted, 2)
  })

  it('keeps deferred path cleanup queued after a partial folder scan', async () => {
    let deferredCleanupRuns = 0
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/one', '/two'],
      inspectFolder: async () => true,
      scanFolders: async () => emptyScanResult(),
      listLocalResources: () => [],
      getPendingPathCleanupRoots: () => ['/removed'],
      applyPendingPathCleanups: () => {
        deferredCleanupRuns += 1
        return { removed: 1, promoted: 0, consumedRoots: ['/removed'] }
      },
      shouldAutoDeleteResourceLessVideos: () => true,
      deleteResourceLessVideos: () => {
        throw new Error('partial scans must not auto-delete videos')
      }
    })

    const result = await coordinator.run({ folders: ['/one'] })

    assert.equal(deferredCleanupRuns, 0)
    assert.equal(result.removed, 0)
  })

  it('allows a full cleanup-only scan after the final configured folder was removed', async () => {
    let scannedFolders: string[] | null = null
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => [],
      scanFolders: async (folders) => {
        scannedFolders = folders
        return emptyScanResult()
      },
      listLocalResources: () => [],
      getPendingPathCleanupRoots: () => ['/removed'],
      applyPendingPathCleanups: () => ({
        removed: 2,
        promoted: 0,
        consumedRoots: ['/removed']
      })
    })

    const result = await coordinator.run()

    assert.deepEqual(scannedFolders, [])
    assert.equal(result.removed, 2)
  })

  it('auto-deletes zero-resource videos after deferred cleanup on a safe full scan', async () => {
    const order: string[] = []
    const summaries: LibraryScanSummary[] = []
    const times = ['2026-08-10T01:00:00.000Z', '2026-08-10T01:00:03.000Z']
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async () => ({
        ...emptyScanResult(),
        imported: 2,
        relocated: 1,
        refreshed: 2
      }),
      listLocalResources: () => [],
      getPendingPathCleanupRoots: () => ['/removed'],
      applyPendingPathCleanups: () => {
        order.push('pending-cleanup')
        return { removed: 4, promoted: 1, consumedRoots: ['/removed'] }
      },
      shouldAutoDeleteResourceLessVideos: () => true,
      deleteResourceLessVideos: () => {
        order.push('delete-videos')
        return 3
      },
      recordScanSummary: (summary) => summaries.push(summary),
      now: () => times.shift() ?? 'unexpected'
    })

    const result = await coordinator.run({ trigger: 'manual' })

    assert.deepEqual(order, ['pending-cleanup', 'delete-videos'])
    assert.equal(result.deletedVideos, 3)
    assert.equal(result.removed, 4)
    assert.equal(result.promoted, 1)
    assert.deepEqual(summaries, [
      {
        libraryId: 1,
        runId: 'test-run',
        configRevision: 7,
        trigger: 'manual',
        startedAt: '2026-08-10T01:00:00.000Z',
        finishedAt: '2026-08-10T01:00:03.000Z',
        status: 'success',
        scannedFiles: 0,
        resourcesAdded: 2,
        resourcesUpdated: 3,
        resourcesRemoved: 4,
        primaryResourcesPromoted: 1,
        videosDeleted: 3,
        skippedFiles: 0,
        failedFiles: 0,
        pendingScanGroups: 0,
        pendingScanResources: 0,
        offlineFolders: [],
        errorSummary: null
      }
    ])
  })

  it('persists a sanitized failed summary without running destructive cleanup', async () => {
    const summaries: LibraryScanSummary[] = []
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async () => {
        throw new Error('adapter https://example.test/watch?token=secret failed')
      },
      shouldAutoDeleteResourceLessVideos: () => true,
      deleteResourceLessVideos: () => {
        throw new Error('failed scans must not auto-delete videos')
      },
      recordScanSummary: (summary) => summaries.push(summary)
    })

    await assert.rejects(() => coordinator.run(), /https:\/\/example\.test\/watch/)
    assert.equal(summaries.length, 1)
    assert.equal(summaries[0].status, 'failed')
    assert.equal(summaries[0].errorSummary?.includes('secret'), false)
  })

  it('rolls back resource cleanup and keeps pending roots when auto-delete fails', async () => {
    const state = { resourcePresent: true, pending: true }
    const summaries: LibraryScanSummary[] = []
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async () => emptyScanResult(),
      listLocalResources: () => [],
      getPendingPathCleanupRoots: () => (state.pending ? ['/removed'] : []),
      applyPendingPathCleanups: (roots) => {
        state.resourcePresent = false
        return { removed: 1, promoted: 0, consumedRoots: roots }
      },
      clearPendingPathCleanups: () => {
        state.pending = false
      },
      runCleanupTransaction: (operation) => {
        const snapshot = { ...state }
        try {
          return operation()
        } catch (error) {
          Object.assign(state, snapshot)
          throw error
        }
      },
      shouldAutoDeleteResourceLessVideos: () => true,
      deleteResourceLessVideos: () => {
        throw new Error('forced auto-delete failure')
      },
      recordScanSummary: (summary) => summaries.push(summary)
    })

    await assert.rejects(() => coordinator.run(), /forced auto-delete failure/)

    assert.equal(state.resourcePresent, true)
    assert.equal(state.pending, true)
    assert.equal(summaries.at(-1)?.status, 'failed')
    assert.equal(summaries.at(-1)?.resourcesRemoved, 0)
  })

  it('keeps pending roots when the cleanup transaction cannot commit', async () => {
    const state = { resourcePresent: true, pending: true }
    let clearRuns = 0
    const coordinator = createTestScanCoordinator({
      gate: new MaintenanceTaskGate(),
      getConfiguredFolders: () => ['/online'],
      inspectFolder: async () => true,
      scanFolders: async () => emptyScanResult(),
      listLocalResources: () => [],
      getPendingPathCleanupRoots: () => (state.pending ? ['/removed'] : []),
      applyPendingPathCleanups: (roots) => {
        state.resourcePresent = false
        return { removed: 1, promoted: 0, consumedRoots: roots }
      },
      clearPendingPathCleanups: () => {
        clearRuns += 1
        state.pending = false
      },
      runCleanupTransaction: (operation) => {
        const snapshot = { ...state }
        operation()
        Object.assign(state, snapshot)
        throw new Error('forced transaction commit failure')
      }
    })

    await assert.rejects(() => coordinator.run(), /forced transaction commit failure/)

    assert.equal(state.resourcePresent, true)
    assert.equal(state.pending, true)
    assert.equal(clearRuns, 0)
  })

  it('rejects duplicate scans and scans blocked by resource maintenance', async () => {
    const gate = new MaintenanceTaskGate()
    const resourceLease = gate.tryAcquire('resource-maintenance')
    assert.ok(resourceLease)
    const coordinator = createTestScanCoordinator({
      gate,
      getConfiguredFolders: () => ['/online']
    })

    await assert.rejects(() => coordinator.run(), /正在运行/)
    resourceLease.release()

    let releaseScan!: () => void
    const pendingScan = new Promise<void>((resolve) => {
      releaseScan = resolve
    })
    const coordinatorWithPendingScan = createTestScanCoordinator({
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
