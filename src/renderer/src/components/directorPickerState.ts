import type { DirectorAssignmentInput, DirectorOption } from '@shared/classificationTypes'

export function typedDirectorAssignment(value: string): DirectorAssignmentInput | null {
  const name = value.trim()
  return name ? { createName: name } : null
}

export function selectedDirectorAssignment(
  option: Pick<DirectorOption, 'id'>
): DirectorAssignmentInput {
  return { directorId: option.id }
}

export function directorOptionDescription(option: DirectorOption): string {
  const career =
    option.careerStartYear || option.careerEndYear
      ? `${option.careerStartYear ?? '?'}-${option.careerEndYear ?? '至今'}`
      : null
  const aliases = option.aliases.length > 0 ? `别名 ${option.aliases.join(' / ')}` : null
  return [
    `#${option.id}`,
    option.countryRegion,
    option.birthDate ? `出生 ${option.birthDate}` : null,
    career ? `从业 ${career}` : null,
    aliases,
    `${option.videoCount} 部`
  ]
    .filter(Boolean)
    .join(' · ')
}
