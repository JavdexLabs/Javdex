import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { ManualImportResult, RenameImportResult } from '@shared/libraryTypes'
import type { VideoResourceImportTarget } from '@shared/videoTypes'
import { structuredError } from '@shared/protocol/errors'
import { getMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
import { getLocalVideoResourceByLocator, getVideoResourceInLibrary } from '@library/db/videoRepo'
import { getDb } from '@library/db/database'
import { normalizeLocalPathIdentity } from '@library/localPathIdentity'
import { isPathUnderRoot } from '@library/scan/libraryPathUtils'
import { authorizeMediaLibraryRootFile } from '@library/scan/mediaLibraryRootFileGuard'
import {
  applyPreparedManualImport,
  prepareManualImport,
  rediscoverRenamedFile,
  renameAndImport,
  type PreparedManualImport
} from '@library/scan/scanner'
import { maintenanceTaskGate } from '@library/scan/maintenanceTaskGate'
import {
  removeLibraryUnrecognizedFile,
  renameLibraryUnrecognizedFile
} from '@library/db/libraryScanRepo'
import type { AggregateVersion, ExpectedVersions } from '@shared/protocol/versions'
import type { CatalogMutationRequest } from './catalogOperations'
import { assertExpectedVideoVersion } from './catalogVideoVersion'
import {
  abortCatalogMutation,
  beginCatalogMutation,
  clearCatalogMutationIntent,
  commitCatalogMutation,
  completeCatalogMutation,
  listCatalogMutationIntentOperationIds,
  readCatalogMutation,
  readCatalogMutationIntent,
  readOperationReceipt
} from './catalogOperations'
import {
  deleteCatalogSetting,
  listCatalogSettingKeys,
  readCatalogSetting,
  writeCatalogSetting
} from './catalogSettings'

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

const FILE_MAINTENANCE_JOURNAL_PREFIX = 'catalog-file-maintenance:'

interface FileMaintenanceJournal {
  operationId: string
  operation: 'files.rename'
  request: CatalogMutationRequest
  phase: 'prepared' | 'moved' | 'completed'
  oldPath: string
  newPath: string
  rootId: number
  remoteSafe?: boolean
  result?: RenameImportResult
}

function fileMaintenanceJournalKey(operationId: string): string {
  return `${FILE_MAINTENANCE_JOURNAL_PREFIX}${operationId}`
}

function versionFromDigest(value: unknown): AggregateVersion {
  const number = Number.parseInt(sha256(value).slice(0, 13), 16) % Number.MAX_SAFE_INTEGER
  return { generation: 1, revision: Math.max(1, number) }
}

function rootBindingVersion(root: NonNullable<ReturnType<typeof getMediaLibraryRoot>>): AggregateVersion {
  return versionFromDigest({
    id: root.id,
    libraryId: root.libraryId,
    normalizedPath: root.normalizedPath,
    normalizedRealPath: root.normalizedRealPath,
    state: root.state,
    updatedAt: root.updatedAt
  })
}

function fileResourceVersion(
  libraryId: number,
  rootId: number,
  filePath: string,
  resourceId?: number
): AggregateVersion {
  const resource = resourceId != null
    ? getVideoResourceInLibrary(libraryId, resourceId)
    : getLocalVideoResourceByLocator(libraryId, filePath)
  if (resource) {
    return versionFromDigest({
      id: resource.id,
      libraryId: resource.library_id,
      videoId: resource.video_id,
      rootId: resource.root_id,
      kind: resource.kind,
      locator: resource.locator,
      resourceKey: resource.resource_key,
      sourceIdentity: resource.source_identity,
      sizeBytes: resource.size_bytes,
      durationSeconds: resource.duration_seconds,
      fileMtimeMs: resource.file_mtime_ms,
      displayName: resource.display_name,
      primary: resource.is_primary
    })
  }
  const unrecognized = getDb()
    .prepare(
      `SELECT root_id, file_path, normalized_path, reason, scan_run_id, last_seen_at
         FROM library_unrecognized_files
        WHERE library_id = ? AND root_id = ? AND file_path = ?`
    )
    .get(libraryId, rootId, filePath) as Record<string, unknown> | undefined
  return versionFromDigest({
    libraryId,
    rootId,
    filePath,
    fingerprint: fileFingerprint(filePath),
    unrecognized
  })
}

export function readFileMaintenanceVersions(input: {
  libraryId: number
  resourceId?: number
  location: { rootId: number; relativePath: string }
}): ExpectedVersions {
  const { root, filePath } = resolveLocation(input.libraryId, input.location)
  return {
    G: rootBindingVersion(root),
    R: fileResourceVersion(input.libraryId, root.id, filePath, input.resourceId)
  }
}

export function assertFileMaintenanceVersions(
  input: {
    libraryId: number
    resourceId?: number
    location: { rootId: number; relativePath: string }
  },
  expected: ExpectedVersions,
  operationId: string
): void {
  const current = readFileMaintenanceVersions(input)
  for (const scope of ['G', 'R'] as const) {
    const wanted = expected[scope]
    if (!wanted) {
      throw structuredError(
        'INVALID_INPUT',
        `需要 ${scope} 版本`,
        { field: `expectedVersions.${scope}` },
        operationId
      )
    }
    if (
      wanted.generation !== current[scope]!.generation ||
      wanted.revision !== current[scope]!.revision
    ) {
      throw structuredError('VERSION_CONFLICT', '文件维护目标已变化，请刷新后重试', undefined, operationId)
    }
  }
}

function requireWritableParent(filePath: string): void {
  fs.accessSync(path.dirname(filePath), fs.constants.W_OK)
}

function resolveLocation(
  libraryId: number,
  location: { rootId: number; relativePath: string }
): { root: NonNullable<ReturnType<typeof getMediaLibraryRoot>>; filePath: string } {
  const root = getMediaLibraryRoot(libraryId, location.rootId)
  if (!root || root.state !== 'active') {
    throw structuredError('INVALID_INPUT', '媒体库根目录不存在、已停用或不属于该媒体库')
  }
  if (path.isAbsolute(location.relativePath)) {
    throw structuredError('INVALID_INPUT', '远程文件位置必须是根目录相对路径')
  }
  // Persisted local resource locators use the configured (lexical) root path.
  // The file guard below still resolves the path through the root's physical
  // identity before any filesystem operation, so using the lexical base here
  // keeps relative locations aligned with stored locators without weakening
  // the authorization boundary.
  const base = root.path
  const filePath = path.resolve(base, location.relativePath)
  if (!isPathUnderRoot(filePath, base)) {
    throw structuredError('INVALID_INPUT', '文件不在授权根目录内')
  }
  return { root, filePath }
}

function fileFingerprint(filePath: string): { size: number; mtimeMs: number } | { missing: true } {
  try {
    const stat = fs.statSync(filePath)
    return { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) }
  } catch {
    return { missing: true }
  }
}

