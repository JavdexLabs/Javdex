import type { LibraryOverviewStats } from '@shared/libraryTypes'
import { getDb } from './database'

export function getLibraryOverviewStats(): LibraryOverviewStats {
  const db = getDb()

  let unscraped = 0
  let scraped = 0
  let failed = 0
  const videoRows = db
    .prepare('SELECT scraped_status AS status, COUNT(*) AS n FROM videos GROUP BY scraped_status')
    .all() as Array<{ status: number; n: number }>
  for (const row of videoRows) {
    if (row.status === 0) unscraped = row.n
    else if (row.status === 1) scraped = row.n
    else if (row.status === 2) failed = row.n
  }

  const actressRow = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN gender = 'male' THEN 1 ELSE 0 END) AS male,
              SUM(CASE WHEN gender IS NULL OR gender = 'female' THEN 1 ELSE 0 END) AS female,
              SUM(
                CASE
                  WHEN (gender IS NULL OR gender = 'female') AND scraped_status = 1 THEN 1
                  ELSE 0
                END
              ) AS scraped,
              SUM(
                CASE
                  WHEN (gender IS NULL OR gender = 'female') AND scraped_status = 2 THEN 1
                  ELSE 0
                END
              ) AS failed,
              SUM(
                CASE
                  WHEN (gender IS NULL OR gender = 'female') AND scraped_status = 0 THEN 1
                  ELSE 0
                END
              ) AS unscraped
       FROM actresses`
    )
    .get() as {
    total: number
    male: number
    female: number
    scraped: number
    failed: number
    unscraped: number
  }

  const playlists = (db.prepare('SELECT COUNT(*) AS n FROM playlists').get() as { n: number }).n
  const tags = (db.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n
  const galleryAssets = (
    db.prepare('SELECT COUNT(*) AS n FROM actress_gallery_assets').get() as { n: number }
  ).n

  const facetCounts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM directors) AS director,
         (SELECT COUNT(*) FROM organization_roles WHERE role = 'maker') AS maker,
         (SELECT COUNT(*) FROM organization_roles WHERE role = 'publisher') AS publisher,
         (SELECT COUNT(*) FROM series) AS series`
    )
    .get() as { director: number; maker: number; publisher: number; series: number }

  return {
    videos: {
      total: unscraped + scraped + failed,
      scraped,
      unscraped,
      failed
    },
    actresses: {
      total: actressRow.total,
      female: actressRow.female,
      male: actressRow.male,
      scraped: actressRow.scraped,
      failed: actressRow.failed,
      unscraped: actressRow.unscraped
    },
    playlists,
    tags,
    galleryAssets,
    facets: {
      directors: facetCounts.director,
      makers: facetCounts.maker,
      publishers: facetCounts.publisher,
      series: facetCounts.series
    }
  }
}
