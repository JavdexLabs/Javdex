import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

/** Actual 0.8.0 schema; kept independent of development schema constants. */
export function releasedV19Database(): Database.Database {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = ON')
    db.exec(fs.readFileSync(path.join(__dirname, '../db/fixtures/schema-v19.sql'), 'utf8'))
    db.pragma('user_version = 19')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
