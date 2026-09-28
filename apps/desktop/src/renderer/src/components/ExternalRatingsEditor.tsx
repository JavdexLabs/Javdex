import type { VideoEditInput, VideoExternalStats } from '@shared/videoTypes'
import { selectDefaultExternalRating } from '@shared/externalRatings'
import { Check, Circle, Trash2, Undo2 } from 'lucide-react'
import Button from './Button'
import { EditFormHint, EditFormSection } from './FormPrimitives'
import styles from './ExternalRatingsEditor.module.css'

type Selection = NonNullable<VideoEditInput['externalRatings']>

export default function ExternalRatingsEditor({ ratings, value, disabled, onChange }: {
  ratings: VideoExternalStats[]
  value: Selection
  disabled: boolean
  onChange: (value: Selection) => void
}): JSX.Element {
  return (
    <EditFormSection title="外部评分" hint="选择详情页显示的评分来源，保存后生效。">
      {ratings.length === 0 ? <EditFormHint as="p">暂无外部评分</EditFormHint> : (
        <div className={styles.list}>
          {ratings.map((rating) => {
            const removed = value.deletedSources.includes(rating.source)
            const selected = value.defaultSource === rating.source
            return (
              <div className={`${styles.row} ${selected ? styles.activeRow : ''} ${removed ? styles.removedRow : ''}`} key={rating.source}>
                <span className={styles.score}>{rating.rating_average == null ? '—' : Number(rating.rating_average.toFixed(1))}</span>
                <div className={styles.info}>
                  <strong className={styles.source} title={rating.source}>{rating.source}</strong>
                  <span className={styles.summary}>{removed ? '待删除 · 保存后移除' : rating.rating_count == null ? '外部评分来源' : `${rating.rating_count.toLocaleString('zh-CN')} 人评分`}</span>
                </div>
                <div className={styles.actions}>
                  <Button size="sm" className={`${styles.choice} ${selected ? styles.selected : ''}`} disabled={disabled || removed || rating.rating_average == null}
                    aria-pressed={selected} aria-label={`将 ${rating.source} 设为默认外部评分`}
                    onClick={() => onChange({ ...value, defaultSource: rating.source })}>
                    {selected ? <Check size={14} aria-hidden /> : <Circle size={14} aria-hidden />}
                    {selected ? '默认来源' : '设为默认'}
                  </Button>
                  <Button size="sm" className={styles.remove} title={removed ? '撤销删除' : '删除评分'} variant={removed ? 'default' : 'danger'} disabled={disabled}
                    aria-label={`${removed ? '撤销删除' : '删除'} ${rating.source} 评分`}
                    onClick={() => {
                      const deletedSources = removed
                        ? value.deletedSources.filter((source) => source !== rating.source)
                        : [...value.deletedSources, rating.source]
                      const remaining = ratings.filter((item) => !deletedSources.includes(item.source))
                        .map((item) => ({ ...item, is_default: item.source === value.defaultSource ? 1 : 0 }))
                      onChange({ deletedSources, defaultSource: selectDefaultExternalRating(remaining)?.source ?? null })
                    }}>{removed ? <Undo2 size={14} aria-hidden /> : <Trash2 size={14} aria-hidden />}</Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </EditFormSection>
  )
}
