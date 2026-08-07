import type { Database as SqliteDatabase } from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from './database'
import { normalizeActressName } from './actressNameNormalization'
import type {
  Actress,
  ActressDetail,
  ActressGalleryAsset,
  Video,
  ActressScrapeResult,
  ActressScrapeFieldImpact,
  ActressEditInput,
  ActressScrapeField,
  ActressScrapeUpdateMode,
  ActressBatchScrapeFilter,
  ActressBatchScrapeStatus,
  ActressGender,
  ActressGenderFilter,
  ActressFaceScanManifestItem,
  ActressListItem,
  ActressListPage,
  ActressListQuery,
  ActressListSortBy,
  ActressListStatusCounts,
  ActressListStatusFilter,
  ActressAvatarSourceInfo,
  ActressAvatarFilter,
  ActressMergeMainNameFrom,
  ListSortDir,
  ScrapedStatus
} from '@shared/types'
import type { ActressDeleteImpact, ActressDeleteMode } from '@shared/actressIpcContract'
import {
  ALL_ACTRESS_SCRAPE_FIELDS,
  ACTRESS_BATCH_DEFAULT_MISSING_FIELDS,
  ACTRESS_LIST_STATUS_SCRAPED_STATUS,
  actressStatusFilterOf
} from '@shared/types'
import {
  createAvatarCropV1,
  parseAvatarCrop,
  type ActressAvatarCommit
} from '@shared/avatarCrop'
import { canMergeActressGenders } from '@shared/actressProfileOptions'
import { normalizeCupSize } from '@shared/cupSizeUtils'
import {
  avatarSourceFingerprint,
  deleteAsset,
  detectImageExtensionFromBuffer,
  importAvatarDisplayFromBuffer,
  importAvatarFromFile,
  importAvatarSourceFromBuffer,
  inspectImageAsset,
  isUsableImageAsset,
  readAssetBytes,
  readAssetForServe,
  readImageDimensionsFromBuffer,
  readImageDimensionsFromPath,
  readImageDimensionsFromRelPath
} from '../services/assetService'
import { mimeFromExt } from '../services/assetCrypto'
import { actressSearchLikeParams, actressTextSearchSql } from './actressSearchSql'
import {
  findActressIdByOwnedName,
  isActressNameOwnershipAvailable as isActressNameAvailable,
  validateAndReleaseActressNameOwnershipForMerge,
  synchronizeActressNameOwnership
} from './actressNameOwnership'

interface ActressGalleryAssetWriteInput {
  remoteUrl?: string | null
  localPath?: string | null
  width?: number | null
  height?: number | null
}
import {
  ACTRESS_NAME_TYPE,
  getActressTypedName,
  listActressAliasNames,
  listActressNameRows,
  setActressTypedName,
  setActressTypedNameIfEmpty,
  upsertActressName
} from './actressNames'

/**
 * Resolve an actress by main name OR alias. Returns the *main* actress id,
 * so renamed/alias performers are merged under one identity.
 */
export function findActressByNameOrAlias(name: string): number | null {
  return findActressIdByOwnedName(name)
}

/** Return a usable avatar source and its exact plaintext-byte fingerprint. */
export function getActressAvatarSourceInfo(id: number): ActressAvatarSourceInfo | null {
  const actress = getDb()
    .prepare('SELECT avatar_path, avatar_source_path FROM actresses WHERE id = ?')
    .get(id) as
    | { avatar_path: string | null; avatar_source_path: string | null }
    | undefined
  if (!actress) return null

  const sourceUsable = isUsableImageAsset(actress.avatar_source_path)
  const assetPath = sourceUsable ? actress.avatar_source_path : actress.avatar_path
  if (!assetPath || !isUsableImageAsset(assetPath)) return null

  return {
    assetPath,
    sourceFingerprint: avatarSourceFingerprint(readAssetBytes(assetPath)),
    requiresSourceAdoption: !sourceUsable
  }
}

/**
 * Find an existing actress (by name/alias) or create a new one.
 * Downloaded avatar paths are adopted into source+display+crop (fill-empty only).
 * Returns the main actress id. Must be called inside a transaction by the caller
 * when used as part of a larger unit of work.
 */
export function upsertActressFromScrape(
  name: string,
  avatarRelPath: string | null,
  gender?: ActressGender
): number {
  const db = getDb()
  const trimmed = name.trim()

  const existingId = findActressByNameOrAlias(trimmed)
  if (existingId !== null) {
    if (gender) {
      db.prepare('UPDATE actresses SET gender = ? WHERE id = ?').run(gender, existingId)
    }
    if (avatarRelPath) {
      adoptDownloadedAvatarIfMissing(existingId, avatarRelPath)
    }
    return existingId
  }

  assertActressNameAvailable(trimmed, 0)
  const id = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO actresses (main_name, avatar_path, gender) VALUES (?, ?, ?)')
      .run(trimmed, null, gender ?? 'female')
    const createdId = Number(info.lastInsertRowid)
    upsertActressName(createdId, trimmed, 'main', null, null, 1)
    synchronizeActressNameOwnership(createdId)
    return createdId
  })()
  if (avatarRelPath) {
    adoptDownloadedAvatarIfMissing(id, avatarRelPath)
  }
  return id
}

/**
 * Promote a scraped download into the avatar bundle when the actress has no usable display avatar.
 * Unused / failed downloads are deleted so temporary scrape files do not linger.
 */
function adoptDownloadedAvatarIfMissing(id: number, downloadedRelPath: string): void {
  clearBrokenActressAvatarIfNeeded(id)
  const db = getDb()
  const actress = db
    .prepare('SELECT main_name, avatar_path FROM actresses WHERE id = ?')
    .get(id) as { main_name: string; avatar_path: string | null } | undefined
  if (!actress) {
    deleteAsset(downloadedRelPath)
    return
  }
  if (!isBlankText(actress.avatar_path) && isUsableImageAsset(actress.avatar_path)) {
    if (downloadedRelPath !== actress.avatar_path) deleteAsset(downloadedRelPath)
    return
  }
  try {
    const adopted = adoptDownloadedAvatarAsBundle(id, actress.main_name, downloadedRelPath)
    db.prepare(
      `UPDATE actresses SET
         avatar_path = ?,
         avatar_source_path = ?,
         avatar_crop_json = ?,
         updated_at = ?
       WHERE id = ?`
    ).run(adopted.displayPath, adopted.sourcePath, adopted.cropJson, nowIso(), id)
  } catch {
    deleteAsset(downloadedRelPath)
  }
}

export function addAlias(actressId: number, aliasName: string): void {
  const db = getDb()
  db.transaction(() => {
    const trimmed = aliasName.trim()
    assertActressNameAvailable(trimmed, actressId)
    upsertActressName(actressId, trimmed, ACTRESS_NAME_TYPE.ALIAS, null, null, 0)
    synchronizeActressNameOwnership(actressId)
  })()
}

export type ActressBatchTarget = { id: number; main_name: string }

function actressMissingFieldCondition(field: ActressScrapeField): string {
  switch (field) {
    case 'avatar':
      return "(a.avatar_path IS NULL OR trim(a.avatar_path) = '')"
    case 'gallery':
      return `NOT EXISTS (
        SELECT 1 FROM actress_gallery_assets aga WHERE aga.actress_id = a.id
      )`
    case 'birthDate':
      return "(a.birth_date IS NULL OR trim(a.birth_date) = '')"
    case 'nameZh':
      return `NOT EXISTS (
        SELECT 1 FROM actress_names an
        WHERE an.actress_id = a.id AND an.type = 'zh'
      )`
    case 'nameEn':
      return `NOT EXISTS (
        SELECT 1 FROM actress_names an
        WHERE an.actress_id = a.id AND an.type = 'en'
      )`
    case 'debutDate':
      return "(a.debut_date IS NULL OR trim(a.debut_date) = '')"
    case 'heightCm':
      return 'a.height_cm IS NULL'
    case 'measurements':
      return '(a.bust_cm IS NULL OR a.waist_cm IS NULL OR a.hip_cm IS NULL)'
    case 'cupSize':
      return "(a.cup_size IS NULL OR trim(a.cup_size) = '')"
    case 'bloodType':
      return "(a.blood_type IS NULL OR trim(a.blood_type) = '')"
    case 'zodiac':
      return "(a.zodiac IS NULL OR trim(a.zodiac) = '')"
    case 'nationality':
      return "(a.nationality IS NULL OR trim(a.nationality) = '')"
    case 'profileSummary':
      return "(a.profile_summary IS NULL OR trim(a.profile_summary) = '')"
    case 'aliases':
      return `NOT EXISTS (
        SELECT 1 FROM actress_names an
        WHERE an.actress_id = a.id AND an.type = 'alias'
      )`
    default:
      return '0'
  }
}

/**
 * Append a cumulative scrape-status condition. The list filter and the batch scope share the
 * same status vocabulary and column mapping, so both go through one place.
 */
function pushScrapeStatusCondition(
  conditions: string[],
  params: unknown[],
  status: ActressListStatusFilter | ActressBatchScrapeStatus
): void {
  if (status === 'all') return
  conditions.push('a.scraped_status = ?')
  params.push(ACTRESS_LIST_STATUS_SCRAPED_STATUS[status])
}

function buildActressBatchConditions(
  filter: Pick<ActressBatchScrapeFilter, 'actressIds' | 'scope' | 'scrapeStatus'>
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.actressIds) {
    const actressIds = Array.from(
      new Set(filter.actressIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)))
    )
    if (actressIds.length === 0) {
      conditions.push('0')
    } else {
      conditions.push(`a.id IN (${actressIds.map(() => '?').join(', ')})`)
      params.push(...actressIds)
    }
  }

  if (filter.scope === 'female') {
    conditions.push("(a.gender IS NULL OR a.gender = 'female')")
  } else if (filter.scope === 'male') {
    conditions.push("a.gender = 'male'")
  }

  pushScrapeStatusCondition(conditions, params, filter.scrapeStatus ?? 'all')

  return { conditions, params }
}

function buildBatchActressWhere(filter: ActressBatchScrapeFilter): {
  sql: string
  params: unknown[]
} {
  const { conditions, params } = buildActressBatchConditions(filter)

  const missingFields = Array.from(new Set(filter.missingFields ?? []))
  if (missingFields.length > 0) {
    conditions.push(`(${missingFields.map(actressMissingFieldCondition).join(' OR ')})`)
  }

  return {
    sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  }
}

function actressBatchScopeSql(
  filter: Pick<ActressBatchScrapeFilter, 'actressIds' | 'scope' | 'scrapeStatus'>
): {
  sql: string
  params: unknown[]
} {
  const { conditions, params } = buildActressBatchConditions(filter)
  return {
    sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  }
}

function listActressesWithBrokenAvatars(
  filter: Pick<ActressBatchScrapeFilter, 'actressIds' | 'scope' | 'scrapeStatus'>
): ActressBatchTarget[] {
  const db = getDb()
  const { sql: scopeSql, params } = actressBatchScopeSql(filter)
  const rows = db
    .prepare(`SELECT a.id, a.main_name, a.avatar_path FROM actresses a ${scopeSql}`)
    .all(...params) as Array<{ id: number; main_name: string; avatar_path: string | null }>

  return rows
    .filter((row) => !isBlankText(row.avatar_path) && !isUsableImageAsset(row.avatar_path))
    .map((row) => ({ id: row.id, main_name: row.main_name }))
}

