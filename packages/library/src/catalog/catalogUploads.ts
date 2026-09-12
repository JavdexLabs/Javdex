import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import fs from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { IncomingMessage } from 'node:http'
import type Database from 'better-sqlite3'
import {
  UPLOAD_STREAM_MAX_BYTES,
  UPLOAD_TTL_MS,
  type ManageImageContentType
} from '@shared/protocol/limits'
import type { UploadCreateResult, UploadInspectResult, UploadPurpose } from '@shared/protocol/uploads'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { assetsRoot, resolveAssetPath, writeAtomic } from '@library/mediaAssetStore/filesystem'
import { detectImageExtensionFromBuffer, readImageDimensionsFromBuffer } from '@library/mediaAssetStore/imageBytes'
import { AssetPixelLimitError, inspectServedImage } from '@library/mediaAssetStore/pixelBudget'
import { readCatalogIdentity } from './catalogIdentity'
import { maybeCrashImageFlow } from './catalogImageCrash'

export const UPLOAD_DIRNAME = 'uploads'
export const PENDING_SCRAPE_STAGING_DIRNAME = '.pending_scrape_staging'

const CONTENT_TYPE_EXT: Record<ManageImageContentType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif'
}

const EXT_CONTENT_TYPE: Record<string, ManageImageContentType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif'
}

export type CatalogUploadStatus =
  | 'reserved'
  | 'writing'
  | 'ready'
  | 'consumed'
  | 'expired'
  | 'failed'
  | 'discarding'

export interface CatalogUploadRow {
  uploadId: string
  purpose: UploadPurpose
  contentType: ManageImageContentType
  writerEpoch: number
  catalogId: string
  status: CatalogUploadStatus
  relPath: string | null
  byteLength: number | null
  sha256: string | null
  width: number | null
  height: number | null
  createdAt: string
  expiresAt: string
  consumedAt: string | null
  consumedByOperationId: string | null
}

interface UploadSqlRow {
  upload_id: string
  purpose: UploadPurpose
  content_type: ManageImageContentType
  writer_epoch: number
  catalog_id: string
  status: CatalogUploadStatus
  rel_path: string | null
  byte_length: number | null
  sha256: string | null
  width: number | null
  height: number | null
  created_at: string
  expires_at: string
  consumed_at: string | null
  consumed_by_operation_id: string | null
}

function mapUpload(row: UploadSqlRow): CatalogUploadRow {
  return {
    uploadId: row.upload_id,
    purpose: row.purpose,
    contentType: row.content_type,
    writerEpoch: row.writer_epoch,
    catalogId: row.catalog_id,
    status: row.status,
    relPath: row.rel_path,
    byteLength: row.byte_length,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumedByOperationId: row.consumed_by_operation_id
  }
}

export function sha256Buffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

export function uploadsDir(): string {
  return path.join(assetsRoot(), UPLOAD_DIRNAME)
}

export function pendingScrapeStagingDir(): string {
  return path.join(assetsRoot(), PENDING_SCRAPE_STAGING_DIRNAME)
}

export function ensureUploadDirs(): void {
  fs.mkdirSync(uploadsDir(), { recursive: true })
  fs.mkdirSync(pendingScrapeStagingDir(), { recursive: true })
}

export function uploadPartRel(uploadId: string): string {
  return path.posix.join(UPLOAD_DIRNAME, `${uploadId}.part`)
}

export function uploadReadyRel(uploadId: string, ext: string): string {
  return path.posix.join(UPLOAD_DIRNAME, `${uploadId}${ext}`)
}

export function pendingScrapeRel(uploadId: string, ext: string): string {
  return path.posix.join(PENDING_SCRAPE_STAGING_DIRNAME, `${uploadId}${ext}`)
}

export function readCatalogUpload(
  uploadId: string,
  database: Database.Database = getDb()
): CatalogUploadRow | null {
  const row = database
    .prepare(
      `SELECT upload_id, purpose, content_type, writer_epoch, catalog_id, status, rel_path,
              byte_length, sha256, width, height, created_at, expires_at, consumed_at,
              consumed_by_operation_id
       FROM catalog_image_uploads WHERE upload_id = ?`
    )
    .get(uploadId) as UploadSqlRow | undefined
  return row ? mapUpload(row) : null
}

