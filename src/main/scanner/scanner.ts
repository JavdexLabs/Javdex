import fs from 'node:fs'
import path from 'node:path'
import { isVideoFile, parseCode } from './codeParser'
import {
  backfillLocalVideoResourceFingerprint,
  getVideoByCode,
  getVideoById,
  getLocalVideoResourceByLocator,
  getStrmVideoResourceBySourcePath,
  getPreferredLocalVideoResource,
  getVideoResourceInLibrary,
  insertLocalVideoResource,
  insertNewScannedStrmVideo,
  insertNewScannedVideo,
  insertScannedVideo,
  listStrmVideoResourceRefs,
  listVideosByCode,
  listVideoResources,
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
  LibraryScanFileAuditEntry,
  LibraryScanNfoAudit,
  RenameImportResult,
  ScanProgress,
  ScanResult,
  StrmScanFailure
} from '@shared/libraryTypes'
import type { ScannedVideoInput, StrmVideoResourceRef } from '../db/videoRepo'
import type {
  LocalVideoResource,
  VideoResource,
  VideoResourceImportTarget
} from '@shared/videoTypes'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import {
  isBelowMinImportDuration,
  readLocalVideoDurationSeconds,
  shouldProbeLocalVideoResourceDuration,
  shouldRefreshLocalVideoResourceDuration,
  type VideoFileFingerprint
} from './videoDuration'
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
import { sanitizeLibraryScanError } from '@shared/libraryScanSummary'
import {
  authorizeMediaLibraryRoot,
  authorizeMediaLibraryRootFile
} from '../services/mediaLibraryRootFileGuard'
import {
  getPendingResourceIdentityByPath,
  pendingResourceIdentityExists,
  upsertPendingResourceIdentity
} from '../db/pendingResourceIdentityRepo'
import {
  localNfoScanService,
  type LocalNfoScanService
} from '../services/localNfoScanService'
import type {
  LocalNfoAnchor,
  LocalNfoIdentityInspection
} from '../metadata-sources'
import { indexNfoSidecars } from '../nfo/nfoSidecarLocator'
import { getMediaLibraryConfig } from '../db/mediaLibraryRepo'

export type ScanProgressFn = (progress: ScanProgress) => void

/** Rescanning refreshes file evidence without choosing either pending identity. */
function refreshPendingIdentity(
  libraryId: number,
  root: Readonly<MediaLibraryRoot>,
  filePath: string,
  target?: ParsedStrmTarget
): boolean {
  const pending = getPendingResourceIdentityByPath(libraryId, filePath)
  if (!pending) return false
  authorizeMediaLibraryRootFile(libraryId, root.id, filePath, root)
  const fingerprint = statFileFingerprint(filePath)
  if (!fingerprint) throw new Error('待确认资源无法读取，保留原身份待办。')
  if (pending.sizeBytes !== fingerprint.file_size ||
    pending.fileMtimeMs !== fingerprint.file_mtime_ms ||
    (target && (pending.targetKind !== target.kind || pending.targetLocator !== target.locator ||
      pending.targetKey !== target.targetKey))) {
    upsertPendingResourceIdentity({
      ...pending,
      sizeBytes: fingerprint.file_size,
      fileMtimeMs: fingerprint.file_mtime_ms,
      ...(target ? { targetKind: target.kind, targetLocator: target.locator, targetKey: target.targetKey } : {})
    })
  }
  return true
}

type ScanFileAuditWithoutRoot = LibraryScanFileAuditEntry extends infer Entry
  ? Entry extends LibraryScanFileAuditEntry
    ? Omit<Entry, 'rootId'>
    : never
  : never

export interface ScanFoldersRequest {
  libraryId: number
  runId: string
  /** Accessible roots selected from the coordinator's immutable run snapshot. */
  roots: readonly Readonly<MediaLibraryRoot>[]
  /** Restrict discovery to these files, e.g. after a rename; never scans other resources. */
  filePaths?: readonly string[]
}

export interface ScanOptions {
  yieldEvery?: number
  signal?: AbortSignal
  /** Override duration probe (tests). Defaults to reading container metadata. */
  readDurationSeconds?: (filePath: string) => Promise<number | null>
  /** Minimum seconds required to import during scan; null disables the filter. */
  minImportDurationSeconds?: number | null
  /** Missing resources owned by these temporarily unavailable roots must not be relocated. */
  unavailableRootIds?: readonly number[]
  /** Override directory reads (tests). Read failures abort cleanup-safe scans. */
  readDirectory?: (dir: string) => Promise<fs.Dirent[]>
  /** Override local resource inspection (tests). */
  inspectPath?: (filePath: string) => 'present' | 'missing' | 'unknown'
  /** Override same-code resource auto-assignment (tests). */
  autoMergeSameCodeResources?: boolean
  /** Read local NFO only while a resource is being discovered for the first time. */
  autoImportLocalNfo?: boolean
  /** Override the built-in local NFO source (tests). */
  localNfoService?: LocalNfoScanService
  /** Receives exactly one final audit outcome for every processed file. */
  onFileResult?: (entry: LibraryScanFileAuditEntry) => void
}

const DEFAULT_YIELD_EVERY = 50

interface LocalNfoPreflight {
  anchor: LocalNfoAnchor
  filenameCode: string | null
  nfoCode: string | null
  effectiveCode: string | null
  identityConflict: boolean
  inspection: LocalNfoIdentityInspection
}

interface LocalNfoVideoBatch {
  code: string
  anchors: LocalNfoAnchor[]
}

