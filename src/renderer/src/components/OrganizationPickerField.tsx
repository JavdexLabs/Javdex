import { useDeferredValue, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  OrganizationAssignmentInput,
  OrganizationRole
} from '@shared/classificationTypes'
import { api } from '../api'
import { resolveOrganizationAssignment } from './organizationPickerState'
import { organizationKeys } from '../query/queryKeys'
import { FACET_LABEL } from '../facet'

interface Props {
  id: string
  role: OrganizationRole
  value: string
  onChange: (value: string) => void
  onAssignmentChange: (assignment: OrganizationAssignmentInput | null) => void
}

export default function OrganizationPickerField({
  id,
  role,
  value,
  onChange,
  onAssignmentChange
}: Props): JSX.Element {
  const deferredValue = useDeferredValue(value)
  const optionsQuery = useQuery({
    queryKey: organizationKeys.options(deferredValue.trim()),
    queryFn: () => api.organizations.options(deferredValue.trim() || undefined),
    placeholderData: (previous) => previous
  })
  const options = useMemo(() => optionsQuery.data ?? [], [optionsQuery.data])
  const listId = `${id}-options`

  useEffect(() => {
    onAssignmentChange(resolveOrganizationAssignment(value, options))
  }, [onAssignmentChange, options, value])

  return (
    <>
      <input
        id={id}
        className="text-input"
        value={value}
        list={listId}
        autoComplete="off"
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          const nextValue = event.target.value
          onChange(nextValue)
          onAssignmentChange(resolveOrganizationAssignment(nextValue, options))
        }}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.id} value={option.mainName}>
            {option.aliases.length > 0 ? option.aliases.join(' / ') : undefined}
          </option>
        ))}
      </datalist>
      <span id={`${id}-hint`} className="entity-edit-field-hint">
        搜索已有{FACET_LABEL[role]}；输入新名称会在保存时创建。
      </span>
    </>
  )
}