function mergeBatchActressTargets(
  filter: ActressBatchScrapeFilter,
  targets: ActressBatchTarget[]
): ActressBatchTarget[] {
  if (!(filter.missingFields ?? []).includes('avatar')) return targets
  const seen = new Set(targets.map((target) => target.id))
  const merged = [...targets]
  for (const extra of listActressesWithBrokenAvatars(filter)) {
    if (seen.has(extra.id)) continue
    merged.push(extra)
    seen.add(extra.id)
  }
  return merged.sort((a, b) => a.main_name.localeCompare(b.main_name, 'zh-Hans-CN'))
}

/** Clear broken avatar display/source files and related crop metadata. */
export function clearBrokenActressAvatarIfNeeded(actressId: number): boolean {
  const db = getDb()
  const row = db
    .prepare(
      'SELECT avatar_path, avatar_source_path, avatar_crop_json FROM actresses WHERE id = ?'
    )
    .get(actressId) as
    | {
        avatar_path: string | null
        avatar_source_path: string | null
        avatar_crop_json: string | null
      }
    | undefined
  if (!row) return false

  const displayBroken =
    !isBlankText(row.avatar_path) && !isUsableImageAsset(row.avatar_path)
  const sourceBroken =
    !isBlankText(row.avatar_source_path) && !isUsableImageAsset(row.avatar_source_path)
  const cropOrphan = Boolean(row.avatar_crop_json) && isBlankText(row.avatar_source_path)

  if (!displayBroken && !sourceBroken && !cropOrphan) return false

  if (displayBroken && row.avatar_path) deleteAsset(row.avatar_path)
  if (sourceBroken && row.avatar_source_path) deleteAsset(row.avatar_source_path)

  db.prepare(
    `UPDATE actresses SET
       avatar_path = CASE WHEN @clear_display = 1 THEN NULL ELSE avatar_path END,
       avatar_source_path = CASE WHEN @clear_source = 1 THEN NULL ELSE avatar_source_path END,
       avatar_crop_json = CASE
         WHEN @clear_source = 1 OR @clear_crop = 1 THEN NULL
         ELSE avatar_crop_json
       END,
       updated_at = @updated_at
     WHERE id = @id`
  ).run({
    id: actressId,
    clear_display: displayBroken ? 1 : 0,
    clear_source: sourceBroken ? 1 : 0,
    clear_crop: sourceBroken || cropOrphan ? 1 : 0,
    updated_at: nowIso()
  })
  return true
}

function readSourceBytesFromCommit(
  commit: ActressAvatarCommit,
  currentSourcePath: string | null
): { bytes: Buffer; ext: string; fingerprint: string } | null {
  const finish = (
    bytes: Buffer,
    ext: string
  ): { bytes: Buffer; ext: string; fingerprint: string } => {
    const detectedExt = detectImageExtensionFromBuffer(bytes)
    // Chromium can decode formats (and some loosely encoded JPEGs) that Electron's
    // nativeImage dimension probe cannot. The editor already decoded this source
    // to produce the display image, so recognized source bytes remain valid.
    if (!readImageDimensionsFromBuffer(bytes) && !detectedExt) {
      throw new Error('头像原图无效')
    }
    return {
      bytes,
      ext: detectedExt ?? ext,
      fingerprint: avatarSourceFingerprint(bytes)
    }
  }

  if (commit.sourceImageBase64) {
    const bytes = Buffer.from(commit.sourceImageBase64, 'base64')
    return finish(bytes, '.jpg')
  }
  if (commit.sourceLocalPath) {
    if (!fs.existsSync(commit.sourceLocalPath)) throw new Error('头像原图文件不存在')
    const bytes = fs.readFileSync(commit.sourceLocalPath)
    const ext = path.extname(commit.sourceLocalPath).toLowerCase() || '.jpg'
    return finish(bytes, ext)
  }
  if (commit.sourceAssetPath) {
    const bytes = readAssetBytes(commit.sourceAssetPath)
    const ext = path.extname(commit.sourceAssetPath).toLowerCase() || '.jpg'
    return finish(bytes, ext)
  }
  if (currentSourcePath && isUsableImageAsset(currentSourcePath)) {
    const bytes = readAssetBytes(currentSourcePath)
    return finish(bytes, path.extname(currentSourcePath).toLowerCase() || '.jpg')
  }
  return null
}

/**
 * Persist avatar source + display + crop as one bundle.
 * Fine-tuning keeps source; changing source replaces the whole bundle.
 */
export function setActressAvatarBundle(
  id: number,
  mainName: string,
  commit: ActressAvatarCommit
): void {
  const db = getDb()
  const actress = db
    .prepare(
      'SELECT avatar_path, avatar_source_path, avatar_crop_json FROM actresses WHERE id = ?'
    )
    .get(id) as
    | {
        avatar_path: string | null
        avatar_source_path: string | null
        avatar_crop_json: string | null
      }
    | undefined
  if (!actress) throw new Error('演员不存在')

  const displayBytes = Buffer.from(commit.displayImageBase64, 'base64')
  if (!readImageDimensionsFromBuffer(displayBytes)) throw new Error('头像展示图无效')

  const changingSource = Boolean(
    commit.sourceImageBase64 || commit.sourceLocalPath || commit.sourceAssetPath
  )
  const sourceInfo = readSourceBytesFromCommit(commit, actress.avatar_source_path)
  if (!sourceInfo) {
    throw new Error('缺少头像原图，请重新选择图片后再裁剪保存')
  }

  const crop = parseAvatarCrop(JSON.stringify(commit.crop), sourceInfo.fingerprint)
  if (!crop) throw new Error('头像裁剪参数无效')
  if (crop.sourceFingerprint !== sourceInfo.fingerprint) {
    throw new Error('头像裁剪参数与原图不匹配')
  }

  let nextSourcePath = actress.avatar_source_path
  if (changingSource || !actress.avatar_source_path) {
    nextSourcePath = importAvatarSourceFromBuffer(
      mainName,
      id,
      sourceInfo.bytes,
      sourceInfo.ext
    ).relPath
  } else {
    const currentAsset = readAssetForServe(actress.avatar_source_path)
    const currentFp = avatarSourceFingerprint(currentAsset.body)
    const storedFormatMismatch = currentAsset.mime !== mimeFromExt(sourceInfo.ext)
    if (currentFp !== sourceInfo.fingerprint || storedFormatMismatch) {
      nextSourcePath = importAvatarSourceFromBuffer(
        mainName,
        id,
        sourceInfo.bytes,
        sourceInfo.ext
      ).relPath
    }
  }

  const nextDisplayPath = importAvatarDisplayFromBuffer(mainName, id, displayBytes)
  const cropJson = JSON.stringify(
    createAvatarCropV1({
      sourceFingerprint: sourceInfo.fingerprint,
      zoom: crop.zoom,
      offsetX: crop.offsetX,
      offsetY: crop.offsetY,
      viewSize: crop.viewSize,
      outputSize: crop.outputSize
    })
  )

  const oldDisplay = actress.avatar_path
  const oldSource = actress.avatar_source_path

  db.prepare(
    `UPDATE actresses SET
       avatar_path = ?,
       avatar_source_path = ?,
       avatar_crop_json = ?,
       updated_at = ?
     WHERE id = ?`
  ).run(nextDisplayPath, nextSourcePath, cropJson, nowIso(), id)

  if (oldDisplay && oldDisplay !== nextDisplayPath) deleteAsset(oldDisplay)
  if (oldSource && oldSource !== nextSourcePath) deleteAsset(oldSource)
}

function clearActressAvatarBundle(id: number): void {
  const db = getDb()
  const actress = db
    .prepare('SELECT avatar_path, avatar_source_path FROM actresses WHERE id = ?')
    .get(id) as { avatar_path: string | null; avatar_source_path: string | null } | undefined
  if (!actress) throw new Error('演员不存在')
  deleteAsset(actress.avatar_path)
  deleteAsset(actress.avatar_source_path)
  db.prepare(
    `UPDATE actresses SET
       avatar_path = NULL,
       avatar_source_path = NULL,
       avatar_crop_json = NULL,
       updated_at = ?
     WHERE id = ?`
  ).run(nowIso(), id)
}

/** Promote a downloaded avatar into source+display+default-crop. */
export function adoptDownloadedAvatarAsBundle(
  id: number,
  mainName: string,
  downloadedRelPath: string
): { displayPath: string; sourcePath: string; cropJson: string } {
  const bytes = readAssetBytes(downloadedRelPath)
  if (!readImageDimensionsFromBuffer(bytes)) {
    deleteAsset(downloadedRelPath)
    throw new Error('下载的头像不是有效图片')
  }
  const fingerprint = avatarSourceFingerprint(bytes)
  const ext = path.extname(downloadedRelPath).toLowerCase() || '.jpg'
  const source = importAvatarSourceFromBuffer(mainName, id, bytes, ext)
  const displayPath = importAvatarDisplayFromBuffer(mainName, id, bytes)
  const cropJson = JSON.stringify(
    createAvatarCropV1({
      sourceFingerprint: fingerprint,
      zoom: 1,
      offsetX: 0,
      offsetY: 0
    })
  )
  if (downloadedRelPath !== source.relPath && downloadedRelPath !== displayPath) {
    deleteAsset(downloadedRelPath)
  }
  return { displayPath, sourcePath: source.relPath, cropJson }
}

/**
 * True when the scrape download is the same image already stored as this actress's
 * avatar source (or legacy display when no source exists). Used to keep manual crops.
 */
function downloadedAvatarMatchesExistingSource(
  actress: { avatar_path: string | null; avatar_source_path: string | null },
  downloadedRelPath: string
): boolean {
  if (!isUsableImageAsset(downloadedRelPath)) return false
  let downloadedFp: string
  try {
    downloadedFp = avatarSourceFingerprint(readAssetBytes(downloadedRelPath))
  } catch {
    return false
  }
  if (actress.avatar_source_path && isUsableImageAsset(actress.avatar_source_path)) {
    try {
      return avatarSourceFingerprint(readAssetBytes(actress.avatar_source_path)) === downloadedFp
    } catch {
      return false
    }
  }
  // Legacy rows without a source: only skip when display bytes are identical (uncropped).
  if (actress.avatar_path && isUsableImageAsset(actress.avatar_path)) {
    try {
      return avatarSourceFingerprint(readAssetBytes(actress.avatar_path)) === downloadedFp
    } catch {
      return false
    }
  }
  return false
}

export function listActressesForBatchScrape(
  filter: ActressBatchScrapeFilter
): ActressBatchTarget[] {
  const db = getDb()
  const { sql: where, params } = buildBatchActressWhere(filter)
  const targets = db
    .prepare(`SELECT a.id, a.main_name FROM actresses a ${where} ORDER BY a.main_name`)
    .all(...params) as ActressBatchTarget[]
  return mergeBatchActressTargets(filter, targets)
}

