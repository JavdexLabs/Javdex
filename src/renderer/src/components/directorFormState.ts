import type {
  DirectorDetail,
  DirectorStatus,
  DirectorUpdateInput,
  OrganizationLinkInput,
} from '@shared/classificationTypes'

export interface DirectorFormDraft {
  mainName: string
  aliases: string
  keepPreviousMainName: boolean
  summary: string
  countryRegion: string
  birthDate: string
  deathDate: string
  birthPlace: string
  careerStartYear: string
  careerEndYear: string
  status: DirectorStatus
  links: OrganizationLinkInput[]
}

export function createDirectorFormDraft(director?: DirectorDetail | null): DirectorFormDraft {
  return {
    mainName: director?.mainName ?? '',
    aliases: director?.aliases.join('\n') ?? '',
    keepPreviousMainName: true,
    summary: director?.summary ?? '',
    countryRegion: director?.countryRegion ?? '',
    birthDate: director?.birthDate ?? '',
    deathDate: director?.deathDate ?? '',
    birthPlace: director?.birthPlace ?? '',
    careerStartYear: director?.careerStartYear?.toString() ?? '',
    careerEndYear: director?.careerEndYear?.toString() ?? '',
    status: director?.status ?? 'unknown',
    links: director?.links.map(({ label, url }) => ({ label, url })) ?? [],
  }
}

export function directorInputFromDraft(draft: DirectorFormDraft): DirectorUpdateInput {
  const names = draft.aliases
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
  const year = (value: string): number | null => (value.trim() ? Number(value) : null)
  return {
    mainName: draft.mainName.trim(),
    aliases: names,
    keepPreviousMainName: draft.keepPreviousMainName,
    summary: draft.summary.trim() || null,
    countryRegion: draft.countryRegion.trim() || null,
    birthDate: draft.birthDate || null,
    deathDate: draft.deathDate || null,
    birthPlace: draft.birthPlace.trim() || null,
    careerStartYear: year(draft.careerStartYear),
    careerEndYear: year(draft.careerEndYear),
    status: draft.status,
    links: draft.links.filter((link) => link.url.trim()),
  }
}
