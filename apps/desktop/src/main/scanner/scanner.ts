import { createScanNfoWorkset, createMemoryScanNfoWorkset, ScanNfoWorksetError, type ScanNfoWorkset } from './scanNfoWorkset'
import { createScanCodeCounts, createMemoryScanCodeCounts, ScanCodeCountsError, type ScanCodeCounts } from './scanCodeCounts'
import { createScanFileSpool, createMemoryScanFileInventory } from './scanFileInventory'
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
} from '@library/db/videoRepo'
import type {
  ManualImportResult,
  LibraryScanFileAuditEntry,
  LibraryScanNfoAudit,
  RenameImportResult,
  ScanProgress,
  ScanResult,
  ScanCompletionResult,
  ScanExecutionResult,
  StrmScanFailure
} from '@shared/libraryTypes'
import type { ScannedVideoInput } from '@library/db/videoRepo'
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
} from '@library/db/pendingScanRepo'
import {
  StrmParseError,
  isStrmFile,
  readStrmFile,
  type ParsedStrmTarget
} from '@library/scan/strmParser'
import { getDb, getDatabaseReadRevision } from '@library/db/database'
import { StrmRelocationIndex } from './strmRelocationIndex'
import { normalizeLocalPathIdentity } from '@library/localPathIdentity'
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
} from '@library/db/pendingResourceIdentityRepo'
import {
  localNfoScanService,
  type LocalNfoScanService,
  type LocalNfoScanApplyResult
} from '../services/localNfoScanService'
import type {
  LocalNfoAnchor,
  LocalNfoIdentityInspection
} from '../metadata-sources'
import { appendDirectoryVideoCode, summarizeDirectoryVideoCodes } from '../nfo/directoryVideoIdentity'
import { indexNfoSidecars } from '../nfo/nfoSidecarLocator'
import { getMediaLibraryConfig } from '@library/db/mediaLibraryRepo'

export type ScanProgressFn = (progress: ScanProgress) => void

