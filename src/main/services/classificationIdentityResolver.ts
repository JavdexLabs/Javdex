import type Database from 'better-sqlite3'
import type {
  VideoClassificationCandidate,
  VideoClassificationField
} from '@shared/videoScrapeTypes'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'
import { getDb } from '../db/database'

export type ClassificationIdentityResolution =
  | { status: 'invalid'; inputName: string; message: string }
  | { status: 'notFound'; inputName: string }
  | { status: 'unique'; inputName: string; candidate: VideoClassificationCandidate }
  | { status: 'ambiguous'; inputName: string; candidates: VideoClassificationCandidate[] }

function normalizedInputName(value: string):
  | { inputName: string; normalizedName: string }
  | { inputName: string; error: string } {
  const inputName = value.trim()
  try {
    return { inputName, normalizedName: normalizeClassificationName(inputName) }
  } catch (error) {
    return { inputName, error: String((error as Error).message ?? error) }
  }
}

function resolveCandidates(
  inputName: string,
  candidates: VideoClassificationCandidate[]
): ClassificationIdentityResolution {
  if (candidates.length === 0) return { status: 'notFound', inputName }
  if (candidates.length === 1) return { status: 'unique', inputName, candidate: candidates[0] }
  return { status: 'ambiguous', inputName, candidates }
}

function aliasesFor(
  database: Database.Database,
  table: 'organization_names' | 'director_names' | 'series_names',
  idColumn: 'organization_id' | 'director_id' | 'series_id',
  id: number
): string[] {
  return (
    database
      .prepare(
        `SELECT name FROM ${table}
         WHERE ${idColumn} = ? AND type = 'alias'
         ORDER BY position, id`
      )
      .all(id) as Array<{ name: string }>
  ).map((row) => row.name)
}

function invalidResolution(
  value: string,
  parsed: ReturnType<typeof normalizedInputName>
): ClassificationIdentityResolution | null {
  return 'error' in parsed
    ? { status: 'invalid', inputName: value.trim(), message: parsed.error }
    : null
}

export function resolveOrganizationIdentity(
  value: string,
  database: Database.Database = getDb()
): ClassificationIdentityResolution {
  const parsed = normalizedInputName(value)
  const invalid = invalidResolution(value, parsed)
  if (invalid) return invalid
  if (!('normalizedName' in parsed)) throw new Error('机构名称解析失败')
  const row = database
    .prepare(
      `SELECT o.id, o.main_name
       FROM organization_name_ownership ownership
       JOIN organizations o ON o.id = ownership.organization_id
       WHERE ownership.normalized_name = ?`
    )
    .get(parsed.normalizedName) as { id: number; main_name: string } | undefined
  return resolveCandidates(
    parsed.inputName,
    row
      ? [
          {
            id: row.id,
            mainName: row.main_name,
            aliases: aliasesFor(database, 'organization_names', 'organization_id', row.id),
            description: null
          }
        ]
      : []
  )
}

export function resolveDirectorIdentity(
  value: string,
  database: Database.Database = getDb()
): ClassificationIdentityResolution {
  const parsed = normalizedInputName(value)
  const invalid = invalidResolution(value, parsed)
  if (invalid) return invalid
  if (!('normalizedName' in parsed)) throw new Error('导演名称解析失败')
  const rows = database
    .prepare(
      `SELECT DISTINCT d.id, d.main_name, d.country_region, d.birth_date,
              d.career_start_year, d.career_end_year, COUNT(v.id) AS video_count
       FROM director_names n
       JOIN directors d ON d.id = n.director_id
       LEFT JOIN videos v ON v.director_id = d.id
       WHERE n.normalized_name = ?
       GROUP BY d.id
       ORDER BY d.main_name, d.id`
    )
    .all(parsed.normalizedName) as Array<{
    id: number
    main_name: string
    country_region: string | null
    birth_date: string | null
    career_start_year: number | null
    career_end_year: number | null
    video_count: number
  }>
  return resolveCandidates(
    parsed.inputName,
    rows.map((row) => {
      const facts = [
        row.country_region,
        row.birth_date ? `出生 ${row.birth_date}` : null,
        row.career_start_year || row.career_end_year
          ? `从业 ${row.career_start_year ?? '未知'}-${row.career_end_year ?? '至今'}`
          : null,
        `${row.video_count} 部影片`
      ].filter(Boolean)
      return {
        id: row.id,
        mainName: row.main_name,
        aliases: aliasesFor(database, 'director_names', 'director_id', row.id),
        description: facts.join(' · ')
      }
    })
  )
}

export function resolveSeriesIdentity(
  value: string,
  database: Database.Database = getDb()
): ClassificationIdentityResolution {
  const parsed = normalizedInputName(value)
  const invalid = invalidResolution(value, parsed)
  if (invalid) return invalid
  if (!('normalizedName' in parsed)) throw new Error('系列名称解析失败')
  const rows = database
    .prepare(
      `SELECT DISTINCT s.id, s.main_name, owner.main_name AS owner_name
       FROM series_names n
       JOIN series s ON s.id = n.series_id
       LEFT JOIN organizations owner ON owner.id = s.owner_organization_id
       WHERE n.normalized_name = ?
       ORDER BY s.main_name, s.id`
    )
    .all(parsed.normalizedName) as Array<{
    id: number
    main_name: string
    owner_name: string | null
  }>
  return resolveCandidates(
    parsed.inputName,
    rows.map((row) => ({
      id: row.id,
      mainName: row.main_name,
      aliases: aliasesFor(database, 'series_names', 'series_id', row.id),
      description: row.owner_name ? `所属机构：${row.owner_name}` : '未归属机构'
    }))
  )
}

export function classificationFieldLabel(field: VideoClassificationField): string {
  return {
    maker: '制作商',
    publisher: '发行商',
    series: '系列',
    director: '导演'
  }[field]
}
