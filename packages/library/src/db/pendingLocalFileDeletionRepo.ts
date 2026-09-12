import { getDb } from './database'

export interface PendingLocalFileDeletion {
  id: number
  original_path: string
  staged_path: string
  device_id: number
  state: 'prepared' | 'committed'
}

export function prepareLocalFileDeletion(
  originalPath: string,
  stagedPath: string,
  deviceId: number
): void {
  getDb()
    .prepare(
      `INSERT INTO pending_local_file_deletions (original_path, staged_path, device_id, state)
       VALUES (?, ?, ?, 'prepared')`
    )
    .run(originalPath, stagedPath, deviceId)
}

export function markLocalFileDeletionsCommitted(stagedPaths: readonly string[]): void {
  const update = getDb().prepare(
    `UPDATE pending_local_file_deletions
     SET state = 'committed'
     WHERE staged_path = ? AND state = 'prepared'`
  )
  for (const stagedPath of stagedPaths) {
    if (update.run(stagedPath).changes !== 1) {
      throw new Error(`待清理影片文件状态异常：${stagedPath}`)
    }
  }
}

export function removePendingLocalFileDeletions(stagedPaths: readonly string[]): void {
  if (stagedPaths.length === 0) return
  const remove = getDb().prepare('DELETE FROM pending_local_file_deletions WHERE staged_path = ?')
  getDb().transaction(() => {
    for (const stagedPath of stagedPaths) remove.run(stagedPath)
  })()
}

export function listPendingLocalFileDeletions(): PendingLocalFileDeletion[] {
  return getDb()
    .prepare(
      `SELECT id, original_path, staged_path, device_id, state
       FROM pending_local_file_deletions
       ORDER BY id ASC`
    )
    .all() as PendingLocalFileDeletion[]
}

export function getPendingLocalFileDeletionByOriginalPath(
  originalPath: string
): PendingLocalFileDeletion | null {
  return (
    (getDb()
      .prepare(
        `SELECT id, original_path, staged_path, device_id, state
         FROM pending_local_file_deletions
         WHERE original_path = ?`
      )
      .get(originalPath) as PendingLocalFileDeletion | undefined) ?? null
  )
}
