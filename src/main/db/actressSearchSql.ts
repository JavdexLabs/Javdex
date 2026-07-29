import { ACTRESS_SEARCHABLE_NAME_TYPES } from './actressNames'

const SEARCHABLE_NAME_TYPES_SQL = ACTRESS_SEARCHABLE_NAME_TYPES.map((type) => `'${type}'`).join(
  ', '
)

/** Bound LIKE params for actress text search (main name + typed names). */
export function actressSearchLikeParams(search: string): string[] {
  const escaped = search.trim().replace(/[\\%_]/g, '\\$&')
  const like = `%${escaped}%`
  return [like, like]
}

/** SQL predicate: actress row matches a free-text search. */
export function actressTextSearchSql(alias: string): string {
  return `(
    ${alias}.main_name LIKE ? ESCAPE '\\'
    OR EXISTS (
      SELECT 1 FROM actress_names an
      WHERE an.actress_id = ${alias}.id
        AND an.type IN (${SEARCHABLE_NAME_TYPES_SQL})
        AND an.name LIKE ? ESCAPE '\\'
    )
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
