import type { ActressConflictQueueItem, ActressConflictQueuePage, ActressConflictQueueQuery, ActressConflictCurrentOwner, ActressConflictDecisionSnapshot, ActressConflictReviewSummary, ActressNameConflictGroup, ActressPendingNameType, DiscardPendingActressScrapeInput, DiscardPendingActressScrapeResult, InspectActressConflictNameInput, InspectActressConflictNameResult, PendingActressNameClaim, PendingActressScrapeCandidate, PendingActressScrapeResource, ResolveActressConflictInput, ResolveActressConflictResult, ValidateIllegalNameReplacementsInput, ValidateIllegalNameReplacementsResult } from '@shared/actressConflictTypes'
import type { ActressScrapeDisposition, ActressScrapeField, ActressScrapePluginRef, ActressScrapeResult, ActressScrapeUpdateMode } from '@shared/actressScrapeTypes'
import { getDatabaseReadRevision, getDb } from '@library/db/database'
import { normalizeActressName } from '@library/db/actressNameNormalization'
import {
  markActressScrapeSucceeded,
  recordActressScrapeFailure
} from '@library/db/actressRepo'
import {
  applyActressScrapeResult,
  mergeActressesWithAssets,
  planActressScrapeResult
} from './actressAssetService'
import { synchronizeActressNameOwnership } from '@library/db/actressNameOwnership'
import { setActressTypedName, upsertActressName } from '@library/db/actressNames'
import { mediaAssetStore } from './mediaAssetStore'

export interface PreparedActressScrapeResource {
  field: 'avatar' | 'gallery'
  position: number
  remoteUrl?: string
  data: Buffer
  width?: number | null
  height?: number | null
}

export interface PreparedActressScrape {
  actressId: number
  plugin: ActressScrapePluginRef
  queryName: string
  selectedFields: ActressScrapeField[]
  applicableFields: ActressScrapeField[]
  mode: ActressScrapeUpdateMode
  result: ActressScrapeResult
  warnings: string[]
  resources: PreparedActressScrapeResource[]
  batchJobId?: string
}

interface PendingName {
  name: string
  normalizedName: string
  type: ActressPendingNameType
}

interface PendingRow {
  id: number
  actress_id: number
  revision: number
  target_actress_revision: number
  plugin_name: string
  plugin_source: ActressScrapePluginRef['source']
  plugin_version: string | null
  query_name: string
  selected_fields_json: string
  applicable_fields_json: string
  update_mode: ActressScrapeUpdateMode
  result_json: string
  warnings_json: string
  batch_job_id: string | null
  created_at: string
  main_name: string
  avatar_path: string | null
  current_actress_revision: number
}

interface PendingResourceRow {
  pending_scrape_id: number
  field: PendingActressScrapeResource['field']
  position: number
  remote_url: string | null
  staged_path: string
  width: number | null
  height: number | null
}

interface PendingNameClaimRow {
  id: number
  normalized_name: string
  actress_id: number
  name: string
  type: string
  locale: string | null
  source: string | null
  is_primary: number
}

function canonicalPendingNameType(type: string): ActressPendingNameType {
  switch (type) {
    case 'main':
    case 'alias':
    case 'zh':
    case 'en':
      return type
    case 'chinese':
      return 'zh'
    case 'english':
    case 'romaji':
      return 'en'
    case 'former':
    case 'native':
      return 'alias'
    default:
      throw new Error(`不支持的待确认名称类型：${type}`)
  }
}

interface PreparedPendingFormalResources {
  avatarRelPath: string | null
  galleryAssets: Array<{
    remoteUrl: string
    localPath: string
    width: number | null
    height: number | null
  }>
  stagedPaths: string[]
}

function stagePreparedResources(
  resources: PreparedActressScrapeResource[]
): PendingActressScrapeResource[] {
  return mediaAssetStore.stageActressScrapeImages(resources)
}

function cleanupStagedResourcePaths(stagedPaths: string[]): void {
  mediaAssetStore.cleanupActressScrapeStagingPaths(stagedPaths)
}

/** Remove crash leftovers while preserving every referenced or recently written staging dir. */
export function cleanupOrphanedActressScrapeStaging(options?: {
  now?: number
  olderThanMs?: number
}): number {
  const referencedPaths = (
    getDb().prepare(
      `SELECT staged_path FROM pending_actress_scrape_resources
       UNION
       SELECT r.staged_path
         FROM agent_metadata_draft_resources r
         JOIN agent_metadata_drafts d ON d.id = r.draft_id
        WHERE d.status = 'ready' AND r.field IN ('avatar', 'gallery')`
    ).all() as Array<{
      staged_path: string
    }>
  ).map((row) => row.staged_path)
  return mediaAssetStore.cleanupOrphanedActressScrapeStaging(referencedPaths, options)
}

function namesFromPreparedScrape(input: PreparedActressScrape): PendingName[] {
  return namesFromResult(input.applicableFields, input.result)
}

