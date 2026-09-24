import type Database from 'better-sqlite3'
import { getDb } from '@library/db/database'

const REFERENCE_QUERIES: Array<{ table: string; sql: string }> = [
  { table: 'videos', sql: "SELECT cover_path AS p FROM videos WHERE cover_path IS NOT NULL AND trim(cover_path) != ''" },
  { table: 'videos', sql: "SELECT poster_path AS p FROM videos WHERE poster_path IS NOT NULL AND trim(poster_path) != ''" },
  {
    table: 'video_assets',
    sql: "SELECT local_path AS p FROM video_assets WHERE local_path IS NOT NULL AND trim(local_path) != ''"
  },
  {
    table: 'actresses',
    sql: "SELECT avatar_path AS p FROM actresses WHERE avatar_path IS NOT NULL AND trim(avatar_path) != ''"
  },
  {
    table: 'actresses',
    sql: "SELECT avatar_source_path AS p FROM actresses WHERE avatar_source_path IS NOT NULL AND trim(avatar_source_path) != ''"
  },
  {
    table: 'actresses',
    sql: "SELECT poster_path AS p FROM actresses WHERE poster_path IS NOT NULL AND trim(poster_path) != ''"
  },
  {
    table: 'actress_gallery_assets',
    sql: "SELECT local_path AS p FROM actress_gallery_assets WHERE local_path IS NOT NULL AND trim(local_path) != ''"
  },
  {
    table: 'playlists',
    sql: "SELECT cover_path AS p FROM playlists WHERE cover_path IS NOT NULL AND trim(cover_path) != ''"
  },
  {
    table: 'organizations',
    sql: "SELECT image_path AS p FROM organizations WHERE image_path IS NOT NULL AND trim(image_path) != ''"
  },
  {
    table: 'directors',
    sql: "SELECT image_path AS p FROM directors WHERE image_path IS NOT NULL AND trim(image_path) != ''"
  },
  { table: 'series', sql: "SELECT image_path AS p FROM series WHERE image_path IS NOT NULL AND trim(image_path) != ''" },
  {
    table: 'pending_video_scrape_resources',
    sql: "SELECT staged_path AS p FROM pending_video_scrape_resources WHERE staged_path IS NOT NULL AND trim(staged_path) != ''"
  },
  {
    table: 'pending_actress_scrape_resources',
    sql: "SELECT staged_path AS p FROM pending_actress_scrape_resources WHERE staged_path IS NOT NULL AND trim(staged_path) != ''"
  },
  {
    table: 'agent_metadata_draft_resources',
    sql: "SELECT staged_path AS p FROM main.agent_metadata_draft_resources WHERE staged_path IS NOT NULL AND trim(staged_path) != ''"
  },
  {
    table: 'catalog_image_uploads',
    sql: `SELECT rel_path AS p FROM catalog_image_uploads
          WHERE purpose = 'pendingScrapeStaging' AND status = 'consumed'
            AND rel_path IS NOT NULL AND trim(rel_path) != ''`
  }
]

function tableExists(database: Database.Database, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  )
}

export function listFormallyReferencedImagePaths(
  database: Database.Database = getDb()
): Set<string> {
  const referenced = new Set<string>()
  const seen = new Set<string>()
  for (const query of REFERENCE_QUERIES) {
    const key = `${query.table}:${query.sql}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!tableExists(database, query.table)) continue
    const rows = database.prepare(query.sql).all() as Array<{ p: string | null }>
    for (const row of rows) {
      if (row.p) referenced.add(row.p)
    }
  }
  return referenced
}

export function isFormallyReferencedImagePath(
  relPath: string,
  database: Database.Database = getDb(),
  cache?: Set<string>
): boolean {
  const referenced = cache ?? listFormallyReferencedImagePaths(database)
  return referenced.has(relPath)
}
