import type {
  ActressConflictCurrentOwner,
  ActressNameConflictGroup,
  ActressPendingNameType,
  ActressScrapeDisposition,
  ActressScrapeField,
  ActressScrapePluginRef,
  ActressScrapeResult,
  ActressScrapeUpdateMode,
  DiscardPendingActressScrapeInput,
  DiscardPendingActressScrapeResult,
  PendingActressScrapeCandidate,
  PendingActressScrapeResource,
  ResolveActressConflictInput,
  ResolveActressConflictResult
} from '@shared/types'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/database'
import { normalizeActressName } from '../db/actressNameNormalization'
import {
  applyActressScrapeResult,
  markActressScrapeSucceeded,
  recordActressScrapeFailure
} from '../db/actressRepo'
import { synchronizeActressNameOwnership } from '../db/actressNameOwnership'
import { setActressTypedName, upsertActressName } from '../db/actressNames'
import {
  assetsRoot,
  deleteAsset,
  detectImageExtensionFromBuffer,
  isUsableImageBuffer,
  storeScrapedActressAvatar,
  storeScrapedActressGalleryImage
} from './assetService'

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

interface PreparedPendingFormalResources {
  avatarRelPath: string | null
  galleryAssets: Array<{
    remoteUrl: string
    localPath: string
    width: number | null
    height: number | null
  }>
  createdPaths: string[]
  stagedPaths: string[]
}

const STAGING_DIRNAME = '.actress_scrape_staging'
const DEFAULT_ORPHAN_SAFETY_AGE_MS = 24 * 60 * 60 * 1000

function stagePreparedResources(
  resources: PreparedActressScrapeResource[]
): PendingActressScrapeResource[] {
  if (resources.length === 0) return []
  const root = assetsRoot()
  const token = crypto.randomUUID()
  const relativeDir = path.posix.join(STAGING_DIRNAME, token)
  const absoluteDir = path.join(root, STAGING_DIRNAME, token)
  fs.mkdirSync(absoluteDir, { recursive: true })
  const staged: PendingActressScrapeResource[] = []
  try {
    for (const resource of resources) {
      if (!isUsableImageBuffer(resource.data)) {
        throw new Error('暂存资源不是可用图片')
      }
      const extension = detectImageExtensionFromBuffer(resource.data) ?? '.jpg'
      const filename = `${resource.field}-${resource.position}${extension}`
      fs.writeFileSync(path.join(absoluteDir, filename), resource.data)
      staged.push({
        field: resource.field,
        position: resource.position,
        ...(resource.remoteUrl?.trim() ? { remoteUrl: resource.remoteUrl.trim() } : {}),
        stagedPath: path.posix.join(relativeDir, filename),
        width: resource.width ?? null,
        height: resource.height ?? null
      })
    }
    return staged
  } catch (error) {
    fs.rmSync(absoluteDir, { recursive: true, force: true })
    throw error
  }
}

function cleanupStagedResourcePaths(stagedPaths: string[]): void {
  const stagingRoot = path.resolve(assetsRoot(), STAGING_DIRNAME)
  const directories = new Set<string>()
  for (const stagedPath of stagedPaths) {
    const absolutePath = path.resolve(assetsRoot(), stagedPath)
    if (!absolutePath.startsWith(`${stagingRoot}${path.sep}`)) continue
    directories.add(path.dirname(absolutePath))
  }
  for (const directory of directories) {
    if (!directory.startsWith(`${stagingRoot}${path.sep}`)) continue
    try {
      fs.rmSync(directory, { recursive: true, force: true })
    } catch (error) {
      console.error('cleanup staged actress scrape resources failed:', (error as Error).message)
    }
  }
}

