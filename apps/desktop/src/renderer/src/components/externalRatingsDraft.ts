import { selectDefaultExternalRating } from '@shared/externalRatings'
import type { VideoEditInput, VideoExternalStats } from '@shared/videoTypes'

export interface ExternalRatingDraftRow {
  key: string
  original: VideoExternalStats | null
  source: string
  score: string
  count: string
  removed: boolean
}

export interface ExternalRatingsDraft {
  rows: ExternalRatingDraftRow[]
  defaultKey: string | null
}

export function createExternalRatingsDraft(ratings: VideoExternalStats[]): ExternalRatingsDraft {
  const selected = selectDefaultExternalRating(ratings)
  return {
    rows: ratings.map((rating) => ({
      key: `rating-${rating.id}`, original: rating, source: rating.source,
      score: rating.rating_average?.toString() ?? '', count: rating.rating_count?.toString() ?? '', removed: false
    })),
    defaultKey: selected ? `rating-${selected.id}` : null
  }
}

function numberFromDraft(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  return /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed) ? Number(trimmed) : NaN
}

export function canSelectExternalRating(row: ExternalRatingDraftRow): boolean {
  const score = numberFromDraft(row.score)
  return !row.removed && row.source.trim() !== '' && score !== null && Number.isFinite(score) && score >= 0
}

export function reconcileExternalRatingsDraft(value: ExternalRatingsDraft): ExternalRatingsDraft {
  const selected = selectDefaultExternalRating(value.rows.filter(canSelectExternalRating).map((row) => ({
    key: row.key, source: row.source.trim(), rating_average: numberFromDraft(row.score),
    fetched_at: row.original?.fetched_at ?? null, is_default: row.key === value.defaultKey ? 1 : 0
  })))
  return { ...value, defaultKey: selected?.key ?? null }
}

export function externalRatingsDraftErrors(value: ExternalRatingsDraft): Map<string, Partial<Record<'source' | 'score' | 'count', string>>> {
  const errors = new Map<string, Partial<Record<'source' | 'score' | 'count', string>>>()
  const sources = new Map<string, string[]>()
  for (const row of value.rows) {
    if (row.removed) continue
    const fields: Partial<Record<'source' | 'score' | 'count', string>> = {}
    const source = row.source.trim()
    if (!source) fields.source = '请输入来源名称'
    else if (source.length > 256) fields.source = '来源名称最多 256 个字符'
    else sources.set(source, [...(sources.get(source) ?? []), row.key])
    const score = numberFromDraft(row.score)
    if (score === null && !row.original) fields.score = '请输入评分'
    else if (score !== null && (!Number.isFinite(score) || score < 0)) fields.score = '评分须为不小于 0 的有效数字'
    const count = numberFromDraft(row.count)
    if (count !== null && (!Number.isSafeInteger(count) || count < 0)) fields.count = '人数须为不小于 0 的整数'
    if (Object.keys(fields).length) errors.set(row.key, fields)
  }
  for (const keys of sources.values()) {
    if (keys.length < 2) continue
    for (const key of keys) errors.set(key, { ...errors.get(key), source: '来源名称不能重复' })
  }
  return errors
}

export function externalRatingsFromDraft(value: ExternalRatingsDraft): NonNullable<VideoEditInput['externalRatings']> {
  const errors = externalRatingsDraftErrors(value)
  if (errors.size) throw new Error(Object.values(errors.values().next().value!)[0])
  const selected = reconcileExternalRatingsDraft(value)
  return {
    deletedSources: value.rows.filter((row) => row.removed && row.original).map((row) => row.original!.source),
    defaultSource: selected.rows.find((row) => row.key === selected.defaultKey)?.source.trim() ?? null,
    entries: value.rows.filter((row) => !row.removed && (!row.original || row.source.trim() !== row.original.source ||
      numberFromDraft(row.score) !== row.original.rating_average || numberFromDraft(row.count) !== row.original.rating_count))
      .map((row) => ({ originalSource: row.original?.source ?? null, source: row.source.trim(),
        ratingAverage: numberFromDraft(row.score), ratingCount: numberFromDraft(row.count) }))
  }
}
