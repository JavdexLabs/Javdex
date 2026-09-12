import type {
  ClassificationLinkInput,
  SeriesDetail,
  SeriesStatus,
  SeriesUpdateInput
} from '@shared/classificationTypes'

export interface SeriesFormDraft {
  mainName: string
  aliases: string[]
  keepPreviousMainName: boolean
  summary: string
  ownerOrganizationId: string
  parentSeriesId: string
  startYear: string
  endYear: string
  status: SeriesStatus
  links: ClassificationLinkInput[]
}

export function createSeriesFormDraft(series?: SeriesDetail | null): SeriesFormDraft {
  return {
    mainName: series?.mainName ?? '',
    aliases: series?.aliases ? [...series.aliases] : [],
    keepPreviousMainName: true,
    summary: series?.summary ?? '',
    ownerOrganizationId: series?.ownerOrganization?.id.toString() ?? '',
    parentSeriesId: series?.parentSeries?.id.toString() ?? '',
    startYear: series?.startYear?.toString() ?? '',
    endYear: series?.endYear?.toString() ?? '',
    status: series?.status ?? 'unknown',
    links: series?.links.map(({ label, url }) => ({ label, url })) ?? []
  }
}

export function seriesInputFromDraft(draft: SeriesFormDraft): SeriesUpdateInput {
  const optionalId = (value: string): number | null => (value.trim() ? Number(value) : null)
  return {
    mainName: draft.mainName.trim(),
    aliases: draft.aliases.map((item) => item.trim()).filter(Boolean),
    keepPreviousMainName: draft.keepPreviousMainName,
    summary: draft.summary.trim() || null,
    ownerOrganizationId: optionalId(draft.ownerOrganizationId),
    parentSeriesId: optionalId(draft.parentSeriesId),
    startYear: optionalId(draft.startYear),
    endYear: optionalId(draft.endYear),
    status: draft.status,
    links: draft.links
      .filter((link) => link.url.trim())
      .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
  }
}
