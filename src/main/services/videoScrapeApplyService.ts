import type { ActressGender } from '@shared/actressTypes'
import type { Video } from '@shared/videoTypes'
import type {
  ScrapeResult,
  ScrapedActress,
  VideoBatchScrapeFilter,
  VideoClassificationField,
  VideoClassificationResolutionOutcome,
  VideoDirectorChoiceRequired,
  VideoScrapeField,
  VideoScrapeUpdateMode
} from '@shared/videoScrapeTypes'
import { ALL_VIDEO_SCRAPE_FIELDS } from '@shared/videoScrapeTypes'
import { findActressByNameOrAlias, upsertActressFromScrape } from '../db/actressRepo'
import { getDb } from '../db/database'
import { collectVideoLibraryCleanupHints, runLibraryCleanup } from '../db/libraryCleanup'
import { getVideoById, listVideosForBatchScrape, replaceVideoTagsByOrigin } from '../db/videoRepo'
import { adoptDownloadedAvatarIfMissing } from './actressAssetService'
import {
  classificationFieldLabel,
  resolveDirectorIdentity,
  resolveOrganizationIdentity,
  resolveSeriesIdentity,
  type ClassificationIdentityResolution
} from './classificationIdentityResolver'
import { classificationMaintenanceService } from './classificationMaintenanceService'
import { mediaAssetStore } from './mediaAssetStore'

function scrapedCastGender(a: ScrapedActress): ActressGender {
  return a.gender ?? 'female'
}

/** Remove cast links for one gender only (NULL gender is treated as female). */
function removeVideoActressesByGender(videoId: number, gender: ActressGender): void {
  const db = getDb()
  if (gender === 'female') {
    db.prepare(
      `DELETE FROM video_actress
       WHERE video_id = ?
         AND actress_id IN (
           SELECT id FROM actresses WHERE gender IS NULL OR gender = 'female'
         )`
    ).run(videoId)
  } else {
    db.prepare(
      `DELETE FROM video_actress
       WHERE video_id = ?
         AND actress_id IN (SELECT id FROM actresses WHERE gender = 'male')`
    ).run(videoId)
  }
}

function linkScrapedCastByGender(
  videoId: number,
  cast: ScrapedActress[],
  gender: ActressGender,
  actressAvatars: Map<string, string | null>
): void {
  const db = getDb()
  for (const a of cast) {
    if (scrapedCastGender(a) !== gender) continue
    const actressId = upsertActressFromScrape(
      a.name,
      actressAvatars.get(a.name) ?? null,
      gender
    )
    db.prepare('INSERT OR IGNORE INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(
      videoId,
      actressId
    )
  }
}


function isBlankText(value: string | null | undefined): boolean {
  return value == null || value.trim() === ''
}

