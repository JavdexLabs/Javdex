import type {
  ClassificationEntityRef,
  ClassificationImageCandidate,
  DirectorDetail,
  DirectorListItem,
  DirectorListQuery,
  DirectorOption,
  OrganizationDetail,
  OrganizationLink,
  OrganizationListItem,
  OrganizationListQuery,
  OrganizationMergeOption,
  OrganizationOption,
  OrganizationRole,
  SeriesDetail,
  SeriesListItem,
  SeriesListQuery,
  SeriesOption
} from '@shared/classificationTypes'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'
import { getDb } from '../db/database'

const VIDEO_ROLE_COLUMN: Record<OrganizationRole, string> = {
  maker: 'maker_organization_id',
  publisher: 'publisher_organization_id'
}

function requireRole(role: OrganizationRole): OrganizationRole {
  if (role !== 'maker' && role !== 'publisher') throw new Error('无效的机构角色')
  return role
}

function normalizedSearch(search: string | undefined): string {
  const trimmed = search?.trim()
  if (!trimmed) return ''
  return normalizeClassificationName(trimmed)
}

function searchLikePattern(search: string | undefined): string {
  const normalized = normalizedSearch(search)
  return normalized ? `%${normalized.replace(/[\\%_]/g, '\\$&')}%` : ''
}

export interface ClassificationQueryService {
  listImageCandidates(entity: ClassificationEntityRef): ClassificationImageCandidate[]
  listOrganizations(query: OrganizationListQuery): OrganizationListItem[]
  getOrganization(id: number, role: OrganizationRole): OrganizationDetail | null
  listOrganizationOptions(search?: string): OrganizationOption[]
  listOrganizationMergeOptions(search?: string): OrganizationMergeOption[]
  listDirectors(query: DirectorListQuery): DirectorListItem[]
  getDirector(id: number): DirectorDetail | null
  listDirectorOptions(search?: string): DirectorOption[]
  listSeries(query: SeriesListQuery): SeriesListItem[]
  getSeries(id: number): SeriesDetail | null
  listSeriesOptions(search?: string): SeriesOption[]
}

