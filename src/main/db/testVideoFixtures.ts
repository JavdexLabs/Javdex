import type Database from 'better-sqlite3'
import { normalizeClassificationName } from '../../shared/classificationNameNormalization'
import { ensureVideoMembership } from './libraryMembershipRepo'
import { buildVideoResourceSourceIdentity } from '../../shared/videoResourceIdentity'

function ensureOrganization(
  db: Database.Database,
  name: string | null | undefined,
  role: 'maker' | 'publisher'
): number | null {
  const trimmed = name?.trim()
  if (!trimmed) return null
  const normalized = normalizeClassificationName(trimmed)
  const owned = db
    .prepare('SELECT organization_id AS id FROM organization_name_ownership WHERE normalized_name = ?')
    .get(normalized) as { id: number } | undefined
  const id =
    owned?.id ??
    Number(db.prepare('INSERT INTO organizations (main_name) VALUES (?)').run(trimmed).lastInsertRowid)
  if (!owned) {
    db.prepare(
      `INSERT INTO organization_names
         (organization_id, name, normalized_name, type, position)
       VALUES (?, ?, ?, 'main', 0)`
    ).run(id, trimmed, normalized)
    db.prepare(
      'INSERT INTO organization_name_ownership (normalized_name, organization_id) VALUES (?, ?)'
    ).run(normalized, id)
  }
  db.prepare('INSERT OR IGNORE INTO organization_roles (organization_id, role) VALUES (?, ?)').run(
    id,
    role
  )
  return id
}

function ensureDirector(db: Database.Database, name: string | null | undefined): number | null {
  const trimmed = name?.trim()
  if (!trimmed) return null
  const existing = db.prepare('SELECT id FROM directors WHERE main_name = ?').get(trimmed) as
    | { id: number }
    | undefined
  if (existing) return existing.id
  const id = Number(db.prepare('INSERT INTO directors (main_name) VALUES (?)').run(trimmed).lastInsertRowid)
  db.prepare(
    `INSERT INTO director_names (director_id, name, normalized_name, type, position)
     VALUES (?, ?, ?, 'main', 0)`
  ).run(id, trimmed, normalizeClassificationName(trimmed))
  return id
}

function ensureSeries(db: Database.Database, name: string | null | undefined): number | null {
  const trimmed = name?.trim()
  if (!trimmed) return null
  const normalized = normalizeClassificationName(trimmed)
  const existing = db
    .prepare(
      `SELECT series_id AS id FROM series_name_ownership
       WHERE owner_organization_id IS NULL AND normalized_name = ?`
    )
    .get(normalized) as { id: number } | undefined
  if (existing) return existing.id
  const id = Number(db.prepare('INSERT INTO series (main_name) VALUES (?)').run(trimmed).lastInsertRowid)
  db.prepare(
    `INSERT INTO series_names (series_id, name, normalized_name, type, position)
     VALUES (?, ?, ?, 'main', 0)`
  ).run(id, trimmed, normalized)
  db.prepare(
    `INSERT INTO series_name_ownership (owner_organization_id, normalized_name, series_id)
     VALUES (NULL, ?, ?)`
  ).run(normalized, id)
  return id
}

export function insertTestVideoWithFile(
  db: Database.Database,
  opts: {
    code: string
    filePath: string
    title?: string | null
    summary?: string | null
    rating?: number
    releaseDate?: string | null
    maker?: string | null
    publisher?: string | null
    series?: string | null
    director?: string | null
    scrapedStatus?: number
    addTime?: string
    isPrimary?: boolean
    fileSize?: number | null
    libraryId?: number
    rootId?: number | null
  }
): { videoId: number; fileId: number } {
  const makerOrganizationId = ensureOrganization(db, opts.maker, 'maker')
  const publisherOrganizationId = ensureOrganization(db, opts.publisher, 'publisher')
  const seriesId = ensureSeries(db, opts.series)
  const directorId = ensureDirector(db, opts.director)
  const info = db
    .prepare(
      `INSERT INTO videos
         (code, title, summary, rating, release_date, maker_organization_id,
          publisher_organization_id, series_id, director_id, scraped_status, add_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.code,
      opts.title ?? null,
      opts.summary ?? null,
      opts.rating ?? 0,
      opts.releaseDate ?? null,
      makerOrganizationId,
      publisherOrganizationId,
      seriesId,
      directorId,
      opts.scrapedStatus ?? 0,
      opts.addTime ?? new Date().toISOString()
    )
  const videoId = Number(info.lastInsertRowid)
  const libraryId = opts.libraryId ?? 1
  ensureVideoMembership(
    {
      libraryId,
      videoId,
      addedVia: 'scan',
      addedAt: opts.addTime ?? new Date().toISOString()
    },
    db
  )
  const sourceIdentity = buildVideoResourceSourceIdentity({
    kind: 'local',
    locator: opts.filePath
  })
  const fileInfo = db
    .prepare(
      `INSERT INTO video_resources
         (library_id, video_id, root_id, kind, locator, resource_key, source_identity,
          size_bytes, is_primary, add_time)
       VALUES (?, ?, ?, 'local', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      libraryId,
      videoId,
      opts.rootId ?? null,
      opts.filePath,
      sourceIdentity,
      sourceIdentity,
      opts.fileSize ?? null,
      opts.isPrimary !== false ? 1 : 0,
      opts.addTime ?? new Date().toISOString()
    )
  return { videoId, fileId: Number(fileInfo.lastInsertRowid) }
}
