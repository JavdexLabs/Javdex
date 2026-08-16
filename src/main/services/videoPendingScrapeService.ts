import fs from 'node:fs'
import type {
  PendingVideoScrape,
  PendingVideoScrapeConfirmInput,
  PendingVideoScrapeResolutionResult,
  ScrapeResult,
  ScrapedActress,
  VideoScrapeField
} from '@shared/videoScrapeTypes'
import { getDb } from '../db/database'
import {
  deletePendingVideoScrape,
  getPendingVideoScrapeResolutionSnapshot,
  listPendingVideoScrapes,
  type PendingVideoScrapeResolutionCandidate
} from '../db/pendingVideoScrapeRepo'
import {
  getVideoById,
  hasPendingVideoScrape,
  listVideoResources,
  markScrapeFailed,
  mergeVideoRecords
} from '../db/videoRepo'
import { mediaAssetStore } from './mediaAssetStore'
import {
  findVideoBusinessIdentityConflictForScrape,
  videoScrapeApplyService
} from './videoScrapeApplyService'
import { selectPrimaryVideoResourceCandidate } from './videoResourcePromotion'
import {
  mergeVideoScrapeResults,
  projectVideoScrapeResult
} from '../scrapers/videoScrapeFieldProjection'

function allStagedPaths(snapshot: NonNullable<ReturnType<typeof getPendingVideoScrapeResolutionSnapshot>>): string[] {
  return snapshot.sources.flatMap((source) =>
    source.candidates.flatMap((candidate) => candidate.resources.map((resource) => resource.stagedPath))
  )
}

/** Remove crash leftovers while preserving every referenced or recently written staging dir. */
export function cleanupOrphanedVideoScrapeStaging(options?: {
  now?: number
  olderThanMs?: number
}): number {
  const referencedPaths = (
    getDb().prepare('SELECT staged_path FROM pending_video_scrape_resources').all() as Array<{
      staged_path: string
    }>
  ).map((row) => row.staged_path)
  return mediaAssetStore.cleanupOrphanedVideoScrapeStaging(referencedPaths, options)
}

function selectedCandidate(
  source: NonNullable<ReturnType<typeof getPendingVideoScrapeResolutionSnapshot>>['sources'][number],
  selections: PendingVideoScrapeConfirmInput['selections']
): PendingVideoScrapeResolutionCandidate {
  const matches = selections.filter((selection) => selection.sourceId === source.id)
  if (matches.length !== 1) throw new Error('每个刮削来源必须且只能选择一个候选')
  const candidate = source.candidates.find((item) => item.id === matches[0].candidateId)
  if (!candidate) throw new Error('所选刮削候选不存在或不属于该来源')
  return candidate
}

function importCandidateResources(
  code: string,
  result: ScrapeResult,
  candidate: PendingVideoScrapeResolutionCandidate,
  fields: Set<VideoScrapeField>
): {
  coverPath: string | null
  samplePaths: Array<string | null>
  actressAvatars: Map<string, string | null>
  createdPaths: string[]
} {
  const createdPaths: string[] = []
  let coverPath: string | null = null
  let samplePaths: Array<string | null> = []
  const actressAvatars = new Map<string, string | null>()
  if (fields.has('cover')) {
    const cover = candidate.resources.find((resource) => resource.field === 'cover')
    if (cover) {
      coverPath = mediaAssetStore.importCover(code, mediaAssetStore.resolve(cover.stagedPath))
      createdPaths.push(coverPath)
    }
  }
  if (fields.has('samples') && result.sampleImageUrls?.length) {
    const resources = candidate.resources
      .filter((resource) => resource.field === 'samples')
      .sort((left, right) => left.position - right.position)
    if (resources.length === result.sampleImageUrls.length) {
      samplePaths = resources.map((resource) => {
        const imported = mediaAssetStore.importSample(code, mediaAssetStore.resolve(resource.stagedPath))
        createdPaths.push(imported)
        return imported
      })
    } else {
      samplePaths = result.sampleImageUrls.map(() => null)
    }
  }
  const wantsFemale = fields.has('actressesFemale')
  const wantsMale = fields.has('actressesMale')
  if (wantsFemale || wantsMale) {
    const avatarResources = candidate.resources.filter(
      (resource) => resource.field === 'actressAvatar'
    )
    for (const resource of avatarResources) {
      const actress: ScrapedActress | undefined = result.actresses?.[resource.position]
      if (!actress?.avatarUrl) continue
      const gender = actress.gender ?? 'female'
      if ((gender === 'female' && !wantsFemale) || (gender === 'male' && !wantsMale)) continue
      const imported = mediaAssetStore.storeScrapedActressAvatar(
        actress.name,
        actress.avatarUrl,
        mediaAssetStore.readVideoScrapeStagedImage(resource.stagedPath)
      )
      actressAvatars.set(actress.name, imported)
      createdPaths.push(imported)
    }
  }
  return { coverPath, samplePaths, actressAvatars, createdPaths }
}

