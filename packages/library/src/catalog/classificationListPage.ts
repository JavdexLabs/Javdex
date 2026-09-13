import type { DirectorListItem, DirectorListQuery, ClassificationListPage, ClassificationPageQuery, OrganizationListItem, OrganizationListQuery, SeriesListItem, SeriesListQuery } from '@shared/classificationTypes'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'
import { getDb } from '@library/db/database'

function bounds(query: ClassificationPageQuery): { limit: number; offset: number } {
  const limit = query.limit ?? 60, offset = query.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid classification page limit')
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid classification page offset')
  return { limit, offset }
}
function pattern(search?: string): string {
  const trimmed = search?.trim()
  if (!trimmed) return ''
  const normalized = normalizeClassificationName(trimmed)
  return normalized ? `%${normalized.replace(/[\\%_]/g, '\\$&')}%` : ''
}

/** Count/rank retain original all-video semantics; only page identities hydrate covers/owners. */
function readPage(kind: 'series' | 'director' | 'maker' | 'publisher', query: SeriesListQuery & ClassificationPageQuery) {
  const {limit,offset} = bounds(query)
  const db = getDb(), search = pattern(query.search)
  const series = kind === 'series'
  const organization = kind === 'maker' || kind === 'publisher'
  const table = series ? 'series' : organization ? 'organizations' : 'directors'
  const names = series ? 'series_names' : organization ? 'organization_names' : 'director_names'
  const nameFk = series ? 'series_id' : organization ? 'organization_id' : 'director_id'
  const videoFk = series ? 'series_id' : kind === 'director' ? 'director_id' : kind === 'maker' ? 'maker_organization_id' : 'publisher_organization_id'
  const role = !organization ? '' : `EXISTS (SELECT 1 FROM organization_roles r WHERE r.organization_id=e.id AND r.role=?) AND `
  const where = `${role}(? = '' OR EXISTS (SELECT 1 FROM ${names} n WHERE n.${nameFk}=e.id AND n.normalized_name LIKE ? ESCAPE '\\'))`
  const parameters = !organization ? [search,search] : [kind,search,search]
  const direction = query.sortDir === 'asc' ? 'ASC' : 'DESC'
  const order = query.sortBy === 'updated_at' ? `updated_at ${direction}, id ASC` : `video_count ${direction}, id ASC`
  return db.transaction(() => {
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} e WHERE ${where}`).get(...parameters) as {n:number}).n
    const rows = db.prepare(`WITH page AS MATERIALIZED (
      SELECT e.id, e.updated_at, (SELECT COUNT(*) FROM videos v WHERE v.${videoFk}=e.id) AS video_count
      FROM ${table} e WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?
    ) SELECT e.id, e.main_name AS mainName, e.image_path AS imagePath, e.updated_at AS updatedAt,
      page.video_count AS videoCount,
      (SELECT v.cover_path FROM videos v WHERE v.${videoFk}=e.id AND v.cover_path IS NOT NULL
       ORDER BY v.release_date DESC, v.add_time DESC, v.id DESC LIMIT 1) AS fallbackCoverPath
      ${series ? ', owner.id AS ownerId, owner.main_name AS ownerName' : ''}
    FROM page JOIN ${table} e ON e.id=page.id
    ${series ? 'LEFT JOIN organizations owner ON owner.id=e.owner_organization_id' : ''}
    ORDER BY ${query.sortBy === 'updated_at' ? `page.updated_at ${direction}` : `page.video_count ${direction}`}, page.id ASC`)
      .all(...parameters,limit,offset) as Array<OrganizationListItem & {ownerId?:number|null;ownerName?:string|null}>
    return { items:rows, total,limit,offset }
  })()
}

export function listOrganizationPage(query: OrganizationListQuery & ClassificationPageQuery): ClassificationListPage<OrganizationListItem> {
  if (query.role !== 'maker' && query.role !== 'publisher') throw new Error('无效的机构角色')
  return readPage(query.role, query)
}
export function listSeriesPage(query: SeriesListQuery & ClassificationPageQuery): ClassificationListPage<SeriesListItem> {
  const page = readPage('series', query)
  return { ...page, items:page.items.map(({ownerId,ownerName,...item})=>({...item, ownerOrganization:ownerId == null || ownerName == null ? null : {id:ownerId,mainName:ownerName}})) }
}

export function listDirectorPage(query: DirectorListQuery & ClassificationPageQuery): ClassificationListPage<DirectorListItem> {
  return readPage('director', query)
}
