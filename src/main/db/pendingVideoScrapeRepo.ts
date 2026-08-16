import type {
  PendingVideoScrape,
  ScrapeResult,
  VideoScrapeField,
  VideoScrapeUpdateMode
} from '@shared/videoScrapeTypes'
import { getDb } from './database'

export interface StagedVideoScrapeResourceInput {
  field: 'cover' | 'samples' | 'actressAvatar'
  position: number
  remoteUrl: string | null
  stagedPath: string
  width?: number | null
  height?: number | null
  sizeBytes?: number | null
}

export interface PendingVideoScrapeCandidateInput {
  result: ScrapeResult
  sourceUrl: string | null
  normalizedSourceUrl: string | null
  resources: StagedVideoScrapeResourceInput[]
}

export interface PendingVideoScrapeSourceInput {
  pluginName: string
  pluginSource: 'builtin' | 'user' | 'composite'
  pluginVersion: string | null
  pluginConfig: unknown
  sourceName: string
  selectedFields: VideoScrapeField[]
  candidates: PendingVideoScrapeCandidateInput[]
}

export interface PendingVideoScrapeInput {
  videoId: number
  selectedFields: VideoScrapeField[]
  applicableFields: VideoScrapeField[]
  updateMode: VideoScrapeUpdateMode
  request: unknown
  warnings: string[]
  batchJobId?: string | null
  sources: PendingVideoScrapeSourceInput[]
}

export interface PendingVideoScrapeResolutionCandidate {
  id: number
  result: ScrapeResult
  resources: Array<StagedVideoScrapeResourceInput & { id: number }>
}

export interface PendingVideoScrapeResolutionSource {
  id: number
  pluginName: string
  pluginConfig: unknown
  sourceName: string
  selectedFields: VideoScrapeField[]
  candidates: PendingVideoScrapeResolutionCandidate[]
}

