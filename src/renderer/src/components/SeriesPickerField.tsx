import { useDeferredValue, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SeriesAssignmentInput } from '@shared/classificationTypes'
import { api } from '../api'
import { seriesKeys } from '../query/queryKeys'
import ClassificationPicker from './ClassificationPicker'
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
  const options = useMemo(
    () =>
      (query.data ?? []).map((option) => ({
        id: option.id,
        mainName: option.mainName,
        description: seriesOptionDescription(option)
      })),
    [query.data]
  )
  return (
    <>
      <ClassificationPicker
        id={id}
        value={value}
        options={options}
        selectedId={selectedId}
        listLabel="系列候选"
        createHint="保留当前输入可新建未归属系列"
        onValueChange={(next) => onChange(next, typedSeriesAssignment(next))}
        onSelect={(option) => onChange(option.mainName, selectedSeriesAssignment(option))}
      />
      {query.isError ? (
        <span className="classification-picker-error" role="alert">
          系列候选加载失败，请稍后重试。
        </span>
      ) : null}
    </>
  )
}
