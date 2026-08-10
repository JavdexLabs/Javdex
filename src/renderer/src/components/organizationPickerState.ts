import type {
  OrganizationAssignmentInput,
  OrganizationOption
} from '@shared/classificationTypes'
import { normalizeClassificationName } from '@shared/classificationNameNormalization'

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
