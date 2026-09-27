import type Database from 'better-sqlite3'

const BLOCKER_PENDING_VIDEO = 'pending-video-scrapes'
const BLOCKER_PENDING_ACTRESS = 'pending-actress-scrapes'
const BLOCKER_PENDING_SCAN = 'pending-scan-groups'
const BLOCKER_UNRECOGNIZED = 'unrecognized-files'
const BLOCKER_ACTIVE_SCAN = 'active-scan'
const BLOCKER_ACTIVE_TASK = 'active-task'

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
