/** Mirrors selectDefaultExternalRating; the enclosing video table uses alias v. */
export const DEFAULT_EXTERNAL_RATING_SQL = `(SELECT es.rating_average FROM video_external_stats es
  WHERE es.video_id = v.id AND es.rating_average IS NOT NULL
  ORDER BY es.is_default DESC, COALESCE(es.fetched_at, '') DESC, es.source ASC LIMIT 1)`
