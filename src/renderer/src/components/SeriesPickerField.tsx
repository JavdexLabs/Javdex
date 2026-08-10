import { useDeferredValue } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SeriesAssignmentInput } from '@shared/classificationTypes'
import { api } from '../api'
import { seriesKeys } from '../query/queryKeys'
import {
  selectedSeriesAssignment,
  seriesOptionDescription,
  typedSeriesAssignment
} from './seriesPickerState'

interface Props {
  id: string
  value: string
  selectedId: number | null
  onChange: (value: string, assignment: SeriesAssignmentInput | null) => void
}

export default function SeriesPickerField({ id, value, selectedId, onChange }: Props): JSX.Element {
  const search = useDeferredValue(value.trim())
  const query = useQuery({
    queryKey: seriesKeys.options(search),
    queryFn: () => api.series.options(search || undefined),
    placeholderData: (previous) => previous
  })
  return (
    <div className="classification-picker">
      <input
        id={id}
        className="text-input"
        value={value}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value, typedSeriesAssignment(event.target.value))}
      />
      {value.trim() && (query.data?.length ?? 0) > 0 ? (
        <div className="classification-picker-options" role="listbox" aria-label="系列候选">
          {query.data!.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={selectedId === option.id}
              className="classification-picker-option"
              onClick={() => onChange(option.mainName, selectedSeriesAssignment(option))}
            >
              <span>{option.mainName}</span>
              <small>{seriesOptionDescription(option)}</small>
            </button>
          ))}
          <div className="classification-picker-create">保留当前输入可新建未归属系列</div>
        </div>
      ) : null}
      {query.isError ? (
        <span className="classification-picker-error" role="alert">
          系列候选加载失败，请稍后重试。
        </span>
      ) : null}
    </div>
  )
}
