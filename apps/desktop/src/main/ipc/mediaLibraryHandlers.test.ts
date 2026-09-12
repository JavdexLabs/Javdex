import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IpcMainInvokeEvent } from 'electron'
import type {
  MediaLibraryConfig,
  MediaLibraryDeletePreview,
  MediaLibraryDetail,
  MediaLibraryRoot,
  MediaLibraryRootMigrationPreview,
  MediaLibraryRootMigrationResult,
  MediaLibrarySummary
} from '@shared/mediaLibraryTypes'
import type { GlobalSearchResult, HomeSnapshot } from '@shared/catalogTypes'
import { IPC, type IpcChannel } from '@shared/ipc-channels'
import { DEFAULT_MEDIA_LIBRARY_CONFIG } from '@shared/mediaLibraryTypes'
import { MediaLibraryRepoError } from '@library/db/mediaLibraryRepo'
import { createMediaLibraryCommandAdapter } from './mediaLibraryContractAdapter'
import { registerMediaLibraryHandlers } from './mediaLibraryHandlers'
import { mediaLibraryIpcSchemas } from './mediaLibraryIpcSchemas'
import { createUnconfiguredRemoteBackend } from '../backends/remote/unconfiguredRemoteBackend'
import type { CatalogBackend } from '../application/catalogBackend'
import type { MigrateMediaLibraryRootInput } from '@shared/mediaLibraryTypes'

const detail = { id: 3, name: '电影' } as MediaLibraryDetail
const config = { libraryId: 3, revision: 2 } as MediaLibraryConfig
const root = { id: 8, libraryId: 3, path: '/media' } as MediaLibraryRoot
const summary = { id: 3, name: '电影' } as MediaLibrarySummary
const deletePreview = {
  libraryId: 3,
  name: '电影',
  revision: 4,
  impactRevision: 'b'.repeat(64),
  status: 'archived',
  rootCount: 1,
  membershipCount: 12,
  resourceCount: 14,
  exclusiveVideoCount: 8,
  pendingScanGroupCount: 2,
  pendingScanResourceCount: 3,
  scanRunCount: 9,
  activeScanRunCount: 0,
  unrecognizedFileCount: 1,
  cleanupJobCount: 2,
  activeCleanupJobCount: 0
} satisfies MediaLibraryDeletePreview
const homeSnapshot: HomeSnapshot = {
  seed: 'session-1',
  recent: [],
  discovery: [],
  libraries: []
}
const searchResult: GlobalSearchResult = { items: [], total: 0 }
const rootMigrationPreview = {
  sourceLibraryId: 3,
  sourceLibraryName: '电影',
  sourceRevision: 2,
  targetLibraryId: 4,
  targetLibraryName: 'NAS',
  targetRevision: 5,
  impactRevision: 'a'.repeat(64),
  rootId: 8,
  rootPath: '/media',
  rootState: 'active',
  resourceCount: 4,
  videoCount: 3,
  targetMembershipsToCreate: 2,
  sourceMembershipsBecomingResourceLess: 2,
  pendingScanGroupCount: 1,
  pendingScanResourceCount: 1,
  targetPendingGroupsToMerge: 0,
  unrecognizedFileCount: 1,
  sourcePrimaryResourcesToPromote: 1,
  sourceFilesPreserved: true
} satisfies MediaLibraryRootMigrationPreview
const rootMigrationResult = {
  sourceLibraryId: 3,
  targetLibraryId: 4,
  previousRootId: 8,
  targetRoot: { ...root, id: 9, libraryId: 4 },
  movedResourceCount: 4,
  createdMembershipCount: 2,
  movedPendingScanResourceCount: 1,
  movedUnrecognizedFileCount: 1,
  promotedSourceResourceIds: [10],
  sourceFilesPreserved: true
} satisfies MediaLibraryRootMigrationResult

