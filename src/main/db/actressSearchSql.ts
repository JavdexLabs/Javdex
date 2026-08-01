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

/** Existing pattern-based actress predicate retained for video free-text search compatibility. */
export function actressStoredNamePatternSearchSql(alias: string): string {
  return `(
    ${alias}.main_name LIKE ?
    OR EXISTS (
      SELECT 1 FROM actress_names an
      WHERE an.actress_id = ${alias}.id AND an.name LIKE ?
    )
  )`
}
