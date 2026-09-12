import type Database from 'better-sqlite3'
import type { ClassificationEntityKind, ClassificationLink } from '@shared/classificationTypes'
import { writeRelatedLinks } from '@library/db/relatedLinkStore'

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
  writeRelatedLinks(database, config.table, config.entityIdColumn, entityId, links)
}
