import type { LibraryOverviewStats } from '@shared/types'
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
                  WHEN (gender IS NULL OR gender = 'female')
                    AND last_scraped_at IS NOT NULL
                    AND trim(last_scraped_at) != ''
                  THEN 1
                  ELSE 0
                END
              ) AS scraped
       FROM actresses`
    )
    .get() as { total: number; male: number; female: number; scraped: number }

  const playlists = (db.prepare('SELECT COUNT(*) AS n FROM playlists').get() as { n: number }).n
  const tags = (db.prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n
  const galleryAssets = (
    db.prepare('SELECT COUNT(*) AS n FROM actress_gallery_assets').get() as { n: number }
  ).n

  const facetCounts = { director: 0, maker: 0, publisher: 0, series: 0 }
  const facetRows = db
    .prepare('SELECT type, COUNT(*) AS n FROM facet_entries GROUP BY type')
    .all() as Array<{ type: keyof typeof facetCounts; n: number }>
  for (const row of facetRows) {
    if (row.type in facetCounts) facetCounts[row.type] = row.n
  }

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
      unscraped: actressRow.female - actressRow.scraped
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
