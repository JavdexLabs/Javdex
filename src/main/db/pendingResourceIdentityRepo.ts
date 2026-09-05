import type Database from 'better-sqlite3'
import type {
  PendingResourceIdentity,
  PendingResourceIdentityChoice
} from '@shared/libraryTypes'
import {
  isNormalizedLocalPathUnderRoot,
  localPathBasename,
  normalizeAbsoluteLocalPath
} from '@shared/localPathIdentity'
import { normalizeVideoCode } from '@shared/videoCode'
import type { ExternalVideoResourceKind } from '@shared/videoTypes'
import { maskVideoResourceLocator } from '@shared/videoResourceLinks'
import { getDb } from './database'

export interface PendingResourceIdentityInput {
  libraryId: number
  rootId: number
  filePath: string
  sourceKind: 'local' | 'strm'
  targetKind?: ExternalVideoResourceKind | null
  targetLocator?: string | null
  targetKey?: string | null
  filenameCode: string
  nfoCode: string
  sizeBytes: number | null
  fileMtimeMs: number | null
}

export interface PendingResourceIdentityRecord {
  id: number
  libraryId: number
  rootId: number
  filePath: string
  normalizedPath: string
  sourceKind: 'local' | 'strm'
  targetKind: ExternalVideoResourceKind | null
  targetLocator: string | null
  targetKey: string | null
  filenameCode: string
  nfoCode: string
  sizeBytes: number | null
  fileMtimeMs: number | null
  revision: number
  createdAt: string
  updatedAt: string
}

export type PendingResourceIdentityRepoErrorCode =
  | 'LIBRARY_NOT_FOUND'
  | 'ROOT_NOT_FOUND'
  | 'IDENTITY_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'VALIDATION_FAILED'

export class PendingResourceIdentityRepoError extends Error {
  constructor(
    readonly code: PendingResourceIdentityRepoErrorCode,
    message: string,
    readonly currentRevision?: number
  ) {
    super(message)
    this.name = 'PendingResourceIdentityRepoError'
  }
}

interface Row {
  id: number
  library_id: number
  root_id: number
  file_path: string
  normalized_path: string
  source_kind: 'local' | 'strm'
  target_kind: ExternalVideoResourceKind | null
  target_locator: string | null
  target_key: string | null
  filename_code: string
  nfo_code: string
  size_bytes: number | null
  file_mtime_ms: number | null
  revision: number
  created_at: string
  updated_at: string
}

interface RootRow {
  id: number
  library_id: number
  normalized_path: string
  normalized_real_path: string | null
  state: string
}

function validationError(message: string): never {
  throw new PendingResourceIdentityRepoError('VALIDATION_FAILED', message)
}

function positiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) validationError(`${label}必须是正整数。`)
  return value
}

function requireLibrary(database: Database.Database, libraryId: number, active = false): void {
  positiveId(libraryId, 'libraryId')
  const row = database
    .prepare('SELECT status FROM media_libraries WHERE id = ?')
    .get(libraryId) as { status: string } | undefined
  if (!row || (active && row.status !== 'active')) {
    throw new PendingResourceIdentityRepoError('LIBRARY_NOT_FOUND', '媒体库不存在或已经归档。')
  }
}

function requireRoot(
  database: Database.Database,
  libraryId: number,
  rootId: number
): RootRow {
  positiveId(rootId, 'rootId')
  const root = database
    .prepare('SELECT * FROM media_library_roots WHERE id = ? AND library_id = ?')
    .get(rootId, libraryId) as RootRow | undefined
  if (!root || root.state !== 'active') {
    throw new PendingResourceIdentityRepoError(
      'ROOT_NOT_FOUND',
      '根目录不属于该媒体库或当前不可用于扫描。'
    )
  }
  return root
}

