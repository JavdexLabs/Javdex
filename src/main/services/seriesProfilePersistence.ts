import type Database from 'better-sqlite3'
import type { ClassificationLink } from '@shared/classificationTypes'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'

type PreparedSeriesName = {
  name: string
  normalizedName: string
  type: 'main' | 'alias'
}

function prepareSeriesNames(
  mainNameInput: string,
  aliasesInput: readonly string[]
): PreparedSeriesName[] {
  const mainName = mainNameInput.trim()
  const mainNormalized = normalizeClassificationName(mainName)
  const names: PreparedSeriesName[] = [
    { name: mainName, normalizedName: mainNormalized, type: 'main' }
  ]
  const seen = new Set([mainNormalized])
  for (const rawAlias of aliasesInput) {
    const alias = rawAlias.trim()
    if (!alias) continue
    const normalizedName = normalizeClassificationName(alias)
    if (seen.has(normalizedName)) continue
    seen.add(normalizedName)
    names.push({ name: alias, normalizedName, type: 'alias' })
  }
  return names
}

export function assertSeriesNamesAvailable(
  database: Database.Database,
  ownerOrganizationId: number | null,
  normalizedNames: readonly string[],
  allowedSeriesIds: number | readonly number[] = []
): void {
  const allowed = new Set(
    typeof allowedSeriesIds === 'number' ? [allowedSeriesIds] : allowedSeriesIds
  )
  const findConflict = database.prepare(
    `SELECT ownership.series_id, series.main_name,
            COALESCE(name.name, series.main_name) AS conflicting_name,
            scope.main_name AS scope_name
     FROM series_name_ownership ownership
     JOIN series ON series.id = ownership.series_id
     LEFT JOIN series_names name
       ON name.series_id = ownership.series_id
      AND name.normalized_name = ownership.normalized_name
     LEFT JOIN organizations scope ON scope.id = ownership.owner_organization_id
     WHERE COALESCE(ownership.owner_organization_id, 0) = COALESCE(?, 0)
       AND ownership.normalized_name = ?
     LIMIT 1`
  )
  for (const normalizedName of normalizedNames) {
    const conflict = findConflict.get(ownerOrganizationId, normalizedName) as
      | {
          series_id: number
          main_name: string
          conflicting_name: string
          scope_name: string | null
        }
      | undefined
    if (conflict && !allowed.has(conflict.series_id)) {
      throw new Error(
        `系列名称“${conflict.conflicting_name}”已由档案 #${conflict.series_id}“${conflict.main_name}”占用` +
          `（目标机构作用域，所属机构：${conflict.scope_name ?? '未归属'}）；请先修改或合并冲突系列`
      )
    }
  }
}

export function writeSeriesNames(
  database: Database.Database,
  seriesId: number,
  ownerOrganizationId: number | null,
  mainName: string,
  aliases: readonly string[]
): void {
  const names = prepareSeriesNames(mainName, aliases)
  assertSeriesNamesAvailable(
    database,
    ownerOrganizationId,
    names.map((item) => item.normalizedName),
    seriesId
  )
  database.prepare('DELETE FROM series_names WHERE series_id = ?').run(seriesId)
  database.prepare('DELETE FROM series_name_ownership WHERE series_id = ?').run(seriesId)
  const insertName = database.prepare(
    `INSERT INTO series_names (series_id, name, normalized_name, type, position)
     VALUES (?, ?, ?, ?, ?)`
  )
  const insertOwnership = database.prepare(
    `INSERT INTO series_name_ownership (owner_organization_id, normalized_name, series_id)
     VALUES (?, ?, ?)`
  )
  names.forEach((name, position) => {
    insertName.run(
      seriesId,
      name.name,
      name.normalizedName,
      name.type,
      name.type === 'main' ? 0 : position - 1
    )
    insertOwnership.run(ownerOrganizationId, name.normalizedName, seriesId)
  })
}

export function writeSeriesLinks(
  database: Database.Database,
  seriesId: number,
  links: readonly ClassificationLink[]
): void {
  database.prepare('DELETE FROM series_links WHERE series_id = ?').run(seriesId)
  const insert = database.prepare(
    `INSERT INTO series_links (series_id, label, url, normalized_url, position)
     VALUES (?, ?, ?, ?, ?)`
  )
  links.forEach((link) => {
    const normalizedUrl = new URL(link.url)
    normalizedUrl.hash = ''
    insert.run(seriesId, link.label, link.url, normalizedUrl.toString(), link.position)
  })
}
