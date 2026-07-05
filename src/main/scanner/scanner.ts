import fs from 'node:fs'
import path from 'node:path'
import { isVideoFile, parseCode } from './codeParser'
import {
  backfillVideoFileFingerprint,
  getVideoByCode,
  getPrimaryVideoFile,
  getVideoFileByPath,
  insertScannedVideo,
  listVideoFileRefs,
  purgeVideoFile,
  relocateVideo,
  updateVideoFileAfterProbe,
  videoExistsByPath
} from '../db/videoRepo'
import type { ManualImportResult, ScanProgress, ScanResult, RenameImportResult } from '@shared/types'
import type { NewVideo } from '../db/videoRepo'
import type { VideoFile } from '@shared/types'
import {
  isBelowMinImportDuration,
  readLocalVideoDurationSeconds,
  resolveMinScanImportDurationSeconds,
  shouldProbeVideoFileDuration,
  shouldRefreshVideoFileDuration,
  type VideoFileFingerprint
} from './videoDuration'
import { getSettings } from '../settings/settingsStore'

export type ScanProgressFn = (progress: ScanProgress) => void

export interface ScanOptions {
  yieldEvery?: number
  signal?: AbortSignal
  /** Override duration probe (tests). Defaults to reading container metadata. */
  readDurationSeconds?: (filePath: string) => Promise<number | null>
  /** Minimum seconds required to import during scan; null disables the filter. */
  minImportDurationSeconds?: number | null
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
    }
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

function isUnderFolder(filePath: string, folders: string[]): boolean {
  const resolved = path.resolve(filePath)
  return folders.some((folder) => {
    const root = path.resolve(folder)
    return resolved === root || resolved.startsWith(root + path.sep)
  })
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
): NewVideo {
  return {
    code,
    file_path: file,
    file_size: fingerprint?.file_size ?? null,
    file_duration_seconds: fileDurationSeconds,
    file_mtime_ms: fingerprint?.file_mtime_ms ?? null
  }
}

function resolveRefreshTarget(file: string): VideoFile | null {
  const existingFile = getVideoFileByPath(file)
  if (existingFile) return existingFile

  const base = path.basename(file, path.extname(file))
  const code = parseCode(base)
  if (!code) return null
  const video = getVideoByCode(code)
  if (!video) return null
  const primary = getPrimaryVideoFile(video.id)
  if (primary && samePath(primary.file_path, file)) return primary
  return null
}

async function refreshScannedFileDuration(
  file: string,
  readDurationSeconds: DurationReader
): Promise<void> {
  const fingerprint = statFileFingerprint(file)
  if (!fingerprint) return

  const record = resolveRefreshTarget(file)
  if (!record) return

  if (!shouldProbeVideoFileDuration(record, fingerprint)) {
    if (record.file_mtime_ms == null) {
      backfillVideoFileFingerprint(record.id, fingerprint)
    }
    return
  }

  const fileDurationSeconds = await readDurationSeconds(file)
  if (fileDurationSeconds == null || fileDurationSeconds <= 0) return

  const nextDuration = shouldRefreshVideoFileDuration(
    record.file_duration_seconds,
    fileDurationSeconds
  )
    ? fileDurationSeconds
    : record.file_duration_seconds

  updateVideoFileAfterProbe(record.id, {
    file_duration_seconds: nextDuration,
    file_size: fingerprint.file_size,
    file_mtime_ms: fingerprint.file_mtime_ms
  })
}

/**
 * Scan the given folders, parse codes, and import new videos.
 * Relocates metadata when a known code appears at a new path and the old file is gone.
 * Purges records when the path is outside scanned library folders, or the file
 * is missing under a library folder.
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
    removed: 0,
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
      if (videoExistsByPath(file)) {
        await refreshScannedFileDuration(file, readDurationSeconds)
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
        const primary = getPrimaryVideoFile(existing.id)
        if (primary && samePath(primary.file_path, file)) {
          await refreshScannedFileDuration(file, readDurationSeconds)
          result.skipped += 1
        } else if (primary && !fs.existsSync(primary.file_path)) {
          relocateVideo(
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
            await refreshScannedFileDuration(file, readDurationSeconds)
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
        await refreshScannedFileDuration(file, readDurationSeconds)
        result.skipped += 1
      }
    } catch (err) {
      console.error('Scan error for', file, err)
      result.failed += 1
    }

    onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
    await maybeYield(result.scannedFiles, yieldEvery)
  }

  let checkedExisting = 0
  for (const { file_id, file_path } of listVideoFileRefs()) {
    if (options.signal?.aborted) {
      result.cancelled = true
      break
    }
    checkedExisting += 1
    const underLibrary = isUnderFolder(file_path, folders)
    if (underLibrary && fs.existsSync(file_path)) {
      await maybeYield(checkedExisting, yieldEvery)
      continue
    }
    try {
      purgeVideoFile(file_id)
      result.removed += 1
    } catch (err) {
      console.error('Purge error for', file_path, err)
    }
    await maybeYield(checkedExisting, yieldEvery)
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
  if (code && !videoExistsByPath(newPath)) {
    const existing = getVideoByCode(code)
    if (existing) {
      const primary = getPrimaryVideoFile(existing.id)
      if (primary && !fs.existsSync(primary.file_path)) {
        relocateVideo(
          existing.id,
          newPath,
          fingerprint?.file_size ?? null,
          fileDurationSeconds,
          fingerprint?.file_mtime_ms ?? null
        )
        imported = true
      } else if (!primary) {
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

  if (videoExistsByPath(filePath)) {
    return { code, imported: false, skippedPath: true }
  }

  const fingerprint = statFileFingerprint(filePath)
  const fileDurationSeconds = await readLocalVideoDurationSeconds(filePath)
  const existing = getVideoByCode(code)
  if (existing) {
    const primary = getPrimaryVideoFile(existing.id)
    if (primary && !fs.existsSync(primary.file_path)) {
      relocateVideo(
        existing.id,
        filePath,
        fingerprint?.file_size ?? null,
        fileDurationSeconds,
        fingerprint?.file_mtime_ms ?? null
      )
      return { code, imported: true, relocated: true }
    }
    if (!videoExistsByPath(filePath)) {
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
