import type { Database as SqliteDatabase } from 'better-sqlite3'
import { getDb } from './database'
import type {
  Actress,
  ActressDetail,
  ActressGalleryAsset,
  Video,
  ActressScrapeResult,
  ActressEditInput,
  ActressScrapeField,
  ActressScrapeUpdateMode,
  ActressBatchScrapeFilter,
  ActressGender,
  ActressGenderFilter,
  ActressListItem,
  ActressListSortBy,
  ActressMergeMainNameFrom,
  ListSortDir
} from '@shared/types'
import { ALL_ACTRESS_SCRAPE_FIELDS, ACTRESS_BATCH_DEFAULT_MISSING_FIELDS } from '@shared/types'
import { canMergeActressGenders } from '@shared/actressProfileOptions'
import { normalizeCupSize } from '@shared/cupSizeUtils'
import {
  deleteAsset,
  importAvatarFromFile,
  importAvatarFromBuffer,
  isUsableImageAsset,
  readImageDimensionsFromPath,
  readImageDimensionsFromRelPath
} from '../services/assetService'
import { actressSearchLikeParams, actressTextSearchSql } from './actressSearchSql'
import {
  ACTRESS_NAME_TYPE,
  findActressIdByStoredName,
  getActressTypedName,
  listActressAliasNames,
  listActressNameRows,
  mergeActressNameRows,
  setActressTypedName,
  setActressTypedNameIfEmpty,
  upsertActressName
} from './actressNames'

/**
 * Resolve an actress by main name OR alias. Returns the *main* actress id,
 * so renamed/alias performers are merged under one identity.
 */
export function findActressByNameOrAlias(name: string): number | null {
  return findActressIdByStoredName(name)
}

