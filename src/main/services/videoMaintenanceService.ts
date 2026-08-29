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
  VideoSampleImportInput,
  VideoMergeInput,
  VideoMergeResult,
  VideoResourceSplitResult
} from '@shared/videoTypes'
import {
  addManualVideoTag,
  addVideoSampleAsset,
  clearVideoMetadataRecord,
  deleteVideoSampleAsset,
  editVideoRecord,
  getVideoById,
  getVideoResourceById,
  getVideoResourceInLibrary,
  importVideoLinkResourceRecord,
  updateVideoLinkResourceRecord,
  updateStrmVideoResourceMetadata,
  listVideoResources,
  listVideoResourcesAcrossLibraries,
  markScrapeSucceeded,
  mergeVideoRecords,
  removeManualVideoTag,
  removeVideoResourceRecord,
  renameVideoCode,
  setPrimaryVideoResource,
  setRating,
  setVideoPosterPath,
  splitVideoResourceRecord,
  updateLocalVideoResourceLabel,
  updateVideoFields,
  hasPendingVideoScrape
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
import { deletePendingVideoScrapeForVideo } from '../db/pendingVideoScrapeRepo'
import { getMediaLibrary, getMediaLibraryRoot } from '../db/mediaLibraryRepo'
import { assertMediaLibraryRootDeletionTarget } from './mediaLibraryRootFileGuard'

export interface VideoMaintenanceService {
  update(id: number, fields: VideoFieldUpdateInput): boolean
  edit(id: number, input: VideoEditInput): boolean
  clearMetadata(id: number): boolean
  markScrapeSucceeded(id: number): boolean
  setRating(id: number, rating: number): boolean
  correctImport(id: number, code: string, discardPendingScrape?: boolean): CorrectImportResult
  importSample(id: number, input: VideoSampleImportInput): Promise<VideoAsset>
  deleteSample(id: number, assetId: number): boolean
  setPoster(id: number, posterPath: string | null): boolean
  addManualTag(id: number, name: string): boolean
  removeManualTag(id: number, tagId: number): boolean
  importLinkResource(input: VideoLinkResourceImportInput): VideoResourceImportResult
  checkLinkResource(url: string): Promise<VideoResourceLinkCheckResult>
  updateLinkResource(
    libraryId: number,
    videoId: number,
    resourceId: number,
    input: VideoLinkResourceUpdateInput
  ): VideoResource
  updateLocalResourceLabel(
    libraryId: number,
    videoId: number,
    resourceId: number,
    label: string | null
  ): VideoResource
  setPrimaryResource(libraryId: number, videoId: number, resourceId: number): boolean
  removeResource(
    libraryId: number,
    videoId: number,
    resourceId: number,
    lastResourceMode?: LastVideoResourceRemovalMode
  ): VideoResourceRemovalResult
  mergeVideos(input: VideoMergeInput): VideoMergeResult
  splitResource(libraryId: number, videoId: number, resourceId: number): VideoResourceSplitResult
  runWithManagedSourceFileDeletion<T>(resources: readonly VideoResource[], work: () => T): T
}

interface VideoMaintenanceServiceDependencies {
  getVideoById: typeof getVideoById
  updateVideoFields: typeof updateVideoFields
  editVideoRecord: typeof editVideoRecord
  clearVideoMetadataRecord: typeof clearVideoMetadataRecord
  markScrapeSucceeded: typeof markScrapeSucceeded
  setRating: typeof setRating
  renameVideoCode: typeof renameVideoCode
  mergeVideoRecords: typeof mergeVideoRecords
  splitVideoResourceRecord: typeof splitVideoResourceRecord
  hasPendingVideoScrape: typeof hasPendingVideoScrape
  deletePendingVideoScrapeForVideo: typeof deletePendingVideoScrapeForVideo
  addVideoSampleAsset: typeof addVideoSampleAsset
  deleteVideoSampleAsset: typeof deleteVideoSampleAsset
  setVideoPosterPath: typeof setVideoPosterPath
  addManualVideoTag: typeof addManualVideoTag
  removeManualVideoTag: typeof removeManualVideoTag
  importVideoLinkResourceRecord: typeof importVideoLinkResourceRecord
  checkLinkResource: typeof videoResourceLinkService.check
  updateVideoLinkResourceRecord: typeof updateVideoLinkResourceRecord
  updateStrmVideoResourceMetadata: typeof updateStrmVideoResourceMetadata
  getVideoResourceById: typeof getVideoResourceById
  getVideoResourceInLibrary: typeof getVideoResourceInLibrary
  listVideoResources: typeof listVideoResources
  listVideoResourcesAcrossLibraries: typeof listVideoResourcesAcrossLibraries
  setPrimaryVideoResource: typeof setPrimaryVideoResource
  updateLocalVideoResourceLabel: typeof updateLocalVideoResourceLabel
  removeVideoResourceRecord: typeof removeVideoResourceRecord
  runInCoordinatedChange: typeof mediaAssetStore.runInCoordinatedChange
  coordinateDatabaseChange: typeof mediaAssetStore.coordinateDatabaseChange
  importCover: typeof mediaAssetStore.importCover
  importSample: typeof mediaAssetStore.importSample
  downloadSamples: typeof mediaAssetStore.downloadSamples
  deleteBestEffort: typeof mediaAssetStore.deleteBestEffort
  cleanupVideoScrapeStagingPaths: typeof mediaAssetStore.cleanupVideoScrapeStagingPaths
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
  getMediaLibrary: typeof getMediaLibrary
  getMediaLibraryRoot: typeof getMediaLibraryRoot
  assignVideoOrganization: typeof classificationMaintenanceService.assignVideoOrganization
  assignVideoDirector: typeof classificationMaintenanceService.assignVideoDirector
  assignVideoSeries: typeof classificationMaintenanceService.assignVideoSeries
}

export function createVideoMaintenanceService(
  dependencies: Partial<VideoMaintenanceServiceDependencies> = {}
): VideoMaintenanceService {
  const readVideoById = dependencies.getVideoById ?? getVideoById
  const writeVideoFields = dependencies.updateVideoFields ?? updateVideoFields
  const writeVideoRecord = dependencies.editVideoRecord ?? editVideoRecord
  const clearMetadataRecord = dependencies.clearVideoMetadataRecord ?? clearVideoMetadataRecord
  const recordScrapeSucceeded = dependencies.markScrapeSucceeded ?? markScrapeSucceeded
  const writeRating = dependencies.setRating ?? setRating
  const renameCode = dependencies.renameVideoCode ?? renameVideoCode
  const mergeRecords = dependencies.mergeVideoRecords ?? mergeVideoRecords
  const splitResourceRecord = dependencies.splitVideoResourceRecord ?? splitVideoResourceRecord
  const readHasPendingVideoScrape =
    dependencies.hasPendingVideoScrape ?? hasPendingVideoScrape
  const deletePendingScrapeForVideo =
    dependencies.deletePendingVideoScrapeForVideo ?? deletePendingVideoScrapeForVideo
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
  const updateStrmResourceMetadata =
    dependencies.updateStrmVideoResourceMetadata ?? updateStrmVideoResourceMetadata
  const readVideoResourceInLibrary =
    dependencies.getVideoResourceInLibrary ?? getVideoResourceInLibrary
  const readVideoResources = dependencies.listVideoResources ?? listVideoResources
  const readVideoResourcesAcrossLibraries =
    dependencies.listVideoResourcesAcrossLibraries ?? listVideoResourcesAcrossLibraries
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
  const cleanupVideoScrapeStagingPaths =
    dependencies.cleanupVideoScrapeStagingPaths ??
    mediaAssetStore.cleanupVideoScrapeStagingPaths.bind(mediaAssetStore)
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
  const readMediaLibrary = dependencies.getMediaLibrary ?? getMediaLibrary
  const readMediaLibraryRoot = dependencies.getMediaLibraryRoot ?? getMediaLibraryRoot
  const assignVideoOrganization =
    dependencies.assignVideoOrganization ?? classificationMaintenanceService.assignVideoOrganization
  const assignVideoDirector =
    dependencies.assignVideoDirector ?? classificationMaintenanceService.assignVideoDirector
  const assignVideoSeries =
    dependencies.assignVideoSeries ?? classificationMaintenanceService.assignVideoSeries

  const assertMetadataUnlocked = (videoId: number): void => {
    if (readHasPendingVideoScrape(videoId)) {
      throw new Error('影片存在待确认刮削结果，请先选择或丢弃候选')
    }
  }

  const videoEditMutatesLockedMetadata = (input: VideoEditInput): boolean =>
    Object.keys(input).some((key) => key !== 'links')

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

  const stageLocalFiles = (
    filePaths: string[],
    assertDeletionAllowed: (filePath: string) => void
  ): StagedLocalFile[] => {
    const staged: StagedLocalFile[] = []
    try {
      for (const originalPath of new Set(filePaths)) {
        assertDeletionAllowed(originalPath)
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
        assertDeletionAllowed(originalPath)
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

  const finalizeStagedLocalFiles = (
    files: StagedLocalFile[],
    assertDeletionAllowed: (filePath: string) => void
  ): void => {
    for (const file of files) {
      try {
        assertDeletionAllowed(file.stagedPath)
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

  const withStagedLocalFileDeletion = <T>(
    filePaths: string[],
    assertDeletionAllowed: (filePath: string) => void,
    databaseChange: () => T
  ): T => {
    const staged = stageLocalFiles(filePaths, assertDeletionAllowed)
    try {
      const result = runDatabaseTransaction(() => {
        const value = databaseChange()
        markPendingFileDeletionsCommitted(staged.map((file) => file.stagedPath))
        return value
      })
      finalizeStagedLocalFiles(staged, assertDeletionAllowed)
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

  const requireActiveMediaLibrary = (libraryId: number): void => {
    const library = readMediaLibrary(libraryId)
    if (!library) throw new Error('媒体库不存在')
    if (library.status !== 'active') {
      throw new Error('已归档媒体库必须恢复后才能修改资源')
    }
  }

  const removeResource = (
    libraryId: number,
    videoId: number,
    resourceId: number,
    lastResourceMode?: LastVideoResourceRemovalMode
  ): VideoResourceRemovalResult => {
    requireActiveMediaLibrary(libraryId)
    if (!readVideoById(videoId)) throw new Error('影片不存在')
    const resource = readVideoResourceInLibrary(libraryId, resourceId)
    if (!resource || resource.video_id !== videoId) throw new Error('资源不属于当前影片')
    const resources = readVideoResources(libraryId, videoId)
    if (resources.length === 1) {
      if (!lastResourceMode) {
        throw new Error('正在移除最后一个资源，请选择保留影片元数据或删除影片')
      }
      if (lastResourceMode !== 'retain-video') {
        throw new Error('全局删除必须先预览影响并通过影片生命周期命令确认')
      }
    }

    let promotedResourceId: number | null = null
    runInCoordinatedChange(() => {
      const sourcePaths =
        resource.kind === 'local'
          ? [resource.locator]
          : resource.strm_source_path
            ? [resource.strm_source_path]
            : []
      const root =
        sourcePaths.length === 0 || resource.root_id == null
          ? null
          : readMediaLibraryRoot(libraryId, resource.root_id)
      if (sourcePaths.length > 0 && !root) {
        throw new Error('影片源文件缺少有效的媒体库根目录归属，无法安全删除')
      }
      const assertDeletionAllowed = (filePath: string): void => {
        if (!root) throw new Error('影片源文件缺少有效的媒体库根目录归属，无法安全删除')
        assertMediaLibraryRootDeletionTarget(filePath, root)
      }
      withStagedLocalFileDeletion(sourcePaths, assertDeletionAllowed, () => {
        removeResourceRecord(libraryId, resourceId)
        if (resource.is_primary) {
          const candidate = selectPrimaryVideoResourceCandidate(
            resources.filter((item) => item.id !== resourceId),
            fileExists
          )
          if (candidate) {
            writePrimaryResource(libraryId, videoId, candidate.id)
            promotedResourceId = candidate.id
          }
        }
      })
    })
    return { videoDeleted: false, promotedResourceId }
  }

  return {
    update(id, fields): boolean {
      assertMetadataUnlocked(id)
      writeVideoFields(id, fields)
      return true
    },
    edit(id, input): boolean {
      const video = readVideoById(id)
      if (!video) throw new Error('Video not found')
      if (videoEditMutatesLockedMetadata(input)) {
        assertMetadataUnlocked(id)
      }

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
      assertMetadataUnlocked(id)

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
      assertMetadataUnlocked(id)
      recordScrapeSucceeded(id)
      return true
    },
    setRating(id, ratingValue): boolean {
      assertMetadataUnlocked(id)
      writeRating(id, ratingValue)
      return true
    },
    correctImport(id, codeRaw, discardPendingScrape = false): CorrectImportResult {
      const newCode = normalizeVideoCode(codeRaw)

      const video = readVideoById(id)
      if (!video) throw new Error('Video not found')

      if (newCode === video.code) {
        return { code: newCode, previousCode: video.code }
      }

      if (readHasPendingVideoScrape(id) && !discardPendingScrape) {
        return { code: newCode, previousCode: video.code, pendingDiscardRequired: true }
      }
      let stagedPaths: string[] = []
      runDatabaseTransaction(() => {
        if (discardPendingScrape) {
          stagedPaths = deletePendingScrapeForVideo(id)?.stagedPaths ?? []
        }
        renameCode(id, newCode)
      })
      cleanupVideoScrapeStagingPaths(stagedPaths)
      return { code: newCode, previousCode: video.code }
    },
    async importSample(id, input): Promise<VideoAsset> {
      const video = readVideoById(id)
      if (!video) throw new Error('Video not found')
      assertMetadataUnlocked(id)

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
      assertMetadataUnlocked(id)
      runInCoordinatedChange(() => {
        const result = deleteSampleAsset(id, assetId)
        for (const localPath of result.obsoletePaths) deleteBestEffort(localPath)
      })
      return true
    },
    setPoster(id, posterPath): boolean {
      assertMetadataUnlocked(id)
      writePoster(id, posterPath)
      return true
    },
    addManualTag(id, name): boolean {
      if (!readVideoById(id)) throw new Error('Video not found')
      assertMetadataUnlocked(id)
      writeManualTag(id, name)
      return true
    },
    removeManualTag(id, tagId): boolean {
      if (!readVideoById(id)) throw new Error('Video not found')
      assertMetadataUnlocked(id)
      deleteManualTag(id, tagId)
      return true
    },
    importLinkResource(input): VideoResourceImportResult {
      return withResourceMaintenance(() => {
        requireActiveMediaLibrary(input.libraryId)
        const code = normalizeVideoCode(input.code)
        const normalized = normalizeExternalVideoResource(input.url, input.kind)
        const displayName = input.displayName?.trim() || normalized.suggestedDisplayName
        const sizeBytes = input.sizeBytes ?? null
        if (sizeBytes != null && (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0)) {
          throw new Error('文件大小必须是大于 0 的整数字节数')
        }
        const result = importLinkResourceRecord({
          libraryId: input.libraryId,
          code,
          target: input.target,
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
    updateLinkResource(libraryId, videoId, resourceId, input): VideoResource {
      return withResourceMaintenance(() => {
        requireActiveMediaLibrary(libraryId)
        if (!readVideoById(videoId)) throw new Error('影片不存在')
        const normalized = normalizeExternalVideoResource(input.url, input.kind)
        const sizeBytes = input.sizeBytes ?? null
        if (sizeBytes != null && (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0)) {
          throw new Error('文件大小必须是大于 0 的整数字节数')
        }
        const existing = readVideoResourceInLibrary(libraryId, resourceId)
        if (!existing || existing.video_id !== videoId || existing.kind === 'local') {
          throw new Error('影片链接资源不存在')
        }
        if (existing.strm_source_path) {
          if (existing.kind !== normalized.kind || existing.locator !== normalized.locator) {
            throw new Error('STRM 资源目标与类型由源文件管理，只读不可修改')
          }
          return updateStrmResourceMetadata({
            libraryId,
            resourceId,
            videoId,
            displayName: input.displayName?.trim() || null,
            sizeBytes
          })
        }
        const result = updateLinkResourceRecord({
          libraryId,
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
    updateLocalResourceLabel(libraryId, videoId, resourceId, label): VideoResource {
      return withResourceMaintenance(() => {
        requireActiveMediaLibrary(libraryId)
        if (!readVideoById(videoId)) throw new Error('影片不存在')
        return writeLocalResourceLabel(
          libraryId,
          videoId,
          resourceId,
          label?.trim() || null
        )
      })
    },
    setPrimaryResource(libraryId, videoId, resourceId): boolean {
      return withResourceMaintenance(() => {
        requireActiveMediaLibrary(libraryId)
        if (!readVideoById(videoId)) throw new Error('影片不存在')
        writePrimaryResource(libraryId, videoId, resourceId)
        return true
      })
    },
    removeResource(libraryId, videoId, resourceId, lastResourceMode): VideoResourceRemovalResult {
      return withResourceMaintenance(() =>
        removeResource(libraryId, videoId, resourceId, lastResourceMode)
      )
    },
    mergeVideos(input): VideoMergeResult {
      return withResourceMaintenance(() => {
        const resources = [
          ...readVideoResourcesAcrossLibraries(input.retainedVideoId),
          ...readVideoResourcesAcrossLibraries(input.sourceVideoId)
        ]
        const hasPrimary = resources.some((resource) => Boolean(resource.is_primary))
        const fallbackPrimaryResourceId = hasPrimary
          ? undefined
          : selectPrimaryVideoResourceCandidate(resources, fileExists)?.id ?? null
        const result = mergeRecords(input, {
          ...(hasPrimary ? {} : { fallbackPrimaryResourceId })
        })
        for (const path of result.obsoletePaths) deleteBestEffort(path)
        return {
          retainedVideoId: result.retainedVideoId,
          deletedVideoId: result.deletedVideoId
        }
      })
    },
    splitResource(libraryId, videoId, resourceId): VideoResourceSplitResult {
      return withResourceMaintenance(() => {
        requireActiveMediaLibrary(libraryId)
        return splitResourceRecord(libraryId, videoId, resourceId)
      })
    },
    runWithManagedSourceFileDeletion(resources, work) {
      const rootsByOriginalPath = new Map<string, NonNullable<ReturnType<typeof readMediaLibraryRoot>>>()
      const filePaths: string[] = []
      for (const resource of resources) {
        const filePath =
          resource.kind === 'local' ? resource.locator : resource.strm_source_path
        if (!filePath) continue
        if (resource.root_id == null) {
          throw new Error('影片源文件缺少有效的媒体库根目录归属，无法安全删除')
        }
        requireActiveMediaLibrary(resource.library_id)
        const root = readMediaLibraryRoot(resource.library_id, resource.root_id)
        if (!root) {
          throw new Error('影片源文件缺少有效的媒体库根目录归属，无法安全删除')
        }
        assertMediaLibraryRootDeletionTarget(filePath, root)
        if (!rootsByOriginalPath.has(filePath)) {
          rootsByOriginalPath.set(filePath, root)
          filePaths.push(filePath)
        }
      }
      const rootForPath = (filePath: string) => {
        const exact = rootsByOriginalPath.get(filePath)
        if (exact) return exact
        for (const [original, root] of rootsByOriginalPath) {
          if (filePath.startsWith(`${original}.javdex-delete-`)) return root
        }
        throw new Error('影片源文件缺少有效的媒体库根目录归属，无法安全删除')
      }
      return withStagedLocalFileDeletion(
        filePaths,
        (filePath) => assertMediaLibraryRootDeletionTarget(filePath, rootForPath(filePath)),
        work
      )
    }
  }
}

export const videoMaintenanceService = createVideoMaintenanceService()
