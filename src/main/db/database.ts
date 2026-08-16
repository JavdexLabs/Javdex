import Database from 'better-sqlite3'
import { migrateDatabase } from './migrations'
import { normalizeActressName } from './actressNameNormalization'

let db: Database.Database | null = null

export function initDatabaseAtPath(dbPath: string): Database.Database {
  if (db) return db
  return openDatabase(dbPath)
}

function openDatabase(dbPath: string): Database.Database {
  db = new Database(dbPath)
  // Performance + integrity pragmas.
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.function('normalize_actress_name', { deterministic: true }, (value: unknown) => {
    if (typeof value !== 'string') return null
    try {
      return normalizeActressName(value)
    } catch {
      return null
    }
  })

  migrateDatabase(db)

  return db
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialised. Call initDatabaseAtPath() first.')
  }
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
