import type Database from 'better-sqlite3'
import type { ClassificationEntityKind, ClassificationLink } from '@shared/classificationTypes'

const LINK_TABLE: Record<
  ClassificationEntityKind,
  { table: string; entityIdColumn: string }
> = {
  organization: { table: 'organization_links', entityIdColumn: 'organization_id' },
  director: { table: 'director_links', entityIdColumn: 'director_id' },
  series: { table: 'series_links', entityIdColumn: 'series_id' }
}

export function writeClassificationLinks(
  database: Database.Database,
  kind: ClassificationEntityKind,
  entityId: number,
  links: readonly ClassificationLink[]
): void {
  const config = LINK_TABLE[kind]
  database.prepare(`DELETE FROM ${config.table} WHERE ${config.entityIdColumn} = ?`).run(entityId)
  const insert = database.prepare(
    `INSERT INTO ${config.table} (
       ${config.entityIdColumn}, label, url, normalized_url, position
     ) VALUES (?, ?, ?, ?, ?)`
  )
  for (const link of links) {
    const normalizedUrl = new URL(link.url)
    normalizedUrl.hash = ''
    insert.run(entityId, link.label, link.url, normalizedUrl.toString(), link.position)
  }
}
