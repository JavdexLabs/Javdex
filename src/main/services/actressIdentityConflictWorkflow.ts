import type {
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
  PendingActressScrapeResource
} from '@shared/types'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db/database'
import { normalizeActressName } from '../db/actressNameNormalization'
import {
  applyActressScrapeResult,
  recordActressScrapeFailure
} from '../db/actressRepo'
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
  const selected = new Set(input.applicableFields)
  const names: Array<{ name: string | undefined; type: ActressPendingNameType }> = []
  if (selected.has('nameZh')) names.push({ name: input.result.nameZh, type: 'zh' })
  if (selected.has('nameEn')) names.push({ name: input.result.nameEn, type: 'en' })
  if (selected.has('aliases')) {
    for (const name of input.result.aliases ?? []) names.push({ name, type: 'alias' })
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

function conflictingNames(actressId: number, names: PendingName[]): PendingName[] {
  const db = getDb()
  const ownerQuery = db.prepare(
    'SELECT actress_id FROM actress_name_ownership WHERE normalized_name = ?'
  )
  const pendingClaimQuery = db.prepare(
    `SELECT 1 FROM pending_actress_name_claims
     WHERE normalized_name = ? AND actress_id != ? LIMIT 1`
  )
  return names.filter((name) => {
    const owner = ownerQuery.get(name.normalizedName) as { actress_id: number } | undefined
    if (owner && owner.actress_id !== actressId) return true
    return Boolean(pendingClaimQuery.get(name.normalizedName, actressId))
  })
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
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
    const pendingRows = db
      .prepare(
        `SELECT p.*, a.main_name, a.avatar_path
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
      actressRevision: row.target_actress_revision,
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
      conflicts: conflictsByPending.get(row.id) ?? []
    }))

    const grouped = new Map<string, ActressNameConflictGroup>()
    for (const candidate of candidates) {
      for (const conflict of candidate.conflicts) {
        let group = grouped.get(conflict.normalizedName)
        if (!group) {
          const owner = db
            .prepare(
              `SELECT o.actress_id, a.main_name, a.avatar_path
               FROM actress_name_ownership o
               JOIN actresses a ON a.id = o.actress_id
               WHERE o.normalized_name = ?`
            )
            .get(conflict.normalizedName) as
            | { actress_id: number; main_name: string; avatar_path: string | null }
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
            normalizedName: conflict.normalizedName,
            displayName: conflict.name,
            currentOwner: owner
              ? {
                  actressId: owner.actress_id,
                  mainName: owner.main_name,
                  avatarPath: owner.avatar_path,
                  nameTypes: ownerTypes.map((item) => item.type)
                }
              : null,
            candidates: []
          }
          grouped.set(conflict.normalizedName, group)
        }
        if (!group.candidates.some((item) => item.pendingId === candidate.pendingId)) {
          group.candidates.push(candidate)
        }
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
