import type Database from 'better-sqlite3'
import type {
  DirectorDeleteImpact,
  DirectorDeleteResult,
  SeriesDeleteImpact,
  SeriesDeleteResult
} from '@shared/classificationTypes'
import { getDb } from '../db/database'
import { cleanupClassificationImage } from './classificationImageCleanup'
import { mediaAssetStore } from './mediaAssetStore'

interface ClassificationDeletionServiceDependencies {
  database: () => Database.Database
  deleteStoredImage: (storedPath: string) => void
}

export interface ClassificationDeletionService {
  previewDirector(id: number): DirectorDeleteImpact
  deleteDirector(id: number): DirectorDeleteResult
  previewSeries(id: number): SeriesDeleteImpact
  deleteSeries(id: number): SeriesDeleteResult
}

function requireId(id: number): void {
  if (!Number.isInteger(id) || id <= 0) throw new Error('分类删除参数无效')
}

function readDirectorImpact(
  database: Database.Database,
  id: number
): DirectorDeleteImpact & { imagePath: string | null } {
  requireId(id)
  const row = database
    .prepare(
      `SELECT d.id, d.image_path,
              (SELECT COUNT(*) FROM videos v WHERE v.director_id = d.id) AS video_count
       FROM directors d WHERE d.id = ?`
    )
    .get(id) as { id: number; image_path: string | null; video_count: number } | undefined
  if (!row) throw new Error('导演不存在')
  return { id: row.id, videoCount: row.video_count, imagePath: row.image_path }
}

function readSeriesImpact(
  database: Database.Database,
  id: number
): SeriesDeleteImpact & { imagePath: string | null } {
  requireId(id)
  const row = database
    .prepare(
      `SELECT s.id, s.image_path,
              (SELECT COUNT(*) FROM videos v WHERE v.series_id = s.id) AS video_count,
              (SELECT COUNT(*) FROM series child WHERE child.parent_series_id = s.id)
                AS direct_child_count
       FROM series s WHERE s.id = ?`
    )
    .get(id) as
    | { id: number; image_path: string | null; video_count: number; direct_child_count: number }
    | undefined
  if (!row) throw new Error('系列不存在')
  return {
    id: row.id,
    videoCount: row.video_count,
    directChildCount: row.direct_child_count,
    imagePath: row.image_path
  }
}

export function createClassificationDeletionService(
  dependencies: Partial<ClassificationDeletionServiceDependencies> = {}
): ClassificationDeletionService {
  const database = dependencies.database ?? getDb
  const deleteStoredImage =
    dependencies.deleteStoredImage ?? ((storedPath) => mediaAssetStore.delete(storedPath))

  return {
    previewDirector(id): DirectorDeleteImpact {
      const { imagePath: _imagePath, ...impact } = readDirectorImpact(database(), id)
      return impact
    },

    deleteDirector(id): DirectorDeleteResult {
      const db = database()
      const committed = db.transaction(() => {
        const impact = readDirectorImpact(db, id)
        const unlinked = db
          .prepare(
            `UPDATE videos SET director_id = NULL, updated_at = ?
             WHERE director_id = ?`
          )
          .run(new Date().toISOString(), id).changes
        db.prepare('DELETE FROM directors WHERE id = ?').run(id)
        return { id, unlinkedVideoCount: unlinked, imagePath: impact.imagePath }
      })()
      const { imagePath, ...result } = committed
      return {
        ...result,
        cleanupFailures: cleanupClassificationImage(imagePath, deleteStoredImage)
      }
    },

    previewSeries(id): SeriesDeleteImpact {
      const { imagePath: _imagePath, ...impact } = readSeriesImpact(database(), id)
      return impact
    },

    deleteSeries(id): SeriesDeleteResult {
      const db = database()
      const committed = db.transaction(() => {
        const impact = readSeriesImpact(db, id)
        const now = new Date().toISOString()
        const unlinked = db
          .prepare(
            `UPDATE videos SET series_id = NULL, updated_at = ?
             WHERE series_id = ?`
          )
          .run(now, id).changes
        const detachedChildren = db
          .prepare(
            `UPDATE series SET parent_series_id = NULL, updated_at = ?
             WHERE parent_series_id = ?`
          )
          .run(now, id).changes
        db.prepare('DELETE FROM series WHERE id = ?').run(id)
        return {
          id,
          unlinkedVideoCount: unlinked,
          detachedChildCount: detachedChildren,
          imagePath: impact.imagePath
        }
      })()
      const { imagePath, ...result } = committed
      return {
        ...result,
        cleanupFailures: cleanupClassificationImage(imagePath, deleteStoredImage)
      }
    }
  }
}

export const classificationDeletionService = createClassificationDeletionService()