/** Rescanning refreshes file evidence without choosing either pending identity. */
function preparePendingIdentityRefresh(
  libraryId: number,
  root: Readonly<MediaLibraryRoot>,
  filePath: string,
  target?: ParsedStrmTarget
): (() => void) | null {
  const pending = getPendingResourceIdentityByPath(libraryId, filePath)
  if (!pending) return null
  authorizeMediaLibraryRootFile(libraryId, root.id, filePath, root)
  const fingerprint = statFileFingerprint(filePath)
  if (!fingerprint) throw new Error('待确认资源无法读取，保留原身份待办。')
  return () => {
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
  }
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

/** Caller-owned synchronous audit persistence. Must not mutate video_resources or hold a transaction across scan awaits. */
export interface ScanAuditSink {
  recordFile(entry: LibraryScanFileAuditEntry): void
  readFileNfo(filePath: string): { nfo?: LibraryScanNfoAudit } | undefined
  patchNfo(filePath: string, nfo: LibraryScanNfoAudit): boolean
}

export interface ScanOptions {
  /** Summary requires a durable audit sink and omits per-file result arrays. */
  resultMode?: 'detailed' | 'summary'
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
  /** Incremental storage instead of the legacy in-memory final callback collection. */
  auditSink?: ScanAuditSink
}

function synchronousAuditResult<T>(value: T): T {
  if (value != null && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function') {
    // A caller may accidentally pass an async function to a void callback.
    // Observe rejection, but never pretend an in-flight write has completed.
    void Promise.resolve(value).catch(() => {})
    throw new Error('Audit sink methods must be synchronous')
  }
  return value
}

const DEFAULT_YIELD_EVERY = 50

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
  append: (filePath: string) => boolean,
  signal: AbortSignal | undefined,
  readDirectory: (dir: string) => Promise<fs.Dirent[]>
): Promise<void> {
  if (signal?.aborted) return
  let entries: fs.Dirent[]
  try {
    entries = await readDirectory(dir)
  } catch (error) {
    throw new Error(`无法读取媒体目录 ${dir}：${(error as Error).message}`, { cause: error })
  }
  for (const entry of entries) {
    if (signal?.aborted) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectScannableFiles(full, append, signal, readDirectory)
    } else if (entry.isFile() && (isVideoFile(full) || isStrmFile(full))) {
      if (append(full)) await yieldToEventLoop()
    } else if (entry.isSymbolicLink() && (isVideoFile(full) || isStrmFile(full))) {
      let isFile = false
      try {
        isFile = (await fs.promises.stat(full)).isFile()
      } catch {
        // Broken or inaccessible symbolic link — skip only the filesystem failure.
      }
      if (isFile && append(full)) await yieldToEventLoop()
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

/** Probe first; the caller authorizes and commits the returned mutation with its audit. */
async function prepareScannedFileRefresh(
  libraryId: number,
  file: string,
  readDurationSeconds: DurationReader,
  authorizeWrite: () => void
): Promise<(() => boolean) | null> {
  const fingerprint = statFileFingerprint(file)
  if (!fingerprint) return null
  const record = resolveRefreshTarget(libraryId, file)
  if (!record) return null
  if (!shouldProbeLocalVideoResourceDuration(record, fingerprint)) {
    if (record.file_mtime_ms == null) {
      return () => {
        backfillLocalVideoResourceFingerprint(record.id, {
          sizeBytes: fingerprint.file_size,
          fileMtimeMs: fingerprint.file_mtime_ms
        })
        return true
      }
    }
    return null
  }
  const fileDurationSeconds = await readDurationSeconds(file)
  if (fileDurationSeconds == null || fileDurationSeconds <= 0) {
    // Preserve the old authorization check even when the probe has no usable result.
    authorizeWrite()
    return null
  }
  const nextDuration = shouldRefreshLocalVideoResourceDuration(record.duration_seconds, fileDurationSeconds)
    ? fileDurationSeconds : record.duration_seconds
  return () => {
    updateLocalVideoResourceAfterProbe(record.id, {
      durationSeconds: nextDuration,
      sizeBytes: fingerprint.file_size,
      fileMtimeMs: fingerprint.file_mtime_ms
    })
    return true
  }
}

/** Transfers the stopped scanner's result without copying its potentially large arrays. */
export class ScanFoldersFailure extends Error {
  constructor(readonly partialResult: ScanExecutionResult, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'ScanFoldersFailure'
  }
}

/**
 * Scan the given folders, parse codes, and add or refresh local video resources.
 * Missing-resource reconciliation is owned by the scan coordinator so it can
 * distinguish accessible folders from offline folders.
 */
export function scanFolders(
  request: ScanFoldersRequest, onProgress: ScanProgressFn | undefined,
  options: ScanOptions & { resultMode: 'summary' }
): Promise<ScanCompletionResult>
export function scanFolders(
  request: ScanFoldersRequest, onProgress?: ScanProgressFn,
  options?: ScanOptions & { resultMode?: 'detailed' }
): Promise<ScanResult>
export function scanFolders(
  request: ScanFoldersRequest, onProgress?: ScanProgressFn, options?: ScanOptions
): Promise<ScanExecutionResult>
export async function scanFolders(
  request: ScanFoldersRequest,
  onProgress?: ScanProgressFn,
  options: ScanOptions = {}
): Promise<ScanExecutionResult> {
  if (!Number.isSafeInteger(request.libraryId) || request.libraryId <= 0) {
    throw new Error('媒体库 ID 无效')
  }
  if (!request.runId.trim()) throw new Error('扫描运行 ID 不能为空')
  if (options.resultMode === 'summary' && !options.auditSink) throw new Error('Summary scan results require an audit sink')
  if (options.auditSink && options.onFileResult) throw new Error('Audit sink and final callback are mutually exclusive')
  const auditSink = options.auditSink
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
  const result: ScanExecutionResult = {
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
    ...(options.resultMode === 'summary' ? { unrecognizedCount: 0 } : { newCodes: [], unrecognizedFiles: [] }),
    strmFailures: [],
    omittedStrmFailures: 0
  }

  const pendingGroupIds = new Set<number>()
  try {
    const inventory = options.resultMode === 'summary'
      ? createScanFileSpool(getDb(), roots)
      : createMemoryScanFileInventory(roots)
    let failed = false
    let failure: unknown
    let completedResult = result
    let codeCounts: ScanCodeCounts | undefined
    let nfoWorkset: ScanNfoWorkset | undefined
    try {
      codeCounts = options.resultMode !== 'summary' ? createMemoryScanCodeCounts()
        : options.autoMergeSameCodeResources ? undefined : createScanCodeCounts(getDb())
      if (options.autoImportLocalNfo) {
        nfoWorkset = options.resultMode === 'summary'
          ? createScanNfoWorkset(getDb(), roots) : createMemoryScanNfoWorkset(roots)
      }
      completedResult = await scanPreparedFolders(request, onProgress, options, roots, result, pendingGroupIds, inventory, codeCounts, nfoWorkset)
    } catch (error) {
      failed = true
      failure = error
    } finally {
      try { disposeScanPreparation([inventory, ...(codeCounts ? [codeCounts] : []), ...(nfoWorkset ? [nfoWorkset] : [])]) } catch (error) {
        // Preserve the triggering scan failure; a cleanup-only failure is still fatal.
        if (!failed) { failed = true; failure = error }
      }
    }
    if (failed) throw failure
    return completedResult
  } catch (error) {
    if (!auditSink) throw error
    result.pendingGroups = pendingGroupIds.size
    throw new ScanFoldersFailure(result, error)
  }
}

/** Try every scratch cleanup even if another fails; retain the first cleanup error. */
function disposeScanPreparation(resources: readonly { dispose(): void }[]): void {
  let failed = false
  let failure: unknown
  for (const resource of resources) {
    try { resource.dispose() } catch (error) {
      if (!failed) { failed = true; failure = error }
    }
  }
  if (failed) throw failure
}

async function scanPreparedFolders(
  request: ScanFoldersRequest,
  onProgress: ScanProgressFn | undefined,
  options: ScanOptions,
  roots: readonly Readonly<MediaLibraryRoot>[],
  result: ScanExecutionResult,
  pendingGroupIds: Set<number>,
  files: ReturnType<typeof createMemoryScanFileInventory>,
  newFileCounts: ScanCodeCounts | undefined,
  nfoWorkset: ScanNfoWorkset | undefined
): Promise<ScanExecutionResult> {
  const libraryId = request.libraryId
  const auditSink = options.auditSink
  const autoImportLocalNfo = options.autoImportLocalNfo ?? false
  const unavailableRootIds = new Set(options.unavailableRootIds ?? [])
  const readDirectory =
    options.readDirectory ??
    ((dir: string) => fs.promises.readdir(dir, { withFileTypes: true }))
  const inspectPath = options.inspectPath ?? inspectScannedResourcePath
  const asStrmRef = (resource: VideoResource | null) =>
    resource?.strm_source_path && resource.kind !== 'local'
      ? {
          library_id: resource.library_id,
          video_id: resource.video_id,
          resource_id: resource.id,
          source_path: resource.strm_source_path,
          kind: resource.kind,
          locator: resource.locator,
          root_id: resource.root_id
        }
      : null
  const strmRelocations = new StrmRelocationIndex({
    revision: getDatabaseReadRevision,
    list: () => listStrmVideoResourceRefs(libraryId),
    get: (id) => asStrmRef(getVideoResourceInLibrary(libraryId, id)),
    getByPath: (sourcePath) => asStrmRef(strmResourceInLibrary(libraryId, sourcePath)),
    inspect: inspectPath,
    unavailableRootIds
  })
  for (const root of roots) {
    if (options.signal?.aborted) {
      result.cancelled = true
      return result
    }
    const appendFile = (filePath: string): boolean => files.append(filePath, root.id)
    const readIndexedDirectory = async (directory: string): Promise<fs.Dirent[]> => {
      const entries = await readDirectory(directory)
      if (autoImportLocalNfo) {
        nfoWorkset!.setSidecars(directory, indexNfoSidecars(entries.map((entry) => entry.name)))
        if (request.filePaths) {
          nfoWorkset!.setDirectoryIdentity(directory, summarizeDirectoryVideoCodes((function* () {
            for (const entry of entries) {
              if (entry.isFile() && (isVideoFile(entry.name) || isStrmFile(entry.name))) {
                yield parseCode(path.basename(entry.name, path.extname(entry.name)))
              }
            }
          })()))
        }
      }
      return entries
    }
    if (request.filePaths) {
      // Targeted discovery uses one frozen root and still indexes siblings for NFO ownership.
      if (roots.length !== 1) throw new Error('单文件重新识别必须指定唯一根目录')
      for (const filePath of request.filePaths) {
        authorizeMediaLibraryRootFile(libraryId, root.id, filePath, root)
        if (appendFile(filePath)) await yieldToEventLoop()
        if (options.signal?.aborted) break
        const directory = path.dirname(filePath)
        if (autoImportLocalNfo && !nfoWorkset!.hasSidecars(directory)) await readIndexedDirectory(directory)
      }
    } else {
      await collectScannableFiles(root.path, appendFile, options.signal, readIndexedDirectory)
    }
  }
  if (options.signal?.aborted) {
    result.cancelled = true
    return result
  }
  files.seal()
  const yieldEvery = Math.max(1, options.yieldEvery ?? DEFAULT_YIELD_EVERY)
  const readDurationSeconds = options.readDurationSeconds ?? readLocalVideoDurationSeconds
  const minImportDurationSeconds =
    options.minImportDurationSeconds !== undefined ? options.minImportDurationSeconds : null
  const autoMergeSameCodeResources = options.autoMergeSameCodeResources ?? false
  const nfoService = options.localNfoService ?? localNfoScanService
  let indexedFiles = 0
  for (const { filePath } of files) {
    if (!autoImportLocalNfo || request.filePaths) break
    await maybeYield(++indexedFiles, yieldEvery)
    if (options.signal?.aborted) {
      result.cancelled = true
      return result
    }
    const directory = path.dirname(filePath)
    nfoWorkset!.setDirectoryIdentity(directory, appendDirectoryVideoCode(
      nfoWorkset!.getDirectoryIdentity(directory), parseCode(path.basename(filePath, path.extname(filePath)))
    ))
  }
  nfoWorkset?.sealDirectories()
  if (autoImportLocalNfo) {
    let inspectedNfoFiles = 0
    for (const { filePath, root } of files) {
      await maybeYield(++inspectedNfoFiles, Math.min(yieldEvery, 10))
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
        directoryVideoCodes: nfoWorkset!.getDirectoryIdentity(path.dirname(filePath)) ?? summarizeDirectoryVideoCodes([]),
        directorySidecars: nfoWorkset!.getSidecars(path.dirname(filePath))
      }
      let inspection: LocalNfoIdentityInspection
      try {
        inspection = nfoService.inspectIdentity(anchor)
      } catch (error) {
        if (error instanceof ScanNfoWorksetError) throw error
        inspection = {
          status: 'warning',
          code: null,
          warnings: [sanitizeLibraryScanError(error)]
        }
      }
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
        nfoWorkset!.setPreflight(filePath, {
          anchor,
          filenameCode,
          nfoCode,
          effectiveCode: identityConflict ? null : (nfoCode ?? filenameCode),
          identityConflict,
          inspection
        })
      }
    }
  }
  nfoWorkset?.sealPreflights()
  const codeForNewFile = (filePath: string): string | null => {
    const preflight = nfoWorkset?.getEffectiveCode(filePath)
    return preflight ? preflight.effectiveCode : parseCode(path.basename(filePath, path.extname(filePath)))
  }
  if (newFileCounts) {
    let countedFiles = 0
    for (const { filePath: file } of files) {
      await maybeYield(++countedFiles, yieldEvery)
      if (options.signal?.aborted) {
        result.cancelled = true
        return result
      }
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
      if (newFileCounts.add(code)) {
        await yieldToEventLoop()
        if (options.signal?.aborted) { result.cancelled = true; return result }
      }
    }
    newFileCounts.finishCounting()
    if (!autoMergeSameCodeResources) {
      let checkedStrmFiles = 0
      for (const { filePath: file } of files) {
        await maybeYield(++checkedStrmFiles, Math.min(yieldEvery, 10))
        if (options.signal?.aborted) {
          result.cancelled = true
          return result
        }
        if (!isStrmFile(file)) continue
        const code = codeForNewFile(file)
        if (!code || newFileCounts.get(code) <= 1) continue
        if (
          getLocalVideoResourceByLocator(libraryId, file) ||
          getStrmVideoResourceBySourcePath(libraryId, file) ||
          pendingScanResourceExists(libraryId, file) ||
          pendingResourceIdentityExists(libraryId, file) ||
          listVideosByCode(code).length > 0
        ) {
          continue
        }
        if (!readStrmTarget(file).ok) {
          newFileCounts.decrement(code)
        }
      }
    }
    newFileCounts.freeze()
  } else {
    // The default summary path needs no counts, but still admits cancellation before its first write.
    await yieldToEventLoop()
    if (options.signal?.aborted) { result.cancelled = true; return result }
  }
  const primarySelectionVideoIds = new Set<number>()
  const auditEntriesByFile = !auditSink && options.onFileResult ? new Map<string, LibraryScanFileAuditEntry>() : undefined
  let auditWriteFailed = false
  const queueNfoInsideCommit = options.resultMode === 'summary'
  const queueNfoCandidate = (videoId: number, code: string, filePath: string): void => {
    const preflight = nfoWorkset?.getPreflight(filePath)
    if (!preflight || preflight.identityConflict || preflight.inspection.status !== 'found') return
    strmRelocations.mutateWithoutResourceChanges(() => nfoWorkset!.enqueue(videoId, code, filePath))
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
    // Only synchronous business + audit segments belong here, never probes/progress/yields.
    const commitFileAudit = <T>(write: () => T): T => auditSink ? getDb().transaction(write)() : write()
    const recordFile = (entry: ScanFileAuditWithoutRoot): void => {
      if (!auditSink && !auditEntriesByFile) return
      const fullEntry = { ...entry, rootId } as LibraryScanFileAuditEntry
      const preflight = nfoWorkset?.getPreflight(file)
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
      if (auditSink) {
        try {
          strmRelocations.mutateWithoutResourceChanges(() => synchronousAuditResult(auditSink.recordFile(fullEntry)))
        }
        catch (error) { auditWriteFailed = true; throw error }
      } else auditEntriesByFile!.set(file, fullEntry)
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
          strmRelocations.mutateWithoutResourceChanges(() => commitFileAudit(() => {
            removePendingScanResource(libraryId, file)
            recordFile({
              filePath: file,
              sourceKind: 'strm',
              outcome: 'strm_failure',
              failureCode: prepared.failure.code,
              message: prepared.failure.message
            })
          }))
          recordStrmFailure(prepared.failure)
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        const target = prepared.target
        const existingResource = strmResourceInLibrary(libraryId, file)
        if (existingResource) {
          authorizeFileWrite()
          const refreshed = strmRelocations.mutate(file, () => commitFileAudit(() => {
            const changed = updateStrmVideoResourceTarget(existingResource.id, {
              kind: target.kind,
              locator: target.locator
            })
            recordFile(changed ? {
              filePath: file,
              sourceKind: 'strm',
              outcome: 'updated',
              updateKind: 'strm_target_synced',
              ...videoIdentity(existingResource.video_id),
              resourceId: existingResource.id,
              resourceKind: target.kind
            } : {
              filePath: file,
              sourceKind: 'strm',
              outcome: 'skipped',
              skipReason: 'unchanged',
              ...videoIdentity(existingResource.video_id),
              resourceId: existingResource.id,
              resourceKind: existingResource.kind
            })
            return changed
          }))
          if (refreshed) result.refreshed += 1
          else result.skipped += 1
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        const code = codeForNewFile(file)
        const refreshIdentity = preparePendingIdentityRefresh(libraryId, root, file, target)
        if (refreshIdentity) {
          strmRelocations.mutateWithoutResourceChanges(() => commitFileAudit(() => {
            refreshIdentity()
            recordFile({
              filePath: file,
              sourceKind: 'strm',
              outcome: 'pending',
              normalizedCode: null,
              groupId: null,
              addedToQueue: false,
              nfo: { disposition: 'identity-conflict' }
            })
          }))
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }
        const nfoPreflight = nfoWorkset?.getPreflight(file)
        if (nfoPreflight?.identityConflict && nfoPreflight.filenameCode && nfoPreflight.nfoCode) {
          const { filenameCode, nfoCode } = nfoPreflight
          authorizeFileWrite()
          const fingerprint = statFileFingerprint(file)
          strmRelocations.mutateWithoutResourceChanges(() => commitFileAudit(() => {
            const pendingIdentity = upsertPendingResourceIdentity({
              libraryId,
              rootId,
              filePath: file,
              sourceKind: 'strm',
              targetKind: target.kind,
              targetLocator: target.locator,
              targetKey: target.targetKey,
              filenameCode,
              nfoCode,
              sizeBytes: fingerprint?.file_size ?? null,
              fileMtimeMs: fingerprint?.file_mtime_ms ?? null
            })
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
          }))
          result.pendingResources += 1
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }
        if (pendingScanResourceExists(libraryId, file)) {
          if (code) authorizeFileWrite()
          const groupId = strmRelocations.mutateWithoutResourceChanges(() => commitFileAudit(() => {
            let groupId: number | null = null
            if (code) {
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
            return groupId
          }))
          if (groupId != null) pendingGroupIds.add(groupId)
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        const relocation = strmRelocations.find(file, target.targetKey)
        if (relocation) {
          authorizeFileWrite()
          strmRelocations.mutate(file, () => commitFileAudit(() => {
            relocateStrmVideoResource(libraryId, relocation.resource_id, {
              rootId,
              sourcePath: file,
              kind: target.kind,
              locator: target.locator
            })
            recordFile({
              filePath: file,
              sourceKind: 'strm',
              outcome: 'updated',
              updateKind: 'relocated',
              ...videoIdentity(relocation.video_id),
              resourceId: relocation.resource_id,
              resourceKind: target.kind
            })
          }))
          result.relocated += 1
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        if (!code) {
          recordFile({ filePath: file, sourceKind: 'strm', outcome: 'unrecognized' })
          result.failed += 1
          if ('unrecognizedFiles' in result) result.unrecognizedFiles.push(file)
          if ('unrecognizedCount' in result) result.unrecognizedCount++
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        const existingVideos = listVideosByCode(code)

        const mustConfirm = autoMergeSameCodeResources
          ? existingVideos.length > 1
          : existingVideos.length > 0 || newFileCounts!.get(code) > 1
        if (mustConfirm) {
          authorizeFileWrite()
          const pending = strmRelocations.mutateWithoutResourceChanges(() => commitFileAudit(() => {
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
            recordFile({
              filePath: file,
              sourceKind: 'strm',
              outcome: 'pending',
              normalizedCode: normalizeVideoCode(code),
              groupId: pending.groupId,
              addedToQueue: pending.addedResources > 0
            })
            return pending
          }))
          pendingGroupIds.add(pending.groupId)
          result.pendingResources += pending.addedResources
          onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
          await maybeYield(result.scannedFiles, yieldEvery)
          continue
        }

        if (existingVideos.length === 1) {
          const needsPrimarySelection =
            listVideoResources(libraryId, existingVideos[0].id).length === 0
          authorizeFileWrite()
          const resourceId = strmRelocations.mutate(file, () => commitFileAudit(() => {
            const resourceId = insertStrmVideoResource({
              libraryId,
              videoId: existingVideos[0].id,
              rootId,
              sourcePath: file,
              kind: target.kind,
              locator: target.locator,
              displayName: path.basename(file)
            })
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
            if (resourceId != null && queueNfoInsideCommit) queueNfoCandidate(existingVideos[0].id, existingVideos[0].code, file)
            return resourceId
          }))
          if (resourceId == null) result.skipped += 1
          else {
            result.imported += 1
            if (needsPrimarySelection) primarySelectionVideoIds.add(existingVideos[0].id)
            if (!queueNfoInsideCommit) queueNfoCandidate(existingVideos[0].id, existingVideos[0].code, file)
          }
        } else {
          authorizeFileWrite()
          const videoId = strmRelocations.mutate(file, () => commitFileAudit(() => {
            const videoId = insertNewScannedStrmVideo({
              libraryId,
              rootId,
              code,
              sourcePath: file,
              kind: target.kind,
              locator: target.locator,
              displayName: path.basename(file)
            })
            const resource = videoId == null ? null : strmResourceInLibrary(libraryId, file)
            if (auditSink && videoId != null && !resource) throw new Error('Imported STRM resource missing before audit commit')
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
            if (videoId != null && queueNfoInsideCommit) queueNfoCandidate(videoId, code, file)
            return videoId
          }))
          if (videoId == null) result.skipped += 1
          else {
            result.imported += 1
            if ('newCodes' in result) result.newCodes.push(code)
            primarySelectionVideoIds.add(videoId)
            if (!queueNfoInsideCommit) queueNfoCandidate(videoId, code, file)
          }
        }
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      const registeredResource = getLocalVideoResourceByLocator(libraryId, file)
      if (registeredResource) {
        const existingResource = localResourceInLibrary(libraryId, file)
        const refresh = existingResource
          ? await prepareScannedFileRefresh(libraryId, file, readDurationSeconds, authorizeFileWrite)
          : null
        if (refresh) authorizeFileWrite()
        const refreshed = commitFileAudit(() => {
          const changed = refresh?.() ?? false
          if (changed && existingResource) {
            recordFile({
              filePath: file,
              sourceKind: 'local',
              outcome: 'updated',
              updateKind: 'metadata_refreshed',
              ...videoIdentity(existingResource.video_id),
              resourceId: existingResource.id,
              resourceKind: 'local'
            })
          } else {
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
          return changed
        })
        if (refreshed) result.refreshed += 1
        else result.skipped += 1
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      const refreshIdentity = preparePendingIdentityRefresh(libraryId, root, file)
      if (refreshIdentity) {
        strmRelocations.mutateWithoutResourceChanges(() => commitFileAudit(() => {
          refreshIdentity()
          recordFile({
            filePath: file,
            sourceKind: 'local',
            outcome: 'pending',
            normalizedCode: null,
            groupId: null,
            addedToQueue: false,
            nfo: { disposition: 'identity-conflict' }
          })
        }))
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      if (pendingScanResourceExists(libraryId, file)) {
        const code = parseCode(path.basename(file, path.extname(file)))
        const fileDurationSeconds = code ? await readDurationSeconds(file) : null
        let fingerprint: VideoFileFingerprint | null = null
        if (code) {
          authorizeFileWrite()
          fingerprint = statFileFingerprint(file)
        }
        const groupId = strmRelocations.mutateWithoutResourceChanges(() => commitFileAudit(() => {
          let groupId: number | null = null
          if (code) {
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
          return groupId
        }))
        if (groupId != null) pendingGroupIds.add(groupId)
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

      const nfoPreflight = nfoWorkset?.getPreflight(file)
      if (nfoPreflight?.identityConflict && nfoPreflight.filenameCode && nfoPreflight.nfoCode) {
        const { filenameCode, nfoCode } = nfoPreflight
        authorizeFileWrite()
        const fingerprint = statFileFingerprint(file)
        strmRelocations.mutateWithoutResourceChanges(() => commitFileAudit(() => {
          const pendingIdentity = upsertPendingResourceIdentity({
            libraryId,
            rootId,
            filePath: file,
            sourceKind: 'local',
            filenameCode,
            nfoCode,
            sizeBytes: fingerprint?.file_size ?? null,
            fileMtimeMs: fingerprint?.file_mtime_ms ?? null
          })
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
        }))
        result.pendingResources += 1
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      const code = codeForNewFile(file)
      if (!code) {
        recordFile({ filePath: file, sourceKind: 'local', outcome: 'unrecognized' })
        result.failed += 1
        if ('unrecognizedFiles' in result) result.unrecognizedFiles.push(file)
        if ('unrecognizedCount' in result) result.unrecognizedCount++
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
        commitFileAudit(() => {
          relocateLocalVideoResourceById(
            libraryId,
            relocation.id,
            rootId,
            file,
            fingerprint?.file_size ?? null,
            fileDurationSeconds,
            fingerprint?.file_mtime_ms ?? null
          )
          recordFile({
            filePath: file,
            sourceKind: 'local',
            outcome: 'updated',
            updateKind: 'relocated',
            ...videoIdentity(relocation.video_id),
            resourceId: relocation.id,
            resourceKind: 'local'
          })
        })
        result.relocated += 1
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      const mustConfirm = autoMergeSameCodeResources
        ? existingVideos.length > 1
        : existingVideos.length > 0 || newFileCounts!.get(code) > 1
      if (mustConfirm) {
        authorizeFileWrite()
        const pending = strmRelocations.mutateWithoutResourceChanges(() => commitFileAudit(() => {
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
          recordFile({
            filePath: file,
            sourceKind: 'local',
            outcome: 'pending',
            normalizedCode: normalizeVideoCode(code),
            groupId: pending.groupId,
            addedToQueue: pending.addedResources > 0
          })
          return pending
        }))
        pendingGroupIds.add(pending.groupId)
        result.pendingResources += pending.addedResources
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      if (existingVideos.length === 1) {
        const needsPrimarySelection =
          listVideoResources(libraryId, existingVideos[0].id).length === 0
        authorizeFileWrite()
        const resourceId = commitFileAudit(() => {
          const resourceId = insertLocalVideoResource({
            libraryId,
            videoId: existingVideos[0].id,
            rootId,
            locator: file,
            sizeBytes: fingerprint?.file_size ?? null,
            durationSeconds: fileDurationSeconds,
            fileMtimeMs: fingerprint?.file_mtime_ms ?? null
          })
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
          if (resourceId != null && queueNfoInsideCommit) queueNfoCandidate(existingVideos[0].id, existingVideos[0].code, file)
          return resourceId
        })
        if (resourceId != null) {
          result.imported += 1
          if (needsPrimarySelection) primarySelectionVideoIds.add(existingVideos[0].id)
          if (!queueNfoInsideCommit) queueNfoCandidate(existingVideos[0].id, existingVideos[0].code, file)
        } else result.skipped += 1
        onProgress?.({ scanned: result.scannedFiles, imported: result.imported, currentFile: file })
        await maybeYield(result.scannedFiles, yieldEvery)
        continue
      }

      authorizeFileWrite()
      const id = commitFileAudit(() => {
        const id = insertScannedVideo(
          buildScannedVideoImport(libraryId, rootId, code, file, fileDurationSeconds, fingerprint)
        )
        if (id !== null) {
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
          } else if (auditSink) throw new Error('Imported local resource missing before audit commit')
        } else {
          recordFile({
            filePath: file,
            sourceKind: 'local',
            outcome: 'skipped',
            skipReason: 'duplicate'
          })
        }
        if (id !== null && queueNfoInsideCommit) queueNfoCandidate(id, code, file)
        return id
      })
      if (id !== null) {
        result.imported += 1
        if ('newCodes' in result) result.newCodes.push(code)
        primarySelectionVideoIds.add(id)
        if (!queueNfoInsideCommit) queueNfoCandidate(id, code, file)
      } else result.skipped += 1
    } catch (err) {
      // Storage failures must abort the run; converting them into a normal file
      // failure would conceal a missing durable audit after business writes.
      if (auditWriteFailed || err instanceof ScanCodeCountsError || err instanceof ScanNfoWorksetError) throw err
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

  // File inventory and counts are finished. Keep the NFO workset alive through
  // apply and final audit revision; one video may still hydrate all of its anchors.
  disposeScanPreparation([files, ...(newFileCounts ? [newFileCounts] : [])])
  nfoWorkset?.sealQueue()

  let appliedNfoBatches = 0
  let updatedNfoAnchors = 0
  const nfoBatches = nfoWorkset?.batches()[Symbol.iterator]()
  try {
    while (nfoBatches) {
      if (options.signal?.aborted) { result.cancelled = true; break }
      const nextBatch = nfoBatches.next()
      if (nextBatch.done) break
      const [videoId, batch] = nextBatch.value
      const toNfoAudit = (applied: LocalNfoScanApplyResult): LibraryScanNfoAudit => ({
        disposition: applied.disposition === 'none' ? 'skipped' : applied.disposition,
        ...(applied.warnings.length > 0 ? { warnings: safeNfoWarnings(applied.warnings) } : {}),
        ...(applied.pendingScrapeId != null ? { pendingScrapeId: applied.pendingScrapeId } : {})
      })
      const reviseAnchor = (anchorPath: string, nfo: LibraryScanNfoAudit): void => {
        const auditEntry = auditSink
          ? synchronousAuditResult(auditSink.readFileNfo(anchorPath))
          : auditEntriesByFile?.get(anchorPath)
        if (!auditEntry) return
        const warnings = safeNfoWarnings([
          ...(auditEntry.nfo?.warnings?.map((warning) => warning.message) ?? []),
          ...(nfo.warnings?.map((warning) => warning.message) ?? [])
        ])
        const mergedNfo = { ...nfo, ...(warnings.length > 0 ? { warnings } : {}) }
        if (auditSink) {
          if (!synchronousAuditResult(auditSink.patchNfo(anchorPath, mergedNfo))) {
            throw new Error('Audit anchor disappeared during NFO revision')
          }
        } else auditEntry.nfo = mergedNfo
      }
      let nfo: LibraryScanNfoAudit
      let nfoAuditFailed = false
      let committedNfoJson: string | undefined
      try {
        const applied = await nfoService.apply(
          videoId, batch.code, batch.anchors,
          auditSink ? (committed) => {
            try {
              // The built-in NFO service calls this in its business write transaction.
              // Do not yield between anchors: a failed revision must roll back the batch.
              const committedNfo = toNfoAudit(committed)
              for (const anchor of batch.anchors) reviseAnchor(anchor.anchorPath, committedNfo)
              committedNfoJson = JSON.stringify(committedNfo)
            } catch (error) {
              nfoAuditFailed = true
              throw error
            }
          } : undefined
        )
        nfo = toNfoAudit(applied)
      } catch (error) {
        if (nfoAuditFailed || error instanceof ScanNfoWorksetError) throw error
        nfo = {
          disposition: 'warning',
          warnings: safeNfoWarnings([sanitizeLibraryScanError(error)])
        }
      }
      const needsFinalRevision = committedNfoJson !== JSON.stringify(nfo)
      for (const anchor of batch.anchors) {
        // Include post-commit asset warnings and support injected legacy NFO services.
        // Finish the committed batch's audit even when cancellation arrives while yielding.
        await maybeYield(++updatedNfoAnchors, yieldEvery)
        if (needsFinalRevision) reviseAnchor(anchor.anchorPath, nfo)
      }
      // An immediately resolved apply promise alone does not let timers or cancellation run.
      await maybeYield(++appliedNfoBatches, Math.min(yieldEvery, 10))
    }
  } finally {
    nfoBatches?.return?.()
  }

  if (options.signal?.aborted) result.cancelled = true
  result.pendingGroups = pendingGroupIds.size

  let selectedPrimaries = 0
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
    // Keep read/select/authorize/write synchronous; settle already committed resources on cancel.
    await maybeYield(++selectedPrimaries, yieldEvery)
  }

  let deliveredAudits = 0
  for (const entry of auditEntriesByFile?.values() ?? []) {
    options.onFileResult?.(entry)
    await maybeYield(++deliveredAudits, yieldEvery)
  }
  if (options.signal?.aborted) result.cancelled = true

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
      resultMode: 'detailed',
      auditSink: undefined,
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