export function filesRenameDigest(input: {
  libraryId: number
  resourceId?: number
  location: { rootId: number; relativePath: string }
  newFileName: string
}): string {
  const { filePath } = resolveLocation(input.libraryId, input.location)
  return sha256({
    libraryId: input.libraryId,
    resourceId: input.resourceId ?? null,
    location: input.location,
    newFileName: input.newFileName,
    fingerprint: fileFingerprint(filePath)
  })
}

export function previewRenameCatalogFile(input: {
  libraryId: number
  location: { rootId: number; relativePath: string }
  newFileName: string
}): { resourceId?: number; planDigest: string; expectedVersions: ExpectedVersions } {
  const { filePath } = resolveLocation(input.libraryId, input.location)
  const resource = getLocalVideoResourceByLocator(input.libraryId, filePath)
  const resourceId = resource?.id
  return {
    ...(resourceId != null ? { resourceId } : {}),
    planDigest: filesRenameDigest({
      libraryId: input.libraryId,
      ...(resourceId != null ? { resourceId } : {}),
      location: input.location,
      newFileName: input.newFileName
    }),
    expectedVersions: readFileMaintenanceVersions({
      libraryId: input.libraryId,
      ...(resourceId != null ? { resourceId } : {}),
      location: input.location
    })
  }
}

