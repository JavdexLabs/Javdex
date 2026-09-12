import type {
  MediaLibraryColor,
  MediaLibraryIcon,
  MediaLibrarySummary
} from './mediaLibraryTypes'
import type { Video, VideoDetail, VideoListResult, VideoQuery } from './videoTypes'

export interface MediaLibraryBadge {
  libraryId: number
  name: string
  icon: MediaLibraryIcon
  color: MediaLibraryColor
}

export interface ScopedVideo extends Video {
  preferredLibraryId: number
  membershipAddedAt: string
  libraries: MediaLibraryBadge[]
}

export interface ScopedVideoListResult extends Omit<VideoListResult, 'items'> {
  items: ScopedVideo[]
  /** Opaque read snapshot identity for cross-page selection consistency. */
  readRevision?: string
}

export interface ScopedVideoDetail extends VideoDetail {
  activeLibraryId: number
  membershipAddedAt: string
  libraries: MediaLibraryBadge[]
}

export interface GlobalSearchInput extends VideoQuery {
  libraryIds?: number[]
}

export type GlobalSearchResult = ScopedVideoListResult

export interface HomeDiscoveryInput {
  seed: string
  recentLimit?: number
  discoveryLimit?: number
  libraryIds?: number[]
}

export type HomeMediaLibraryScanStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unavailable'

/** Bounded operational summary rendered by each media-library card on Home. */
export interface HomeMediaLibraryStatus extends MediaLibrarySummary {
  membershipCount: number
  resourceCount: number
  pendingScanResourceCount: number
  unrecognizedFileCount: number
  lastScanStatus: HomeMediaLibraryScanStatus | null
  lastScanStartedAt: string | null
  lastScanFinishedAt: string | null
  lastSuccessfulScanAt: string | null
  /**
   * Root paths reported offline by the latest persisted scan summary. `null`
   * means no valid scan availability snapshot exists; Home never probes disk.
   */
  lastScanOfflineRootCount: number | null
}

export interface HomeSnapshot {
  seed: string
  recent: ScopedVideo[]
  discovery: ScopedVideo[]
  libraries: HomeMediaLibraryStatus[]
}
