import type Database from 'better-sqlite3'
import { SCHEMA_SQL } from './schema'

export const CURRENT_SCHEMA_VERSION = 1

/** Apply the v1 schema on first open. */
export function migrateDatabase(database: Database.Database): void {
  const current = Number(database.pragma('user_version', { simple: true }) ?? 0)
  if (current > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Database schema version ${current} is newer than supported ${CURRENT_SCHEMA_VERSION}`)
  }
  if (current >= CURRENT_SCHEMA_VERSION) return

  database.exec(SCHEMA_SQL)
  database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`)
}