interface MediaLibraryHandlerTestDependencies {
  list: (input?: { includeArchived?: boolean }) => MediaLibrarySummary[]
  get: (libraryId: number) => MediaLibraryDetail
  create: (input: { name: string }) => MediaLibraryDetail
  update: (input: { libraryId: number; expectedRevision: number }) => MediaLibraryDetail
  updateConfig: (input: { libraryId: number; expectedRevision: number }) => MediaLibraryConfig
  addRoot: (input: { libraryId: number; root: { path: string } }) => MediaLibraryRoot
  updateRoot: (input: { libraryId: number; rootId: number }) => MediaLibraryRoot
  removeRoot: (input: { libraryId: number; rootId: number }) => MediaLibraryRoot
  cancelRootRemoval: (input: {
    libraryId: number
    rootId: number
    expectedRevision: number
  }) => MediaLibraryRoot
  previewRootMigration: (input: {
    sourceLibraryId: number
    targetLibraryId: number
    rootId: number
  }) => MediaLibraryRootMigrationPreview
  migrateRoot: (input: MigrateMediaLibraryRootInput) => MediaLibraryRootMigrationResult
  archive: (input: { libraryId: number; expectedRevision: number }) => MediaLibraryDetail
  restore: (input: { libraryId: number; expectedRevision: number }) => MediaLibraryDetail
  previewRemoval: (libraryId: number) => MediaLibraryDeletePreview
  remove: (input: {
    libraryId: number
    expectedRevision: number
    expectedImpactRevision: string
  }) => MediaLibraryDetail
  loadHome: (input: { seed: string }) => HomeSnapshot
  search: (input: { search?: string }) => GlobalSearchResult
}

function backendFromDeps(deps: MediaLibraryHandlerTestDependencies): CatalogBackend {
  const backend = createUnconfiguredRemoteBackend()
  Object.assign(backend.queries, {
    homeLoad: async (input: { seed: string }) => deps.loadHome(input),
    homeSearch: async (input: { search?: string }) => deps.search(input)
  })
  Object.assign(backend.libraries, {
    list: async (input?: { includeArchived?: boolean }) => deps.list(input),
    get: async (input: { libraryId: number }) => deps.get(input.libraryId),
    create: async (input: { name: string }) => deps.create(input),
    update: async (input: { libraryId: number; expectedRevision: number }) => deps.update(input),
    updateConfig: async (input: { libraryId: number; expectedRevision: number }) =>
      deps.updateConfig(input),
    addRoot: async (input: { libraryId: number; root: { path: string } }) => deps.addRoot(input),
    updateRoot: async (input: { libraryId: number; rootId: number }) => deps.updateRoot(input),
    removeRoot: async (input: { libraryId: number; rootId: number }) => deps.removeRoot(input),
    cancelRootRemoval: async (input: {
      libraryId: number
      rootId: number
      expectedRevision: number
    }) => deps.cancelRootRemoval(input),
    archive: async (input: { libraryId: number; expectedRevision: number }) => deps.archive(input),
    restore: async (input: { libraryId: number; expectedRevision: number }) => deps.restore(input),
    deletePreview: async (input: { libraryId: number }) => deps.previewRemoval(input.libraryId),
    delete: async (input: {
      libraryId: number
      expectedRevision: number
      expectedImpactRevision: string
    }) => deps.remove(input)
  })
  return backend
}

function createDependencies(calls: string[]): MediaLibraryHandlerTestDependencies {
  return {
    list: (input) => {
      calls.push(`list:${String(input?.includeArchived ?? false)}`)
      return [summary]
    },
    get: (libraryId) => {
      calls.push(`get:${libraryId}`)
      return detail
    },
    create: (input) => {
      calls.push(`create:${input.name}`)
      return detail
    },
    update: (input) => {
      calls.push(`update:${input.libraryId}:${input.expectedRevision}`)
      return detail
    },
    updateConfig: (input) => {
      calls.push(`config:${input.libraryId}:${input.expectedRevision}`)
      return config
    },
    addRoot: (input) => {
      calls.push(`add-root:${input.libraryId}:${input.root.path}`)
      return root
    },
    updateRoot: (input) => {
      calls.push(`update-root:${input.libraryId}:${input.rootId}`)
      return root
    },
    removeRoot: (input) => {
      calls.push(`remove-root:${input.libraryId}:${input.rootId}`)
      return root
    },
    cancelRootRemoval: (input) => {
      calls.push(`cancel-root-removal:${input.libraryId}:${input.rootId}:${input.expectedRevision}`)
      return root
    },
    previewRootMigration: (input) => {
      calls.push(
        `preview-root-migration:${input.sourceLibraryId}:${input.targetLibraryId}:${input.rootId}`
      )
      return rootMigrationPreview
    },
    migrateRoot: (input) => {
      calls.push(
        `migrate-root:${input.sourceLibraryId}:${input.targetLibraryId}:${input.rootId}:${input.expectedSourceRevision}:${input.expectedTargetRevision}`
      )
      return rootMigrationResult
    },
    archive: (input) => {
      calls.push(`archive:${input.libraryId}:${input.expectedRevision}`)
      return detail
    },
    restore: (input) => {
      calls.push(`restore:${input.libraryId}:${input.expectedRevision}`)
      return detail
    },
    previewRemoval: (libraryId) => {
      calls.push(`preview-removal:${libraryId}`)
      return deletePreview
    },
    remove: (input) => {
      calls.push(
        `remove:${input.libraryId}:${input.expectedRevision}:${input.expectedImpactRevision}`
      )
      return detail
    },
    loadHome: (input) => {
      calls.push(`home:${input.seed}`)
      return homeSnapshot
    },
    search: (input) => {
      calls.push(`search:${input.search ?? ''}`)
      return searchResult
    }
  }
}