function countVideoCastByGender(videoId: number, gender: ActressGender): number {
  const db = getDb()
  const condition =
    gender === 'female' ? "(a.gender = 'female' OR a.gender IS NULL)" : "a.gender = 'male'"
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM video_actress va
         JOIN actresses a ON a.id = va.actress_id
         WHERE va.video_id = ? AND ${condition}`
      )
      .get(videoId) as { n: number }
  ).n
}

function countScrapedVideoTags(videoId: number): number {
  const db = getDb()
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM video_tag WHERE video_id = ? AND origin = ?')
      .get(videoId, 'scraped') as { n: number }
  ).n
}

function countVideoSources(videoId: number, sourceName?: string): number {
  const db = getDb()
  const row = sourceName
    ? db
        .prepare(
          "SELECT COUNT(*) AS n FROM video_sources WHERE video_id = ? AND source = ? AND url IS NOT NULL AND trim(url) != ''"
        )
        .get(videoId, sourceName)
    : db
        .prepare(
          "SELECT COUNT(*) AS n FROM video_sources WHERE video_id = ? AND url IS NOT NULL AND trim(url) != ''"
        )
        .get(videoId)
  return (row as { n: number }).n
}

function countVideoExternalStats(videoId: number, sourceName?: string): number {
  const db = getDb()
  const row = sourceName
    ? db
        .prepare(
          'SELECT COUNT(*) AS n FROM video_external_stats WHERE video_id = ? AND source = ? AND rating_average IS NOT NULL'
        )
        .get(videoId, sourceName)
    : db
        .prepare(
          'SELECT COUNT(*) AS n FROM video_external_stats WHERE video_id = ? AND rating_average IS NOT NULL'
        )
        .get(videoId)
  return (row as { n: number }).n
}

function listVideoAssetPaths(videoId: number, type: string): Array<string | null> {
  return getDb()
    .prepare(
      'SELECT local_path FROM video_assets WHERE video_id = ? AND type = ? ORDER BY position, id'
    )
    .all(videoId, type)
    .map((row) => (row as { local_path: string | null }).local_path)
}

function hasVideoSampleLink(videoId: number): boolean {
  return Boolean(
    getDb()
      .prepare(
        `SELECT 1 AS n FROM video_assets
         WHERE video_id = ? AND type = 'sample'
           AND (
             (local_path IS NOT NULL AND trim(local_path) != '')
             OR (remote_url IS NOT NULL AND trim(remote_url) != '')
           )
         LIMIT 1`
      )
      .get(videoId)
  )
}

function isVideoFieldEmptyForFill(
  video: Video,
  field: VideoScrapeField,
  femaleCastCount: number,
  maleCastCount: number,
  tagCount: number,
  sourceName?: string,
  ratingSourceName?: string
): boolean {
  switch (field) {
    case 'title':
      return isBlankText(video.title)
    case 'summary':
      return isBlankText(video.summary)
    case 'cover':
      return isBlankText(video.cover_path)
    case 'releaseDate':
      return isBlankText(video.release_date)
    case 'maker':
      return video.maker_organization_id == null
    case 'publisher':
      return video.publisher_organization_id == null
    case 'series':
      return video.series_id == null
    case 'director':
      return video.director_id == null
    case 'duration':
      return video.duration_seconds == null
    case 'actressesFemale':
      return femaleCastCount === 0
    case 'actressesMale':
      return maleCastCount === 0
    case 'tags':
      return tagCount === 0
    case 'source':
      return countVideoSources(video.id, sourceName) === 0
    case 'rating':
      return countVideoExternalStats(video.id, ratingSourceName ?? sourceName) === 0
    case 'samples':
      return !hasVideoSampleLink(video.id)
    default:
      return false
  }
}

/**
 * In fillEmpty mode, keep only selected fields that are currently empty on the video.
 * Cast fields apply only when the video has no linked performers (no female and no male).
 */
export function resolveEffectiveScrapeFields(
  videoId: number,
  fields: VideoScrapeField[],
  mode: VideoScrapeUpdateMode = 'replace',
  sourceName?: string,
  ratingSourceName?: string
): VideoScrapeField[] {
  if (mode !== 'fillEmpty') return fields
  const video = getVideoById(videoId)
  if (!video) return []
  const requested = new Set(fields)
  const femaleCastCount = requested.has('actressesFemale')
    ? countVideoCastByGender(videoId, 'female')
    : 0
  const maleCastCount = requested.has('actressesMale')
    ? countVideoCastByGender(videoId, 'male')
    : 0
  const tagCount = requested.has('tags') ? countScrapedVideoTags(videoId) : 0
  return fields.filter((field) =>
    isVideoFieldEmptyForFill(
      video,
      field,
      femaleCastCount,
      maleCastCount,
      tagCount,
      sourceName,
      ratingSourceName
    )
  )
}

function nowIso(): string {
  return new Date().toISOString()
}

function upsertVideoAsset(
  videoId: number,
  asset: {
    type: string
    position: number
    remoteUrl: string | null
    localPath: string | null
    isPrimary: number
    createdAt: string
  }
): void {
  const db = getDb()
  if (asset.isPrimary) {
    db.prepare('UPDATE video_assets SET is_primary = 0 WHERE video_id = ? AND type = ?').run(
      videoId,
      asset.type
    )
  }
  db.prepare(
    `INSERT INTO video_assets
       (video_id, type, position, remote_url, local_path, is_primary, created_at)
     VALUES (@videoId, @type, @position, @remoteUrl, @localPath, @isPrimary, @createdAt)`
  ).run({ videoId, ...asset })
}

function clearVideoPosterForPaths(videoId: number, paths: Array<string | null>): void {
  const db = getDb()
  const clear = db.prepare('UPDATE videos SET poster_path = NULL WHERE id = ? AND poster_path = ?')
  for (const path of paths) {
    if (path) clear.run(videoId, path)
  }
}

function replaceVideoAssets(
  videoId: number,
  type: string,
  assets: Array<{
    type: string
    position: number
    remoteUrl: string | null
    localPath: string | null
    isPrimary: number
    createdAt: string
  }>
): Array<string | null> {
  const db = getDb()
  const old = db
    .prepare('SELECT local_path FROM video_assets WHERE video_id = ? AND type = ?')
    .all(videoId, type) as { local_path: string | null }[]
  clearVideoPosterForPaths(videoId, old.map((row) => row.local_path))
  db.prepare('DELETE FROM video_assets WHERE video_id = ? AND type = ?').run(videoId, type)
  for (const asset of assets) {
    upsertVideoAsset(videoId, asset)
  }
  return old.map((row) => row.local_path)
}

function upsertVideoSource(
  videoId: number,
  source: string,
  result: ScrapeResult,
  fetchedAt: string
): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO video_sources
       (video_id, source, external_code, url, title, fetched_at)
     VALUES (@videoId, @source, @externalCode, @url, @title, @fetchedAt)
     ON CONFLICT(video_id, source) DO UPDATE SET
       external_code = excluded.external_code,
       url = excluded.url,
       title = excluded.title,
       fetched_at = excluded.fetched_at`
  ).run({
    videoId,
    source,
    externalCode: result.code || null,
    url: result.sourceUrl ?? null,
    title: result.title ?? null,
    fetchedAt
  })
}

function deleteVideoSource(videoId: number, source: string): void {
  getDb()
    .prepare('DELETE FROM video_sources WHERE video_id = ? AND source = ?')
    .run(videoId, source)
}

