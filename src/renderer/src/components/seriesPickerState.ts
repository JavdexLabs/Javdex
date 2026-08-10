import type { SeriesAssignmentInput, SeriesOption } from '@shared/classificationTypes'

export function typedSeriesAssignment(value: string): SeriesAssignmentInput | null {
  const name = value.trim()
  return name ? { createName: name } : null
}

export function selectedSeriesAssignment(option: Pick<SeriesOption, 'id'>): SeriesAssignmentInput {
  return { seriesId: option.id }
}

export function seriesOptionDescription(option: SeriesOption): string {
  const owner = option.ownerOrganization?.mainName ?? '未归属'
  const aliases = option.aliases.length > 0 ? `别名 ${option.aliases.join(' / ')}` : null
  return [`#${option.id}`, owner, aliases, `${option.videoCount} 部`].filter(Boolean).join(' · ')
}