export function hasFileMaintenanceJournal(
  operationId: string,
  database: ReturnType<typeof getDb> = getDb()
): boolean {
  return readCatalogSetting<FileMaintenanceJournal | null>(
    fileMaintenanceJournalKey(operationId),
    null,
    database
  ) != null
}

export function clearFileMaintenanceJournal(
  operationId: string,
  database: ReturnType<typeof getDb> = getDb()
): void {
  deleteCatalogSetting(fileMaintenanceJournalKey(operationId), database)
}

function projectRenameResult(
  result: RenameImportResult,
  root: NonNullable<ReturnType<typeof getMediaLibraryRoot>>
): RenameImportResult {
  const relative = [root.path, root.realPath]
    .filter((base): base is string => Boolean(base))
    .map((base) => path.relative(base, result.newPath))
    .find((candidate) =>
      candidate &&
      !path.isAbsolute(candidate) &&
      candidate !== '..' &&
      !candidate.startsWith(`..${path.sep}`)
    )
  return {
    ...result,
    newPath: relative ? relative.split(path.sep).join('/') : path.basename(result.newPath)
  }
}

function writeFileMaintenanceJournal(
  journal: FileMaintenanceJournal,
  database: ReturnType<typeof getDb> = getDb()
): void {
  writeCatalogSetting(fileMaintenanceJournalKey(journal.operationId), journal, database)
}

function readFileMaintenanceJournals(
  database: ReturnType<typeof getDb>
): Array<{ key: string; journal: FileMaintenanceJournal }> {
  return listCatalogSettingKeys(FILE_MAINTENANCE_JOURNAL_PREFIX, database).flatMap((key) => {
    const journal = readCatalogSetting<FileMaintenanceJournal | null>(key, null, database)
    return journal ? [{ key, journal }] : []
  })
}

function readFileMaintenanceJournal(
  operationId: string,
  database: ReturnType<typeof getDb> = getDb()
): FileMaintenanceJournal | null {
  return readCatalogSetting<FileMaintenanceJournal | null>(
    fileMaintenanceJournalKey(operationId),
    null,
    database
  )
}

function renameDestination(oldPath: string, newName: string): string {
  const trimmed = newName.trim()
  const finalName = path.extname(trimmed) ? trimmed : trimmed + path.extname(oldPath)
  return path.join(path.dirname(oldPath), finalName)
}

function applyUnrecognizedRenameResult(
  input: { libraryId: number; rootId: number; oldPath: string },
  result: RenameImportResult
): void {
  if (result.outcome === 'imported' || result.outcome === 'pending') {
    removeLibraryUnrecognizedFile(
      input.libraryId,
      input.rootId,
      normalizeLocalPathIdentity(input.oldPath)
    )
  } else {
    renameLibraryUnrecognizedFile(
      input.libraryId,
      input.rootId,
      normalizeLocalPathIdentity(input.oldPath),
      {
        filePath: result.newPath,
        normalizedPath: normalizeLocalPathIdentity(result.newPath)
      }
    )
  }
}

function projectRenameResultForRoot(
  result: RenameImportResult,
  root: NonNullable<ReturnType<typeof getMediaLibraryRoot>>,
  remoteSafe: boolean | undefined
): RenameImportResult {
  return remoteSafe ? projectRenameResult(result, root) : result
}

function assertResourceOrUnrecognized(
  libraryId: number,
  resourceId: number | undefined,
  filePath: string
): void {
  if (resourceId != null) {
    const resource = getVideoResourceInLibrary(libraryId, resourceId)
    if (resource) {
      if (normalizeLocalPathIdentity(resource.locator) !== normalizeLocalPathIdentity(filePath)) {
        throw structuredError('INVALID_INPUT', '资源定位与文件位置不一致')
      }
      return
    }
    throw structuredError('INVALID_INPUT', '文件不是该媒体库中的资源或未识别项')
  }
  if (getLocalVideoResourceByLocator(libraryId, filePath)) {
    throw structuredError('INVALID_INPUT', '文件已登记为资源，缺少资源编号')
  }
  const unrecognized = getDb()
    .prepare(
      `SELECT 1 AS ok FROM library_unrecognized_files
        WHERE library_id = ? AND file_path = ?`
    )
    .get(libraryId, filePath) as { ok: number } | undefined
  if (!unrecognized) {
    throw structuredError('INVALID_INPUT', '文件不是该媒体库中的资源或未识别项')
  }
}