function requireIdentity(database: Database.Database) {
  const identity = readCatalogIdentity(database)
  if (!identity) throw structuredError('AUTH_REQUIRED', '资料库身份尚未初始化')
  if (identity.frozen) throw structuredError('CATALOG_FROZEN', '资料库已冻结')
  return identity
}

export function createCatalogUpload(
  input: {
    purpose: UploadPurpose
    contentType: ManageImageContentType
    writerEpoch: number
    catalogId: string
    uploadId?: string
    now?: Date
  },
  database: Database.Database = getDb()
): UploadCreateResult {
  if (!(input.contentType in CONTENT_TYPE_EXT)) {
    throw structuredError('INVALID_INPUT', '不支持的图片类型', { field: 'contentType' })
  }
  const now = input.now ?? new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + UPLOAD_TTL_MS).toISOString()
  const uploadId = input.uploadId ?? randomUUID()
  const identity = requireIdentity(database)
  if (input.catalogId !== identity.catalogId) {
    throw structuredError('CATALOG_MISMATCH', '目标资料库已变化')
  }
  if (identity.writerEpoch !== input.writerEpoch) {
    throw structuredError('WRITER_REVOKED', '写入代次已变化')
  }
  ensureUploadDirs()
  const partRel = uploadPartRel(uploadId)
  const jobId = randomUUID()
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO catalog_image_uploads (
           upload_id, purpose, content_type, writer_epoch, catalog_id, status, rel_path,
           created_at, expires_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`
      )
      .run(
        uploadId,
        input.purpose,
        input.contentType,
        input.writerEpoch,
        input.catalogId,
        partRel,
        createdAt,
        expiresAt,
        createdAt
      )
    database
      .prepare(
        `INSERT INTO catalog_image_file_jobs (
           job_id, kind, upload_id, rel_path, status, created_at, updated_at
         ) VALUES (?, 'uploadWrite', ?, ?, 'pending', ?, ?)`
      )
      .run(jobId, uploadId, partRel, createdAt, createdAt)
  })()
  if (!database.inTransaction) maybeCrashImageFlow('afterPersistUploadRow')
  return {
    uploadId,
    expiresAt,
    maxBytes: UPLOAD_STREAM_MAX_BYTES
  }
}

export function inspectCatalogUpload(
  uploadId: string,
  options: { now?: Date } = {},
  database: Database.Database = getDb()
): UploadInspectResult {
  const row = readCatalogUpload(uploadId, database)
  if (!row) throw structuredError('INVALID_INPUT', '上传不存在', { field: 'uploadId' })
  const now = options.now ?? new Date()
  if (row.status === 'expired' || (row.status !== 'consumed' && row.expiresAt <= now.toISOString())) {
    throw structuredError('UPLOAD_EXPIRED', '上传已过期，请重新上传')
  }
  if (row.status !== 'ready' && row.status !== 'consumed') {
    throw structuredError('UPLOAD_NOT_READY', '上传尚未完成')
  }
  if (
    row.byteLength == null ||
    !row.sha256 ||
    row.width == null ||
    row.height == null ||
    !row.contentType
  ) {
    throw structuredError('UPLOAD_NOT_READY', '上传尚未完成')
  }
  return {
    uploadId: row.uploadId,
    purpose: row.purpose,
    contentType: row.contentType,
    byteLength: row.byteLength,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    consumed: row.status === 'consumed',
    expiresAt: row.expiresAt
  }
}

class LimitedBytes extends Transform {
  received = 0
  constructor(private readonly maxBytes: number) {
    super()
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.received += chunk.length
    if (this.received > this.maxBytes) {
      callback(
        Object.assign(new Error('upload too large'), {
          code: 'LIMIT_EXCEEDED' as const,
          limit: this.maxBytes,
          actual: this.received
        })
      )
      return
    }
    this.push(chunk)
    callback()
  }
}

function isLimitError(error: unknown): error is Error & { code: 'LIMIT_EXCEEDED'; limit: number; actual: number } {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'LIMIT_EXCEEDED'
  )
}

function extensionForDetectedType(mediaType: string, fallback: ManageImageContentType): string {
  if (mediaType in CONTENT_TYPE_EXT) return CONTENT_TYPE_EXT[mediaType as ManageImageContentType]
  return CONTENT_TYPE_EXT[fallback]
}

export async function completeCatalogUploadFromStream(
  uploadId: string,
  request: IncomingMessage,
  options: {
    writerEpoch: number
    catalogId: string
    maxBytes?: number
    now?: Date
  },
  database: Database.Database = getDb()
): Promise<UploadInspectResult> {
  const row = readCatalogUpload(uploadId, database)
  if (!row) throw structuredError('INVALID_INPUT', '上传不存在', { field: 'uploadId' })
  const identity = requireIdentity(database)
  if (row.catalogId !== options.catalogId || identity.catalogId !== options.catalogId) {
    throw structuredError('CATALOG_MISMATCH', '目标资料库已变化')
  }
  if (row.writerEpoch !== options.writerEpoch || identity.writerEpoch !== options.writerEpoch) {
    throw structuredError('WRITER_REVOKED', '写入代次已变化')
  }
  const now = options.now ?? new Date()
  if (row.expiresAt <= now.toISOString()) {
    throw structuredError('UPLOAD_EXPIRED', '上传已过期，请重新上传')
  }
  if (row.status === 'consumed') {
    throw structuredError('UPLOAD_NOT_READY', '上传已被业务引用，不能再次写入')
  }
  if (row.status === 'ready') {
    return inspectCatalogUpload(uploadId, { now }, database)
  }
  const declared = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
  if (declared && declared !== row.contentType) {
    throw structuredError('INVALID_INPUT', '上传内容类型与申请不一致', { field: 'contentType' })
  }
  const lengthHeader = request.headers['content-length']
  const maxBytes = options.maxBytes ?? UPLOAD_STREAM_MAX_BYTES
  if (lengthHeader) {
    const length = Number(lengthHeader)
    if (!Number.isFinite(length) || length < 0) {
      throw structuredError('INVALID_INPUT', 'Content-Length 无效')
    }
    if (length > maxBytes) {
      throw structuredError('LIMIT_EXCEEDED', '上传超过大小上限', { limit: maxBytes, actual: length })
    }
  }
  ensureUploadDirs()
  const partRel = uploadPartRel(uploadId)
  const partAbs = resolveAssetPath(partRel)
  const updatedAt = now.toISOString()
  database
    .prepare(
      `UPDATE catalog_image_uploads SET status = 'writing', rel_path = ?, updated_at = ? WHERE upload_id = ?`
    )
    .run(partRel, updatedAt, uploadId)
  database
    .prepare(
      `UPDATE catalog_image_file_jobs
       SET status = 'inProgress', updated_at = ?
       WHERE upload_id = ? AND kind = 'uploadWrite' AND status IN ('pending', 'inProgress')`
    )
    .run(updatedAt, uploadId)
  maybeCrashImageFlow('beforeWriteFile')
  fs.mkdirSync(path.dirname(partAbs), { recursive: true })
  const limiter = new LimitedBytes(maxBytes)
  try {
    await pipeline(request, limiter, createWriteStream(partAbs))
  } catch (error) {
    try {
      fs.unlinkSync(partAbs)
    } catch {
      // Best-effort; recovery deletes leftover parts.
    }
    database
      .prepare(
        `UPDATE catalog_image_uploads SET status = 'failed', updated_at = ? WHERE upload_id = ?`
      )
      .run(new Date().toISOString(), uploadId)
    if (isLimitError(error)) {
      throw structuredError('LIMIT_EXCEEDED', '上传超过大小上限', {
        limit: error.limit,
        actual: error.actual
      })
    }
    throw error
  }
  const data = fs.readFileSync(partAbs)
  const detectedExt = detectImageExtensionFromBuffer(data)
  if (!detectedExt) {
    fs.unlinkSync(partAbs)
    database
      .prepare(
        `UPDATE catalog_image_uploads SET status = 'failed', updated_at = ? WHERE upload_id = ?`
      )
      .run(new Date().toISOString(), uploadId)
    throw structuredError('INVALID_INPUT', '上传不是可用图片')
  }
  let mediaType: string
  try {
    mediaType = await inspectServedImage(data)
  } catch (error) {
    fs.unlinkSync(partAbs)
    database
      .prepare(
        `UPDATE catalog_image_uploads SET status = 'failed', updated_at = ? WHERE upload_id = ?`
      )
      .run(new Date().toISOString(), uploadId)
    if (error instanceof AssetPixelLimitError) {
      throw structuredError('LIMIT_EXCEEDED', '图片像素尺寸过大', {
        limit: 64 * 1024 * 1024
      })
    }
    throw structuredError('INVALID_INPUT', '上传不是可用图片')
  }
  if (mediaType !== row.contentType) {
    fs.unlinkSync(partAbs)
    database
      .prepare(
        `UPDATE catalog_image_uploads SET status = 'failed', updated_at = ? WHERE upload_id = ?`
      )
      .run(new Date().toISOString(), uploadId)
    throw structuredError('INVALID_INPUT', '上传内容类型与申请不一致', { field: 'contentType' })
  }
  const ext = extensionForDetectedType(mediaType, row.contentType)
  const readyRel = uploadReadyRel(uploadId, ext)
  const readyAbs = resolveAssetPath(readyRel)
  writeAtomic(readyAbs, data)
  try {
    fs.unlinkSync(partAbs)
  } catch {
    // Part may already be gone after atomic replace on the same path.
  }
  maybeCrashImageFlow('afterWriteFile')
  const dimensions = readImageDimensionsFromBuffer(data)
  if (!dimensions) {
    throw structuredError('INVALID_INPUT', '无法读取图片尺寸')
  }
  const digest = sha256Buffer(data)
  const readyAt = new Date().toISOString()
  database.transaction(() => {
    database
      .prepare(
        `UPDATE catalog_image_uploads
         SET status = 'ready', rel_path = ?, byte_length = ?, sha256 = ?, width = ?, height = ?,
             content_type = ?, updated_at = ?
         WHERE upload_id = ?`
      )
      .run(readyRel, data.length, digest, dimensions.width, dimensions.height, row.contentType, readyAt, uploadId)
    database
      .prepare(
        `UPDATE catalog_image_file_jobs
         SET status = 'done', rel_path = ?, target_rel_path = ?, updated_at = ?
         WHERE upload_id = ? AND kind = 'uploadWrite'`
      )
      .run(readyRel, readyRel, readyAt, uploadId)
  })()
  return inspectCatalogUpload(uploadId, { now: new Date() }, database)
}

export function readReadyUploadBytes(upload: CatalogUploadRow): Buffer {
  if (upload.status !== 'ready' || !upload.relPath) {
    throw structuredError('UPLOAD_NOT_READY', '上传尚未完成')
  }
  const abs = resolveAssetPath(upload.relPath)
  if (!fs.existsSync(abs)) throw structuredError('UPLOAD_NOT_READY', '上传文件缺失')
  return fs.readFileSync(abs)
}

export function extensionFromUpload(upload: CatalogUploadRow): string {
  if (upload.relPath) {
    const ext = path.posix.extname(upload.relPath).toLowerCase()
    if (ext && ext !== '.part') return ext
  }
  return CONTENT_TYPE_EXT[upload.contentType]
}

export function contentTypeFromExt(ext: string): ManageImageContentType | null {
  return EXT_CONTENT_TYPE[ext.toLowerCase()] ?? null
}

export function consumeReadyUpload(
  uploadId: string,
  operationId: string,
  expectedPurpose: UploadPurpose,
  database: Database.Database = getDb()
): CatalogUploadRow {
  const row = readCatalogUpload(uploadId, database)
  if (!row) throw structuredError('INVALID_INPUT', '上传不存在', { field: 'uploadId' })
  if (row.purpose !== expectedPurpose) {
    throw structuredError('INVALID_INPUT', '上传用途与业务不一致', { field: 'purpose' })
  }
  if (row.status === 'consumed' && row.consumedByOperationId === operationId) {
    return row
  }
  if (row.status === 'expired') {
    throw structuredError('UPLOAD_EXPIRED', '上传已过期，请重新上传')
  }
  if (row.status !== 'ready') {
    throw structuredError('UPLOAD_NOT_READY', '上传尚未完成或已被使用')
  }
  const now = new Date().toISOString()
  if (row.expiresAt <= now) {
    throw structuredError('UPLOAD_EXPIRED', '上传已过期，请重新上传')
  }
  const changed = database
    .prepare(
      `UPDATE catalog_image_uploads
       SET status = 'consumed', consumed_at = ?, consumed_by_operation_id = ?, updated_at = ?
       WHERE upload_id = ? AND status = 'ready'`
    )
    .run(now, operationId, now, uploadId)
  if (changed.changes !== 1) {
    throw structuredError('UPLOAD_NOT_READY', '上传尚未完成或已被使用')
  }
  return readCatalogUpload(uploadId, database)!
}

export function insertImageFileJob(
  input: {
    kind: 'promoteToFormal' | 'deleteOrphan' | 'deleteReplaced' | 'uploadWrite'
    uploadId?: string | null
    relPath: string
    targetRelPath?: string | null
    status?: 'pending' | 'inProgress' | 'done' | 'failed'
  },
  database: Database.Database = getDb()
): string {
  const jobId = randomUUID()
  const now = new Date().toISOString()
  database
    .prepare(
      `INSERT INTO catalog_image_file_jobs (
         job_id, kind, upload_id, rel_path, target_rel_path, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      jobId,
      input.kind,
      input.uploadId ?? null,
      input.relPath,
      input.targetRelPath ?? null,
      input.status ?? 'pending',
      now,
      now
    )
  return jobId
}

