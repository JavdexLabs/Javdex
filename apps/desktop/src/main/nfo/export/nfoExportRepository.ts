import type Database from 'better-sqlite3'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import { getDb } from '../../db/database'
import { getMediaLibraryRoot } from '../../db/mediaLibraryRepo'
import type {
  NfoExportActor,
  NfoExportIdentity,
  NfoExportRating
} from './nfoExportProfiles'

interface ExportResourceRow {
  resource_id: number
  library_id: number
  library_revision: number
  video_id: number
  root_id: number | null
  kind: string
  locator: string
  strm_source_path: string | null
  resource_size: number | null
  resource_mtime: number | null
  code: string
  title: string | null
  original_title: string | null
  summary: string | null
  cover_path: string | null
  poster_path: string | null
  release_date: string | null
  duration_seconds: number | null
  updated_at: string | null
  maker: string | null
  publisher: string | null
  series: string | null
  director: string | null
}

export interface NfoExportResourceSnapshot {
  resourceId: number
  libraryId: number
  libraryRevision: number
  videoId: number
  rootId: number | null
  root: MediaLibraryRoot | null
  kind: string
  anchorPath: string | null
  resourceSize: number | null
  resourceMtime: number | null
  code: string
  title?: string
  originalTitle?: string
  summary?: string
  coverPath?: string
  posterPath?: string
  releaseDate?: string
  durationSeconds?: number
  updatedAt?: string
  maker?: string
  publisher?: string
  series?: string
  director?: string
  tags: string[]
  actors: Array<NfoExportActor & { avatarPath?: string; actressRevision: number }>
  ratings: NfoExportRating[]
  identities: NfoExportIdentity[]
  samples: string[]
}

export interface NfoExportRepository {
  listActiveLibraries(): Array<{ id: number; name: string }>
  listResourceSnapshots(libraryIds: readonly number[]): NfoExportResourceSnapshot[]
  getResourceSnapshot(resourceId: number): NfoExportResourceSnapshot | null
}

function optional(value: string | null): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

export class SqliteNfoExportRepository implements NfoExportRepository {
  constructor(
    private readonly database: () => Database.Database = getDb,
    private readonly readRoot: (libraryId: number, rootId: number) => MediaLibraryRoot | null =
      getMediaLibraryRoot
  ) {}

  listActiveLibraries(): Array<{ id: number; name: string }> {
    return this.database()
      .prepare(
        `SELECT id, name FROM media_libraries
          WHERE status = 'active'
          ORDER BY position, id`
      )
      .all() as Array<{ id: number; name: string }>
  }

  listResourceSnapshots(libraryIds: readonly number[]): NfoExportResourceSnapshot[] {
    const allowed = new Set(
      this.listActiveLibraries().map((library) => library.id).filter((id) => libraryIds.includes(id))
    )
    if (allowed.size === 0) return []
    const placeholders = [...allowed].map(() => '?').join(', ')
    const rows = this.database()
      .prepare(`${this.baseQuery()} WHERE resource.library_id IN (${placeholders})
        ORDER BY resource.library_id, resource.video_id, resource.id`)
      .all(...allowed) as ExportResourceRow[]
    return rows.map((row) => this.hydrate(row))
  }

  getResourceSnapshot(resourceId: number): NfoExportResourceSnapshot | null {
    const row = this.database()
      .prepare(`${this.baseQuery()} WHERE resource.id = ? AND library.status = 'active'`)
      .get(resourceId) as ExportResourceRow | undefined
    return row ? this.hydrate(row) : null
  }

