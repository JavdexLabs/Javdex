import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type {
  CorrectImportResult,
  LastVideoResourceRemovalMode,
  VideoAsset,
  VideoEditInput,
  VideoFieldUpdateInput,
  VideoLinkResourceImportInput,
  VideoLinkResourceUpdateInput,
  VideoResource,
  VideoResourceImportResult,
  VideoResourceLinkCheckResult,
  VideoResourceRemovalResult,
  VideoSampleImportInput
} from '@shared/videoTypes'
import {
  addManualVideoTag,
  addVideoSampleAsset,
  clearVideoMetadataRecord,
  deleteVideoSampleAsset,
  editVideoRecord,
  getPrimaryVideoResource,
  getVideoByCode,
  getVideoById,
  getVideoResourceById,
  importVideoLinkResourceRecord,
  updateVideoLinkResourceRecord,
  listVideoResources,
  markScrapeSucceeded,
  mergeVideoIntoExistingCode,
  purgeVideo,
  removeManualVideoTag,
  removeVideoResourceRecord,
  renameVideoCode,
  setPrimaryVideoResource,
  setRating,
  setVideoPosterPath,
  updateLocalVideoResourceLabel,
  updateVideoFields
} from '../db/videoRepo'
import { normalizeExternalVideoResource } from '@shared/videoResourceLinks'
import { normalizeVideoCode } from '@shared/videoCode'
import { videoResourceLinkService } from './videoResourceLinkService'
import { mediaAssetStore } from './mediaAssetStore'
import { fetchRemoteImageBuffer } from './remoteImageFetch'
import { maintenanceTaskGate } from './maintenanceTaskGate'
import { selectPrimaryVideoResourceCandidate } from './videoResourcePromotion'
import { classificationMaintenanceService } from './classificationMaintenanceService'
import { getDb } from '../db/database'
import {
  getPendingLocalFileDeletionByOriginalPath,
  markLocalFileDeletionsCommitted,
  prepareLocalFileDeletion,
  removePendingLocalFileDeletions
} from '../db/pendingLocalFileDeletionRepo'
import { inspectWritableLocalPath } from './localFileAvailability'

export interface VideoMaintenanceService {
  update(id: number, fields: VideoFieldUpdateInput): boolean
  edit(id: number, input: VideoEditInput): boolean
  clearMetadata(id: number): boolean
  markScrapeSucceeded(id: number): boolean
  delete(id: number): boolean
  setRating(id: number, rating: number): boolean
  correctImport(id: number, code: string): CorrectImportResult
  importSample(id: number, input: VideoSampleImportInput): Promise<VideoAsset>
  deleteSample(id: number, assetId: number): boolean
  setPoster(id: number, posterPath: string | null): boolean
  addManualTag(id: number, name: string): boolean
  removeManualTag(id: number, tagId: number): boolean
  importLinkResource(input: VideoLinkResourceImportInput): VideoResourceImportResult
  checkLinkResource(url: string): Promise<VideoResourceLinkCheckResult>
  updateLinkResource(
    videoId: number,
    resourceId: number,
    input: VideoLinkResourceUpdateInput
  ): VideoResource
  updateLocalResourceLabel(videoId: number, resourceId: number, label: string | null): VideoResource
  setPrimaryResource(videoId: number, resourceId: number): boolean
  removeResource(
    videoId: number,
    resourceId: number,
    lastResourceMode?: LastVideoResourceRemovalMode
  ): VideoResourceRemovalResult
}

