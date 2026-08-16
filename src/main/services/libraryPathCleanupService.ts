import fs from 'node:fs'
import type { LibraryPathRemovalPreview } from '@shared/libraryTypes'
import type { AppSettings } from '@shared/settingsTypes'
import {
  listLocalVideoResourceRefs,
  listSourceManagedVideoResourceRefs,
  listStrmVideoResourceRefs,
  listVideoResources,
  removeSourceManagedVideoResourcesBatch,
  type VideoResourceBatchRemovalPlan
} from '../db/videoRepo'
import { getDb } from '../db/database'
import { isPathUnderRoot, isSameLibraryPath } from '../scanner/libraryPathUtils'
import { getSettings, updateSettings } from '../settings/settingsStore'
import { maintenanceTaskGate } from './maintenanceTaskGate'
import { mediaAssetStore } from './mediaAssetStore'
import { selectPrimaryVideoResourceCandidate } from './videoResourcePromotion'

export interface PendingLibraryPathCleanupResult {
  removed: number
  promoted: number
  consumedRoots: string[]
}

export function listPendingLibraryPathCleanupRoots(): string[] {
  return [...getSettings().pendingLibraryPathCleanups]
}

export function clearPendingLibraryPathCleanups(roots: string[]): void {
  if (roots.length === 0) return
  const pending = getSettings().pendingLibraryPathCleanups
  updateSettings({
    pendingLibraryPathCleanups: pending.filter(
      (item) => !roots.some((root) => isSameLibraryPath(item, root))
    )
  })
}

export function runLibraryScanCleanupTransaction<T>(operation: () => T): T {
  return mediaAssetStore.coordinateDatabaseChange(() => getDb().transaction(operation)())
}

export function previewLibraryPathRemoval(root: string): LibraryPathRemovalPreview {
  const configuredRoot = getSettings().libraryPaths.find((item) => isSameLibraryPath(item, root))
  if (!configuredRoot) throw new Error('媒体库路径不存在')
  const affectedRefs = listLocalVideoResourceRefs().filter((ref) =>
    isPathUnderRoot(ref.locator, configuredRoot)
  )
  const affectedStrmRefs = listStrmVideoResourceRefs().filter((ref) =>
    isPathUnderRoot(ref.source_path, configuredRoot)
  )
  const affectedIds = new Set(
    [...affectedRefs, ...affectedStrmRefs].map((ref) => ref.resource_id)
  )
  const affectedVideoIds = new Set(
    [...affectedRefs, ...affectedStrmRefs].map((ref) => ref.video_id)
  )
  let videosBecomingResourceLess = 0

  for (const videoId of affectedVideoIds) {
    if (listVideoResources(videoId).every((resource) => affectedIds.has(resource.id))) {
      videosBecomingResourceLess += 1
    }
  }

  return {
    path: configuredRoot,
    localResourceCount: affectedRefs.length,
    strmResourceCount: affectedStrmRefs.length,
    videosBecomingResourceLess
  }
}

export function confirmLibraryPathRemoval(root: string): AppSettings {
  return maintenanceTaskGate.runSync('resource-maintenance', () => {
    const settings = getSettings()
    const configuredRoot = settings.libraryPaths.find((item) => isSameLibraryPath(item, root))
    if (!configuredRoot) throw new Error('媒体库路径已被移除')

    return updateSettings({
      libraryPaths: settings.libraryPaths.filter(
        (item) => !isSameLibraryPath(item, configuredRoot)
      ),
      pendingLibraryPathCleanups: Array.from(
        new Set([...settings.pendingLibraryPathCleanups, configuredRoot])
      )
    })
  })
}

export function applyPendingLibraryPathCleanups(
  roots: string[]
): PendingLibraryPathCleanupResult {
  if (roots.length === 0) return { removed: 0, promoted: 0, consumedRoots: [] }

  const affectedRefs = listSourceManagedVideoResourceRefs().filter((ref) =>
    roots.some((root) => isPathUnderRoot(ref.locator, root))
  )
  const affectedIds = new Set(affectedRefs.map((ref) => ref.resource_id))
  const refsByVideo = new Map<number, number[]>()
  for (const ref of affectedRefs) {
    const resourceIds = refsByVideo.get(ref.video_id) ?? []
    resourceIds.push(ref.resource_id)
    refsByVideo.set(ref.video_id, resourceIds)
  }

  const plans: VideoResourceBatchRemovalPlan[] = []
  for (const [videoId, resourceIds] of refsByVideo) {
    const resources = listVideoResources(videoId)
    const removesPrimary = resources.some(
      (resource) => affectedIds.has(resource.id) && resource.is_primary === 1
    )
    const remaining = resources.filter((resource) => !affectedIds.has(resource.id))
    const promoted = removesPrimary
      ? selectPrimaryVideoResourceCandidate(remaining, fs.existsSync)
      : null
    plans.push({
      videoId,
      resourceIds,
      promotedResourceId: promoted?.id ?? null
    })
  }

  const result = removeSourceManagedVideoResourcesBatch(plans)
  return { ...result, consumedRoots: roots }
}

export function consumePendingLibraryPathCleanups(): PendingLibraryPathCleanupResult {
  const roots = listPendingLibraryPathCleanupRoots()
  const result = runLibraryScanCleanupTransaction(() =>
    applyPendingLibraryPathCleanups(roots)
  )
  clearPendingLibraryPathCleanups(roots)
  return result
}
