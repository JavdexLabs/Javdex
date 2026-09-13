import type Database from 'better-sqlite3'
import type { MigrationPhase, MigrationPreview, RootMapping } from '@shared/protocol/migration'

export const MIGRATION_STATE_KEY = 'migration-state'
export const MIGRATION_FINAL_PREFIX = 'migration-final:'

export interface StoredMigrationState {
  migrationId: string
  role: 'source' | 'target'
  sourcePhase: MigrationPhase
  targetPhase: MigrationPhase
  digest: string
  mappings: RootMapping[]
  preview: MigrationPreview
  sourcePlatform: string
  sourceServerId: string
  sourceCatalogId: string
  schemaVersion: number
  appVersion: string
  packageRel: string | null
  newCatalogId?: string
  allowEnableAt?: string
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
  const videos = (database.prepare('SELECT COUNT(*) AS n FROM videos').get() as { n: number }).n
  const actresses = (database.prepare('SELECT COUNT(*) AS n FROM actresses').get() as { n: number }).n
  const roots = (
    database.prepare('SELECT COUNT(*) AS n FROM media_library_roots').get() as { n: number }
  ).n
  const extraLibraries = (
    database.prepare('SELECT COUNT(*) AS n FROM media_libraries WHERE id != 1').get() as { n: number }
  ).n
  return videos === 0 && actresses === 0 && roots === 0 && extraLibraries === 0
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
