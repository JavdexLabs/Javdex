import fs from 'node:fs'
import path from 'node:path'
import { isVideoFile, parseCode } from './codeParser'
import {
  backfillLocalVideoResourceFingerprint,
  getVideoByCode,
  getLocalVideoResourceByLocator,
  getStrmVideoResourceBySourcePath,
  getPreferredLocalVideoResource,
  insertLocalVideoResource,
  insertNewScannedStrmVideo,
  insertNewScannedVideo,
  insertScannedVideo,
  listStrmVideoResourceRefs,
  listVideosByCode,
  listVideoResources,
  localVideoResourceExistsByLocator,
  relocateLocalVideoResource,
  relocateLocalVideoResourceById,
  relocateStrmVideoResource,
  setPrimaryVideoResource,
  updateStrmVideoResourceTarget,
  insertStrmVideoResource,
  updateLocalVideoResourceAfterProbe
} from '../db/videoRepo'
import type {
  ManualImportResult,
  RenameImportResult,
  ScanProgress,
  ScanResult,
  StrmScanFailure
} from '@shared/libraryTypes'
import type { ScannedVideoInput, StrmVideoResourceRef } from '../db/videoRepo'
import type {
  LocalVideoResource,
  VideoResourceImportTarget
} from '@shared/videoTypes'
import {
  isBelowMinImportDuration,
  readLocalVideoDurationSeconds,
  resolveMinScanImportDurationSeconds,
  shouldProbeLocalVideoResourceDuration,
  shouldRefreshLocalVideoResourceDuration,
  type VideoFileFingerprint
} from './videoDuration'
import { getSettings } from '../settings/settingsStore'
import { isPathUnderRoot } from './libraryPathUtils'
import { normalizeVideoCode } from '@shared/videoCode'
import {
  pendingScanResourceExists,
  removePendingScanResource,
  upsertPendingScanResources
} from '../db/pendingScanRepo'
import {
  StrmParseError,
  isStrmFile,
  readStrmFile,
  type ParsedStrmTarget
} from './strmParser'
import { normalizeExternalVideoResource } from '@shared/videoResourceLinks'
import { normalizeLocalPathIdentity } from '@shared/localPathIdentity'
import { selectDefaultPendingScanPrimary } from '@shared/pendingScanPrimary'

export type ScanProgressFn = (progress: ScanProgress) => void

export interface ScanOptions {
  yieldEvery?: number
  signal?: AbortSignal
  /** Override duration probe (tests). Defaults to reading container metadata. */
  readDurationSeconds?: (filePath: string) => Promise<number | null>
  /** Minimum seconds required to import during scan; null disables the filter. */
  minImportDurationSeconds?: number | null
  /** Missing resources below these temporarily unavailable roots must not be relocated. */
  unavailableRoots?: string[]
  /** Override directory reads (tests). Read failures abort cleanup-safe scans. */
  readDirectory?: (dir: string) => Promise<fs.Dirent[]>
  /** Override local resource inspection (tests). */
  inspectPath?: (filePath: string) => 'present' | 'missing' | 'unknown'
  /** Override same-code resource auto-assignment (tests). */
  autoMergeSameCodeResources?: boolean
}

const DEFAULT_YIELD_EVERY = 50