export function countActressesForBatchScrape(filter: ActressBatchScrapeFilter): number {
  if ((filter.missingFields ?? []).includes('avatar')) {
    return listActressesForBatchScrape(filter).length
  }
  const db = getDb()
  const { sql: where, params } = buildBatchActressWhere(filter)
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM actresses a ${where}`).get(...params) as { n: number }
  ).n
}

/** Actresses missing avatar, birth date, or structured measurements (batch profile scrape targets). */
export function listIncompleteProfileActresses(
  gender: ActressGenderFilter = 'female'
): { id: number; main_name: string }[] {
  return listActressesForBatchScrape({
    scope: gender,
    missingFields: [...ACTRESS_BATCH_DEFAULT_MISSING_FIELDS]
  })
}

function buildActressListWhere(
  search: string | undefined,
  gender: ActressGenderFilter,
  status: ActressListStatusFilter,
  actressIds?: number[]
): { sql: string; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  if (search?.trim()) {
    conditions.push(actressTextSearchSql('a'))
    params.push(...actressSearchLikeParams(search))
  }
  if (gender !== 'all') {
    conditions.push('a.gender = ?')
    params.push(gender)
  }
  pushScrapeStatusCondition(conditions, params, status)
  if (actressIds) {
    const ids = [...new Set(actressIds.filter((id) => Number.isInteger(id) && id > 0))]
    conditions.push(ids.length > 0 ? 'a.id IN (SELECT value FROM json_each(?))' : '0 = 1')
    if (ids.length > 0) params.push(JSON.stringify(ids))
  }

  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', params }
}

function actressHasUsableAvatar(actress: Pick<ActressListItem, 'avatar_path'>): boolean {
  return !isBlankText(actress.avatar_path) && inspectImageAsset(actress.avatar_path).usable
}

function actressDisplayAvatarFingerprint(
  actress: Pick<ActressListItem, 'avatar_path'>
): string | null {
  return inspectImageAsset(actress.avatar_path).fingerprint
}

function enrichActressListItems(actresses: ActressListItem[]): ActressListItem[] {
  return actresses.map((actress) => ({
    ...actress,
    avatar_fingerprint: actressDisplayAvatarFingerprint(actress)
  }))
}

function filterActressAvatars(
  actresses: ActressListItem[],
  avatar: ActressAvatarFilter
): ActressListItem[] {
  if (avatar === 'all') return actresses
  if (avatar === 'without-face') return []
  const wantsAvatar = avatar === 'with'
  return actresses.filter((actress) => actressHasUsableAvatar(actress) === wantsAvatar)
}

function queryActressListRows(
  search?: string,
  gender: ActressGenderFilter = 'female',
  sortBy: ActressListSortBy = 'video_count',
  sortDir: ListSortDir = 'desc',
  status: ActressListStatusFilter = 'all',
  limit?: number,
  offset = 0,
  actressIds?: number[]
): ActressListItem[] {
  const db = getDb()
  const { sql: where, params } = buildActressListWhere(search, gender, status, actressIds)
  const orderBy = buildActressListOrderBy(sortBy, sortDir)
  const pagination = limit == null ? '' : 'LIMIT ? OFFSET ?'
  const queryParams = limit == null ? params : [...params, limit, offset]
  return db
    .prepare(
      `SELECT a.*,
              COUNT(va.video_id) AS video_count,
              (SELECT COUNT(*) FROM actress_gallery_assets ag WHERE ag.actress_id = a.id) AS gallery_count
       FROM actresses a
       LEFT JOIN video_actress va ON va.actress_id = a.id
       ${where}
       GROUP BY a.id
       ORDER BY ${orderBy}
       ${pagination}`
    )
    .all(...queryParams) as ActressListItem[]
}

/** Minimal full-library input for renderer-session avatar face detection. */
export function listActressFaceScanManifest(): ActressFaceScanManifestItem[] {
  const rows = getDb()
    .prepare(
      `SELECT id, main_name, avatar_path
       FROM actresses
       WHERE avatar_path IS NOT NULL AND trim(avatar_path) != ''
       ORDER BY id ASC`
    )
    .all() as Array<{ id: number; main_name: string; avatar_path: string }>

  const manifest: ActressFaceScanManifestItem[] = []
  for (const row of rows) {
    const inspection = inspectImageAsset(row.avatar_path)
    if (!inspection.usable || !inspection.fingerprint) continue
    manifest.push({
      id: row.id,
      main_name: row.main_name,
      avatar_path: row.avatar_path,
      avatar_fingerprint: inspection.fingerprint
    })
  }
  return manifest
}

export function listActresses(
  search?: string,
  gender: ActressGenderFilter = 'female',
  sortBy: ActressListSortBy = 'video_count',
  sortDir: ListSortDir = 'desc',
  status: ActressListStatusFilter = 'all',
  avatar: ActressAvatarFilter = 'all'
): ActressListItem[] {
  return filterActressAvatars(
    queryActressListRows(search, gender, sortBy, sortDir, status),
    avatar
  )
}

function buildActressListOrderBy(sortBy: ActressListSortBy, sortDir: ListSortDir): string {
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC'
  const tie = 'a.main_name ASC, a.id ASC'
  switch (sortBy) {
    case 'gallery':
      return `gallery_count ${dir}, ${tie}`
    case 'age':
      if (sortDir === 'asc') {
        return `(a.birth_date IS NULL OR trim(a.birth_date) = ''), a.birth_date DESC, ${tie}`
      }
      return `(a.birth_date IS NULL OR trim(a.birth_date) = ''), a.birth_date ASC, ${tie}`
    case 'cup_size': {
      const cupLetter = "UPPER(SUBSTR(TRIM(a.cup_size), 1, 1))"
      return `(a.cup_size IS NULL OR trim(a.cup_size) = ''), ${cupLetter} ${dir}, ${tie}`
    }
    case 'video_count':
    default:
      return `video_count ${dir}, ${tie}`
  }
}

/** Actresses per cumulative status, scoped by search and gender but not by the status filter. */
function countActressListStatuses(
  search: string | undefined,
  gender: ActressGenderFilter,
  actressIds?: number[]
): ActressListStatusCounts {
  const db = getDb()
  const { sql: where, params } = buildActressListWhere(search, gender, 'all', actressIds)
  const rows = db
    .prepare(
      `SELECT a.scraped_status AS status, COUNT(*) AS n
       FROM actresses a
       ${where}
       GROUP BY a.scraped_status`
    )
    .all(...params) as Array<{ status: ScrapedStatus; n: number }>

  const counts: ActressListStatusCounts = { all: 0, success: 0, unscraped: 0, failed: 0 }
  for (const row of rows) {
    counts[actressStatusFilterOf(row.status)] += row.n
    counts.all += row.n
  }
  return counts
}

function countActressListRows(
  search: string | undefined,
  gender: ActressGenderFilter,
  status: ActressListStatusFilter,
  actressIds?: number[]
): number {
  const db = getDb()
  const { sql: where, params } = buildActressListWhere(search, gender, status, actressIds)
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM actresses a ${where}`)
    .get(...params) as { n: number }
  return row.n
}

/** Actress list read contract: filtered rows plus the status counts the toolbar shows. */
export function listActressPage(query: ActressListQuery = {}): ActressListPage {
  const gender = query.gender ?? 'female'
  const status = query.status ?? 'all'
  const requestedAvatar = query.avatar ?? 'all'
  // Local face results are renderer-session state. The main process only pages
  // the explicit classified ID subset and never infers "without-face" itself.
  const avatar = requestedAvatar === 'without-face' ? 'all' : requestedAvatar
  const actressIds = requestedAvatar === 'without-face'
    ? query.actressIds ?? []
    : query.actressIds
  const offset = Math.max(0, Math.trunc(query.offset ?? 0))
  const limit = query.limit == null
    ? undefined
    : Math.max(1, Math.min(1000, Math.trunc(query.limit)))

  let actresses: ActressListItem[]
  let total: number
  if (avatar === 'all') {
    actresses = queryActressListRows(
      query.search,
      gender,
      query.sortBy,
      query.sortDir,
      status,
      limit,
      offset,
      actressIds
    )
    total = countActressListRows(query.search, gender, status, actressIds)
  } else {
    const filtered = filterActressAvatars(
      queryActressListRows(
        query.search,
        gender,
        query.sortBy,
        query.sortDir,
        status,
        undefined,
        0,
        actressIds
      ),
      avatar
    )
    total = filtered.length
    actresses = limit == null
      ? filtered
      : filtered.slice(offset, offset + limit)
  }
  return {
    // Fingerprints are only needed when the renderer may run or apply the
    // local face filter. Avoid probing every avatar for ordinary list views.
    items: requestedAvatar === 'with'
      ? enrichActressListItems(actresses)
      : actresses,
    total,
    statusCounts: countActressListStatuses(query.search, gender, actressIds)
  }
}

/** Fill missing width/height for gallery assets by probing stored local files. */
export function backfillActressGalleryAssetDimensions(
  database?: SqliteDatabase,
  actressId?: number
): number {
  const db = database ?? getDb()
  const params: unknown[] = []
  let actressFilter = ''
  if (actressId != null) {
    actressFilter = 'AND actress_id = ?'
    params.push(actressId)
  }

  const rows = db
    .prepare(
      `SELECT id, local_path FROM actress_gallery_assets
       WHERE local_path IS NOT NULL AND trim(local_path) != ''
         AND (width IS NULL OR height IS NULL OR width <= 0 OR height <= 0)
         ${actressFilter}`
    )
    .all(...params) as Array<{ id: number; local_path: string }>

  if (!rows.length) return 0

  const update = db.prepare(
    'UPDATE actress_gallery_assets SET width = ?, height = ? WHERE id = ?'
  )
  let updated = 0
  for (const row of rows) {
    const dims = readImageDimensionsFromRelPath(row.local_path)
    if (!dims) continue
    update.run(dims.width, dims.height, row.id)
    updated += 1
  }
  return updated
}

export function getActressDetail(id: number): ActressDetail | null {
  backfillActressGalleryAssetDimensions(undefined, id)
  const db = getDb()
  const actress = db.prepare('SELECT * FROM actresses WHERE id = ?').get(id) as
    | Actress
    | undefined
  if (!actress) return null

  const names = listActressNameRows(id)

  const gallery = db
    .prepare(
      `SELECT * FROM actress_gallery_assets
       WHERE actress_id = ?
       ORDER BY position, id`
    )
    .all(id) as ActressDetail['gallery']

  const videos = db
    .prepare(
      `SELECT v.* FROM videos v
       JOIN video_actress va ON va.video_id = v.id
       WHERE va.actress_id = ?
       ORDER BY v.release_date DESC, v.add_time DESC`
    )
    .all(id) as Video[]

  return {
    ...actress,
    name_zh: getActressTypedName(id, 'zh', names),
    name_en: getActressTypedName(id, 'en', names),
    aliases: listActressAliasNames(id, names),
    names,
    gallery,
    videos
  }
}

