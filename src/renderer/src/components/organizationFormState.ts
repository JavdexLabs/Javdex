import type {
  OrganizationDetail,
  OrganizationLinkInput,
  OrganizationOption,
  OrganizationSummary,
  OrganizationStatus,
  OrganizationUpdateInput
} from '@shared/classificationTypes'

export interface OrganizationFormDraft {
  mainName: string
  aliases: string
  summary: string
  countryRegion: string
  foundedYear: string
  endedYear: string
  status: OrganizationStatus
  parentOrganizationId: string
  links: OrganizationLinkInput[]
  keepPreviousMainName: boolean
}

export function retainSelectedParentOption(
  options: readonly OrganizationOption[],
  selected: OrganizationSummary | null,
  excludedOrganizationId?: number
): OrganizationOption[] {
  const available = options.filter((option) => option.id !== excludedOrganizationId)
  if (
    !selected ||
    selected.id === excludedOrganizationId ||
    available.some((option) => option.id === selected.id)
  ) {
    return available
  }
  return [{ ...selected, aliases: [], roles: [] }, ...available]
}

export function createOrganizationFormDraft(
  organization?: OrganizationDetail | null
): OrganizationFormDraft {
  return {
    mainName: organization?.mainName ?? '',
    aliases: organization?.aliases.join('\n') ?? '',
    summary: organization?.summary ?? '',
    countryRegion: organization?.countryRegion ?? '',
    foundedYear: organization?.foundedYear?.toString() ?? '',
    endedYear: organization?.endedYear?.toString() ?? '',
    status: organization?.status ?? 'unknown',
    parentOrganizationId: organization?.parent?.id.toString() ?? '',
    links: organization?.links.map(({ label, url }) => ({ label, url })) ?? [],
    keepPreviousMainName: true
  }
}

function optionalYear(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  return Number(trimmed)
}

export function organizationUpdateInputFromDraft(
  draft: OrganizationFormDraft
): OrganizationUpdateInput {
  return {
    mainName: draft.mainName.trim(),
    keepPreviousMainName: draft.keepPreviousMainName,
    aliases: draft.aliases
      .split(/[\n,，、]/)
      .map((name) => name.trim())
      .filter(Boolean),
    summary: draft.summary.trim() || null,
    countryRegion: draft.countryRegion.trim() || null,
    foundedYear: optionalYear(draft.foundedYear),
    endedYear: optionalYear(draft.endedYear),
    status: draft.status,
    parentOrganizationId: draft.parentOrganizationId
      ? Number(draft.parentOrganizationId)
      : null,
    links: draft.links
      .map((link) => ({ label: link.label.trim(), url: link.url.trim() }))
      .filter((link) => Boolean(link.url))
  }
}
