import type Database from 'better-sqlite3'
import type { ClassificationLink } from '@shared/classificationTypes'
import { writeClassificationLinks } from './classificationLinkPersistence'
import { prepareClassificationNames } from './classificationNamePreparation'

export function assertOrganizationNamesAvailable(
  database: Database.Database,
  normalizedNames: readonly string[],
  allowedOrganizationIds: number | readonly number[] = []
): void {
  const allowed = new Set(
    typeof allowedOrganizationIds === 'number'
      ? [allowedOrganizationIds]
      : allowedOrganizationIds
  )
  const findConflict = database.prepare(
    `SELECT ownership.organization_id,
            organization.main_name,
            COALESCE(name.name, organization.main_name) AS conflicting_name
     FROM organization_name_ownership ownership
     JOIN organizations organization ON organization.id = ownership.organization_id
     LEFT JOIN organization_names name
       ON name.organization_id = ownership.organization_id
      AND name.normalized_name = ownership.normalized_name
     WHERE ownership.normalized_name = ?
     LIMIT 1`
  )
  for (const normalizedName of normalizedNames) {
    const conflict = findConflict.get(normalizedName) as
      | { organization_id: number; main_name: string; conflicting_name: string }
      | undefined
    if (conflict && !allowed.has(conflict.organization_id)) {
      throw new Error(
        `机构名称“${conflict.conflicting_name}”已归属于其他机构档案 #${conflict.organization_id}` +
          `“${conflict.main_name}”占用；请先修改或合并冲突机构`
      )
    }
  }
}

export function writeOrganizationNames(
  database: Database.Database,
  organizationId: number,
  mainName: string,
  aliases: readonly string[]
): void {
  const names = prepareClassificationNames(mainName, aliases).normalizedNames
  assertOrganizationNamesAvailable(
    database,
    names.map((name) => name.normalizedName),
    organizationId
  )
  database.prepare('DELETE FROM organization_names WHERE organization_id = ?').run(organizationId)
  database
    .prepare('DELETE FROM organization_name_ownership WHERE organization_id = ?')
    .run(organizationId)
  const insertName = database.prepare(
    `INSERT INTO organization_names (
       organization_id, name, normalized_name, type, position
     ) VALUES (?, ?, ?, ?, ?)`
  )
  const insertOwnership = database.prepare(
    `INSERT INTO organization_name_ownership (normalized_name, organization_id)
     VALUES (?, ?)`
  )
  names.forEach((name, position) => {
    insertName.run(
      organizationId,
      name.name,
      name.normalizedName,
      name.type,
      name.type === 'main' ? 0 : position - 1
    )
    insertOwnership.run(name.normalizedName, organizationId)
  })
}

export function writeOrganizationLinks(
  database: Database.Database,
  organizationId: number,
  links: readonly ClassificationLink[]
): void {
  writeClassificationLinks(database, 'organization', organizationId, links)
}
