import type { ClassificationEntityRef, ClassificationImageCandidate, ClassificationListPage, ClassificationPageQuery } from '@shared/classificationTypes'
import type Database from 'better-sqlite3'
import { getDb } from '@library/db/database'

/** Preserve the original all-video cover eligibility and date ordering. */
export function createClassificationImagePageReader(connection: () => Database.Database) {
  return function listClassificationImagePage(entity: ClassificationEntityRef, query: ClassificationPageQuery = {}): ClassificationListPage<ClassificationImageCandidate> {
    if (!Number.isSafeInteger(entity.id) || entity.id <= 0) throw new Error('分类实体参数无效')
    const limit = query.limit ?? 60, offset = query.offset ?? 0
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid image candidate page limit')
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid image candidate page offset')
    const predicate = entity.kind === 'organization' ? '(v.maker_organization_id = ? OR v.publisher_organization_id = ?)'
      : entity.kind === 'director' ? 'v.director_id = ?' : entity.kind === 'series' ? 'v.series_id = ?' : null
    if (!predicate) throw new Error('分类实体参数无效')
    const parameters = entity.kind === 'organization' ? [entity.id,entity.id] : [entity.id]
    const where = `${predicate} AND v.cover_path IS NOT NULL AND trim(v.cover_path) != ''`
    const db = connection()
    return db.transaction(() => {
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM videos v WHERE ${where}`).get(...parameters) as {n:number}).n
      // Rank narrow identities before hydrating potentially long title/path fields.
      const items = db.prepare(`WITH page AS MATERIALIZED (
        SELECT v.id, v.release_date, v.add_time,
          (v.release_date IS NULL OR trim(v.release_date) = '') AS empty_date
        FROM videos v WHERE ${where}
        ORDER BY empty_date ASC, v.release_date DESC, v.add_time DESC, v.id DESC
        LIMIT ? OFFSET ?
      ) SELECT v.id AS videoId, v.code, v.title, v.cover_path AS coverPath
        FROM page JOIN videos v ON v.id = page.id
        ORDER BY page.empty_date ASC, page.release_date DESC, page.add_time DESC, page.id DESC`)
        .all(...parameters,limit,offset) as ClassificationImageCandidate[]
      return {items,total,limit,offset}
    })()
  }

}

export const listClassificationImagePage = createClassificationImagePageReader(getDb)
