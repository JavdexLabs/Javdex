import type { CatalogImageRef } from '@shared/protocol/uploads'
import type { ManageOperationInput } from '@shared/manage/inputs'
import { getVideoById, markScrapeFailed } from '@library/db/videoRepo'
import { videoMaintenanceService, type VideoMaintenanceService } from './videoMaintenanceService'
import { videoEditInputFromManageFields } from './videoEditFields'
import { applyVideoCoverRef, commitManageImageMutation } from './catalogImageApply'
import { commitCatalogMutation } from './catalogOperations'
import { assertExpectedVideoVersion, readVideoAggregateVersion } from './catalogAggregateVersion'
import type { CatalogWriteContext } from './catalogOperations'

type EditInput = {
  videoId: number
  fields: Parameters<typeof videoEditInputFromManageFields>[0] & {
    cover?: CatalogImageRef
    coverSourcePath?: string
  }
}

/** Synchronous authoritative video writes, shared by both hosts. */
export function createCatalogVideoCommands(videos: VideoMaintenanceService = videoMaintenanceService) {
  function write<I extends { videoId: number }>(operation: string, work: (input: I) => boolean) {
    return (input: I, context: CatalogWriteContext, legacyLocal = false) => commitCatalogMutation(
      { ...context, operation, input },
      () => {
        // Some existing desktop IPCs have no version argument. Keep that local-only
        // behavior, while still rejecting any supplied stale version.
        if (!legacyLocal || context.expectedVersions.V) {
          assertExpectedVideoVersion(input.videoId, context.expectedVersions, context.operationId, context.database)
        }
        const ok = work(input)
        return { ok, videoId: input.videoId, versions: { V: readVideoAggregateVersion(input.videoId, context.database)! } }
      },
      context.database
    )
  }
  return {
    edit(input: EditInput, context: CatalogWriteContext) {
      return commitManageImageMutation({ ...context, operation: 'videos.edit', input }, () => {
        assertExpectedVideoVersion(input.videoId, context.expectedVersions, context.operationId, context.database)
        if (input.fields.cover) applyVideoCoverRef(input.videoId, input.fields.cover, context.expectedVersions, context.operationId, context.database, { bumpRevision: false })
        const fields = videoEditInputFromManageFields(input.fields)
        if ('coverSourcePath' in input.fields) fields.coverSourcePath = input.fields.coverSourcePath
        const ok = videos.edit(input.videoId, fields)
        return { ok, videoId: input.videoId, versions: { V: readVideoAggregateVersion(input.videoId, context.database)! } }
      }, context.database)
    },
    setRating: write('videos.setRating', (input: ManageOperationInput<'videos.setRating'>) => videos.setRating(input.videoId, input.rating)),
    clearMeta: write('videos.clearMeta', (input: ManageOperationInput<'videos.clearMeta'>) => videos.clearMetadata(input.videoId)),
    markScrapeSuccess: write('videos.markScrapeSuccess', (input: ManageOperationInput<'videos.markScrapeSuccess'>) => videos.markScrapeSucceeded(input.videoId)),
    markScrapeFailed: write('videos.markScrapeFailed', (input: ManageOperationInput<'videos.markScrapeFailed'>) => {
      if (!getVideoById(input.videoId)) throw new Error('影片不存在')
      markScrapeFailed(input.videoId)
      return true
    }),
    deleteSample: write('videos.deleteSample', (input: ManageOperationInput<'videos.deleteSample'>) => videos.deleteSample(input.videoId, input.assetId)),
    addManualTag: write('videos.addManualTag', (input: ManageOperationInput<'videos.addManualTag'>) => videos.addManualTag(input.videoId, input.name)),
    addExistingManualTag: write('videos.addExistingManualTag', (input: ManageOperationInput<'videos.addExistingManualTag'>) => videos.addExistingManualTag(input.videoId, input.tagId)),
    removeManualTag: write('videos.removeManualTag', (input: ManageOperationInput<'videos.removeManualTag'>) => videos.removeManualTag(input.videoId, input.tagId))
  }
}

export const catalogVideoCommands = createCatalogVideoCommands()
