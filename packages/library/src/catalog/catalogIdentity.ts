import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from '@library/db/database'

export interface CatalogIdentityState {
  catalogId: string
  serverId: string | null
  writerEpoch: number
  frozen: boolean
  createdAt: string
  updatedAt: string
}

interface IdentityRow {
  catalog_id: string
  server_id: string | null
  writer_epoch: number
  frozen: number
  created_at: string
  updated_at: string
}

function mapIdentity(row: IdentityRow): CatalogIdentityState {
  return {
    catalogId: row.catalog_id,
    serverId: row.server_id,
    writerEpoch: row.writer_epoch,
    frozen: row.frozen === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function readCatalogIdentity(
  database: Database.Database = getDb()
): CatalogIdentityState | null {
  const row = database
    .prepare(
      `SELECT catalog_id, server_id, writer_epoch, frozen, created_at, updated_at
       FROM catalog_identity WHERE id = 1`
    )
    .get() as IdentityRow | undefined
  return row ? mapIdentity(row) : null
}

export function isWriterBound(database: Database.Database = getDb()): boolean {
  const identity = readCatalogIdentity(database)
  return Boolean(identity && identity.writerEpoch > 0)
}

export function ensureCatalogIdentity(
  options: {
    catalogId?: string
    serverId?: string | null
    now?: () => string
  } = {},
  database: Database.Database = getDb()
): CatalogIdentityState {
  const now = options.now ?? (() => new Date().toISOString())
  return database.transaction(() => {
    const existing = readCatalogIdentity(database)
    if (existing) {
      if (existing.serverId == null && options.serverId) {
        const updatedAt = now()
        database
          .prepare('UPDATE catalog_identity SET server_id = ?, updated_at = ? WHERE id = 1')
          .run(options.serverId, updatedAt)
        return { ...existing, serverId: options.serverId, updatedAt }
      }
      return existing
    }
    const createdAt = now()
    const catalogId = options.catalogId ?? randomUUID()
    const serverId = options.serverId === undefined ? null : options.serverId
    database
      .prepare(
        `INSERT INTO catalog_identity (
           id, catalog_id, server_id, writer_epoch, frozen, created_at, updated_at
         ) VALUES (1, ?, ?, 0, 0, ?, ?)`
      )
      .run(catalogId, serverId, createdAt, createdAt)
    return {
      catalogId,
      serverId,
      writerEpoch: 0,
      frozen: false,
      createdAt,
      updatedAt: createdAt
    }
  })()
}

export function setCatalogFrozen(
  frozen: boolean,
  database: Database.Database = getDb(),
  now = () => new Date().toISOString()
): void {
  const updated = database
    .prepare('UPDATE catalog_identity SET frozen = ?, updated_at = ? WHERE id = 1')
    .run(frozen ? 1 : 0, now())
  if (updated.changes !== 1) throw new Error('资料库身份尚未初始化')
}