interface VideoMaintenanceServiceDependencies {
  getVideoById: typeof getVideoById
  getVideoByCode: typeof getVideoByCode
  getPrimaryVideoResource: typeof getPrimaryVideoResource
  updateVideoFields: typeof updateVideoFields
  editVideoRecord: typeof editVideoRecord
  clearVideoMetadataRecord: typeof clearVideoMetadataRecord
  markScrapeSucceeded: typeof markScrapeSucceeded
  setRating: typeof setRating
  renameVideoCode: typeof renameVideoCode
  mergeVideoIntoExistingCode: typeof mergeVideoIntoExistingCode
  purgeVideo: typeof purgeVideo
  addVideoSampleAsset: typeof addVideoSampleAsset
  deleteVideoSampleAsset: typeof deleteVideoSampleAsset
  setVideoPosterPath: typeof setVideoPosterPath
  addManualVideoTag: typeof addManualVideoTag
  removeManualVideoTag: typeof removeManualVideoTag
  importVideoLinkResourceRecord: typeof importVideoLinkResourceRecord
  checkLinkResource: typeof videoResourceLinkService.check
  updateVideoLinkResourceRecord: typeof updateVideoLinkResourceRecord
  getVideoResourceById: typeof getVideoResourceById
  listVideoResources: typeof listVideoResources
  setPrimaryVideoResource: typeof setPrimaryVideoResource
  updateLocalVideoResourceLabel: typeof updateLocalVideoResourceLabel
  removeVideoResourceRecord: typeof removeVideoResourceRecord
  runInCoordinatedChange: typeof mediaAssetStore.runInCoordinatedChange
  coordinateDatabaseChange: typeof mediaAssetStore.coordinateDatabaseChange
  importCover: typeof mediaAssetStore.importCover
  importSample: typeof mediaAssetStore.importSample
  downloadSamples: typeof mediaAssetStore.downloadSamples
  deleteBestEffort: typeof mediaAssetStore.deleteBestEffort
  fetchRemoteImageBuffer: typeof fetchRemoteImageBuffer
  fileExists: (path: string) => boolean
  unlinkSync: (path: string) => void
  renameSync: (oldPath: string, newPath: string) => void
  runDatabaseTransaction: <T>(work: () => T) => T
  getPendingLocalFileDeletionByOriginalPath: typeof getPendingLocalFileDeletionByOriginalPath
  prepareLocalFileDeletion: typeof prepareLocalFileDeletion
  markLocalFileDeletionsCommitted: typeof markLocalFileDeletionsCommitted
  removePendingLocalFileDeletions: typeof removePendingLocalFileDeletions
  withResourceMaintenance: <T>(work: () => T) => T
  assignVideoOrganization: typeof classificationMaintenanceService.assignVideoOrganization
  assignVideoDirector: typeof classificationMaintenanceService.assignVideoDirector
  assignVideoSeries: typeof classificationMaintenanceService.assignVideoSeries
}

