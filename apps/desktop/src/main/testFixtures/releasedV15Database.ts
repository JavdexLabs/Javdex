import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/** Actual released schema, independent of the current schema's DDL fragments. */
export function releasedV15Database(): Database.Database {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(fs.readFileSync(path.join(__dirname, '../db/fixtures/schema-v15.sql'), 'utf8'))
    db.pragma('user_version = 15')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
