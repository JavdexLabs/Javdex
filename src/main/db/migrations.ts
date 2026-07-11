import type Database from 'better-sqlite3'
import { SCHEMA_SQL } from './schema'

export const CURRENT_SCHEMA_VERSION = 2

type Migration = {
  version: number
  migrate: (database: Database.Database) => void
}

function columnNames(database: Database.Database, table: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
  )
}

function migrateToV2(database: Database.Database): void {
  const cols = columnNames(database, 'actresses')
  if (!cols.has('avatar_source_path')) {
    database.exec('ALTER TABLE actresses ADD COLUMN avatar_source_path TEXT')
  }
  if (!cols.has('avatar_crop_json')) {
    database.exec('ALTER TABLE actresses ADD COLUMN avatar_crop_json TEXT')
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: 2,
    migrate: migrateToV2
  }
]

function migrationForVersion(version: number): Migration | undefined {
  return MIGRATIONS.find((migration) => migration.version === version)
}

/** Initialise or upgrade the database schema. */
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
    return
  }
  for (let next = current + 1; next <= CURRENT_SCHEMA_VERSION; next += 1) {
    const migration = migrationForVersion(next)
    if (!migration) {
      throw new Error(`Missing database migration for schema version ${next}.`)
    }
    migration.migrate(database)
    database.pragma(`user_version = ${next}`)
  }
}