export interface PendingVideoScrapeResolutionSnapshot {
  pending: PendingVideoScrape
  request: unknown
  sources: PendingVideoScrapeResolutionSource[]
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function replacePendingVideoScrape(
  input: PendingVideoScrapeInput
): { pendingScrapeId: number; obsoletePaths: string[] } {
  const db = getDb()
  return db.transaction(() => {
    const existing = db
      .prepare('SELECT id, revision FROM pending_video_scrapes WHERE video_id = ?')
      .get(input.videoId) as { id: number; revision: number } | undefined
    const obsoletePaths = existing
      ? (
          db
            .prepare(
              `SELECT r.staged_path
               FROM pending_video_scrape_resources r
               JOIN pending_video_scrape_candidates c ON c.id = r.candidate_id
               JOIN pending_video_scrape_sources s ON s.id = c.source_id
               WHERE s.pending_scrape_id = ?`
            )
            .all(existing.id) as Array<{ staged_path: string }>
        ).map((row) => row.staged_path)
      : []
    if (existing) db.prepare('DELETE FROM pending_video_scrapes WHERE id = ?').run(existing.id)
    const now = new Date().toISOString()
    const pendingId = Number(
      db
        .prepare(
          `INSERT INTO pending_video_scrapes (
             video_id, revision, selected_fields_json, applicable_fields_json,
             update_mode, request_json, warnings_json, batch_job_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.videoId,
          (existing?.revision ?? 0) + 1,
          JSON.stringify(input.selectedFields),
          JSON.stringify(input.applicableFields),
          input.updateMode,
          JSON.stringify(input.request),
          JSON.stringify(input.warnings),
          input.batchJobId ?? null,
          now,
          now
        ).lastInsertRowid
    )
    const insertSource = db.prepare(
      `INSERT INTO pending_video_scrape_sources (
         pending_scrape_id, position, plugin_name, plugin_source, plugin_version,
         plugin_config_json, source_name, selected_fields_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertCandidate = db.prepare(
      `INSERT INTO pending_video_scrape_candidates (
         source_id, position, result_json, source_url, normalized_source_url
       ) VALUES (?, ?, ?, ?, ?)`
    )
    const insertResource = db.prepare(
      `INSERT INTO pending_video_scrape_resources (
         candidate_id, field, position, remote_url, staged_path, width, height, size_bytes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    input.sources.forEach((source, sourcePosition) => {
      const sourceId = Number(
        insertSource.run(
          pendingId,
          sourcePosition,
          source.pluginName,
          source.pluginSource,
          source.pluginVersion,
          JSON.stringify(source.pluginConfig),
          source.sourceName,
          JSON.stringify(source.selectedFields)
        ).lastInsertRowid
      )
      source.candidates.forEach((candidate, candidatePosition) => {
        const candidateId = Number(
          insertCandidate.run(
            sourceId,
            candidatePosition,
            JSON.stringify(candidate.result),
            candidate.sourceUrl,
            candidate.normalizedSourceUrl
          ).lastInsertRowid
        )
        for (const resource of candidate.resources) {
          insertResource.run(
            candidateId,
            resource.field,
            resource.position,
            resource.remoteUrl,
            resource.stagedPath,
            resource.width ?? null,
            resource.height ?? null,
            resource.sizeBytes ?? null
          )
        }
      })
    })
    return { pendingScrapeId: pendingId, obsoletePaths }
  })()
}

export function getPendingVideoScrapeById(id: number): PendingVideoScrape | null {
  const db = getDb()
  const pending = db
    .prepare('SELECT * FROM pending_video_scrapes WHERE id = ?')
    .get(id) as
    | {
        id: number
        video_id: number
        revision: number
        selected_fields_json: string
        applicable_fields_json: string
        update_mode: VideoScrapeUpdateMode
        warnings_json: string
        created_at: string
        updated_at: string
      }
    | undefined
  if (!pending) return null
  const sources = db
    .prepare(
      `SELECT id, position, plugin_name, plugin_source, plugin_version,
              source_name, selected_fields_json, selected_candidate_id
       FROM pending_video_scrape_sources WHERE pending_scrape_id = ? ORDER BY position, id`
    )
    .all(id) as Array<{
    id: number
    position: number
    plugin_name: string
    plugin_source: 'builtin' | 'user' | 'composite'
    plugin_version: string | null
    source_name: string
    selected_fields_json: string
    selected_candidate_id: number | null
  }>
  let stagedBytes = 0
  const mappedSources = sources.map((source) => {
    const candidates = db
      .prepare(
        `SELECT id, position, result_json, source_url
         FROM pending_video_scrape_candidates WHERE source_id = ? ORDER BY position, id`
      )
      .all(source.id) as Array<{
      id: number
      position: number
      result_json: string
      source_url: string | null
    }>
    return {
      id: source.id,
      position: source.position,
      pluginName: source.plugin_name,
      pluginSource: source.plugin_source,
      pluginVersion: source.plugin_version,
      sourceName: source.source_name,
      selectedFields: parseJson<VideoScrapeField[]>(source.selected_fields_json, []),
      selectedCandidateId: source.selected_candidate_id,
      candidates: candidates.map((candidate) => {
        const resources = db
          .prepare(
            `SELECT field, position, staged_path, size_bytes
             FROM pending_video_scrape_resources WHERE candidate_id = ? ORDER BY field, position`
          )
          .all(candidate.id) as Array<{
          field: 'cover' | 'samples' | 'actressAvatar'
          position: number
          staged_path: string
          size_bytes: number | null
        }>
        stagedBytes += resources.reduce((sum, resource) => sum + (resource.size_bytes ?? 0), 0)
        return {
          id: candidate.id,
          position: candidate.position,
          result: parseJson<ScrapeResult>(candidate.result_json, { code: '' }),
          sourceUrl: candidate.source_url,
          stagedCoverPath:
            resources.find((resource) => resource.field === 'cover')?.staged_path ?? null,
          stagedSamplePaths: resources
            .filter((resource) => resource.field === 'samples')
            .sort((left, right) => left.position - right.position)
            .map((resource) => resource.staged_path),
          stagedActressAvatarPaths: resources
            .filter((resource) => resource.field === 'actressAvatar')
            .sort((left, right) => left.position - right.position)
            .map((resource) => resource.staged_path)
        }
      })
    }
  })
  return {
    id: pending.id,
    videoId: pending.video_id,
    revision: pending.revision,
    selectedFields: parseJson<VideoScrapeField[]>(pending.selected_fields_json, []),
    applicableFields: parseJson<VideoScrapeField[]>(pending.applicable_fields_json, []),
    updateMode: pending.update_mode,
    warnings: parseJson<string[]>(pending.warnings_json, []),
    createdAt: pending.created_at,
    updatedAt: pending.updated_at,
    sources: mappedSources,
    stagedBytes
  }
}

export function getPendingVideoScrapeResolutionSnapshot(
  id: number
): PendingVideoScrapeResolutionSnapshot | null {
  const pending = getPendingVideoScrapeById(id)
  if (!pending) return null
  const db = getDb()
  const requestRow = db
    .prepare('SELECT request_json FROM pending_video_scrapes WHERE id = ?')
    .get(id) as { request_json: string }
  const sourceRows = db
    .prepare(
      `SELECT id, plugin_name, plugin_config_json, source_name, selected_fields_json
       FROM pending_video_scrape_sources WHERE pending_scrape_id = ? ORDER BY position, id`
    )
    .all(id) as Array<{
    id: number
    plugin_name: string
    plugin_config_json: string
    source_name: string
    selected_fields_json: string
  }>
  return {
    pending,
    request: parseJson<unknown>(requestRow.request_json, {}),
    sources: sourceRows.map((source) => {
      const candidateRows = db
        .prepare(
          `SELECT id, result_json FROM pending_video_scrape_candidates
           WHERE source_id = ? ORDER BY position, id`
        )
        .all(source.id) as Array<{ id: number; result_json: string }>
      return {
        id: source.id,
        pluginName: source.plugin_name,
        pluginConfig: parseJson<unknown>(source.plugin_config_json, {}),
        sourceName: source.source_name,
        selectedFields: parseJson<VideoScrapeField[]>(source.selected_fields_json, []),
        candidates: candidateRows.map((candidate) => ({
          id: candidate.id,
          result: parseJson<ScrapeResult>(candidate.result_json, { code: '' }),
          resources: (
            db
              .prepare(
                `SELECT id, field, position, remote_url, staged_path, width, height, size_bytes
                 FROM pending_video_scrape_resources WHERE candidate_id = ?
                 ORDER BY field, position, id`
              )
              .all(candidate.id) as Array<{
              id: number
              field: 'cover' | 'samples' | 'actressAvatar'
              position: number
              remote_url: string | null
              staged_path: string
              width: number | null
              height: number | null
              size_bytes: number | null
            }>
          ).map((resource) => ({
            id: resource.id,
            field: resource.field,
            position: resource.position,
            remoteUrl: resource.remote_url,
            stagedPath: resource.staged_path,
            width: resource.width,
            height: resource.height,
            sizeBytes: resource.size_bytes
          }))
        }))
      }
    })
  }
}

export function getPendingVideoScrapeForVideo(videoId: number): PendingVideoScrape | null {
  const row = getDb()
    .prepare('SELECT id FROM pending_video_scrapes WHERE video_id = ?')
    .get(videoId) as { id: number } | undefined
  return row ? getPendingVideoScrapeById(row.id) : null
}

export function listPendingVideoScrapes(): PendingVideoScrape[] {
  const rows = getDb()
    .prepare('SELECT id FROM pending_video_scrapes ORDER BY created_at, id')
    .all() as Array<{ id: number }>
  return rows.flatMap((row) => {
    const pending = getPendingVideoScrapeById(row.id)
    return pending ? [pending] : []
  })
}

export function deletePendingVideoScrape(
  pendingScrapeId: number
): { videoId: number; stagedPaths: string[] } | null {
  const db = getDb()
  return db.transaction(() => {
    const pending = db
      .prepare('SELECT video_id FROM pending_video_scrapes WHERE id = ?')
      .get(pendingScrapeId) as { video_id: number } | undefined
    if (!pending) return null
    const stagedPaths = (
      db
        .prepare(
          `SELECT r.staged_path
           FROM pending_video_scrape_resources r
           JOIN pending_video_scrape_candidates c ON c.id = r.candidate_id
           JOIN pending_video_scrape_sources s ON s.id = c.source_id
           WHERE s.pending_scrape_id = ?`
        )
        .all(pendingScrapeId) as Array<{ staged_path: string }>
    ).map((row) => row.staged_path)
    db.prepare('DELETE FROM pending_video_scrapes WHERE id = ?').run(pendingScrapeId)
    return { videoId: pending.video_id, stagedPaths }
  })()
}

export function deletePendingVideoScrapeForVideo(
  videoId: number
): { videoId: number; stagedPaths: string[] } | null {
  const row = getDb()
    .prepare('SELECT id FROM pending_video_scrapes WHERE video_id = ?')
    .get(videoId) as { id: number } | undefined
  return row ? deletePendingVideoScrape(row.id) : null
}
