import { useDeferredValue } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DirectorAssignmentInput } from '@shared/classificationTypes'
import { api } from '../api'
import { directorKeys } from '../query/queryKeys'
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
  return (
    <div className="classification-picker">
      <input
        id={id}
        className="text-input"
        value={value}
        autoComplete="off"
        onChange={(event) =>
          onChange(event.target.value, typedDirectorAssignment(event.target.value))
        }
      />
      {value.trim() && (query.data?.length ?? 0) > 0 ? (
        <div className="classification-picker-options" role="listbox" aria-label="导演候选">
          {query.data!.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={selectedId === option.id}
              className="classification-picker-option"
              onClick={() => onChange(option.mainName, selectedDirectorAssignment(option))}
            >
              <span>{option.mainName}</span>
              <small>{directorOptionDescription(option)}</small>
            </button>
          ))}
          <div className="classification-picker-create">保留当前输入可就地新建同名导演</div>
        </div>
      ) : null}
    </div>
  )
}
