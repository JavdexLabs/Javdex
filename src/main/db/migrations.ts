import type Database from 'better-sqlite3'
import { SCHEMA_SQL } from './schema'

export const CURRENT_SCHEMA_VERSION = 1

/** Initialise an empty database with the current schema. */
export function migrateDatabase(database: Database.Database): void {
  const current = Number(database.pragma('user_version', { simple: true }) ?? 0)
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is no longer supported. Delete the database file and restart.`
    )
  }
  if (current === 0) {
    database.exec(SCHEMA_SQL)
    database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`)
  }
}