  private baseQuery(): string {
    return `SELECT
      resource.id AS resource_id,
      resource.library_id,
      library.revision AS library_revision,
      resource.video_id,
      resource.root_id,
      resource.kind,
      resource.locator,
      resource.strm_source_path,
      resource.size_bytes AS resource_size,
      resource.file_mtime_ms AS resource_mtime,
      video.code,
      video.title,
      video.original_title,
      video.summary,
      video.cover_path,
      video.poster_path,
      video.release_date,
      video.duration_seconds,
      video.updated_at,
      maker.main_name AS maker,
      publisher.main_name AS publisher,
      series.main_name AS series,
      director.main_name AS director
    FROM video_resources resource
    JOIN media_libraries library ON library.id = resource.library_id
    JOIN videos video ON video.id = resource.video_id
    LEFT JOIN organizations maker ON maker.id = video.maker_organization_id
    LEFT JOIN organizations publisher ON publisher.id = video.publisher_organization_id
    LEFT JOIN series ON series.id = video.series_id
    LEFT JOIN directors director ON director.id = video.director_id`
  }

  private hydrate(row: ExportResourceRow): NfoExportResourceSnapshot {
    const database = this.database()
    const tags = database
      .prepare(`SELECT tag.name FROM video_tag item JOIN tags tag ON tag.id = item.tag_id
        WHERE item.video_id = ? ORDER BY tag.name COLLATE NOCASE, tag.id`)
      .all(row.video_id) as Array<{ name: string }>
    const actors = database
      .prepare(`SELECT actress.main_name AS name, actress.gender, actress.avatar_path,
          actress.revision
        FROM video_actress item JOIN actresses actress ON actress.id = item.actress_id
        WHERE item.video_id = ? ORDER BY actress.main_name COLLATE NOCASE, actress.id`)
      .all(row.video_id) as Array<{
        name: string
        gender: 'female' | 'male' | null
        avatar_path: string | null
        revision: number
      }>
    const ratings = database
      .prepare(`SELECT source, rating_average, rating_count FROM video_external_stats
        WHERE video_id = ? AND rating_average IS NOT NULL ORDER BY source`)
      .all(row.video_id) as Array<{
        source: string
        rating_average: number
        rating_count: number | null
      }>
    const identities = database
      .prepare(`SELECT source, external_code FROM video_sources
        WHERE video_id = ? AND external_code IS NOT NULL ORDER BY source`)
      .all(row.video_id) as Array<{ source: string; external_code: string }>
    const samples = database
      .prepare(`SELECT local_path FROM video_assets
        WHERE video_id = ? AND type = 'sample' AND local_path IS NOT NULL
        ORDER BY position, id`)
      .all(row.video_id) as Array<{ local_path: string }>
    const root = row.root_id == null ? null : this.readRoot(row.library_id, row.root_id)
    return {
      resourceId: row.resource_id,
      libraryId: row.library_id,
      libraryRevision: row.library_revision,
      videoId: row.video_id,
      rootId: row.root_id,
      root,
      kind: row.kind,
      anchorPath: row.kind === 'local' ? row.locator : row.strm_source_path,
      resourceSize: row.resource_size,
      resourceMtime: row.resource_mtime,
      code: row.code,
      title: optional(row.title),
      originalTitle: optional(row.original_title),
      summary: optional(row.summary),
      coverPath: optional(row.cover_path),
      posterPath: optional(row.poster_path),
      releaseDate: optional(row.release_date),
      durationSeconds: row.duration_seconds ?? undefined,
      updatedAt: optional(row.updated_at),
      maker: optional(row.maker),
      publisher: optional(row.publisher),
      series: optional(row.series),
      director: optional(row.director),
      tags: tags.map((tag) => tag.name),
      actors: actors.map((actor) => ({
        name: actor.name,
        ...(actor.gender ? { gender: actor.gender } : {}),
        ...(optional(actor.avatar_path) ? { avatarPath: actor.avatar_path! } : {}),
        actressRevision: actor.revision
      })),
      ratings: ratings.map((rating) => ({
        source: rating.source,
        average: rating.rating_average,
        ...(rating.rating_count == null ? {} : { count: rating.rating_count })
      })),
      identities: identities.map((identity) => ({
        source: identity.source,
        code: identity.external_code
      })),
      samples: samples.map((sample) => sample.local_path)
    }
  }
}

export const nfoExportRepository = new SqliteNfoExportRepository()
