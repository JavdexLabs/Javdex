import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { VideoLifecycleImpact } from '@shared/videoLifecycleTypes'
import type { VideoResource } from '@shared/videoTypes'
import type {
  DeleteVideoGloballyRepoResult,
  VideoLifecycleRepo
} from '../db/videoLifecycleRepo'
import { createVideoLifecycleService } from './videoLifecycleService'

function impact(): VideoLifecycleImpact {
  return {
    kind: 'delete-globally',
    revision: 'revision-1',
    videoId: 91,
    sourceLibraryId: null,
    targetLibraryId: null,
    resourceIds: [911, 921],
    sourcePaths: ['/library/ML-091.mp4', '/library/ML-091.strm'],
    remainingLibraryIds: [],
    removesCanonicalVideo: true,
    playlistCount: 0,
    assetCount: 2,
    libraries: [],
    resources: [],
    playlists: [],
    mediaAssets: [],
    pendingScrapeCount: 1,
    pendingAgentDraftCount: 1,
    pendingStagingAssetCount: 2,
    sourceFilesPreserved: false
  }
}

function repoWithDelete(
  result: DeleteVideoGloballyRepoResult
): VideoLifecycleRepo {
  const unexpected = (): never => {
    throw new Error('unexpected lifecycle command')
  }
  return {
    previewRemoveFromLibrary: unexpected,
    removeFromLibrary: unexpected,
    previewMoveResource: unexpected,
    moveResource: unexpected,
    previewDeleteGlobally: () => impact(),
    deleteGlobally: () => result
  }
}

describe('video lifecycle service', () => {
  it('cleans app-owned and pending assets while never receiving source media paths', () => {
    const deletedAssets: string[] = []
    const cleanedStaging: string[][] = []
    const events: string[] = []
    const result: DeleteVideoGloballyRepoResult = {
      operationId: 'delete-91',
      kind: 'delete-globally',
      videoId: 91,
      sourceLibraryId: null,
      targetLibraryId: null,
      resourceIds: [911, 921],
      promotedResourceId: null,
      canonicalVideoDeleted: true,
      obsoleteAssetPaths: ['covers/ML-091.jpg', 'samples/ML-091-1.jpg'],
      pendingStagingPaths: ['video-scrape/pending/cover.jpg', 'video-scrape/agent/sample.jpg']
    }
    const repo = repoWithDelete(result)
    const service = createVideoLifecycleService({
      repo,
      withResourceMaintenance: (work) => {
        events.push('gate')
        return work()
      },
      runInCoordinatedChange: (work) => {
        events.push('assets')
        return work()
      },
      deleteOwnedAsset: (path) => deletedAssets.push(path),
      cleanupVideoScrapeStagingPaths: (paths) => cleanedStaging.push(paths),
      collectVideoLibraryCleanupHints: () => ({ actressIds: [7] }),
      runLibraryCleanup: (hints) => events.push(`cleanup:${hints.actressIds?.join(',')}`),
      listSourceResources: () => [],
      deleteManagedSourceFiles: (_resources, work) => work()
    })

    const publicResult = service.deleteGlobally({
      videoId: 91,
      operationId: 'delete-91',
      expectedRevision: 'revision-1'
    })

    assert.deepEqual(deletedAssets, ['covers/ML-091.jpg', 'samples/ML-091-1.jpg'])
    assert.deepEqual(cleanedStaging, [result.pendingStagingPaths])
    assert.equal(deletedAssets.includes('/library/ML-091.mp4'), false)
    assert.equal(deletedAssets.includes('/library/ML-091.strm'), false)
    assert.deepEqual(events, ['gate', 'assets', 'cleanup:7'])
    assert.equal('obsoleteAssetPaths' in publicResult, false)
    assert.equal('pendingStagingPaths' in publicResult, false)
  })

  it('retries cleanup safely when the repository replays an idempotent result', () => {
    let deleteCalls = 0
    let cleanupCalls = 0
    const result: DeleteVideoGloballyRepoResult = {
      operationId: 'delete-91',
      kind: 'delete-globally',
      videoId: 91,
      sourceLibraryId: null,
      targetLibraryId: null,
      resourceIds: [],
      promotedResourceId: null,
      canonicalVideoDeleted: true,
      obsoleteAssetPaths: ['covers/ML-091.jpg'],
      pendingStagingPaths: ['video-scrape/pending/cover.jpg']
    }
    const repo = repoWithDelete(result)
    const service = createVideoLifecycleService({
      repo,
      withResourceMaintenance: (work) => work(),
      runInCoordinatedChange: (work) => work(),
      deleteOwnedAsset: () => {
        deleteCalls += 1
      },
      cleanupVideoScrapeStagingPaths: () => {
        cleanupCalls += 1
      },
      collectVideoLibraryCleanupHints: () => ({}),
      runLibraryCleanup: () => {},
      listSourceResources: () => [],
      deleteManagedSourceFiles: (_resources, work) => work()
    })
    const input = {
      videoId: 91,
      operationId: 'delete-91',
      expectedRevision: 'revision-1'
    }

    assert.deepEqual(service.deleteGlobally(input), service.deleteGlobally(input))
    assert.equal(deleteCalls, 2)
    assert.equal(cleanupCalls, 2)
  })

  it('deletes managed source files before committing the global video record', () => {
    const events: string[] = []
    const seenPaths: string[][] = []
    const result: DeleteVideoGloballyRepoResult = {
      operationId: 'delete-91',
      kind: 'delete-globally',
      videoId: 91,
      sourceLibraryId: null,
      targetLibraryId: null,
      resourceIds: [911],
      promotedResourceId: null,
      canonicalVideoDeleted: true,
      obsoleteAssetPaths: ['covers/ML-091.jpg'],
      pendingStagingPaths: []
    }
    const service = createVideoLifecycleService({
      repo: repoWithDelete(result),
      withResourceMaintenance: (work) => work(),
      runInCoordinatedChange: (work) => work(),
      deleteOwnedAsset: () => events.push('asset'),
      cleanupVideoScrapeStagingPaths: () => events.push('staging'),
      collectVideoLibraryCleanupHints: () => ({}),
      runLibraryCleanup: () => events.push('cleanup'),
      listSourceResources: (): VideoResource[] => [
          {
            id: 911,
            library_id: 1,
            video_id: 91,
            root_id: 3,
            kind: 'local',
            locator: '/library/ML-091.mp4',
            resource_key: 'local:/library/ML-091.mp4',
            source_identity: null,
            strm_source_path: null,
            size_bytes: null,
            duration_seconds: null,
            file_mtime_ms: null,
            display_name: null,
            is_primary: 1,
            add_time: '2026-01-01'
          }
        ],
      deleteManagedSourceFiles: (resources, work) => {
        seenPaths.push(resources.map((resource) => resource.locator))
        events.push('source-files')
        return work()
      }
    })

    service.deleteGlobally({
      videoId: 91,
      operationId: 'delete-91',
      expectedRevision: 'revision-1'
    })

    assert.deepEqual(seenPaths, [['/library/ML-091.mp4']])
    assert.deepEqual(events, ['source-files', 'asset', 'staging', 'cleanup'])
  })
})
