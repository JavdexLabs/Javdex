import type Database from 'better-sqlite3'
import type {
  SeriesMergeInput,
  SeriesMergeResult,
  SeriesStatus
} from '@shared/classificationTypes'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'
import { getDb } from '../db/database'
import {
  assertClassificationMergeInput,
  mergeClassificationAliases,
  mergeClassificationLinks,
  resolveClassificationMergeParent,
  targetFirstMeaningfulText,
  type ClassificationMergeLink,
  type ClassificationMergeName
} from './classificationMergeSupport'
import {
  cleanupClassificationImage,
  obsoleteSourceImagePath
} from './classificationImageCleanup'
import { mediaAssetStore } from './mediaAssetStore'
import {
  assertSeriesNamesAvailable,
  writeSeriesLinks,
  writeSeriesNames
} from './seriesProfilePersistence'
import { assertNoPendingVideoMetadataMutation } from '../db/videoPendingMetadataLock'

type StoredSeries = {
  id: number
  main_name: string
  image_path: string | null
  summary: string | null
  owner_organization_id: number | null
  parent_series_id: number | null
  start_year: number | null
  end_year: number | null
  status: SeriesStatus
}

interface SeriesMergeServiceDependencies {
  database: () => Database.Database
  deleteStoredImage: (storedPath: string) => void
}

export interface SeriesMergeService {
  merge(input: SeriesMergeInput): SeriesMergeResult
}

function readSeries(database: Database.Database, id: number): StoredSeries {
  const series = database.prepare('SELECT * FROM series WHERE id = ?').get(id) as
    | StoredSeries
    | undefined
  if (!series) throw new Error('系列不存在')
  return series
}

function readAliases(database: Database.Database, id: number): ClassificationMergeName[] {
  return database
    .prepare(
      `SELECT name, normalized_name FROM series_names
       WHERE series_id = ? AND type = 'alias'
       ORDER BY position, id`
    )
    .all(id) as ClassificationMergeName[]
}

function readLinks(database: Database.Database, id: number): ClassificationMergeLink[] {
  return database
    .prepare(
      `SELECT label, url, normalized_url, position FROM series_links
       WHERE series_id = ? ORDER BY position, id`
    )
    .all(id) as ClassificationMergeLink[]
}

function validateMergedLifecycle(series: StoredSeries): void {
  if (
    series.start_year != null &&
    series.end_year != null &&
    series.start_year > series.end_year
  ) {
    throw new Error('合并后的开始年份不能晚于结束年份')
  }
}

export function createSeriesMergeService(
  dependencies: Partial<SeriesMergeServiceDependencies> = {}
): SeriesMergeService {
  const database = dependencies.database ?? getDb
  const deleteStoredImage =
    dependencies.deleteStoredImage ?? ((storedPath) => mediaAssetStore.delete(storedPath))

  return {
    merge(input): SeriesMergeResult {
      assertClassificationMergeInput(input, '系列')
      const db = database()
      const committed = db.transaction(() => {
        const target = readSeries(db, input.targetId)
        const source = readSeries(db, input.sourceId)
        assertNoPendingVideoMetadataMutation(db, 'v.series_id = ?', [source.id])
        const aliases = mergeClassificationAliases(
          target.main_name,
          readAliases(db, target.id),
          source.main_name,
          readAliases(db, source.id)
        )
        const links = mergeClassificationLinks(
          readLinks(db, target.id),
          readLinks(db, source.id)
        )
        const merged: StoredSeries = {
          ...target,
          image_path: target.image_path ?? source.image_path,
          summary: targetFirstMeaningfulText(target.summary, source.summary),
          owner_organization_id:
            target.owner_organization_id ?? source.owner_organization_id,
          parent_series_id: resolveClassificationMergeParent(
            db,
            'series',
            { id: target.id, parentId: target.parent_series_id },
            { id: source.id, parentId: source.parent_series_id }
          ),
          start_year: target.start_year ?? source.start_year,
          end_year: target.end_year ?? source.end_year,
          status: target.status !== 'unknown' ? target.status : source.status
        }
        validateMergedLifecycle(merged)
        const normalizedNames = [target.main_name, ...aliases].map((name) =>
          normalizeClassificationName(name)
        )
        assertSeriesNamesAvailable(
          db,
          merged.owner_organization_id,
          normalizedNames,
          [target.id, source.id]
        )

        const now = new Date().toISOString()
        db.prepare(
          `UPDATE series
           SET image_path = ?, summary = ?, owner_organization_id = ?, parent_series_id = ?,
               start_year = ?, end_year = ?, status = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          merged.image_path,
          merged.summary,
          merged.owner_organization_id,
          merged.parent_series_id,
          merged.start_year,
          merged.end_year,
          merged.status,
          now,
          target.id
        )
        db.prepare('DELETE FROM series_name_ownership WHERE series_id = ?').run(source.id)
        writeSeriesNames(
          db,
          target.id,
          merged.owner_organization_id,
          target.main_name,
          aliases
        )
        writeSeriesLinks(db, target.id, links)
        const transferredVideoCount = db
          .prepare(
            'UPDATE videos SET series_id = ?, updated_at = ? WHERE series_id = ?'
          )
          .run(target.id, now, source.id).changes
        const transferredChildCount = db
          .prepare(
            `UPDATE series SET parent_series_id = ?, updated_at = ?
             WHERE parent_series_id = ? AND id <> ?`
          )
          .run(target.id, now, source.id, target.id).changes
        db.prepare('DELETE FROM series WHERE id = ?').run(source.id)
        return {
          targetId: target.id,
          sourceId: source.id,
          transferredVideoCount,
          transferredChildCount,
          imagePath: merged.image_path,
          obsoleteImagePath: obsoleteSourceImagePath(target.image_path, source.image_path)
        }
      })()

      const { obsoleteImagePath, ...result } = committed
      return {
        ...result,
        cleanupFailures: cleanupClassificationImage(obsoleteImagePath, deleteStoredImage)
      }
    }
  }
}

export const seriesMergeService = createSeriesMergeService()
