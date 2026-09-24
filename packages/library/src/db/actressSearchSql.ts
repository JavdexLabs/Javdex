import { normalizeActressName } from './actressNameNormalization'
import {
  ACTRESS_NAME_TYPE,
  ACTRESS_SEARCHABLE_NAME_TYPES
} from './actressNames'

const OWNED_SEARCHABLE_NAME_TYPES = [
  ACTRESS_NAME_TYPE.MAIN,
  ...ACTRESS_SEARCHABLE_NAME_TYPES
] as const
const SEARCHABLE_NAME_TYPES_SQL = OWNED_SEARCHABLE_NAME_TYPES.map((type) => `'${type}'`).join(', ')

/** Bound LIKE params for actress text search (main name + typed names). */
export function actressSearchLikeParams(search: string): string[] {
  const escaped = normalizeActressName(search).replace(/[\\%_]/g, '\\$&')
  const like = `%${escaped}%`
  return [like]
}

/** SQL predicate: actress row matches a free-text search. */
export function actressTextSearchSql(alias: string): string {
  return `EXISTS (
    SELECT 1
    FROM actress_names an
    JOIN actress_name_ownership ano
      ON ano.actress_id = an.actress_id
     AND ano.normalized_name = normalize_actress_name(an.name)
    WHERE an.actress_id = ${alias}.id
      AND an.type IN (${SEARCHABLE_NAME_TYPES_SQL})
      AND ano.normalized_name LIKE ? ESCAPE '\\'
  )`
}

/** SQL predicate for video free-text search through uniquely owned actress names. */
export function actressOwnedNamePatternSearchSql(alias: string): string {
  return `EXISTS (
    SELECT 1
    FROM actress_names an
    JOIN actress_name_ownership ano
      ON ano.actress_id = an.actress_id
     AND ano.normalized_name = normalize_actress_name(an.name)
    WHERE an.actress_id = ${alias}.id
      AND an.type IN (${SEARCHABLE_NAME_TYPES_SQL})
      AND an.name LIKE ?
  )`
}

/**
 * Resolve owned names once per actress, then expand through the relation index.
 * MATERIALIZED and CROSS JOIN keep the name predicate out of the per-video loop.
 * Keep the original raw-name LIKE predicate (including its wildcard semantics).
 */
export function actressOwnedNameVideoIdsSql(): string {
  return `WITH matched_actresses AS MATERIALIZED (
    SELECT a.id FROM actresses a
    WHERE ${actressOwnedNamePatternSearchSql('a')}
  )
  SELECT va.video_id
  FROM matched_actresses matched
  CROSS JOIN video_actress va ON va.actress_id = matched.id`
}
