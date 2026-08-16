import type Database from 'better-sqlite3'

export function assertNoPendingVideoMetadataMutation(
  database: Database.Database,
  affectedVideoSql: string,
  params: unknown[]
): void {
  const rows = database
    .prepare(
      `SELECT DISTINCT v.id
       FROM videos v
       JOIN pending_video_scrapes pending ON pending.video_id = v.id
       WHERE ${affectedVideoSql}
       ORDER BY v.id`
    )
    .all(...params) as Array<{ id: number }>
  if (rows.length === 0) return
  throw new Error(
    `操作会修改存在待确认刮削结果的影片（ID：${rows.map((row) => row.id).join('、')}），请先选择或丢弃候选`
  )
}
