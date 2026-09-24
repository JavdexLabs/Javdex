import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { PLAN_TTL_MS } from '@shared/protocol/limits'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'

export type MaintenancePlanKind = 'nfo' | 'files.rename' | 'libraries.removeRoot'

interface PlanRow {
  plan_id: string
  kind: string
  digest: string
  payload_json: string
  expires_at: string
  created_at: string
}

export interface StoredMaintenancePlan<T> {
  planId: string
  kind: MaintenancePlanKind
  digest: string
  payload: T
  expiresAt: string
  createdAt: string
}

export function digestMaintenancePlan(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function expireMaintenancePlans(
  database: Database.Database = getDb(),
  now = new Date()
): number {
  return database
    .prepare('DELETE FROM catalog_maintenance_plans WHERE expires_at <= ?')
    .run(now.toISOString()).changes
}

/** Restart invalidates every live plan, including ones that have not reached TTL. */
export function discardAllMaintenancePlans(database: Database.Database = getDb()): number {
  return database.prepare('DELETE FROM catalog_maintenance_plans').run().changes
}

export function saveMaintenancePlan<T>(
  kind: MaintenancePlanKind,
  payload: T,
  digest = digestMaintenancePlan(payload),
  options: { planId?: string; now?: Date } = {},
  database: Database.Database = getDb()
): StoredMaintenancePlan<T> {
  expireMaintenancePlans(database, options.now ?? new Date())
  const createdAt = (options.now ?? new Date()).toISOString()
  const expiresAt = new Date((options.now ?? new Date()).getTime() + PLAN_TTL_MS).toISOString()
  const planId = options.planId ?? randomUUID()
  database
    .prepare(
      `INSERT INTO catalog_maintenance_plans (plan_id, kind, digest, payload_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(planId, kind, digest, JSON.stringify(payload), expiresAt, createdAt)
  return { planId, kind, digest, payload, expiresAt, createdAt }
}

export function readMaintenancePlan<T>(
  planId: string,
  kind: MaintenancePlanKind,
  database: Database.Database = getDb(),
  now = new Date()
): StoredMaintenancePlan<T> {
  expireMaintenancePlans(database, now)
  const row = database
    .prepare(
      `SELECT plan_id, kind, digest, payload_json, expires_at, created_at
         FROM catalog_maintenance_plans WHERE plan_id = ?`
    )
    .get(planId) as PlanRow | undefined
  if (!row || row.kind !== kind) {
    throw structuredError('VERSION_CONFLICT', '维护计划不存在或已失效')
  }
  if (Date.parse(row.expires_at) <= now.getTime()) {
    database.prepare('DELETE FROM catalog_maintenance_plans WHERE plan_id = ?').run(planId)
    throw structuredError('VERSION_CONFLICT', '维护计划已过期，请重新预览后重试')
  }
  return {
    planId: row.plan_id,
    kind: row.kind as MaintenancePlanKind,
    digest: row.digest,
    payload: JSON.parse(row.payload_json) as T,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  }
}

export function consumeMaintenancePlan<T>(
  planId: string,
  kind: MaintenancePlanKind,
  planDigest: string,
  database: Database.Database = getDb(),
  now = new Date()
): StoredMaintenancePlan<T> {
  const plan = readMaintenancePlan<T>(planId, kind, database, now)
  if (plan.digest !== planDigest) {
    throw structuredError('VERSION_CONFLICT', '维护计划已变化，请重新预览后重试')
  }
  database.prepare('DELETE FROM catalog_maintenance_plans WHERE plan_id = ?').run(planId)
  return plan
}

export function discardMaintenancePlan(
  planId: string,
  database: Database.Database = getDb()
): void {
  const changed = database
    .prepare('DELETE FROM catalog_maintenance_plans WHERE plan_id = ?')
    .run(planId).changes
  if (changed === 0) throw structuredError('INVALID_INPUT', '维护计划不存在或已失效')
}
