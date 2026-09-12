import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type {
  MediaLibraryConfig,
  MediaLibraryDeletePreview,
  MediaLibraryDetail,
  MediaLibraryRootMigrationPreview,
  MediaLibraryRootMigrationResult
} from '@shared/mediaLibraryTypes'
import type { LibraryPathRemovalPreview } from '@shared/libraryTypes'
import { MediaLibraryRepoError } from '../db/mediaLibraryRepo'
import {
  createMediaLibraryService,
  type MediaLibraryServiceDependencies
} from './mediaLibraryService'
import { MaintenanceTaskGate } from './maintenanceTaskGate'

function createHarness(runnableNames: readonly string[] = ['Runnable']) {
  const calls = {
    create: [] as unknown[],
    update: [] as unknown[],
    updateConfig: [] as unknown[],
    rootMutations: [] as string[],
    runnable: [] as string[],
    migration: [] as unknown[],
    lifecycle: [] as string[],
    rootRemovalPreviews: [] as unknown[],
    maintenanceRuns: 0
  }
  const created = { id: 2 } as MediaLibraryDetail
  const config = { libraryId: 2, revision: 2 } as MediaLibraryConfig
  const preview = {
    sourceLibraryId: 2,
    targetLibraryId: 3,
    rootId: 11
  } as MediaLibraryRootMigrationPreview
  const result = {
    sourceLibraryId: 2,
    targetLibraryId: 3,
    previousRootId: 11
  } as MediaLibraryRootMigrationResult
  const rootRemovalPreview = {
    libraryId: 2,
    rootId: 11,
    libraryRevision: 3,
    impactRevision: 'b'.repeat(64)
  } as LibraryPathRemovalPreview
  const deletionPreview = { libraryId: 2 } as MediaLibraryDeletePreview
  const dependencies: MediaLibraryServiceDependencies = {
    create(input) {
      calls.create.push(input)
      return created
    },
    update(input) {
      calls.update.push(input)
      return created
    },
    updateConfig(input) {
      calls.updateConfig.push(input)
      return config
    },
    addRoot(input) {
      calls.rootMutations.push(`add:${input.libraryId}`)
      return { id: 11 } as never
    },
    updateRoot(input) {
      calls.rootMutations.push(`update:${input.rootId}`)
      return { id: input.rootId } as never
    },
    removeRoot(input) {
      calls.rootMutations.push(`remove:${input.rootId}`)
      return { id: input.rootId } as never
    },
    cancelRootRemoval(input) {
      calls.rootMutations.push(`cancel-remove:${input.rootId}`)
      return { id: input.rootId } as never
    },
    previewRootRemoval(input) {
      calls.rootRemovalPreviews.push(input)
      return rootRemovalPreview
    },
    previewRootMigration() {
      return preview
    },
    migrateRoot(input) {
      calls.migration.push(input)
      return result
    },
    archive(input) {
      calls.lifecycle.push(`archive:${input.libraryId}`)
      return created
    },
    restore(input) {
      calls.lifecycle.push(`restore:${input.libraryId}`)
      return created
    },
    previewRemoval(libraryId) {
      calls.lifecycle.push(`preview:${libraryId}`)
      return deletionPreview
    },
    remove(input) {
      calls.lifecycle.push(`remove:${input.libraryId}`)
      return created
    },
    isVideoScraperRunnable(name) {
      calls.runnable.push(name)
      return runnableNames.includes(name)
    },
    runResourceMaintenance(work) {
      calls.maintenanceRuns += 1
      return work()
    }
  }
  return {
    service: createMediaLibraryService(dependencies),
    dependencies,
    calls,
    created,
    config,
    preview,
    result,
    rootRemovalPreview,
    deletionPreview
  }
}

