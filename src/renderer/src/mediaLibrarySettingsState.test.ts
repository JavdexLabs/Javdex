import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { MediaLibraryDetail } from '@shared/mediaLibraryTypes'
import {
  buildMediaLibraryConfigPatch,
  buildCreateMediaLibraryInput,
  createMediaLibraryDraft,
  buildMediaLibraryIdentityPatch,
  canRunMediaLibraryScan,
  configDraftFromLibrary,
  identityDraftFromLibrary,
  mediaLibraryLifecycleCapabilities,
  mediaLibraryRootAddFailureMessage,
  mediaLibrarySettingsLoadState,
  rootRemovalRequiresCleanup
} from './mediaLibrarySettingsState'

const library: MediaLibraryDetail = {
  id: 2,
  name: '本地影片',
  icon: 'hard-drive',
  color: 'blue',
  position: 1,
  status: 'active',
  isDefault: false,
  revision: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: {
    libraryId: 2,
    autoScanEnabled: false,
    autoScanIntervalMinutes: 60,
    minImportDurationMinutes: 0,
    autoMergeSameCodeResources: false,
    removeResourceLessMemberships: false,
    defaultVideoScraper: null,
    defaultSortBy: 'release_date',
    defaultSortDir: 'desc',
    includeInHomeDiscovery: true,
    revision: 4
  },
  roots: [],
  rootCount: 0,
  activeRootCount: 0,
  pendingRemovalRootCount: 0,
  pendingCleanupJobCount: 0,
  pendingScanGroupCount: 0,
  disabledRootCount: 0,
  archivedRootCount: 0
}

describe('media-library settings state', () => {
  it('builds a trimmed create command, deduplicates roots and still allows an empty library', () => {
    const empty = createMediaLibraryDraft()
    empty.name = '  新媒体库  '
    assert.deepEqual(buildCreateMediaLibraryInput(empty).roots, [])

    empty.roots = ['/media/a', ' /media/a ', '/media/b']
    empty.config.defaultVideoScraper = ' example '
    assert.deepEqual(buildCreateMediaLibraryInput(empty), {
      name: '新媒体库',
      icon: 'library',
      color: 'slate',
      config: { ...empty.config, defaultVideoScraper: 'example' },
      roots: [
        { path: '/media/a', state: 'active' },
        { path: '/media/b', state: 'active' }
      ]
    })
  })

  it('builds minimal identity and section-scoped config patches', () => {
    const identity = identityDraftFromLibrary(library)
    assert.equal(buildMediaLibraryIdentityPatch(library, identity), null)
    assert.deepEqual(
      buildMediaLibraryIdentityPatch(library, {
        ...identity,
        name: '  NAS  ',
        color: 'green',
        position: 4
      }),
      { name: 'NAS', color: 'green', position: 4 }
    )
    assert.throws(
      () => buildMediaLibraryIdentityPatch(library, { ...identity, position: -1 }),
      /非负整数/
    )

    const draft = configDraftFromLibrary(library.config)
    draft.autoScanEnabled = true
    draft.defaultSortBy = 'rating'
    assert.deepEqual(
      buildMediaLibraryConfigPatch(library.config, draft, [
        'autoScanEnabled',
        'autoScanIntervalMinutes'
      ]),
      { autoScanEnabled: true }
    )
  })

  it('normalizes an empty scraper and validates numeric scan boundaries', () => {
    const draft = { ...configDraftFromLibrary(library.config), defaultVideoScraper: '   ' }
    assert.equal(buildMediaLibraryConfigPatch(library.config, draft)?.defaultVideoScraper, undefined)

    assert.throws(
      () => buildMediaLibraryConfigPatch(library.config, { ...draft, autoScanIntervalMinutes: 4 }),
      /5 到 10080/
    )
  })

  it('gates destructive lifecycle commands', () => {
    assert.deepEqual(mediaLibraryLifecycleCapabilities(library), {
      canArchive: true,
      canRestore: false,
      canDelete: false
    })
    assert.deepEqual(
      mediaLibraryLifecycleCapabilities({ ...library, status: 'archived' }),
      { canArchive: false, canRestore: true, canDelete: true }
    )
    assert.deepEqual(
      mediaLibraryLifecycleCapabilities({ ...library, isDefault: true }),
      { canArchive: false, canRestore: false, canDelete: false }
    )
  })

  it('allows cleanup-only scans but rejects a library with no work', () => {
    assert.equal(canRunMediaLibraryScan(library), false)
    assert.equal(
      canRunMediaLibraryScan({
        ...library,
        pendingCleanupJobCount: 1
      }),
      true
    )
    assert.equal(canRunMediaLibraryScan({ ...library, activeRootCount: 1 }), true)
    assert.equal(
      canRunMediaLibraryScan({
        ...library,
        status: 'archived',
        pendingCleanupJobCount: 1
      }),
      false
    )
  })

  it('routes every root-owned record through cleanup before direct deletion', () => {
    const empty = {
      localResourceCount: 0,
      strmResourceCount: 0,
      pendingScanResourceCount: 0,
      unrecognizedFileCount: 0,
      terminalCleanupJobCount: 0
    }
    assert.equal(rootRemovalRequiresCleanup(empty), false)
    assert.equal(rootRemovalRequiresCleanup({ ...empty, localResourceCount: 1 }), true)
    assert.equal(rootRemovalRequiresCleanup({ ...empty, pendingScanResourceCount: 1 }), true)
    assert.equal(rootRemovalRequiresCleanup({ ...empty, unrecognizedFileCount: 1 }), true)
    assert.equal(rootRemovalRequiresCleanup({ ...empty, terminalCleanupJobCount: 1 }), false)
  })

  it('reports partial root additions explicitly', () => {
    assert.equal(mediaLibraryRootAddFailureMessage(0, '路径冲突'), '路径冲突')
    assert.equal(
      mediaLibraryRootAddFailureMessage(2, '路径冲突'),
      '已添加 2 个来源目录，其余目录添加失败：路径冲突'
    )
  })

  it('shows a terminal query error even before form drafts exist', () => {
    assert.equal(
      mediaLibrarySettingsLoadState({
        isLoading: false,
        isError: true,
        hasLibrary: false,
        hasDrafts: false
      }),
      'error'
    )
    assert.equal(
      mediaLibrarySettingsLoadState({
        isLoading: false,
        isError: false,
        hasLibrary: true,
        hasDrafts: false
      }),
      'loading'
    )
  })
})