export const videoPendingScrapeService = {
  list(): PendingVideoScrape[] {
    return listPendingVideoScrapes()
  },

  discard(pendingScrapeId: number): boolean {
    const deleted = getDb().transaction(() => {
      const result = deletePendingVideoScrape(pendingScrapeId)
      if (!result) return null
      markScrapeFailed(result.videoId)
      return result
    })()
    if (!deleted) return false
    mediaAssetStore.cleanupVideoScrapeStagingPaths(deleted.stagedPaths)
    return true
  },

  confirm(input: PendingVideoScrapeConfirmInput): PendingVideoScrapeResolutionResult {
    const snapshot = getPendingVideoScrapeResolutionSnapshot(input.pendingScrapeId)
    if (!snapshot) throw new Error('待确认影片刮削结果不存在')
    if (input.selections.length !== snapshot.sources.length) {
      throw new Error('必须为每个刮削来源选择一个候选')
    }
    const chosen = snapshot.sources.map((source) => ({
      source,
      candidate: selectedCandidate(source, input.selections)
    }))
    let merged: ScrapeResult | null = null
    for (const item of chosen) {
      merged = mergeVideoScrapeResults(
        merged,
        projectVideoScrapeResult(item.candidate.result, new Set(item.source.selectedFields))
      )
    }
    if (!merged) throw new Error('待确认结果不包含候选')

    const selectedFields = new Set(snapshot.pending.selectedFields)
    const fieldsToApply = snapshot.pending.applicableFields
    const preflight = videoScrapeApplyService.preflightClassifications(
      snapshot.pending.videoId,
      merged,
      fieldsToApply,
      snapshot.pending.updateMode,
      { directorSelectionId: input.directorSelectionId, directorAmbiguity: 'choice' }
    )
    if (preflight.directorChoice) {
      return {
        status: 'skipped',
        applied: false,
        warnings: preflight.warnings,
        directorChoice: preflight.directorChoice
      }
    }

    const conflictVideoId = findVideoBusinessIdentityConflictForScrape(
      snapshot.pending.videoId,
      merged,
      fieldsToApply,
      snapshot.pending.updateMode
    )
    if (conflictVideoId != null && input.mergeRetainedVideoId == null) {
      return {
        status: 'merge-required',
        applied: false,
        conflictVideoId,
        warnings: snapshot.pending.warnings
      }
    }

    if (
      conflictVideoId != null &&
      input.mergeRetainedVideoId !== snapshot.pending.videoId &&
      input.mergeRetainedVideoId !== conflictVideoId
    ) {
      throw new Error('合并保留影片必须是当前影片或发生冲突的影片')
    }
    if (conflictVideoId == null && input.mergeRetainedVideoId != null) {
      throw new Error('当前候选没有需要处理的影片业务身份冲突')
    }
    if (conflictVideoId != null && hasPendingVideoScrape(conflictVideoId)) {
      throw new Error('冲突影片也存在待确认刮削结果，处理后才能合并')
    }

    const video = getVideoById(snapshot.pending.videoId)
    if (!video) throw new Error('影片不存在')
    const stagedPaths = allStagedPaths(snapshot)
    const sourceName = chosen.find(({ source }) => source.selectedFields.includes('source'))?.source
      .sourceName
    const ratingSourceName = chosen.find(({ source }) =>
      source.selectedFields.includes('rating')
    )?.source.sourceName

    const application = mediaAssetStore.coordinateDatabaseChange(() =>
      getDb().transaction(() => {
        let applyVideoId = snapshot.pending.videoId
        if (conflictVideoId != null && input.mergeRetainedVideoId != null) {
          const sourceVideoId =
            input.mergeRetainedVideoId === snapshot.pending.videoId
              ? conflictVideoId
              : snapshot.pending.videoId
          const mergeResources = [
            ...listVideoResources(input.mergeRetainedVideoId),
            ...listVideoResources(sourceVideoId)
          ]
          const hasPrimary = mergeResources.some((resource) => Boolean(resource.is_primary))
          const fallbackPrimaryResourceId = hasPrimary
            ? undefined
            : selectPrimaryVideoResourceCandidate(mergeResources, fs.existsSync)?.id ?? null
          const mergedVideo = mergeVideoRecords(
            { retainedVideoId: input.mergeRetainedVideoId, sourceVideoId },
            {
              allowPendingVideoId: snapshot.pending.videoId,
              ...(hasPrimary ? {} : { fallbackPrimaryResourceId })
            }
          )
          applyVideoId = mergedVideo.retainedVideoId
          for (const obsoletePath of mergedVideo.obsoletePaths) {
            mediaAssetStore.deleteBestEffort(obsoletePath)
          }
        }
        const applyVideo = getVideoById(applyVideoId)
        if (!applyVideo) throw new Error('合并后的影片不存在')
        let resources: ReturnType<typeof importCandidateResources> = {
          coverPath: null,
          samplePaths: [],
          actressAvatars: new Map(),
          createdPaths: []
        }
        for (const { source, candidate } of chosen) {
          const sourceFields = new Set(
            source.selectedFields.filter((field) => selectedFields.has(field))
          )
          const imported = importCandidateResources(
            applyVideo.code,
            candidate.result,
            candidate,
            sourceFields
          )
          resources = {
            coverPath: imported.coverPath ?? resources.coverPath,
            samplePaths: imported.samplePaths.length ? imported.samplePaths : resources.samplePaths,
            actressAvatars: new Map([...resources.actressAvatars, ...imported.actressAvatars]),
            createdPaths: [...resources.createdPaths, ...imported.createdPaths]
          }
        }
        const applied = videoScrapeApplyService.apply(
          applyVideo.id,
          merged,
          resources.coverPath,
          resources.actressAvatars,
          resources.samplePaths,
          fieldsToApply,
          sourceName,
          snapshot.pending.updateMode,
          ratingSourceName,
          { directorSelectionId: input.directorSelectionId, directorAmbiguity: 'choice' }
        )
        if (applied.directorChoice) throw new Error('导演选择仍未完成')
        for (const obsoletePath of applied.obsoleteAssetPaths) {
          mediaAssetStore.deleteBestEffort(obsoletePath)
        }
        if (!applied.applied) {
          for (const createdPath of resources.createdPaths) mediaAssetStore.deleteBestEffort(createdPath)
        }
        const deleted = deletePendingVideoScrape(snapshot.pending.id)
        if (!deleted && applyVideoId === snapshot.pending.videoId) {
          throw new Error('待确认影片刮削结果已发生变化')
        }
        return applied
      })()
    )
    mediaAssetStore.cleanupVideoScrapeStagingPaths(stagedPaths)
    return {
      status: application.applied ? 'applied' : 'skipped',
      applied: application.applied,
      warnings: [...snapshot.pending.warnings, ...application.warnings]
    }
  }
}
