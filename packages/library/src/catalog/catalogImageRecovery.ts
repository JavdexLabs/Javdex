import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { UPLOAD_TTL_MS } from '@shared/protocol/limits'
import { getDb } from '@library/db/database'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { listFormallyReferencedImagePaths } from './catalogImageRefs'
import { maybeCrashImageFlow } from './catalogImageCrash'
import {
  PENDING_SCRAPE_STAGING_DIRNAME,
  findReadyUploadRelOnDisk,
  listPromoteJournalUploadIds,
  readCatalogUpload,
  readPromoteJournal,
  removePromoteJournal,
  sha256Buffer,
  type CatalogUploadStatus
} from './catalogUploads'

interface JobRow {
  job_id: string
  kind: 'uploadWrite' | 'promoteToFormal' | 'deleteOrphan' | 'deleteReplaced'
  upload_id: string | null
  rel_path: string
  target_rel_path: string | null
  status: 'pending' | 'inProgress' | 'done' | 'failed'
}

function unlinkIfPresent(relPath: string): void {
  try {
    const abs = mediaAssetStore.resolve(relPath)
    if (fs.existsSync(abs)) fs.unlinkSync(abs)
  } catch {
    // Paths that escape the media root are ignored; recovery must not throw.
  }
}

function fileExists(relPath: string | null | undefined): boolean {
  if (!relPath) return false
  try {
    return fs.existsSync(mediaAssetStore.resolve(relPath))
  } catch {
    return false
  }
}

function markUploadReadyFromFile(
  database: Database.Database,
  uploadId: string,
  readyRel: string,
  nowIso: string
): boolean {
  if (!fileExists(readyRel)) return false
  const bytes = fs.readFileSync(mediaAssetStore.resolve(readyRel))
  if (!mediaAssetStore.isUsableImageBuffer(bytes)) return false
  const dimensions = mediaAssetStore.readImageDimensions(bytes)
  if (!dimensions) return false
  database
    .prepare(
      `UPDATE catalog_image_uploads
       SET status = 'ready', rel_path = ?, byte_length = ?, sha256 = ?, width = ?, height = ?, updated_at = ?
       WHERE upload_id = ? AND status IN ('reserved', 'writing')`
    )
    .run(readyRel, bytes.length, sha256Buffer(bytes), dimensions.width, dimensions.height, nowIso, uploadId)
  database
    .prepare(
      `UPDATE catalog_image_file_jobs
       SET status = 'done', rel_path = ?, target_rel_path = ?, updated_at = ?
       WHERE upload_id = ? AND kind = 'uploadWrite'`
    )
    .run(readyRel, readyRel, nowIso, uploadId)
  return true
}

function recoverIncompleteWrites(database: Database.Database, nowIso: string): void {
  const rows = database
    .prepare(
      `SELECT upload_id, status, rel_path
       FROM catalog_image_uploads
       WHERE status IN ('reserved', 'writing', 'failed')`
    )
    .all() as Array<{
    upload_id: string
    status: CatalogUploadStatus
    rel_path: string | null
  }>
  for (const row of rows) {
    const upload = readCatalogUpload(row.upload_id, database)
    if (!upload) continue
    const partRel = upload.relPath?.endsWith('.part') ? upload.relPath : null
    const readyRel =
      (upload.relPath && !upload.relPath.endsWith('.part') ? upload.relPath : null) ??
      findReadyUploadRelOnDisk(upload.uploadId)
    if (partRel) unlinkIfPresent(partRel)
    if (readyRel && markUploadReadyFromFile(database, upload.uploadId, readyRel, nowIso)) {
      continue
    }
    database
      .prepare(
        `UPDATE catalog_image_uploads SET status = 'failed', updated_at = ? WHERE upload_id = ? AND status IN ('reserved', 'writing')`
      )
      .run(nowIso, upload.uploadId)
    database
      .prepare(
        `UPDATE catalog_image_file_jobs
         SET status = 'failed', updated_at = ?
         WHERE upload_id = ? AND kind = 'uploadWrite' AND status IN ('pending', 'inProgress')`
      )
      .run(nowIso, upload.uploadId)
  }
}

function recoverUncommittedPromotes(
  database: Database.Database,
  nowIso: string,
  referenced: Set<string>
): void {
  const jobs = database
    .prepare(
      `SELECT job_id, kind, upload_id, rel_path, target_rel_path, status
       FROM catalog_image_file_jobs
       WHERE kind = 'promoteToFormal' AND status IN ('pending', 'inProgress')`
    )
    .all() as JobRow[]
  for (const job of jobs) {
    const target = job.target_rel_path
    const upload = job.upload_id ? readCatalogUpload(job.upload_id, database) : null
    if (upload?.status === 'consumed' && target && referenced.has(target)) {
      if (!fileExists(target) && fileExists(job.rel_path)) {
        try {
          fs.mkdirSync(path.dirname(mediaAssetStore.resolve(target)), { recursive: true })
          fs.copyFileSync(mediaAssetStore.resolve(job.rel_path), mediaAssetStore.resolve(target))
        } catch {
          // Leave the job pending; a later recovery pass retries.
          continue
        }
      }
      database
        .prepare(`UPDATE catalog_image_file_jobs SET status = 'done', updated_at = ? WHERE job_id = ?`)
        .run(nowIso, job.job_id)
      continue
    }
    if (target && !referenced.has(target)) unlinkIfPresent(target)
    database
      .prepare(`UPDATE catalog_image_file_jobs SET status = 'failed', updated_at = ? WHERE job_id = ?`)
      .run(nowIso, job.job_id)
  }
}

