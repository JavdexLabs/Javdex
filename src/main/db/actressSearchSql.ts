/** Bound LIKE params for actress text search (main name + typed names). */
export function actressSearchLikeParams(search: string): string[] {
  const like = `%${search.trim()}%`
  return [like, like]
}

/** SQL predicate: actress row matches a free-text search. */
export function actressTextSearchSql(alias: string): string {
  return `(
    ${alias}.main_name LIKE ?
    OR EXISTS (
      SELECT 1 FROM actress_names an
      WHERE an.actress_id = ${alias}.id AND an.name LIKE ?
    )
  )`
}
