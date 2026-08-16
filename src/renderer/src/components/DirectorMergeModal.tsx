import { Clapperboard } from 'lucide-react'
import type {
  DirectorDetail,
  DirectorMergeResult,
  DirectorOption
} from '@shared/classificationTypes'
import { api } from '../api'
import { directorKeys } from '../query/queryKeys'
import ClassificationMergeModal from './ClassificationMergeModal'
import { UI_ICON_SM } from './iconDefaults'

interface Props {
  target: DirectorDetail
  onCancel: () => void
  onMerged: (result: DirectorMergeResult) => void | Promise<void>
}

function directorMeta(director: DirectorOption): string {
  return `档案 #${director.id} · ${director.videoCount} 部影片`
}

export default function DirectorMergeModal({ target, onCancel, onMerged }: Props): JSX.Element {
  return (
    <ClassificationMergeModal
      title="合并导演"
      hint="当前导演固定为保留目标。选择另一位导演并入后，来源记录会被删除。"
      entityLabel="导演"
      sourceNoun="一位导演"
      candidateCountUnit="位"
      target={target}
      queryKey={directorKeys.options}
      listCandidates={(search) => api.directors.options(search)}
      merge={(input) => api.directors.merge(input)}
      renderIcon={() => <Clapperboard {...UI_ICON_SM} aria-hidden />}
      targetMeta={(director) =>
        `档案 #${director.id} · ${director.videoCount} 部影片 · 主名保持不变`
      }
      sourceMeta={(director) =>
        `档案 #${director.id} · ${director.videoCount} 部影片 · 主名转为目标别名`
      }
      candidateMeta={directorMeta}
      renderPlan={(keep, source) => (
        <>
          <li>保留“{keep.mainName}”作为主名，“{source.mainName}”转为别名</li>
          <li>别名与相关链接去重合并，目标已有资料优先</li>
          <li>目标空字段由来源补齐，全部来源影片转移到目标</li>
          <li>目标没有正式肖像时才接收来源肖像</li>
        </>
      )}
      onCancel={onCancel}
      onMerged={onMerged}
    />
  )
}