/** Remove crash leftovers while preserving every referenced or recently written staging dir. */
export function cleanupOrphanedActressScrapeStaging(options?: {
  now?: number
  olderThanMs?: number
}): number {
  const stagingRoot = path.resolve(assetsRoot(), STAGING_DIRNAME)
  if (!fs.existsSync(stagingRoot)) return 0
  const referencedDirectories = new Set(
    (
      getDb().prepare('SELECT staged_path FROM pending_actress_scrape_resources').all() as Array<{
        staged_path: string
      }>
    ).map((row) => path.dirname(path.resolve(assetsRoot(), row.staged_path)))
  )
  const now = options?.now ?? Date.now()
  const olderThanMs = options?.olderThanMs ?? DEFAULT_ORPHAN_SAFETY_AGE_MS
  let removed = 0
  for (const entry of fs.readdirSync(stagingRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = path.resolve(stagingRoot, entry.name)
    if (!directory.startsWith(`${stagingRoot}${path.sep}`)) continue
    if (referencedDirectories.has(directory)) continue
    const stat = fs.statSync(directory)
    if (now - stat.mtimeMs < olderThanMs) continue
    fs.rmSync(directory, { recursive: true, force: true })
    removed += 1
  }
  return removed
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

function readNameClaimants(normalizedName: string): ActressConflictCurrentOwner[] {
  const rows = getDb()
    .prepare(
      `SELECT a.id AS actress_id, a.revision, a.main_name, a.avatar_path, n.type
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
    type: ActressPendingNameType
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
        nameTypes: []
      }
      claimants.set(row.actress_id, claimant)
    }
    if (!claimant.nameTypes.includes(row.type)) claimant.nameTypes.push(row.type)
  }
  return [...claimants.values()]
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

function ensureCurrentPendingConflicts(): void {
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
  const replacementNormalized = normalizeActressName(replacement)
  if (replacementNormalized === normalizedName) {
    throw new Error('替代主名不能与被移除的名称相同')
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
    throw new Error(`替代主名「${replacement}」已被其他演员使用`)
  }

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
  const prepared: PreparedPendingFormalResources = {
    avatarRelPath: null,
    galleryAssets: [],
    createdPaths: [],
    stagedPaths: resources.map((resource) => resource.staged_path)
  }
  const stagingRoot = path.resolve(assetsRoot(), STAGING_DIRNAME)
  try {
    for (const resource of resources) {
      const stagedAbsolutePath = path.resolve(assetsRoot(), resource.staged_path)
      if (!stagedAbsolutePath.startsWith(`${stagingRoot}${path.sep}`)) {
        throw new Error('待确认暂存资源路径无效')
      }
      const data = fs.readFileSync(stagedAbsolutePath)
      if (!isUsableImageBuffer(data)) throw new Error('待确认暂存资源不可用')
      const remoteUrl = resource.remote_url?.trim() ?? ''
      if (resource.field === 'avatar') {
        prepared.avatarRelPath = storeScrapedActressAvatar(
          actress.main_name,
          remoteUrl,
          data
        )
        prepared.createdPaths.push(prepared.avatarRelPath)
      } else {
        const stored = storeScrapedActressGalleryImage(
          actress.main_name,
          actress.id,
          remoteUrl,
          data
        )
        prepared.createdPaths.push(stored.localPath)
        prepared.galleryAssets.push({
          remoteUrl,
          localPath: stored.localPath,
          width: resource.width ?? stored.width,
          height: resource.height ?? stored.height
        })
      }
    }
    return prepared
  } catch (error) {
    for (const createdPath of prepared.createdPaths) deleteAsset(createdPath)
    throw error
  }
}

export class ActressIdentityConflictWorkflow {
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
      let avatarRelPath: string | null = null
      const galleryAssets: Array<{
        remoteUrl: string
        localPath: string
        width: number | null
        height: number | null
      }> = []
      const newlyStoredPaths: string[] = []
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
        for (const resource of input.resources) {
          const remoteUrl = resource.remoteUrl?.trim() ?? ''
          if (resource.field === 'avatar') {
            avatarRelPath = storeScrapedActressAvatar(
              detail.main_name,
              remoteUrl,
              resource.data
            )
            newlyStoredPaths.push(avatarRelPath)
          } else {
            const stored = storeScrapedActressGalleryImage(
              detail.main_name,
              input.actressId,
              remoteUrl,
              resource.data
            )
            newlyStoredPaths.push(stored.localPath)
            galleryAssets.push({
              remoteUrl,
              localPath: stored.localPath,
              width: resource.width ?? stored.width,
              height: resource.height ?? stored.height
            })
          }
        }
        const applied = applyActressScrapeResult(
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
        if (!applied.applied) {
          for (const storedPath of newlyStoredPaths) deleteAsset(storedPath)
          recordActressScrapeFailure(input.actressId)
          return {
            status: 'failure',
            ok: false,
            error: '未找到有效的演员资料',
            warnings:
              [...input.warnings, ...applied.warnings].length > 0
                ? [...input.warnings, ...applied.warnings]
                : undefined
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
        for (const storedPath of newlyStoredPaths) deleteAsset(storedPath)
        recordActressScrapeFailure(input.actressId)
        return { status: 'failure', ok: false, error: (error as Error).message }
      }
    }

    const createdAt = new Date().toISOString()
    const stagedResources = stagePreparedResources(input.resources)
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
    let pendingId: number
    try {
      pendingId = db.transaction(() => {
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
    } catch (error) {
      cleanupStagedResourcePaths(stagedResources.map((resource) => resource.stagedPath))
      throw error
    }
    cleanupStagedResourcePaths(obsoleteStagedPaths)

    return {
      status: 'pending',
      ok: true,
      pendingId,
      result: input.result,
      warnings: input.warnings.length > 0 ? input.warnings : undefined
    }
  }

  listConflictGroups(): ActressNameConflictGroup[] {
    const db = getDb()
    ensureCurrentPendingConflicts()
    const pendingRows = db
      .prepare(
        `SELECT p.*, a.main_name, a.avatar_path, a.revision AS current_actress_revision
         FROM pending_actress_scrapes p
         JOIN actresses a ON a.id = p.actress_id
         ORDER BY p.created_at, p.id`
      )
      .all() as PendingRow[]
    const conflicts = db
      .prepare(
        `SELECT pending_scrape_id, normalized_name, name, name_type
         FROM pending_actress_scrape_conflicts
         ORDER BY id`
      )
      .all() as Array<{
      pending_scrape_id: number
      normalized_name: string
      name: string
      name_type: ActressPendingNameType
      }>
    const resourceRows = db
      .prepare(
        `SELECT pending_scrape_id, field, position, remote_url, staged_path, width, height
         FROM pending_actress_scrape_resources
         ORDER BY pending_scrape_id, field, position`
      )
      .all() as PendingResourceRow[]
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
      )
    }))

    const grouped = new Map<string, ActressNameConflictGroup>()
    for (const candidate of candidates) {
      for (const conflict of candidate.conflicts) {
        let group = grouped.get(conflict.normalizedName)
        if (!group) {
          const owner = db
            .prepare(
              `SELECT o.actress_id, a.main_name, a.avatar_path, a.revision
               FROM actress_name_ownership o
               JOIN actresses a ON a.id = o.actress_id
               WHERE o.normalized_name = ?`
            )
            .get(conflict.normalizedName) as
            | {
                actress_id: number
                main_name: string
                avatar_path: string | null
                revision: number
              }
            | undefined
          const ownerTypes = owner
            ? (db
                .prepare(
                  `SELECT DISTINCT type FROM actress_names
                   WHERE actress_id = ? AND normalize_actress_name(name) = ?
                   ORDER BY type`
                )
                .all(owner.actress_id, conflict.normalizedName) as Array<{
                type: ActressPendingNameType
              }>)
            : []
          group = {
            status: 'conflict',
            normalizedName: conflict.normalizedName,
            displayName: conflict.name,
            currentOwner: owner
              ? {
                  actressId: owner.actress_id,
                  revision: owner.revision,
                  mainName: owner.main_name,
                  avatarPath: owner.avatar_path,
                  nameTypes: ownerTypes.map((item) => item.type)
                }
              : null,
            claimants: readNameClaimants(conflict.normalizedName),
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
      const owner = db
        .prepare(
          `SELECT o.actress_id, a.main_name, a.avatar_path, a.revision
           FROM actress_name_ownership o
           JOIN actresses a ON a.id = o.actress_id
           WHERE o.normalized_name = ?`
        )
        .get(previousConflict.normalizedName) as
        | {
            actress_id: number
            main_name: string
            avatar_path: string | null
            revision: number
          }
        | undefined
      const ownerTypes = owner
        ? (db
            .prepare(
              `SELECT DISTINCT type FROM actress_names
               WHERE actress_id = ? AND normalize_actress_name(name) = ?
               ORDER BY type`
            )
            .all(owner.actress_id, previousConflict.normalizedName) as Array<{
            type: ActressPendingNameType
          }>)
        : []
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
          currentOwner: owner
            ? {
                actressId: owner.actress_id,
                revision: owner.revision,
                mainName: owner.main_name,
                avatarPath: owner.avatar_path,
                nameTypes: ownerTypes.map((item) => item.type)
              }
            : null,
          claimants: readNameClaimants(previousConflict.normalizedName),
          candidates: [candidate]
        })
      }
    }
    return [...grouped.values()].sort((a, b) =>
      a.normalizedName.localeCompare(b.normalizedName)
    )
  }

  countPendingScrapes(): number {
    return (
      getDb().prepare('SELECT COUNT(*) AS total FROM pending_actress_scrapes').get() as {
        total: number
      }
    ).total
  }

  resolveConflict(input: ResolveActressConflictInput): ResolveActressConflictResult {
    const db = getDb()
    ensureCurrentPendingConflicts()
    const stale = (): ResolveActressConflictResult => ({
      status: 'stale',
      message: '数据已变化，请刷新后重新确认'
    })
    const snapshotMatches = (): boolean => {
      const owner = db
        .prepare(
          `SELECT o.actress_id, a.revision
           FROM actress_name_ownership o
           JOIN actresses a ON a.id = o.actress_id
           WHERE o.normalized_name = ?`
        )
        .get(input.snapshot.normalizedName) as
        | { actress_id: number; revision: number }
        | undefined
      if ((owner?.actress_id ?? null) !== input.snapshot.currentOwnerActressId) return false
      if ((owner?.revision ?? null) !== input.snapshot.currentOwnerRevision) return false
      const expectedClaimants = [...input.snapshot.claimants].sort(
        (a, b) => a.actressId - b.actressId
      )
      const currentClaimants = readNameClaimants(input.snapshot.normalizedName)
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
      if (input.kind === 'assignToExistingActress') {
        const chosen = db
          .prepare('SELECT revision FROM actresses WHERE id = ?')
          .get(input.ownerActressId) as { revision: number } | undefined
        if (chosen?.revision !== input.ownerActressRevision) return false
      }

      const expectedIds = input.snapshot.candidates
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
          .all(input.snapshot.normalizedName) as Array<{ pending_scrape_id: number }>
      ).map((row) => row.pending_scrape_id)
      if (
        expectedIds.length !== actualIds.length ||
        expectedIds.some((pendingId, index) => pendingId !== actualIds[index])
      ) {
        return false
      }
      const readCandidate = db.prepare(
        `SELECT p.revision AS pending_revision, p.actress_id, a.revision AS actress_revision
         FROM pending_actress_scrapes p
         JOIN actresses a ON a.id = p.actress_id
         WHERE p.id = ?`
      )
      return input.snapshot.candidates.every((candidate) => {
        const current = readCandidate.get(candidate.pendingId) as
          | {
              pending_revision: number
              actress_id: number
              actress_revision: number
            }
          | undefined
        return (
          current?.pending_revision === candidate.pendingRevision &&
          current.actress_id === candidate.actressId &&
          current.actress_revision === candidate.actressRevision
        )
      })
    }

    if (!snapshotMatches()) return stale()
    const remainingConflictCount = (pendingId: number, excludingNormalizedName: string): number =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS total
             FROM pending_actress_scrape_conflicts
             WHERE pending_scrape_id = ? AND normalized_name != ?`
          )
          .get(pendingId, excludingNormalizedName) as { total: number }
      ).total
    const remainingConflictCountAfterItem = (
      pendingId: number,
      normalizedName: string,
      name: string,
      nameType: ActressPendingNameType
    ): number =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS total
             FROM pending_actress_scrape_conflicts
             WHERE pending_scrape_id = ? AND NOT (
               normalized_name = ? AND name = ? AND name_type = ?
             )`
          )
          .get(pendingId, normalizedName, name, nameType) as { total: number }
      ).total
    const preparedByPending = new Map<number, PreparedPendingFormalResources>()
    const preparePending = (pendingId: number): void => {
      if (!preparedByPending.has(pendingId)) {
        preparedByPending.set(pendingId, promotePendingResources(pendingId))
      }
    }
    const createdDuringApply: string[] = []
    const obsoleteAfterCommit: string[] = []
    try {
      const remainingPending = db.transaction(() => {
        if (!snapshotMatches()) throw new Error('STALE_CONFLICT_SNAPSHOT')
        const applyIfUnlocked = (
          pendingId: number,
          resultOverride?: ActressScrapeResult
        ): void => {
          const unresolved = (
            db
              .prepare(
                'SELECT COUNT(*) AS total FROM pending_actress_scrape_conflicts WHERE pending_scrape_id = ?'
              )
              .get(pendingId) as { total: number }
          ).total
          if (unresolved > 0) return
          const pending = db
            .prepare('SELECT * FROM pending_actress_scrapes WHERE id = ?')
            .get(pendingId) as PendingRow | undefined
          if (!pending) throw new Error('STALE_CONFLICT_SNAPSHOT')
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
          createdDuringApply.push(...(applied.fileChanges?.createdPaths ?? []))
          obsoleteAfterCommit.push(...(applied.fileChanges?.obsoletePaths ?? []))
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
          if (
            !stillConflicts &&
            remainingConflictCountAfterItem(
              input.pendingId,
              input.snapshot.normalizedName,
              input.name,
              input.nameType
            ) === 0
          ) {
            preparePending(input.pendingId)
          }
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
          if (remainingConflictCount(input.pendingId, input.snapshot.normalizedName) === 0) {
            preparePending(input.pendingId)
          }

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
          declarePendingNamesForActress(
            pending.actress_id,
            conflictRows.map((row) => ({
              name: row.name,
              normalizedName: row.normalized_name,
              type: row.name_type
            }))
          )
          synchronizeActressNameOwnership(pending.actress_id)
          db.prepare(
            `DELETE FROM pending_actress_scrape_conflicts
             WHERE pending_scrape_id = ? AND normalized_name = ?`
          ).run(input.pendingId, input.snapshot.normalizedName)
          db.prepare(
            'UPDATE pending_actress_scrapes SET revision = revision + 1 WHERE id = ?'
          ).run(input.pendingId)
          applyIfUnlocked(input.pendingId)
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
          if (groupConflicts.length === 0) throw new Error('STALE_CONFLICT_SNAPSHOT')
          for (const candidate of input.snapshot.candidates) {
            if (
              remainingConflictCount(candidate.pendingId, input.snapshot.normalizedName) === 0
            ) {
              preparePending(candidate.pendingId)
            }
          }

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
          const chosenHasName = db
            .prepare(
              `SELECT 1 FROM actress_names
               WHERE actress_id = ? AND normalize_actress_name(name) = ? LIMIT 1`
            )
            .get(input.ownerActressId, input.snapshot.normalizedName)
          if (!chosenHasName) {
            upsertActressName(
              input.ownerActressId,
              groupConflicts[0].name,
              'alias',
              null,
              null,
              0
            )
          }
          synchronizeActressNameOwnership(input.ownerActressId)
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
          preparePending(input.pendingId)
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
        return this.countPendingScrapes()
      })()
      for (const obsoletePath of new Set(obsoleteAfterCommit)) deleteAsset(obsoletePath)
      for (const prepared of preparedByPending.values()) {
        if (prepared.avatarRelPath) deleteAsset(prepared.avatarRelPath)
        cleanupStagedResourcePaths(prepared.stagedPaths)
      }
      return { status: 'success', remainingPending }
    } catch (error) {
      for (const createdPath of new Set([
        ...Array.from(preparedByPending.values()).flatMap((item) => item.createdPaths),
        ...createdDuringApply
      ])) {
        deleteAsset(createdPath)
      }
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
