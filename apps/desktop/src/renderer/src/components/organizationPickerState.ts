import type {
  OrganizationAssignmentInput,
  OrganizationOption,
  OrganizationRole
} from '@shared/classificationTypes'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'
import { FACET_LABEL } from '../facet'

type OrganizationIdentityOption = Pick<OrganizationOption, 'id' | 'mainName' | 'aliases'>

export function resolveOrganizationAssignment(
  rawValue: string,
  options: readonly OrganizationIdentityOption[]
): OrganizationAssignmentInput | null {
  const value = rawValue.trim()
  if (!value) return null
  const normalizedValue = normalizeClassificationName(value)
  const existing = options.find((option) =>
    [option.mainName, ...option.aliases].some(
      (name) => normalizeClassificationName(name) === normalizedValue
    )
  )
  return existing ? { organizationId: existing.id } : { createName: value }
}

export function organizationOptionDescription(option: {
  id: number
  aliases: readonly string[]
  roles: readonly OrganizationRole[]
}): string {
  const roles = option.roles.map((role) => FACET_LABEL[role]).join(' / ')
  const aliases = option.aliases.length > 0 ? `别名 ${option.aliases.join(' / ')}` : null
  return [`#${option.id}`, roles || null, aliases].filter(Boolean).join(' · ')
}
