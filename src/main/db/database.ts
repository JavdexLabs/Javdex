import Database from 'better-sqlite3'
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { migrateDatabase } from './migrations'

let db: Database.Database | null = null

/**
 * Initialise (or open) the SQLite database stored under userData.
 * Safe to call multiple times — returns the existing connection.
 */
export function initDatabase(): Database.Database {
  if (db) return db

  const userData = app.getPath('userData')
  const dbDir = path.join(userData, 'data')
  return openDatabase(path.join(dbDir, 'library.db'))
}

export function initDatabaseAtPath(dbPath: string): Database.Database {
  if (db) return db
  return openDatabase(dbPath)
}

function openDatabase(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  db = new Database(dbPath)
  // Performance + integrity pragmas.
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  migrateDatabase(db)

  return db
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialised. Call initDatabase() first.')
  }
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