export function createVideoMaintenanceService(
  dependencies: Partial<VideoMaintenanceServiceDependencies> = {}
): VideoMaintenanceService {
  const readVideoById = dependencies.getVideoById ?? getVideoById
  const readVideoByCode = dependencies.getVideoByCode ?? getVideoByCode
  const readPrimaryVideoResource =
    dependencies.getPrimaryVideoResource ?? getPrimaryVideoResource
  const writeVideoFields = dependencies.updateVideoFields ?? updateVideoFields
  const writeVideoRecord = dependencies.editVideoRecord ?? editVideoRecord
  const clearMetadataRecord = dependencies.clearVideoMetadataRecord ?? clearVideoMetadataRecord
  const recordScrapeSucceeded = dependencies.markScrapeSucceeded ?? markScrapeSucceeded
  const writeRating = dependencies.setRating ?? setRating
  const renameCode = dependencies.renameVideoCode ?? renameVideoCode
  const mergeIntoExistingCode = dependencies.mergeVideoIntoExistingCode ?? mergeVideoIntoExistingCode
  const purgeVideoRecord = dependencies.purgeVideo ?? purgeVideo
  const addSampleAsset = dependencies.addVideoSampleAsset ?? addVideoSampleAsset
  const deleteSampleAsset = dependencies.deleteVideoSampleAsset ?? deleteVideoSampleAsset
  const writePoster = dependencies.setVideoPosterPath ?? setVideoPosterPath
  const writeManualTag = dependencies.addManualVideoTag ?? addManualVideoTag
  const deleteManualTag = dependencies.removeManualVideoTag ?? removeManualVideoTag
  const importLinkResourceRecord =
    dependencies.importVideoLinkResourceRecord ?? importVideoLinkResourceRecord
  const checkLinkResource = dependencies.checkLinkResource ?? videoResourceLinkService.check
  const updateLinkResourceRecord =
    dependencies.updateVideoLinkResourceRecord ?? updateVideoLinkResourceRecord
  const readVideoResourceById = dependencies.getVideoResourceById ?? getVideoResourceById
  const readVideoResources = dependencies.listVideoResources ?? listVideoResources
  const writePrimaryResource = dependencies.setPrimaryVideoResource ?? setPrimaryVideoResource
  const writeLocalResourceLabel =
    dependencies.updateLocalVideoResourceLabel ?? updateLocalVideoResourceLabel
  const removeResourceRecord =
    dependencies.removeVideoResourceRecord ?? removeVideoResourceRecord
  const runInCoordinatedChange =
    dependencies.runInCoordinatedChange ?? mediaAssetStore.runInCoordinatedChange.bind(mediaAssetStore)
  const coordinateDatabaseChange =
    dependencies.coordinateDatabaseChange ??
    mediaAssetStore.coordinateDatabaseChange.bind(mediaAssetStore)
  const importCover = dependencies.importCover ?? mediaAssetStore.importCover.bind(mediaAssetStore)
  const importSampleAsset =
    dependencies.importSample ?? mediaAssetStore.importSample.bind(mediaAssetStore)
  const downloadSamples =
    dependencies.downloadSamples ?? mediaAssetStore.downloadSamples.bind(mediaAssetStore)
  const deleteBestEffort =
    dependencies.deleteBestEffort ?? mediaAssetStore.deleteBestEffort.bind(mediaAssetStore)
  const fetchRemoteBuffer = dependencies.fetchRemoteImageBuffer ?? fetchRemoteImageBuffer
  const fileExists = dependencies.fileExists ?? ((path) => fs.existsSync(path))
  const unlinkSync = dependencies.unlinkSync ?? ((path) => fs.unlinkSync(path))
  const renameSync = dependencies.renameSync ?? ((oldPath, newPath) => fs.renameSync(oldPath, newPath))
  const runDatabaseTransaction =
    dependencies.runDatabaseTransaction ??
    (<T>(work: () => T): T => getDb().transaction(work)())
  const readPendingFileDeletion =
    dependencies.getPendingLocalFileDeletionByOriginalPath ??
    getPendingLocalFileDeletionByOriginalPath
  const preparePendingFileDeletion =
    dependencies.prepareLocalFileDeletion ?? prepareLocalFileDeletion
  const markPendingFileDeletionsCommitted =
    dependencies.markLocalFileDeletionsCommitted ?? markLocalFileDeletionsCommitted
  const removePendingFileDeletions =
    dependencies.removePendingLocalFileDeletions ?? removePendingLocalFileDeletions
  const withResourceMaintenance =
    dependencies.withResourceMaintenance ??
    (<T>(work: () => T): T => maintenanceTaskGate.runSync('resource-maintenance', work))
  const assignVideoOrganization =
    dependencies.assignVideoOrganization ?? classificationMaintenanceService.assignVideoOrganization
  const assignVideoDirector =
    dependencies.assignVideoDirector ?? classificationMaintenanceService.assignVideoDirector
  const assignVideoSeries =
    dependencies.assignVideoSeries ?? classificationMaintenanceService.assignVideoSeries

  interface StagedLocalFile {
    originalPath: string
    stagedPath: string
    deviceId: number
  }

  const restoreStagedLocalFiles = (files: StagedLocalFile[]): void => {
    const failures: string[] = []
    for (const file of [...files].reverse()) {
      const stagedInspection = inspectWritableLocalPath(file.stagedPath, {
        expectedDeviceId: file.deviceId,
        acceptPresentDeviceChange: true
      })
      if (stagedInspection.state === 'unknown') {
        failures.push(`${file.originalPath}：暂存文件所在存储当前不可用`)
        continue
      }
      if (stagedInspection.state === 'missing') {
        const originalInspection = inspectWritableLocalPath(file.originalPath, {
          expectedDeviceId: file.deviceId
        })
        if (originalInspection.state !== 'present') {
          failures.push(`${file.originalPath}：暂存文件和原文件均不可用`)
        }
        continue
      }
      const originalInspection = inspectWritableLocalPath(file.originalPath, {
        expectedDeviceId: stagedInspection.deviceId ?? file.deviceId
      })
      if (originalInspection.state === 'unknown') {
        failures.push(`${file.originalPath}：无法确认原路径状态`)
        continue
      }
      if (originalInspection.state === 'present') {
        failures.push(`${file.originalPath}：原路径已被占用`)
        continue
      }
      try {
        renameSync(file.stagedPath, file.originalPath)
      } catch (error) {
        failures.push(`${file.originalPath}：${(error as Error).message}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(`恢复影片文件失败：${failures.join('；')}`)
    }
  }

  const stageLocalFiles = (filePaths: string[]): StagedLocalFile[] => {
    const staged: StagedLocalFile[] = []
    try {
      for (const originalPath of new Set(filePaths)) {
        const existing = readPendingFileDeletion(originalPath)
        if (existing) {
          if (existing.state === 'committed') {
            throw new Error(`影片文件已有待完成的删除任务：${originalPath}`)
          }
          const stagedInspection = inspectWritableLocalPath(existing.staged_path, {
            expectedDeviceId: existing.device_id,
            acceptPresentDeviceChange: true
          })
          if (stagedInspection.state === 'present') {
            const originalInspection = inspectWritableLocalPath(originalPath, {
              expectedDeviceId: stagedInspection.deviceId ?? existing.device_id
            })
            if (originalInspection.state === 'unknown') {
              throw new Error(`无法确认影片原路径是否可用：${originalPath}`)
            }
            if (originalInspection.state === 'present') {
              throw new Error(`影片原路径已被占用，无法继续删除：${originalPath}`)
            }
            staged.push({
              originalPath,
              stagedPath: existing.staged_path,
              deviceId: stagedInspection.deviceId ?? existing.device_id
            })
            continue
          }
          const originalInspection = inspectWritableLocalPath(originalPath, {
            expectedDeviceId: existing.device_id
          })
          if (originalInspection.state !== 'present') {
            throw new Error(
              originalInspection.state === 'unknown'
                ? `无法确认影片文件是否存在：${originalPath}`
                : `待恢复的暂存文件和原文件均不存在：${originalPath}`
            )
          }
          removePendingFileDeletions([existing.staged_path])
        }

        const originalInspection = inspectWritableLocalPath(originalPath)
        if (originalInspection.state === 'unknown') {
          throw new Error(`无法确认影片文件是否存在：${originalPath}`)
        }
        if (originalInspection.state === 'missing') continue
        if (originalInspection.deviceId == null) {
          throw new Error(`无法确认影片文件所在存储：${originalPath}`)
        }
        const stagedPath = `${originalPath}.javdex-delete-${randomUUID()}`
        preparePendingFileDeletion(originalPath, stagedPath, originalInspection.deviceId)
        staged.push({ originalPath, stagedPath, deviceId: originalInspection.deviceId })
        renameSync(originalPath, stagedPath)
      }
      return staged
    } catch (error) {
      const recoveryErrors: string[] = []
      let restored = true
      try {
        restoreStagedLocalFiles(staged)
      } catch (restoreError) {
        restored = false
        recoveryErrors.push((restoreError as Error).message)
      }
      if (restored) {
        try {
          removePendingFileDeletions(staged.map((file) => file.stagedPath))
        } catch (queueError) {
          recoveryErrors.push(`清理待删除记录失败：${(queueError as Error).message}`)
        }
      }
      const recoverySuffix = recoveryErrors.length > 0 ? `；${recoveryErrors.join('；')}` : ''
      throw new Error(`准备删除影片文件失败：${(error as Error).message}${recoverySuffix}`)
    }
  }

  const finalizeStagedLocalFiles = (files: StagedLocalFile[]): void => {
    for (const file of files) {
      try {
        unlinkSync(file.stagedPath)
      } catch (error) {
        console.error('Staged video file remains queued for deletion:', file.stagedPath, error)
        continue
      }
      try {
        removePendingFileDeletions([file.stagedPath])
      } catch (error) {
        console.error('Failed to clear completed local file deletion:', file.stagedPath, error)
      }
    }
  }

  const withStagedLocalFileDeletion = <T>(filePaths: string[], databaseChange: () => T): T => {
    const staged = stageLocalFiles(filePaths)
    try {
      const result = runDatabaseTransaction(() => {
        const value = databaseChange()
        markPendingFileDeletionsCommitted(staged.map((file) => file.stagedPath))
        return value
      })
      finalizeStagedLocalFiles(staged)
      return result
    } catch (error) {
      const recoveryErrors: string[] = []
      let restored = true
      try {
        restoreStagedLocalFiles(staged)
      } catch (restoreError) {
        restored = false
        recoveryErrors.push((restoreError as Error).message)
      }
      if (restored) {
        try {
          removePendingFileDeletions(staged.map((file) => file.stagedPath))
        } catch (queueError) {
          recoveryErrors.push(`清理待删除记录失败：${(queueError as Error).message}`)
        }
      }
      if (recoveryErrors.length > 0) {
        throw new Error(`${(error as Error).message}；${recoveryErrors.join('；')}`)
      }
      throw error
    }
  }

  const deleteWholeVideo = (id: number): boolean => {
    if (!readVideoById(id)) throw new Error('影片不存在')
    runInCoordinatedChange(() => {
      const resources = readVideoResources(id)
      const result = withStagedLocalFileDeletion(
        resources.filter((resource) => resource.kind === 'local').map((resource) => resource.locator),
        () => purgeVideoRecord(id)
      )
      for (const assetPath of result.obsoletePaths) deleteBestEffort(assetPath)
    })
    return true
  }

  const removeResource = (
    videoId: number,
    resourceId: number,
    lastResourceMode?: LastVideoResourceRemovalMode
  ): VideoResourceRemovalResult => {
    if (!readVideoById(videoId)) throw new Error('影片不存在')
    const resource = readVideoResourceById(resourceId)
    if (!resource || resource.video_id !== videoId) throw new Error('资源不属于当前影片')
    const resources = readVideoResources(videoId)
    if (resources.length === 1) {
      if (!lastResourceMode) {
        throw new Error('正在移除最后一个资源，请选择保留影片元数据或删除影片')
      }
      if (lastResourceMode === 'delete-video') {
        deleteWholeVideo(videoId)
        return { videoDeleted: true, promotedResourceId: null }
      }
    }

    let promotedResourceId: number | null = null
    runInCoordinatedChange(() => {
      withStagedLocalFileDeletion(resource.kind === 'local' ? [resource.locator] : [], () => {
        removeResourceRecord(resourceId)
        if (resource.is_primary) {
          const candidate = selectPrimaryVideoResourceCandidate(
            resources.filter((item) => item.id !== resourceId),
            fileExists
          )
          if (candidate) {
            writePrimaryResource(videoId, candidate.id)
            promotedResourceId = candidate.id
          }
        }
      })
    })
    return { videoDeleted: false, promotedResourceId }
  }

  return {
    update(id, fields): boolean {
      writeVideoFields(id, fields)
      return true
    },
    edit(id, input): boolean {
      const video = readVideoById(id)
      if (!video) throw new Error('Video not found')

      runInCoordinatedChange(() => {
        const coverRelPath = input.coverSourcePath
          ? importCover(video.code, input.coverSourcePath)
          : undefined
        let result: { obsoletePaths: string[] } = { obsoletePaths: [] }
        getDb().transaction(() => {
          result = writeVideoRecord(id, input, coverRelPath)
          if ('makerOrganization' in input) {
            assignVideoOrganization(id, 'maker', input.makerOrganization ?? null)
          }
          if ('publisherOrganization' in input) {
            assignVideoOrganization(id, 'publisher', input.publisherOrganization ?? null)
          }
          if ('directorAssignment' in input) {
            assignVideoDirector(id, input.directorAssignment ?? null)
          }
          if ('seriesAssignment' in input) {
            assignVideoSeries(id, input.seriesAssignment ?? null)
          }
        })()
        for (const assetPath of result.obsoletePaths) {
          deleteBestEffort(assetPath)
        }
      })
      return true
    },
    clearMetadata(id): boolean {
      const video = readVideoById(id)
      if (!video) return true

      runInCoordinatedChange(() => {
        const result = clearMetadataRecord(id)
        for (const assetPath of new Set([...result.obsoletePaths, video.cover_path])) {
          deleteBestEffort(assetPath)
        }
      })
      return true
    },
    markScrapeSucceeded(id): boolean {
      const video = readVideoById(id)
      if (!video) throw new Error('Video not found')
      recordScrapeSucceeded(id)
      return true
    },
    delete(id): boolean {
      return withResourceMaintenance(() => deleteWholeVideo(id))
    },
    setRating(id, ratingValue): boolean {
      writeRating(id, ratingValue)
      return true
    },
    correctImport(id, codeRaw): CorrectImportResult {
      const newCode = normalizeVideoCode(codeRaw)

      const video = readVideoById(id)
      if (!video) throw new Error('Video not found')

      if (newCode === video.code) {
        return { code: newCode, previousCode: video.code }
      }

      const existing = readVideoByCode(newCode)
      if (existing && existing.id !== id) {
        const primary = readPrimaryVideoResource(existing.id)
        const canReplacePrimary =
          !primary || (primary.kind === 'local' && !fileExists(primary.locator))
        if (canReplacePrimary) {
          if (primary) removeResourceRecord(primary.id)
          mergeIntoExistingCode(id, existing.id)
          return { code: newCode, previousCode: video.code, mergedIntoId: existing.id }
        }
        throw new Error(`番号 ${newCode} 已存在且仍有可用主资源`)
      }

      renameCode(id, newCode)
      return { code: newCode, previousCode: video.code }
    },
    async importSample(id, input): Promise<VideoAsset> {
      const video = readVideoById(id)
      if (!video) throw new Error('Video not found')

      if (input.source === 'file') {
        const sourcePath = input.sourcePath?.trim()
        if (!sourcePath) throw new Error('请选择本地图片文件')
        return coordinateDatabaseChange(() => {
          const localPath = importSampleAsset(video.code, sourcePath)
          return addSampleAsset(id, { localPath })
        })
      }

      const rawUrl = input.remoteUrl?.trim()
      if (!rawUrl) throw new Error('请输入样张链接')
      let parsed: URL
      try {
        parsed = new URL(rawUrl)
      } catch {
        throw new Error('样张链接格式不正确')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('样张链接仅支持 http/https')
      }
      const remoteUrl = parsed.toString()
      return coordinateDatabaseChange(async () => {
        const buf = await fetchRemoteBuffer(remoteUrl)
        const [localPath] = await downloadSamples(video.code, [remoteUrl], async () => buf)
        if (!localPath) throw new Error('样张链接下载失败')
        return addSampleAsset(id, { remoteUrl, localPath })
      })
    },
    deleteSample(id, assetId): boolean {
      runInCoordinatedChange(() => {
        const result = deleteSampleAsset(id, assetId)
        for (const localPath of result.obsoletePaths) deleteBestEffort(localPath)
      })
      return true
    },
    setPoster(id, posterPath): boolean {
      writePoster(id, posterPath)
      return true
    },
    addManualTag(id, name): boolean {
      if (!readVideoById(id)) throw new Error('Video not found')
      writeManualTag(id, name)
      return true
    },
    removeManualTag(id, tagId): boolean {
      if (!readVideoById(id)) throw new Error('Video not found')
      deleteManualTag(id, tagId)
      return true
    },
    importLinkResource(input): VideoResourceImportResult {
      return withResourceMaintenance(() => {
        const code = normalizeVideoCode(input.code)
        const normalized = normalizeExternalVideoResource(input.url, input.kind)
        const displayName = input.displayName?.trim() || normalized.suggestedDisplayName
        const sizeBytes = input.sizeBytes ?? null
        if (sizeBytes != null && (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0)) {
          throw new Error('文件大小必须是大于 0 的整数字节数')
        }
        const result = importLinkResourceRecord({
          code,
          kind: normalized.kind,
          locator: normalized.locator,
          resourceKey: normalized.resourceKey,
          displayName,
          sizeBytes
        })
        if ('duplicateOwnerCode' in result) {
          throw new Error(`该资源链接已属于影片 ${result.duplicateOwnerCode}`)
        }
        return result
      })
    },
    checkLinkResource(url): Promise<VideoResourceLinkCheckResult> {
      return checkLinkResource(url)
    },
    updateLinkResource(videoId, resourceId, input): VideoResource {
      return withResourceMaintenance(() => {
        if (!readVideoById(videoId)) throw new Error('影片不存在')
        const normalized = normalizeExternalVideoResource(input.url, input.kind)
        const sizeBytes = input.sizeBytes ?? null
        if (sizeBytes != null && (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0)) {
          throw new Error('文件大小必须是大于 0 的整数字节数')
        }
        const result = updateLinkResourceRecord({
          resourceId,
          videoId,
          kind: normalized.kind,
          locator: normalized.locator,
          resourceKey: normalized.resourceKey,
          displayName: input.displayName?.trim() || normalized.suggestedDisplayName,
          sizeBytes
        })
        if ('duplicateOwnerCode' in result) {
          throw new Error(`该资源链接已属于影片 ${result.duplicateOwnerCode}`)
        }
        return result
      })
    },
    updateLocalResourceLabel(videoId, resourceId, label): VideoResource {
      return withResourceMaintenance(() => {
        if (!readVideoById(videoId)) throw new Error('影片不存在')
        return writeLocalResourceLabel(videoId, resourceId, label?.trim() || null)
      })
    },
    setPrimaryResource(videoId, resourceId): boolean {
      return withResourceMaintenance(() => {
        if (!readVideoById(videoId)) throw new Error('影片不存在')
        writePrimaryResource(videoId, resourceId)
        return true
      })
    },
    removeResource(videoId, resourceId, lastResourceMode): VideoResourceRemovalResult {
      return withResourceMaintenance(() =>
        removeResource(videoId, resourceId, lastResourceMode)
      )
    }
  }
}

export const videoMaintenanceService = createVideoMaintenanceService()