export function updateImageFileJob(
  jobId: string,
  patch: { status?: 'pending' | 'inProgress' | 'done' | 'failed'; relPath?: string; targetRelPath?: string },
  database: Database.Database = getDb()
): void {
  const now = new Date().toISOString()
  const assignments = ['updated_at = ?']
  const values: unknown[] = [now]
  if (patch.status) {
    assignments.push('status = ?')
    values.push(patch.status)
  }
  if (patch.relPath) {
    assignments.push('rel_path = ?')
    values.push(patch.relPath)
  }
  if (patch.targetRelPath) {
    assignments.push('target_rel_path = ?')
    values.push(patch.targetRelPath)
  }
  values.push(jobId)
  database.prepare(`UPDATE catalog_image_file_jobs SET ${assignments.join(', ')} WHERE job_id = ?`).run(...values)
}

export const PROMOTE_JOURNAL_SUFFIX = '.promote.json'

export function promoteJournalRel(uploadId: string): string {
  return path.posix.join(UPLOAD_DIRNAME, `${uploadId}${PROMOTE_JOURNAL_SUFFIX}`)
}

export function writePromoteJournal(uploadId: string, destinationRel: string, stagingRel: string): void {
  ensureUploadDirs()
  writeAtomic(
    resolveAssetPath(promoteJournalRel(uploadId)),
    Buffer.from(JSON.stringify({ destinationRel, stagingRel, uploadId }), 'utf8')
  )
}

