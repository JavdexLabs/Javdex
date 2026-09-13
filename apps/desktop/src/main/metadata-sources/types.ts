import type { ScraperPluginSource } from '@shared/scraperPluginTypes'
import type { ScrapeResult, VideoScrapeField } from '@shared/videoScrapeTypes'
import type { PendingVideoScrapeCandidateInput } from '@library/db/pendingVideoScrapeRepo'

export type VideoMetadataSourceKind = 'web-scraper' | 'local-nfo'

export interface VideoMetadataSourceDescriptor {
  id: string
  name: string
  kind: VideoMetadataSourceKind
  origin: ScraperPluginSource | 'host'
  version: string | null
  supportedFields: VideoScrapeField[]
}

export type VideoMetadataTarget =
  | { kind: 'code'; code: string }
  | { kind: 'video'; videoId: number; code: string }

export interface VideoMetadataSourceRequest {
  target: VideoMetadataTarget
  fields: VideoScrapeField[]
}

import type { ManagedRootFileCapability } from '@library/nfo/managedRootFileCapability'

export type { ManagedRootFileCapability }

export type MetadataAssetField = 'cover' | 'samples' | 'actressAvatar'

export type MetadataAssetRef =
  | {
      kind: 'remote-url'
      field: MetadataAssetField
      position: number
      url: string
    }
  | {
      kind: 'managed-root-file'
      field: MetadataAssetField
      position: number
      capability: ManagedRootFileCapability
      filename: string
    }

export interface MetadataEvidence {
  kind: VideoMetadataSourceKind
  sourceId: string
  sourceName: string
  sourceUrl?: string
}

export interface VideoMetadataCandidate {
  result: ScrapeResult
  assets: MetadataAssetRef[]
  evidence: MetadataEvidence
}

export interface MetadataCandidateBatch {
  candidates: VideoMetadataCandidate[]
  warnings: string[]
}

export interface DeliveredVideoMetadataAssets {
  coverRel: string | null
  sampleRels: Array<string | null>
  avatarMap: Map<string, string | null>
}

export interface VideoMetadataCandidateStager {
  stageForPending(candidates: VideoMetadataCandidate[]): Promise<{
    candidates: PendingVideoScrapeCandidateInput[]
    warnings: string[]
  }>
  deliverForApply(
    candidate: VideoMetadataCandidate,
    selectedFields: VideoScrapeField[],
    fallbackCode: string
  ): Promise<DeliveredVideoMetadataAssets>
}

/**
 * Main-process metadata-source seam. Sources collect reviewable candidates;
 * candidate selection, persistence and field application stay with the host.
 */
export interface VideoMetadataSource {
  readonly descriptor: VideoMetadataSourceDescriptor
  collect(request: VideoMetadataSourceRequest): Promise<MetadataCandidateBatch>
}
