import type Database from 'better-sqlite3'
import type { MigrationPhase, MigrationPreview, RootMapping } from '@shared/protocol/migration'

export const MIGRATION_STATE_KEY = 'migration-state'
export const MIGRATION_FINAL_PREFIX = 'migration-final:'
export const MIGRATION_TARGET_INTENT_PREFIX = 'migration-target-intent:'

export interface StoredMigrationState {
  migrationId: string
  role: 'source' | 'target'
  phase: MigrationPhase
  digest: string
  mappings: RootMapping[]
  preview: MigrationPreview
  sourcePlatform: string
  sourceServerId: string | null
  sourceCatalogId: string
  schemaVersion: number
  appVersion: string
  packageRel: string | null
  newCatalogId?: string
  enabledAt?: string
  abandonedAt?: string
  taskId?: string
}

const BLOCKER_PENDING_VIDEO = 'pending-video-scrapes'
const BLOCKER_PENDING_ACTRESS = 'pending-actress-scrapes'
const BLOCKER_PENDING_SCAN = 'pending-scan-groups'
const BLOCKER_UNRECOGNIZED = 'unrecognized-files'
const BLOCKER_ACTIVE_SCAN = 'active-scan'
const BLOCKER_ACTIVE_TASK = 'active-task'
const BLOCKER_ENCRYPTED = 'encrypted-assets'

export function catalogLooksEmpty(database: Database.Database): boolean {
  // A target with only a manually created playlist/tag/classification is not empty.
  for (const table of ['videos', 'actresses', 'media_library_roots', 'playlists', 'tags', 'organizations', 'directors', 'series']) {
    if (database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return false
  }
  return !database.prepare('SELECT 1 FROM media_libraries WHERE id != 1 LIMIT 1').get()
}

export function countPendingBlockers(database: Database.Database): string[] {
  const blockers: string[] = []
  const videoScrapes = (
    database.prepare('SELECT COUNT(*) AS n FROM pending_video_scrapes').get() as { n: number }
  ).n
  if (videoScrapes > 0) blockers.push(BLOCKER_PENDING_VIDEO)
  const actressScrapes = (
    database.prepare('SELECT COUNT(*) AS n FROM pending_actress_scrapes').get() as { n: number }
  ).n
  if (actressScrapes > 0) blockers.push(BLOCKER_PENDING_ACTRESS)
  const pendingScan = (
    database.prepare('SELECT COUNT(*) AS n FROM pending_scan_groups').get() as { n: number }
  ).n
  if (pendingScan > 0) blockers.push(BLOCKER_PENDING_SCAN)
  const unrecognized = (
    database.prepare('SELECT COUNT(*) AS n FROM library_unrecognized_files').get() as { n: number }
  ).n
  if (unrecognized > 0) blockers.push(BLOCKER_UNRECOGNIZED)
  const activeScan = database
    .prepare(
      `SELECT 1 AS busy FROM library_scan_runs WHERE status IN ('queued', 'running') LIMIT 1`
    )
    .get() as { busy: number } | undefined
  if (activeScan) blockers.push(BLOCKER_ACTIVE_SCAN)
  const activeTask = database
    .prepare(
      `SELECT 1 AS busy FROM catalog_tasks
        WHERE state IN ('queued', 'running', 'cancelRequested')
        LIMIT 1`
    )
    .get() as { busy: number } | undefined
  if (activeTask) blockers.push(BLOCKER_ACTIVE_TASK)
  return blockers
}

export { BLOCKER_ENCRYPTED }
