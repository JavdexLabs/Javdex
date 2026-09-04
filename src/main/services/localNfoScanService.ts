import { ALL_VIDEO_SCRAPE_FIELDS, type VideoScrapeField } from '@shared/videoScrapeTypes'
import { LOCAL_NFO_SOURCE_NAME } from '@shared/videoMetadataSourceConstants'
import { getVideoById } from '../db/videoRepo'
import { replacePendingVideoScrape } from '../db/pendingVideoScrapeRepo'
import {
  createDefaultLocalNfoSourceAdapter,
  createVideoMetadataCandidateStager,
  getDefaultNfoFileStore,
  LOCAL_NFO_SUPPORTED_FIELDS,
  type LocalNfoAnchor,
  type LocalNfoIdentityInspection,
  type LocalNfoSourceAdapter
} from '../metadata-sources'
import { mediaAssetStore } from './mediaAssetStore'
import {
  findVideoBusinessIdentityConflictForScrape,
  resolveEffectiveVideoScrapeFields,
  videoScrapeApplyService
} from './videoScrapeApplyService'

export type LocalNfoScanDisposition =
  | 'none'
  | 'imported'
  | 'skipped'
  | 'warning'
  | 'pending-candidate'

export interface LocalNfoScanApplyResult {
  disposition: LocalNfoScanDisposition
  warnings: string[]
  pendingScrapeId?: number
}

export interface LocalNfoScanService {
  inspectIdentity(anchor: LocalNfoAnchor): LocalNfoIdentityInspection
  apply(videoId: number, code: string, anchors: readonly LocalNfoAnchor[]): Promise<LocalNfoScanApplyResult>
}

const SCAN_FIELDS = ALL_VIDEO_SCRAPE_FIELDS.filter((field) =>
  (LOCAL_NFO_SUPPORTED_FIELDS as readonly VideoScrapeField[]).includes(field)
)

export function createLocalNfoScanService(
  source: LocalNfoSourceAdapter = createDefaultLocalNfoSourceAdapter(getDefaultNfoFileStore())
): LocalNfoScanService {
  return {
    inspectIdentity: (anchor) => source.inspectIdentity(anchor),

    async apply(videoId, code, anchors) {
      const video = getVideoById(videoId)
      if (!video) return { disposition: 'warning', warnings: ['NFO 目标影片不存在'] }
      if (video.scraped_status === 1) return { disposition: 'skipped', warnings: [] }

      const effective = resolveEffectiveVideoScrapeFields(
        videoId,
        SCAN_FIELDS,
        'fillEmpty',
        LOCAL_NFO_SOURCE_NAME,
        LOCAL_NFO_SOURCE_NAME
      )
      if (effective.length === 0) return { disposition: 'skipped', warnings: [] }
      const collected = await source.collectFromAnchors(
        {
          target: { kind: 'video', videoId, code },
          fields: effective
        },
        anchors
      )
      if (collected.candidates.length === 0) {
        return {
          disposition: collected.warnings.length > 0 ? 'warning' : 'none',
          warnings: collected.warnings
        }
      }

      const identityConflictVideoId =
        collected.candidates.length === 1
          ? findVideoBusinessIdentityConflictForScrape(
              videoId,
              collected.candidates[0].result,
              effective,
              'fillEmpty'
            )
          : null
      if (collected.candidates.length > 1 || identityConflictVideoId != null) {
        const candidateStager = createVideoMetadataCandidateStager({
          fetchRemote: async () => {
            throw new Error('本地 NFO 不允许下载远程图片')
          },
          readManagedRootFile: async (capability) =>
            getDefaultNfoFileStore().readBytes(capability, 64 * 1024 * 1024)
        })
        const persisted = await mediaAssetStore.coordinateDatabaseChange(async () => {
          const staged = await candidateStager.stageForPending(collected.candidates)
          const pending = replacePendingVideoScrape({
            videoId,
            selectedFields: SCAN_FIELDS,
            applicableFields: effective,
            updateMode: 'fillEmpty',
            request: {
              scraperName: LOCAL_NFO_SOURCE_NAME,
              fields: SCAN_FIELDS,
              mode: 'fillEmpty'
            },
            warnings: [
              ...collected.warnings,
              ...(identityConflictVideoId == null
                ? []
                : [`候选会与影片 ID ${identityConflictVideoId} 的业务身份冲突`]),
              ...staged.warnings
            ],
            sources: [
              {
                pluginName: LOCAL_NFO_SOURCE_NAME,
                pluginSource: 'builtin',
                pluginVersion: '1',
                pluginConfig: { sourceId: 'local-nfo', supportedFields: SCAN_FIELDS },
                sourceName: LOCAL_NFO_SOURCE_NAME,
                selectedFields: effective,
                candidates: staged.candidates
              }
            ]
          })
          return { pending, stageWarnings: staged.warnings }
        })
        mediaAssetStore.cleanupVideoScrapeStagingPaths(persisted.pending.obsoletePaths)
        return {
          disposition: 'pending-candidate',
          warnings: [...collected.warnings, ...persisted.stageWarnings],
          pendingScrapeId: persisted.pending.pendingScrapeId
        }
      }

      const candidateStager = createVideoMetadataCandidateStager({
        fetchRemote: async () => {
          throw new Error('本地 NFO 不允许下载远程图片')
        },
        readManagedRootFile: async (capability) =>
          getDefaultNfoFileStore().readBytes(capability, 64 * 1024 * 1024)
      })
      const delivery = await videoScrapeApplyService.deliverCandidate({
        videoId,
        code,
        candidate: collected.candidates[0],
        candidateStager,
        selectedFields: SCAN_FIELDS,
        fieldsToApply: effective,
        mode: 'fillEmpty',
        sourceName: LOCAL_NFO_SOURCE_NAME,
        ratingSourceName: LOCAL_NFO_SOURCE_NAME,
        classificationOptions: { directorAmbiguity: 'preserve' }
      })
      return {
        disposition: delivery.applied ? 'imported' : 'skipped',
        warnings: [...collected.warnings, ...delivery.warnings]
      }
    }
  }
}

export const localNfoScanService = createLocalNfoScanService()
