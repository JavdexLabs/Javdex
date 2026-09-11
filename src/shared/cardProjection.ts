import type { ActressListItem, ActressListPage } from './actressTypes'
import type { ScopedVideo, ScopedVideoListResult } from './catalogTypes'
import type { VideoCard } from './videoTypes'

export type ActressCard = Pick<ActressListItem,
  'id' | 'main_name' | 'avatar_path' | 'gender' | 'scraped_status' | 'video_count' |
  'avatar_fingerprint' | 'revision'>
export type ScopedVideoCard = VideoCard & Pick<ScopedVideo,
  'preferredLibraryId' | 'membershipAddedAt' | 'libraries'>
export type ActressCardPage = Omit<ActressListPage, 'items'> & { items: ActressCard[] }
export type ScopedVideoCardPage = Omit<ScopedVideoListResult, 'items'> & { items: ScopedVideoCard[] }

/** JSON UTF-8 retention budget, not a bound on transport, transient serialization or JS heap. */
export const CARD_PAGE_BYTE_LIMIT = 1024 * 1024

export function toVideoCard(video: VideoCard): VideoCard {
  return {
    id: video.id, code: video.code, title: video.title, cover_path: video.cover_path,
    scraped_status: video.scraped_status, has_pending_scrape: video.has_pending_scrape,
    resource_kinds: video.resource_kinds?.slice()
  }
}

export function toScopedVideoCard(video: ScopedVideoCard): ScopedVideoCard {
  return {
    ...toVideoCard(video),
    preferredLibraryId: video.preferredLibraryId,
    membershipAddedAt: video.membershipAddedAt,
    libraries: video.libraries.map(({ libraryId, name, icon, color }) => ({ libraryId, name, icon, color }))
  }
}

export function toActressCard(actress: ActressCard): ActressCard {
  return {
    id: actress.id, main_name: actress.main_name, avatar_path: actress.avatar_path,
    gender: actress.gender, scraped_status: actress.scraped_status, video_count: actress.video_count,
    avatar_fingerprint: actress.avatar_fingerprint, revision: actress.revision
  }
}

function withinPageBudget<T>(page: T): T {
  if (new TextEncoder().encode(JSON.stringify(page)).byteLength > CARD_PAGE_BYTE_LIMIT) {
    throw new Error('卡片页内容超过 1 MiB，请缩小查询范围')
  }
  return page
}

/** Apply before cache admission. Legacy list/GET objects are never mutated or cast to a narrow shape. */
export function toScopedVideoCardPage(page: ScopedVideoCardPage): ScopedVideoCardPage {
  return withinPageBudget({
    total: page.total, items: page.items.map(toScopedVideoCard),
    ...(page.readRevision === undefined ? {} : { readRevision: page.readRevision })
  })
}

export function toActressCardPage(page: ActressCardPage): ActressCardPage {
  return withinPageBudget({
    total: page.total, statusCounts: { ...page.statusCounts }, items: page.items.map(toActressCard),
    ...(page.readRevision === undefined ? {} : { readRevision: page.readRevision })
  })
}