function namesFromResult(
  applicableFields: ActressScrapeField[],
  scrapeResult: ActressScrapeResult
): PendingName[] {
  const selected = new Set(applicableFields)
  const names: Array<{ name: string | undefined; type: ActressPendingNameType }> = []
  if (selected.has('nameZh')) names.push({ name: scrapeResult.nameZh, type: 'zh' })
  if (selected.has('nameEn')) names.push({ name: scrapeResult.nameEn, type: 'en' })
  if (selected.has('aliases')) {
    for (const name of scrapeResult.aliases ?? []) names.push({ name, type: 'alias' })
  }

  const seen = new Set<string>()
  const result: PendingName[] = []
  for (const item of names) {
    const name = item.name?.trim()
    if (!name) continue
    const normalizedName = normalizeActressName(name)
    const key = `${normalizedName}\0${item.type}\0${name}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ name, normalizedName, type: item.type })
  }
  return result
}

function conflictingNames(
  actressId: number,
  names: PendingName[],
  pendingId?: number
): PendingName[] {
  const db = getDb()
  const ownerQuery = db.prepare(
    'SELECT actress_id FROM actress_name_ownership WHERE normalized_name = ?'
  )
  const pendingClaimQuery = db.prepare(
    `SELECT 1 FROM pending_actress_name_claims
     WHERE normalized_name = ? AND actress_id != ? LIMIT 1`
  )
  const otherPendingQuery = db.prepare(
    `SELECT 1
     FROM pending_actress_scrape_conflicts c
     JOIN pending_actress_scrapes p ON p.id = c.pending_scrape_id
     WHERE c.normalized_name = ?
       AND (? IS NULL OR c.pending_scrape_id != ?)
       AND p.actress_id != ?
     LIMIT 1`
  )
  return names.filter((name) => {
    const owner = ownerQuery.get(name.normalizedName) as { actress_id: number } | undefined
    if (owner && owner.actress_id !== actressId) return true
    if (pendingClaimQuery.get(name.normalizedName, actressId)) return true
    return Boolean(
      otherPendingQuery.get(name.normalizedName, pendingId ?? null, pendingId ?? null, actressId)
    )
  })
}

export function findActressScrapeNameConflicts(
  actressId: number,
  fields: ActressScrapeField[],
  result: ActressScrapeResult
): Array<{ name: string; normalizedName: string; type: ActressPendingNameType }> {
  return conflictingNames(actressId, namesFromResult(fields, result))
}

function readNameClaimants(normalizedName: string): ActressConflictCurrentOwner[] {
  const rows = getDb()
    .prepare(
      `SELECT a.id AS actress_id, a.revision, a.main_name, a.avatar_path, n.type,
              EXISTS(
                SELECT 1 FROM pending_actress_scrapes p WHERE p.actress_id = a.id
              ) AS has_pending_scrape
       FROM actress_names n
       JOIN actresses a ON a.id = n.actress_id
       WHERE normalize_actress_name(n.name) = ?
       ORDER BY a.id, n.type`
    )
    .all(normalizedName) as Array<{
    actress_id: number
    revision: number
    main_name: string
    avatar_path: string | null
    type: string
    has_pending_scrape: number
  }>
  const claimants = new Map<number, ActressConflictCurrentOwner>()
  for (const row of rows) {
    let claimant = claimants.get(row.actress_id)
    if (!claimant) {
      claimant = {
        actressId: row.actress_id,
        revision: row.revision,
        mainName: row.main_name,
        avatarPath: row.avatar_path,
        nameTypes: [],
        hasPendingScrape: Boolean(row.has_pending_scrape)
      }
      claimants.set(row.actress_id, claimant)
    }
    const nameType = canonicalPendingNameType(row.type)
    if (!claimant.nameTypes.includes(nameType)) claimant.nameTypes.push(nameType)
  }
  return [...claimants.values()]
}

function readPendingNameClaims(normalizedName: string): PendingActressNameClaim[] {
  const rows = getDb()
    .prepare(
      `SELECT id, normalized_name, actress_id, name, type, locale, source, is_primary
       FROM pending_actress_name_claims
       WHERE normalized_name = ?
       ORDER BY id`
    )
    .all(normalizedName) as PendingNameClaimRow[]
  return rows.map((row) => ({
    claimId: row.id,
    actressId: row.actress_id,
    name: row.name,
    type: canonicalPendingNameType(row.type),
    locale: row.locale,
    source: row.source,
    isPrimary: Boolean(row.is_primary)
  }))
}

function readCurrentNameOwner(normalizedName: string): ActressConflictCurrentOwner | null {
  const db = getDb()
  const owner = db
    .prepare(
      `SELECT o.actress_id, a.main_name, a.avatar_path, a.revision,
              EXISTS(
                SELECT 1 FROM pending_actress_scrapes p WHERE p.actress_id = a.id
              ) AS has_pending_scrape
       FROM actress_name_ownership o
       JOIN actresses a ON a.id = o.actress_id
       WHERE o.normalized_name = ?`
    )
    .get(normalizedName) as
    | {
        actress_id: number
        main_name: string
        avatar_path: string | null
        revision: number
        has_pending_scrape: number
      }
    | undefined
  if (!owner) return null
  const ownerTypes = db
    .prepare(
      `SELECT DISTINCT type FROM actress_names
       WHERE actress_id = ? AND normalize_actress_name(name) = ?
       ORDER BY type`
    )
    .all(owner.actress_id, normalizedName) as Array<{ type: string }>
  return {
    actressId: owner.actress_id,
    revision: owner.revision,
    mainName: owner.main_name,
    avatarPath: owner.avatar_path,
    nameTypes: ownerTypes.map((item) => canonicalPendingNameType(item.type)),
    hasPendingScrape: Boolean(owner.has_pending_scrape)
  }
}

function conflictSnapshotMatches(snapshot: ActressConflictDecisionSnapshot): boolean {
  const db = getDb()
  const owner = db
    .prepare(
      `SELECT o.actress_id, a.revision
       FROM actress_name_ownership o
       JOIN actresses a ON a.id = o.actress_id
       WHERE o.normalized_name = ?`
    )
    .get(snapshot.normalizedName) as
    | { actress_id: number; revision: number }
    | undefined
  if ((owner?.actress_id ?? null) !== snapshot.currentOwnerActressId) return false
  if ((owner?.revision ?? null) !== snapshot.currentOwnerRevision) return false

  const expectedClaimants = [...snapshot.claimants].sort((a, b) => a.actressId - b.actressId)
  const currentClaimants = readNameClaimants(snapshot.normalizedName)
    .map((claimant) => ({ actressId: claimant.actressId, revision: claimant.revision }))
    .sort((a, b) => a.actressId - b.actressId)
  if (
    expectedClaimants.length !== currentClaimants.length ||
    expectedClaimants.some(
      (claimant, index) =>
        claimant.actressId !== currentClaimants[index]?.actressId ||
        claimant.revision !== currentClaimants[index]?.revision
    )
  ) {
    return false
  }

  const expectedNameClaims = [...snapshot.pendingNameClaims].sort(
    (a, b) => a.claimId - b.claimId
  )
  const currentNameClaims = readPendingNameClaims(snapshot.normalizedName)
    .map((claim) => ({
      claimId: claim.claimId,
      actressId: claim.actressId,
      name: claim.name,
      type: claim.type
    }))
    .sort((a, b) => a.claimId - b.claimId)
  if (
    expectedNameClaims.length !== currentNameClaims.length ||
    expectedNameClaims.some(
      (claim, index) =>
        claim.claimId !== currentNameClaims[index]?.claimId ||
        claim.actressId !== currentNameClaims[index]?.actressId ||
        claim.name !== currentNameClaims[index]?.name ||
        claim.type !== currentNameClaims[index]?.type
    )
  ) {
    return false
  }

  const expectedIds = snapshot.candidates
    .map((candidate) => candidate.pendingId)
    .sort((a, b) => a - b)
  const actualIds = (
    db
      .prepare(
        `SELECT DISTINCT pending_scrape_id
         FROM pending_actress_scrape_conflicts
         WHERE normalized_name = ?
         ORDER BY pending_scrape_id`
      )
      .all(snapshot.normalizedName) as Array<{ pending_scrape_id: number }>
  ).map((row) => row.pending_scrape_id)
  if (
    expectedIds.length !== actualIds.length ||
    expectedIds.some((pendingId, index) => pendingId !== actualIds[index])
  ) {
    return false
  }

  const readCandidate = db.prepare(
    `SELECT p.revision AS pending_revision,
            p.actress_id,
            p.applicable_fields_json,
            p.result_json,
            a.revision AS actress_revision
     FROM pending_actress_scrapes p
     JOIN actresses a ON a.id = p.actress_id
     WHERE p.id = ?`
  )
  const readRecordedConflicts = db.prepare(
    `SELECT normalized_name, name, name_type
     FROM pending_actress_scrape_conflicts
     WHERE pending_scrape_id = ?`
  )
  return snapshot.candidates.every((candidate) => {
    const current = readCandidate.get(candidate.pendingId) as
      | {
          pending_revision: number
          actress_id: number
          applicable_fields_json: string
          result_json: string
          actress_revision: number
        }
      | undefined
    if (
      current?.pending_revision !== candidate.pendingRevision ||
      current.actress_id !== candidate.actressId ||
      current.actress_revision !== candidate.actressRevision
    ) {
      return false
    }
    const recorded = new Set(
      (
        readRecordedConflicts.all(candidate.pendingId) as Array<{
          normalized_name: string
          name: string
          name_type: ActressPendingNameType
        }>
      ).map((conflict) => `${conflict.normalized_name}\0${conflict.name}\0${conflict.name_type}`)
    )
    return conflictingNames(
      current.actress_id,
      namesFromResult(
        parseJson<ActressScrapeField[]>(current.applicable_fields_json),
        parseJson<ActressScrapeResult>(current.result_json)
      ),
      candidate.pendingId
    ).every((conflict) =>
      recorded.has(`${conflict.normalizedName}\0${conflict.name}\0${conflict.type}`)
    )
  })
}

function isPendingConflictActive(
  pendingId: number,
  actressId: number,
  normalizedName: string
): boolean {
  const db = getDb()
  const owner = db
    .prepare('SELECT actress_id FROM actress_name_ownership WHERE normalized_name = ?')
    .get(normalizedName) as { actress_id: number } | undefined
  if (owner && owner.actress_id !== actressId) return true
  const foreignClaim = db
    .prepare(
      `SELECT 1 FROM pending_actress_name_claims
       WHERE normalized_name = ? AND actress_id != ? LIMIT 1`
    )
    .get(normalizedName, actressId)
  if (foreignClaim) return true
  const otherPendingTarget = db
    .prepare(
      `SELECT 1
       FROM pending_actress_scrape_conflicts c
       JOIN pending_actress_scrapes p ON p.id = c.pending_scrape_id
       WHERE c.normalized_name = ?
         AND c.pending_scrape_id != ?
         AND p.actress_id != ?
       LIMIT 1`
    )
    .get(normalizedName, pendingId, actressId)
  return Boolean(otherPendingTarget)
}

const ACTIVE_PENDING_CONFLICT_SQL = `CASE WHEN
                  EXISTS (
                    SELECT 1 FROM actress_name_ownership o
                    WHERE o.normalized_name = c.normalized_name
                      AND o.actress_id != p.actress_id
                  )
                  OR EXISTS (
                    SELECT 1 FROM pending_actress_name_claims n
                    WHERE n.normalized_name = c.normalized_name
                      AND n.actress_id != p.actress_id
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM pending_actress_scrape_conflicts other_c
                    JOIN pending_actress_scrapes other_p
                      ON other_p.id = other_c.pending_scrape_id
                    WHERE other_c.normalized_name = c.normalized_name
                      AND other_c.pending_scrape_id != c.pending_scrape_id
                      AND other_p.actress_id != p.actress_id
                  )
                THEN 1 ELSE 0 END`

type PendingConflictMaintenanceRevision = ReturnType<typeof getDatabaseReadRevision> & {
  schemaVersion: number
}
let pendingConflictMaintenanceRevision: PendingConflictMaintenanceRevision | undefined

function readPendingConflictMaintenanceRevision(): PendingConflictMaintenanceRevision {
  const db = getDb()
  return {
    ...getDatabaseReadRevision(db),
    schemaVersion: db.pragma('schema_version', { simple: true }) as number
  }
}

/** Reuse only a completed check of this exact database state; never cache a transaction draft. */
function ensureCurrentPendingConflicts(): void {
  const db = getDb()
  if (db.inTransaction) {
    pendingConflictMaintenanceRevision = undefined
    repairCurrentPendingConflicts()
    return
  }
  const before = readPendingConflictMaintenanceRevision()
  const previous = pendingConflictMaintenanceRevision
  if (previous?.connection === before.connection && previous.changes === before.changes &&
      previous.dataVersion === before.dataVersion && previous.schemaVersion === before.schemaVersion) return
  // Failure or a concurrent external commit must not publish a successful-check stamp.
  pendingConflictMaintenanceRevision = undefined
  repairCurrentPendingConflicts()
  const after = readPendingConflictMaintenanceRevision()
  // Newly added conflicts can make an earlier candidate conflict on the next pass.
  // Publish only a no-write pass; a repair must be checked again before reuse.
  if (before.connection === after.connection && before.changes === after.changes &&
      before.dataVersion === after.dataVersion && before.schemaVersion === after.schemaVersion) {
    pendingConflictMaintenanceRevision = after
  }
}

function repairCurrentPendingConflicts(): void {
  const db = getDb()
  const pendingRows = db
    .prepare(
      `SELECT id, actress_id, applicable_fields_json, result_json
       FROM pending_actress_scrapes`
    )
    .all() as Array<{
    id: number
    actress_id: number
    applicable_fields_json: string
    result_json: string
  }>
  const existingRows = db.prepare(
    `SELECT normalized_name, name, name_type
     FROM pending_actress_scrape_conflicts
     WHERE pending_scrape_id = ?`
  )
  const insert = db.prepare(
    `INSERT OR IGNORE INTO pending_actress_scrape_conflicts
       (pending_scrape_id, normalized_name, name, name_type)
     VALUES (?, ?, ?, ?)`
  )
  const incrementRevision = db.prepare(
    'UPDATE pending_actress_scrapes SET revision = revision + 1 WHERE id = ?'
  )
  db.transaction(() => {
    for (const pending of pendingRows) {
      const existing = new Set(
        (existingRows.all(pending.id) as Array<{
          normalized_name: string
          name: string
          name_type: ActressPendingNameType
        }>).map((row) => `${row.normalized_name}\0${row.name}\0${row.name_type}`)
      )
      const current = conflictingNames(
        pending.actress_id,
        namesFromResult(
          parseJson<ActressScrapeField[]>(pending.applicable_fields_json),
          parseJson<ActressScrapeResult>(pending.result_json)
        ),
        pending.id
      )
      let changed = false
      for (const conflict of current) {
        const key = `${conflict.normalizedName}\0${conflict.name}\0${conflict.type}`
        if (existing.has(key)) continue
        changed =
          insert.run(
            pending.id,
            conflict.normalizedName,
            conflict.name,
            conflict.type
          ).changes > 0 || changed
      }
      if (changed) incrementRevision.run(pending.id)
    }
  })()
}

function readActivePendingConflictsForMerge(
  pendingId: number
): Array<{ normalizedName: string; name: string }> {
  const db = getDb()
  const pending = db
    .prepare('SELECT actress_id FROM pending_actress_scrapes WHERE id = ?')
    .get(pendingId) as { actress_id: number } | undefined
  if (!pending) return []
  const rows = db
    .prepare(
      `SELECT normalized_name, name
       FROM pending_actress_scrape_conflicts
       WHERE pending_scrape_id = ?`
    )
    .all(pendingId) as Array<{ normalized_name: string; name: string }>
  return rows
    .filter((row) =>
      isPendingConflictActive(pendingId, pending.actress_id, row.normalized_name)
    )
    .map((row) => ({ normalizedName: row.normalized_name, name: row.name }))
}

function pendingConflictWithThirdActress(
  pendingId: number,
  mergedActressIds: readonly number[]
): { name: string } | null {
  const db = getDb()
  const allowedIds = new Set(mergedActressIds)
  const findOwner = db.prepare(
    'SELECT actress_id FROM actress_name_ownership WHERE normalized_name = ?'
  )
  const listClaimants = db.prepare(
    'SELECT DISTINCT actress_id FROM pending_actress_name_claims WHERE normalized_name = ?'
  )
  const listOtherPendingTargets = db.prepare(
    `SELECT DISTINCT p.actress_id
     FROM pending_actress_scrape_conflicts c
     JOIN pending_actress_scrapes p ON p.id = c.pending_scrape_id
     WHERE c.normalized_name = ? AND c.pending_scrape_id != ?`
  )
  for (const conflict of readActivePendingConflictsForMerge(pendingId)) {
    const owner = findOwner.get(conflict.normalizedName) as
      | { actress_id: number }
      | undefined
    const claimants = listClaimants.all(conflict.normalizedName) as Array<{
      actress_id: number
    }>
    const otherPendingTargets = listOtherPendingTargets.all(
      conflict.normalizedName,
      pendingId
    ) as Array<{ actress_id: number }>
    if (
      (owner && !allowedIds.has(owner.actress_id)) ||
      claimants.some((claimant) => !allowedIds.has(claimant.actress_id)) ||
      otherPendingTargets.some((target) => !allowedIds.has(target.actress_id))
    ) {
      return conflict
    }
  }
  return null
}

function mergedNameConflictWithThirdPending(
  pendingId: number,
  mergedActressIds: readonly number[]
): { name: string } | null {
  const db = getDb()
  const placeholders = mergedActressIds.map(() => '?').join(', ')
  // Materialize once: a correlated lookup otherwise renormalizes every alias per conflict.
  const conflicts = db
    .prepare(
      `WITH merged_names AS MATERIALIZED (
         SELECT DISTINCT normalize_actress_name(name) AS normalized_name
         FROM actress_names
         WHERE actress_id IN (${placeholders})
       )
       SELECT DISTINCT
         c.pending_scrape_id,
         c.normalized_name,
         c.name,
         p.actress_id
       FROM pending_actress_scrape_conflicts c
       JOIN pending_actress_scrapes p ON p.id = c.pending_scrape_id
       WHERE c.pending_scrape_id != ?
         AND p.actress_id NOT IN (${placeholders})
         AND c.normalized_name IN (SELECT normalized_name FROM merged_names)
       ORDER BY c.normalized_name, c.pending_scrape_id`
    )
    .all(...mergedActressIds, pendingId, ...mergedActressIds) as Array<{
    pending_scrape_id: number
    normalized_name: string
    name: string
    actress_id: number
  }>
  return (
    conflicts.find((conflict) =>
      isPendingConflictActive(
        conflict.pending_scrape_id,
        conflict.actress_id,
        conflict.normalized_name
      )
    ) ?? null
  )
}

function mergePairBlockedReason(actressIds: readonly [number, number]): string | null {
  const pendingRows = getDb()
    .prepare(
      `SELECT id
       FROM pending_actress_scrapes
       WHERE actress_id IN (?, ?)
       ORDER BY id`
    )
    .all(...actressIds) as Array<{ id: number }>
  if (pendingRows.length > 1) {
    return '两位演员都有待确认刮削结果，请先处理其中一份'
  }
  const pendingId = pendingRows[0]?.id
  const thirdActressConflict =
    pendingId == null ? null : pendingConflictWithThirdActress(pendingId, actressIds)
  if (thirdActressConflict) {
    return `名称「${thirdActressConflict.name}」还与第三位演员冲突，请先处理该冲突`
  }
  const thirdPendingConflict = mergedNameConflictWithThirdPending(
    pendingId ?? -1,
    actressIds
  )
  if (thirdPendingConflict) {
    return `名称「${thirdPendingConflict.name}」还与第三位演员的待确认结果冲突，请先处理该冲突`
  }
  return null
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function updatePendingResultName(
  result: ActressScrapeResult,
  type: ActressPendingNameType,
  previousName: string,
  newName: string
): ActressScrapeResult {
  const updated = { ...result }
  if (type === 'main') {
    if (updated.mainName?.trim() !== previousName) throw new Error('待确认名称已变化')
    updated.mainName = newName
  } else if (type === 'zh') {
    if (updated.nameZh?.trim() !== previousName) throw new Error('待确认名称已变化')
    updated.nameZh = newName
  } else if (type === 'en') {
    if (updated.nameEn?.trim() !== previousName) throw new Error('待确认名称已变化')
    updated.nameEn = newName
  } else {
    const aliases = [...(updated.aliases ?? [])]
    const index = aliases.findIndex((alias) => alias.trim() === previousName)
    if (index < 0) throw new Error('待确认名称已变化')
    aliases[index] = newName
    updated.aliases = aliases
  }
  return updated
}

function replacementMainNameFor(
  input: ResolveActressConflictInput,
  actressId: number
): string {
  const replacement = input.replacementMainNames
    .find((item) => item.actressId === actressId)
    ?.mainName.trim()
  if (!replacement) throw new Error('主名被移除时必须提供替代主名')
  return replacement
}

function replacementMainNameConflict(
  actressId: number,
  replacement: string,
  removedNormalizedName: string
): string | null {
  const db = getDb()
  const replacementNormalized = normalizeActressName(replacement)
  if (replacementNormalized === removedNormalizedName) {
    return '替代主名不能与被移除的名称相同'
  }
  const owner = db
    .prepare('SELECT actress_id FROM actress_name_ownership WHERE normalized_name = ?')
    .get(replacementNormalized) as { actress_id: number } | undefined
  const foreignClaim = db
    .prepare(
      `SELECT 1 FROM pending_actress_name_claims
       WHERE normalized_name = ? AND actress_id != ? LIMIT 1`
    )
    .get(replacementNormalized, actressId)
  const foreignPending = db
    .prepare(
      `SELECT 1
       FROM pending_actress_scrape_conflicts c
       JOIN pending_actress_scrapes p ON p.id = c.pending_scrape_id
       WHERE c.normalized_name = ? AND p.actress_id != ?
       LIMIT 1`
    )
    .get(replacementNormalized, actressId)
  if ((owner && owner.actress_id !== actressId) || foreignClaim || foreignPending) {
    return `名称「${replacement}」已被其他演员使用`
  }
  return null
}

function replaceMainNameBeforeRemovingNormalized(
  input: ResolveActressConflictInput,
  actressId: number,
  normalizedName: string
): void {
  const db = getDb()
  const main = db
    .prepare(
      `SELECT 1 FROM actress_names
       WHERE actress_id = ? AND type = 'main' AND normalize_actress_name(name) = ?`
    )
    .get(actressId, normalizedName)
  if (!main) {
    db.prepare(
      `DELETE FROM actress_names
       WHERE actress_id = ? AND normalize_actress_name(name) = ?`
    ).run(actressId, normalizedName)
    return
  }

  const replacement = replacementMainNameFor(input, actressId)
  const conflict = replacementMainNameConflict(actressId, replacement, normalizedName)
  if (conflict) throw new Error(conflict)

  db.prepare(
    `DELETE FROM actress_names
     WHERE actress_id = ? AND normalize_actress_name(name) = ?`
  ).run(actressId, normalizedName)
  db.prepare('UPDATE actresses SET main_name = ?, updated_at = ? WHERE id = ?').run(
    replacement,
    new Date().toISOString(),
    actressId
  )
  upsertActressName(actressId, replacement, 'main', null, null, 1)
}

function declarePendingNamesForActress(
  actressId: number,
  names: PendingName[]
): void {
  const db = getDb()
  for (const item of names) {
    if (item.type === 'main') {
      db.prepare('UPDATE actresses SET main_name = ?, updated_at = ? WHERE id = ?').run(
        item.name,
        new Date().toISOString(),
        actressId
      )
      upsertActressName(actressId, item.name, 'main', null, null, 1)
    } else if (item.type === 'zh' || item.type === 'en') {
      setActressTypedName(actressId, item.type, item.name)
    } else {
      upsertActressName(actressId, item.name, 'alias', null, null, 0)
    }
  }
}

function releasePendingResultNamesBeforeApply(
  actressId: number,
  fields: ActressScrapeField[],
  result: ActressScrapeResult
): void {
  const remove = getDb().prepare(
    `DELETE FROM actress_names
     WHERE actress_id = ? AND type = ? AND normalize_actress_name(name) = ?`
  )
  for (const item of namesFromResult(fields, result)) {
    remove.run(actressId, item.type, item.normalizedName)
  }
  synchronizeActressNameOwnership(actressId)
}

function reconcilePendingNameClaimGroup(normalizedName: string): void {
  const db = getDb()
  const declarations = db
    .prepare(
      `SELECT actress_id, name, type, locale, source, is_primary
       FROM actress_names
       WHERE normalize_actress_name(name) = ?
       ORDER BY actress_id, id`
    )
    .all(normalizedName) as Array<{
    actress_id: number
    name: string
    type: string
    locale: string | null
    source: string | null
    is_primary: number
  }>
  const actressIds = [...new Set(declarations.map((item) => item.actress_id))]
  db.prepare('DELETE FROM actress_name_ownership WHERE normalized_name = ?').run(normalizedName)
  db.prepare('DELETE FROM pending_actress_name_claims WHERE normalized_name = ?').run(
    normalizedName
  )
  if (actressIds.length <= 1) {
    if (actressIds[0] !== undefined) synchronizeActressNameOwnership(actressIds[0])
    return
  }
  const insertClaim = db.prepare(
    `INSERT INTO pending_actress_name_claims
       (normalized_name, actress_id, name, type, locale, source, is_primary)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  for (const declaration of declarations) {
    insertClaim.run(
      normalizedName,
      declaration.actress_id,
      declaration.name,
      declaration.type,
      declaration.locale,
      declaration.source,
      declaration.is_primary
    )
  }
}

function excludeNormalizedNameFromPendingResult(
  result: ActressScrapeResult,
  fields: ActressScrapeField[],
  normalizedName: string
): { result: ActressScrapeResult; fields: ActressScrapeField[] } {
  const updated = { ...result }
  const excludedFields = new Set<ActressScrapeField>()
  if (updated.nameZh?.trim() && normalizeActressName(updated.nameZh) === normalizedName) {
    delete updated.nameZh
    excludedFields.add('nameZh')
  }
  if (updated.nameEn?.trim() && normalizeActressName(updated.nameEn) === normalizedName) {
    delete updated.nameEn
    excludedFields.add('nameEn')
  }
  if (updated.aliases) {
    const aliases = updated.aliases.filter(
      (name) => !name.trim() || normalizeActressName(name) !== normalizedName
    )
    if (aliases.length > 0) updated.aliases = aliases
    else {
      delete updated.aliases
      excludedFields.add('aliases')
    }
  }
  return {
    result: updated,
    fields: fields.filter((field) => !excludedFields.has(field))
  }
}

function pendingResultNameKeysOwnedByActress(
  actressId: number,
  fields: ActressScrapeField[],
  result: ActressScrapeResult
): string[] {
  const readOwner = getDb().prepare(
    'SELECT actress_id FROM actress_name_ownership WHERE normalized_name = ?'
  )
  return Array.from(
    new Set(
      namesFromResult(fields, result)
        .filter((name) => {
          const owner = readOwner.get(name.normalizedName) as { actress_id: number } | undefined
          return owner?.actress_id === actressId
        })
        .map((name) => name.normalizedName)
    )
  )
}

function promotePendingResources(pendingId: number): PreparedPendingFormalResources {
  const db = getDb()
  const actress = db
    .prepare(
      `SELECT a.id, a.main_name
       FROM pending_actress_scrapes p
       JOIN actresses a ON a.id = p.actress_id
       WHERE p.id = ?`
    )
    .get(pendingId) as { id: number; main_name: string } | undefined
  if (!actress) throw new Error('待确认结果已变化，请刷新后重新确认')
  const resources = db
    .prepare(
      `SELECT pending_scrape_id, field, position, remote_url, staged_path, width, height
       FROM pending_actress_scrape_resources
       WHERE pending_scrape_id = ?
       ORDER BY field, position`
    )
    .all(pendingId) as PendingResourceRow[]
  return mediaAssetStore.runInCoordinatedChange(() => {
    const prepared: PreparedPendingFormalResources = {
      avatarRelPath: null,
      galleryAssets: [],
      stagedPaths: resources.map((resource) => resource.staged_path)
    }
    for (const resource of resources) {
      const data = mediaAssetStore.readActressScrapeStagedImage(resource.staged_path)
      const remoteUrl = resource.remote_url?.trim() ?? ''
      if (resource.field === 'avatar') {
        prepared.avatarRelPath = mediaAssetStore.storeScrapedActressAvatar(
          actress.main_name,
          remoteUrl,
          data
        )
      } else {
        const stored = mediaAssetStore.storeScrapedActressGalleryImage(
          actress.main_name,
          actress.id,
          remoteUrl,
          data
        )
        prepared.galleryAssets.push({
          remoteUrl,
          localPath: stored.localPath,
          width: resource.width ?? stored.width,
          height: resource.height ?? stored.height
        })
      }
    }
    return prepared
  })
}

/** True when the plugin returned at least one apply-able profile field (not just sourceUrl/mainName). */
function actressScrapeResultHasUsableValue(result: ActressScrapeResult): boolean {
  if (result.birthDate?.trim()) return true
  if (result.nameZh?.trim()) return true
  if (result.nameEn?.trim()) return true
  if (result.debutDate?.trim()) return true
  if (result.heightCm != null) return true
  if (result.bustCm != null || result.waistCm != null || result.hipCm != null) return true
  if (result.cupSize?.trim()) return true
  if (result.bloodType?.trim()) return true
  if (result.zodiac?.trim()) return true
  if (result.nationality?.trim()) return true
  if (result.profileSummary?.trim()) return true
  if (result.avatarUrl?.trim()) return true
  if (result.galleryImageUrls?.some((url) => url.trim())) return true
  if (result.aliases?.some((name) => name.trim())) return true
  return false
}

export class ActressIdentityConflictWorkflow {
  routeStagedScrape(input: {
    actressId: number
    plugin: ActressScrapePluginRef
    queryName: string
    selectedFields: ActressScrapeField[]
    applicableFields: ActressScrapeField[]
    mode: ActressScrapeUpdateMode
    result: ActressScrapeResult
    warnings: string[]
    resources: PendingActressScrapeResource[]
  }): { pendingId: number; obsoleteStagedPaths: string[] } {
    const db = getDb()
    const actress = db
      .prepare('SELECT revision FROM actresses WHERE id = ?')
      .get(input.actressId) as { revision: number } | undefined
    if (!actress) throw new Error('演员不存在')
    const conflicts = findActressScrapeNameConflicts(
      input.actressId,
      input.applicableFields,
      input.result
    )
    if (conflicts.length === 0) throw new Error('演员候选当前不存在名称归属冲突')
    return db.transaction(() => {
      const obsoleteStagedPaths = (
        db.prepare(
          `SELECT r.staged_path
             FROM pending_actress_scrape_resources r
             JOIN pending_actress_scrapes p ON p.id = r.pending_scrape_id
            WHERE p.actress_id = ?`
        ).all(input.actressId) as Array<{ staged_path: string }>
      ).map((row) => row.staged_path)
      db.prepare('DELETE FROM pending_actress_scrapes WHERE actress_id = ?').run(input.actressId)
      const createdAt = new Date().toISOString()
      const pendingId = Number(db.prepare(
        `INSERT INTO pending_actress_scrapes (
           actress_id, target_actress_revision, plugin_name, plugin_source, plugin_version,
           query_name, selected_fields_json, applicable_fields_json, update_mode,
           result_json, warnings_json, batch_job_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      ).run(
        input.actressId,
        actress.revision,
        input.plugin.name,
        input.plugin.source,
        input.plugin.version ?? null,
        input.queryName,
        JSON.stringify(input.selectedFields),
        JSON.stringify(input.applicableFields),
        input.mode,
        JSON.stringify(input.result),
        JSON.stringify(input.warnings),
        createdAt
      ).lastInsertRowid)
      const insertConflict = db.prepare(
        `INSERT INTO pending_actress_scrape_conflicts
           (pending_scrape_id, normalized_name, name, name_type)
         VALUES (?, ?, ?, ?)`
      )
      for (const conflict of conflicts) {
        insertConflict.run(pendingId, conflict.normalizedName, conflict.name, conflict.type)
      }
      const insertResource = db.prepare(
        `INSERT INTO pending_actress_scrape_resources
           (pending_scrape_id, field, position, remote_url, staged_path, width, height)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      for (const resource of input.resources) {
        insertResource.run(
          pendingId,
          resource.field,
          resource.position,
          resource.remoteUrl ?? null,
          resource.stagedPath,
          resource.width,
          resource.height
        )
      }
      return { pendingId, obsoleteStagedPaths }
    })()
  }

  processPreparedScrape(input: PreparedActressScrape): ActressScrapeDisposition {
    const db = getDb()
    const actress = db
      .prepare('SELECT revision FROM actresses WHERE id = ?')
      .get(input.actressId) as { revision: number } | undefined
    if (!actress) return { status: 'failure', ok: false, error: '演员不存在' }

    const conflicts = conflictingNames(input.actressId, namesFromPreparedScrape(input))
    if (conflicts.length === 0) {
      const detail = db
        .prepare('SELECT main_name FROM actresses WHERE id = ?')
        .get(input.actressId) as { main_name: string } | undefined
      if (!detail) return { status: 'failure', ok: false, error: '演员不存在' }
      const obsoleteStagedPaths = (
        db
          .prepare(
            `SELECT r.staged_path
             FROM pending_actress_scrape_resources r
             JOIN pending_actress_scrapes p ON p.id = r.pending_scrape_id
             WHERE p.actress_id = ?`
          )
          .all(input.actressId) as Array<{ staged_path: string }>
      ).map((row) => row.staged_path)
      try {
        const applied = mediaAssetStore.coordinateDatabaseChange(() => {
          let avatarRelPath: string | null = null
          const galleryAssets: Array<{
            remoteUrl: string
            localPath: string
            width: number | null
            height: number | null
          }> = []
          for (const resource of input.resources) {
            const remoteUrl = resource.remoteUrl?.trim() ?? ''
            if (resource.field === 'avatar') {
              avatarRelPath = mediaAssetStore.storeScrapedActressAvatar(
                detail.main_name,
                remoteUrl,
                resource.data
              )
            } else {
              const stored = mediaAssetStore.storeScrapedActressGalleryImage(
                detail.main_name,
                input.actressId,
                remoteUrl,
                resource.data
              )
              galleryAssets.push({
                remoteUrl,
                localPath: stored.localPath,
                width: resource.width ?? stored.width,
                height: resource.height ?? stored.height
              })
            }
          }
          const result = applyActressScrapeResult(
            input.actressId,
            input.result,
            avatarRelPath,
            galleryAssets,
            input.applicableFields,
            input.mode,
            () => {
              db.prepare('DELETE FROM pending_actress_scrapes WHERE actress_id = ?').run(
                input.actressId
              )
            }
          )
          if (!result.applied) {
            if (avatarRelPath) mediaAssetStore.deleteBestEffort(avatarRelPath)
            for (const asset of galleryAssets) mediaAssetStore.deleteBestEffort(asset.localPath)
          }
          return result
        })
        if (!applied.applied) {
          const warnings = [...input.warnings, ...applied.warnings]
          if (input.mode === 'fillEmpty' && actressScrapeResultHasUsableValue(input.result)) {
            return {
              status: 'success',
              ok: true,
              result: input.result,
              skipped: true,
              warnings: warnings.length > 0 ? warnings : undefined
            }
          }
          recordActressScrapeFailure(input.actressId)
          return {
            status: 'failure',
            ok: false,
            error: '未找到有效的演员资料',
            warnings: warnings.length > 0 ? warnings : undefined
          }
        }
        cleanupStagedResourcePaths(obsoleteStagedPaths)
        const warnings = [...input.warnings, ...applied.warnings]
        return {
          status: 'success',
          ok: true,
          result: input.result,
          warnings: warnings.length > 0 ? warnings : undefined,
          avatarUpdated: applied.avatarApplied
        }
      } catch (error) {
        recordActressScrapeFailure(input.actressId)
        return { status: 'failure', ok: false, error: (error as Error).message }
      }
    }

    const createdAt = new Date().toISOString()
    const obsoleteStagedPaths = (
      db
        .prepare(
          `SELECT r.staged_path
           FROM pending_actress_scrape_resources r
           JOIN pending_actress_scrapes p ON p.id = r.pending_scrape_id
           WHERE p.actress_id = ?`
        )
        .all(input.actressId) as Array<{ staged_path: string }>
    ).map((row) => row.staged_path)
    const pendingId = mediaAssetStore.coordinateDatabaseChange(() => {
      const stagedResources = stagePreparedResources(input.resources)
      return db.transaction(() => {
        db.prepare('DELETE FROM pending_actress_scrapes WHERE actress_id = ?').run(input.actressId)
        const inserted = db
          .prepare(
            `INSERT INTO pending_actress_scrapes (
               actress_id, target_actress_revision, plugin_name, plugin_source, plugin_version,
               query_name, selected_fields_json, applicable_fields_json, update_mode,
               result_json, warnings_json, batch_job_id, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.actressId,
            actress.revision,
            input.plugin.name,
            input.plugin.source,
            input.plugin.version ?? null,
            input.queryName,
            JSON.stringify(input.selectedFields),
            JSON.stringify(input.applicableFields),
            input.mode,
            JSON.stringify(input.result),
            JSON.stringify(input.warnings),
            input.batchJobId ?? null,
            createdAt
          )
        const id = Number(inserted.lastInsertRowid)
        const insertConflict = db.prepare(
          `INSERT INTO pending_actress_scrape_conflicts
             (pending_scrape_id, normalized_name, name, name_type)
           VALUES (?, ?, ?, ?)`
        )
        for (const conflict of conflicts) {
          insertConflict.run(id, conflict.normalizedName, conflict.name, conflict.type)
        }
        const insertResource = db.prepare(
          `INSERT INTO pending_actress_scrape_resources
             (pending_scrape_id, field, position, remote_url, staged_path, width, height)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        for (const resource of stagedResources) {
          insertResource.run(
            id,
            resource.field,
            resource.position,
            resource.remoteUrl ?? null,
            resource.stagedPath,
            resource.width,
            resource.height
          )
        }
        return id
      })()
    })
    cleanupStagedResourcePaths(obsoleteStagedPaths)

    return {
      status: 'pending',
      ok: true,
      pendingId,
      result: input.result,
      warnings: input.warnings.length > 0 ? input.warnings : undefined
    }
  }

  getConflictGroup(normalizedName: string): ActressNameConflictGroup | null {
    if (typeof normalizedName !== 'string' || normalizedName.length === 0) throw new Error('Invalid conflict group name')
    return this.listConflictGroups(true, normalizedName)[0] ?? null
  }

  listConflictGroups(includeFieldImpacts = true, onlyName?: string): ActressNameConflictGroup[] {
    const db = getDb()
    ensureCurrentPendingConflicts()
    const pendingRows = db
      .prepare(
        `SELECT p.*, a.main_name, a.avatar_path, a.revision AS current_actress_revision
         FROM pending_actress_scrapes p
         JOIN actresses a ON a.id = p.actress_id
         ${onlyName === undefined ? '' : 'WHERE p.id IN (SELECT pending_scrape_id FROM pending_actress_scrape_conflicts WHERE normalized_name = ?)'}
         ORDER BY p.created_at, p.id`
      )
      .all(...(onlyName === undefined ? [] : [onlyName])) as PendingRow[]
    const conflicts = db
      .prepare(
        `SELECT pending_scrape_id, normalized_name, name, name_type
         FROM pending_actress_scrape_conflicts
         ${onlyName === undefined ? '' : 'WHERE pending_scrape_id IN (SELECT pending_scrape_id FROM pending_actress_scrape_conflicts WHERE normalized_name = ?)'}
         ORDER BY id`
      )
      .all(...(onlyName === undefined ? [] : [onlyName])) as Array<{
      pending_scrape_id: number
      normalized_name: string
      name: string
      name_type: ActressPendingNameType
      }>
    const resourceRows = db
      .prepare(
        `SELECT pending_scrape_id, field, position, remote_url, staged_path, width, height
         FROM pending_actress_scrape_resources
         ${onlyName === undefined ? '' : 'WHERE pending_scrape_id IN (SELECT pending_scrape_id FROM pending_actress_scrape_conflicts WHERE normalized_name = ?)'}
         ORDER BY pending_scrape_id, field, position`
      )
      .all(...(onlyName === undefined ? [] : [onlyName])) as PendingResourceRow[]
    const resourcesByPending = new Map<number, PendingActressScrapeResource[]>()
    for (const resource of resourceRows) {
      const rows = resourcesByPending.get(resource.pending_scrape_id) ?? []
      rows.push({
        field: resource.field,
        position: resource.position,
        ...(resource.remote_url ? { remoteUrl: resource.remote_url } : {}),
        stagedPath: resource.staged_path,
        width: resource.width,
        height: resource.height
      })
      resourcesByPending.set(resource.pending_scrape_id, rows)
    }
    const conflictsByPending = new Map<number, PendingActressScrapeCandidate['conflicts']>()
    for (const conflict of conflicts) {
      const rows = conflictsByPending.get(conflict.pending_scrape_id) ?? []
      rows.push({
        name: conflict.name,
        normalizedName: conflict.normalized_name,
        type: conflict.name_type
      })
      conflictsByPending.set(conflict.pending_scrape_id, rows)
    }
    const candidates = pendingRows.map((row): PendingActressScrapeCandidate => ({
      pendingId: row.id,
      revision: row.revision,
      actressId: row.actress_id,
      actressRevision: row.current_actress_revision,
      actressMainName: row.main_name,
      actressAvatarPath: row.avatar_path,
      plugin: {
        name: row.plugin_name,
        source: row.plugin_source,
        ...(row.plugin_version ? { version: row.plugin_version } : {})
      },
      queryName: row.query_name,
      selectedFields: parseJson<ActressScrapeField[]>(row.selected_fields_json),
      applicableFields: parseJson<ActressScrapeField[]>(row.applicable_fields_json),
      mode: row.update_mode,
      result: parseJson<ActressScrapeResult>(row.result_json),
      warnings: parseJson<string[]>(row.warnings_json),
      createdAt: row.created_at,
      ...(row.batch_job_id ? { batchJobId: row.batch_job_id } : {}),
      resources: resourcesByPending.get(row.id) ?? [],
      conflicts: (conflictsByPending.get(row.id) ?? []).filter((conflict) =>
        isPendingConflictActive(row.id, row.actress_id, conflict.normalizedName)
      ),
      fieldImpactsWhenAssignedToCandidate: [],
      fieldImpacts: [],
      willApplyAfterDecision: false,
      remainingConflictCountAfterDecision: 0
    }))

    const grouped = new Map<string, ActressNameConflictGroup>()
    const pendingClaimGroups = db
      .prepare(
        `SELECT DISTINCT normalized_name
         FROM pending_actress_name_claims
         ${onlyName === undefined ? '' : 'WHERE normalized_name = ?'}
         ORDER BY normalized_name`
      )
      .all(...(onlyName === undefined ? [] : [onlyName])) as Array<{ normalized_name: string }>
    for (const pendingClaimGroup of pendingClaimGroups) {
      const pendingNameClaims = readPendingNameClaims(pendingClaimGroup.normalized_name)
      if (pendingNameClaims.length === 0) continue
      grouped.set(pendingClaimGroup.normalized_name, {
        status: 'conflict',
        normalizedName: pendingClaimGroup.normalized_name,
        displayName: pendingNameClaims[0].name,
        currentOwner: readCurrentNameOwner(pendingClaimGroup.normalized_name),
        claimants: readNameClaimants(pendingClaimGroup.normalized_name),
        pendingNameClaims,
        candidates: []
      })
    }
    for (const candidate of candidates) {
      for (const conflict of candidate.conflicts) {
        let group = grouped.get(conflict.normalizedName)
        if (!group) {
          group = {
            status: 'conflict',
            normalizedName: conflict.normalizedName,
            displayName: conflict.name,
            currentOwner: readCurrentNameOwner(conflict.normalizedName),
            claimants: readNameClaimants(conflict.normalizedName),
            pendingNameClaims: readPendingNameClaims(conflict.normalizedName),
            candidates: []
          }
          grouped.set(conflict.normalizedName, group)
        }
        if (!group.candidates.some((item) => item.pendingId === candidate.pendingId)) {
          group.candidates.push(candidate)
        }
      }
    }
    for (const candidate of candidates) {
      if (candidate.conflicts.length > 0) continue
      const previousConflict = conflictsByPending.get(candidate.pendingId)?.[0]
      if (!previousConflict) continue
      const existingGroup = grouped.get(previousConflict.normalizedName)
      if (existingGroup) {
        if (!existingGroup.candidates.some((item) => item.pendingId === candidate.pendingId)) {
          existingGroup.candidates.push(candidate)
        }
      } else {
        grouped.set(previousConflict.normalizedName, {
          status: 'applicable',
          normalizedName: previousConflict.normalizedName,
          displayName: previousConflict.name,
          currentOwner: readCurrentNameOwner(previousConflict.normalizedName),
          claimants: readNameClaimants(previousConflict.normalizedName),
          pendingNameClaims: readPendingNameClaims(previousConflict.normalizedName),
          candidates: [candidate]
        })
      }
    }
    return [...grouped.values()]
      .filter(group => onlyName === undefined || group.normalizedName === onlyName)
      .map((group): ActressNameConflictGroup => {
        const plannedCandidates = group.candidates.map((candidate) => {
          const remainingConflictCountAfterDecision =
            group.status === 'applicable'
              ? candidate.conflicts.length
              : candidate.conflicts.filter(
                  (conflict) => conflict.normalizedName !== group.normalizedName
                ).length
          const willApplyAfterDecision = remainingConflictCountAfterDecision === 0
          if (!willApplyAfterDecision || !includeFieldImpacts) {
            return {
              ...candidate,
              fieldImpactsWhenAssignedToCandidate: [],
              fieldImpacts: [],
              willApplyAfterDecision,
              remainingConflictCountAfterDecision
            }
          }
          const preview =
            group.status === 'conflict'
              ? excludeNormalizedNameFromPendingResult(
                  candidate.result,
                  candidate.applicableFields,
                  group.normalizedName
                )
              : { result: candidate.result, fields: candidate.applicableFields }
          const avatarResource = candidate.resources.find(
            (resource) => resource.field === 'avatar'
          )
          const galleryResources = candidate.resources
            .filter((resource) => resource.field === 'gallery')
            .map((resource) => ({
              remoteUrl: resource.remoteUrl ?? null,
              localPath: resource.stagedPath,
              width: resource.width,
              height: resource.height
            }))
          const plan = planActressScrapeResult(
            candidate.actressId,
            preview.result,
            avatarResource?.stagedPath ?? null,
            galleryResources,
            preview.fields,
            candidate.mode
          )
          const assignedPlan =
            group.status === 'conflict'
              ? planActressScrapeResult(
                  candidate.actressId,
                  candidate.result,
                  avatarResource?.stagedPath ?? null,
                  galleryResources,
                  candidate.applicableFields,
                  candidate.mode,
                  {
                    releasedNameKeys: Array.from(
                      new Set([
                        group.normalizedName,
                        ...pendingResultNameKeysOwnedByActress(
                          candidate.actressId,
                          candidate.applicableFields,
                          candidate.result
                        )
                      ])
                    )
                  }
                )
              : plan
          return {
            ...candidate,
            fieldImpactsWhenAssignedToCandidate: assignedPlan.impacts,
            fieldImpacts: plan.impacts,
            willApplyAfterDecision,
            remainingConflictCountAfterDecision
          }
        })
        const actressIds = Array.from(
          new Set([
            ...group.claimants.map((claimant) => claimant.actressId),
            ...plannedCandidates.map((candidate) => candidate.actressId)
          ])
        ).sort((left, right) => left - right)
        const mergePairs: NonNullable<ActressNameConflictGroup['mergePairs']> = []
        for (let left = 0; left < actressIds.length; left += 1) {
          for (let right = left + 1; right < actressIds.length; right += 1) {
            const pair: [number, number] = [actressIds[left], actressIds[right]]
            mergePairs.push({ actressIds: pair, blockedReason: mergePairBlockedReason(pair) })
          }
        }
        return { ...group, candidates: plannedCandidates, mergePairs }
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'))
  }

  /** Page lightweight group metadata, before candidate JSON/resource/merge-plan hydration. */
  pageConflictQueue(query: ActressConflictQueueQuery): ActressConflictQueuePage {
    const { limit = 50, offset = 0, anchorName } = query
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(offset) || offset < 0 ||
        (anchorName !== undefined && (typeof anchorName !== 'string' || anchorName.length === 0))) {
      throw new Error('Invalid actress conflict queue page')
    }
    ensureCurrentPendingConflicts()
    return getDb().transaction(() => {
      const db = getDb()
      type Group = Omit<ActressConflictQueueItem, 'candidateCount'> & { candidateIds: Set<number> }
      const groups = new Map<string, Group>()
      const claims = db.prepare(`SELECT normalized_name, name FROM pending_actress_name_claims
        ORDER BY normalized_name, id`).all() as Array<{normalized_name:string;name:string}>
      for (const claim of claims) {
        let group = groups.get(claim.normalized_name)
        if (!group) {
          group = {normalizedName:claim.normalized_name,displayName:claim.name,status:'conflict',
            candidateIds:new Set(),pendingNameClaimCount:0,avatarPath:null}
          groups.set(claim.normalized_name, group)
        }
        group.pendingNameClaimCount++
      }
      const rows = db.prepare(`SELECT c.pending_scrape_id,c.normalized_name,c.name,
          CASE WHEN length(a.avatar_path)<=4096 THEN a.avatar_path ELSE NULL END AS avatar_path,
          ${ACTIVE_PENDING_CONFLICT_SQL} AS is_active
        FROM pending_actress_scrape_conflicts c
        JOIN pending_actress_scrapes p ON p.id=c.pending_scrape_id
        JOIN actresses a ON a.id=p.actress_id
        ORDER BY p.created_at,p.id,c.id`).all() as Array<{
          pending_scrape_id:number;normalized_name:string;name:string;avatar_path:string|null;is_active:number
        }>
      const byPending = new Map<number, typeof rows>()
      function add(row: typeof rows[number], status: Group['status']): void {
        let group = groups.get(row.normalized_name)
        if (!group) {
          group = {normalizedName:row.normalized_name,displayName:row.name,status,
            candidateIds:new Set(),pendingNameClaimCount:0,avatarPath:null}
          groups.set(row.normalized_name, group)
        }
        if (group.candidateIds.size === 0) group.avatarPath = row.avatar_path
        group.candidateIds.add(row.pending_scrape_id)
      }
      for (const row of rows) {
        const pending = byPending.get(row.pending_scrape_id) ?? []
        pending.push(row)
        byPending.set(row.pending_scrape_id,pending)
        if (row.is_active) add(row,'conflict')
      }
      // A candidate with no active conflicts belongs to its first recorded name.
      // Append these after active candidates, matching the review's stable tie order.
      for (const pending of byPending.values()) {
        if (!pending.some(row => Boolean(row.is_active))) add(pending[0],'applicable')
      }
      const ordered = [...groups.values()].sort((a,b)=>a.displayName.localeCompare(b.displayName,'zh-Hans-CN'))
      const total = ordered.length
      let pageOffset = Math.min(offset,Math.max(0,Math.floor((total-1)/limit)*limit))
      if (anchorName !== undefined) {
        const rank = ordered.findIndex(group => group.normalizedName === anchorName)
        if (rank >= 0) pageOffset = Math.floor(rank/limit)*limit
      }
      const items = ordered.slice(pageOffset,pageOffset+limit).map(({candidateIds,...group}) => {
        const display = Array.from(group.displayName)
        return {...group,displayName:display.length>128 ? display.slice(0,128).join('')+'…' : group.displayName,
          candidateCount:candidateIds.size}
      })
      return {items,total,offset:pageOffset}
    })()
  }

  countPendingScrapes(): number {
    return (
      getDb().prepare('SELECT COUNT(*) AS total FROM pending_actress_scrapes').get() as {
        total: number
      }
    ).total
  }

  countPendingReviewItems(): number {
    return this.getConflictReviewSummary().groupCount
  }

  getConflictReviewSummary(): ActressConflictReviewSummary {
    // The global badge omits candidate/resource DTOs and field planning. Conflict repair
    // below reads candidate JSON after database changes; this is not a constant-work count.
    ensureCurrentPendingConflicts()
    const db = getDb()
    const pendingNameGroups = db
      .prepare('SELECT DISTINCT normalized_name FROM pending_actress_name_claims')
      .all() as Array<{ normalized_name: string }>
    const recordedConflicts = db
      .prepare(
        `SELECT c.id, c.pending_scrape_id, c.normalized_name,
                ${ACTIVE_PENDING_CONFLICT_SQL} AS is_active
         FROM pending_actress_scrape_conflicts c
         JOIN pending_actress_scrapes p ON p.id = c.pending_scrape_id
         ORDER BY c.id`
      )
      .all() as Array<{
      id: number
      pending_scrape_id: number
      normalized_name: string
      is_active: number
    }>
    const conflictGroups = new Set(pendingNameGroups.map((row) => row.normalized_name))
    const rowsByPending = new Map<number, typeof recordedConflicts>()
    for (const row of recordedConflicts) {
      const rows = rowsByPending.get(row.pending_scrape_id) ?? []
      rows.push(row)
      rowsByPending.set(row.pending_scrape_id, rows)
      if (row.is_active) conflictGroups.add(row.normalized_name)
    }
    const applicableGroups = new Set<string>()
    for (const rows of rowsByPending.values()) {
      if (rows.some((row) => Boolean(row.is_active))) continue
      const normalizedName = rows[0]?.normalized_name
      if (normalizedName && !conflictGroups.has(normalizedName)) {
        applicableGroups.add(normalizedName)
      }
    }
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM pending_actress_scrapes) AS pending_scrapes,
           (SELECT COUNT(DISTINCT normalized_name) FROM pending_actress_name_claims)
             AS pending_name_groups`
      )
      .get() as { pending_scrapes: number; pending_name_groups: number }
    return {
      groupCount: conflictGroups.size + applicableGroups.size,
      conflictGroupCount: conflictGroups.size,
      applicableGroupCount: applicableGroups.size,
      pendingScrapeCount: counts.pending_scrapes,
      pendingNameClaimGroupCount: counts.pending_name_groups
    }
  }

  inspectConflictName(
    input: InspectActressConflictNameInput
  ): InspectActressConflictNameResult {
    const name = input.name.trim()
    const normalizedName = normalizeActressName(name)
    const conflict = conflictingNames(
      input.actressId,
      [{ name, normalizedName, type: 'alias' }],
      input.pendingId
    ).length > 0
    return { normalizedName, status: conflict ? 'conflict' : 'available' }
  }

  validateIllegalNameReplacements(
    input: ValidateIllegalNameReplacementsInput
  ): ValidateIllegalNameReplacementsResult {
    if (!conflictSnapshotMatches(input.snapshot)) {
      return { status: 'stale', message: '数据已变化，请刷新后重新确认' }
    }
    const replacements = new Map(
      input.replacementMainNames.map((replacement) => [
        replacement.actressId,
        replacement.mainName.trim()
      ])
    )
    const errors: Array<{ actressId: number; message: string }> = []
    const normalizedByActress = new Map<number, string>()
    const requiredClaimants = readNameClaimants(input.snapshot.normalizedName).filter(
      (claimant) =>
        claimant.nameTypes.includes('main') &&
        claimant.actressId !== input.destinationOwnerActressId
    )
    for (const claimant of requiredClaimants) {
      const replacement = replacements.get(claimant.actressId) ?? ''
      if (!replacement) {
        errors.push({ actressId: claimant.actressId, message: '请填写替代主名' })
        continue
      }
      const conflict = replacementMainNameConflict(
        claimant.actressId,
        replacement,
        input.snapshot.normalizedName
      )
      if (conflict) {
        errors.push({ actressId: claimant.actressId, message: conflict })
        continue
      }
      normalizedByActress.set(claimant.actressId, normalizeActressName(replacement))
    }
    const duplicateActors = new Set<number>()
    const firstActorByName = new Map<string, number>()
    for (const [actressId, normalizedName] of normalizedByActress) {
      const firstActorId = firstActorByName.get(normalizedName)
      if (firstActorId === undefined) {
        firstActorByName.set(normalizedName, actressId)
      } else if (firstActorId !== actressId) {
        duplicateActors.add(firstActorId)
        duplicateActors.add(actressId)
      }
    }
    for (const actressId of duplicateActors) {
      errors.push({ actressId, message: '替代主名不能同时归属多个演员' })
    }
    return errors.length > 0 ? { status: 'invalid', errors } : { status: 'valid' }
  }

  resolveConflict(input: ResolveActressConflictInput): ResolveActressConflictResult {
    const db = getDb()
    const stale = (): ResolveActressConflictResult => ({
      status: 'stale',
      message: '数据已变化，请刷新后重新确认'
    })
    const snapshotMatches = (): boolean => {
      if (!conflictSnapshotMatches(input.snapshot)) return false
      if (input.kind === 'assignToExistingActress') {
        const chosen = db
          .prepare('SELECT revision FROM actresses WHERE id = ?')
          .get(input.ownerActressId) as { revision: number } | undefined
        if (chosen?.revision !== input.ownerActressRevision) return false
      }
      if (input.kind === 'mergeActresses') {
        if (input.keepActressId === input.mergeActressId) return false
        if (input.pendingId !== undefined) {
          const selectedCandidate = input.snapshot.candidates.find(
            (candidate) => candidate.pendingId === input.pendingId
          )
          if (
            !selectedCandidate ||
            (selectedCandidate.actressId !== input.keepActressId &&
              selectedCandidate.actressId !== input.mergeActressId)
          ) {
            return false
          }
        }
        const involvedVersions = new Map<number, number>()
        for (const claimant of input.snapshot.claimants) {
          involvedVersions.set(claimant.actressId, claimant.revision)
        }
        for (const candidate of input.snapshot.candidates) {
          involvedVersions.set(candidate.actressId, candidate.actressRevision)
        }
        if (
          involvedVersions.get(input.keepActressId) !== input.keepActressRevision ||
          involvedVersions.get(input.mergeActressId) !== input.mergeActressRevision
        ) {
          return false
        }
        const readRevision = db.prepare('SELECT revision FROM actresses WHERE id = ?')
        const keep = readRevision.get(input.keepActressId) as { revision: number } | undefined
        const merge = readRevision.get(input.mergeActressId) as { revision: number } | undefined
        if (
          keep?.revision !== input.keepActressRevision ||
          merge?.revision !== input.mergeActressRevision
        ) {
          return false
        }
      }
      return true
    }

    if (!snapshotMatches()) return stale()
    const activePendingConflicts = (
      pendingId: number
    ): Array<{
      normalizedName: string
      name: string
      nameType: ActressPendingNameType
    }> => {
      const pending = db
        .prepare('SELECT actress_id FROM pending_actress_scrapes WHERE id = ?')
        .get(pendingId) as { actress_id: number } | undefined
      if (!pending) throw new Error('STALE_CONFLICT_SNAPSHOT')
      const conflicts = db
        .prepare(
          `SELECT normalized_name, name, name_type
           FROM pending_actress_scrape_conflicts
           WHERE pending_scrape_id = ?`
        )
        .all(pendingId) as Array<{
        normalized_name: string
        name: string
        name_type: ActressPendingNameType
      }>
      return conflicts
        .filter((conflict) =>
          isPendingConflictActive(pendingId, pending.actress_id, conflict.normalized_name)
        )
        .map((conflict) => ({
          normalizedName: conflict.normalized_name,
          name: conflict.name,
          nameType: conflict.name_type
        }))
    }
    const remainingConflictCount = (pendingId: number, excludingNormalizedName: string): number =>
      activePendingConflicts(pendingId).filter(
        (conflict) => conflict.normalizedName !== excludingNormalizedName
      ).length
    const remainingConflictCountAfterItem = (
      pendingId: number,
      normalizedName: string,
      name: string,
      nameType: ActressPendingNameType
    ): number =>
      activePendingConflicts(pendingId).filter(
        (conflict) =>
          !(
            conflict.normalizedName === normalizedName &&
            conflict.name === name &&
            conflict.nameType === nameType
          )
      ).length
    const preparedByPending = new Map<number, PreparedPendingFormalResources>()
    const preparePending = (pendingId: number): void => {
      if (!preparedByPending.has(pendingId)) {
        preparedByPending.set(pendingId, promotePendingResources(pendingId))
      }
    }
    const pendingIdsUnlockedByDecision = (): number[] => {
      if (input.kind === 'applyPending') return [input.pendingId]
      const affectedCandidates =
        'pendingId' in input
          ? input.snapshot.candidates.filter(
              (candidate) => candidate.pendingId === input.pendingId
            )
          : input.snapshot.candidates
      if (input.kind === 'editName') {
        const newName = input.newName.trim()
        if (!newName) throw new Error('名称不能为空')
        const pending = db
          .prepare('SELECT actress_id FROM pending_actress_scrapes WHERE id = ?')
          .get(input.pendingId) as { actress_id: number } | undefined
        if (!pending) return []
        const normalizedName = normalizeActressName(newName)
        const stillConflicts =
          conflictingNames(
            pending.actress_id,
            [{ name: newName, normalizedName, type: input.nameType }],
            input.pendingId
          ).length > 0
        return !stillConflicts &&
          affectedCandidates.length > 0 &&
          remainingConflictCountAfterItem(
            input.pendingId,
            input.snapshot.normalizedName,
            input.name,
            input.nameType
          ) === 0
          ? [input.pendingId]
          : []
      }
      return affectedCandidates
        .filter(
          (candidate) =>
            remainingConflictCount(candidate.pendingId, input.snapshot.normalizedName) === 0
        )
        .map((candidate) => candidate.pendingId)
    }
    const obsoleteAfterCommit: string[] = []
    try {
      return mediaAssetStore.coordinateDatabaseChange(() => {
      for (const pendingId of pendingIdsUnlockedByDecision()) preparePending(pendingId)
      const remainingPending = db.transaction(() => {
        if (!snapshotMatches()) throw new Error('STALE_CONFLICT_SNAPSHOT')
        const applyIfUnlocked = (
          pendingId: number,
          resultOverride?: ActressScrapeResult
        ): void => {
          const pending = db
            .prepare('SELECT * FROM pending_actress_scrapes WHERE id = ?')
            .get(pendingId) as PendingRow | undefined
          if (!pending) throw new Error('STALE_CONFLICT_SNAPSHOT')
          if (activePendingConflicts(pendingId).length > 0) return
          const prepared = preparedByPending.get(pendingId)
          const resourceCount = (
            db
              .prepare(
                'SELECT COUNT(*) AS total FROM pending_actress_scrape_resources WHERE pending_scrape_id = ?'
              )
              .get(pendingId) as { total: number }
          ).total
          if (resourceCount > 0 && !prepared) {
            throw new Error('待确认资源尚未准备')
          }
          const applicableFields = parseJson<ActressScrapeField[]>(
            pending.applicable_fields_json
          )
          if (applicableFields.length === 0) {
            markActressScrapeSucceeded(pending.actress_id)
            db.prepare('DELETE FROM pending_actress_scrapes WHERE id = ?').run(pendingId)
            return
          }
          const applied = applyActressScrapeResult(
            pending.actress_id,
            resultOverride ?? parseJson<ActressScrapeResult>(pending.result_json),
            prepared?.avatarRelPath ?? null,
            prepared?.galleryAssets ?? [],
            applicableFields,
            pending.update_mode,
            () => {
              db.prepare('DELETE FROM pending_actress_scrapes WHERE id = ?').run(pendingId)
            },
            { deferFileCleanup: true }
          )
          if (!applied.applied) throw new Error('待确认结果没有可应用的资料')
          obsoleteAfterCommit.push(...(applied.fileChanges?.obsoletePaths ?? []))
        }
        const removeCurrentGroupFromCandidates = (): void => {
          for (const candidate of input.snapshot.candidates) {
            const pending = db
              .prepare('SELECT * FROM pending_actress_scrapes WHERE id = ?')
              .get(candidate.pendingId) as PendingRow | undefined
            if (!pending) throw new Error('STALE_CONFLICT_SNAPSHOT')
            const excluded = excludeNormalizedNameFromPendingResult(
              parseJson<ActressScrapeResult>(pending.result_json),
              parseJson<ActressScrapeField[]>(pending.applicable_fields_json),
              input.snapshot.normalizedName
            )
            db.prepare(
              `UPDATE pending_actress_scrapes
               SET result_json = ?, applicable_fields_json = ?, revision = revision + 1
               WHERE id = ?`
            ).run(
              JSON.stringify(excluded.result),
              JSON.stringify(excluded.fields),
              candidate.pendingId
            )
            db.prepare(
              `DELETE FROM pending_actress_scrape_conflicts
               WHERE pending_scrape_id = ? AND normalized_name = ?`
            ).run(candidate.pendingId, input.snapshot.normalizedName)
          }
          for (const candidate of input.snapshot.candidates) {
            applyIfUnlocked(candidate.pendingId)
          }
        }

        if (input.kind === 'editName') {
          const newName = input.newName.trim()
          if (!newName) throw new Error('名称不能为空')
          const normalizedName = normalizeActressName(newName)
          const conflict = db
            .prepare(
              `SELECT id
               FROM pending_actress_scrape_conflicts
               WHERE pending_scrape_id = ? AND normalized_name = ? AND name = ? AND name_type = ?`
            )
            .get(
              input.pendingId,
              input.snapshot.normalizedName,
              input.name,
              input.nameType
            ) as { id: number } | undefined
          const pending = db
            .prepare('SELECT * FROM pending_actress_scrapes WHERE id = ?')
            .get(input.pendingId) as PendingRow | undefined
          if (!conflict || !pending) throw new Error('STALE_CONFLICT_SNAPSHOT')
          const result = updatePendingResultName(
            parseJson<ActressScrapeResult>(pending.result_json),
            input.nameType,
            input.name,
            newName
          )
          const stillConflicts = conflictingNames(
            pending.actress_id,
            [{ name: newName, normalizedName, type: input.nameType }],
            input.pendingId
          ).length > 0
          db.prepare(
            `UPDATE pending_actress_scrapes
             SET result_json = ?, revision = revision + 1
             WHERE id = ?`
          ).run(JSON.stringify(result), input.pendingId)
          if (stillConflicts) {
            db.prepare(
              `UPDATE pending_actress_scrape_conflicts
               SET normalized_name = ?, name = ?
               WHERE id = ?`
            ).run(normalizedName, newName, conflict.id)
          } else {
            db.prepare('DELETE FROM pending_actress_scrape_conflicts WHERE id = ?').run(conflict.id)
          }
          applyIfUnlocked(input.pendingId, result)
        } else if (input.kind === 'editPendingNameClaim') {
          const newName = input.newName.trim()
          if (!newName) throw new Error('名称不能为空')
          const claim = db
            .prepare(
              `SELECT id, normalized_name, actress_id, name, type, locale, source, is_primary
               FROM pending_actress_name_claims
               WHERE id = ?`
            )
            .get(input.claimId) as PendingNameClaimRow | undefined
          if (
            !claim ||
            claim.normalized_name !== input.snapshot.normalizedName ||
            claim.actress_id !== input.actressId ||
            claim.name !== input.name ||
            canonicalPendingNameType(claim.type) !== input.nameType
          ) {
            throw new Error('STALE_CONFLICT_SNAPSHOT')
          }
          const newNormalizedName = normalizeActressName(newName)
          const removed = db
            .prepare(
              `DELETE FROM actress_names
               WHERE actress_id = ? AND name = ? AND type = ?`
            )
            .run(claim.actress_id, claim.name, claim.type)
          if (removed.changes !== 1) throw new Error('STALE_CONFLICT_SNAPSHOT')
          db.prepare(
            `INSERT INTO actress_names (actress_id, name, type, locale, source, is_primary)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(actress_id, name, type) DO UPDATE SET
               locale = excluded.locale,
               source = excluded.source,
               is_primary = excluded.is_primary`
          ).run(
            claim.actress_id,
            newName,
            claim.type,
            claim.locale,
            claim.source,
            claim.is_primary
          )
          if (canonicalPendingNameType(claim.type) === 'main') {
            db.prepare('UPDATE actresses SET main_name = ?, updated_at = ? WHERE id = ?').run(
              newName,
              new Date().toISOString(),
              claim.actress_id
            )
          } else {
            db.prepare('UPDATE actresses SET updated_at = ? WHERE id = ?').run(
              new Date().toISOString(),
              claim.actress_id
            )
          }
          db.prepare('DELETE FROM pending_actress_name_claims WHERE id = ?').run(claim.id)
          reconcilePendingNameClaimGroup(claim.normalized_name)
          if (newNormalizedName !== claim.normalized_name) {
            reconcilePendingNameClaimGroup(newNormalizedName)
          }
          for (const candidate of input.snapshot.candidates) {
            applyIfUnlocked(candidate.pendingId)
          }
        } else if (input.kind === 'assignToCurrentActress') {
          const pending = db
            .prepare('SELECT * FROM pending_actress_scrapes WHERE id = ?')
            .get(input.pendingId) as PendingRow | undefined
          if (!pending) throw new Error('STALE_CONFLICT_SNAPSHOT')
          const conflictRows = db
            .prepare(
              `SELECT name, normalized_name, name_type
               FROM pending_actress_scrape_conflicts
               WHERE pending_scrape_id = ? AND normalized_name = ?`
            )
            .all(input.pendingId, input.snapshot.normalizedName) as Array<{
            name: string
            normalized_name: string
            name_type: ActressPendingNameType
          }>
          if (conflictRows.length === 0) throw new Error('STALE_CONFLICT_SNAPSHOT')
          const previousClaimantIds = readNameClaimants(input.snapshot.normalizedName)
            .map((claimant) => claimant.actressId)
            .filter((actressId) => actressId !== pending.actress_id)
          for (const previousClaimantId of previousClaimantIds) {
            replaceMainNameBeforeRemovingNormalized(
              input,
              previousClaimantId,
              input.snapshot.normalizedName
            )
          }
          db.prepare(
            'DELETE FROM actress_name_ownership WHERE normalized_name = ?'
          ).run(input.snapshot.normalizedName)
          db.prepare(
            'DELETE FROM pending_actress_name_claims WHERE normalized_name = ?'
          ).run(input.snapshot.normalizedName)
          for (const previousClaimantId of previousClaimantIds) {
            synchronizeActressNameOwnership(previousClaimantId)
          }
          db.prepare(
            `DELETE FROM pending_actress_scrape_conflicts
             WHERE pending_scrape_id = ? AND normalized_name = ?`
          ).run(input.pendingId, input.snapshot.normalizedName)
          db.prepare(
            'UPDATE pending_actress_scrapes SET revision = revision + 1 WHERE id = ?'
          ).run(input.pendingId)
          if (activePendingConflicts(input.pendingId).length === 0) {
            const applicableFields = parseJson<ActressScrapeField[]>(
              pending.applicable_fields_json
            )
            const result = parseJson<ActressScrapeResult>(pending.result_json)
            releasePendingResultNamesBeforeApply(pending.actress_id, applicableFields, result)
            applyIfUnlocked(input.pendingId)
          } else {
            declarePendingNamesForActress(
              pending.actress_id,
              conflictRows.map((row) => ({
                name: row.name,
                normalizedName: row.normalized_name,
                type: row.name_type
              }))
            )
            synchronizeActressNameOwnership(pending.actress_id)
          }
        } else if (input.kind === 'assignToExistingActress') {
          const groupConflicts = db
            .prepare(
              `SELECT pending_scrape_id, name, name_type
               FROM pending_actress_scrape_conflicts
               WHERE normalized_name = ?
               ORDER BY id`
            )
            .all(input.snapshot.normalizedName) as Array<{
            pending_scrape_id: number
            name: string
            name_type: ActressPendingNameType
          }>
          const representativeName =
            groupConflicts[0]?.name ?? input.snapshot.pendingNameClaims[0]?.name
          if (!representativeName) throw new Error('STALE_CONFLICT_SNAPSHOT')
          const declaredBy = db
            .prepare(
              `SELECT DISTINCT actress_id
               FROM actress_names
               WHERE normalize_actress_name(name) = ?`
            )
            .all(input.snapshot.normalizedName) as Array<{ actress_id: number }>
          for (const { actress_id: actressId } of declaredBy) {
            if (actressId === input.ownerActressId) continue
            replaceMainNameBeforeRemovingNormalized(
              input,
              actressId,
              input.snapshot.normalizedName
            )
          }
          db.prepare(
            'DELETE FROM actress_name_ownership WHERE normalized_name = ?'
          ).run(input.snapshot.normalizedName)
          db.prepare(
            'DELETE FROM pending_actress_name_claims WHERE normalized_name = ?'
          ).run(input.snapshot.normalizedName)
          for (const { actress_id: actressId } of declaredBy) {
            if (actressId !== input.ownerActressId) synchronizeActressNameOwnership(actressId)
          }
          removeCurrentGroupFromCandidates()
          const chosenHasName = db
            .prepare(
              `SELECT 1 FROM actress_names
               WHERE actress_id = ? AND normalize_actress_name(name) = ? LIMIT 1`
            )
            .get(input.ownerActressId, input.snapshot.normalizedName)
          if (!chosenHasName) {
            upsertActressName(
              input.ownerActressId,
              representativeName,
              'alias',
              null,
              null,
              0
            )
          }
          synchronizeActressNameOwnership(input.ownerActressId)
        } else if (input.kind === 'mergeActresses') {
          const actresses = db
            .prepare(
              `SELECT id, main_name
               FROM actresses
               WHERE id IN (?, ?)
               ORDER BY id`
            )
            .all(input.keepActressId, input.mergeActressId) as Array<{
            id: number
            main_name: string
          }>
          if (actresses.length !== 2) throw new Error('STALE_CONFLICT_SNAPSHOT')
          const keep = actresses.find((actress) => actress.id === input.keepActressId)!
          const merge = actresses.find((actress) => actress.id === input.mergeActressId)!
          const finalMainName = input.finalMainName.trim()
          const mainNameFrom =
            finalMainName === keep.main_name
              ? 'keep'
              : finalMainName === merge.main_name
                ? 'merge'
                : null
          if (!mainNameFrom) throw new Error('最终主名必须从两位演员的当前主名中明确选择')

          const pendingRows = db
            .prepare(
              `SELECT id, actress_id
               FROM pending_actress_scrapes
               WHERE actress_id IN (?, ?)
               ORDER BY id`
            )
            .all(input.keepActressId, input.mergeActressId) as Array<{
            id: number
            actress_id: number
          }>
          if (pendingRows.length > 1) {
            throw new Error('两位演员都有待确认刮削结果，请先处理其中一份')
          }
          const pending =
            input.pendingId === undefined
              ? pendingRows[0]
              : pendingRows.find((row) => row.id === input.pendingId)
          if (input.pendingId !== undefined && !pending) {
            throw new Error('STALE_CONFLICT_SNAPSHOT')
          }
          const mergedActressIds = [input.keepActressId, input.mergeActressId]
          const thirdPartyConflict = pending
            ? pendingConflictWithThirdActress(pending.id, mergedActressIds)
            : null
          if (thirdPartyConflict) {
            throw new Error(
              `名称「${thirdPartyConflict.name}」还与第三位演员冲突，请先处理该冲突`
            )
          }
          const thirdPartyPendingConflict = mergedNameConflictWithThirdPending(
            pending?.id ?? -1,
            mergedActressIds
          )
          if (thirdPartyPendingConflict) {
            throw new Error(
              `名称「${thirdPartyPendingConflict.name}」还与第三位演员的待确认结果冲突，请先处理该冲突`
            )
          }
          if (pending?.actress_id === input.mergeActressId) {
            db.prepare(
              'UPDATE pending_actress_scrapes SET actress_id = ? WHERE id = ?'
            ).run(input.keepActressId, pending.id)
          }
          const merged = mergeActressesWithAssets(
            input.keepActressId,
            input.mergeActressId,
            mainNameFrom,
            { deferCleanup: true }
          )
          obsoleteAfterCommit.push(...(merged.fileChanges?.obsoletePaths ?? []))
          const keeper = db
            .prepare('SELECT revision FROM actresses WHERE id = ?')
            .get(input.keepActressId) as { revision: number }
          if (pending) {
            db.prepare(
              `UPDATE pending_actress_scrapes
               SET target_actress_revision = ?, revision = revision + 1
               WHERE id = ?`
            ).run(keeper.revision, pending.id)
          }
        } else if (input.kind === 'markIllegalName') {
          const claimantIds = readNameClaimants(input.snapshot.normalizedName).map(
            (claimant) => claimant.actressId
          )
          for (const claimantId of claimantIds) {
            replaceMainNameBeforeRemovingNormalized(
              input,
              claimantId,
              input.snapshot.normalizedName
            )
          }
          db.prepare(
            'DELETE FROM actress_name_ownership WHERE normalized_name = ?'
          ).run(input.snapshot.normalizedName)
          db.prepare(
            'DELETE FROM pending_actress_name_claims WHERE normalized_name = ?'
          ).run(input.snapshot.normalizedName)
          for (const claimantId of claimantIds) {
            synchronizeActressNameOwnership(claimantId)
          }
          removeCurrentGroupFromCandidates()
        } else if (input.kind === 'applyPending') {
          if (input.snapshot.status !== 'applicable') {
            throw new Error('STALE_CONFLICT_SNAPSHOT')
          }
          const pending = db
            .prepare('SELECT actress_id FROM pending_actress_scrapes WHERE id = ?')
            .get(input.pendingId) as { actress_id: number } | undefined
          if (!pending) throw new Error('STALE_CONFLICT_SNAPSHOT')
          const conflicts = db
            .prepare(
              `SELECT normalized_name
               FROM pending_actress_scrape_conflicts
               WHERE pending_scrape_id = ?`
            )
            .all(input.pendingId) as Array<{ normalized_name: string }>
          if (
            conflicts.some((conflict) =>
              isPendingConflictActive(
                input.pendingId,
                pending.actress_id,
                conflict.normalized_name
              )
            )
          ) {
            throw new Error('STALE_CONFLICT_SNAPSHOT')
          }
          db.prepare(
            'DELETE FROM pending_actress_scrape_conflicts WHERE pending_scrape_id = ?'
          ).run(input.pendingId)
          db.prepare(
            'UPDATE pending_actress_scrapes SET revision = revision + 1 WHERE id = ?'
          ).run(input.pendingId)
          applyIfUnlocked(input.pendingId)
        } else {
          throw new Error('该冲突处理方式尚未实现')
        }
        return this.countPendingReviewItems()
      })()
      for (const obsoletePath of new Set(obsoleteAfterCommit)) {
        mediaAssetStore.deleteBestEffort(obsoletePath)
      }
      for (const prepared of preparedByPending.values()) {
        if (prepared.avatarRelPath) mediaAssetStore.deleteBestEffort(prepared.avatarRelPath)
        cleanupStagedResourcePaths(prepared.stagedPaths)
      }
      return { status: 'success', remainingPending }
      })
    } catch (error) {
      if ((error as Error).message === 'STALE_CONFLICT_SNAPSHOT') return stale()
      throw error
    }
  }

  discardPendingScrape(
    input: DiscardPendingActressScrapeInput
  ): DiscardPendingActressScrapeResult {
    const db = getDb()
    const pending = db
      .prepare('SELECT actress_id, revision FROM pending_actress_scrapes WHERE id = ?')
      .get(input.pendingId) as { actress_id: number; revision: number } | undefined
    if (!pending || pending.revision !== input.expectedRevision) {
      throw new Error('待确认结果已变化，请刷新后重新确认')
    }
    const stagedPaths = (
      db
        .prepare(
          'SELECT staged_path FROM pending_actress_scrape_resources WHERE pending_scrape_id = ?'
        )
        .all(input.pendingId) as Array<{ staged_path: string }>
    ).map((row) => row.staged_path)

    const remainingPending = db.transaction(() => {
      const latest = db
        .prepare('SELECT actress_id, revision FROM pending_actress_scrapes WHERE id = ?')
        .get(input.pendingId) as { actress_id: number; revision: number } | undefined
      if (!latest || latest.revision !== input.expectedRevision) {
        throw new Error('待确认结果已变化，请刷新后重新确认')
      }
      db.prepare('DELETE FROM pending_actress_scrapes WHERE id = ?').run(input.pendingId)
      recordActressScrapeFailure(latest.actress_id)
      return (
        db.prepare('SELECT COUNT(*) AS total FROM pending_actress_scrapes').get() as {
          total: number
        }
      ).total
    })()
    cleanupStagedResourcePaths(stagedPaths)
    return { remainingPending }
  }
}

export const actressIdentityConflictWorkflow = new ActressIdentityConflictWorkflow()
