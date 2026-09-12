import { ALL_VIDEO_SCRAPE_FIELDS, type VideoScrapeField } from '@shared/videoScrapeTypes'
import { LOCAL_NFO_SOURCE_NAME } from '@shared/videoMetadataSourceConstants'
import { getDb } from '@library/db/database'
import { getVideoById } from '@library/db/videoRepo'
import { replacePendingVideoScrape } from '@library/db/pendingVideoScrapeRepo'
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
  /** Before DB commit, not proof of commit. No-write outcomes may run without a business transaction.
   * Returned warnings may grow during post-commit asset handling. */
  apply(videoId: number, code: string, anchors: readonly LocalNfoAnchor[],
    beforeCommit?: (result: LocalNfoScanApplyResult) => void): Promise<LocalNfoScanApplyResult>
}

const SCAN_FIELDS = ALL_VIDEO_SCRAPE_FIELDS.filter((field) =>
  (LOCAL_NFO_SUPPORTED_FIELDS as readonly VideoScrapeField[]).includes(field)
)

export function createLocalNfoScanService(
  source: LocalNfoSourceAdapter = createDefaultLocalNfoSourceAdapter(getDefaultNfoFileStore())
): LocalNfoScanService {
  return {
    inspectIdentity: (anchor) => source.inspectIdentity(anchor),

    async apply(videoId, code, anchors, beforeCommit) {
      const notify = (result: LocalNfoScanApplyResult): LocalNfoScanApplyResult => {
        const returned: unknown = beforeCommit?.(result)
        if (returned != null && (typeof returned === 'object' || typeof returned === 'function') &&
            typeof (returned as { then?: unknown }).then === 'function') {
          void Promise.resolve(returned).catch(() => {})
          throw new Error('NFO commit callback must be synchronous')
        }
        return result
      }
      const video = getVideoById(videoId)
      if (!video) return notify({ disposition: 'warning', warnings: ['NFO 目标影片不存在'] })
      if (video.scraped_status === 1) return notify({ disposition: 'skipped', warnings: [] })

      const effective = resolveEffectiveVideoScrapeFields(
        videoId,
        SCAN_FIELDS,
        'fillEmpty',
        LOCAL_NFO_SOURCE_NAME,
        LOCAL_NFO_SOURCE_NAME
      )
      if (effective.length === 0) return notify({ disposition: 'skipped', warnings: [] })
      const collected = await source.collectFromAnchors(
        {
          target: { kind: 'video', videoId, code },
          fields: effective
        },
        anchors
      )
      if (collected.candidates.length === 0) {
        return notify({
          disposition: collected.warnings.length > 0 ? 'warning' : 'none',
          warnings: collected.warnings
        })
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
          return getDb().transaction(() => {
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
            const result = notify({
              disposition: 'pending-candidate',
              warnings: [...collected.warnings, ...staged.warnings],
              pendingScrapeId: pending.pendingScrapeId
            })
            return { pending, result }
          })()

        })
        try {
          mediaAssetStore.cleanupVideoScrapeStagingPaths(persisted.pending.obsoletePaths)
        } catch (error) {
          persisted.result.warnings.push(`NFO 旧候选资源清理失败：${(error as Error).message}`)
        }
        return persisted.result
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
        classificationOptions: { directorAmbiguity: 'preserve' },
        beforeCommit: (result) => {
          notify({ disposition: result.applied ? 'imported' : 'skipped',
            warnings: [...collected.warnings, ...result.warnings] })
        }
      })
      return {
        disposition: delivery.applied ? 'imported' : 'skipped',
        warnings: [...collected.warnings, ...delivery.warnings]
      }
    }
  }
}

export const localNfoScanService = createLocalNfoScanService()