export async function renameCatalogFile(input: {
  libraryId: number
  resourceId?: number
  location: { rootId: number; relativePath: string }
  newFileName: string
  planDigest: string
}, options: {
  operationId?: string
  mutation?: CatalogMutationRequest
  remoteSafe?: boolean
} = {}): Promise<RenameImportResult> {
  const existingJournal = options.operationId
    ? readFileMaintenanceJournal(options.operationId)
    : null
  if (existingJournal?.phase === 'completed' && existingJournal.result) {
    return existingJournal.result
  }
  const oldPathExists = existingJournal ? fs.existsSync(existingJournal.oldPath) : false
  const newPathExists = existingJournal ? fs.existsSync(existingJournal.newPath) : false
  const resuming = Boolean(
    existingJournal &&
    newPathExists &&
    (existingJournal.phase === 'moved' || (existingJournal.phase === 'prepared' && !oldPathExists))
  )
  if (!resuming && filesRenameDigest(input) !== input.planDigest) {
    throw structuredError('VERSION_CONFLICT', '文件维护预览已过期，请刷新后重试')
  }
  const { root, filePath } = resolveLocation(input.libraryId, input.location)
  if (options.mutation && !resuming) {
    assertFileMaintenanceVersions(input, options.mutation.expectedVersions, options.mutation.operationId)
  }
  const authorizedPath = resuming && existingJournal ? existingJournal.newPath : filePath
  authorizeMediaLibraryRootFile(
    input.libraryId,
    root.id,
    authorizedPath,
    root
  )
  if (!resuming) assertResourceOrUnrecognized(input.libraryId, input.resourceId, filePath)
  try {
    requireWritableParent(filePath)
  } catch {
    throw structuredError('INVALID_INPUT', '只读挂载不允许维护写入')
  }
  const newPath = resuming && existingJournal
    ? existingJournal.newPath
    : renameDestination(filePath, input.newFileName)
  if (
    resuming &&
    path.resolve(newPath) !== path.resolve(renameDestination(filePath, input.newFileName))
  ) {
    throw structuredError(
      'RECOVERY_REQUIRED',
      '待恢复的文件维护请求与当前请求不一致',
      { operationId: options.operationId },
      options.operationId
    )
  }
  return maintenanceTaskGate.run('resource-maintenance', async () => {
    const journal = resuming && existingJournal
      ? existingJournal
      : options.mutation && options.operationId
      ? {
          operationId: options.operationId,
          operation: 'files.rename' as const,
          request: options.mutation,
          phase: 'prepared' as const,
          oldPath: filePath,
          newPath,
          rootId: root.id,
          remoteSafe: options.remoteSafe
        }
      : null
    if (journal && !resuming) writeFileMaintenanceJournal(journal)

    // A request may be retried in the same process after the physical rename
    // succeeded but before its receipt was committed. Resume from the durable
    // journal instead of trying to rename the vanished old path again.
    let result: RenameImportResult
    if (resuming && existingJournal) {
      result = await rediscoverRenamedFile(
        { libraryId: input.libraryId, rootId: root.id, newPath: existingJournal.newPath }
      )
    } else {
      try {
        result = await renameAndImport(
          {
            libraryId: input.libraryId,
            rootId: root.id,
            oldPath: filePath,
            newName: input.newFileName
          },
          {
            onRenamed: (movedPath) => {
              if (journal) {
                writeFileMaintenanceJournal({ ...journal, phase: 'moved', newPath: movedPath })
              }
            }
          }
        )
      } catch (error) {
        // Validation failures happen before renameAndImport's filesystem side
        // effect. Do not leave an intent behind for a request that never moved
        // anything; retain the journal only when the old path has disappeared.
        if (journal) {
          const currentJournal = readFileMaintenanceJournal(journal.operationId)
          const oldExists = currentJournal ? fs.existsSync(currentJournal.oldPath) : false
          const newExists = currentJournal ? fs.existsSync(currentJournal.newPath) : false
          const samePath = currentJournal
            ? path.resolve(currentJournal.oldPath) === path.resolve(currentJournal.newPath)
            : false
          if (currentJournal?.phase === 'prepared' && oldExists && (samePath || !newExists)) {
            clearFileMaintenanceJournal(currentJournal.operationId)
          }
        }
        throw error
      }
    }
    applyUnrecognizedRenameResult(
      { libraryId: input.libraryId, rootId: root.id, oldPath: filePath },
      result
    )
    const projected = projectRenameResultForRoot(result, root, options.remoteSafe)
    if (journal) writeFileMaintenanceJournal({ ...journal, phase: 'completed', result: projected })
    return projected
  })
}

