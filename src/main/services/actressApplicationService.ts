import {
  deleteUnlinkedActressRecords,
  listActressFaceScanManifest,
  listActressPage
} from '../db/actressRepo'
import { deleteAssetOrThrow } from './assetService'
import type {
  ActressDeleteCleanupFailure,
  ActressDeleteResult
} from '@shared/actressIpcContract'
import type {
  ActressFaceScanManifestItem,
  ActressListPage,
  ActressListQuery
} from '@shared/types'

export interface ActressApplicationService {
  listActresses(query?: ActressListQuery): ActressListPage
  listFaceScanManifest(): ActressFaceScanManifestItem[]
  deleteUnlinkedActresses(input: { ids: number[] }): ActressDeleteResult
}

interface ActressApplicationServiceDependencies {
  deleteStoredAsset: (path: string) => void
  listPage: (query?: ActressListQuery) => ActressListPage
  listFaceScanManifest: () => ActressFaceScanManifestItem[]
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

export function createActressApplicationService(
  dependencies: Partial<ActressApplicationServiceDependencies> = {}
): ActressApplicationService {
  const deleteStoredAsset = dependencies.deleteStoredAsset ?? deleteAssetOrThrow
  const readListPage = dependencies.listPage ?? listActressPage
  const readFaceScanManifest = dependencies.listFaceScanManifest ?? listActressFaceScanManifest
  const avatarPageSnapshots = new Map<string, ActressListPage>()

  return {
    listFaceScanManifest(): ActressFaceScanManifestItem[] {
      return readFaceScanManifest()
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
        snapshot = readListPage({ ...requested, limit: undefined, offset: 0 })
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
    },
    deleteUnlinkedActresses(input): ActressDeleteResult {
      const deleted = deleteUnlinkedActressRecords(input.ids)
      const cleanupFailures: ActressDeleteCleanupFailure[] = []

      for (const assetPath of deleted.assetPaths) {
        try {
          deleteStoredAsset(assetPath)
        } catch (error) {
          console.error('Failed to clean deleted actress asset:', assetPath, error)
          cleanupFailures.push({
            path: assetPath,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }

      return { deletedCount: deleted.deletedCount, cleanupFailures }
    }
  }
}

export const actressApplicationService = createActressApplicationService()
