import type Database from 'better-sqlite3'
import type {
  ClassificationImageCleanupFailure,
  ClassificationLink,
  DirectorMergeInput,
  DirectorMergeResult,
  DirectorStatus
} from '@shared/classificationTypes'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'
import { getDb } from '../db/database'
import { writeDirectorLinks, writeDirectorNames } from './directorProfilePersistence'
import { mediaAssetStore } from './mediaAssetStore'

type StoredDirector = {
  id: number
  main_name: string
  image_path: string | null
  summary: string | null
  country_region: string | null
  birth_date: string | null
  death_date: string | null
  birth_place: string | null
  career_start_year: number | null
  career_end_year: number | null
  status: DirectorStatus
}

type StoredName = {
  name: string
  normalized_name: string
}

type StoredLink = ClassificationLink & {
  normalized_url: string
}

interface DirectorMergeServiceDependencies {
  database: () => Database.Database
  deleteStoredImage: (storedPath: string) => void
}

export interface DirectorMergeService {
  merge(input: DirectorMergeInput): DirectorMergeResult
}

function assertMergeInput(input: DirectorMergeInput): void {
  if (
    !input ||
    !Number.isInteger(input.targetId) ||
    input.targetId <= 0 ||
    !Number.isInteger(input.sourceId) ||
    input.sourceId <= 0
  ) {
    throw new Error('导演合并参数无效')
  }
  if (input.targetId === input.sourceId) throw new Error('不能合并同一导演')
}

function readDirector(database: Database.Database, id: number): StoredDirector {
  const director = database.prepare('SELECT * FROM directors WHERE id = ?').get(id) as
    | StoredDirector
    | undefined
  if (!director) throw new Error('导演不存在')
  return director
}

function readNames(database: Database.Database, id: number): StoredName[] {
  return database
    .prepare(
      `SELECT name, normalized_name FROM director_names
       WHERE director_id = ? AND type = 'alias'
       ORDER BY position, id`
    )
    .all(id) as StoredName[]
}

function mergedAliases(
  target: StoredDirector,
  targetAliases: StoredName[],
  source: StoredDirector,
  sourceAliases: StoredName[]
): string[] {
  const seen = new Set([normalizeClassificationName(target.main_name)])
  const aliases: string[] = []
  const append = (name: string, normalizedName?: string): void => {
    const normalized = normalizedName ?? normalizeClassificationName(name)
    if (seen.has(normalized)) return
    seen.add(normalized)
    aliases.push(name)
  }
  targetAliases.forEach((alias) => append(alias.name, alias.normalized_name))
  append(source.main_name)
  sourceAliases.forEach((alias) => append(alias.name, alias.normalized_name))
  return aliases
}

function readLinks(database: Database.Database, id: number): StoredLink[] {
  return database
    .prepare(
      `SELECT label, url, normalized_url, position FROM director_links
       WHERE director_id = ? ORDER BY position, id`
    )
    .all(id) as StoredLink[]
}

function mergedLinks(targetLinks: StoredLink[], sourceLinks: StoredLink[]): StoredLink[] {
  const seen = new Set<string>()
  const links: StoredLink[] = []
  for (const link of [...targetLinks, ...sourceLinks]) {
    if (seen.has(link.normalized_url)) continue
    seen.add(link.normalized_url)
    links.push({ ...link, position: links.length })
  }
  return links
}

function meaningfulText(target: string | null, source: string | null): string | null {
  return target?.trim() ? target : source?.trim() ? source : null
}

function validateMergedTimeline(director: StoredDirector): void {
  if (director.birth_date && director.death_date && director.birth_date > director.death_date) {
    throw new Error('合并后的出生日期不能晚于去世日期')
  }
  if (
    director.career_start_year != null &&
    director.career_end_year != null &&
    director.career_start_year > director.career_end_year
  ) {
    throw new Error('合并后的从业开始年份不能晚于结束年份')
  }
}

export function createDirectorMergeService(
  dependencies: Partial<DirectorMergeServiceDependencies> = {}
): DirectorMergeService {
  const database = dependencies.database ?? getDb
  const deleteStoredImage =
    dependencies.deleteStoredImage ?? ((storedPath) => mediaAssetStore.delete(storedPath))

  return {
    merge(input): DirectorMergeResult {
      assertMergeInput(input)
      const db = database()
      const committed = db.transaction(() => {
        const target = readDirector(db, input.targetId)
        const source = readDirector(db, input.sourceId)
        const aliases = mergedAliases(
          target,
          readNames(db, target.id),
          source,
          readNames(db, source.id)
        )
        const links = mergedLinks(readLinks(db, target.id), readLinks(db, source.id))
        const now = new Date().toISOString()
        const merged: StoredDirector = {
          ...target,
          image_path: target.image_path ?? source.image_path,
          summary: meaningfulText(target.summary, source.summary),
          country_region: meaningfulText(target.country_region, source.country_region),
          birth_date: target.birth_date ?? source.birth_date,
          death_date: target.death_date ?? source.death_date,
          birth_place: meaningfulText(target.birth_place, source.birth_place),
          career_start_year: target.career_start_year ?? source.career_start_year,
          career_end_year: target.career_end_year ?? source.career_end_year,
          status: target.status !== 'unknown' ? target.status : source.status
        }
        validateMergedTimeline(merged)
        db.prepare(
          `UPDATE directors
           SET image_path = ?, summary = ?, country_region = ?, birth_date = ?, death_date = ?,
               birth_place = ?, career_start_year = ?, career_end_year = ?, status = ?,
               updated_at = ?
           WHERE id = ?`
        ).run(
          merged.image_path,
          merged.summary,
          merged.country_region,
          merged.birth_date,
          merged.death_date,
          merged.birth_place,
          merged.career_start_year,
          merged.career_end_year,
          merged.status,
          now,
          target.id
        )
        writeDirectorNames(db, target.id, target.main_name, aliases)
        writeDirectorLinks(db, target.id, links)
        const transferredVideoCount = db
          .prepare(
            'UPDATE videos SET director_id = ?, director = ?, updated_at = ? WHERE director_id = ?'
          )
          .run(target.id, target.main_name, now, source.id).changes
        db.prepare('DELETE FROM directors WHERE id = ?').run(source.id)
        return {
          targetId: target.id,
          sourceId: source.id,
          transferredVideoCount,
          imagePath: merged.image_path,
          obsoleteImagePath:
            target.image_path && source.image_path && target.image_path !== source.image_path
              ? source.image_path
              : null
        }
      })()

      const cleanupFailures: ClassificationImageCleanupFailure[] = []
      const { obsoleteImagePath, ...result } = committed
      if (obsoleteImagePath) {
        try {
          deleteStoredImage(obsoleteImagePath)
        } catch (error) {
          cleanupFailures.push({
            path: obsoleteImagePath,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
      return { ...result, cleanupFailures }
    }
  }
}

export const directorMergeService = createDirectorMergeService()