export interface PreparedCatalogManualFile {
  input: {
    libraryId: number
    location: { rootId: number; relativePath: string }
    code: string
    target: VideoResourceImportTarget
  }
  root: NonNullable<ReturnType<typeof getMediaLibraryRoot>>
  filePath: string
  prepared: PreparedManualImport
}

export async function prepareCatalogManualFile(input: PreparedCatalogManualFile['input']): Promise<PreparedCatalogManualFile> {
  const { root, filePath } = resolveLocation(input.libraryId, input.location)
  authorizeMediaLibraryRootFile(input.libraryId, root.id, filePath, root)
  try {
    requireWritableParent(filePath)
  } catch {
    throw structuredError('INVALID_INPUT', '只读挂载不允许维护写入')
  }
  return {
    input,
    root,
    filePath,
    prepared: await prepareManualImport(
      {
        libraryId: input.libraryId,
        rootId: root.id,
        filePath,
        code: input.code,
        target: input.target
      },
      { expectedRoot: root }
    )
  }
}

export function applyPreparedCatalogManualFile(
  prepared: PreparedCatalogManualFile
): ManualImportResult {
  const result = applyPreparedManualImport(prepared.prepared)
  if (result.imported || result.skippedPath) {
    removeLibraryUnrecognizedFile(
      prepared.input.libraryId,
      prepared.root.id,
      normalizeLocalPathIdentity(prepared.filePath)
    )
  }
  return result
}

export async function importCatalogManualFile(input: {
  libraryId: number
  location: { rootId: number; relativePath: string }
  code: string
  target: VideoResourceImportTarget
}): Promise<ManualImportResult> {
  const prepared = await prepareCatalogManualFile(input)
  return maintenanceTaskGate.run('resource-maintenance', async () => {
    return applyPreparedCatalogManualFile(prepared)
  })
}

type RenameFileRequest = Omit<CatalogMutationRequest, 'operation' | 'input'> & {
  operation: 'files.rename'
  input: Omit<Parameters<typeof renameCatalogFile>[0], 'planDigest'> & { planDigest?: string }
}

type ManualFileRequest = Omit<CatalogMutationRequest, 'operation' | 'input'> & {
  operation: 'files.importManual'
  input: PreparedCatalogManualFile['input']
}

interface FileMaintenanceOptions {
  database?: ReturnType<typeof getDb>
  remoteSafe?: boolean
}

type FileMaintenanceResult<T> = ReturnType<typeof completeCatalogMutation<T>>