function inspectScannedResourcePath(filePath: string): 'present' | 'missing' | 'unknown' {
  try {
    fs.statSync(filePath)
    return 'present'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown'
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function maybeYield(count: number, yieldEvery: number): Promise<void> {
  if (count % yieldEvery === 0) {
    await yieldToEventLoop()
  }
}

/** Recursively collect local video and STRM source paths under a directory. */
async function collectScannableFiles(
  dir: string,
  acc: string[],
  signal: AbortSignal | undefined,
  readDirectory: (dir: string) => Promise<fs.Dirent[]>
): Promise<void> {
  if (signal?.aborted) return
  let entries: fs.Dirent[]
  try {
    entries = await readDirectory(dir)
  } catch (error) {
    throw new Error(`无法读取媒体目录 ${dir}：${(error as Error).message}`)
  }
  for (const entry of entries) {
    if (signal?.aborted) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectScannableFiles(full, acc, signal, readDirectory)
    } else if (entry.isFile() && (isVideoFile(full) || isStrmFile(full))) {
      acc.push(full)
    } else if (entry.isSymbolicLink() && (isVideoFile(full) || isStrmFile(full))) {
      try {
        const target = await fs.promises.stat(full)
        if (target.isFile()) acc.push(full)
      } catch {
        // Broken or inaccessible symbolic link — skip.
      }
    }
  }
}

type PreparedStrm =
  | { ok: true; target: ParsedStrmTarget }
  | { ok: false; failure: StrmScanFailure }

function readStrmTarget(sourcePath: string): PreparedStrm {
  try {
    return { ok: true, target: readStrmFile(sourcePath) }
  } catch (error) {
    if (error instanceof StrmParseError) {
      return {
        ok: false,
        failure: { sourcePath, code: error.code, message: error.message }
      }
    }
    return {
      ok: false,
      failure: { sourcePath, code: 'read_failed', message: '无法读取 STRM 文件' }
    }
  }
}

function targetKeyForStrmResource(resource: StrmVideoResourceRef): string | null {
  try {
    return normalizeExternalVideoResource(resource.locator, resource.kind).resourceKey
  } catch {
    return null
  }
}

function findStrmRelocationCandidate(
  sourcePath: string,
  targetKey: string,
  unavailableRoots: string[],
  inspectPath: (filePath: string) => 'present' | 'missing' | 'unknown'
): StrmVideoResourceRef | null {
  const sourceName = path.basename(sourcePath)
  const candidates = listStrmVideoResourceRefs()
    .filter((resource) => {
      const oldSourcePath = resource.source_path
      if (path.basename(oldSourcePath) !== sourceName) return false
      if (unavailableRoots.some((root) => isPathUnderRoot(oldSourcePath, root))) return false
      if (inspectPath(oldSourcePath) !== 'missing') return false
      return targetKeyForStrmResource(resource) === targetKey
    })
  return candidates.length === 1 ? candidates[0] : null
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

export function statFileFingerprint(filePath: string): VideoFileFingerprint | null {
  try {
    const stat = fs.statSync(filePath)
    return { file_size: stat.size, file_mtime_ms: Math.round(stat.mtimeMs) }
  } catch {
    return null
  }
}

type DurationReader = (filePath: string) => Promise<number | null>

async function resolveImportDurationSeconds(
  file: string,
  readDurationSeconds: DurationReader,
  cached?: number | null
): Promise<number | null> {
  if (cached !== undefined) return cached
  return readDurationSeconds(file)
}

function buildScannedVideoImport(
  code: string,
  file: string,
  fileDurationSeconds: number | null,
  fingerprint: VideoFileFingerprint | null
): ScannedVideoInput {
  return {
    code,
    locator: file,
    size_bytes: fingerprint?.file_size ?? null,
    duration_seconds: fileDurationSeconds,
    file_mtime_ms: fingerprint?.file_mtime_ms ?? null
  }
}

function scanRootForFile(file: string, folders: string[]): string {
  return (
    [...folders]
      .filter((folder) => isPathUnderRoot(file, folder))
      .sort((left, right) => right.length - left.length)[0] ?? path.dirname(file)
  )
}

function findRelocationCandidate(
  videos: Array<{ id: number }>,
  file: string,
  sizeBytes: number | null,
  unavailableRoots: string[],
  inspectPath: (filePath: string) => 'present' | 'missing' | 'unknown'
): LocalVideoResource | null {
  if (sizeBytes == null) return null
  const newName = path.basename(file)
  const localResources = videos.flatMap((video) =>
    listVideoResources(video.id)
      .filter((resource): resource is LocalVideoResource => resource.kind === 'local')
  )
  const auditable = localResources.filter(
    (resource) => !unavailableRoots.some((root) => isPathUnderRoot(resource.locator, root))
  )
  const missing = auditable.filter((resource) => inspectPath(resource.locator) === 'missing')
  const matches = missing.filter((resource) => {
    if (resource.size_bytes !== sizeBytes) return false
    return videos.length === 1 || path.basename(resource.locator) === newName
  })
  return matches.length === 1 ? matches[0] : null
}

function resolveRefreshTarget(file: string): LocalVideoResource | null {
  const existingResource = getLocalVideoResourceByLocator(file)
  if (existingResource) return existingResource

  const base = path.basename(file, path.extname(file))
  const code = parseCode(base)
  if (!code) return null
  const video = getVideoByCode(code)
  if (!video) return null
  const localResource = getPreferredLocalVideoResource(video.id)
  if (localResource && samePath(localResource.locator, file)) return localResource
  return null
}

async function refreshScannedFileDuration(
  file: string,
  readDurationSeconds: DurationReader
): Promise<boolean> {
  const fingerprint = statFileFingerprint(file)
  if (!fingerprint) return false

  const record = resolveRefreshTarget(file)
  if (!record) return false

  if (!shouldProbeLocalVideoResourceDuration(record, fingerprint)) {
    if (record.file_mtime_ms == null) {
      backfillLocalVideoResourceFingerprint(record.id, {
        sizeBytes: fingerprint.file_size,
        fileMtimeMs: fingerprint.file_mtime_ms
      })
      return true
    }
    return false
  }

  const fileDurationSeconds = await readDurationSeconds(file)
  if (fileDurationSeconds == null || fileDurationSeconds <= 0) return false

  const nextDuration = shouldRefreshLocalVideoResourceDuration(
    record.duration_seconds,
    fileDurationSeconds
  )
    ? fileDurationSeconds
    : record.duration_seconds

  updateLocalVideoResourceAfterProbe(record.id, {
    durationSeconds: nextDuration,
    sizeBytes: fingerprint.file_size,
    fileMtimeMs: fingerprint.file_mtime_ms
  })
  return true
}

/**
 * Scan the given folders, parse codes, and add or refresh local video resources.
 * Missing-resource reconciliation is owned by the scan coordinator so it can
 * distinguish accessible folders from offline folders.
 */
export async function scanFolders(
  folders: string[],
  onProgress?: ScanProgressFn,
  options: ScanOptions = {}
): Promise<ScanResult> {
  const result: ScanResult = {
    scannedFiles: 0,
    imported: 0,
    skipped: 0,
    skippedShort: 0,
    failed: 0,
    pendingGroups: 0,
    pendingResources: 0,
    relocated: 0,
    refreshed: 0,
    removed: 0,
    promoted: 0,
    deletedVideos: 0,
    offlineFolders: [],
    newCodes: [],
    unrecognizedFiles: [],
    strmFailures: [],
    omittedStrmFailures: 0
  }

  const filePaths: string[] = []
  const readDirectory =
    options.readDirectory ??
    ((dir: string) => fs.promises.readdir(dir, { withFileTypes: true }))
  const inspectPath = options.inspectPath ?? inspectScannedResourcePath
  for (const folder of folders) {
    if (options.signal?.aborted) {
      result.cancelled = true
      return result
    }
    await collectScannableFiles(folder, filePaths, options.signal, readDirectory)
  }
  const yieldEvery = Math.max(1, options.yieldEvery ?? DEFAULT_YIELD_EVERY)
  const readDurationSeconds = options.readDurationSeconds ?? readLocalVideoDurationSeconds
  const minImportDurationSeconds =
    options.minImportDurationSeconds !== undefined
      ? options.minImportDurationSeconds
      : resolveMinScanImportDurationSeconds(getSettings().minScanImportDurationMinutes)
  const autoMergeSameCodeResources =
    options.autoMergeSameCodeResources ?? getSettings().autoMergeSameCodeResources
  const newFileCounts = new Map<string, number>()
  for (const file of filePaths) {
    if (
      localVideoResourceExistsByLocator(file) ||
      getStrmVideoResourceBySourcePath(file) ||
      pendingScanResourceExists(file)
    ) {
      continue
    }
    const code = parseCode(path.basename(file, path.extname(file)))
    if (!code) continue
    newFileCounts.set(code, (newFileCounts.get(code) ?? 0) + 1)
  }
  if (!autoMergeSameCodeResources) {
    let checkedStrmFiles = 0
    for (const file of filePaths) {
      if (options.signal?.aborted) {
        result.cancelled = true
        return result
      }
      if (!isStrmFile(file)) continue
      const code = parseCode(path.basename(file, path.extname(file)))
      if (!code || (newFileCounts.get(code) ?? 0) <= 1) continue
      if (
        localVideoResourceExistsByLocator(file) ||
        getStrmVideoResourceBySourcePath(file) ||
        pendingScanResourceExists(file) ||
        listVideosByCode(code).length > 0
      ) {
        continue
      }
      checkedStrmFiles += 1
      if (!readStrmTarget(file).ok) {
        newFileCounts.set(code, Math.max(0, (newFileCounts.get(code) ?? 0) - 1))
      }
      await maybeYield(checkedStrmFiles, Math.min(yieldEvery, 10))
    }
  }
  const pendingGroupIds = new Set<number>()
  const primarySelectionVideoIds = new Set<number>()

  const recordStrmFailure = (failure: StrmScanFailure): void => {
    result.failed += 1
    if (result.strmFailures.length < 50) result.strmFailures.push(failure)
    else result.omittedStrmFailures += 1
  }

  for (const file of filePaths) {
    if (options.signal?.aborted) {
      result.cancelled = true
      break
    }
    result.scannedFiles += 1

    try {
      if (isStrmFile(file)) {
        const prepared = readStrmTarget(file)
        if (options.signal?.aborted) {
          result.cancelled = true
          break
        }
        if (!prepared.ok) {
          removePendingScanResource(file)
          recordStrmFailure(prepared.failure)
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        const target = prepared.target
        const existingResource = getStrmVideoResourceBySourcePath(file)
        if (existingResource) {
          if (
            updateStrmVideoResourceTarget(existingResource.id, {
              kind: target.kind,
              locator: target.locator
            })
          ) {
            result.refreshed += 1
          } else {
            result.skipped += 1
          }
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        const code = parseCode(path.basename(file, path.extname(file)))
        if (pendingScanResourceExists(file)) {
          if (code) {
            const pending = upsertPendingScanResources(code, [
              {
                filePath: file,
                scanRoot: scanRootForFile(file, folders),
                sourceKind: 'strm',
                targetKind: target.kind,
                targetLocator: target.locator,
                targetKey: target.targetKey,
                sizeBytes: null,
                durationSeconds: null,
                fileMtimeMs: null,
                displayName: path.basename(file)
              }
            ])
            pendingGroupIds.add(pending.groupId)
          }
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        const relocation = findStrmRelocationCandidate(
          file,
          target.targetKey,
          options.unavailableRoots ?? [],
          inspectPath
        )
        if (relocation) {
          relocateStrmVideoResource(relocation.resource_id, {
            sourcePath: file,
            kind: target.kind,
            locator: target.locator
          })
          result.relocated += 1
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        if (!code) {
          result.failed += 1
          result.unrecognizedFiles.push(file)
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        const existingVideos = listVideosByCode(code)

        const mustConfirm = autoMergeSameCodeResources
          ? existingVideos.length > 1
          : existingVideos.length > 0 || (newFileCounts.get(code) ?? 0) > 1
        if (mustConfirm) {
          const pending = upsertPendingScanResources(code, [
            {
              filePath: file,
              scanRoot: scanRootForFile(file, folders),
              sourceKind: 'strm',
              targetKind: target.kind,
              targetLocator: target.locator,
              targetKey: target.targetKey,
              sizeBytes: null,
              durationSeconds: null,
              fileMtimeMs: null,
              displayName: path.basename(file)
            }
          ])
          pendingGroupIds.add(pending.groupId)
          result.pendingResources += pending.addedResources
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        if (existingVideos.length === 1) {
          const needsPrimarySelection = listVideoResources(existingVideos[0].id).length === 0
          const resourceId = insertStrmVideoResource({
            videoId: existingVideos[0].id,
            sourcePath: file,
            kind: target.kind,
            locator: target.locator,
            displayName: path.basename(file)
          })
          if (resourceId == null) result.skipped += 1
          else {
            result.imported += 1
            if (needsPrimarySelection) primarySelectionVideoIds.add(existingVideos[0].id)
          }
        } else {
          const videoId = insertNewScannedStrmVideo({
            code,
            sourcePath: file,
            kind: target.kind,
            locator: target.locator,
            displayName: path.basename(file)
          })
          if (videoId == null) result.skipped += 1
          else {
            result.imported += 1
            result.newCodes.push(code)
            primarySelectionVideoIds.add(videoId)
          }
        }
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      if (localVideoResourceExistsByLocator(file)) {
        if (await refreshScannedFileDuration(file, readDurationSeconds)) {
          result.refreshed += 1
        }
        result.skipped += 1
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      if (pendingScanResourceExists(file)) {
        const code = parseCode(path.basename(file, path.extname(file)))
        if (code) {
          const fingerprint = statFileFingerprint(file)
          const fileDurationSeconds = await readDurationSeconds(file)
          const pending = upsertPendingScanResources(code, [
            {
              filePath: file,
              scanRoot: scanRootForFile(file, folders),
              sizeBytes: fingerprint?.file_size ?? null,
              durationSeconds: fileDurationSeconds,
              fileMtimeMs: fingerprint?.file_mtime_ms ?? null,
              displayName: path.basename(file)
            }
          ])
          pendingGroupIds.add(pending.groupId)
        }
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      let probedDuration: number | null | undefined = undefined
      if (minImportDurationSeconds != null) {
        probedDuration = await readDurationSeconds(file)
        if (isBelowMinImportDuration(probedDuration, minImportDurationSeconds)) {
          result.skipped += 1
          result.skippedShort += 1
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }
      }

      const base = path.basename(file, path.extname(file))
      const code = parseCode(base)
      if (!code) {
        result.failed += 1
        result.unrecognizedFiles.push(file)
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      const fingerprint = statFileFingerprint(file)
      const existingVideos = listVideosByCode(code)
      const fileDurationSeconds = await resolveImportDurationSeconds(
        file,
        readDurationSeconds,
        probedDuration
      )
      const relocation = findRelocationCandidate(
        existingVideos,
        file,
        fingerprint?.file_size ?? null,
        options.unavailableRoots ?? [],
        inspectPath
      )
      if (relocation) {
        relocateLocalVideoResourceById(
          relocation.id,
          file,
          fingerprint?.file_size ?? null,
          fileDurationSeconds,
          fingerprint?.file_mtime_ms ?? null
        )
        result.relocated += 1
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      const mustConfirm = autoMergeSameCodeResources
        ? existingVideos.length > 1
        : existingVideos.length > 0 || (newFileCounts.get(code) ?? 0) > 1
      if (mustConfirm) {
        const pending = upsertPendingScanResources(code, [
          {
            filePath: file,
            scanRoot: scanRootForFile(file, folders),
            sizeBytes: fingerprint?.file_size ?? null,
            durationSeconds: fileDurationSeconds,
            fileMtimeMs: fingerprint?.file_mtime_ms ?? null,
            displayName: path.basename(file)
          }
        ])
        pendingGroupIds.add(pending.groupId)
        result.pendingResources += pending.addedResources
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      if (existingVideos.length === 1) {
        const needsPrimarySelection = listVideoResources(existingVideos[0].id).length === 0
        const resourceId = insertLocalVideoResource({
          videoId: existingVideos[0].id,
          locator: file,
          sizeBytes: fingerprint?.file_size ?? null,
          durationSeconds: fileDurationSeconds,
          fileMtimeMs: fingerprint?.file_mtime_ms ?? null
        })
        if (resourceId != null) {
          result.imported += 1
          if (needsPrimarySelection) primarySelectionVideoIds.add(existingVideos[0].id)
        } else result.skipped += 1
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      const id = insertScannedVideo(
        buildScannedVideoImport(code, file, fileDurationSeconds, fingerprint)
      )
      if (id !== null) {
        result.imported += 1
        result.newCodes.push(code)
        primarySelectionVideoIds.add(id)
      } else result.skipped += 1
    } catch (err) {
      console.error('Scan error for', file, err)
      result.failed += 1
    }

    onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
    await maybeYield(result.scannedFiles, yieldEvery)
  }

  result.pendingGroups = pendingGroupIds.size

  for (const videoId of primarySelectionVideoIds) {
    const candidates = listVideoResources(videoId).map((resource) => ({
      resource,
      filePath: resource.strm_source_path ?? resource.locator,
      sourceKind: resource.strm_source_path ? ('strm' as const) : ('local' as const),
      targetKind: resource.kind === 'local' ? null : resource.kind,
      durationSeconds: resource.duration_seconds,
      sizeBytes: resource.size_bytes
    }))
    const primary = selectDefaultPendingScanPrimary(candidates, normalizeLocalPathIdentity)
    if (primary) setPrimaryVideoResource(videoId, primary.resource.id)
  }

  return result
}

const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/

/**
 * Rename a file on disk (keeping its original extension unless the new name
 * already carries one), then import it using the user's explicit code and target.
 * Used to fix up files the scanner couldn't recognize.
 */
export async function renameAndImport(
  oldPath: string,
  newNameRaw: string,
  codeRaw: string,
  target: VideoResourceImportTarget
): Promise<RenameImportResult> {
  if (!fs.existsSync(oldPath)) throw new Error('原文件不存在或已被移动')

  const newName = newNameRaw.trim()
  if (!newName) throw new Error('文件名不能为空')
  if (ILLEGAL_NAME_CHARS.test(newName)) {
    throw new Error('文件名包含非法字符： \\ / : * ? " < > |')
  }
  const code = normalizeVideoCode(codeRaw)
  if (
    target.kind === 'existing' &&
    !listVideosByCode(code).some((video) => video.id === target.videoId)
  ) {
    throw new Error('所选影片不存在或番号已经变化')
  }

  const dir = path.dirname(oldPath)
  const originalExt = path.extname(oldPath)
  // Keep the original extension unless the user already typed one.
  const finalName = path.extname(newName) ? newName : newName + originalExt
  const newPath = path.join(dir, finalName)

  const sameFile = path.resolve(newPath) === path.resolve(oldPath)
  if (!sameFile && fs.existsSync(newPath)) {
    throw new Error('目标文件名已存在')
  }

  if (!sameFile) {
    fs.renameSync(oldPath, newPath)
  }

  try {
    const result = await importManual(newPath, code, target)
    return { newPath, newName: path.basename(newPath), imported: result.imported, code }
  } catch (error) {
    if (!sameFile && fs.existsSync(newPath) && !fs.existsSync(oldPath)) {
      try {
        fs.renameSync(newPath, oldPath)
      } catch {
        throw new Error(`导入失败且无法恢复原文件名：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw error
  }
}

/**
 * Import a file with a user-supplied code. Does not rename the file and does not
 * validate code format beyond the shared trim-and-uppercase identity rule.
 */
export async function importManual(
  filePath: string,
  codeRaw: string,
  target: VideoResourceImportTarget
): Promise<ManualImportResult> {
  if (!fs.existsSync(filePath)) throw new Error('原文件不存在或已被移动')

  const code = normalizeVideoCode(codeRaw)

  if (isStrmFile(filePath)) {
    const parsed = readStrmFile(filePath)
    if (getStrmVideoResourceBySourcePath(filePath)) {
      return { code, imported: false, skippedPath: true }
    }
    if (target.kind === 'existing') {
      const existing = listVideosByCode(code).find((video) => video.id === target.videoId)
      if (!existing) throw new Error('所选影片不存在或番号已经变化')
      const resourceId = insertStrmVideoResource({
        videoId: existing.id,
        sourcePath: filePath,
        kind: parsed.kind,
        locator: parsed.locator,
        displayName: path.basename(filePath)
      })
      return { code, imported: resourceId !== null }
    }
    const videoId = insertNewScannedStrmVideo({
      code,
      sourcePath: filePath,
      kind: parsed.kind,
      locator: parsed.locator,
      displayName: path.basename(filePath)
    })
    return { code, imported: videoId !== null }
  }

  if (localVideoResourceExistsByLocator(filePath)) {
    return { code, imported: false, skippedPath: true }
  }

  const fingerprint = statFileFingerprint(filePath)
  const fileDurationSeconds = await readLocalVideoDurationSeconds(filePath)
  if (target.kind === 'existing') {
    const existing = listVideosByCode(code).find((video) => video.id === target.videoId)
    if (!existing) throw new Error('所选影片不存在或番号已经变化')
    const localResource = getPreferredLocalVideoResource(existing.id)
    if (localResource && !fs.existsSync(localResource.locator)) {
      relocateLocalVideoResource(
        existing.id,
        filePath,
        fingerprint?.file_size ?? null,
        fileDurationSeconds,
        fingerprint?.file_mtime_ms ?? null
      )
      return { code, imported: true, relocated: true }
    }
    if (!localVideoResourceExistsByLocator(filePath)) {
      const resourceId = insertLocalVideoResource({
        videoId: existing.id,
        locator: filePath,
        sizeBytes: fingerprint?.file_size ?? null,
        durationSeconds: fileDurationSeconds,
        fileMtimeMs: fingerprint?.file_mtime_ms ?? null
      })
      return { code, imported: resourceId !== null, relocated: false }
    }
    return { code, imported: false, skippedPath: false }
  }

  const id = insertNewScannedVideo(
    buildScannedVideoImport(code, filePath, fileDurationSeconds, fingerprint)
  )
  return { code, imported: id !== null }
}