export function recoverPromoteJournals(database: Database.Database = getDb()): void {
  const referenced = listFormallyReferencedImagePaths(database)
  for (const uploadId of listPromoteJournalUploadIds()) {
    const journal = readPromoteJournal(uploadId)
    if (!journal) {
      removePromoteJournal(uploadId)
      continue
    }
    if (referenced.has(journal.destinationRel)) {
      removePromoteJournal(uploadId)
      continue
    }
    const upload = readCatalogUpload(uploadId, database)
    if (
      journal.destinationRel.startsWith(`${PENDING_SCRAPE_STAGING_DIRNAME}/`) &&
      upload?.status === 'consumed'
    ) {
      removePromoteJournal(uploadId)
      continue
    }
    unlinkIfPresent(journal.destinationRel)
    removePromoteJournal(uploadId)
  }
}

function expireUnconsumedUploads(database: Database.Database, nowIso: string): void {
  const expired = database
    .prepare(
      `SELECT upload_id, rel_path, purpose, status
       FROM catalog_image_uploads
       WHERE status IN ('reserved', 'ready', 'failed')
         AND expires_at <= ?
         AND NOT (purpose = 'pendingScrapeStaging' AND status = 'consumed')`
    )
    .all(nowIso) as Array<{ upload_id: string; rel_path: string | null; purpose: string; status: string }>
  for (const row of expired) {
    database
      .prepare(
        `UPDATE catalog_image_uploads SET status = 'discarding', updated_at = ? WHERE upload_id = ?`
      )
      .run(nowIso, row.upload_id)
    if (row.rel_path) {
      database
        .prepare(
          `INSERT INTO catalog_image_file_jobs (
             job_id, kind, upload_id, rel_path, status, created_at, updated_at
           ) VALUES (?, 'deleteOrphan', ?, ?, 'pending', ?, ?)`
        )
        .run(cryptoRandom(), row.upload_id, row.rel_path, nowIso, nowIso)
    }
  }
}

function cryptoRandom(): string {
  return globalThis.crypto.randomUUID()
}

export function runCatalogImageFileJobs(database: Database.Database = getDb()): void {
  maybeCrashImageFlow('beforeOldDelete')
  const referenced = listFormallyReferencedImagePaths(database)
  const jobs = database
    .prepare(
      `SELECT job_id, kind, upload_id, rel_path, target_rel_path, status
       FROM catalog_image_file_jobs
       WHERE kind IN ('deleteOrphan', 'deleteReplaced') AND status IN ('pending', 'inProgress')
       ORDER BY created_at`
    )
    .all() as JobRow[]
  const nowIso = new Date().toISOString()
  for (const job of jobs) {
    database
      .prepare(`UPDATE catalog_image_file_jobs SET status = 'inProgress', updated_at = ? WHERE job_id = ?`)
      .run(nowIso, job.job_id)
    if (job.rel_path.startsWith(`${PENDING_SCRAPE_STAGING_DIRNAME}/`)) {
      database
        .prepare(`UPDATE catalog_image_file_jobs SET status = 'done', updated_at = ? WHERE job_id = ?`)
        .run(nowIso, job.job_id)
      continue
    }
    if (referenced.has(job.rel_path)) {
      database
        .prepare(`UPDATE catalog_image_file_jobs SET status = 'failed', updated_at = ? WHERE job_id = ?`)
        .run(nowIso, job.job_id)
      continue
    }
    unlinkIfPresent(job.rel_path)
    database
      .prepare(`UPDATE catalog_image_file_jobs SET status = 'done', updated_at = ? WHERE job_id = ?`)
      .run(nowIso, job.job_id)
    if (job.upload_id) {
      const upload = readCatalogUpload(job.upload_id, database)
      if (upload?.status === 'discarding') {
        database
          .prepare(
            `UPDATE catalog_image_uploads SET status = 'expired', updated_at = ? WHERE upload_id = ?`
          )
          .run(nowIso, job.upload_id)
      }
    }
  }
  maybeCrashImageFlow('afterOldDelete')
}

export function recoverCatalogImages(database: Database.Database = getDb(), now = new Date()): void {
  const nowIso = now.toISOString()
  recoverIncompleteWrites(database, nowIso)
  recoverPromoteJournals(database)
  const referenced = listFormallyReferencedImagePaths(database)
  recoverUncommittedPromotes(database, nowIso, referenced)
  expireUnconsumedUploads(database, nowIso)
  runCatalogImageFileJobs(database)
  void UPLOAD_TTL_MS
}
