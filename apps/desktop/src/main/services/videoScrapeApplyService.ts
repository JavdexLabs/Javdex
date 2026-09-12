import type {
  ScrapeResult,
  VideoBatchScrapeFilter,
  VideoClassificationField,
  VideoClassificationResolutionOutcome,
  VideoDirectorChoiceRequired,
  VideoScrapeField,
  VideoScrapeUpdateMode
} from '@shared/videoScrapeTypes'
import type {
  VideoMetadataCandidate,
  VideoMetadataCandidateStager
} from '../metadata-sources'
import { findActressByNameOrAlias } from '@library/db/actressRepo'
import { getDb } from '@library/db/database'
import { adoptDownloadedAvatarIfMissing } from '@library/catalog/actressAssetService'
import { mediaAssetStore } from '@library/mediaAssetStore'
import {
  CLASSIFICATION_FIELDS,
  applyScrapeResult,
  planVideoScrapeResult,
  resolveEffectiveVideoScrapeFields,
  resolveVideoBatchTargets,
  videoScrapeApplyBridge,
  type ApplyVideoScrapeResult,
  type VideoClassificationResolutionOptions,
  type VideoScrapeApplicationPlan
} from '@library/catalog/videoScrapeApplyService'

export {
  CLASSIFICATION_FIELDS,
  applyScrapeResult,
  findVideoBusinessIdentityConflictForScrape,
  planVideoScrapeResult,
  resolveEffectiveScrapeFields,
  resolveEffectiveVideoScrapeFields,
  resolveVideoBatchTargets,
  videoScrapeApplyBridge,
  videoScrapeApplyService as catalogVideoScrapeApplyService
} from '@library/catalog/videoScrapeApplyService'
export type {
  ApplyVideoScrapeResult,
  VideoClassificationResolutionOptions,
  VideoScrapeApplicationPlan,
  VideoScrapeFieldImpact,
  VideoScrapeImpactAction,
  VideoScrapeImpactReason
} from '@library/catalog/videoScrapeApplyService'

export interface VideoScrapeDeliverInput {
  videoId: number
  code: string
  candidate: VideoMetadataCandidate
  candidateStager: VideoMetadataCandidateStager
  selectedFields: VideoScrapeField[]
  fieldsToApply: VideoScrapeField[]
  mode: VideoScrapeUpdateMode
  sourceName?: string
  ratingSourceName?: string
  classificationOptions?: VideoClassificationResolutionOptions
  /** Runs in the same database transaction after a successful application. */
  afterSuccessfulApply?: () => void
  /** Before commit/asset deletion, not confirmation of commit. Later avatar adoption may add warnings. */
  beforeCommit?: (result: VideoScrapeDeliverOutcome) => void
}

export interface VideoScrapeDeliverOutcome {
  applied: boolean
  warnings: string[]
  classifications: VideoClassificationResolutionOutcome[]
  directorChoice?: VideoDirectorChoiceRequired
}

export interface VideoScrapeApplyService {
  resolveEffectiveFields(
    videoId: number,
    fields: VideoScrapeField[],
    mode?: VideoScrapeUpdateMode,
    sourceName?: string,
    ratingSourceName?: string
  ): VideoScrapeField[]
  resolveBatchTargets(filter: VideoBatchScrapeFilter): Array<{ id: number; code: string }>
  preflightClassifications(
    videoId: number,
    result: ScrapeResult,
    fields: VideoScrapeField[],
    mode: VideoScrapeUpdateMode,
    options?: VideoClassificationResolutionOptions
  ): VideoScrapeApplicationPlan
  plan: typeof planVideoScrapeResult
  apply: typeof applyScrapeResult
  deliverCandidate(input: VideoScrapeDeliverInput): Promise<VideoScrapeDeliverOutcome>
}

interface VideoScrapeApplyServiceDependencies {
  resolveEffectiveFields: typeof resolveEffectiveVideoScrapeFields
  resolveBatchTargets: typeof resolveVideoBatchTargets
  plan: typeof planVideoScrapeResult
  apply: typeof applyScrapeResult
  coordinateDatabaseChange: typeof mediaAssetStore.coordinateDatabaseChange
  deleteBestEffort: typeof mediaAssetStore.deleteBestEffort
  findActressByNameOrAlias: typeof findActressByNameOrAlias
  adoptDownloadedAvatarIfMissing: typeof adoptDownloadedAvatarIfMissing
}