function safeNfoWarnings(warnings: readonly string[]): NonNullable<LibraryScanNfoAudit['warnings']> {
  const seen = new Set<string>()
  return warnings.flatMap((warning) => {
    const message = sanitizeLibraryScanError(warning)
      .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s，。；]+/gu, '[本地路径已隐藏]')
      .slice(0, 500)
    if (!message || seen.has(message)) return []
    seen.add(message)
    return [{ code: 'nfo-warning', message }]
  }).slice(0, 20)
}

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
  libraryId: number,
  sourcePath: string,
  targetKey: string,
  unavailableRootIds: ReadonlySet<number>,
  inspectPath: (filePath: string) => 'present' | 'missing' | 'unknown'
): StrmVideoResourceRef | null {
  const sourceName = path.basename(sourcePath)
  const candidates = listStrmVideoResourceRefs(libraryId)
    .filter((resource) => {
      const oldSourcePath = resource.source_path
      if (path.basename(oldSourcePath) !== sourceName) return false
      const record = getVideoResourceInLibrary(libraryId, resource.resource_id)
      if (!record?.root_id || unavailableRootIds.has(record.root_id)) return false
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
  libraryId: number,
  rootId: number,
  code: string,
  file: string,
  fileDurationSeconds: number | null,
  fingerprint: VideoFileFingerprint | null
): ScannedVideoInput {
  return {
    libraryId,
    rootId,
    code,
    locator: file,
    size_bytes: fingerprint?.file_size ?? null,
    duration_seconds: fileDurationSeconds,
    file_mtime_ms: fingerprint?.file_mtime_ms ?? null
  }
}

function findRelocationCandidate(
  libraryId: number,
  videos: Array<{ id: number }>,
  file: string,
  sizeBytes: number | null,
  unavailableRootIds: ReadonlySet<number>,
  inspectPath: (filePath: string) => 'present' | 'missing' | 'unknown'
): LocalVideoResource | null {
  if (sizeBytes == null) return null
  const newName = path.basename(file)
  const localResources = videos.flatMap((video) =>
    listVideoResources(libraryId, video.id)
      .filter((resource): resource is LocalVideoResource => resource.kind === 'local')
  )
  const auditable = localResources.filter(
    (resource) => resource.root_id != null && !unavailableRootIds.has(resource.root_id)
  )
  const missing = auditable.filter((resource) => inspectPath(resource.locator) === 'missing')
  const matches = missing.filter((resource) => {
    if (resource.size_bytes !== sizeBytes) return false
    return videos.length === 1 || path.basename(resource.locator) === newName
  })
  return matches.length === 1 ? matches[0] : null
}

function localResourceInLibrary(libraryId: number, file: string): LocalVideoResource | null {
  return getLocalVideoResourceByLocator(libraryId, file)
}

function strmResourceInLibrary(libraryId: number, file: string): VideoResource | null {
  return getStrmVideoResourceBySourcePath(libraryId, file)
}

function resolveRefreshTarget(libraryId: number, file: string): LocalVideoResource | null {
  const existingResource = localResourceInLibrary(libraryId, file)
  if (existingResource) return existingResource

  const base = path.basename(file, path.extname(file))
  const code = parseCode(base)
  if (!code) return null
  const video = getVideoByCode(code)
  if (!video) return null
  const localResource = getPreferredLocalVideoResource(libraryId, video.id)
  if (localResource && samePath(localResource.locator, file)) return localResource
  return null
}

async function refreshScannedFileDuration(
  libraryId: number,
  file: string,
  readDurationSeconds: DurationReader,
  authorizeWrite: () => void
): Promise<boolean> {
  const fingerprint = statFileFingerprint(file)
  if (!fingerprint) return false

  const record = resolveRefreshTarget(libraryId, file)
  if (!record) return false

  if (!shouldProbeLocalVideoResourceDuration(record, fingerprint)) {
    if (record.file_mtime_ms == null) {
      authorizeWrite()
      backfillLocalVideoResourceFingerprint(record.id, {
        sizeBytes: fingerprint.file_size,
        fileMtimeMs: fingerprint.file_mtime_ms
      })
      return true
    }
    return false
  }

  const fileDurationSeconds = await readDurationSeconds(file)
  authorizeWrite()
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
  request: ScanFoldersRequest,
  onProgress?: ScanProgressFn,
  options: ScanOptions = {}
): Promise<ScanResult> {
  if (!Number.isSafeInteger(request.libraryId) || request.libraryId <= 0) {
    throw new Error('媒体库 ID 无效')
  }
  if (!request.runId.trim()) throw new Error('扫描运行 ID 不能为空')
  const roots = request.roots.map((root) => ({ ...root }))
  if (
    roots.some(
      (root) =>
        !Number.isSafeInteger(root.id) ||
        root.id <= 0 ||
        root.libraryId !== request.libraryId ||
        !path.isAbsolute(root.path) ||
        root.state !== 'active'
    ) ||
    new Set(roots.map((root) => root.id)).size !== roots.length
  ) {
    throw new Error('扫描根目录快照无效')
  }
  const libraryId = request.libraryId
  for (const root of roots) {
    authorizeMediaLibraryRoot(libraryId, root.id, root)
  }
  const unavailableRootIds = new Set(options.unavailableRootIds ?? [])
  const result: ScanResult = {
    libraryId,
    runId: request.runId,
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

  const files: Array<{ filePath: string; root: Readonly<MediaLibraryRoot> }> = []
  const directorySidecars = new Map<string, ReadonlyMap<string, string>>()
  const directoryVideoCodes = new Map<string, Array<string | null>>()
  const readDirectory =
    options.readDirectory ??
    ((dir: string) => fs.promises.readdir(dir, { withFileTypes: true }))
  const inspectPath = options.inspectPath ?? inspectScannedResourcePath
  for (const root of roots) {
    if (options.signal?.aborted) {
      result.cancelled = true
      return result
    }
    const rootFiles: string[] = []
    const readIndexedDirectory = async (directory: string): Promise<fs.Dirent[]> => {
      const entries = await readDirectory(directory)
      directorySidecars.set(directory, indexNfoSidecars(entries.map((entry) => entry.name)))
      if (request.filePaths) {
        directoryVideoCodes.set(directory, entries
          .filter((entry) => entry.isFile() && (isVideoFile(entry.name) || isStrmFile(entry.name)))
          .map((entry) => parseCode(path.basename(entry.name, path.extname(entry.name)))))
      }
      return entries
    }
    if (request.filePaths) {
      // Targeted discovery uses one frozen root and still indexes siblings for NFO ownership.
      if (roots.length !== 1) throw new Error('单文件重新识别必须指定唯一根目录')
      for (const filePath of request.filePaths) {
        authorizeMediaLibraryRootFile(libraryId, root.id, filePath, root)
        rootFiles.push(filePath)
        const directory = path.dirname(filePath)
        if (!directorySidecars.has(directory)) await readIndexedDirectory(directory)
      }
    } else {
      await collectScannableFiles(root.path, rootFiles, options.signal, readIndexedDirectory)
    }
    files.push(...rootFiles.map((filePath) => ({ filePath, root })))
  }
  const yieldEvery = Math.max(1, options.yieldEvery ?? DEFAULT_YIELD_EVERY)
  const readDurationSeconds = options.readDurationSeconds ?? readLocalVideoDurationSeconds
  const minImportDurationSeconds =
    options.minImportDurationSeconds !== undefined ? options.minImportDurationSeconds : null
  const autoMergeSameCodeResources = options.autoMergeSameCodeResources ?? false
  const autoImportLocalNfo = options.autoImportLocalNfo ?? false
  const nfoService = options.localNfoService ?? localNfoScanService
  for (const { filePath } of files) {
    if (request.filePaths) break
    const directory = path.dirname(filePath)
    const codes = directoryVideoCodes.get(directory) ?? []
    codes.push(parseCode(path.basename(filePath, path.extname(filePath))))
    directoryVideoCodes.set(directory, codes)
  }
  const nfoPreflightByFile = new Map<string, LocalNfoPreflight>()
  if (autoImportLocalNfo) {
    let inspectedNfoFiles = 0
    for (const { filePath, root } of files) {
      if (options.signal?.aborted) {
        result.cancelled = true
        return result
      }
      if (
        getLocalVideoResourceByLocator(libraryId, filePath) ||
        getStrmVideoResourceBySourcePath(libraryId, filePath) ||
        pendingScanResourceExists(libraryId, filePath) ||
        pendingResourceIdentityExists(libraryId, filePath)
      ) {
        continue
      }
      const filenameCode = parseCode(path.basename(filePath, path.extname(filePath)))
      const anchor: LocalNfoAnchor = {
        root,
        anchorPath: filePath,
        directoryVideoCodes: directoryVideoCodes.get(path.dirname(filePath)) ?? [],
        directorySidecars: directorySidecars.get(path.dirname(filePath))
      }
      let inspection: LocalNfoIdentityInspection
      try {
        inspection = nfoService.inspectIdentity(anchor)
      } catch (error) {
        inspection = {
          status: 'warning',
          code: null,
          warnings: [sanitizeLibraryScanError(error)]
        }
      }
      inspectedNfoFiles += 1
      if (inspection.status !== 'missing') {
        let nfoCode: string | null = null
        try {
          nfoCode = inspection.code ? normalizeVideoCode(inspection.code) : null
        } catch {
          inspection = {
            status: 'warning',
            code: null,
            warnings: [...inspection.warnings, 'NFO 番号无效，已忽略']
          }
        }
        const identityConflict = Boolean(
          filenameCode && nfoCode && normalizeVideoCode(filenameCode) !== nfoCode
        )
        nfoPreflightByFile.set(filePath, {
          anchor,
          filenameCode,
          nfoCode,
          effectiveCode: identityConflict ? null : (nfoCode ?? filenameCode),
          identityConflict,
          inspection
        })
      }
      await maybeYield(inspectedNfoFiles, Math.min(yieldEvery, 10))
    }
  }
  const codeForNewFile = (filePath: string): string | null => {
    const preflight = nfoPreflightByFile.get(filePath)
    return preflight ? preflight.effectiveCode : parseCode(path.basename(filePath, path.extname(filePath)))
  }
  const newFileCounts = new Map<string, number>()
  for (const { filePath: file } of files) {
    if (
      getLocalVideoResourceByLocator(libraryId, file) ||
      getStrmVideoResourceBySourcePath(libraryId, file) ||
      pendingScanResourceExists(libraryId, file) ||
      pendingResourceIdentityExists(libraryId, file)
    ) {
      continue
    }
    const code = codeForNewFile(file)
    if (!code) continue
    newFileCounts.set(code, (newFileCounts.get(code) ?? 0) + 1)
  }
  if (!autoMergeSameCodeResources) {
    let checkedStrmFiles = 0
    for (const { filePath: file } of files) {
      if (options.signal?.aborted) {
        result.cancelled = true
        return result
      }
      if (!isStrmFile(file)) continue
      const code = codeForNewFile(file)
      if (!code || (newFileCounts.get(code) ?? 0) <= 1) continue
      if (
        getLocalVideoResourceByLocator(libraryId, file) ||
        getStrmVideoResourceBySourcePath(libraryId, file) ||
        pendingScanResourceExists(libraryId, file) ||
        pendingResourceIdentityExists(libraryId, file) ||
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
  const auditEntriesByFile = new Map<string, LibraryScanFileAuditEntry>()
  const nfoBatchesByVideo = new Map<number, LocalNfoVideoBatch>()
  const queueNfoCandidate = (videoId: number, code: string, filePath: string): void => {
    const preflight = nfoPreflightByFile.get(filePath)
    if (!preflight || preflight.identityConflict || preflight.inspection.status !== 'found') return
    const batch = nfoBatchesByVideo.get(videoId)
    if (batch) batch.anchors.push(preflight.anchor)
    else nfoBatchesByVideo.set(videoId, { code, anchors: [preflight.anchor] })
  }
  const videoIdentity = (videoId: number): { videoId: number; videoCode: string } => ({
    videoId,
    videoCode: getVideoById(videoId)?.code ?? ''
  })

  const recordStrmFailure = (failure: StrmScanFailure): void => {
    result.failed += 1
    if (result.strmFailures.length < 50) result.strmFailures.push(failure)
    else result.omittedStrmFailures += 1
  }

  for (const { filePath: file, root } of files) {
    const rootId = root.id
    const authorizeFileWrite = (): void => {
      authorizeMediaLibraryRootFile(libraryId, rootId, file, root)
    }
    const recordFile = (entry: ScanFileAuditWithoutRoot): void => {
      const fullEntry = { ...entry, rootId } as LibraryScanFileAuditEntry
      const preflight = nfoPreflightByFile.get(file)
      if (
        preflight &&
        !preflight.identityConflict &&
        preflight.inspection.warnings.length > 0
      ) {
        fullEntry.nfo = {
          disposition: 'warning',
          warnings: safeNfoWarnings(preflight.inspection.warnings)
        }
      }
      auditEntriesByFile.set(file, fullEntry)
    }
    if (options.signal?.aborted) {
      result.cancelled = true
      break
    }
    result.scannedFiles += 1

    try {
      if (isStrmFile(file)) {
        const prepared = readStrmTarget(file)
        if (options.signal?.aborted) {
          result.scannedFiles -= 1
          result.cancelled = true
          break
        }
        if (!prepared.ok) {
          authorizeFileWrite()
          removePendingScanResource(libraryId, file)
          recordStrmFailure(prepared.failure)
          recordFile({
            filePath: file,
            sourceKind: 'strm',
            outcome: 'strm_failure',
            failureCode: prepared.failure.code,
            message: prepared.failure.message
          })
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        const target = prepared.target
        const existingResource = strmResourceInLibrary(libraryId, file)
        if (existingResource) {
          authorizeFileWrite()
          if (
            updateStrmVideoResourceTarget(existingResource.id, {
              kind: target.kind,
              locator: target.locator
            })
          ) {
            result.refreshed += 1
            recordFile({
              filePath: file,
              sourceKind: 'strm',
              outcome: 'updated',
              updateKind: 'strm_target_synced',
              ...videoIdentity(existingResource.video_id),
              resourceId: existingResource.id,
              resourceKind: target.kind
            })
          } else {
            result.skipped += 1
            recordFile({
              filePath: file,
              sourceKind: 'strm',
              outcome: 'skipped',
              skipReason: 'unchanged',
              ...videoIdentity(existingResource.video_id),
              resourceId: existingResource.id,
              resourceKind: existingResource.kind
            })
          }
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        const code = codeForNewFile(file)
        if (refreshPendingIdentity(libraryId, root, file, target)) {
          recordFile({
            filePath: file,
            sourceKind: 'strm',
            outcome: 'pending',
            normalizedCode: null,
            groupId: null,
            addedToQueue: false,
            nfo: { disposition: 'identity-conflict' }
          })
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }
        const nfoPreflight = nfoPreflightByFile.get(file)
        if (nfoPreflight?.identityConflict && nfoPreflight.filenameCode && nfoPreflight.nfoCode) {
          authorizeFileWrite()
          const fingerprint = statFileFingerprint(file)
          const pendingIdentity = upsertPendingResourceIdentity({
            libraryId,
            rootId,
            filePath: file,
            sourceKind: 'strm',
            targetKind: target.kind,
            targetLocator: target.locator,
            targetKey: target.targetKey,
            filenameCode: nfoPreflight.filenameCode,
            nfoCode: nfoPreflight.nfoCode,
            sizeBytes: fingerprint?.file_size ?? null,
            fileMtimeMs: fingerprint?.file_mtime_ms ?? null
          })
          result.pendingResources += 1
          recordFile({
            filePath: file,
            sourceKind: 'strm',
            outcome: 'pending',
            normalizedCode: null,
            groupId: null,
            addedToQueue: true,
            nfo: {
              disposition: 'identity-conflict',
              pendingIdentityId: pendingIdentity.id,
              ...(nfoPreflight.inspection.warnings.length > 0
                ? { warnings: safeNfoWarnings(nfoPreflight.inspection.warnings) }
                : {})
            }
          })
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }
        if (pendingScanResourceExists(libraryId, file)) {
          let groupId: number | null = null
          if (code) {
            authorizeFileWrite()
            const pending = upsertPendingScanResources(libraryId, code, [
              {
                rootId,
                filePath: file,
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
            groupId = pending.groupId
          }
          recordFile({
            filePath: file,
            sourceKind: 'strm',
            outcome: 'pending',
            normalizedCode: code ? normalizeVideoCode(code) : null,
            groupId,
            addedToQueue: false
          })
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        const relocation = findStrmRelocationCandidate(
          libraryId,
          file,
          target.targetKey,
          unavailableRootIds,
          inspectPath
        )
        if (relocation) {
          authorizeFileWrite()
          relocateStrmVideoResource(libraryId, relocation.resource_id, {
            rootId,
            sourcePath: file,
            kind: target.kind,
            locator: target.locator
          })
          result.relocated += 1
          recordFile({
            filePath: file,
            sourceKind: 'strm',
            outcome: 'updated',
            updateKind: 'relocated',
            ...videoIdentity(relocation.video_id),
            resourceId: relocation.resource_id,
            resourceKind: target.kind
          })
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        if (!code) {
          result.failed += 1
          result.unrecognizedFiles.push(file)
          recordFile({ filePath: file, sourceKind: 'strm', outcome: 'unrecognized' })
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        const existingVideos = listVideosByCode(code)

        const mustConfirm = autoMergeSameCodeResources
          ? existingVideos.length > 1
          : existingVideos.length > 0 || (newFileCounts.get(code) ?? 0) > 1
        if (mustConfirm) {
          authorizeFileWrite()
          const pending = upsertPendingScanResources(libraryId, code, [
            {
              rootId,
              filePath: file,
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
          recordFile({
            filePath: file,
            sourceKind: 'strm',
            outcome: 'pending',
            normalizedCode: normalizeVideoCode(code),
            groupId: pending.groupId,
            addedToQueue: pending.addedResources > 0
          })
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        if (existingVideos.length === 1) {
          const needsPrimarySelection =
            listVideoResources(libraryId, existingVideos[0].id).length === 0
          authorizeFileWrite()
          const resourceId = insertStrmVideoResource({
            libraryId,
            videoId: existingVideos[0].id,
            rootId,
            sourcePath: file,
            kind: target.kind,
            locator: target.locator,
            displayName: path.basename(file)
          })
          if (resourceId == null) result.skipped += 1
          else {
            result.imported += 1
            if (needsPrimarySelection) primarySelectionVideoIds.add(existingVideos[0].id)
            queueNfoCandidate(existingVideos[0].id, existingVideos[0].code, file)
          }
          recordFile(
            resourceId == null
              ? {
                  filePath: file,
                  sourceKind: 'strm',
                  outcome: 'skipped',
                  skipReason: 'duplicate'
                }
              : {
                  filePath: file,
                  sourceKind: 'strm',
                  outcome: 'added',
                  videoId: existingVideos[0].id,
                  videoCode: existingVideos[0].code,
                  resourceId,
                  resourceKind: target.kind,
                  createdVideo: false
                }
          )
        } else {
          authorizeFileWrite()
          const videoId = insertNewScannedStrmVideo({
            libraryId,
            rootId,
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
            queueNfoCandidate(videoId, code, file)
          }
          const resource = videoId == null ? null : strmResourceInLibrary(libraryId, file)
          recordFile(
            videoId == null || !resource
              ? {
                  filePath: file,
                  sourceKind: 'strm',
                  outcome: 'skipped',
                  skipReason: 'duplicate'
                }
              : {
                  filePath: file,
                  sourceKind: 'strm',
                  outcome: 'added',
                  videoId,
                  videoCode: code,
                  resourceId: resource.id,
                  resourceKind: resource.kind,
                  createdVideo: true
                }
          )
        }
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      const registeredResource = getLocalVideoResourceByLocator(libraryId, file)
      if (registeredResource) {
        const existingResource = localResourceInLibrary(libraryId, file)
        const refreshed = existingResource
          ? await refreshScannedFileDuration(
              libraryId,
              file,
              readDurationSeconds,
              authorizeFileWrite
            )
          : false
        if (refreshed) {
          result.refreshed += 1
          if (existingResource) {
            recordFile({
              filePath: file,
              sourceKind: 'local',
              outcome: 'updated',
              updateKind: 'metadata_refreshed',
              ...videoIdentity(existingResource.video_id),
              resourceId: existingResource.id,
              resourceKind: 'local'
            })
          }
        } else {
          result.skipped += 1
          recordFile({
            filePath: file,
            sourceKind: 'local',
            outcome: 'skipped',
            skipReason: 'unchanged',
            ...(existingResource
              ? {
                  ...videoIdentity(existingResource.video_id),
                  resourceId: existingResource.id,
                  resourceKind: 'local' as const
                }
              : {})
          })
        }
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      if (refreshPendingIdentity(libraryId, root, file)) {
        recordFile({
          filePath: file,
          sourceKind: 'local',
          outcome: 'pending',
          normalizedCode: null,
          groupId: null,
          addedToQueue: false,
          nfo: { disposition: 'identity-conflict' }
        })
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      if (pendingScanResourceExists(libraryId, file)) {
        const code = parseCode(path.basename(file, path.extname(file)))
        let groupId: number | null = null
        if (code) {
          const fileDurationSeconds = await readDurationSeconds(file)
          authorizeFileWrite()
          const fingerprint = statFileFingerprint(file)
          const pending = upsertPendingScanResources(libraryId, code, [
            {
              rootId,
              filePath: file,
              sizeBytes: fingerprint?.file_size ?? null,
              durationSeconds: fileDurationSeconds,
              fileMtimeMs: fingerprint?.file_mtime_ms ?? null,
              displayName: path.basename(file)
            }
          ])
          pendingGroupIds.add(pending.groupId)
          groupId = pending.groupId
        }
        recordFile({
          filePath: file,
          sourceKind: 'local',
          outcome: 'pending',
          normalizedCode: code ? normalizeVideoCode(code) : null,
          groupId,
          addedToQueue: false
        })
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      let probedDuration: number | null | undefined = undefined
      if (minImportDurationSeconds != null) {
        probedDuration = await readDurationSeconds(file)
        authorizeFileWrite()
        if (isBelowMinImportDuration(probedDuration, minImportDurationSeconds)) {
          result.skipped += 1
          result.skippedShort += 1
          recordFile({
            filePath: file,
            sourceKind: 'local',
            outcome: 'skipped',
            skipReason: 'below_min_duration'
          })
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }
      }

      const nfoPreflight = nfoPreflightByFile.get(file)
      if (nfoPreflight?.identityConflict && nfoPreflight.filenameCode && nfoPreflight.nfoCode) {
        authorizeFileWrite()
        const fingerprint = statFileFingerprint(file)
        const pendingIdentity = upsertPendingResourceIdentity({
          libraryId,
          rootId,
          filePath: file,
          sourceKind: 'local',
          filenameCode: nfoPreflight.filenameCode,
          nfoCode: nfoPreflight.nfoCode,
          sizeBytes: fingerprint?.file_size ?? null,
          fileMtimeMs: fingerprint?.file_mtime_ms ?? null
        })
        result.pendingResources += 1
        recordFile({
          filePath: file,
          sourceKind: 'local',
          outcome: 'pending',
          normalizedCode: null,
          groupId: null,
          addedToQueue: true,
          nfo: {
            disposition: 'identity-conflict',
            pendingIdentityId: pendingIdentity.id,
            ...(nfoPreflight.inspection.warnings.length > 0
              ? { warnings: safeNfoWarnings(nfoPreflight.inspection.warnings) }
              : {})
          }
        })
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      const code = codeForNewFile(file)
      if (!code) {
        result.failed += 1
        result.unrecognizedFiles.push(file)
        recordFile({ filePath: file, sourceKind: 'local', outcome: 'unrecognized' })
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      const existingVideos = listVideosByCode(code)
      const fileDurationSeconds = await resolveImportDurationSeconds(
        file,
        readDurationSeconds,
        probedDuration
      )
      authorizeFileWrite()
      const fingerprint = statFileFingerprint(file)
      const relocation = findRelocationCandidate(
        libraryId,
        existingVideos,
        file,
        fingerprint?.file_size ?? null,
        unavailableRootIds,
        inspectPath
      )
      if (relocation) {
        authorizeFileWrite()
        relocateLocalVideoResourceById(
          libraryId,
          relocation.id,
          rootId,
          file,
          fingerprint?.file_size ?? null,
          fileDurationSeconds,
          fingerprint?.file_mtime_ms ?? null
        )
        result.relocated += 1
        recordFile({
          filePath: file,
          sourceKind: 'local',
          outcome: 'updated',
          updateKind: 'relocated',
          ...videoIdentity(relocation.video_id),
          resourceId: relocation.id,
          resourceKind: 'local'
        })
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      const mustConfirm = autoMergeSameCodeResources
        ? existingVideos.length > 1
        : existingVideos.length > 0 || (newFileCounts.get(code) ?? 0) > 1
      if (mustConfirm) {
        authorizeFileWrite()
        const pending = upsertPendingScanResources(libraryId, code, [
          {
            rootId,
            filePath: file,
            sizeBytes: fingerprint?.file_size ?? null,
            durationSeconds: fileDurationSeconds,
            fileMtimeMs: fingerprint?.file_mtime_ms ?? null,
            displayName: path.basename(file)
          }
        ])
        pendingGroupIds.add(pending.groupId)
        result.pendingResources += pending.addedResources
        recordFile({
          filePath: file,
          sourceKind: 'local',
          outcome: 'pending',
          normalizedCode: normalizeVideoCode(code),
          groupId: pending.groupId,
          addedToQueue: pending.addedResources > 0
        })
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      if (existingVideos.length === 1) {
        const needsPrimarySelection =
          listVideoResources(libraryId, existingVideos[0].id).length === 0
        authorizeFileWrite()
        const resourceId = insertLocalVideoResource({
          libraryId,
          videoId: existingVideos[0].id,
          rootId,
          locator: file,
          sizeBytes: fingerprint?.file_size ?? null,
          durationSeconds: fileDurationSeconds,
          fileMtimeMs: fingerprint?.file_mtime_ms ?? null
        })
        if (resourceId != null) {
          result.imported += 1
          if (needsPrimarySelection) primarySelectionVideoIds.add(existingVideos[0].id)
          queueNfoCandidate(existingVideos[0].id, existingVideos[0].code, file)
        } else result.skipped += 1
        recordFile(
          resourceId == null
            ? {
                filePath: file,
                sourceKind: 'local',
                outcome: 'skipped',
                skipReason: 'duplicate'
              }
            : {
                filePath: file,
                sourceKind: 'local',
                outcome: 'added',
                videoId: existingVideos[0].id,
                videoCode: existingVideos[0].code,
                resourceId,
                resourceKind: 'local',
                createdVideo: false
              }
        )
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      authorizeFileWrite()
      const id = insertScannedVideo(
        buildScannedVideoImport(libraryId, rootId, code, file, fileDurationSeconds, fingerprint)
      )
      if (id !== null) {
        result.imported += 1
        result.newCodes.push(code)
        primarySelectionVideoIds.add(id)
        queueNfoCandidate(id, code, file)
        const resource = localResourceInLibrary(libraryId, file)
        if (resource) {
          recordFile({
            filePath: file,
            sourceKind: 'local',
            outcome: 'added',
            videoId: id,
            videoCode: code,
            resourceId: resource.id,
            resourceKind: 'local',
            createdVideo: true
          })
        }
      } else {
        result.skipped += 1
        recordFile({
          filePath: file,
          sourceKind: 'local',
          outcome: 'skipped',
          skipReason: 'duplicate'
        })
      }
    } catch (err) {
      console.error('Scan error for', file, err)
      result.failed += 1
      recordFile({
        filePath: file,
        sourceKind: isStrmFile(file) ? 'strm' : 'local',
        outcome: 'processing_failure',
        message: sanitizeLibraryScanError(err)
      })
    }

    onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
    await maybeYield(result.scannedFiles, yieldEvery)
  }

  for (const [videoId, batch] of nfoBatchesByVideo) {
    let nfo: LibraryScanNfoAudit
    try {
      const applied = await nfoService.apply(videoId, batch.code, batch.anchors)
      nfo = {
        disposition: applied.disposition === 'none' ? 'skipped' : applied.disposition,
        ...(applied.warnings.length > 0 ? { warnings: safeNfoWarnings(applied.warnings) } : {}),
        ...(applied.pendingScrapeId != null
          ? { pendingScrapeId: applied.pendingScrapeId }
          : {})
      }
    } catch (error) {
      nfo = {
        disposition: 'warning',
        warnings: safeNfoWarnings([sanitizeLibraryScanError(error)])
      }
    }
    for (const anchor of batch.anchors) {
      const auditEntry = auditEntriesByFile.get(anchor.anchorPath)
      if (!auditEntry) continue
      const warnings = safeNfoWarnings([
        ...(auditEntry.nfo?.warnings?.map((warning) => warning.message) ?? []),
        ...(nfo.warnings?.map((warning) => warning.message) ?? [])
      ])
      auditEntry.nfo = {
        ...nfo,
        ...(warnings.length > 0 ? { warnings } : {})
      }
    }
  }

  result.pendingGroups = pendingGroupIds.size

  for (const videoId of primarySelectionVideoIds) {
    const candidates = listVideoResources(libraryId, videoId).map((resource) => ({
      resource,
      filePath: resource.strm_source_path ?? resource.locator,
      sourceKind: resource.strm_source_path ? ('strm' as const) : ('local' as const),
      targetKind: resource.kind === 'local' ? null : resource.kind,
      durationSeconds: resource.duration_seconds,
      sizeBytes: resource.size_bytes
    }))
    const primary = selectDefaultPendingScanPrimary(candidates, normalizeLocalPathIdentity)
    if (primary) {
      if (primary.resource.root_id != null) {
        const root = roots.find((candidate) => candidate.id === primary.resource.root_id)
        if (!root) throw new Error('主资源候选不属于本次扫描根目录快照')
        authorizeMediaLibraryRootFile(
          libraryId,
          root.id,
          primary.filePath,
          root
        )
      }
      setPrimaryVideoResource(libraryId, videoId, primary.resource.id)
    }
  }

  for (const entry of auditEntriesByFile.values()) {
    options.onFileResult?.(entry)
  }

  return result
}

const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/

export interface RenameAndImportRequest {
  libraryId: number
  rootId: number
  oldPath: string
  newName: string
}

export interface ManualImportRequest {
  libraryId: number
  rootId: number
  filePath: string
  code: string
  target: VideoResourceImportTarget
}

export interface ManualImportOptions {
  /** Test seam for deterministically exercising the probe-to-commit race. */
  readDurationSeconds?: (filePath: string) => Promise<number | null>
  /** Frozen by rename-and-import so the physical operation and import share one authority. */
  expectedRoot?: Readonly<MediaLibraryRoot>
}

export type RenameAndImportOptions = Pick<ManualImportOptions, 'readDurationSeconds'>

function assertManagedImportPath(
  libraryId: number,
  rootId: number,
  filePath: string,
  expectedRoot?: Readonly<MediaLibraryRoot>
): MediaLibraryRoot {
  return authorizeMediaLibraryRootFile(libraryId, rootId, filePath, expectedRoot)
}

/**
 * Rename a file on disk (keeping its original extension unless the new name
 * already carries one), then rediscover it using the library's ordinary scan rules.
 * Used to fix up files the scanner couldn't recognize.
 */
export async function renameAndImport(
  input: RenameAndImportRequest,
  options: RenameAndImportOptions = {}
): Promise<RenameImportResult> {
  const { libraryId, rootId, oldPath } = input
  if (!fs.existsSync(oldPath)) throw new Error('原文件不存在或已被移动')
  const expectedRoot = assertManagedImportPath(libraryId, rootId, oldPath)
  const config = getMediaLibraryConfig(libraryId)
  if (!config) throw new Error('媒体库配置不存在')

  const newName = input.newName.trim()
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
    assertManagedImportPath(libraryId, rootId, oldPath, expectedRoot)
    fs.renameSync(oldPath, newPath)
  }

  // Renaming is the requested operation. A failed recognition must not undo it.
  const response: RenameImportResult = {
    newPath, newName: path.basename(newPath), imported: false,
    code: parseCode(path.basename(newPath, path.extname(newPath))), outcome: 'failed'
  }
  const entries: LibraryScanFileAuditEntry[] = []
  try {
    const result = await scanFolders({
      libraryId, runId: `rename:${rootId}`, roots: [expectedRoot], filePaths: [newPath]
    }, undefined, {
      ...options,
      autoMergeSameCodeResources: config.autoMergeSameCodeResources,
      autoImportLocalNfo: config.autoImportLocalNfo,
      minImportDurationSeconds: config.minImportDurationMinutes * 60,
      onFileResult: (entry) => entries.push(entry)
    })
    const entry = entries[0]
    if (entry && 'videoCode' in entry) response.code = entry.videoCode ?? response.code
    if (entry?.outcome === 'pending') response.code = entry.normalizedCode
    response.imported = result.imported > 0 || result.relocated > 0 || result.refreshed > 0
    response.outcome = response.imported ? 'imported'
      : entry?.outcome === 'pending' ? 'pending'
        : result.unrecognizedFiles.length > 0 ? 'unrecognized'
          : result.failed > 0 ? 'failed' : 'skipped'
    if (entry && 'message' in entry) response.message = entry.message
    if (entry?.outcome === 'skipped' && entry.skipReason === 'below_min_duration') {
      response.message = '低于媒体库设置的导入最小时长'
    }
  } catch (error) {
    response.message = sanitizeLibraryScanError(error)
  }
  return response
}

/**
 * Import a file with a user-supplied code. Does not rename the file and does not
 * validate code format beyond the shared trim-and-uppercase identity rule.
 */
export async function importManual(
  input: ManualImportRequest,
  options: ManualImportOptions = {}
): Promise<ManualImportResult> {
  const { libraryId, rootId, filePath, target } = input
  if (!fs.existsSync(filePath)) throw new Error('原文件不存在或已被移动')
  const expectedRoot = assertManagedImportPath(
    libraryId,
    rootId,
    filePath,
    options.expectedRoot
  )

  const code = normalizeVideoCode(input.code)

  if (isStrmFile(filePath)) {
    const parsed = readStrmFile(filePath)
    if (getStrmVideoResourceBySourcePath(libraryId, filePath)) {
      return { code, imported: false, skippedPath: true }
    }
    if (target.kind === 'existing') {
      const existing = listVideosByCode(code).find((video) => video.id === target.videoId)
      if (!existing) throw new Error('所选影片不存在或番号已经变化')
      assertManagedImportPath(libraryId, rootId, filePath, expectedRoot)
      const resourceId = insertStrmVideoResource({
        libraryId,
        videoId: existing.id,
        rootId,
        sourcePath: filePath,
        kind: parsed.kind,
        locator: parsed.locator,
        displayName: path.basename(filePath)
      })
      return { code, imported: resourceId !== null }
    }
    assertManagedImportPath(libraryId, rootId, filePath, expectedRoot)
    const videoId = insertNewScannedStrmVideo({
      libraryId,
      rootId,
      code,
      sourcePath: filePath,
      kind: parsed.kind,
      locator: parsed.locator,
      displayName: path.basename(filePath)
    })
    return { code, imported: videoId !== null }
  }

  if (getLocalVideoResourceByLocator(libraryId, filePath)) {
    return { code, imported: false, skippedPath: true }
  }

  const fileDurationSeconds = await (
    options.readDurationSeconds ?? readLocalVideoDurationSeconds
  )(filePath)
  assertManagedImportPath(libraryId, rootId, filePath, expectedRoot)
  const fingerprint = statFileFingerprint(filePath)
  if (target.kind === 'existing') {
    const existing = listVideosByCode(code).find((video) => video.id === target.videoId)
    if (!existing) throw new Error('所选影片不存在或番号已经变化')
    const localResource = getPreferredLocalVideoResource(libraryId, existing.id)
    if (localResource && !fs.existsSync(localResource.locator)) {
      assertManagedImportPath(libraryId, rootId, filePath, expectedRoot)
      relocateLocalVideoResource(
        libraryId,
        existing.id,
        rootId,
        filePath,
        fingerprint?.file_size ?? null,
        fileDurationSeconds,
        fingerprint?.file_mtime_ms ?? null
      )
      return { code, imported: true, relocated: true }
    }
    if (!getLocalVideoResourceByLocator(libraryId, filePath)) {
      assertManagedImportPath(libraryId, rootId, filePath, expectedRoot)
      const resourceId = insertLocalVideoResource({
        libraryId,
        videoId: existing.id,
        rootId,
        locator: filePath,
        sizeBytes: fingerprint?.file_size ?? null,
        durationSeconds: fileDurationSeconds,
        fileMtimeMs: fingerprint?.file_mtime_ms ?? null
      })
      return { code, imported: resourceId !== null, relocated: false }
    }
    return { code, imported: false, skippedPath: false }
  }

  assertManagedImportPath(libraryId, rootId, filePath, expectedRoot)
  const id = insertNewScannedVideo(
    buildScannedVideoImport(
      libraryId,
      rootId,
      code,
      filePath,
      fileDurationSeconds,
      fingerprint
    )
  )
  return { code, imported: id !== null }
}