export function executeCatalogFileMaintenance(
  request: RenameFileRequest,
  options?: FileMaintenanceOptions
): Promise<FileMaintenanceResult<RenameImportResult>>
export function executeCatalogFileMaintenance(
  request: ManualFileRequest,
  options?: FileMaintenanceOptions
): Promise<FileMaintenanceResult<ManualImportResult>>
/** Own the receipt, versions and durable filesystem journal as one operation. */
export async function executeCatalogFileMaintenance(
  request: RenameFileRequest | ManualFileRequest,
  options: FileMaintenanceOptions = {}
): Promise<FileMaintenanceResult<RenameImportResult | ManualImportResult>> {
  const database = options.database ?? getDb()
  const scopes = request.operation === 'files.importManual' && request.input.target.kind === 'existing'
    ? ['G', 'R', 'V'] as const
    : ['G', 'R'] as const
  for (const scope of scopes) {
    if (!request.expectedVersions[scope]) {
      throw structuredError('INVALID_INPUT', `需要 ${scope} 版本`, {
        field: `expectedVersions.${scope}`
      }, request.operationId)
    }
  }
  if (request.operation === 'files.importManual') {
    // A completed import can be retried after its source file has been removed.
    const duplicate = readCatalogMutation<ManualImportResult>(request, database)
    if (duplicate) return duplicate
    const { input } = request
    const prepared = await prepareCatalogManualFile(input)
    return commitCatalogMutation(request, () => {
      assertFileMaintenanceVersions(input, request.expectedVersions, request.operationId)
      if (input.target.kind === 'existing') {
        assertExpectedVideoVersion(input.target.videoId, request.expectedVersions, request.operationId, database)
      }
      return applyPreparedCatalogManualFile(prepared)
    }, database)
  }

  const begun = beginCatalogMutation(request, database)
  if (begun.outcome === 'duplicate') {
    clearFileMaintenanceJournal(request.operationId, database)
    return begun
  }
  try {
    const result = await renameCatalogFile({
      ...request.input,
      planDigest: request.input.planDigest ?? filesRenameDigest(request.input)
    }, {
      operationId: request.operationId,
      mutation: request,
      remoteSafe: options.remoteSafe
    })
    const completed = completeCatalogMutation(request, result, database)
    clearFileMaintenanceJournal(request.operationId, database)
    return completed
  } catch (error) {
    if (!hasFileMaintenanceJournal(request.operationId, database)) {
      abortCatalogMutation(request, database)
    }
    throw error
  }
}

/**
 * Finish file maintenance operations left between the filesystem side effect
 * and the operation receipt. Recovery is intentionally conservative when both
 * paths exist: a human must resolve that ambiguous state before retrying.
 */
export function recoverCatalogFileMaintenance(
  database: ReturnType<typeof getDb> = getDb()
): void {
  for (const { key, journal } of readFileMaintenanceJournals(database)) {
    if (!journal || journal.operation !== 'files.rename' || !journal.request?.operationId) {
      deleteCatalogSetting(key, database)
      continue
    }
    const receipt = readOperationReceipt(journal.operationId, database)
    if (receipt) {
      deleteCatalogSetting(key, database)
      continue
    }

    const oldExists = fs.existsSync(journal.oldPath)
    const newExists = fs.existsSync(journal.newPath)
    if (journal.phase === 'prepared' && oldExists) {
      abortCatalogMutation(journal.request, database)
      deleteCatalogSetting(key, database)
      continue
    }
    if (journal.result) {
      try {
        completeCatalogMutation(journal.request, journal.result, database)
        deleteCatalogSetting(key, database)
      } catch {
        // Leave the journal for the next startup; no destructive guess is safe.
      }
      continue
    }
    if (!newExists || (oldExists && journal.oldPath !== journal.newPath)) continue
    // The physical move is known, but rediscovery is asynchronous. Leave the
    // intent and journal in place so the normal retry path can reconcile the
    // new path before issuing the receipt.
  }

  // beginCatalogMutation persists the intent before renameCatalogFile writes
  // its journal. A crash in that small gap has no filesystem side effect, so
  // an intent with no matching file-maintenance journal can be discarded. Do
  // not touch intents owned by other async operations that may be added later.
  for (const operationId of listCatalogMutationIntentOperationIds(database)) {
    const intent = readCatalogMutationIntent(operationId, database)
    if (!intent || intent.operation !== 'files.rename') continue
    if (readOperationReceipt(operationId, database) || !hasFileMaintenanceJournal(operationId, database)) {
      clearCatalogMutationIntent(operationId, database)
    }
  }
}
