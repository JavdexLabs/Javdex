import type { CatalogImageRef } from '@shared/protocol/uploads'
import type { ManageOperationInput } from '@shared/manage/inputs'
import { METADATA_TRANSLATION_FIELDS, type ApplyMetadataTranslation, type ApplyMetadataTranslationResult, type MetadataTranslationField, type MetadataTranslationOutcome, type TranslationTarget } from '@shared/metadataTranslation'
import { getDb } from '@library/db/database'
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

export function listTranslationTargets(input: ManageOperationInput<'videos.translationTargets'>, database = getDb()): TranslationTarget[] {
  if (!input.videoIds.length) return []
  const textColumns = input.includeText ? ', v.title, v.summary' : ''
  return database.prepare(`SELECT v.id, v.generation, v.code${textColumns} FROM videos v
    JOIN library_video_memberships m ON m.video_id = v.id AND m.is_hidden = 0
    JOIN media_libraries l ON l.id = m.library_id AND l.status = 'active'
    WHERE m.library_id = ? AND v.id IN (${input.videoIds.map(() => '?').join(',')})`)
    .all(input.libraryId, ...input.videoIds) as TranslationTarget[]
}

function applyTranslation(input: ApplyMetadataTranslation, context: CatalogWriteContext) {
  const database = context.database ?? getDb()
  return commitCatalogMutation({ ...context, operation: 'videos.applyTranslation', input }, () => {
    const video = database.prepare('SELECT generation, revision, title, summary FROM videos WHERE id = ?')
      .get(input.videoId) as { generation: number; revision: number; title: string | null; summary: string | null } | undefined
    const member = video && database.prepare(`SELECT 1 FROM library_video_memberships m
      JOIN media_libraries l ON l.id = m.library_id AND l.status = 'active'
      WHERE m.library_id = ? AND m.video_id = ? AND m.is_hidden = 0`).get(input.libraryId, input.videoId)
    const locked = member && database.prepare('SELECT 1 FROM pending_video_scrapes WHERE video_id = ?').get(input.videoId)
    const fields: ApplyMetadataTranslationResult['fields'] = {}
    const patch: Record<MetadataTranslationField, string | null> = { title: null, summary: null }
    for (const field of METADATA_TRANSLATION_FIELDS) {
      const value = input.fields[field]
      if (!value) continue
      let outcome: MetadataTranslationOutcome
      if (!video || video.generation !== input.generation) outcome = 'missing'
      else if (!member) outcome = 'out-of-scope'
      else if (locked) outcome = 'locked'
      else if (video[field] !== value.original) outcome = 'conflict'
      else {
        outcome = 'applied'
        if (video[field] !== value.translation) patch[field] = value.translation
      }
      fields[field] = outcome
    }
    if (patch.title !== null || patch.summary !== null) {
      database.prepare(`UPDATE videos SET title = COALESCE(@title, title), summary = COALESCE(@summary, summary),
        updated_at = @updatedAt, revision = revision + 1 WHERE id = @videoId`)
        .run({ ...patch, updatedAt: new Date().toISOString(), videoId: input.videoId })
    }
    return { fields, versions: video && { V: readVideoAggregateVersion(input.videoId, database)! } }
  }, database)
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
    applyTranslation,
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