describe('media-library IPC schemas', () => {
  it('accepts the complete default config sent by the create wizard, including local NFO import', () => {
    for (const autoImportLocalNfo of [true, false]) {
      const input = {
        name: '下载临时', roots: [],
        config: { ...DEFAULT_MEDIA_LIBRARY_CONFIG, autoImportLocalNfo }
      }
      assert.deepEqual(mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_CREATE].parse([input]), [input])
    }
  })

  it('accepts boolean local NFO settings on update and rejects malformed values on both paths', () => {
    for (const autoImportLocalNfo of [true, false]) {
      const input = { libraryId: 3, expectedRevision: 2, patch: { autoImportLocalNfo } }
      assert.deepEqual(mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_CONFIG_UPDATE].parse([input]), [input])
    }
    for (const autoImportLocalNfo of ['true', 1, null]) {
      assert.equal(mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_CREATE].safeParse([
        { name: '下载临时', config: { autoImportLocalNfo } }
      ]).success, false)
      assert.equal(mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_CONFIG_UPDATE].safeParse([
        { libraryId: 3, expectedRevision: 2, patch: { autoImportLocalNfo } }
      ]).success, false)
    }
  })

  it('accepts exact management commands and rejects loose object shapes', () => {
    assert.equal(mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_LIST].safeParse([]).success, true)
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_LIST].safeParse([
        { includeArchived: true }
      ]).success,
      true
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_CREATE].safeParse([
        {
          name: '电影',
          icon: 'film',
          color: 'blue',
          config: {
            autoScanEnabled: true,
            autoScanIntervalMinutes: 60,
            defaultSortBy: 'release_date',
            defaultSortDir: 'desc'
          },
          roots: [{ path: '/media/movies', state: 'active' }]
        }
      ]).success,
      true
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_CREATE].safeParse([
        { name: '电影', config: { defaultCoverMode: 'cover' } }
      ]).success,
      false
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_CREATE].safeParse([
        { name: '电影', icon: 'untrusted', extra: true }
      ]).success,
      false
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_UPDATE].safeParse([
        { libraryId: 3, expectedRevision: 2, patch: {} }
      ]).success,
      false
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_ROOT_ADD].safeParse([
        {
          libraryId: 3,
          expectedRevision: 2,
          root: { path: '/media/movies', state: 'archived' }
        }
      ]).success,
      false
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_ROOT_ADD].safeParse([
        {
          libraryId: 3,
          expectedRevision: 2,
          root: { path: '/media/movies', state: 'pending_removal' }
        }
      ]).success,
      false
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_ROOT_UPDATE].safeParse([
        {
          libraryId: 3,
          rootId: 8,
          expectedRevision: 2,
          patch: { state: 'pending_removal' }
        }
      ]).success,
      false
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_ROOT_MIGRATE_PREVIEW].safeParse([
        { sourceLibraryId: 3, targetLibraryId: 4, rootId: 8 }
      ]).success,
      true
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_ROOT_REMOVE].safeParse([
        {
          libraryId: 3,
          rootId: 8,
          expectedRevision: 2,
          expectedImpactRevision: 'c'.repeat(64)
        }
      ]).success,
      true
    )
    for (const input of [
      { libraryId: 3, rootId: 8, expectedRevision: 2 },
      {
        libraryId: 3,
        rootId: 8,
        expectedRevision: 2,
        expectedImpactRevision: 'invalid'
      }
    ]) {
      assert.equal(
        mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_ROOT_REMOVE].safeParse([input]).success,
        false
      )
    }
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_ROOT_MIGRATE].safeParse([
        {
          sourceLibraryId: 3,
          targetLibraryId: 4,
          rootId: 8,
          expectedSourceRevision: 2,
          expectedTargetRevision: 5,
          expectedImpactRevision: 'a'.repeat(64)
        }
      ]).success,
      true
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_ROOT_MIGRATE].safeParse([
        {
          sourceLibraryId: 3,
          targetLibraryId: 4,
          rootId: 8,
          expectedSourceRevision: 0,
          expectedTargetRevision: 5,
          expectedImpactRevision: 'a'.repeat(64),
          injected: true
        }
      ]).success,
      false
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_ROOT_REMOVE_CANCEL].safeParse([
        { libraryId: 3, rootId: 8, expectedRevision: 2 }
      ]).success,
      true
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_ROOT_REMOVE_CANCEL].safeParse([
        { libraryId: 3, rootId: 8, expectedRevision: 0 }
      ]).success,
      false
    )
  })

  it('rejects invalid ids and revisions on every optimistic command shape', () => {
    for (const libraryId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(
        mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_GET].safeParse([libraryId]).success,
        false
      )
      assert.equal(
        mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_DELETE_PREVIEW].safeParse([
          { libraryId }
        ]).success,
        false
      )
    }
    for (const channel of [
      IPC.MEDIA_LIBRARY_ARCHIVE,
      IPC.MEDIA_LIBRARY_RESTORE,
      IPC.MEDIA_LIBRARY_DELETE
    ] as const) {
      assert.equal(
        mediaLibraryIpcSchemas[channel].safeParse([
          { libraryId: 3, expectedRevision: 0 }
        ]).success,
        false
      )
      assert.equal(
        mediaLibraryIpcSchemas[channel].safeParse([
          { libraryId: 3, expectedRevision: 2, unexpected: true }
        ]).success,
        false
      )
    }
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_DELETE_PREVIEW].safeParse([
        { libraryId: 3 }
      ]).success,
      true
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_DELETE_PREVIEW].safeParse([
        { libraryId: 3, expectedRevision: 2 }
      ]).success,
      false
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_DELETE].safeParse([
        {
          libraryId: 3,
          expectedRevision: 2,
          expectedImpactRevision: 'a'.repeat(64)
        }
      ]).success,
      true
    )
    for (const input of [
      { libraryId: 3, expectedRevision: 2 },
      { libraryId: 3, expectedRevision: 2, expectedImpactRevision: 'not-a-digest' },
      {
        libraryId: 3,
        expectedRevision: 2,
        expectedImpactRevision: 'a'.repeat(64),
        unexpected: true
      }
    ]) {
      assert.equal(
        mediaLibraryIpcSchemas[IPC.MEDIA_LIBRARY_DELETE].safeParse([input]).success,
        false
      )
    }
  })

  it('strictly validates home discovery and global-search inputs', () => {
    assert.equal(
      mediaLibraryIpcSchemas[IPC.HOME_LOAD].safeParse([
        { seed: 'session-1', recentLimit: 12, discoveryLimit: 12, libraryIds: [3, 7] }
      ]).success,
      true
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.HOME_LOAD].safeParse([
        { seed: '', libraryIds: [3, 3] }
      ]).success,
      false
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.HOME_SEARCH].safeParse([
        {
          search: 'ABC',
          libraryIds: [3, 7],
          resourceKinds: ['local', 'web'],
          sortBy: 'release_date',
          sortDir: 'desc',
          limit: 50,
          offset: 0
        }
      ]).success,
      true
    )
    assert.equal(
      mediaLibraryIpcSchemas[IPC.HOME_SEARCH].safeParse([
        { search: 'ABC', libraryIds: [0], sortBy: 'unknown', rawSql: 'SELECT 1' }
      ]).success,
      false
    )
  })
})