export const classificationQueryService: ClassificationQueryService = {
  listImageCandidates(entity): ClassificationImageCandidate[] {
    if (!Number.isInteger(entity.id) || entity.id <= 0) throw new Error('分类实体参数无效')
    const predicate =
      entity.kind === 'organization'
        ? '(v.maker_organization_id = ? OR v.publisher_organization_id = ?)'
        : entity.kind === 'director'
          ? 'v.director_id = ?'
          : entity.kind === 'series'
            ? 'v.series_id = ?'
            : null
    if (!predicate) throw new Error('分类实体参数无效')
    const parameters = entity.kind === 'organization' ? [entity.id, entity.id] : [entity.id]
    const rows = getDb()
      .prepare(
        `SELECT v.id AS video_id, v.code, v.title, v.cover_path
         FROM videos v
         WHERE ${predicate} AND v.cover_path IS NOT NULL AND trim(v.cover_path) != ''
         ORDER BY (v.release_date IS NULL OR trim(v.release_date) = '') ASC,
                  v.release_date DESC, v.add_time DESC, v.id DESC`
      )
      .all(...parameters) as Array<{
      video_id: number
      code: string
      title: string | null
      cover_path: string
    }>
    return rows.map((row) => ({
      videoId: row.video_id,
      code: row.code,
      title: row.title,
      coverPath: row.cover_path
    }))
  },

  listOrganizations(query): OrganizationListItem[] {
    const role = requireRole(query.role)
    const videoColumn = VIDEO_ROLE_COLUMN[role]
    const search = searchLikePattern(query.search)
    const sortBy = query.sortBy === 'updated_at' ? 'updated_at' : 'video_count'
    const sortDir = query.sortDir === 'asc' ? 'ASC' : 'DESC'
    const order = sortBy === 'updated_at' ? `o.updated_at ${sortDir}` : `video_count ${sortDir}`
    const rows = getDb()
      .prepare(
        `SELECT o.id,
                o.main_name,
                o.image_path,
                o.updated_at,
                (SELECT COUNT(*) FROM videos v WHERE v.${videoColumn} = o.id) AS video_count,
                (
                  SELECT v.cover_path
                  FROM videos v
                  WHERE v.${videoColumn} = o.id
                    AND v.cover_path IS NOT NULL
                  ORDER BY v.release_date DESC, v.add_time DESC, v.id DESC
                  LIMIT 1
                ) AS fallback_cover_path
         FROM organizations o
         WHERE EXISTS (
                 SELECT 1 FROM organization_roles r
                 WHERE r.organization_id = o.id AND r.role = ?
               )
           AND (
             ? = '' OR EXISTS (
               SELECT 1 FROM organization_names n
               WHERE n.organization_id = o.id
                 AND n.normalized_name LIKE ? ESCAPE '\\'
             )
           )
         ORDER BY ${order}, o.id ASC`
      )
      .all(role, search, search) as Array<{
      id: number
      main_name: string
      image_path: string | null
      updated_at: string
      video_count: number
      fallback_cover_path: string | null
    }>
    return rows.map((row) => ({
      id: row.id,
      mainName: row.main_name,
      imagePath: row.image_path,
      fallbackCoverPath: row.fallback_cover_path,
      videoCount: row.video_count,
      updatedAt: row.updated_at
    }))
  },

  getOrganization(id, role): OrganizationDetail | null {
    requireRole(role)
    const videoColumn = VIDEO_ROLE_COLUMN[role]
    const row = getDb()
      .prepare(
        `SELECT o.id,
                o.main_name,
                o.image_path,
                o.summary,
                o.country_region,
                o.founded_year,
                o.ended_year,
                o.status,
                o.updated_at,
                parent.id AS parent_id,
                parent.main_name AS parent_name,
                (SELECT COUNT(*) FROM videos v WHERE v.${videoColumn} = o.id) AS video_count,
                (SELECT COUNT(*) FROM videos v WHERE v.maker_organization_id = o.id)
                  AS maker_video_count,
                (SELECT COUNT(*) FROM videos v WHERE v.publisher_organization_id = o.id)
                  AS publisher_video_count,
                (
                  SELECT MIN(CAST(substr(v.release_date, 1, 4) AS INTEGER))
                  FROM videos v
                  WHERE v.${videoColumn} = o.id
                    AND v.release_date GLOB '[0-9][0-9][0-9][0-9]-*'
                ) AS release_year_start,
                (
                  SELECT MAX(CAST(substr(v.release_date, 1, 4) AS INTEGER))
                  FROM videos v
                  WHERE v.${videoColumn} = o.id
                    AND v.release_date GLOB '[0-9][0-9][0-9][0-9]-*'
                ) AS release_year_end,
                (
                  SELECT v.cover_path
                  FROM videos v
                  WHERE v.${videoColumn} = o.id
                    AND v.cover_path IS NOT NULL
                  ORDER BY v.release_date DESC, v.add_time DESC, v.id DESC
                  LIMIT 1
                ) AS fallback_cover_path
         FROM organizations o
         LEFT JOIN organizations parent ON parent.id = o.parent_organization_id
         WHERE o.id = ?
           AND EXISTS (
             SELECT 1 FROM organization_roles r
             WHERE r.organization_id = o.id AND r.role = ?
           )`
      )
      .get(id, role) as
      | {
          id: number
          main_name: string
          image_path: string | null
          summary: string | null
          country_region: string | null
          founded_year: number | null
          ended_year: number | null
          status: OrganizationDetail['status']
          updated_at: string
          parent_id: number | null
          parent_name: string | null
          video_count: number
          maker_video_count: number
          publisher_video_count: number
          release_year_start: number | null
          release_year_end: number | null
          fallback_cover_path: string | null
        }
      | undefined
    if (!row) return null

    const aliases = getDb()
      .prepare(
        `SELECT name FROM organization_names
         WHERE organization_id = ? AND type = 'alias'
         ORDER BY position, id`
      )
      .all(id) as Array<{ name: string }>
    const links = getDb()
      .prepare(
        `SELECT label, url, position FROM organization_links
         WHERE organization_id = ? ORDER BY position, id`
      )
      .all(id) as OrganizationLink[]
    const roles = getDb()
      .prepare(
        `SELECT role FROM organization_roles
         WHERE organization_id = ? ORDER BY role`
      )
      .all(id) as Array<{ role: OrganizationRole }>

    return {
      id: row.id,
      mainName: row.main_name,
      imagePath: row.image_path,
      fallbackCoverPath: row.fallback_cover_path,
      videoCount: row.video_count,
      updatedAt: row.updated_at,
      summary: row.summary,
      countryRegion: row.country_region,
      foundedYear: row.founded_year,
      endedYear: row.ended_year,
      status: row.status,
      parent:
        row.parent_id == null || row.parent_name == null
          ? null
          : { id: row.parent_id, mainName: row.parent_name },
      aliases: aliases.map((alias) => alias.name),
      links,
      roles: roles.map((item) => item.role),
      makerVideoCount: row.maker_video_count,
      publisherVideoCount: row.publisher_video_count,
      releaseYearStart: row.release_year_start,
      releaseYearEnd: row.release_year_end
    }
  },

  listOrganizationOptions(search): OrganizationOption[] {
    const normalized = searchLikePattern(search)
    const rows = getDb()
      .prepare(
        `SELECT o.id, o.main_name
         FROM organizations o
         WHERE ? = '' OR EXISTS (
           SELECT 1 FROM organization_names n
           WHERE n.organization_id = o.id
             AND n.normalized_name LIKE ? ESCAPE '\\'
         )
         ORDER BY o.main_name, o.id
         LIMIT 100`
      )
      .all(normalized, normalized) as Array<{ id: number; main_name: string }>
    const readAliases = getDb().prepare(
      `SELECT name FROM organization_names
       WHERE organization_id = ? AND type = 'alias'
       ORDER BY position, id`
    )
    const readRoles = getDb().prepare(
      `SELECT role FROM organization_roles
       WHERE organization_id = ? ORDER BY role`
    )
    return rows.map((row) => ({
      id: row.id,
      mainName: row.main_name,
      aliases: (readAliases.all(row.id) as Array<{ name: string }>).map((item) => item.name),
      roles: (readRoles.all(row.id) as Array<{ role: OrganizationRole }>).map(
        (item) => item.role
      )
    }))
  },

  listOrganizationMergeOptions(search): OrganizationMergeOption[] {
    const normalized = searchLikePattern(search)
    const rows = getDb()
      .prepare(
        `SELECT o.id, o.main_name,
                (SELECT COUNT(*) FROM videos v
                 WHERE v.maker_organization_id = o.id OR v.publisher_organization_id = o.id)
                  AS video_count,
                (SELECT COUNT(*) FROM videos v WHERE v.maker_organization_id = o.id)
                  AS maker_video_count,
                (SELECT COUNT(*) FROM videos v WHERE v.publisher_organization_id = o.id)
                  AS publisher_video_count
         FROM organizations o
         WHERE ? = '' OR EXISTS (
           SELECT 1 FROM organization_names n
           WHERE n.organization_id = o.id
             AND n.normalized_name LIKE ? ESCAPE '\\'
         )
         ORDER BY o.main_name, o.id
         LIMIT 100`
      )
      .all(normalized, normalized) as Array<{
      id: number
      main_name: string
      video_count: number
      maker_video_count: number
      publisher_video_count: number
    }>
    const readAliases = getDb().prepare(
      `SELECT name FROM organization_names
       WHERE organization_id = ? AND type = 'alias'
       ORDER BY position, id`
    )
    const readRoles = getDb().prepare(
      `SELECT role FROM organization_roles
       WHERE organization_id = ? ORDER BY role`
    )
    return rows.map((row) => ({
      id: row.id,
      mainName: row.main_name,
      aliases: (readAliases.all(row.id) as Array<{ name: string }>).map((item) => item.name),
      roles: (readRoles.all(row.id) as Array<{ role: OrganizationRole }>).map(
        (item) => item.role
      ),
      videoCount: row.video_count,
      makerVideoCount: row.maker_video_count,
      publisherVideoCount: row.publisher_video_count
    }))
  },

  listDirectors(query): DirectorListItem[] {
    const search = searchLikePattern(query.search)
    const sortBy = query.sortBy === 'updated_at' ? 'updated_at' : 'video_count'
    const sortDir = query.sortDir === 'asc' ? 'ASC' : 'DESC'
    const order = sortBy === 'updated_at' ? `d.updated_at ${sortDir}` : `video_count ${sortDir}`
    const rows = getDb()
      .prepare(
        `SELECT d.id, d.main_name, d.image_path, d.updated_at,
                COUNT(v.id) AS video_count,
                (SELECT cover_path FROM videos cv
                 WHERE cv.director_id = d.id AND cv.cover_path IS NOT NULL
                 ORDER BY cv.release_date DESC, cv.add_time DESC, cv.id DESC LIMIT 1)
                  AS fallback_cover_path
         FROM directors d
         LEFT JOIN videos v ON v.director_id = d.id
         WHERE ? = '' OR EXISTS (
           SELECT 1 FROM director_names n
           WHERE n.director_id = d.id AND n.normalized_name LIKE ? ESCAPE '\\'
         )
         GROUP BY d.id
         ORDER BY ${order}, d.id ASC`
      )
      .all(search, search) as Array<{
      id: number
      main_name: string
      image_path: string | null
      updated_at: string
      video_count: number
      fallback_cover_path: string | null
    }>
    return rows.map((row) => ({
      id: row.id,
      mainName: row.main_name,
      imagePath: row.image_path,
      fallbackCoverPath: row.fallback_cover_path,
      videoCount: row.video_count,
      updatedAt: row.updated_at
    }))
  },

  getDirector(id): DirectorDetail | null {
    const row = getDb()
      .prepare(
        `SELECT d.*,
                COUNT(v.id) AS video_count,
                MIN(CASE WHEN v.release_date GLOB '[0-9][0-9][0-9][0-9]-*'
                         THEN CAST(substr(v.release_date, 1, 4) AS INTEGER) END) AS release_year_start,
                MAX(CASE WHEN v.release_date GLOB '[0-9][0-9][0-9][0-9]-*'
                         THEN CAST(substr(v.release_date, 1, 4) AS INTEGER) END) AS release_year_end,
                (SELECT cover_path FROM videos cv
                 WHERE cv.director_id = d.id AND cv.cover_path IS NOT NULL
                 ORDER BY cv.release_date DESC, cv.add_time DESC, cv.id DESC LIMIT 1)
                  AS fallback_cover_path
         FROM directors d
         LEFT JOIN videos v ON v.director_id = d.id
         WHERE d.id = ?
         GROUP BY d.id`
      )
      .get(id) as
      | {
          id: number
          main_name: string
          image_path: string | null
          summary: string | null
          country_region: string | null
          birth_date: string | null
          death_date: string | null
          birth_place: string | null
          career_start_year: number | null
          career_end_year: number | null
          status: DirectorDetail['status']
          updated_at: string
          video_count: number
          release_year_start: number | null
          release_year_end: number | null
          fallback_cover_path: string | null
        }
      | undefined
    if (!row) return null
    const aliases = getDb()
      .prepare(
        `SELECT name FROM director_names WHERE director_id = ? AND type = 'alias'
         ORDER BY position, id`
      )
      .all(id) as Array<{ name: string }>
    const links = getDb()
      .prepare(
        `SELECT label, url, position FROM director_links
         WHERE director_id = ? ORDER BY position, id`
      )
      .all(id) as OrganizationLink[]
    return {
      id: row.id,
      mainName: row.main_name,
      imagePath: row.image_path,
      fallbackCoverPath: row.fallback_cover_path,
      videoCount: row.video_count,
      updatedAt: row.updated_at,
      aliases: aliases.map((item) => item.name),
      summary: row.summary,
      countryRegion: row.country_region,
      birthDate: row.birth_date,
      deathDate: row.death_date,
      birthPlace: row.birth_place,
      careerStartYear: row.career_start_year,
      careerEndYear: row.career_end_year,
      status: row.status,
      links,
      releaseYearStart: row.release_year_start,
      releaseYearEnd: row.release_year_end
    }
  },

  listDirectorOptions(search): DirectorOption[] {
    const normalized = searchLikePattern(search)
    const rows = getDb()
      .prepare(
        `SELECT d.id, d.main_name, d.country_region, d.birth_date,
                d.career_start_year, d.career_end_year, COUNT(v.id) AS video_count
         FROM directors d
         LEFT JOIN videos v ON v.director_id = d.id
         WHERE ? = '' OR EXISTS (
           SELECT 1 FROM director_names n
           WHERE n.director_id = d.id AND n.normalized_name LIKE ? ESCAPE '\\'
         )
         GROUP BY d.id ORDER BY d.main_name, d.id LIMIT 100`
      )
      .all(normalized, normalized) as Array<{
      id: number
      main_name: string
      country_region: string | null
      birth_date: string | null
      career_start_year: number | null
      career_end_year: number | null
      video_count: number
    }>
    const readAliases = getDb().prepare(
      `SELECT name FROM director_names WHERE director_id = ? AND type = 'alias'
       ORDER BY position, id`
    )
    return rows.map((row) => ({
      id: row.id,
      mainName: row.main_name,
      aliases: (readAliases.all(row.id) as Array<{ name: string }>).map((item) => item.name),
      countryRegion: row.country_region,
      birthDate: row.birth_date,
      careerStartYear: row.career_start_year,
      careerEndYear: row.career_end_year,
      videoCount: row.video_count
    }))
  },

  listSeries(query): SeriesListItem[] {
    const search = searchLikePattern(query.search)
    const sortBy = query.sortBy === 'updated_at' ? 'updated_at' : 'video_count'
    const sortDir = query.sortDir === 'asc' ? 'ASC' : 'DESC'
    const order = sortBy === 'updated_at' ? `s.updated_at ${sortDir}` : `video_count ${sortDir}`
    const rows = getDb()
      .prepare(
        `SELECT s.id, s.main_name, s.image_path, s.updated_at,
                owner.id AS owner_id, owner.main_name AS owner_name,
                COUNT(v.id) AS video_count,
                (SELECT cover_path FROM videos cv
                 WHERE cv.series_id = s.id AND cv.cover_path IS NOT NULL
                 ORDER BY cv.release_date DESC, cv.add_time DESC, cv.id DESC LIMIT 1)
                  AS fallback_cover_path
         FROM series s
         LEFT JOIN organizations owner ON owner.id = s.owner_organization_id
         LEFT JOIN videos v ON v.series_id = s.id
         WHERE ? = '' OR EXISTS (
           SELECT 1 FROM series_names n
           WHERE n.series_id = s.id AND n.normalized_name LIKE ? ESCAPE '\\'
         )
         GROUP BY s.id
         ORDER BY ${order}, s.id ASC`
      )
      .all(search, search) as Array<{
      id: number
      main_name: string
      image_path: string | null
      updated_at: string
      owner_id: number | null
      owner_name: string | null
      video_count: number
      fallback_cover_path: string | null
    }>
    return rows.map((row) => ({
      id: row.id,
      mainName: row.main_name,
      imagePath: row.image_path,
      fallbackCoverPath: row.fallback_cover_path,
      ownerOrganization:
        row.owner_id == null || row.owner_name == null
          ? null
          : { id: row.owner_id, mainName: row.owner_name },
      videoCount: row.video_count,
      updatedAt: row.updated_at
    }))
  },

  getSeries(id): SeriesDetail | null {
    const row = getDb()
      .prepare(
        `SELECT s.*,
                owner.id AS owner_id, owner.main_name AS owner_name,
                parent.id AS parent_id, parent.main_name AS parent_name,
                parent_owner.id AS parent_owner_id,
                parent_owner.main_name AS parent_owner_name,
                COUNT(v.id) AS video_count,
                MIN(CASE WHEN v.release_date GLOB '[0-9][0-9][0-9][0-9]-*'
                         THEN CAST(substr(v.release_date, 1, 4) AS INTEGER) END) AS release_year_start,
                MAX(CASE WHEN v.release_date GLOB '[0-9][0-9][0-9][0-9]-*'
                         THEN CAST(substr(v.release_date, 1, 4) AS INTEGER) END) AS release_year_end,
                (SELECT cover_path FROM videos cv
                 WHERE cv.series_id = s.id AND cv.cover_path IS NOT NULL
                 ORDER BY cv.release_date DESC, cv.add_time DESC, cv.id DESC LIMIT 1)
                  AS fallback_cover_path
         FROM series s
         LEFT JOIN organizations owner ON owner.id = s.owner_organization_id
         LEFT JOIN series parent ON parent.id = s.parent_series_id
         LEFT JOIN organizations parent_owner ON parent_owner.id = parent.owner_organization_id
         LEFT JOIN videos v ON v.series_id = s.id
         WHERE s.id = ?
         GROUP BY s.id`
      )
      .get(id) as
      | {
          id: number
          main_name: string
          image_path: string | null
          summary: string | null
          start_year: number | null
          end_year: number | null
          status: SeriesDetail['status']
          updated_at: string
          owner_id: number | null
          owner_name: string | null
          parent_id: number | null
          parent_name: string | null
          parent_owner_id: number | null
          parent_owner_name: string | null
          video_count: number
          release_year_start: number | null
          release_year_end: number | null
          fallback_cover_path: string | null
        }
      | undefined
    if (!row) return null
    const aliases = getDb()
      .prepare(
        `SELECT name FROM series_names
         WHERE series_id = ? AND type = 'alias'
         ORDER BY position, id`
      )
      .all(id) as Array<{ name: string }>
    const links = getDb()
      .prepare(
        `SELECT label, url, position FROM series_links
         WHERE series_id = ? ORDER BY position, id`
      )
      .all(id) as OrganizationLink[]
    return {
      id: row.id,
      mainName: row.main_name,
      imagePath: row.image_path,
      fallbackCoverPath: row.fallback_cover_path,
      ownerOrganization:
        row.owner_id == null || row.owner_name == null
          ? null
          : { id: row.owner_id, mainName: row.owner_name },
      parentSeries:
        row.parent_id == null || row.parent_name == null
          ? null
          : {
              id: row.parent_id,
              mainName: row.parent_name,
              ownerOrganization:
                row.parent_owner_id == null || row.parent_owner_name == null
                  ? null
                  : { id: row.parent_owner_id, mainName: row.parent_owner_name }
            },
      aliases: aliases.map((item) => item.name),
      summary: row.summary,
      startYear: row.start_year,
      endYear: row.end_year,
      status: row.status,
      links,
      videoCount: row.video_count,
      releaseYearStart: row.release_year_start,
      releaseYearEnd: row.release_year_end,
      updatedAt: row.updated_at
    }
  },

  listSeriesOptions(search): SeriesOption[] {
    const normalized = searchLikePattern(search)
    const rows = getDb()
      .prepare(
        `SELECT s.id, s.main_name,
                owner.id AS owner_id, owner.main_name AS owner_name,
                COUNT(v.id) AS video_count
         FROM series s
         LEFT JOIN organizations owner ON owner.id = s.owner_organization_id
         LEFT JOIN videos v ON v.series_id = s.id
         WHERE ? = '' OR EXISTS (
           SELECT 1 FROM series_names n
           WHERE n.series_id = s.id AND n.normalized_name LIKE ? ESCAPE '\\'
         )
         GROUP BY s.id
         ORDER BY s.main_name, s.id
         LIMIT 100`
      )
      .all(normalized, normalized) as Array<{
      id: number
      main_name: string
      owner_id: number | null
      owner_name: string | null
      video_count: number
    }>
    const readAliases = getDb().prepare(
      `SELECT name FROM series_names
       WHERE series_id = ? AND type = 'alias'
       ORDER BY position, id`
    )
    return rows.map((row) => ({
      id: row.id,
      mainName: row.main_name,
      ownerOrganization:
        row.owner_id == null || row.owner_name == null
          ? null
          : { id: row.owner_id, mainName: row.owner_name },
      aliases: (readAliases.all(row.id) as Array<{ name: string }>).map((item) => item.name),
      videoCount: row.video_count
    }))
  }
}