export function createVideoScrapeApplyService(
  dependencies: Partial<VideoScrapeApplyServiceDependencies> = {}
): VideoScrapeApplyService {
  const resolveEffectiveFields =
    dependencies.resolveEffectiveFields ?? resolveEffectiveVideoScrapeFields
  const resolveBatchTargets = dependencies.resolveBatchTargets ?? resolveVideoBatchTargets
  const plan = dependencies.plan ?? planVideoScrapeResult
  const apply =
    dependencies.apply ??
    ((...args: Parameters<typeof applyScrapeResult>) =>
      videoScrapeApplyBridge.applyScrapeResult(...args))
  const coordinateDatabaseChange =
    dependencies.coordinateDatabaseChange ??
    mediaAssetStore.coordinateDatabaseChange.bind(mediaAssetStore)
  const deleteBestEffort =
    dependencies.deleteBestEffort ?? mediaAssetStore.deleteBestEffort.bind(mediaAssetStore)
  const findActress = dependencies.findActressByNameOrAlias ?? findActressByNameOrAlias
  const adoptAvatar =
    dependencies.adoptDownloadedAvatarIfMissing ?? adoptDownloadedAvatarIfMissing

  return {
    resolveEffectiveFields,
    resolveBatchTargets,
    preflightClassifications(videoId, result, fields, mode, options) {
      return plan(
        videoId,
        result,
        null,
        [],
        fields.filter((field): field is VideoClassificationField =>
          CLASSIFICATION_FIELDS.includes(field as VideoClassificationField)
        ),
        undefined,
        mode,
        undefined,
        options
      )
    },
    plan,
    apply: (...args) => apply(...args),
    async deliverCandidate(input): Promise<VideoScrapeDeliverOutcome> {
      const result = input.candidate.result
      const downloads = await coordinateDatabaseChange(() =>
        input.candidateStager.deliverForApply(
          input.candidate,
          input.selectedFields,
          input.code
        )
      )

      const downloadedPaths = [
        downloads.coverRel,
        ...downloads.sampleRels,
        ...downloads.avatarMap.values()
      ].filter((assetPath): assetPath is string => Boolean(assetPath))

      let application: ApplyVideoScrapeResult
      try {
        application = coordinateDatabaseChange(() =>
          getDb().transaction(() => {
            const applied = apply(
              input.videoId,
              result,
              downloads.coverRel,
              downloads.avatarMap,
              downloads.sampleRels,
              input.fieldsToApply,
              input.sourceName,
              input.mode,
              input.ratingSourceName,
              input.classificationOptions
            )
            if (applied.applied) input.afterSuccessfulApply?.()
            const callbackResult: unknown = input.beforeCommit?.({
              applied: applied.applied,
              warnings: [...applied.warnings],
              classifications: applied.classifications,
              directorChoice: applied.directorChoice
            })
            if (callbackResult != null &&
                (typeof callbackResult === 'object' || typeof callbackResult === 'function') &&
                typeof (callbackResult as { then?: unknown }).then === 'function') {
              void Promise.resolve(callbackResult).catch(() => {})
              throw new Error('NFO commit callback must be synchronous')
            }
            for (const assetPath of applied.obsoleteAssetPaths) {
              deleteBestEffort(assetPath)
            }
            return applied
          })()
        )
      } catch (applyError) {
        for (const assetPath of downloadedPaths) deleteBestEffort(assetPath)
        throw applyError
      }

      if (!application.applied) {
        for (const assetPath of downloadedPaths) deleteBestEffort(assetPath)
      } else {
        for (const [name, avatarPath] of downloads.avatarMap) {
          if (!avatarPath) continue
          try {
            const actressId = findActress(name)
            if (actressId == null) {
              deleteBestEffort(avatarPath)
              continue
            }
            adoptAvatar(actressId, avatarPath)
          } catch (error) {
            deleteBestEffort(avatarPath)
            application.warnings.push(
              `演员「${name}」头像未应用：${(error as Error).message}`
            )
          }
        }
      }

      return {
        applied: application.applied,
        warnings: application.warnings,
        classifications: application.classifications,
        directorChoice: application.directorChoice
      }
    }
  }
}

export const videoScrapeApplyService = createVideoScrapeApplyService()