export function readPromoteJournal(
  uploadId: string
): { destinationRel: string; stagingRel: string; uploadId: string } | null {
  const abs = resolveAssetPath(promoteJournalRel(uploadId))
  if (!fs.existsSync(abs)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as {
      destinationRel?: unknown
      stagingRel?: unknown
      uploadId?: unknown
    }
    if (
      typeof parsed.destinationRel !== 'string' ||
      typeof parsed.stagingRel !== 'string' ||
      typeof parsed.uploadId !== 'string'
    ) {
      return null
    }
    return {
      destinationRel: parsed.destinationRel,
      stagingRel: parsed.stagingRel,
      uploadId: parsed.uploadId
    }
  } catch {
    return null
  }
}

export function removePromoteJournal(uploadId: string): void {
  try {
    fs.unlinkSync(resolveAssetPath(promoteJournalRel(uploadId)))
  } catch {
    // Journal may already be gone after a previous recovery pass.
  }
}

export function listPromoteJournalUploadIds(): string[] {
  const dir = uploadsDir()
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(PROMOTE_JOURNAL_SUFFIX))
    .map((name) => name.slice(0, -PROMOTE_JOURNAL_SUFFIX.length))
}

export function findReadyUploadRelOnDisk(uploadId: string): string | null {
  const dir = uploadsDir()
  if (!fs.existsSync(dir)) return null
  const names = fs.readdirSync(dir)
  const match = names.find(
    (name) =>
      name.startsWith(`${uploadId}.`) &&
      !name.endsWith('.part') &&
      !name.endsWith(PROMOTE_JOURNAL_SUFFIX)
  )
  return match ? path.posix.join(UPLOAD_DIRNAME, match) : null
}

export async function completeCatalogUploadFromBuffer(
  uploadId: string,
  data: Buffer,
  options: {
    writerEpoch: number
    catalogId: string
    contentType?: ManageImageContentType
    maxBytes?: number
    now?: Date
  },
  database: Database.Database = getDb()
): Promise<UploadInspectResult> {
  const stream = Readable.from([data]) as IncomingMessage
  Object.assign(stream, {
    headers: {
      'content-type': options.contentType ?? 'image/png',
      'content-length': String(data.length)
    }
  })
  return completeCatalogUploadFromStream(uploadId, stream, options, database)
}
