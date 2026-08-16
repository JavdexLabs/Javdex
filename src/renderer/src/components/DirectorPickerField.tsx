import { useDeferredValue, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DirectorAssignmentInput } from '@shared/classificationTypes'
import { api } from '../api'
import { directorKeys } from '../query/queryKeys'
import ClassificationPicker from './ClassificationPicker'
import {
  directorOptionDescription,
  selectedDirectorAssignment,
  typedDirectorAssignment
} from './directorPickerState'

interface Props {
  id: string
  value: string
  selectedId: number | null
  onChange: (value: string, assignment: DirectorAssignmentInput | null) => void
}

export default function DirectorPickerField({
  id,
  value,
  selectedId,
  onChange,
}: Props): JSX.Element {
  const search = useDeferredValue(value.trim())
  const query = useQuery({
    queryKey: directorKeys.options(search),
    queryFn: () => api.directors.options(search || undefined),
    placeholderData: (previous) => previous,
  })
  const options = useMemo(
    () =>
      (query.data ?? []).map((option) => ({
        id: option.id,
        mainName: option.mainName,
        description: directorOptionDescription(option),
      })),
    [query.data],
  )
  return (
    <ClassificationPicker
      id={id}
      value={value}
      options={options}
      selectedId={selectedId}
      listLabel="导演候选"
      createHint="保留当前输入可就地新建同名导演"
      onValueChange={(next) => onChange(next, typedDirectorAssignment(next))}
      onSelect={(option) => onChange(option.mainName, selectedDirectorAssignment(option))}
    />
  )
}
