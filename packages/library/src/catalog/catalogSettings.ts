import type Database from 'better-sqlite3'
import { getDb } from '@library/db/database'

export function readCatalogSetting<T>(
  key: string,
  fallback: T,
  database: Database.Database = getDb()
): T {
  const row = database
    .prepare('SELECT value_json FROM catalog_settings WHERE key = ?')
    .get(key) as { value_json: string } | undefined
  if (!row) return fallback
  try {
    return JSON.parse(row.value_json) as T
  } catch {
    return fallback
  }
}

export function writeCatalogSetting(
  key: string,
  value: unknown,
  database: Database.Database = getDb()
): void {
  const updatedAt = new Date().toISOString()
  database
    .prepare(
      `INSERT INTO catalog_settings(key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    )
    .run(key, JSON.stringify(value), updatedAt)
}
