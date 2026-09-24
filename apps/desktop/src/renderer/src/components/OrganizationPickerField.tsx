import { useDeferredValue, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  OrganizationAssignmentInput,
  OrganizationRole
} from '@shared/classificationTypes'
import { api } from '../api'
import {
  organizationOptionDescription,
  resolveOrganizationAssignment
} from './organizationPickerState'
import { organizationKeys } from '../query/queryKeys'
import { FACET_LABEL } from '../facet'
import ClassificationPicker from './ClassificationPicker'

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
  const pickerOptions = useMemo(
    () =>
      options.map((option) => ({
        id: option.id,
        mainName: option.mainName,
        description: organizationOptionDescription(option)
      })),
    [options]
  )
  const assignment = resolveOrganizationAssignment(value, options)
  const selectedId = assignment && 'organizationId' in assignment ? assignment.organizationId : null

  useEffect(() => {
    onAssignmentChange(resolveOrganizationAssignment(value, options))
  }, [onAssignmentChange, options, value])

  return (
    <>
      <ClassificationPicker
        id={id}
        value={value}
        options={pickerOptions}
        selectedId={selectedId}
        listLabel={`${FACET_LABEL[role]}候选`}
        createHint={`输入新名称会在保存时创建${FACET_LABEL[role]}`}
        onValueChange={(next) => {
          onChange(next)
          onAssignmentChange(resolveOrganizationAssignment(next, options))
        }}
        onSelect={(option) => {
          onChange(option.mainName)
          onAssignmentChange({ organizationId: option.id })
        }}
      />
      {optionsQuery.isError ? (
        <span className="classification-picker-error" role="alert">
          {FACET_LABEL[role]}候选加载失败，请稍后重试。
        </span>
      ) : null}
    </>
  )
}