function rowToRecord(row: Row): PendingResourceIdentityRecord {
  return {
    id: row.id,
    libraryId: row.library_id,
    rootId: row.root_id,
    filePath: row.file_path,
    normalizedPath: row.normalized_path,
    sourceKind: row.source_kind,
    targetKind: row.target_kind,
    targetLocator: row.target_locator,
    targetKey: row.target_key,
    filenameCode: row.filename_code,
    nfoCode: row.nfo_code,
    sizeBytes: row.size_bytes,
    fileMtimeMs: row.file_mtime_ms,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToVisible(row: Row): PendingResourceIdentity {
  return {
    id: row.id,
    libraryId: row.library_id,
    rootId: row.root_id,
    sourceKind: row.source_kind,
    targetKind: row.target_kind,
    targetDisplay:
      row.target_kind && row.target_locator
        ? maskVideoResourceLocator(row.target_locator, row.target_kind)
        : null,
    displayName: localPathBasename(row.file_path),
    filenameCode: row.filename_code,
    nfoCode: row.nfo_code,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function prepareInput(
  database: Database.Database,
  input: PendingResourceIdentityInput
): Omit<PendingResourceIdentityRecord, 'id' | 'revision' | 'createdAt' | 'updatedAt'> {
  requireLibrary(database, input.libraryId, true)
  const root = requireRoot(database, input.libraryId, input.rootId)
  let normalized: ReturnType<typeof normalizeAbsoluteLocalPath>
  try {
    normalized = normalizeAbsoluteLocalPath(input.filePath)
  } catch {
    validationError('待确认资源路径必须是绝对路径。')
  }
  if (
    !isNormalizedLocalPathUnderRoot(normalized.normalizedPath, root.normalized_path) &&
    (!root.normalized_real_path ||
      !isNormalizedLocalPathUnderRoot(normalized.normalizedPath, root.normalized_real_path))
  ) {
    throw new PendingResourceIdentityRepoError('ROOT_NOT_FOUND', '待确认资源不在指定根目录内。')
  }
  if (input.sourceKind !== 'local' && input.sourceKind !== 'strm') {
    validationError('待确认资源类型无效。')
  }
  const targetKind = input.targetKind ?? null
  const targetLocator = input.targetLocator ?? null
  const targetKey = input.targetKey ?? null
  if (input.sourceKind === 'strm' && (!targetKind || !targetLocator || !targetKey)) {
    validationError('STRM 身份待办缺少安全目标快照。')
  }
  if (input.sourceKind === 'local' && (targetKind || targetLocator || targetKey)) {
    validationError('本地身份待办不能包含 STRM 目标快照。')
  }
  const filenameCode = normalizeVideoCode(input.filenameCode)
  const nfoCode = normalizeVideoCode(input.nfoCode)
  if (filenameCode === nfoCode) validationError('相同影片身份不应创建待确认记录。')
  return {
    libraryId: input.libraryId,
    rootId: input.rootId,
    filePath: normalized.path,
    normalizedPath: normalized.normalizedPath,
    sourceKind: input.sourceKind,
    targetKind,
    targetLocator,
    targetKey,
    filenameCode,
    nfoCode,
    sizeBytes: input.sizeBytes,
    fileMtimeMs: input.fileMtimeMs
  }
}

export function upsertPendingResourceIdentity(
  input: PendingResourceIdentityInput
): PendingResourceIdentityRecord {
  const database = getDb()
  const prepared = prepareInput(database, input)
  return database.transaction(() => {
    requireLibrary(database, input.libraryId, true)
    requireRoot(database, input.libraryId, input.rootId)
    const existing = database
      .prepare(
        'SELECT * FROM pending_resource_identities WHERE library_id = ? AND normalized_path = ?'
      )
      .get(input.libraryId, prepared.normalizedPath) as Row | undefined
    const parameters = {
      libraryId: prepared.libraryId,
      rootId: prepared.rootId,
      filePath: prepared.filePath,
      normalizedPath: prepared.normalizedPath,
      sourceKind: prepared.sourceKind,
      targetKind: prepared.targetKind,
      targetLocator: prepared.targetLocator,
      targetKey: prepared.targetKey,
      filenameCode: prepared.filenameCode,
      nfoCode: prepared.nfoCode,
      sizeBytes: prepared.sizeBytes,
      fileMtimeMs: prepared.fileMtimeMs
    }
    let id: number
    if (existing) {
      database
        .prepare(`
          UPDATE pending_resource_identities
             SET root_id = @rootId, file_path = @filePath, source_kind = @sourceKind,
                 target_kind = @targetKind, target_locator = @targetLocator,
                 target_key = @targetKey, filename_code = @filenameCode, nfo_code = @nfoCode,
                 size_bytes = @sizeBytes, file_mtime_ms = @fileMtimeMs,
                 revision = revision + 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = @id AND library_id = @libraryId
        `)
        .run({ ...parameters, id: existing.id })
      id = existing.id
    } else {
      const info = database
        .prepare(`
          INSERT INTO pending_resource_identities (
            library_id, root_id, file_path, normalized_path, source_kind,
            target_kind, target_locator, target_key, filename_code, nfo_code,
            size_bytes, file_mtime_ms, revision, created_at, updated_at
          ) VALUES (
            @libraryId, @rootId, @filePath, @normalizedPath, @sourceKind,
            @targetKind, @targetLocator, @targetKey, @filenameCode, @nfoCode,
            @sizeBytes, @fileMtimeMs, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
        `)
        .run(parameters)
      id = Number(info.lastInsertRowid)
    }
    return rowToRecord(
      database.prepare('SELECT * FROM pending_resource_identities WHERE id = ?').get(id) as Row
    )
  }).immediate()
}

export function pendingResourceIdentityExists(libraryId: number, filePath: string): boolean {
  return getPendingResourceIdentityByPath(libraryId, filePath) !== null
}

export function getPendingResourceIdentityByPath(
  libraryId: number,
  filePath: string
): PendingResourceIdentityRecord | null {
  const database = getDb()
  requireLibrary(database, libraryId)
  let normalizedPath: string
  try {
    normalizedPath = normalizeAbsoluteLocalPath(filePath).normalizedPath
  } catch {
    validationError('待确认资源路径必须是绝对路径。')
  }
  const row = database
    .prepare('SELECT * FROM pending_resource_identities WHERE library_id = ? AND normalized_path = ?')
    .get(libraryId, normalizedPath) as Row | undefined
  return row ? rowToRecord(row) : null
}

export function listPendingResourceIdentities(libraryId: number): PendingResourceIdentity[] {
  const database = getDb()
  requireLibrary(database, libraryId)
  return (
    database
      .prepare(
        'SELECT * FROM pending_resource_identities WHERE library_id = ? ORDER BY updated_at, id'
      )
      .all(libraryId) as Row[]
  ).map(rowToVisible)
}

export function getPendingResourceIdentityRecord(
  libraryId: number,
  identityId: number
): PendingResourceIdentityRecord | null {
  const database = getDb()
  requireLibrary(database, libraryId)
  positiveId(identityId, 'identityId')
  const row = database
    .prepare('SELECT * FROM pending_resource_identities WHERE id = ? AND library_id = ?')
    .get(identityId, libraryId) as Row | undefined
  return row ? rowToRecord(row) : null
}

export function deletePendingResourceIdentity(
  libraryId: number,
  identityId: number,
  expectedRevision: number
): boolean {
  const database = getDb()
  requireLibrary(database, libraryId)
  positiveId(identityId, 'identityId')
  positiveId(expectedRevision, 'revision')
  const row = database
    .prepare('SELECT revision FROM pending_resource_identities WHERE id = ? AND library_id = ?')
    .get(identityId, libraryId) as { revision: number } | undefined
  if (!row) return false
  if (row.revision !== expectedRevision) {
    throw new PendingResourceIdentityRepoError(
      'REVISION_CONFLICT',
      '资源身份待办已发生变化，请刷新后重试。',
      row.revision
    )
  }
  return (
    database
      .prepare(
        'DELETE FROM pending_resource_identities WHERE id = ? AND library_id = ? AND revision = ?'
      )
      .run(identityId, libraryId, expectedRevision).changes === 1
  )
}

export function reconcilePendingResourceIdentities(
  libraryId: number,
  accessibleRootIds: number[],
  inspectPath: (filePath: string) => 'present' | 'missing' | 'unknown'
): { removed: number } {
  const database = getDb()
  requireLibrary(database, libraryId)
  const rootIds = [...new Set(accessibleRootIds.map((rootId) => positiveId(rootId, 'rootId')))]
  if (rootIds.length === 0) return { removed: 0 }
  return database.transaction(() => {
    for (const rootId of rootIds) requireRoot(database, libraryId, rootId)
    const placeholders = rootIds.map(() => '?').join(', ')
    const rows = database
      .prepare(
        `SELECT id, file_path FROM pending_resource_identities
          WHERE library_id = ? AND root_id IN (${placeholders}) ORDER BY id`
      )
      .all(libraryId, ...rootIds) as Array<{ id: number; file_path: string }>
    let removed = 0
    const remove = database.prepare(
      'DELETE FROM pending_resource_identities WHERE id = ? AND library_id = ?'
    )
    for (const row of rows) {
      if (inspectPath(row.file_path) !== 'missing') continue
      removed += remove.run(row.id, libraryId).changes
    }
    return { removed }
  }).immediate()
}

export function selectedPendingResourceIdentityCode(
  record: PendingResourceIdentityRecord,
  choice: Exclude<PendingResourceIdentityChoice, 'discard'>
): string {
  return choice === 'filename' ? record.filenameCode : record.nfoCode
}
