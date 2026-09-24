import { getActressProfile } from '@library/db/actressRepo'
import { randomUUID } from 'node:crypto'
import type { ActressProfile } from '@shared/actressTypes'
import { listActressGalleryPage } from '@library/db/actressGalleryPageRepo'
import type { ActressGalleryPage, ActressGalleryPageQuery } from '@shared/actressTypes'
import { getActressMetadata } from '@library/db/actressRepo'
import type { ActressMetadata } from '@shared/actressTypes'
import { listActressVideoPage } from '@library/db/actressVideoPageRepo'
import type { ActressVideoPage, ActressVideoPageQuery } from '@shared/actressTypes'
import { normalizeRunTargets } from '@shared/pluginDevKindProfile'
import type { ActressAvatarAutoCropTarget } from '@shared/actressAvatarCropTypes'
import type { ActressMergeCandidatePage, ActressMergeCandidateQuery } from '@shared/actressTypes'
import type { ActressPickerIdentity, ActressPickerPage, ActressPickerQuery } from '@shared/actressTypes'
import {
  listActressTestTargetPage,
  getActressTestTargetName,
  listActressAvatarCropTargets,
  countActressAvatarCropTargets,
  getActressDetail,
  getActressPickerIdentity,
  listActresses,
  listActressAvatarCandidates,
  listActressPage,
  listActressPickerPage,
  listActressMergeCandidates
} from '@library/db/actressRepo'
import { getActressAvatarSourceInfo } from './actressAssetService'
import { mediaAssetStore } from '@library/mediaAssetStore'
import type {
  ActressAvatarSourceInfo,
  ActressDetail,
  ActressFaceScanManifestItem,
  ActressGenderFilter,
  ActressListItem,
  ActressListPage,
  ActressListQuery,
  ActressListSortBy
} from '@shared/actressTypes'
import { actressStatusFilterOf } from '@shared/actressTypes'
import type { SortDir } from '@shared/commonTypes'

export interface ActressQueryService {
  getProfile(id: number): ActressProfile | null
  listGallery(id: number, query?: ActressGalleryPageQuery): ActressGalleryPage | null
  getMetadata(id: number): ActressMetadata | null
  listVideos(id: number, query?: ActressVideoPageQuery): ActressVideoPage | null
  listTestTargets(query?: ActressPickerQuery): ActressPickerPage
  getTestTarget(id: number): string | null
  listAvatarCropTargets(): ActressAvatarAutoCropTarget[]
  countAvatarCropTargets(): number
  listLegacy(
    search?: string,
    gender?: ActressGenderFilter,
    sortBy?: ActressListSortBy,
    sortDir?: SortDir
  ): ActressListItem[]
  listMergeCandidates(query: ActressMergeCandidateQuery): ActressMergeCandidatePage
  getPicker(id: number): ActressPickerIdentity | null
  listPicker(query?: ActressPickerQuery): ActressPickerPage
  listActresses(query?: ActressListQuery): ActressListPage
  listFaceScanManifest(): ActressFaceScanManifestItem[]
  getActress(id: number): ActressDetail | null
  getAvatarSourceInfo(id: number): ActressAvatarSourceInfo | null
}

interface ActressQueryServiceDependencies {
  getProfile: typeof getActressProfile
  listGallery: typeof listActressGalleryPage
  getMetadata: typeof getActressMetadata
  listVideos: typeof listActressVideoPage
  listTestTargets: typeof listActressTestTargetPage
  getTestTargetName: typeof getActressTestTargetName
  listAvatarCropTargets: typeof listActressAvatarCropTargets
  countAvatarCropTargets: typeof countActressAvatarCropTargets
  listMergeCandidates: typeof listActressMergeCandidates
  getPicker: typeof getActressPickerIdentity
  listPicker: typeof listActressPickerPage
  listLegacy: typeof listActresses
  listPage: (query?: ActressListQuery) => ActressListPage
  listFaceScanCandidates: typeof listActressAvatarCandidates
  getActress: typeof getActressDetail
  getAvatarSourceInfo: typeof getActressAvatarSourceInfo
  inspectImage: typeof mediaAssetStore.inspectImage
}

const MAX_AVATAR_PAGE_SNAPSHOTS = 8

function avatarPageSnapshotKey(query: ActressListQuery): string {
  return JSON.stringify({
    search: query.search?.trim() ?? '',
    gender: query.gender ?? 'female',
    status: query.status ?? 'all',
    avatar: query.avatar ?? 'all',
    sortBy: query.sortBy ?? 'video_count',
    sortDir: query.sortDir ?? 'desc',
    actressIds: query.actressIds ?? null
  })
}

