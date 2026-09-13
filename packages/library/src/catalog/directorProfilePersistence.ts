import type Database from 'better-sqlite3'
import type { ClassificationLink } from '@shared/classificationTypes'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'
import { writeClassificationLinks } from './classificationLinkPersistence'

export function writeDirectorNames(
  database: Database.Database,
  directorId: number,
  mainName: string,
  aliases: readonly string[]
): void {
  database.prepare('DELETE FROM director_names WHERE director_id = ?').run(directorId)
  const insert = database.prepare(
    `INSERT INTO director_names (director_id, name, normalized_name, type, position)
     VALUES (?, ?, ?, ?, ?)`
  )
  insert.run(directorId, mainName, normalizeClassificationName(mainName), 'main', 0)
  aliases.forEach((alias, position) => {
    insert.run(directorId, alias, normalizeClassificationName(alias), 'alias', position)
  })
}

export function writeDirectorLinks(
  database: Database.Database,
  directorId: number,
  links: readonly ClassificationLink[]
): void {
  writeClassificationLinks(database, 'director', directorId, links)
}