export function addActressGalleryAsset(
  actressId: number,
  input: ActressGalleryAssetWriteInput
): ActressGalleryAsset {
  if (!input.remoteUrl && !input.localPath) throw new Error('写真来源不能为空')
  const db = getDb()
  const position = (
    db
      .prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS n FROM actress_gallery_assets WHERE actress_id = ?'
      )
      .get(actressId) as { n: number }
  ).n
  const createdAt = nowIso()
  const info = db
    .prepare(
      `INSERT INTO actress_gallery_assets
         (actress_id, type, position, remote_url, local_path, width, height, created_at)
       VALUES (@actressId, 'gallery', @position, @remoteUrl, @localPath, @width, @height, @createdAt)`
    )
    .run({
      actressId,
      position,
      remoteUrl: input.remoteUrl ?? null,
      localPath: input.localPath ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      createdAt
    })
  return db
    .prepare('SELECT * FROM actress_gallery_assets WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as ActressGalleryAsset
}

export function replaceActressGalleryAssets(
  actressId: number,
  assets: ActressGalleryAssetWriteInput[]
): void {
  const db = getDb()
  const obsoleteLocalPaths = db.transaction(() =>
    replaceActressGalleryAssetRows(actressId, assets)
  )()
  deleteObsoleteActressGalleryAssets(obsoleteLocalPaths)
}

function replaceActressGalleryAssetRows(
  actressId: number,
  assets: ActressGalleryAssetWriteInput[]
): string[] {
  const db = getDb()
  const existing = db
    .prepare('SELECT local_path FROM actress_gallery_assets WHERE actress_id = ?')
    .all(actressId) as { local_path: string | null }[]
  const createdAt = nowIso()

  clearActressPosterForPaths(
    actressId,
    existing.map((row) => row.local_path)
  )
  db.prepare('DELETE FROM actress_gallery_assets WHERE actress_id = ?').run(actressId)
  const insert = db.prepare(
    `INSERT INTO actress_gallery_assets
       (actress_id, type, position, remote_url, local_path, width, height, created_at)
     VALUES (@actressId, 'gallery', @position, @remoteUrl, @localPath, @width, @height, @createdAt)`
  )
  assets.forEach((asset, position) => {
    if (!asset.remoteUrl && !asset.localPath) return
    insert.run({
      actressId,
      position,
      remoteUrl: asset.remoteUrl ?? null,
      localPath: asset.localPath ?? null,
      width: asset.width ?? null,
      height: asset.height ?? null,
      createdAt
    })
  })

  const retainedLocalPaths = new Set(
    assets.map((asset) => asset.localPath).filter((localPath): localPath is string => !!localPath)
  )
  return existing
    .map((row) => row.local_path)
    .filter(
      (localPath): localPath is string =>
        Boolean(localPath) && !retainedLocalPaths.has(localPath as string)
    )
}

function deleteObsoleteActressGalleryAssets(localPaths: string[]): void {
  for (const localPath of localPaths) deleteAsset(localPath)
}

export function deleteActressGalleryAsset(actressId: number, assetId: number): string | null {
  const db = getDb()
  const asset = db
    .prepare('SELECT local_path FROM actress_gallery_assets WHERE id = ? AND actress_id = ?')
    .get(assetId, actressId) as { local_path: string | null } | undefined
  if (!asset) throw new Error('写真不存在')
  clearActressPosterForPaths(actressId, [asset.local_path])
  db.prepare('DELETE FROM actress_gallery_assets WHERE id = ? AND actress_id = ?').run(
    assetId,
    actressId
  )
  return asset.local_path
}

export function setActressPosterPath(id: number, posterPath: string | null): void {
  const db = getDb()
  const normalized = posterPath?.trim() || null
  if (normalized) {
    const row = db
      .prepare(
        "SELECT 1 FROM actress_gallery_assets WHERE actress_id = ? AND type = 'gallery' AND local_path = ?"
      )
      .get(id, normalized)
    if (!row) throw new Error('海报必须来自当前演员的本地写真')
  }
  db.prepare('UPDATE actresses SET poster_path = ?, updated_at = ? WHERE id = ?').run(
    normalized,
    nowIso(),
    id
  )
}

