import type Database from 'better-sqlite3'

export function insertTestVideoWithFile(
  db: Database.Database,
  opts: {
    code: string
    filePath: string
    title?: string | null
    summary?: string | null
    rating?: number
    releaseDate?: string | null
    maker?: string | null
    series?: string | null
    director?: string | null
    scrapedStatus?: number
    addTime?: string
    isPrimary?: boolean
    fileSize?: number | null
  }
): { videoId: number; fileId: number } {
  const info = db
    .prepare(
      `INSERT INTO videos
         (code, title, summary, rating, release_date, maker, series, director, scraped_status, add_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.code,
      opts.title ?? null,
      opts.summary ?? null,
      opts.rating ?? 0,
      opts.releaseDate ?? null,
      opts.maker ?? null,
      opts.series ?? null,
      opts.director ?? null,
      opts.scrapedStatus ?? 0,
      opts.addTime ?? new Date().toISOString()
    )
  const videoId = Number(info.lastInsertRowid)
  const fileInfo = db
    .prepare(
      `INSERT INTO video_files (video_id, file_path, file_size, is_primary, add_time)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      videoId,
      opts.filePath,
      opts.fileSize ?? null,
      opts.isPrimary !== false ? 1 : 0,
      opts.addTime ?? new Date().toISOString()
    )
  return { videoId, fileId: Number(fileInfo.lastInsertRowid) }
}
