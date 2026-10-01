import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, SearchX } from 'lucide-react'
import { useQuery, type QueryKey } from '@tanstack/react-query'
import type { ClassificationMergeInput } from '@shared/classificationTypes'
import {
  buildClassificationMergeCommand,
  reconcileClassificationMergeSource
} from './classificationMergeState'
import { useDebounce } from '../hooks/useDebounce'
import { ClassificationChoiceEmpty, ClassificationChoiceList, ClassificationChoiceRow } from './ClassificationChoices'
import SearchInput from './SearchInput'
import styles from './ClassificationMergeModal.module.css'
import Modal from './Modal'
import { UI_ICON_SM } from './iconDefaults'

interface MergeEntity {
  id: number
  mainName: string
  videoCount: number
}

interface Props<TTarget extends MergeEntity, TSource extends MergeEntity, TResult> {
  title: string
  hint: string
  entityLabel: string
  sourceNoun: string
  candidateCountUnit: string
  target: TTarget
  queryKey: (search: string) => QueryKey
  listCandidates: (search: string) => Promise<TSource[]>
  merge: (input: ClassificationMergeInput) => Promise<TResult>
  renderIcon: () => ReactNode
  targetMeta: (target: TTarget) => ReactNode
  sourceMeta: (source: TSource) => ReactNode
  candidateMeta: (source: TSource) => ReactNode
  renderPlan: (target: TTarget, source: TSource) => ReactNode
  onCancel: () => void
  onMerged: (result: TResult) => void | Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function ClassificationMergeModal<
  TTarget extends MergeEntity,
  TSource extends MergeEntity,
  TResult
>({
  title,
  hint,
  entityLabel,
  sourceNoun,
  candidateCountUnit,
  target,
  queryKey,
  listCandidates,
  merge,
  renderIcon,
  targetMeta,
  sourceMeta,
  candidateMeta,
  renderPlan,
  onCancel,
  onMerged
}: Props<TTarget, TSource, TResult>): JSX.Element {
  const [searchInput, setSearchInput] = useState('')
  const search = useDebounce(searchInput, 300).trim()
  const [selected, setSelected] = useState<TSource | null>(null)
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const candidatesQuery = useQuery({
    queryKey: queryKey(search),
    queryFn: () => listCandidates(search)
  })
  const candidates = useMemo(
    () => (candidatesQuery.data ?? []).filter((candidate) => candidate.id !== target.id),
    [candidatesQuery.data, target.id]
  )

  useEffect(() => {
    setSelected((current) => reconcileClassificationMergeSource(current, candidates))
  }, [candidates])

  const input = buildClassificationMergeCommand(target.id, selected?.id ?? null)
  const submit = async (): Promise<void> => {
    if (!input || merging) return
    setMerging(true)
    setError(null)
    try {
      await onMerged(await merge(input))
    } catch (mergeError) {
      setError(errorMessage(mergeError))
    } finally {
      setMerging(false)
    }
  }

  return (
    <Modal
      title={title}
      hint={hint}
      size="md"
      className={styles.modal}
      confirmText={merging ? '合并中…' : '确认合并'}
      confirmDisabled={!input}
      busy={merging}
      danger
      onCancel={onCancel}
      onConfirm={() => void submit()}
    >
      <div className={styles.body}>
        <div className={styles.flow} aria-label={`${entityLabel}合并方向`}>
          <article
            className={styles.card}
            data-highlighted={Boolean(selected)}
          >
            <span className={styles.badge}>来源 · 并入后删除</span>
            {renderIcon()}
            <strong>{selected?.mainName ?? '尚未选择来源'}</strong>
            <small>{selected ? sourceMeta(selected) : `从下方候选中选择${sourceNoun}`}</small>
          </article>
          <ArrowRight className={styles.arrow} {...UI_ICON_SM} aria-hidden />
          <article className={styles.card} data-highlighted>
            <span className={styles.badge}>目标 · 保留</span>
            {renderIcon()}
            <strong>{target.mainName}</strong>
            <small>{targetMeta(target)}</small>
          </article>
        </div>

        <section className={styles.picker} aria-label={`选择来源${entityLabel}`}>
          <div className={styles.sectionHead}>
            <strong>选择来源{entityLabel}</strong>
            {!candidatesQuery.isLoading && candidates.length > 0 ? (
              <span>
                {candidates.length} {candidateCountUnit}候选
              </span>
            ) : null}
          </div>
          <SearchInput
            fullWidth
            type="search"
            placeholder="搜索主名或别名…"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            autoFocus
          />
          <ClassificationChoiceList>
            {candidatesQuery.isLoading ? (
              <ClassificationChoiceEmpty loading />
            ) : candidatesQuery.isError ? (
              <ClassificationChoiceEmpty
                icon={<SearchX {...UI_ICON_SM} aria-hidden />}
                title={`候选${entityLabel}加载失败`}
                description={errorMessage(candidatesQuery.error)}
              />
            ) : candidates.length === 0 ? (
              <ClassificationChoiceEmpty
                icon={<SearchX {...UI_ICON_SM} aria-hidden />}
                title={search ? `没有匹配的${entityLabel}` : `没有可合并的${entityLabel}`}
                description={
                  search ? '调整搜索关键词后再试。' : `当前没有其他${entityLabel}资料。`
                }
              />
            ) : (
              <div role="listbox" aria-label={`来源${entityLabel}候选`}>
                {candidates.map((candidate) => {
                  const isSelected = candidate.id === selected?.id
                  return (
                    <ClassificationChoiceRow
                      key={candidate.id}
                      role="option"
                      selected={isSelected}
                      name={candidate.mainName}
                      description={candidateMeta(candidate)}
                      trailing={`${candidate.videoCount} 部`}
                      onClick={() => setSelected(candidate)}
                    />
                  )
                })}
              </div>
            )}
          </ClassificationChoiceList>
        </section>

        {selected ? (
          <section className={styles.plan} aria-label="合并规则">
            <strong>合并后</strong>
            <ul>{renderPlan(target, selected)}</ul>
          </section>
        ) : null}
        {error ? <p className={styles.error}>{error}</p> : null}
      </div>
    </Modal>
  )
}