/** Merge mergeId into keepId as one database transaction. */
export function mergeActresses(
  keepId: number,
  mergeId: number,
  mainNameFrom: ActressMergeMainNameFrom = 'keep',
  options?: { deferFileCleanup?: boolean }
): { fileChanges?: { obsoletePaths: string[] } } {
  if (keepId === mergeId) throw new Error('不能合并同一演员')

  const db = getDb()
  const cleanup = db.transaction(() => {
    const keep = db.prepare('SELECT * FROM actresses WHERE id = ?').get(keepId) as
      | Actress
      | undefined
    const merge = db.prepare('SELECT * FROM actresses WHERE id = ?').get(mergeId) as
      | Actress
      | undefined
    if (!keep || !merge) throw new Error('演员不存在')
    if (!canMergeActressGenders(keep.gender, merge.gender)) {
      throw new Error('不能合并不同性别的演员')
    }

    const finalMain = mainNameFrom === 'keep' ? keep.main_name : merge.main_name
    const keepNameRows = listActressNameRows(keepId)
    const mergeNameRows = listActressNameRows(mergeId)
    const allNameRows = [...keepNameRows, ...mergeNameRows]
    const aliases = dedupeActressAliases(
      [
        ...listActressAliasNames(keepId, keepNameRows),
        ...listActressAliasNames(mergeId, mergeNameRows),
        ...(keep.main_name === finalMain ? [] : [keep.main_name]),
        ...(merge.main_name === finalMain ? [] : [merge.main_name])
      ],
      finalMain
    )
    const typedNameRows = allNameRows.filter(
      (row) => row.type !== ACTRESS_NAME_TYPE.MAIN && row.type !== ACTRESS_NAME_TYPE.ALIAS
    )
    validateAndReleaseActressNameOwnershipForMerge(
      [finalMain, ...aliases, ...typedNameRows.map((row) => row.name)],
      [keepId, mergeId]
    )

    const avatarOwner = isUsableImageAsset(keep.avatar_path)
      ? keep
      : isUsableImageAsset(merge.avatar_path)
        ? merge
        : null
    const avatarPath = avatarOwner?.avatar_path ?? null
    const avatarSourcePath =
      avatarOwner && isUsableImageAsset(avatarOwner.avatar_source_path)
        ? avatarOwner.avatar_source_path
        : null
    const avatarCropJson =
      avatarOwner?.avatar_crop_json &&
      avatarSourcePath &&
      parseAvatarCrop(
        avatarOwner.avatar_crop_json,
        avatarSourceFingerprint(readAssetBytes(avatarSourcePath))
      )
        ? avatarOwner.avatar_crop_json
        : null
    const mergedScrapeRecord = mergeActressScrapeRecords(keep, merge)

    db.prepare(
      `INSERT OR IGNORE INTO video_actress (video_id, actress_id)
       SELECT video_id, ? FROM video_actress WHERE actress_id = ?`
    ).run(keepId, mergeId)
    db.prepare('DELETE FROM video_actress WHERE actress_id = ?').run(mergeId)

    const maxPos = (
      db
        .prepare(
          'SELECT COALESCE(MAX(position), -1) AS n FROM actress_gallery_assets WHERE actress_id = ?'
        )
        .get(keepId) as { n: number }
    ).n
    db.prepare(
      `UPDATE actress_gallery_assets
       SET actress_id = ?, position = position + ?
       WHERE actress_id = ?`
    ).run(keepId, maxPos + 1, mergeId)

    if (isBlankText(keep.poster_path) && !isBlankText(merge.poster_path)) {
      const posterStillValid = db
        .prepare(
          'SELECT 1 FROM actress_gallery_assets WHERE actress_id = ? AND local_path = ?'
        )
        .get(keepId, merge.poster_path)
      if (posterStillValid) {
        db.prepare('UPDATE actresses SET poster_path = ? WHERE id = ?').run(
          merge.poster_path,
          keepId
        )
      }
    }

    db.prepare(
      `INSERT OR IGNORE INTO actress_tag (actress_id, tag_id)
       SELECT ?, tag_id FROM actress_tag WHERE actress_id = ?`
    ).run(keepId, mergeId)

    db.prepare('DELETE FROM actress_names WHERE actress_id = ?').run(keepId)
    removeMergedActressRecord(mergeId)

    db.prepare(
      `UPDATE actresses SET
         main_name = @main_name,
         birth_date = COALESCE(NULLIF(trim(birth_date), ''), NULLIF(trim(@birth_date), '')),
         debut_date = COALESCE(NULLIF(trim(debut_date), ''), NULLIF(trim(@debut_date), '')),
         height_cm = COALESCE(height_cm, @height_cm),
         bust_cm = COALESCE(bust_cm, @bust_cm),
         waist_cm = COALESCE(waist_cm, @waist_cm),
         hip_cm = COALESCE(hip_cm, @hip_cm),
         cup_size = COALESCE(NULLIF(trim(cup_size), ''), NULLIF(trim(@cup_size), '')),
         blood_type = COALESCE(NULLIF(trim(blood_type), ''), NULLIF(trim(@blood_type), '')),
         zodiac = COALESCE(NULLIF(trim(zodiac), ''), NULLIF(trim(@zodiac), '')),
         nationality = COALESCE(NULLIF(trim(nationality), ''), NULLIF(trim(@nationality), '')),
         profile_summary = COALESCE(NULLIF(trim(profile_summary), ''), NULLIF(trim(@profile_summary), '')),
         avatar_path = @avatar_path,
         avatar_source_path = @avatar_source_path,
         avatar_crop_json = @avatar_crop_json,
         gender = COALESCE(gender, @gender),
         scraped_status = @scraped_status,
         last_scraped_at = @last_scraped_at,
         updated_at = @updated_at
       WHERE id = @keepId`
    ).run({
      keepId,
      main_name: finalMain,
      birth_date: merge.birth_date,
      debut_date: merge.debut_date,
      height_cm: merge.height_cm,
      bust_cm: merge.bust_cm,
      waist_cm: merge.waist_cm,
      hip_cm: merge.hip_cm,
      cup_size: merge.cup_size,
      blood_type: merge.blood_type,
      zodiac: merge.zodiac,
      nationality: merge.nationality,
      profile_summary: merge.profile_summary,
      avatar_path: avatarPath,
      avatar_source_path: avatarSourcePath,
      avatar_crop_json: avatarCropJson,
      gender: merge.gender,
      scraped_status: mergedScrapeRecord.scrapedStatus,
      last_scraped_at: mergedScrapeRecord.lastScrapedAt,
      updated_at: nowIso()
    })

    upsertActressName(keepId, finalMain, ACTRESS_NAME_TYPE.MAIN, null, null, 1)
    const insertTypedName = db.prepare(
      `INSERT OR IGNORE INTO actress_names
         (actress_id, name, type, locale, source, is_primary)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const row of typedNameRows) {
      insertTypedName.run(keepId, row.name, row.type, row.locale, row.source, row.is_primary)
    }
    replacePreparedActressAliases(keepId, aliases)
    synchronizeActressNameOwnership(keepId)

    const keptAvatar = db
      .prepare('SELECT avatar_path, avatar_source_path FROM actresses WHERE id = ?')
      .get(keepId) as { avatar_path: string | null; avatar_source_path: string | null }
    const retainedAvatarPaths = new Set(
      [keptAvatar.avatar_path, keptAvatar.avatar_source_path].filter(
        (assetPath): assetPath is string => Boolean(assetPath)
      )
    )
    const obsoleteAvatarPaths = Array.from(
      new Set([
        keep.avatar_path,
        keep.avatar_source_path,
        merge.avatar_path,
        merge.avatar_source_path
      ])
    ).filter(
      (assetPath): assetPath is string =>
        Boolean(assetPath) && !retainedAvatarPaths.has(assetPath as string)
    )
    return {
      obsoleteAvatarPaths
    }
  })()

  if (!options?.deferFileCleanup) {
    for (const assetPath of cleanup.obsoleteAvatarPaths) deleteAsset(assetPath)
  }
  return options?.deferFileCleanup
    ? { fileChanges: { obsoletePaths: cleanup.obsoleteAvatarPaths } }
    : {}
}

/** Cumulative history is strongest for a success, then a failure, and weakest when never scraped. */
const ACTRESS_SCRAPE_STATUS_STRENGTH: Record<ScrapedStatus, number> = { 0: 0, 2: 1, 1: 2 }

type ActressScrapeRecord = Pick<Actress, 'scraped_status' | 'last_scraped_at'>

/** Combine two cumulative histories: the strongest state wins, and only successes contribute a time. */
function mergeActressScrapeRecords(
  keep: ActressScrapeRecord,
  merge: ActressScrapeRecord
): { scrapedStatus: ScrapedStatus; lastScrapedAt: string | null } {
  const scrapedStatus =
    ACTRESS_SCRAPE_STATUS_STRENGTH[merge.scraped_status] >
    ACTRESS_SCRAPE_STATUS_STRENGTH[keep.scraped_status]
      ? merge.scraped_status
      : keep.scraped_status
  const [newestSuccessTime] = [keep, merge]
    .filter((record) => record.scraped_status === 1)
    .map((record) => record.last_scraped_at)
    .filter((time): time is string => !isBlankText(time))
    .sort((a, b) => (a > b ? -1 : 1))
  return { scrapedStatus, lastScrapedAt: newestSuccessTime ?? null }
}

/**
 * Clear scraped actress metadata while keeping main name, gender, and video links.
 * Removes avatar, gallery, poster, profile fields, and non-main name rows.
 */
export function clearActressMetadataRecord(id: number): void {
  const db = getDb()
  const actress = db
    .prepare('SELECT avatar_path, avatar_source_path FROM actresses WHERE id = ?')
    .get(id) as { avatar_path: string | null; avatar_source_path: string | null } | undefined
  if (!actress) throw new Error('演员不存在')

  let galleryPaths: Array<string | null> = []
  const txn = db.transaction(() => {
    galleryPaths = deleteActressGalleryAssetRows(id)
    db.prepare(
      `UPDATE actresses SET
         birth_date = NULL, debut_date = NULL, height_cm = NULL,
         bust_cm = NULL, waist_cm = NULL, hip_cm = NULL, cup_size = NULL,
         blood_type = NULL, zodiac = NULL, nationality = NULL,
         profile_summary = NULL, avatar_path = NULL, avatar_source_path = NULL,
         avatar_crop_json = NULL, poster_path = NULL,
         scraped_status = 0, last_scraped_at = NULL, updated_at = ?
       WHERE id = ?`
    ).run(nowIso(), id)
    db.prepare("DELETE FROM actress_names WHERE actress_id = ? AND type != 'main'").run(id)
    synchronizeActressNameOwnership(id)
  })
  txn()
  for (const galleryPath of galleryPaths) deleteAsset(galleryPath)
  deleteAsset(actress.avatar_path)
  deleteAsset(actress.avatar_source_path)
}

/** Delete an actress that has no linked videos. Removes aliases and avatar. */
export function deleteActress(id: number): void {
  deleteUnlinkedActresses([id])
}

export interface DeletedActressRecords {
  deletedCount: number
  unlinkedVideoCount: number
  assetPaths: string[]
}

function normalizeActressDeleteIds(ids: number[]): number[] {
  return Array.from(
    new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))
  )
}

function inspectActressDeleteImpact(ids: number[]): ActressDeleteImpact {
  const db = getDb()
  const uniqueIds = normalizeActressDeleteIds(ids)
  if (uniqueIds.length === 0) {
    return { actressCount: 0, linkedActressCount: 0, affectedVideoCount: 0 }
  }

  const payload = JSON.stringify(uniqueIds)
  const actressCount = (
    db.prepare(
      'SELECT COUNT(*) AS n FROM actresses WHERE id IN (SELECT value FROM json_each(?))'
    ).get(payload) as { n: number }
  ).n
  if (actressCount !== uniqueIds.length) {
    throw new Error('选中的演员不存在，请刷新列表后重试')
  }
  const links = db.prepare(
    `SELECT COUNT(DISTINCT actress_id) AS linkedActressCount,
            COUNT(DISTINCT video_id) AS affectedVideoCount
     FROM video_actress
     WHERE actress_id IN (SELECT value FROM json_each(?))`
  ).get(payload) as { linkedActressCount: number; affectedVideoCount: number }
  return { actressCount, ...links }
}

/** Current database impact shown before an actress delete is confirmed. */
export function previewActressDelete(ids: number[]): ActressDeleteImpact {
  return getDb().transaction(() => inspectActressDeleteImpact(ids))()
}

/** Atomically apply the selected delete mode and return only actress-owned resources. */
export function deleteActressRecords(
  ids: number[],
  mode: ActressDeleteMode
): DeletedActressRecords {
  if (mode !== 'only-unlinked' && mode !== 'unlink-videos-and-delete') {
    throw new Error('不支持的演员删除模式')
  }
  const db = getDb()
  const uniqueIds = normalizeActressDeleteIds(ids)
  if (uniqueIds.length === 0) {
    return { deletedCount: 0, unlinkedVideoCount: 0, assetPaths: [] }
  }

  const result = db.transaction(() => {
    const impact = inspectActressDeleteImpact(uniqueIds)
    const findActress = db.prepare(
      'SELECT avatar_path, avatar_source_path FROM actresses WHERE id = ?'
    )
    const listGallery = db.prepare(
      'SELECT local_path FROM actress_gallery_assets WHERE actress_id = ?'
    )
    const listPendingResources = db.prepare(
      `SELECT r.staged_path
       FROM pending_actress_scrape_resources r
       JOIN pending_actress_scrapes p ON p.id = r.pending_scrape_id
       WHERE p.actress_id = ?`
    )
    const removeLinks = db.prepare('DELETE FROM video_actress WHERE actress_id = ?')
    const removeActress = db.prepare('DELETE FROM actresses WHERE id = ?')
    const paths: Array<string | null> = []

    for (const id of uniqueIds) {
      const actress = findActress.get(id) as
        | { avatar_path: string | null; avatar_source_path: string | null }
        | undefined
      if (!actress) throw new Error('选中的演员不存在，请刷新列表后重试')
      paths.push(actress.avatar_path, actress.avatar_source_path)
      const gallery = listGallery.all(id) as { local_path: string | null }[]
      paths.push(...gallery.map((item) => item.local_path))
      const pendingResources = listPendingResources.all(id) as Array<{ staged_path: string }>
      paths.push(...pendingResources.map((item) => item.staged_path))
    }

    if (mode === 'only-unlinked' && impact.linkedActressCount > 0) {
      throw new Error(`${impact.linkedActressCount} 位演员仍有关联影片，整批未删除`)
    }
    for (const id of uniqueIds) {
      if (mode === 'unlink-videos-and-delete') removeLinks.run(id)
      removeActress.run(id)
    }
    return { paths, impact }
  })()

  return {
    deletedCount: uniqueIds.length,
    unlinkedVideoCount:
      mode === 'unlink-videos-and-delete' ? result.impact.affectedVideoCount : 0,
    assetPaths: Array.from(
      new Set(result.paths.filter((assetPath): assetPath is string => Boolean(assetPath?.trim())))
    )
  }
}

/** Safe compatibility wrapper for callers that only permit unlinked actresses. */
export function deleteUnlinkedActressRecords(ids: number[]): DeletedActressRecords {
  return deleteActressRecords(ids, 'only-unlinked')
}

/** Atomically delete actress records only when every selected actress has no linked videos. */
export function deleteUnlinkedActresses(ids: number[]): number {
  const result = deleteUnlinkedActressRecords(ids)
  for (const assetPath of result.assetPaths) deleteAsset(assetPath)
  return result.deletedCount
}

function assertActressNameAvailable(name: string, exceptId: number): void {
  if (!isActressNameAvailable(name, exceptId)) {
    throw new Error(`名称「${name}」已被其他演员使用`)
  }
}

function dedupeActressAliases(aliases: string[], mainName: string): string[] {
  const prepared: string[] = []
  const seen = new Set<string>()
  const mainKey = normalizeActressNameKey(mainName)
  for (const alias of aliases) {
    const trimmed = alias.trim()
    if (!trimmed) continue
    const key = normalizeActressNameKey(trimmed)
    if (key === mainKey || seen.has(key)) continue
    seen.add(key)
    prepared.push(trimmed)
  }
  return prepared
}

function prepareActressAliases(aliases: string[], mainName: string): string[] {
  return dedupeActressAliases(aliases, mainName).filter(isValidActressAlias)
}

function replaceActressAliases(
  actressId: number,
  aliases: string[],
  mainName: string
): void {
  replacePreparedActressAliases(actressId, prepareActressAliases(aliases, mainName))
}

function replacePreparedActressAliases(actressId: number, aliases: string[]): void {
  const db = getDb()
  db.prepare("DELETE FROM actress_names WHERE actress_id = ? AND type = 'alias'").run(actressId)

  for (const alias of aliases) {
    if (!isActressNameAvailable(alias, actressId)) {
      throw new Error(`名称「${alias}」已被其他演员使用`)
    }
    upsertActressName(actressId, alias, ACTRESS_NAME_TYPE.ALIAS, null, null, 0)
  }
}

/** Manually edit actress profile fields. Aliases fully replace when supplied. */
export function editActress(id: number, input: ActressEditInput): void {
  const db = getDb()
  const actress = db
    .prepare('SELECT main_name, avatar_path, avatar_source_path FROM actresses WHERE id = ?')
    .get(id) as
    | { main_name: string; avatar_path: string | null; avatar_source_path: string | null }
    | undefined
  if (!actress) throw new Error('演员不存在')

  const txn = db.transaction(() => {
    const assignments: string[] = []
    const bind: Record<string, unknown> = { id }

    if ('main_name' in input && input.main_name !== undefined) {
      const name = input.main_name.trim()
      if (!name) throw new Error('演员名称不能为空')
      assertActressNameAvailable(name, id)
      assignments.push('main_name = @main_name')
      bind.main_name = name
      upsertActressName(id, name, 'main', null, null, 1)
    }
    if ('gender' in input) {
      assignments.push('gender = @gender')
      bind.gender = input.gender ?? null
    }
    if ('birth_date' in input) {
      assignments.push('birth_date = @birth_date')
      bind.birth_date = input.birth_date?.trim() || null
    }
    for (const key of [
      'debut_date',
      'height_cm',
      'bust_cm',
      'waist_cm',
      'hip_cm',
      'cup_size',
      'blood_type',
      'zodiac',
      'nationality',
      'profile_summary'
    ] as const) {
      if (key in input) {
        assignments.push(`${key} = @${key}`)
        if (key === 'cup_size') {
          bind[key] = normalizeCupSize(typeof input[key] === 'string' ? input[key] : null)
        } else {
          bind[key] =
            typeof input[key] === 'string' ? input[key]?.trim() || null : input[key] ?? null
        }
      }
    }
    assignments.push('updated_at = @updated_at')
    bind.updated_at = nowIso()
    if (assignments.length) {
      db.prepare(`UPDATE actresses SET ${assignments.join(', ')} WHERE id = @id`).run(bind)
    }

    const mainName =
      ('main_name' in input && input.main_name?.trim()) || actress.main_name
    if ('name_zh' in input) {
      const zh = input.name_zh?.trim() || null
      if (zh) assertActressNameAvailable(zh, id)
      setActressTypedName(id, 'zh', zh)
    }
    if ('name_en' in input) {
      const en = input.name_en?.trim() || null
      if (en) assertActressNameAvailable(en, id)
      setActressTypedName(id, 'en', en)
    }
    if (input.aliases) replaceActressAliases(id, input.aliases, mainName)

    if (
      'main_name' in input ||
      'name_zh' in input ||
      'name_en' in input ||
      'aliases' in input
    ) {
      synchronizeActressNameOwnership(id)
    }

    if (input.clearAvatar) {
      clearActressAvatarBundle(id)
    } else if (input.avatar) {
      setActressAvatarBundle(id, mainName, input.avatar)
    } else if (input.avatarImageBase64) {
      const bytes = Buffer.from(input.avatarImageBase64, 'base64')
      if (!readImageDimensionsFromBuffer(bytes)) throw new Error('头像图片无效')
      const source = importAvatarSourceFromBuffer(mainName, id, bytes, '.jpg')
      const displayPath = importAvatarDisplayFromBuffer(mainName, id, bytes)
      const cropJson = JSON.stringify(
        createAvatarCropV1({
          sourceFingerprint: source.fingerprint,
          zoom: 1,
          offsetX: 0,
          offsetY: 0
        })
      )
      const oldDisplay = actress.avatar_path
      const oldSource = actress.avatar_source_path
      db.prepare(
        `UPDATE actresses SET
           avatar_path = ?,
           avatar_source_path = ?,
           avatar_crop_json = ?,
           updated_at = ?
         WHERE id = ?`
      ).run(displayPath, source.relPath, cropJson, nowIso(), id)
      if (oldDisplay && oldDisplay !== displayPath) deleteAsset(oldDisplay)
      if (oldSource && oldSource !== source.relPath) deleteAsset(oldSource)
    } else if (input.avatarSourcePath) {
      const imported = importAvatarFromFile(mainName, input.avatarSourcePath, id)
      const bytes = readAssetBytes(imported)
      if (!readImageDimensionsFromBuffer(bytes)) throw new Error('头像图片无效')
      const source = importAvatarSourceFromBuffer(
        mainName,
        id,
        bytes,
        path.extname(imported).toLowerCase() || '.jpg'
      )
      const displayPath = importAvatarDisplayFromBuffer(mainName, id, bytes)
      const cropJson = JSON.stringify(
        createAvatarCropV1({
          sourceFingerprint: source.fingerprint,
          zoom: 1,
          offsetX: 0,
          offsetY: 0
        })
      )
      const oldDisplay = actress.avatar_path
      const oldSource = actress.avatar_source_path
      db.prepare(
        `UPDATE actresses SET
           avatar_path = ?,
           avatar_source_path = ?,
           avatar_crop_json = ?,
           updated_at = ?
         WHERE id = ?`
      ).run(displayPath, source.relPath, cropJson, nowIso(), id)
      if (oldDisplay && oldDisplay !== displayPath) deleteAsset(oldDisplay)
      if (oldSource && oldSource !== source.relPath) deleteAsset(oldSource)
      if (imported !== displayPath && imported !== source.relPath) deleteAsset(imported)
    }
  })
  txn()
}

function isBlankText(value: string | null | undefined): boolean {
  return value == null || value.trim() === ''
}

function countActressAliases(actressId: number): number {
  const db = getDb()
  return (
    db.prepare(
      "SELECT COUNT(*) AS n FROM actress_names WHERE actress_id = ? AND type = 'alias'"
    ).get(actressId) as {
      n: number
    }
  ).n
}

function countActressGalleryAssets(actressId: number): number {
  const db = getDb()
  return (
    db.prepare('SELECT COUNT(*) AS n FROM actress_gallery_assets WHERE actress_id = ?').get(
      actressId
    ) as { n: number }
  ).n
}

function isActressFieldEmptyForFill(
  actress: Actress,
  field: ActressScrapeField,
  aliasCount: number,
  galleryCount: number,
  names: ReturnType<typeof listActressNameRows>
): boolean {
  switch (field) {
    case 'avatar':
      return isBlankText(actress.avatar_path) || !isUsableImageAsset(actress.avatar_path)
    case 'gallery':
      return galleryCount === 0
    case 'birthDate':
      return isBlankText(actress.birth_date)
    case 'nameZh':
      return isBlankText(getActressTypedName(actress.id, 'zh', names))
    case 'nameEn':
      return isBlankText(getActressTypedName(actress.id, 'en', names))
    case 'debutDate':
      return isBlankText(actress.debut_date)
    case 'heightCm':
      return actress.height_cm == null
    case 'measurements':
      return actress.bust_cm == null || actress.waist_cm == null || actress.hip_cm == null
    case 'cupSize':
      return isBlankText(actress.cup_size)
    case 'bloodType':
      return isBlankText(actress.blood_type)
    case 'zodiac':
      return isBlankText(actress.zodiac)
    case 'nationality':
      return isBlankText(actress.nationality)
    case 'profileSummary':
      return isBlankText(actress.profile_summary)
    case 'aliases':
      return aliasCount === 0
    default:
      return false
  }
}

export function resolveEffectiveActressScrapeFields(
  actressId: number,
  fields: ActressScrapeField[],
  mode: ActressScrapeUpdateMode = 'replace'
): ActressScrapeField[] {
  if (mode !== 'fillEmpty') return fields
  const db = getDb()
  const actress = db.prepare('SELECT * FROM actresses WHERE id = ?').get(actressId) as
    | Actress
    | undefined
  if (!actress) return []
  const aliasCount = countActressAliases(actressId)
  const galleryCount = countActressGalleryAssets(actressId)
  const names = listActressNameRows(actressId)
  return fields.filter((field) =>
    isActressFieldEmptyForFill(actress, field, aliasCount, galleryCount, names)
  )
}

/** Record a failed scrape without degrading actresses that have succeeded before. */
export function recordActressScrapeFailure(actressId: number): void {
  const db = getDb()
  db.prepare(
    `UPDATE actresses
     SET scraped_status = CASE WHEN scraped_status = 1 THEN 1 ELSE 2 END,
         updated_at = ?
     WHERE id = ?`
  ).run(nowIso(), actressId)
}

/** Manually confirm a scrape succeeded. An earlier success time is kept, a missing one is stamped. */
export function markActressScrapeSucceeded(actressId: number): void {
  const db = getDb()
  const scrapedAt = nowIso()
  const result = db
    .prepare(
      `UPDATE actresses
       SET scraped_status = 1,
           last_scraped_at = COALESCE(NULLIF(trim(last_scraped_at), ''), @scrapedAt),
           updated_at = @scrapedAt
       WHERE id = @actressId`
    )
    .run({ actressId, scrapedAt })
  if (result.changes === 0) throw new Error('演员不存在')
}

function hasValidActressScrapeValue(
  result: ActressScrapeResult,
  field: ActressScrapeField,
  avatarApplied: boolean,
  galleryAssets: ActressGalleryAssetWriteInput[],
  applicableAliases: string[],
  mode: ActressScrapeUpdateMode,
  actress: Pick<Actress, 'bust_cm' | 'waist_cm' | 'hip_cm'>
): boolean {
  switch (field) {
    case 'avatar':
      return avatarApplied
    case 'gallery':
      return galleryAssets.some(
        (asset) => Boolean(asset.remoteUrl?.trim()) || Boolean(asset.localPath?.trim())
      )
    case 'birthDate':
      return Boolean(result.birthDate?.trim())
    case 'nameZh':
      return Boolean(result.nameZh?.trim())
    case 'nameEn':
      return Boolean(result.nameEn?.trim())
    case 'debutDate':
      return Boolean(result.debutDate?.trim())
    case 'heightCm':
      return result.heightCm !== undefined && result.heightCm !== null
    case 'measurements':
      if (mode === 'fillEmpty') {
        return (
          (actress.bust_cm == null && result.bustCm !== undefined && result.bustCm !== null) ||
          (actress.waist_cm == null && result.waistCm !== undefined && result.waistCm !== null) ||
          (actress.hip_cm == null && result.hipCm !== undefined && result.hipCm !== null)
        )
      }
      return [result.bustCm, result.waistCm, result.hipCm].some(
        (value) => value !== undefined && value !== null
      )
    case 'cupSize':
      return Boolean(normalizeCupSize(result.cupSize))
    case 'bloodType':
      return Boolean(result.bloodType?.trim())
    case 'zodiac':
      return Boolean(result.zodiac?.trim())
    case 'nationality':
      return Boolean(result.nationality?.trim())
    case 'profileSummary':
      return Boolean(result.profileSummary?.trim())
    case 'aliases':
      return applicableAliases.length > 0
    default:
      return false
  }
}

function resolveApplicableScrapedAliases(
  aliases: string[] | undefined,
  actressId: number,
  mainName: string,
  releasedNameKeys: ReadonlySet<string> = new Set()
): { applicable: string[]; conflicts: string[] } {
  const applicable: string[] = []
  const conflicts: string[] = []
  const seen = new Set<string>()
  const mainKey = normalizeActressNameKey(mainName)

  for (const name of aliases ?? []) {
    const trimmed = name.trim()
    if (!trimmed || !isValidActressAlias(trimmed)) continue
    const key = normalizeActressNameKey(trimmed)
    if (key === mainKey || seen.has(key)) continue
    seen.add(key)
    if (!releasedNameKeys.has(key) && !isActressNameAvailable(trimmed, actressId)) {
      conflicts.push(trimmed)
      continue
    }
    applicable.push(trimmed)
  }

  return { applicable, conflicts }
}

interface ActressScrapeApplicationPlan {
  effectiveFields: ActressScrapeField[]
  impacts: ActressScrapeFieldImpact[]
  applicableAliases: string[]
  shouldReplaceAliases: boolean
  shouldClearAvatar: boolean
}

interface ActressScrapePlanSnapshot extends Actress {
  name_zh: string | null
  name_en: string | null
  aliases: string[]
  gallery: Array<Pick<ActressGalleryAsset, 'remote_url' | 'local_path'>>
}

/** Read only the rows needed to plan a scrape. Unlike getActressDetail, this never backfills assets. */
function readActressScrapePlanSnapshot(actressId: number): ActressScrapePlanSnapshot | null {
  const db = getDb()
  const actress = db.prepare('SELECT * FROM actresses WHERE id = ?').get(actressId) as
    | Actress
    | undefined
  if (!actress) return null
  const names = listActressNameRows(actressId)
  const gallery = db
    .prepare(
      `SELECT remote_url, local_path
       FROM actress_gallery_assets
       WHERE actress_id = ?
       ORDER BY position, id`
    )
    .all(actressId) as ActressScrapePlanSnapshot['gallery']
  return {
    ...actress,
    name_zh: getActressTypedName(actressId, 'zh', names),
    name_en: getActressTypedName(actressId, 'en', names),
    aliases: listActressAliasNames(actressId, names),
    gallery
  }
}

function samePlannedValue(
  left: ActressScrapeFieldImpact['currentValue'],
  right: ActressScrapeFieldImpact['nextValue']
): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }
  return left === right
}

function plannedImpact(
  field: ActressScrapeField,
  currentValue: ActressScrapeFieldImpact['currentValue'],
  incomingValue: ActressScrapeFieldImpact['nextValue'],
  mode: ActressScrapeUpdateMode,
  selected: boolean,
  options?: {
    part?: ActressScrapeFieldImpact['part']
    collection?: boolean
    resourceUnavailable?: boolean
  }
): ActressScrapeFieldImpact {
  let nextValue = currentValue
  let reason: ActressScrapeFieldImpact['reason'] =
    mode === 'replace' ? 'replace' : mode

  if (!selected) {
    reason = mode === 'fillEmpty' ? 'existingValue' : 'noValue'
  } else if (options?.resourceUnavailable) {
    reason = 'resourceUnavailable'
  } else if (mode === 'replace') {
    nextValue = incomingValue
  } else if (mode === 'fillEmpty') {
    if (currentValue === null || (Array.isArray(currentValue) && currentValue.length === 0)) {
      if (incomingValue !== null && (!Array.isArray(incomingValue) || incomingValue.length > 0)) {
        nextValue = incomingValue
      } else {
        reason = 'noValue'
      }
    } else {
      reason = 'existingValue'
    }
  } else if (
    incomingValue !== null &&
    (!Array.isArray(incomingValue) || incomingValue.length > 0)
  ) {
    nextValue = incomingValue
  } else {
    reason = 'noValue'
  }

  const action: ActressScrapeFieldImpact['action'] = samePlannedValue(currentValue, nextValue)
    ? 'preserve'
    : nextValue === null || (Array.isArray(nextValue) && nextValue.length === 0)
      ? 'clear'
      : options?.collection
        ? 'replace'
        : 'set'
  return {
    field,
    ...(options?.part ? { part: options.part } : {}),
    action,
    currentValue,
    nextValue,
    reason
  }
}

/**
 * Build the read-only field plan used by both conflict preview and formal application.
 * Files are inspected for availability, but neither database rows nor assets are changed.
 */
export function planActressScrapeResult(
  actressId: number,
  result: ActressScrapeResult,
  avatarRelPath: string | null,
  galleryAssets: ActressGalleryAssetWriteInput[],
  fields?: ActressScrapeField[],
  mode: ActressScrapeUpdateMode = 'replace',
  options?: { releasedNameKeys?: readonly string[] }
): ActressScrapeApplicationPlan {
  const storedDetail = readActressScrapePlanSnapshot(actressId)
  if (!storedDetail) throw new Error('演员不存在')
  const releasedNameKeys = new Set(options?.releasedNameKeys ?? [])
  const detail: ActressScrapePlanSnapshot = releasedNameKeys.size
    ? {
        ...storedDetail,
        name_zh:
          storedDetail.name_zh &&
          releasedNameKeys.has(normalizeActressNameKey(storedDetail.name_zh))
            ? null
            : storedDetail.name_zh,
        name_en:
          storedDetail.name_en &&
          releasedNameKeys.has(normalizeActressNameKey(storedDetail.name_en))
            ? null
            : storedDetail.name_en,
        aliases: storedDetail.aliases.filter(
          (alias) => !releasedNameKeys.has(normalizeActressNameKey(alias))
        )
      }
    : storedDetail
  const requested = fields ?? ALL_ACTRESS_SCRAPE_FIELDS
  const storedEffectiveFields = resolveEffectiveActressScrapeFields(actressId, requested, mode)
  const effectiveFields =
    mode === 'fillEmpty' && releasedNameKeys.size
      ? requested.filter((field) => {
          if (field === 'nameZh') return isBlankText(detail.name_zh)
          if (field === 'nameEn') return isBlankText(detail.name_en)
          if (field === 'aliases') return detail.aliases.length === 0
          return storedEffectiveFields.includes(field)
        })
      : storedEffectiveFields
  const selected = new Set(effectiveFields)
  const avatarResourceAvailable = Boolean(avatarRelPath && isUsableImageAsset(avatarRelPath))
  const avatarResourceUnavailable = Boolean(
    selected.has('avatar') &&
      ((avatarRelPath && !avatarResourceAvailable) || (!avatarRelPath && result.avatarUrl?.trim()))
  )
  const aliasResultIsEmpty = !result.aliases || result.aliases.length === 0
  const { applicable: applicableAliases, conflicts: conflictingAliases } = selected.has('aliases')
    ? resolveApplicableScrapedAliases(
        result.aliases,
        actressId,
        detail.main_name,
        releasedNameKeys
      )
    : { applicable: [], conflicts: [] }
  if (conflictingAliases.length > 0) {
    throw new Error(`名称「${conflictingAliases[0]}」已被其他演员使用`)
  }
  const shouldReplaceAliases =
    selected.has('aliases') &&
    (applicableAliases.length > 0 || (mode === 'replace' && aliasResultIsEmpty))
  const shouldClearAvatar =
    mode === 'replace' &&
    selected.has('avatar') &&
    !result.avatarUrl?.trim() &&
    !avatarRelPath

  const galleryValues = galleryAssets
    .map((asset) => asset.localPath?.trim() || asset.remoteUrl?.trim() || '')
    .filter(Boolean)
  const currentGallery = detail.gallery
    .map((asset) => asset.local_path?.trim() || asset.remote_url?.trim() || '')
    .filter(Boolean)
  const currentAvatar =
    detail.avatar_path?.trim() && isUsableImageAsset(detail.avatar_path)
      ? detail.avatar_path.trim()
      : null
  const avatarMatchesExisting = Boolean(
    avatarResourceAvailable &&
      avatarRelPath &&
      downloadedAvatarMatchesExistingSource(detail, avatarRelPath)
  )
  const nextAvatar = avatarMatchesExisting
    ? currentAvatar
    : avatarResourceAvailable
      ? avatarRelPath
    : shouldClearAvatar
      ? null
      : currentAvatar
  const textInputs: Array<{
    field: Exclude<ActressScrapeField, 'avatar' | 'gallery' | 'measurements' | 'aliases'>
    current: string | number | null
    incoming: string | number | null
  }> = [
    { field: 'birthDate', current: detail.birth_date, incoming: result.birthDate?.trim() || null },
    { field: 'nameZh', current: detail.name_zh, incoming: result.nameZh?.trim() || null },
    { field: 'nameEn', current: detail.name_en, incoming: result.nameEn?.trim() || null },
    { field: 'debutDate', current: detail.debut_date, incoming: result.debutDate?.trim() || null },
    { field: 'heightCm', current: detail.height_cm, incoming: result.heightCm ?? null },
    { field: 'cupSize', current: detail.cup_size, incoming: normalizeCupSize(result.cupSize) },
    { field: 'bloodType', current: detail.blood_type, incoming: result.bloodType?.trim() || null },
    { field: 'zodiac', current: detail.zodiac, incoming: result.zodiac?.trim() || null },
    { field: 'nationality', current: detail.nationality, incoming: result.nationality?.trim() || null },
    {
      field: 'profileSummary',
      current: detail.profile_summary,
      incoming: result.profileSummary?.trim() || null
    }
  ]
  const impacts: ActressScrapeFieldImpact[] = []
  for (const field of requested) {
    if (field === 'avatar') {
      impacts.push(
        plannedImpact('avatar', currentAvatar, nextAvatar, mode, selected.has('avatar'), {
          resourceUnavailable: avatarResourceUnavailable
        })
      )
    } else if (field === 'gallery') {
      impacts.push(
        plannedImpact(
          'gallery',
          currentGallery,
          galleryValues,
          mode,
          selected.has('gallery'),
          { collection: true }
        )
      )
    } else if (field === 'measurements') {
      for (const [part, current, incoming] of [
        ['bustCm', detail.bust_cm, result.bustCm ?? null],
        ['waistCm', detail.waist_cm, result.waistCm ?? null],
        ['hipCm', detail.hip_cm, result.hipCm ?? null]
      ] as const) {
        impacts.push(
          plannedImpact('measurements', current, incoming, mode, selected.has('measurements'), {
            part
          })
        )
      }
    } else if (field === 'aliases') {
      impacts.push(
        plannedImpact(
          'aliases',
          detail.aliases,
          applicableAliases,
          mode,
          selected.has('aliases'),
          { collection: true }
        )
      )
    } else {
      const input = textInputs.find((item) => item.field === field)
      if (input) {
        impacts.push(
          plannedImpact(field, input.current, input.incoming, mode, selected.has(field))
        )
      }
    }
  }

  return {
    effectiveFields,
    impacts,
    applicableAliases,
    shouldReplaceAliases,
    shouldClearAvatar
  }
}

/** Apply actress profile scrape result (avatar, gallery, profile fields, measurements, aliases). */
export function applyActressScrapeResult(
  actressId: number,
  result: ActressScrapeResult,
  avatarRelPath: string | null,
  galleryAssets: ActressGalleryAssetWriteInput[],
  fields?: ActressScrapeField[],
  mode: ActressScrapeUpdateMode = 'replace',
  beforeCommit?: () => void,
  options?: { deferFileCleanup?: boolean }
): {
  applied: boolean
  warnings: string[]
  avatarApplied: boolean
  fileChanges?: { createdPaths: string[]; obsoletePaths: string[] }
} {
  const db = getDb()
  const plan = planActressScrapeResult(
    actressId,
    result,
    avatarRelPath,
    galleryAssets,
    fields,
    mode
  )
  const effective = plan.effectiveFields
  if (effective.length === 0) return { applied: false, warnings: [], avatarApplied: false }
  const selected = new Set(effective)
  const warnings: string[] = []
  const scrapedAt = nowIso()
  const preserveExistingDb = mode === 'fillEmpty'
  if (preserveExistingDb && selected.has('avatar')) {
    clearBrokenActressAvatarIfNeeded(actressId)
  }
  const actress = db
    .prepare(
      `SELECT main_name, avatar_path, avatar_source_path, bust_cm, waist_cm, hip_cm
       FROM actresses WHERE id = ?`
    )
    .get(actressId) as
    | Pick<
        Actress,
        | 'main_name'
        | 'avatar_path'
        | 'avatar_source_path'
        | 'bust_cm'
        | 'waist_cm'
        | 'hip_cm'
      >
    | undefined
  if (!actress) throw new Error('演员不存在')
  const shouldClearAvatar = plan.shouldClearAvatar
  const aliasResultIsEmpty = !result.aliases || result.aliases.length === 0
  const applicableAliases = plan.applicableAliases
  const shouldReplaceAliases = plan.shouldReplaceAliases

  let adoptedAvatar:
    | { displayPath: string; sourcePath: string; cropJson: string }
    | null = null
  let avatarApplied = false
  if (selected.has('avatar') && avatarRelPath) {
    const shouldAdopt =
      !preserveExistingDb ||
      isBlankText(actress.avatar_path) ||
      !isUsableImageAsset(actress.avatar_path)
    if (shouldAdopt) {
      // Same source image again: keep manual crop / display; only drop the temp download.
      if (
        isUsableImageAsset(actress.avatar_path) &&
        downloadedAvatarMatchesExistingSource(actress, avatarRelPath)
      ) {
        avatarApplied = true
        if (avatarRelPath !== actress.avatar_path && avatarRelPath !== actress.avatar_source_path) {
          deleteAsset(avatarRelPath)
        }
      } else {
        try {
          adoptedAvatar = adoptDownloadedAvatarAsBundle(
            actressId,
            actress.main_name,
            avatarRelPath
          )
          avatarApplied = true
        } catch (err) {
          warnings.push(`头像未应用：${(err as Error).message}`)
        }
      }
    } else if (avatarRelPath !== actress.avatar_path && avatarRelPath !== actress.avatar_source_path) {
      deleteAsset(avatarRelPath)
    }
  }

  const hasReplaceOperation =
    mode === 'replace' &&
    effective.some((field) => {
      if (field === 'avatar') return shouldClearAvatar
      if (field === 'aliases') return aliasResultIsEmpty
      return true
    })
  const hasValidValue =
    hasReplaceOperation ||
    effective.some((field) =>
      hasValidActressScrapeValue(
        result,
        field,
        avatarApplied,
        galleryAssets,
        applicableAliases,
        mode,
        actress
      )
    )
  if (!hasValidValue) {
    return { applied: false, warnings, avatarApplied: false }
  }

  let obsoleteGalleryLocalPaths: string[] = []
  const txn = db.transaction(() => {
    const updates: string[] = []
    const bind: Record<string, unknown> = { id: actressId }
    const impactValue = (
      field: ActressScrapeField,
      part?: ActressScrapeFieldImpact['part']
    ): ActressScrapeFieldImpact['nextValue'] =>
      plan.impacts.find((impact) => impact.field === field && impact.part === part)?.nextValue ??
      null
    const setPlanned = (
      column: string,
      bindKey: string,
      field: ActressScrapeField,
      part?: ActressScrapeFieldImpact['part']
    ): void => {
      updates.push(`${column} = @${bindKey}`)
      bind[bindKey] = impactValue(field, part)
    }

    if (selected.has('birthDate')) {
      setPlanned('birth_date', 'birth_date', 'birthDate')
    }
    if (selected.has('debutDate')) {
      setPlanned('debut_date', 'debut_date', 'debutDate')
    }
    if (selected.has('heightCm')) {
      setPlanned('height_cm', 'height_cm', 'heightCm')
    }
    if (selected.has('measurements')) {
      setPlanned('bust_cm', 'bust_cm', 'measurements', 'bustCm')
      setPlanned('waist_cm', 'waist_cm', 'measurements', 'waistCm')
      setPlanned('hip_cm', 'hip_cm', 'measurements', 'hipCm')
    }
    if (selected.has('cupSize')) {
      setPlanned('cup_size', 'cup_size', 'cupSize')
    }
    if (selected.has('bloodType')) {
      setPlanned('blood_type', 'blood_type', 'bloodType')
    }
    if (selected.has('zodiac')) {
      setPlanned('zodiac', 'zodiac', 'zodiac')
    }
    if (selected.has('nationality')) {
      setPlanned('nationality', 'nationality', 'nationality')
    }
    if (selected.has('profileSummary')) {
      setPlanned('profile_summary', 'profile_summary', 'profileSummary')
    }
    if (selected.has('avatar') && adoptedAvatar) {
      updates.push(
        preserveExistingDb
          ? `avatar_path = CASE WHEN avatar_path IS NULL OR trim(avatar_path) = '' THEN @avatar_path ELSE avatar_path END`
          : 'avatar_path = @avatar_path'
      )
      updates.push(
        preserveExistingDb
          ? `avatar_source_path = CASE WHEN avatar_path IS NULL OR trim(avatar_path) = '' THEN @avatar_source_path ELSE avatar_source_path END`
          : 'avatar_source_path = @avatar_source_path'
      )
      updates.push(
        preserveExistingDb
          ? `avatar_crop_json = CASE WHEN avatar_path IS NULL OR trim(avatar_path) = '' THEN @avatar_crop_json ELSE avatar_crop_json END`
          : 'avatar_crop_json = @avatar_crop_json'
      )
      bind.avatar_path = adoptedAvatar.displayPath
      bind.avatar_source_path = adoptedAvatar.sourcePath
      bind.avatar_crop_json = adoptedAvatar.cropJson
    } else if (shouldClearAvatar) {
      updates.push('avatar_path = NULL')
      updates.push('avatar_source_path = NULL')
      updates.push('avatar_crop_json = NULL')
    }
    if (selected.has('nameZh') && (mode === 'replace' || result.nameZh !== undefined)) {
      const zh = impactValue('nameZh') as string | null
      if (zh) assertActressNameAvailable(zh, actressId)
      if (preserveExistingDb) {
        setActressTypedNameIfEmpty(actressId, 'zh', zh)
      } else if (mode === 'replace' || zh) {
        setActressTypedName(actressId, 'zh', zh)
      }
    }
    if (selected.has('nameEn') && (mode === 'replace' || result.nameEn !== undefined)) {
      const en = impactValue('nameEn') as string | null
      if (en) assertActressNameAvailable(en, actressId)
      if (preserveExistingDb) {
        setActressTypedNameIfEmpty(actressId, 'en', en)
      } else if (mode === 'replace' || en) {
        setActressTypedName(actressId, 'en', en)
      }
    }
    updates.push('scraped_status = 1')
    updates.push('last_scraped_at = @last_scraped_at')
    updates.push('updated_at = @updated_at')
    bind.last_scraped_at = scrapedAt
    bind.updated_at = scrapedAt
    if (updates.length) {
      db.prepare(`UPDATE actresses SET ${updates.join(', ')} WHERE id = @id`).run(bind)
    }

    if (shouldReplaceAliases) {
      replaceActressAliases(actressId, applicableAliases, actress.main_name)
    }
    if (selected.has('nameZh') || selected.has('nameEn') || shouldReplaceAliases) {
      synchronizeActressNameOwnership(actressId)
    }
    if (selected.has('gallery') && (galleryAssets.length > 0 || mode === 'replace')) {
      obsoleteGalleryLocalPaths = replaceActressGalleryAssetRows(actressId, galleryAssets)
    }
    beforeCommit?.()
  })
  try {
    txn()
  } catch (error) {
    if (adoptedAvatar) {
      deleteAsset(adoptedAvatar.displayPath)
      if (adoptedAvatar.sourcePath !== adoptedAvatar.displayPath) {
        deleteAsset(adoptedAvatar.sourcePath)
      }
    }
    throw error
  }
  const createdPaths = adoptedAvatar
    ? Array.from(new Set([adoptedAvatar.displayPath, adoptedAvatar.sourcePath]))
    : []
  const obsoletePaths = [...obsoleteGalleryLocalPaths]

  if (selected.has('avatar') && adoptedAvatar) {
    if (actress.avatar_path && actress.avatar_path !== adoptedAvatar.displayPath) {
      obsoletePaths.push(actress.avatar_path)
    }
    if (
      actress.avatar_source_path &&
      actress.avatar_source_path !== adoptedAvatar.sourcePath
    ) {
      obsoletePaths.push(actress.avatar_source_path)
    }
  } else if (shouldClearAvatar) {
    if (actress.avatar_path) obsoletePaths.push(actress.avatar_path)
    if (actress.avatar_source_path) obsoletePaths.push(actress.avatar_source_path)
  }

  if (!options?.deferFileCleanup) {
    deleteObsoleteActressGalleryAssets(obsoleteGalleryLocalPaths)
    for (const obsoletePath of obsoletePaths) {
      if (!obsoleteGalleryLocalPaths.includes(obsoletePath)) deleteAsset(obsoletePath)
    }
  }

  return {
    applied: true,
    warnings,
    avatarApplied,
    ...(options?.deferFileCleanup
      ? {
          fileChanges: {
            createdPaths,
            obsoletePaths: Array.from(new Set(obsoletePaths))
          }
        }
      : {})
  }
}

function dedupeUrls(urls: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const url of urls) {
    const trimmed = url.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function isValidActressAlias(name: string): boolean {
  if (name.length > 48) return false
  if (/出演|在線看|在線|missav|搜尋|搜索|watch|online|免费|高清|javdb/i.test(name)) return false
  if (/\d+\s*(部|个)\s*(影片|作品)/.test(name)) return false
  if (/\d+\s*movie\(s\)/i.test(name)) return false
  return true
}

function normalizeActressNameKey(name: string): string {
  return normalizeActressName(name)
}

function removeMergedActressRecord(id: number): void {
  const db = getDb()
  const actress = db
    .prepare('SELECT avatar_path, avatar_source_path FROM actresses WHERE id = ?')
    .get(id) as { avatar_path: string | null; avatar_source_path: string | null } | undefined
  if (!actress) throw new Error('演员不存在')
  db.prepare('DELETE FROM actresses WHERE id = ?').run(id)
  // Avatar files for the merged row are deleted by mergeActresses after adoption checks.
  void actress
}

function deleteActressGalleryAssetRows(actressId: number): Array<string | null> {
  const db = getDb()
  const rows = db
    .prepare('SELECT local_path FROM actress_gallery_assets WHERE actress_id = ?')
    .all(actressId) as { local_path: string | null }[]
  db.prepare('UPDATE actresses SET poster_path = NULL WHERE id = ?').run(actressId)
  db.prepare('DELETE FROM actress_gallery_assets WHERE actress_id = ?').run(actressId)
  return rows.map((row) => row.local_path)
}

function clearActressPosterForPaths(actressId: number, paths: Array<string | null>): void {
  const db = getDb()
  const clear = db.prepare(
    'UPDATE actresses SET poster_path = NULL WHERE id = ? AND poster_path = ?'
  )
  for (const path of paths) {
    if (path) clear.run(actressId, path)
  }
}

function nowIso(): string {
  return new Date().toISOString()
}