function registerTestHandlers(
  deps: MediaLibraryHandlerTestDependencies,
  adapter: ReturnType<typeof createMediaLibraryCommandAdapter>
): void {
  registerMediaLibraryHandlers(
    backendFromDeps(deps),
    {
      previewRootMigration: deps.previewRootMigration,
      migrateRoot: deps.migrateRoot
    },
    adapter
  )
}

describe('media-library IPC handlers', () => {
  it('registers the complete contract and forwards validated arguments', async () => {
    const registrations = new Map<
      string,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>
    >()
    const adapter = createMediaLibraryCommandAdapter((channel, handler) => {
      registrations.set(channel, handler)
    })
    const calls: string[] = []
    registerTestHandlers(createDependencies(calls), adapter)

    assert.deepEqual(
      [...registrations.keys()].sort(),
      Object.keys(mediaLibraryIpcSchemas).sort()
    )

    const event = {} as IpcMainInvokeEvent
    assert.deepEqual(
      await registrations.get(IPC.MEDIA_LIBRARY_LIST)?.(event, { includeArchived: true }),
      [summary]
    )
    assert.equal(await registrations.get(IPC.MEDIA_LIBRARY_GET)?.(event, 3), detail)
    assert.equal(
      await registrations.get(IPC.MEDIA_LIBRARY_CREATE)?.(event, { name: '电影' }),
      detail
    )
    assert.equal(
      await registrations.get(IPC.MEDIA_LIBRARY_DELETE_PREVIEW)?.(event, {
        libraryId: 3
      }),
      deletePreview
    )
    assert.equal(
      await registrations.get(IPC.MEDIA_LIBRARY_DELETE)?.(event, {
        libraryId: 3,
        expectedRevision: 4,
        expectedImpactRevision: 'b'.repeat(64)
      }),
      detail
    )
    assert.equal(
      await registrations.get(IPC.MEDIA_LIBRARY_ROOT_REMOVE)?.(event, {
        libraryId: 3,
        rootId: 8,
        expectedRevision: 2,
        expectedImpactRevision: 'c'.repeat(64)
      }),
      root
    )
    assert.equal(
      await registrations.get(IPC.MEDIA_LIBRARY_ROOT_REMOVE_CANCEL)?.(event, {
        libraryId: 3,
        rootId: 8,
        expectedRevision: 3
      }),
      root
    )
    assert.equal(
      await registrations.get(IPC.MEDIA_LIBRARY_ROOT_MIGRATE_PREVIEW)?.(event, {
        sourceLibraryId: 3,
        targetLibraryId: 4,
        rootId: 8
      }),
      rootMigrationPreview
    )
    assert.equal(
      await registrations.get(IPC.MEDIA_LIBRARY_ROOT_MIGRATE)?.(event, {
        sourceLibraryId: 3,
        targetLibraryId: 4,
        rootId: 8,
        expectedSourceRevision: 2,
        expectedTargetRevision: 5,
        expectedImpactRevision: 'a'.repeat(64)
      }),
      rootMigrationResult
    )
    assert.equal(
      await registrations.get(IPC.HOME_LOAD)?.(event, { seed: 'session-1' }),
      homeSnapshot
    )
    assert.equal(
      await registrations.get(IPC.HOME_SEARCH)?.(event, { search: 'ABC' }),
      searchResult
    )
    assert.deepEqual(calls, [
      'list:true',
      'get:3',
      'create:电影',
      'preview-removal:3',
      `remove:3:4:${'b'.repeat(64)}`,
      'remove-root:3:8',
      'cancel-root-removal:3:8:3',
      'preview-root-migration:3:4:8',
      'migrate-root:3:4:8:2:5',
      'home:session-1',
      'search:ABC'
    ])
  })

  it('rejects malformed calls before a dependency is invoked', () => {
    const registrations = new Map<
      IpcChannel,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>
    >()
    const adapter = createMediaLibraryCommandAdapter((channel, handler) => {
      registrations.set(channel, handler)
    })
    const calls: string[] = []
    registerTestHandlers(createDependencies(calls), adapter)

    assert.throws(
      () => registrations.get(IPC.MEDIA_LIBRARY_GET)?.({} as IpcMainInvokeEvent, 0),
      /无效的 IPC 请求参数/
    )
    assert.throws(
      () =>
        registrations
          .get(IPC.MEDIA_LIBRARY_CREATE)
          ?.({} as IpcMainInvokeEvent, { name: '电影', injected: true }),
      /无效的 IPC 请求参数/
    )
    assert.deepEqual(calls, [])
  })

  it('preserves root continuity domain errors across validated IPC handlers', () => {
    const registrations = new Map<
      IpcChannel,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>
    >()
    const adapter = createMediaLibraryCommandAdapter((channel, handler) => {
      registrations.set(channel, handler)
    })
    const calls: string[] = []
    const continuityError = new MediaLibraryRepoError(
      'VALIDATION_FAILED',
      '根目录缺少可验证的原物理身份。'
    )
    const deps = {
      ...createDependencies(calls),
      updateRoot: () => {
        throw continuityError
      },
      restore: () => {
        throw continuityError
      }
    }
    registerTestHandlers(deps, adapter)

    const event = {} as IpcMainInvokeEvent
    assert.throws(
      () =>
        registrations.get(IPC.MEDIA_LIBRARY_ROOT_UPDATE)?.(event, {
          libraryId: 3,
          rootId: 8,
          expectedRevision: 2,
          patch: { state: 'active' }
        }),
      (error) => error === continuityError
    )
    assert.throws(
      () =>
        registrations.get(IPC.MEDIA_LIBRARY_RESTORE)?.(event, {
          libraryId: 3,
          expectedRevision: 2
        }),
      (error) => error === continuityError
    )
  })
})
