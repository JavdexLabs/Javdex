import Database from 'better-sqlite3'
import { CURRENT_SCHEMA_VERSION, migrateDatabase } from './migrations'
import { normalizeActressName } from './actressNameNormalization'

let db: Database.Database | null = null

/** Invalidates a short-lived read cache after writes on this or another connection. */
export function getDatabaseReadRevision(connection: Database.Database = getDb()): {
  connection: object
  changes: number
  dataVersion: number
} {
  return {
    connection,
    changes: (connection.prepare('SELECT total_changes() AS count').get() as { count: number }).count,
    dataVersion: connection.pragma('data_version', { simple: true }) as number
  }
}

export function initDatabaseAtPath(dbPath: string): Database.Database {
  if (db) return db
  return openDatabase(dbPath)
}

function registerReadFunctions(connection: Database.Database): void {
  // Match renderer Unicode search semantics on both writer and reader connections.
  connection.function('tag_name_contains_folded', { deterministic: true }, (name: unknown, folded: unknown) =>
    typeof name === 'string' && typeof folded === 'string' && name.toLowerCase().includes(folded) ? 1 : 0)
  connection.function('normalize_actress_name', { deterministic: true }, (value: unknown) => {
    if (typeof value !== 'string') return null
    try {
      return normalizeActressName(value)
    } catch {
      return null
    }
  })
}

function openDatabase(dbPath: string): Database.Database {
  const connection = new Database(dbPath)
  try {
    connection.pragma('journal_mode = WAL')
    connection.pragma('foreign_keys = ON')
    registerReadFunctions(connection)
    migrateDatabase(connection)
    // Publish only a completely initialized connection. Failure must allow retry.
    db = connection
    return connection
  } catch (error) {
    connection.close()
    throw error
  }
}

/** Caller-owned reader for an already migrated catalog; never initializes or migrates it. */
export function openReadOnlyDatabaseAtPath(dbPath: string): Database.Database {
  const connection = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 })
  try {
    connection.pragma('query_only = ON')
    connection.pragma('foreign_keys = ON')
    const version = Number(connection.pragma('user_version', { simple: true }))
    if (version !== CURRENT_SCHEMA_VERSION) {
      throw new Error(`Catalog reader requires schema ${CURRENT_SCHEMA_VERSION}; found ${version}`)
    }
    if (connection.pragma('journal_mode', { simple: true }) !== 'wal') {
      throw new Error('Catalog reader requires WAL mode')
    }
    registerReadFunctions(connection)
    return connection
  } catch (error) {
    connection.close()
    throw error
  }
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