export function createActressQueryService(
  dependencies: Partial<ActressQueryServiceDependencies> = {}
): ActressQueryService {
  const readMergeCandidates = dependencies.listMergeCandidates ?? listActressMergeCandidates
  const readPickerIdentity = dependencies.getPicker ?? getActressPickerIdentity
  const readPicker = dependencies.listPicker ?? listActressPickerPage
  const readLegacyList = dependencies.listLegacy ?? listActresses
  const readListPage = dependencies.listPage ?? listActressPage
  const readFaceScanCandidates =
    dependencies.listFaceScanCandidates ?? listActressAvatarCandidates
  const readActress = dependencies.getActress ?? getActressDetail
  const readAvatarSourceInfo = dependencies.getAvatarSourceInfo ?? getActressAvatarSourceInfo
  const inspectImage = dependencies.inspectImage ?? mediaAssetStore.inspectImage
  const avatarPageSnapshots = new Map<string, ActressListPage>()

  return {
    getProfile: (id) => (dependencies.getProfile ?? getActressProfile)(id),
    listGallery: (id, query) => (dependencies.listGallery ?? listActressGalleryPage)(id, query),
    getMetadata: (id) => (dependencies.getMetadata ?? getActressMetadata)(id),
    listVideos: (id, query) => (dependencies.listVideos ?? listActressVideoPage)(id, query),
    listTestTargets: (query) => (dependencies.listTestTargets ?? listActressTestTargetPage)(query),
    getTestTarget(id) {
      const mainName = (dependencies.getTestTargetName ?? getActressTestTargetName)(id)
      if (mainName === null) return null
      const target = normalizeRunTargets([{ kind: 'actress', mainName, aliases: [] }])[0]
      return target.kind === 'actress' ? target.mainName : null
    },
    listAvatarCropTargets: () => (dependencies.listAvatarCropTargets ?? listActressAvatarCropTargets)(),
    countAvatarCropTargets: () => (dependencies.countAvatarCropTargets ?? countActressAvatarCropTargets)(),
    listMergeCandidates: (query) => readMergeCandidates(query),
    getPicker: (id) => readPickerIdentity(id),
    listPicker: (query) => readPicker(query),
    listLegacy(search, gender, sortBy, sortDir): ActressListItem[] {
      return readLegacyList(search, gender, sortBy, sortDir)
    },
    listFaceScanManifest(): ActressFaceScanManifestItem[] {
      return readFaceScanCandidates().flatMap((candidate) => {
        const inspection = inspectImage(candidate.avatar_path)
        if (!inspection.usable || !inspection.fingerprint) return []
        return [{
          ...candidate,
          avatar_fingerprint: inspection.fingerprint
        }]
      })
    },
    getActress(id): ActressDetail | null {
      return readActress(id)
    },
    getAvatarSourceInfo(id): ActressAvatarSourceInfo | null {
      return readAvatarSourceInfo(id)
    },
    listActresses(query): ActressListPage {
      const requested = query ?? {}
      const limit = requested.limit
      const avatar = requested.avatar ?? 'all'
      if (limit == null || avatar === 'all' || avatar === 'without-face') {
        return readListPage(requested)
      }

      const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)))
      const safeOffset = Math.max(0, Math.trunc(requested.offset ?? 0))
      const key = avatarPageSnapshotKey(requested)
      let snapshot = safeOffset === 0 ? undefined : avatarPageSnapshots.get(key)
      if (!snapshot) {
        const unfiltered = readListPage({
          ...requested,
          avatar: 'all',
          status: 'all',
          limit: undefined,
          offset: 0
        })
        const wantsAvatar = avatar === 'with'
        const avatarFiltered = unfiltered.items.flatMap((actress) => {
          const inspection = inspectImage(actress.avatar_path)
          if (inspection.usable !== wantsAvatar) return []
          return [wantsAvatar
            ? { ...actress, avatar_fingerprint: inspection.fingerprint }
            : actress]
        })
        const statusCounts = { all: 0, success: 0, unscraped: 0, failed: 0 }
        for (const actress of avatarFiltered) {
          statusCounts.all += 1
          statusCounts[actressStatusFilterOf(actress.scraped_status)] += 1
        }
        const requestedStatus = requested.status ?? 'all'
        const items = requestedStatus === 'all'
          ? avatarFiltered
          : avatarFiltered.filter(
              (actress) => actressStatusFilterOf(actress.scraped_status) === requestedStatus
            )
        snapshot = {
          items, total: items.length, statusCounts,
          ...(unfiltered.readRevision === undefined ? {} : {
            readRevision: `${unfiltered.readRevision}:avatar:${randomUUID()}`
          })
        }
        avatarPageSnapshots.delete(key)
        avatarPageSnapshots.set(key, snapshot)
        while (avatarPageSnapshots.size > MAX_AVATAR_PAGE_SNAPSHOTS) {
          const oldestKey = avatarPageSnapshots.keys().next().value as string | undefined
          if (oldestKey == null) break
          avatarPageSnapshots.delete(oldestKey)
        }
      }

      return {
        ...snapshot,
        items: snapshot.items.slice(safeOffset, safeOffset + safeLimit)
      }
    }
  }
}

export const actressQueryService = createActressQueryService()