/**
 * Find an existing actress (by name/alias) or create a new one.
 * If found via alias, the avatar is only filled in when missing.
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
    if (avatarRelPath) {
      // Fill avatar only if not already set.
      db.prepare(
        `UPDATE actresses SET avatar_path = COALESCE(avatar_path, ?) WHERE id = ?`
      ).run(avatarRelPath, existingId)
    }
    if (gender) {
      db.prepare('UPDATE actresses SET gender = ? WHERE id = ?').run(gender, existingId)
    }
    return existingId
  }

  const info = db
    .prepare('INSERT INTO actresses (main_name, avatar_path, gender) VALUES (?, ?, ?)')
    .run(trimmed, avatarRelPath, gender ?? 'female')
  const id = Number(info.lastInsertRowid)
  upsertActressName(id, trimmed, 'main', null, null, 1)
  return id
}

export function addAlias(actressId: number, aliasName: string): void {
  upsertActressName(actressId, aliasName.trim(), ACTRESS_NAME_TYPE.ALIAS, null, null, 0)
}

type ActressBatchTarget = { id: number; main_name: string }

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

function actressNeverScrapedCondition(): string {
  return "(a.last_scraped_at IS NULL OR trim(a.last_scraped_at) = '')"
}

function actressScrapedCondition(): string {
  return "(a.last_scraped_at IS NOT NULL AND trim(a.last_scraped_at) != '')"
}

function buildActressBatchConditions(
  filter: Pick<ActressBatchScrapeFilter, 'scope' | 'scrapeStatus'>
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.scope === 'female') {
    conditions.push("(a.gender IS NULL OR a.gender = 'female')")
  } else if (filter.scope === 'male') {
    conditions.push("a.gender = 'male'")
  }

  const scrapeStatus = filter.scrapeStatus ?? 'all'
  if (scrapeStatus === 'unscraped') {
    conditions.push(actressNeverScrapedCondition())
  } else if (scrapeStatus === 'scraped') {
    conditions.push(actressScrapedCondition())
  }

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
  filter: Pick<ActressBatchScrapeFilter, 'scope' | 'scrapeStatus'>
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
  filter: Pick<ActressBatchScrapeFilter, 'scope' | 'scrapeStatus'>
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

/** Clear avatar_path when the stored file is missing or not a readable image. */
export function clearBrokenActressAvatarIfNeeded(actressId: number): boolean {
  const db = getDb()
  const row = db.prepare('SELECT avatar_path FROM actresses WHERE id = ?').get(actressId) as
    | { avatar_path: string | null }
    | undefined
  if (!row || isBlankText(row.avatar_path) || isUsableImageAsset(row.avatar_path)) {
    return false
  }

  deleteAsset(row.avatar_path)
  db.prepare('UPDATE actresses SET avatar_path = NULL, updated_at = ? WHERE id = ?').run(
    nowIso(),
    actressId
  )
  return true
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

export function listActresses(
  search?: string,
  gender: ActressGenderFilter = 'female',
  sortBy: ActressListSortBy = 'video_count',
  sortDir: ListSortDir = 'desc'
): ActressListItem[] {
  const db = getDb()
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

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const orderBy = buildActressListOrderBy(sortBy, sortDir)
  return db
    .prepare(
      `SELECT a.*,
              COUNT(va.video_id) AS video_count,
              (SELECT COUNT(*) FROM actress_gallery_assets ag WHERE ag.actress_id = a.id) AS gallery_count
       FROM actresses a
       LEFT JOIN video_actress va ON va.actress_id = a.id
       ${where}
       GROUP BY a.id
       ORDER BY ${orderBy}`
    )
    .all(...params) as ActressListItem[]
}

function buildActressListOrderBy(sortBy: ActressListSortBy, sortDir: ListSortDir): string {
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC'
  const tie = 'a.main_name ASC'
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
  input: {
    remoteUrl?: string | null
    localPath?: string | null
    width?: number | null
    height?: number | null
  }
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
  assets: Array<{
    remoteUrl?: string | null
    localPath?: string | null
    width?: number | null
    height?: number | null
  }>
): void {
  const db = getDb()
  const existing = db
    .prepare('SELECT local_path FROM actress_gallery_assets WHERE actress_id = ?')
    .all(actressId) as { local_path: string | null }[]
  const createdAt = nowIso()

  const txn = db.transaction(() => {
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
  })
  txn()

  const retainedLocalPaths = new Set(
    assets.map((asset) => asset.localPath).filter((localPath): localPath is string => !!localPath)
  )
  for (const row of existing) {
    if (!row.local_path || retainedLocalPaths.has(row.local_path)) continue
    deleteAsset(row.local_path)
  }
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

/** Merge mergeId into keepId. The merged record is removed; videos, gallery, and aliases combine. */
export function mergeActresses(
  keepId: number,
  mergeId: number,
  mainNameFrom: ActressMergeMainNameFrom = 'keep'
): void {
  if (keepId === mergeId) throw new Error('不能合并同一演员')

  const db = getDb()
  const keep = db.prepare('SELECT * FROM actresses WHERE id = ?').get(keepId) as Actress | undefined
  const merge = db.prepare('SELECT * FROM actresses WHERE id = ?').get(mergeId) as Actress | undefined
  if (!keep || !merge) throw new Error('演员不存在')
  if (!canMergeActressGenders(keep.gender, merge.gender)) {
    throw new Error('不能合并不同性别的演员')
  }

  const finalMain = mainNameFrom === 'keep' ? keep.main_name : merge.main_name
  const aliasCandidates = new Set<string>()
  for (const alias of [...listActressAliasNames(keepId), ...listActressAliasNames(mergeId)]) {
    aliasCandidates.add(alias)
  }
  if (merge.main_name.trim() !== finalMain) aliasCandidates.add(merge.main_name.trim())
  if (mainNameFrom === 'merge' && keep.main_name.trim() !== finalMain) {
    aliasCandidates.add(keep.main_name.trim())
  }

  const mergeAvatarPath = merge.avatar_path

  const txn = db.transaction(() => {
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

    mergeActressNameRows(keepId, mergeId)

    db.prepare(
      `UPDATE actresses SET
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
         avatar_path = COALESCE(NULLIF(trim(avatar_path), ''), NULLIF(trim(@avatar_path), '')),
         gender = COALESCE(gender, @gender),
         last_scraped_at = CASE
           WHEN last_scraped_at IS NULL THEN @last_scraped_at
           WHEN @last_scraped_at IS NULL THEN last_scraped_at
           WHEN last_scraped_at > @last_scraped_at THEN last_scraped_at
           ELSE @last_scraped_at
         END,
         updated_at = @updated_at
       WHERE id = @keepId`
    ).run({
      keepId,
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
      avatar_path: merge.avatar_path,
      gender: merge.gender,
      last_scraped_at: merge.last_scraped_at,
      updated_at: nowIso()
    })

    db.prepare(
      `INSERT OR IGNORE INTO actress_tag (actress_id, tag_id)
       SELECT ?, tag_id FROM actress_tag WHERE actress_id = ?`
    ).run(keepId, mergeId)

    removeMergedActressRecord(mergeId)
  })
  txn()

  const keptAvatar = (
    db.prepare('SELECT avatar_path FROM actresses WHERE id = ?').get(keepId) as {
      avatar_path: string | null
    }
  ).avatar_path

  if (finalMain !== keep.main_name) {
    assertActressNameAvailable(finalMain, keepId)
    db.prepare('UPDATE actresses SET main_name = ?, updated_at = ? WHERE id = ?').run(
      finalMain,
      nowIso(),
      keepId
    )
    upsertActressName(keepId, finalMain, 'main', null, null, 1)
  }

  replaceActressAliases(keepId, Array.from(aliasCandidates), finalMain)

  if (mergeAvatarPath && mergeAvatarPath !== keptAvatar) {
    deleteAsset(mergeAvatarPath)
  }
}

/**
 * Clear scraped actress metadata while keeping main name, gender, and video links.
 * Removes avatar, gallery, poster, profile fields, and non-main name rows.
 */
export function clearActressMetadataRecord(id: number): void {
  const db = getDb()
  const actress = db.prepare('SELECT avatar_path FROM actresses WHERE id = ?').get(id) as
    | { avatar_path: string | null }
    | undefined
  if (!actress) throw new Error('演员不存在')

  deleteActressGalleryAssets(id)
  deleteAsset(actress.avatar_path)

  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE actresses SET
         birth_date = NULL, debut_date = NULL, height_cm = NULL,
         bust_cm = NULL, waist_cm = NULL, hip_cm = NULL, cup_size = NULL,
         blood_type = NULL, zodiac = NULL, nationality = NULL,
         profile_summary = NULL, avatar_path = NULL, poster_path = NULL,
         last_scraped_at = NULL, updated_at = ?
       WHERE id = ?`
    ).run(nowIso(), id)
    db.prepare("DELETE FROM actress_names WHERE actress_id = ? AND type != 'main'").run(id)
  })
  txn()
}

/** Delete an actress that has no linked videos. Removes aliases and avatar. */
export function deleteActress(id: number): void {
  const db = getDb()
  const count = db
    .prepare('SELECT COUNT(*) AS c FROM video_actress WHERE actress_id = ?')
    .get(id) as { c: number }
  if (count.c > 0) throw new Error('仍有影片关联，无法删除')

  const actress = db.prepare('SELECT avatar_path FROM actresses WHERE id = ?').get(id) as
    | { avatar_path: string | null }
    | undefined
  if (!actress) throw new Error('演员不存在')

  deleteActressGalleryAssets(id)
  db.prepare('DELETE FROM actresses WHERE id = ?').run(id)
  deleteAsset(actress.avatar_path)
}

function isActressNameAvailable(name: string, exceptId: number): boolean {
  const existing = findActressByNameOrAlias(name)
  return existing === null || existing === exceptId
}

function assertActressNameAvailable(name: string, exceptId: number): void {
  if (!isActressNameAvailable(name, exceptId)) {
    throw new Error(`名称「${name}」已被其他演员使用`)
  }
}

function replaceActressAliases(
  actressId: number,
  aliases: string[],
  mainName: string,
  options?: { onNameConflict?: 'throw' | 'skip' }
): string[] {
  const onNameConflict = options?.onNameConflict ?? 'throw'
  const skipped: string[] = []
  const db = getDb()
  db.prepare("DELETE FROM actress_names WHERE actress_id = ? AND type = 'alias'").run(actressId)
  const seen = new Set<string>()
  const mainKey = normalizeActressNameKey(mainName)

  for (const alias of aliases) {
    const trimmed = alias.trim()
    if (!trimmed || !isValidActressAlias(trimmed)) continue
    const key = normalizeActressNameKey(trimmed)
    if (key === mainKey || seen.has(key)) continue
    if (!isActressNameAvailable(trimmed, actressId)) {
      if (onNameConflict === 'skip') {
        skipped.push(trimmed)
        continue
      }
      throw new Error(`名称「${trimmed}」已被其他演员使用`)
    }
    seen.add(key)
    upsertActressName(actressId, trimmed, ACTRESS_NAME_TYPE.ALIAS, null, null, 0)
  }

  return skipped
}

/** Manually edit actress profile fields. Aliases fully replace when supplied. */
export function editActress(id: number, input: ActressEditInput): void {
  const db = getDb()
  const actress = db.prepare('SELECT main_name, avatar_path FROM actresses WHERE id = ?').get(id) as
    | { main_name: string; avatar_path: string | null }
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

    if (input.avatarImageBase64) {
      const avatarPath = importAvatarFromBuffer(
        mainName,
        Buffer.from(input.avatarImageBase64, 'base64')
      )
      if (actress.avatar_path && actress.avatar_path !== avatarPath) {
        deleteAsset(actress.avatar_path)
      }
      db.prepare('UPDATE actresses SET avatar_path = ?, updated_at = ? WHERE id = ?').run(
        avatarPath,
        nowIso(),
        id
      )
    } else if (input.avatarSourcePath) {
      const avatarPath = importAvatarFromFile(mainName, input.avatarSourcePath)
      if (actress.avatar_path && actress.avatar_path !== avatarPath) {
        deleteAsset(actress.avatar_path)
      }
      db.prepare('UPDATE actresses SET avatar_path = ?, updated_at = ? WHERE id = ?').run(
        avatarPath,
        nowIso(),
        id
      )
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
  if (fields.includes('avatar')) {
    clearBrokenActressAvatarIfNeeded(actressId)
  }
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

/** Record that a scrape attempt finished, even when no profile data was applied. */
export function touchActressLastScrapedAt(actressId: number): void {
  const db = getDb()
  const scrapedAt = nowIso()
  db.prepare('UPDATE actresses SET last_scraped_at = ?, updated_at = ? WHERE id = ?').run(
    scrapedAt,
    scrapedAt,
    actressId
  )
}

/** Apply actress profile scrape result (avatar, gallery, profile fields, measurements, aliases). */
export function applyActressScrapeResult(
  actressId: number,
  result: ActressScrapeResult,
  avatarRelPath: string | null,
  galleryAssets: Array<{
    remoteUrl?: string | null
    localPath?: string | null
    width?: number | null
    height?: number | null
  }>,
  fields?: ActressScrapeField[],
  mode: ActressScrapeUpdateMode = 'replace'
): { applied: boolean; warnings: string[] } {
  const db = getDb()
  const requested = fields ?? ALL_ACTRESS_SCRAPE_FIELDS
  const effective = resolveEffectiveActressScrapeFields(actressId, requested, mode)
  if (effective.length === 0) return { applied: false, warnings: [] }
  const selected = new Set(effective)
  const warnings: string[] = []
  const scrapedAt = nowIso()
  const actress = db
    .prepare('SELECT main_name, avatar_path FROM actresses WHERE id = ?')
    .get(actressId) as { main_name: string; avatar_path: string | null } | undefined
  if (!actress) throw new Error('演员不存在')
  const preserveExistingDb = mode === 'fillEmpty'
  const preserveNullScrape = mode !== 'replace'
  if (preserveExistingDb && selected.has('avatar')) {
    clearBrokenActressAvatarIfNeeded(actressId)
  }

  const txn = db.transaction(() => {
    const updates: string[] = []
    const bind: Record<string, unknown> = { id: actressId }
    const setText = (column: string, bindKey: string, value: string | null): void => {
      if (preserveExistingDb) {
        updates.push(
          `${column} = CASE WHEN ${column} IS NULL OR trim(${column}) = '' THEN @${bindKey} ELSE ${column} END`
        )
      } else if (preserveNullScrape) {
        updates.push(
          `${column} = CASE WHEN @${bindKey} IS NULL OR trim(@${bindKey}) = '' THEN ${column} ELSE @${bindKey} END`
        )
      } else {
        updates.push(`${column} = @${bindKey}`)
      }
      bind[bindKey] = value
    }
    const setNumber = (column: string, bindKey: string, value: number | null): void => {
      if (preserveExistingDb) {
        updates.push(`${column} = COALESCE(${column}, @${bindKey})`)
      } else if (preserveNullScrape) {
        updates.push(`${column} = COALESCE(@${bindKey}, ${column})`)
      } else {
        updates.push(`${column} = @${bindKey}`)
      }
      bind[bindKey] = value
    }

    if (selected.has('birthDate')) {
      setText('birth_date', 'birth_date', result.birthDate?.trim() || null)
    }
    if (selected.has('debutDate')) {
      setText('debut_date', 'debut_date', result.debutDate?.trim() || null)
    }
    if (selected.has('heightCm')) {
      setNumber('height_cm', 'height_cm', result.heightCm ?? null)
    }
    if (selected.has('measurements')) {
      setNumber('bust_cm', 'bust_cm', result.bustCm ?? null)
      setNumber('waist_cm', 'waist_cm', result.waistCm ?? null)
      setNumber('hip_cm', 'hip_cm', result.hipCm ?? null)
    }
    if (selected.has('cupSize')) {
      setText('cup_size', 'cup_size', normalizeCupSize(result.cupSize))
    }
    if (selected.has('bloodType')) {
      setText('blood_type', 'blood_type', result.bloodType?.trim() || null)
    }
    if (selected.has('zodiac')) {
      setText('zodiac', 'zodiac', result.zodiac?.trim() || null)
    }
    if (selected.has('nationality')) {
      setText('nationality', 'nationality', result.nationality?.trim() || null)
    }
    if (selected.has('profileSummary')) {
      setText('profile_summary', 'profile_summary', result.profileSummary?.trim() || null)
    }
    if (selected.has('avatar') && avatarRelPath) {
      updates.push(
        preserveExistingDb
          ? `avatar_path = CASE WHEN avatar_path IS NULL OR trim(avatar_path) = '' THEN @avatar_path ELSE avatar_path END`
          : 'avatar_path = @avatar_path'
      )
      bind.avatar_path = avatarRelPath
    }
    if (selected.has('nameZh') && result.nameZh !== undefined) {
      const zh = result.nameZh?.trim() || null
      if (zh) assertActressNameAvailable(zh, actressId)
      if (preserveExistingDb) {
        setActressTypedNameIfEmpty(actressId, 'zh', zh)
      } else if (mode === 'replace' || zh) {
        setActressTypedName(actressId, 'zh', zh)
      }
    }
    if (selected.has('nameEn') && result.nameEn !== undefined) {
      const en = result.nameEn?.trim() || null
      if (en) assertActressNameAvailable(en, actressId)
      if (preserveExistingDb) {
        setActressTypedNameIfEmpty(actressId, 'en', en)
      } else if (mode === 'replace' || en) {
        setActressTypedName(actressId, 'en', en)
      }
    }
    updates.push('last_scraped_at = @last_scraped_at')
    updates.push('updated_at = @updated_at')
    bind.last_scraped_at = scrapedAt
    bind.updated_at = scrapedAt
    if (updates.length) {
      db.prepare(`UPDATE actresses SET ${updates.join(', ')} WHERE id = @id`).run(bind)
    }

    if (selected.has('aliases')) {
      const aliases = (result.aliases ?? []).filter((a) => isValidActressAlias(a.trim()))
      if (mode === 'replace' || aliases.length > 0) {
        const skipped = replaceActressAliases(actressId, aliases, actress.main_name, {
          onNameConflict: 'skip'
        })
        for (const name of skipped) {
          warnings.push(`别名「${name}」已被其他演员使用，已跳过`)
        }
      }
    }
  })
  txn()

  if (selected.has('gallery')) {
    if (galleryAssets.length) {
      replaceActressGalleryAssets(actressId, galleryAssets)
    } else if (mode === 'replace') {
      replaceActressGalleryAssets(actressId, [])
    }
  }

  if (
    selected.has('avatar') &&
    avatarRelPath &&
    actress.avatar_path &&
    actress.avatar_path !== avatarRelPath
  ) {
    deleteAsset(actress.avatar_path)
  }

  return { applied: true, warnings }
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
  return name.toLowerCase().replace(/\s+/g, '')
}

function removeMergedActressRecord(id: number): void {
  const db = getDb()
  const actress = db.prepare('SELECT avatar_path FROM actresses WHERE id = ?').get(id) as
    | { avatar_path: string | null }
    | undefined
  if (!actress) throw new Error('演员不存在')
  db.prepare('DELETE FROM actresses WHERE id = ?').run(id)
}

function deleteActressGalleryAssets(actressId: number): void {
  const db = getDb()
  const rows = db
    .prepare('SELECT local_path FROM actress_gallery_assets WHERE actress_id = ?')
    .all(actressId) as { local_path: string | null }[]
  db.prepare('UPDATE actresses SET poster_path = NULL WHERE id = ?').run(actressId)
  for (const row of rows) deleteAsset(row.local_path)
  db.prepare('DELETE FROM actress_gallery_assets WHERE actress_id = ?').run(actressId)
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