function upsertVideoExternalStats(
  videoId: number,
  source: string,
  result: ScrapeResult,
  fetchedAt: string
): void {
  if (result.ratingAverage === undefined && result.ratingCount === undefined) return
  const db = getDb()
  db.prepare(
    `INSERT INTO video_external_stats
       (video_id, source, rating_average, rating_count, fetched_at)
     VALUES (@videoId, @source, @ratingAverage, @ratingCount, @fetchedAt)
     ON CONFLICT(video_id, source) DO UPDATE SET
       rating_average = excluded.rating_average,
       rating_count = excluded.rating_count,
       fetched_at = excluded.fetched_at`
  ).run({
    videoId,
    source,
    ratingAverage: result.ratingAverage ?? null,
    ratingCount: result.ratingCount ?? null,
    fetchedAt
  })
}

function deleteVideoExternalStats(videoId: number, source: string): void {
  const db = getDb()
  db.prepare('DELETE FROM video_external_stats WHERE video_id = ? AND source = ?').run(
    videoId,
    source
  )
}

export type VideoScrapeImpactAction = 'preserve' | 'set' | 'replace' | 'clear'
export type VideoScrapeImpactReason =
  | 'replace'
  | 'fillEmpty'
  | 'replaceIfPresent'
  | 'existingValue'
  | 'noValue'
  | 'resourceUnavailable'
  | 'sameEntity'
  | 'ambiguous'
  | 'invalidName'

export interface VideoClassificationResolutionOptions {
  directorSelectionId?: number
  directorAmbiguity?: 'choice' | 'preserve'
}

type PlannedEntityReference =
  | { referenceKind: 'existing'; entityId: number }
  | { referenceKind: 'create'; createName: string }

type PlannedClassificationAssignment =
  | { kind: 'clear' }
  | ({ kind: 'organization'; role: 'maker' | 'publisher' } & PlannedEntityReference)
  | ({ kind: 'director' } & PlannedEntityReference)
  | ({ kind: 'series' } & PlannedEntityReference)

export interface VideoScrapeFieldImpact {
  field: VideoScrapeField
  action: VideoScrapeImpactAction
  reason: VideoScrapeImpactReason
  currentValue: unknown
  nextValue: unknown
  sourceName?: string
}

export interface VideoScrapeApplicationPlan {
  effectiveFields: VideoScrapeField[]
  impacts: VideoScrapeFieldImpact[]
  shouldApply: boolean
  warnings: string[]
  classifications: VideoClassificationResolutionOutcome[]
  directorChoice?: VideoDirectorChoiceRequired
  classificationAssignments: Map<VideoClassificationField, PlannedClassificationAssignment>
}

