import { Layers3 } from 'lucide-react'
import type { SeriesDetail, SeriesMergeResult, SeriesOption } from '@shared/classificationTypes'
import { api } from '../api'
import { seriesKeys } from '../query/queryKeys'
import ClassificationMergeModal from './ClassificationMergeModal'
import { UI_ICON_SM } from './iconDefaults'

interface Props {
  target: SeriesDetail
  onCancel: () => void
  onMerged: (result: SeriesMergeResult) => void | Promise<void>
}

function ownerName(series: SeriesDetail | SeriesOption): string {
  return series.ownerOrganization?.mainName ?? '未归属'
}

export default function SeriesMergeModal({ target, onCancel, onMerged }: Props): JSX.Element {
  return (
    <ClassificationMergeModal
      title="合并系列"
      hint="当前系列固定为保留目标。来源影片与直接子系列会转移，来源记录随后删除。"
      entityLabel="系列"
      sourceNoun="一个系列"
      candidateCountUnit="个"
      target={target}
      queryKey={seriesKeys.options}
      listCandidates={(search) => api.series.options(search)}
      merge={(input) => api.series.merge(input)}
      renderIcon={() => <Layers3 {...UI_ICON_SM} aria-hidden />}
      targetMeta={(series) =>
        `档案 #${series.id} · ${series.videoCount} 部影片 · ${ownerName(series)}`
      }
      sourceMeta={(series) =>
        `档案 #${series.id} · ${series.videoCount} 部影片 · ${ownerName(series)}`
      }
      candidateMeta={(series) => `所属 ${ownerName(series)} · 档案 #${series.id}`}
      renderPlan={(keep, source) => (
        <>
          <li>保留“{keep.mainName}”作为主名，“{source.mainName}”转为别名</li>
          <li>别名与相关链接去重合并，目标已有资料和正式封面优先</li>
          <li>目标空字段由来源补齐，名称作用域或层级冲突会阻止合并</li>
          <li>来源影片与直接子系列转移到目标，来源记录永久删除</li>
        </>
      )}
      onCancel={onCancel}
      onMerged={onMerged}
    />
  )
}
