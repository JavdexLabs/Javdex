import fs from 'node:fs'
import path from 'node:path'
import { isVideoFile, parseCode } from './codeParser'
import {
  backfillLocalVideoResourceFingerprint,
  getVideoByCode,
  getLocalVideoResourceByLocator,
  getPreferredLocalVideoResource,
  insertScannedVideo,
  localVideoResourceExistsByLocator,
  relocateLocalVideoResource,
  updateLocalVideoResourceAfterProbe
} from '../db/videoRepo'
import type { ManualImportResult, ScanProgress, ScanResult, RenameImportResult } from '@shared/libraryTypes'
import type { ScannedVideoInput } from '../db/videoRepo'
import type { LocalVideoResource } from '@shared/videoTypes'
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
}

const DEFAULT_YIELD_EVERY = 50

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function maybeYield(count: number, yieldEvery: number): Promise<void> {
  if (count % yieldEvery === 0) {
    await yieldToEventLoop()
  }
}

/** Recursively collect video file paths under a directory. */
async function collectVideoFiles(
  dir: string,
  acc: string[],
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return // permission / missing dir — skip
  }
  for (const entry of entries) {
    if (signal?.aborted) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectVideoFiles(full, acc, signal)
    } else if (entry.isFile() && isVideoFile(full)) {
      acc.push(full)
    } else if (entry.isSymbolicLink() && isVideoFile(full)) {
      try {
        const target = await fs.promises.stat(full)
        if (target.isFile()) acc.push(full)
      } catch {
        // Broken or inaccessible symbolic link — skip.
      }
    }
  }
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
    relocated: 0,
    refreshed: 0,
    removed: 0,
    promoted: 0,
    deletedVideos: 0,
    offlineFolders: [],
    newCodes: [],
    unrecognizedFiles: []
  }

  const files: string[] = []
  for (const folder of folders) {
    if (options.signal?.aborted) {
      result.cancelled = true
      return result
    }
    await collectVideoFiles(folder, files, options.signal)
  }

  const yieldEvery = Math.max(1, options.yieldEvery ?? DEFAULT_YIELD_EVERY)
  const readDurationSeconds = options.readDurationSeconds ?? readLocalVideoDurationSeconds
  const minImportDurationSeconds =
    options.minImportDurationSeconds !== undefined
      ? options.minImportDurationSeconds
      : resolveMinScanImportDurationSeconds(getSettings().minScanImportDurationMinutes)

  for (const file of files) {
    if (options.signal?.aborted) {
      result.cancelled = true
      break
    }
    result.scannedFiles += 1

    try {
      if (localVideoResourceExistsByLocator(file)) {
        if (await refreshScannedFileDuration(file, readDurationSeconds)) {
          result.refreshed += 1
        }
        result.skipped += 1
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
      const existing = getVideoByCode(code)
      const fileDurationSeconds = await resolveImportDurationSeconds(
        file,
        readDurationSeconds,
        probedDuration
      )
      if (existing) {
        const localResource = getPreferredLocalVideoResource(existing.id)
        if (localResource && samePath(localResource.locator, file)) {
          if (await refreshScannedFileDuration(file, readDurationSeconds)) {
            result.refreshed += 1
          }
          result.skipped += 1
        } else if (
          localResource &&
          !options.unavailableRoots?.some((root) => isPathUnderRoot(localResource.locator, root)) &&
          !fs.existsSync(localResource.locator)
        ) {
          relocateLocalVideoResource(
            existing.id,
            file,
            fingerprint?.file_size ?? null,
            fileDurationSeconds,
            fingerprint?.file_mtime_ms ?? null
          )
          result.relocated += 1
        } else {
          const id = insertScannedVideo(
            buildScannedVideoImport(code, file, fileDurationSeconds, fingerprint)
          )
          if (id !== null) {
            result.imported += 1
          } else {
            if (await refreshScannedFileDuration(file, readDurationSeconds)) {
              result.refreshed += 1
            }
            result.skipped += 1
          }
        }
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
      } else {
        if (await refreshScannedFileDuration(file, readDurationSeconds)) {
          result.refreshed += 1
        }
        result.skipped += 1
      }
    } catch (err) {
      console.error('Scan error for', file, err)
      result.failed += 1
    }

    onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
    await maybeYield(result.scannedFiles, yieldEvery)
  }

  return result
}

const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/

/**
 * Rename a file on disk (keeping its original extension unless the new name
 * already carries one), then attempt to parse a code from the new name and
 * import it. Used to fix up files the scanner couldn't recognize.
 */
export async function renameAndImport(oldPath: string, newNameRaw: string): Promise<RenameImportResult> {
  if (!fs.existsSync(oldPath)) throw new Error('原文件不存在或已被移动')

  const newName = newNameRaw.trim()
  if (!newName) throw new Error('文件名不能为空')
  if (ILLEGAL_NAME_CHARS.test(newName)) {
    throw new Error('文件名包含非法字符： \\ / : * ? " < > |')
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

  const base = path.basename(newPath, path.extname(newPath))
  const code = parseCode(base)
  const fingerprint = statFileFingerprint(newPath)
  const fileDurationSeconds = await readLocalVideoDurationSeconds(newPath)
  let imported = false
  if (code && !localVideoResourceExistsByLocator(newPath)) {
    const existing = getVideoByCode(code)
    if (existing) {
      const localResource = getPreferredLocalVideoResource(existing.id)
      if (localResource && !fs.existsSync(localResource.locator)) {
        relocateLocalVideoResource(
          existing.id,
          newPath,
          fingerprint?.file_size ?? null,
          fileDurationSeconds,
          fingerprint?.file_mtime_ms ?? null
        )
        imported = true
      } else if (!localResource) {
        const id = insertScannedVideo(
          buildScannedVideoImport(code, newPath, fileDurationSeconds, fingerprint)
        )
        imported = id !== null
      }
    } else {
      const id = insertScannedVideo(
        buildScannedVideoImport(code, newPath, fileDurationSeconds, fingerprint)
      )
      imported = id !== null
    }
  }

  return { newPath, newName: path.basename(newPath), imported, code }
}

/**
 * Import a file with a user-supplied code. Does not rename the file and does not
 * validate code format — only trims whitespace and rejects empty strings.
 */
export async function importManual(filePath: string, codeRaw: string): Promise<ManualImportResult> {
  if (!fs.existsSync(filePath)) throw new Error('原文件不存在或已被移动')

  const code = codeRaw.trim()
  if (!code) throw new Error('番号不能为空')

  if (localVideoResourceExistsByLocator(filePath)) {
    return { code, imported: false, skippedPath: true }
  }

  const fingerprint = statFileFingerprint(filePath)
  const fileDurationSeconds = await readLocalVideoDurationSeconds(filePath)
  const existing = getVideoByCode(code)
  if (existing) {
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
      const id = insertScannedVideo(
        buildScannedVideoImport(code, filePath, fileDurationSeconds, fingerprint)
      )
      return { code, imported: id !== null, relocated: false }
    }
    return { code, imported: false, skippedPath: false }
  }

  const id = insertScannedVideo(
    buildScannedVideoImport(code, filePath, fileDurationSeconds, fingerprint)
  )
  return { code, imported: id !== null }
}