function normalizedScrapeText(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

const CLASSIFICATION_FIELDS: VideoClassificationField[] = [
  'maker',
  'publisher',
  'series',
  'director'
]

function currentClassificationId(video: Video, field: VideoClassificationField): number | null {
  return {
    maker: video.maker_organization_id,
    publisher: video.publisher_organization_id,
    series: video.series_id,
    director: video.director_id
  }[field]
}

function resolveClassificationIdentity(
  field: VideoClassificationField,
  inputName: string
): ClassificationIdentityResolution {
  if (field === 'maker' || field === 'publisher') return resolveOrganizationIdentity(inputName)
  if (field === 'series') return resolveSeriesIdentity(inputName)
  return resolveDirectorIdentity(inputName)
}

function plannedEntityAssignment(
  field: VideoClassificationField,
  reference: PlannedEntityReference
): PlannedClassificationAssignment {
  if (field === 'maker' || field === 'publisher') {
    return { kind: 'organization', role: field, ...reference }
  }
  return field === 'series'
    ? { kind: 'series', ...reference }
    : { kind: 'director', ...reference }
}

function ambiguousWarning(
  field: VideoClassificationField,
  inputName: string,
  candidateCount: number
): string {
  return `${classificationFieldLabel(field)}“${inputName}”匹配到 ${candidateCount} 个候选，` +
    `已保留现有关联；请先手动选择或合并重复${classificationFieldLabel(field)}`
}

function planClassificationResolutions(
  video: Video,
  impacts: VideoScrapeFieldImpact[],
  warnings: string[],
  options: VideoClassificationResolutionOptions
): {
  classifications: VideoClassificationResolutionOutcome[]
  directorChoice?: VideoDirectorChoiceRequired
  assignments: Map<VideoClassificationField, PlannedClassificationAssignment>
} {
  const classifications: VideoClassificationResolutionOutcome[] = []
  const assignments = new Map<VideoClassificationField, PlannedClassificationAssignment>()
  let directorChoice: VideoDirectorChoiceRequired | undefined
  for (const field of CLASSIFICATION_FIELDS) {
    const impact = impacts.find((item) => item.field === field)
    if (!impact || impact.action === 'preserve') continue
    const inputName = typeof impact.nextValue === 'string' ? impact.nextValue : null
    if (impact.action === 'clear' || !inputName) {
      assignments.set(field, { kind: 'clear' })
      classifications.push({ field, status: 'cleared', inputName: null, entityId: null })
      continue
    }

    const resolution = resolveClassificationIdentity(field, inputName)
    const currentId = currentClassificationId(video, field)
    if (resolution.status === 'invalid') {
      impact.action = 'preserve'
      impact.reason = 'invalidName'
      const message = `${classificationFieldLabel(field)}名称无效：${resolution.message}`
      warnings.push(message)
      classifications.push({
        field,
        status: 'invalid',
        inputName,
        entityId: currentId,
        message
      })
      continue
    }
    if (resolution.status === 'notFound') {
      assignments.set(
        field,
        plannedEntityAssignment(field, { referenceKind: 'create', createName: inputName })
      )
      classifications.push({ field, status: 'create', inputName, entityId: null })
      continue
    }

    const candidates =
      resolution.status === 'unique' ? [resolution.candidate] : resolution.candidates
    const explicitlySelected =
      field === 'director' && options.directorSelectionId != null
        ? candidates.find((candidate) => candidate.id === options.directorSelectionId)
        : undefined
    if (field === 'director' && options.directorSelectionId != null && !explicitlySelected) {
      throw new Error('所选导演不再匹配本次刮削名称，请重新选择')
    }
    const currentCandidate = candidates.find((candidate) => candidate.id === currentId)
    const selected = explicitlySelected ?? currentCandidate
    if (selected) {
      if (selected.id === currentId) {
        impact.action = 'preserve'
        impact.reason = 'sameEntity'
        classifications.push({
          field,
          status: 'preserved',
          inputName,
          entityId: selected.id
        })
      } else {
        assignments.set(
          field,
          plannedEntityAssignment(field, { referenceKind: 'existing', entityId: selected.id })
        )
        classifications.push({ field, status: 'matched', inputName, entityId: selected.id })
      }
      continue
    }

    if (resolution.status === 'unique') {
      const candidate = resolution.candidate
      assignments.set(
        field,
        plannedEntityAssignment(field, { referenceKind: 'existing', entityId: candidate.id })
      )
      classifications.push({ field, status: 'matched', inputName, entityId: candidate.id })
      continue
    }

    impact.action = 'preserve'
    impact.reason = 'ambiguous'
    classifications.push({
      field,
      status: 'ambiguous',
      inputName,
      entityId: currentId,
      candidates: resolution.candidates
    })
    if (field === 'director' && options.directorAmbiguity === 'choice') {
      directorChoice = { scrapedName: inputName, candidates: resolution.candidates }
    } else {
      warnings.push(ambiguousWarning(field, inputName, resolution.candidates.length))
    }
  }
  return { classifications, directorChoice, assignments }
}

/** Build a read-only field plan before any database row or asset reference is changed. */
export function planVideoScrapeResult(
  videoId: number,
  result: ScrapeResult,
  coverRelPath: string | null,
  sampleRelPaths: Array<string | null> = [],
  fields?: VideoScrapeField[],
  sourceName?: string,
  mode: VideoScrapeUpdateMode = 'replace',
  ratingSourceName?: string,
  classificationOptions: VideoClassificationResolutionOptions = {}
): VideoScrapeApplicationPlan {
  const requested = fields ?? ALL_VIDEO_SCRAPE_FIELDS
  const effectiveFields = resolveEffectiveScrapeFields(
    videoId,
    requested,
    mode,
    sourceName,
    ratingSourceName
  )
  const effective = new Set(effectiveFields)
  const video = getVideoById(videoId)
  const warnings: string[] = []
  const cast = result.actresses ?? []
  const sampleUrls = (result.sampleImageUrls ?? []).filter((url) =>
    Boolean(normalizedScrapeText(url))
  )
  const samplesReady =
    sampleUrls.length > 0 &&
    sampleRelPaths.length === sampleUrls.length &&
    sampleRelPaths.every((assetPath) => Boolean(assetPath))
  const coverUnavailable =
    effective.has('cover') && Boolean(normalizedScrapeText(result.coverUrl)) && !coverRelPath
  const samplesUnavailable = effective.has('samples') && sampleUrls.length > 0 && !samplesReady
  if (coverUnavailable) warnings.push('封面下载失败，已保留原封面')
  if (samplesUnavailable) warnings.push('样张下载不完整，已保留原样张')

  const durationValue =
    typeof result.durationSeconds === 'number' &&
    Number.isFinite(result.durationSeconds) &&
    result.durationSeconds >= 0
      ? result.durationSeconds
      : null
  const ratingValue =
    typeof result.ratingAverage === 'number' && Number.isFinite(result.ratingAverage)
      ? result.ratingAverage
      : null
  const values = new Map<VideoScrapeField, unknown>([
    ['title', normalizedScrapeText(result.title)],
    ['summary', normalizedScrapeText(result.summary)],
    ['cover', coverRelPath],
    ['releaseDate', normalizedScrapeText(result.releaseDate)],
    ['maker', normalizedScrapeText(result.maker)],
    ['publisher', normalizedScrapeText(result.publisher)],
    ['series', normalizedScrapeText(result.series)],
    ['director', normalizedScrapeText(result.director)],
    ['duration', durationValue],
    ['actressesFemale', cast.filter((item) => scrapedCastGender(item) === 'female')],
    ['actressesMale', cast.filter((item) => scrapedCastGender(item) === 'male')],
    ['tags', result.tags ?? []],
    ['source', normalizedScrapeText(result.sourceUrl)],
    ['rating', ratingValue],
    ['samples', samplesReady ? sampleRelPaths : []]
  ])
  const currentValues = new Map<VideoScrapeField, unknown>([
    ['title', video?.title ?? null],
    ['summary', video?.summary ?? null],
    ['cover', video?.cover_path ?? null],
    ['releaseDate', video?.release_date ?? null],
    ['maker', video?.maker ?? null],
    ['publisher', video?.publisher ?? null],
    ['series', video?.series ?? null],
    ['director', video?.director ?? null],
    ['duration', video?.duration_seconds ?? null],
    ['actressesFemale', countVideoCastByGender(videoId, 'female')],
    ['actressesMale', countVideoCastByGender(videoId, 'male')],
    ['tags', countScrapedVideoTags(videoId)],
    ['source', countVideoSources(videoId, sourceName)],
    ['rating', countVideoExternalStats(videoId, ratingSourceName ?? sourceName)],
    ['samples', listVideoAssetPaths(videoId, 'sample')]
  ])

  const impacts = requested.map((field): VideoScrapeFieldImpact => {
    const nextValue = values.get(field) ?? null
    const isCollection = Array.isArray(nextValue)
    const hasValue = isCollection ? nextValue.length > 0 : nextValue !== null && nextValue !== undefined
    const resourceUnavailable =
      (field === 'cover' && coverUnavailable) || (field === 'samples' && samplesUnavailable)
    const missingFieldSource =
      (field === 'source' && !sourceName) ||
      (field === 'rating' && !(ratingSourceName ?? sourceName))
    let action: VideoScrapeImpactAction = 'preserve'
    let reason: VideoScrapeImpactReason = effective.has(field) ? 'noValue' : 'existingValue'
    if (effective.has(field) && missingFieldSource) {
      reason = 'noValue'
    } else if (effective.has(field) && resourceUnavailable) {
      reason = 'resourceUnavailable'
    } else if (effective.has(field) && mode === 'replace') {
      action = hasValue ? 'replace' : 'clear'
      reason = 'replace'
    } else if (effective.has(field) && hasValue) {
      action = mode === 'fillEmpty' ? 'set' : 'replace'
      reason = mode
    }
    return {
      field,
      action,
      reason,
      currentValue: currentValues.get(field) ?? null,
      nextValue,
      sourceName:
        field === 'rating'
          ? (ratingSourceName ?? sourceName)
          : field === 'source'
            ? sourceName
            : undefined
    }
  })

  const classificationPlan = video
    ? planClassificationResolutions(video, impacts, warnings, classificationOptions)
    : {
        classifications: [],
        assignments: new Map<VideoClassificationField, PlannedClassificationAssignment>()
      }

  return {
    effectiveFields,
    impacts,
    shouldApply:
      !classificationPlan.directorChoice &&
      impacts.some((impact) => impact.action !== 'preserve'),
    warnings,
    classifications: classificationPlan.classifications,
    directorChoice: classificationPlan.directorChoice,
    classificationAssignments: classificationPlan.assignments
  }
}

/** Return the conflicting video id when applying this result would complete a duplicate identity. */
export function findVideoBusinessIdentityConflictForScrape(
  videoId: number,
  result: ScrapeResult,
  fields: VideoScrapeField[],
  mode: VideoScrapeUpdateMode
): number | null {
  const video = getVideoById(videoId)
  if (!video) return null
  const plan = planVideoScrapeResult(videoId, result, null, [], fields, undefined, mode)
  let publisherId = video.publisher_organization_id
  const publisherImpact = plan.impacts.find((impact) => impact.field === 'publisher')
  if (publisherImpact && publisherImpact.action !== 'preserve') {
    if (publisherImpact.action === 'clear') {
      publisherId = null
    } else {
      publisherId =
        plan.classifications.find((outcome) => outcome.field === 'publisher')?.entityId ?? null
    }
  }
  let releaseDate = video.release_date?.trim() || null
  const releaseImpact = plan.impacts.find((impact) => impact.field === 'releaseDate')
  if (releaseImpact && releaseImpact.action !== 'preserve') {
    releaseDate =
      releaseImpact.action === 'clear' || typeof releaseImpact.nextValue !== 'string'
        ? null
        : releaseImpact.nextValue.trim() || null
  }
  if (publisherId == null || !video.code?.trim() || !releaseDate) return null
  const conflict = getDb()
    .prepare(
      `SELECT id FROM videos
       WHERE publisher_organization_id = ?
         AND upper(trim(code)) = upper(trim(?))
         AND release_date = ? AND id != ?
       ORDER BY id LIMIT 1`
    )
    .get(publisherId, video.code, releaseDate, video.id) as { id: number } | undefined
  return conflict?.id ?? null
}

/**
 * Apply a scrape result to a video, link actresses/tags, and store cover path.
 * Wrapped in a transaction so a partial failure doesn't corrupt relations.
 */
export interface ApplyVideoScrapeResult {
  applied: boolean
  warnings: string[]
  obsoleteAssetPaths: string[]
  classifications: VideoClassificationResolutionOutcome[]
  directorChoice?: VideoDirectorChoiceRequired
}

export function applyScrapeResult(
  videoId: number,
  result: ScrapeResult,
  coverRelPath: string | null,
  actressAvatars: Map<string, string | null>,
  sampleRelPaths: Array<string | null> = [],
  fields?: VideoScrapeField[],
  sourceName?: string,
  mode: VideoScrapeUpdateMode = 'replace',
  ratingSourceName?: string,
  classificationOptions: VideoClassificationResolutionOptions = {}
): ApplyVideoScrapeResult {
  const db = getDb()
  const requested = fields ?? ALL_VIDEO_SCRAPE_FIELDS
  const plan = planVideoScrapeResult(
    videoId,
    result,
    coverRelPath,
    sampleRelPaths,
    requested,
    sourceName,
    mode,
    ratingSourceName,
    classificationOptions
  )
  if (!plan.shouldApply) {
    return {
      applied: false,
      warnings: plan.warnings,
      obsoleteAssetPaths: [],
      classifications: plan.classifications,
      directorChoice: plan.directorChoice
    }
  }

  const impactFor = (field: VideoScrapeField): VideoScrapeFieldImpact | undefined =>
    plan.impacts.find((impact) => impact.field === field)
  const impactAction = (field: VideoScrapeField): VideoScrapeImpactAction =>
    impactFor(field)?.action ?? 'preserve'
  const writesField = (field: VideoScrapeField): boolean => impactAction(field) !== 'preserve'
  const existing = getVideoById(videoId)
  if (!existing) {
    return {
      applied: false,
      warnings: [],
      obsoleteAssetPaths: [],
      classifications: []
    }
  }
  const cleanupHints = collectVideoLibraryCleanupHints(videoId)
  const scrapedAt = nowIso()
  const warnings = plan.warnings
  const scalarColumns: Partial<Record<VideoScrapeField, { column: string; bindKey: string }>> = {
    title: { column: 'title', bindKey: 'title' },
    summary: { column: 'summary', bindKey: 'summary' },
    releaseDate: { column: 'release_date', bindKey: 'release_date' },
    duration: { column: 'duration_seconds', bindKey: 'duration_seconds' }
  }
  const scalarWrites = plan.impacts.flatMap((impact) => {
    const metadata = scalarColumns[impact.field]
    return metadata && impact.action !== 'preserve'
      ? [{ field: impact.field, value: impact.nextValue, ...metadata }]
      : []
  })

  const cast = result.actresses ?? []
  const writeFemale = writesField('actressesFemale')
  const writeMale = writesField('actressesMale')
  const writeTags = writesField('tags')

  const sourceUrl = (impactFor('source')?.nextValue as string | null | undefined) ?? null
  const writeSource = Boolean(sourceName && writesField('source'))
  const ratingValue = (impactFor('rating')?.nextValue as number | null | undefined) ?? null
  const statsSource = ratingSourceName ?? sourceName
  const writeRating = Boolean(statsSource && writesField('rating'))

  const writeCover = writesField('cover')

  const sampleUrls = (result.sampleImageUrls ?? []).filter((url) =>
    Boolean(normalizedScrapeText(url))
  )
  const writeSamples = writesField('samples')

  const oldAssetPaths: Array<string | null> = []

  const txn = db.transaction(() => {
    const assignments: string[] = []
    const bind: Record<string, unknown> = { id: videoId }

    for (const { field, column, bindKey, value } of scalarWrites) {
      assignments.push(`${column} = @${bindKey}`)
      bind[bindKey] = value
      if (field === 'title') {
        assignments.push('original_title = @original_title')
        bind.original_title = value
      }
    }

    if (writeCover) {
      assignments.push('cover_path = @cover_path')
      bind.cover_path = coverRelPath
      oldAssetPaths.push(existing.cover_path)
      oldAssetPaths.push(
        ...replaceVideoAssets(
          videoId,
          'cover',
          coverRelPath
            ? [
                {
                  type: 'cover',
                  position: 0,
                  remoteUrl: result.coverUrl ?? null,
                  localPath: coverRelPath,
                  isPrimary: 1,
                  createdAt: scrapedAt
                }
              ]
            : []
        )
      )
    }

    if (assignments.length > 0) {
      db.prepare(`UPDATE videos SET ${assignments.join(', ')} WHERE id = @id`).run(bind)
    }

    for (const [field, assignment] of plan.classificationAssignments) {
      let entityId: number | null = null
      if (assignment.kind === 'clear') {
        if (field === 'maker' || field === 'publisher') {
          classificationMaintenanceService.assignVideoOrganization(videoId, field, null)
        } else if (field === 'director') {
          classificationMaintenanceService.assignVideoDirector(videoId, null)
        } else {
          classificationMaintenanceService.assignVideoSeries(videoId, null)
        }
      } else if (assignment.kind === 'organization') {
        const resolved = classificationMaintenanceService.assignVideoOrganization(
          videoId,
          assignment.role,
          assignment.referenceKind === 'existing'
            ? { organizationId: assignment.entityId }
            : { createName: assignment.createName }
        )
        entityId = resolved.organizationId
      } else if (assignment.kind === 'director') {
        const resolved = classificationMaintenanceService.assignVideoDirector(
          videoId,
          assignment.referenceKind === 'existing'
            ? { directorId: assignment.entityId }
            : { createName: assignment.createName }
        )
        entityId = resolved.directorId
      } else {
        const resolved = classificationMaintenanceService.assignVideoSeries(
          videoId,
          assignment.referenceKind === 'existing'
            ? { seriesId: assignment.entityId }
            : { createName: assignment.createName }
        )
        entityId = resolved.seriesId
      }
      const outcome = plan.classifications.find((item) => item.field === field)
      if (outcome && outcome.status === 'create') {
        outcome.status = 'created'
        outcome.entityId = entityId
      }
    }

    if (writeFemale) {
      removeVideoActressesByGender(videoId, 'female')
      linkScrapedCastByGender(videoId, cast, 'female', actressAvatars)
    }
    if (writeMale) {
      removeVideoActressesByGender(videoId, 'male')
      linkScrapedCastByGender(videoId, cast, 'male', actressAvatars)
    }

    if (writeTags) {
      replaceVideoTagsByOrigin(videoId, result.tags ?? [], 'scraped', sourceName ?? null, scrapedAt)
    }

    if (writeSamples) {
      oldAssetPaths.push(
        ...replaceVideoAssets(
          videoId,
          'sample',
          sampleUrls.map((url, index) => ({
            type: 'sample',
            position: index,
            remoteUrl: url,
            localPath: sampleRelPaths[index]!,
            isPrimary: 0,
            createdAt: scrapedAt
          }))
        )
      )
    }

    if (writeSource && sourceName) {
      if (sourceUrl) upsertVideoSource(videoId, sourceName, result, scrapedAt)
      else deleteVideoSource(videoId, sourceName)
    }

    if (writeRating && statsSource) {
      if (ratingValue !== null) {
        upsertVideoExternalStats(videoId, statsSource, result, scrapedAt)
      } else {
        deleteVideoExternalStats(videoId, statsSource)
      }
    }

    db.prepare(
      'UPDATE videos SET scraped_status = 1, last_scraped_at = ?, updated_at = ? WHERE id = ?'
    ).run(scrapedAt, scrapedAt, videoId)
  })

  txn()

  const obsoleteAssetPaths = Array.from(new Set(oldAssetPaths)).filter(
    (assetPath): assetPath is string =>
      Boolean(assetPath && assetPath !== coverRelPath && !sampleRelPaths.includes(assetPath))
  )

  try {
    runLibraryCleanup(cleanupHints)
  } catch (error) {
    console.error('Post-commit library cleanup failed:', error)
  }
  return {
    applied: true,
    warnings,
    obsoleteAssetPaths,
    classifications: plan.classifications
  }
}

export function resolveEffectiveVideoScrapeFields(
  videoId: number,
  fields: VideoScrapeField[],
  mode: VideoScrapeUpdateMode = 'replace',
  sourceName?: string,
  ratingSourceName?: string
): VideoScrapeField[] {
  return resolveEffectiveScrapeFields(videoId, fields, mode, sourceName, ratingSourceName)
}

export function resolveVideoBatchTargets(
  filter: VideoBatchScrapeFilter
): Array<{ id: number; code: string }> {
  // Explicit videoIds (library multi-select) are the scope — do not further
  // filter by missingFields. Settings full-library batches pass status +
  // missingFields without videoIds.
  if (filter.videoIds) {
    return listVideosForBatchScrape({ ...filter, missingFields: [] })
  }
  return listVideosForBatchScrape(filter)
}

/** Apply entry used by deliver; tests may replace this to force apply-phase failures. */
export const videoScrapeApplyBridge = {
  applyScrapeResult
}

export interface VideoScrapeDeliverInput {
  videoId: number
  code: string
  result: ScrapeResult
  selectedFields: VideoScrapeField[]
  fieldsToApply: VideoScrapeField[]
  mode: VideoScrapeUpdateMode
  sourceName?: string
  ratingSourceName?: string
  classificationOptions?: VideoClassificationResolutionOptions
  fetcher: (url: string) => Promise<Buffer>
  /** Runs in the same database transaction after a successful application. */
  afterSuccessfulApply?: () => void
}

export interface VideoScrapeDeliverOutcome {
  applied: boolean
  warnings: string[]
  classifications: VideoClassificationResolutionOutcome[]
  directorChoice?: VideoDirectorChoiceRequired
}

export interface VideoScrapeApplyService {
  resolveEffectiveFields(
    videoId: number,
    fields: VideoScrapeField[],
    mode?: VideoScrapeUpdateMode,
    sourceName?: string,
    ratingSourceName?: string
  ): VideoScrapeField[]
  resolveBatchTargets(filter: VideoBatchScrapeFilter): Array<{ id: number; code: string }>
  preflightClassifications(
    videoId: number,
    result: ScrapeResult,
    fields: VideoScrapeField[],
    mode: VideoScrapeUpdateMode,
    options?: VideoClassificationResolutionOptions
  ): VideoScrapeApplicationPlan
  plan: typeof planVideoScrapeResult
  apply: typeof applyScrapeResult
  deliverParsedResult(input: VideoScrapeDeliverInput): Promise<VideoScrapeDeliverOutcome>
}

interface VideoScrapeApplyServiceDependencies {
  resolveEffectiveFields: typeof resolveEffectiveVideoScrapeFields
  resolveBatchTargets: typeof resolveVideoBatchTargets
  plan: typeof planVideoScrapeResult
  apply: typeof applyScrapeResult
  coordinateDatabaseChange: typeof mediaAssetStore.coordinateDatabaseChange
  downloadCover: typeof mediaAssetStore.downloadCover
  downloadAvatar: typeof mediaAssetStore.downloadAvatar
  downloadSamples: typeof mediaAssetStore.downloadSamples
  deleteBestEffort: typeof mediaAssetStore.deleteBestEffort
  findActressByNameOrAlias: typeof findActressByNameOrAlias
  adoptDownloadedAvatarIfMissing: typeof adoptDownloadedAvatarIfMissing
}

export function createVideoScrapeApplyService(
  dependencies: Partial<VideoScrapeApplyServiceDependencies> = {}
): VideoScrapeApplyService {
  const resolveEffectiveFields =
    dependencies.resolveEffectiveFields ?? resolveEffectiveVideoScrapeFields
  const resolveBatchTargets = dependencies.resolveBatchTargets ?? resolveVideoBatchTargets
  const plan = dependencies.plan ?? planVideoScrapeResult
  const apply =
    dependencies.apply ??
    ((...args: Parameters<typeof applyScrapeResult>) =>
      videoScrapeApplyBridge.applyScrapeResult(...args))
  const coordinateDatabaseChange =
    dependencies.coordinateDatabaseChange ??
    mediaAssetStore.coordinateDatabaseChange.bind(mediaAssetStore)
  const downloadCover =
    dependencies.downloadCover ?? mediaAssetStore.downloadCover.bind(mediaAssetStore)
  const downloadAvatar =
    dependencies.downloadAvatar ?? mediaAssetStore.downloadAvatar.bind(mediaAssetStore)
  const downloadSamples =
    dependencies.downloadSamples ?? mediaAssetStore.downloadSamples.bind(mediaAssetStore)
  const deleteBestEffort =
    dependencies.deleteBestEffort ?? mediaAssetStore.deleteBestEffort.bind(mediaAssetStore)
  const findActress = dependencies.findActressByNameOrAlias ?? findActressByNameOrAlias
  const adoptAvatar =
    dependencies.adoptDownloadedAvatarIfMissing ?? adoptDownloadedAvatarIfMissing

  return {
    resolveEffectiveFields,
    resolveBatchTargets,
    preflightClassifications(videoId, result, fields, mode, options) {
      return plan(
        videoId,
        result,
        null,
        [],
        fields.filter((field): field is VideoClassificationField =>
          CLASSIFICATION_FIELDS.includes(field as VideoClassificationField)
        ),
        undefined,
        mode,
        undefined,
        options
      )
    },
    plan,
    apply: (...args) => apply(...args),
    async deliverParsedResult(input): Promise<VideoScrapeDeliverOutcome> {
      const selected = new Set(input.selectedFields)
      const downloads = await coordinateDatabaseChange(async () => {
        let coverRel: string | null = null
        let sampleRels: Array<string | null> = []
        const avatarMap = new Map<string, string | null>()

        if (selected.has('cover') && input.result.coverUrl) {
          coverRel = await downloadCover(
            input.result.code || input.code,
            input.result.coverUrl,
            input.fetcher
          )
        }

        const wantsFemale = selected.has('actressesFemale')
        const wantsMale = selected.has('actressesMale')
        if (wantsFemale || wantsMale) {
          for (const a of input.result.actresses ?? []) {
            const gender = a.gender ?? 'female'
            if (gender === 'female' && !wantsFemale) continue
            if (gender === 'male' && !wantsMale) continue
            if (a.avatarUrl) {
              const rel = await downloadAvatar(a.name, a.avatarUrl, input.fetcher)
              avatarMap.set(a.name, rel)
            }
          }
        }

        if (selected.has('samples') && input.result.sampleImageUrls?.length) {
          sampleRels = await downloadSamples(
            input.result.code || input.code,
            input.result.sampleImageUrls,
            input.fetcher
          )
          if (sampleRels.some((assetPath) => !assetPath)) {
            for (const assetPath of sampleRels) deleteBestEffort(assetPath)
            sampleRels = input.result.sampleImageUrls.map(() => null)
          }
        }

        return { coverRel, sampleRels, avatarMap }
      })

      const downloadedPaths = [
        downloads.coverRel,
        ...downloads.sampleRels,
        ...downloads.avatarMap.values()
      ].filter((assetPath): assetPath is string => Boolean(assetPath))

      let application: ApplyVideoScrapeResult
      try {
        application = coordinateDatabaseChange(() =>
          getDb().transaction(() => {
            const applied = apply(
              input.videoId,
              input.result,
              downloads.coverRel,
              downloads.avatarMap,
              downloads.sampleRels,
              input.fieldsToApply,
              input.sourceName,
              input.mode,
              input.ratingSourceName,
              input.classificationOptions
            )
            if (applied.applied) input.afterSuccessfulApply?.()
            for (const assetPath of applied.obsoleteAssetPaths) {
              deleteBestEffort(assetPath)
            }
            return applied
          })()
        )
      } catch (applyError) {
        for (const assetPath of downloadedPaths) deleteBestEffort(assetPath)
        throw applyError
      }

      if (!application.applied) {
        for (const assetPath of downloadedPaths) deleteBestEffort(assetPath)
      } else {
        for (const [name, avatarPath] of downloads.avatarMap) {
          if (!avatarPath) continue
          const actressId = findActress(name)
          if (actressId == null) {
            deleteBestEffort(avatarPath)
            continue
          }
          try {
            adoptAvatar(actressId, avatarPath)
          } catch (error) {
            deleteBestEffort(avatarPath)
            application.warnings.push(
              `演员「${name}」头像未应用：${(error as Error).message}`
            )
          }
        }
      }

      return {
        applied: application.applied,
        warnings: application.warnings,
        classifications: application.classifications,
        directorChoice: application.directorChoice
      }
    }
  }
}

export const videoScrapeApplyService = createVideoScrapeApplyService()