describe('media-library service', () => {
  it('validates an explicitly configured create-time video scraper before persistence', () => {
    const harness = createHarness()
    assert.equal(
      harness.service.create({
        name: 'Library',
        config: { defaultVideoScraper: '  Runnable  ' }
      }),
      harness.created
    )
    assert.deepEqual(harness.calls.runnable, ['Runnable'])
    assert.equal(harness.calls.create.length, 1)

    const invalid = createHarness([])
    assert.throws(
      () =>
        invalid.service.create({
          name: 'Library',
          config: { defaultVideoScraper: 'Missing' }
        }),
      (error: unknown) =>
        error instanceof MediaLibraryRepoError && error.code === 'VALIDATION_FAILED'
    )
    assert.equal(invalid.calls.create.length, 0)
  })

  it('allows unrelated config edits with a stale stored scraper but validates explicit changes', () => {
    const harness = createHarness([])
    assert.equal(
      harness.service.updateConfig({
        libraryId: 2,
        expectedRevision: 1,
        patch: { autoScanEnabled: true }
      }),
      harness.config
    )
    assert.deepEqual(harness.calls.runnable, [])
    assert.equal(harness.calls.updateConfig.length, 1)

    assert.throws(
      () =>
        harness.service.updateConfig({
          libraryId: 2,
          expectedRevision: 1,
          patch: { defaultVideoScraper: 'Missing' }
        }),
      (error: unknown) =>
        error instanceof MediaLibraryRepoError && error.code === 'VALIDATION_FAILED'
    )
    assert.equal(harness.calls.updateConfig.length, 1)

    harness.service.updateConfig({
      libraryId: 2,
      expectedRevision: 1,
      patch: { defaultVideoScraper: null }
    })
    assert.equal(harness.calls.updateConfig.length, 2)
  })

  it('runs the root-migration commit through the shared resource-maintenance gate', () => {
    const harness = createHarness()
    const input = {
      sourceLibraryId: 2,
      targetLibraryId: 3,
      rootId: 11,
      expectedSourceRevision: 7,
      expectedTargetRevision: 9,
      expectedImpactRevision: 'a'.repeat(64)
    }
    assert.equal(harness.service.migrateRoot(input), harness.result)
    assert.equal(harness.calls.maintenanceRuns, 1)
    assert.deepEqual(harness.calls.migration, [input])
    assert.equal(
      harness.service.previewRootMigration({
        sourceLibraryId: 2,
        targetLibraryId: 3,
        rootId: 11
      }),
      harness.preview
    )
    assert.equal(harness.calls.maintenanceRuns, 1, 'read-only previews do not take the write gate')
  })

  it('runs every root mutation through the scan-shared maintenance gate', () => {
    const harness = createHarness()
    harness.service.addRoot({ libraryId: 2, expectedRevision: 1, root: { path: '/media' } })
    harness.service.updateRoot({
      libraryId: 2,
      rootId: 11,
      expectedRevision: 2,
      patch: { state: 'disabled' }
    })
    harness.service.removeRoot({
      libraryId: 2,
      rootId: 11,
      expectedRevision: 3,
      expectedImpactRevision: harness.rootRemovalPreview.impactRevision
    })
    harness.service.cancelRootRemoval({
      libraryId: 2,
      rootId: 11,
      expectedRevision: 4
    })

    assert.deepEqual(harness.calls.rootMutations, [
      'add:2',
      'update:11',
      'remove:11',
      'cancel-remove:11'
    ])
    assert.equal(harness.calls.maintenanceRuns, 4)
    assert.deepEqual(harness.calls.rootRemovalPreviews, [{ libraryId: 2, rootId: 11 }])

    assert.throws(
      () =>
        harness.service.removeRoot({
          libraryId: 2,
          rootId: 11,
          expectedRevision: 3,
          expectedImpactRevision: 'c'.repeat(64)
        }),
      (error: unknown) =>
        error instanceof MediaLibraryRepoError && error.code === 'REVISION_CONFLICT'
    )
    assert.deepEqual(harness.calls.rootMutations, [
      'add:2',
      'update:11',
      'remove:11',
      'cancel-remove:11'
    ])
  })

  it('preserves root continuity validation errors through service mutation gates', () => {
    const harness = createHarness()
    const continuityError = new MediaLibraryRepoError(
      'VALIDATION_FAILED',
      '根目录缺少可验证的原物理身份。'
    )
    const service = createMediaLibraryService({
      ...harness.dependencies,
      updateRoot: () => {
        throw continuityError
      },
      restore: () => {
        throw continuityError
      }
    })

    assert.throws(
      () =>
        service.updateRoot({
          libraryId: 2,
          rootId: 11,
          expectedRevision: 3,
          patch: { state: 'active' }
        }),
      (error) => error === continuityError
    )
    assert.throws(
      () => service.restore({ libraryId: 2, expectedRevision: 4 }),
      (error) => error === continuityError
    )
    assert.equal(harness.calls.maintenanceRuns, 2)
  })

  it('serializes library and config lifecycle mutations with resource writes', () => {
    const harness = createHarness()
    harness.service.create({ name: 'Library' })
    harness.service.update({ libraryId: 2, expectedRevision: 1, patch: { name: 'Renamed' } })
    harness.service.updateConfig({
      libraryId: 2,
      expectedRevision: 1,
      patch: { autoScanEnabled: true }
    })
    harness.service.archive({ libraryId: 2, expectedRevision: 2 })
    harness.service.restore({ libraryId: 2, expectedRevision: 3 })
    assert.equal(harness.service.previewRemoval(2), harness.deletionPreview)
    harness.service.remove({
      libraryId: 2,
      expectedRevision: 4,
      expectedImpactRevision: 'a'.repeat(64)
    })

    assert.equal(harness.calls.maintenanceRuns, 6)
    assert.deepEqual(harness.calls.lifecycle, [
      'archive:2',
      'restore:2',
      'preview:2',
      'remove:2'
    ])
  })

  it('cannot archive through the service while an asynchronous resource write owns the gate', async () => {
    const harness = createHarness()
    const gate = new MaintenanceTaskGate()
    const service = createMediaLibraryService({
      ...harness.dependencies,
      runResourceMaintenance: (work) => gate.runSync('resource-maintenance', work)
    })
    let releaseWrite!: () => void
    const writeFinished = gate.run(
      'resource-maintenance',
      () => new Promise<void>((resolve) => {
        releaseWrite = resolve
      })
    )

    assert.throws(
      () => service.archive({ libraryId: 2, expectedRevision: 1 }),
      /已有扫描或资源维护任务正在运行/
    )
    assert.deepEqual(harness.calls.lifecycle, [])

    releaseWrite()
    await writeFinished
    service.archive({ libraryId: 2, expectedRevision: 1 })
    assert.deepEqual(harness.calls.lifecycle, ['archive:2'])
  })
})
