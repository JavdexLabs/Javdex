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
  const aliases = option.aliases.length > 0 ? `别名 ${option.aliases.join(' / ')}` : null
  return [`#${option.id}`, aliases, `${option.videoCount} 部`].filter(Boolean).join(' · ')
}
